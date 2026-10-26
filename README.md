# aiven-storyshelf

Self-hosted [StoryShelf](https://github.com/GuptaSiddhant/StoryShelf) visual testing server. It uses Postgres for data, S3-compatible object storage (Cloudflare R2) for builds and screenshots, and captures stories with Chromium running on a **separate Playwright server** (remote browser target `chromium@grid`).

## Layout

| Path | Purpose |
|---|---|
| `server/index.ts` | Entrypoint: creates the app with `createShelfApp`, serves it with Hono and handles shutdown. |
| `server/shelf.ts` | Adapters, logger, observability and config passed to `createShelfApp`. |
| `playwright-server/Dockerfile` | The Playwright server that runs Chromium. Pinned to the runner's `playwright-core` version. |
| `Dockerfile` | Single-stage Node 24 image with no browsers installed (1.3GB). Node runs the TypeScript directly, so there is no build step. |

## Run locally

Requires Node.js 24 or later and a Chromium for Playwright (`npx playwright-core install chromium`).

```sh
pnpm install
DATABASE_URL=postgres://user:pass@localhost:5432/shelf \
SECRET=$(openssl rand -hex 32) AUTH_PASSWORD=a-long-admin-password pnpm start
```

Use `pnpm dev` to restart on changes.

## Run with Docker

```sh
docker build -t storyshelf .
docker run -d --name storyshelf \
  -e SECRET=$(openssl rand -hex 32) \
  -e AUTH_PASSWORD=a-long-admin-password \
  -e DATABASE_URL=postgres://user:pass@host:5432/shelf?sslmode=require \
  -e S3_BUCKET=storyshelf \
  -e S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com \
  -e AWS_ACCESS_KEY_ID=... -e AWS_SECRET_ACCESS_KEY=... \
  -e PUBLIC_BASE_URL=https://shelf.example.com \
  -p 3000:3000 \
  storyshelf
```

Check it is up:

```sh
curl localhost:3000/api/v1/health
```

### Remote browsers

This app installs no browser. The runner connects to a Playwright server (`playwright run-server`) over a WebSocket and renders there. Start the server (the image tag and `playwright@` version must equal the runner's `playwright-core`, 1.63.0 for StoryShelf 0.7):

```sh
docker build -t pwserver ./playwright-server
docker run -d --init --ipc=host --name pw --network <net> --cpus=2 --memory=4g \
  -e PLAYWRIGHT_PATH=/<long-random-path> -e PLAYWRIGHT_MAX_CLIENTS=16 pwserver
```

Then run the app with `PLAYWRIGHT_SERVER_URL=ws://pw:3000/<long-random-path>` and `PLAYWRIGHT_SESSIONS=<pages at once>`. A bare `run-server` has no authentication: the path is its only gate, so keep the port on a private network (or put a proxy that checks a token in front and set `PLAYWRIGHT_SERVER_TOKEN`).

New projects default to the local `chromium` target, which this runner does not offer. Set each project's capture target to `chromium@grid` (Settings → Capture, or `PATCH /api/v1/projects/<slug>` with `{"browser":"chromium@grid"}`) before uploading. The remote target has its own baselines, so existing local baselines are not reused.

Measured with a 555-story design system, full capture, no failures (app host fixed at 1 vCPU / 1GB):

| Playwright server(s) | Time | App host peak / avg CPU | Server peak memory / avg CPU |
|---|---|---|---|
| 1 x (2 vCPU, 4GB), 4 sessions | 339s | 347MiB / 33% | 996MiB / 164% of 2 |
| 1 x (1 vCPU, 2GB), 2 sessions | 731s | 341MiB / 19% | 666MiB / 84% |
| 2 x (1 vCPU, 2GB) behind a load balancer, 4 sessions, **sharded** | 419s | 324MiB / 29% | 644MiB and 618MiB / 67% and 74% |
| 2 x (1 vCPU, 2GB) behind a load balancer, 4 sessions, **not sharded** | 703s | 347MiB / 18% | 644MiB and 774MiB / 46% and 52% |

For comparison, Chromium on the app host itself took 313s on 2 vCPU / 4GB and 618s on 1 vCPU / 2GB.

Notes:
- **Remote costs about 10-18% more time** than local Chromium on the same CPU, because every asset of every page crosses the WebSocket. The app host sent about 1.6GB to the server for these 555 stories.
- **The app host stays small:** about 350MiB and 20-33% of one CPU, with the 1.3GB image. The server holds the browser load.
- **`sessions` is the total pages rendered at once across all servers and shards.**
- **Several servers only help when the build is sharded** (`CAPTURE_SHARD_SIZE`, with `CAPTURE_CONCURRENCY` shards in flight). Without shards the work effectively runs at one CPU of throughput. Behind a load balancer, put `least_conn` and WebSocket upgrade headers on the proxy.
- **Total CPU matters most:** one 2 vCPU server beat two 1 vCPU servers, because the sharded run left each server at about 70% CPU.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port. |
| `DATABASE_URL` | required | Postgres connection string. Add `?sslmode=require` for managed Postgres. Migrations run on boot. |
| `S3_BUCKET` | required | Bucket for builds, screenshots and baselines. |
| `S3_ENDPOINT` | AWS S3 | Set for R2: `https://<account-id>.r2.cloudflarestorage.com`. |
| `S3_REGION` | `auto` | Use `auto` for R2. |
| `S3_PREFIX` | none | Optional key prefix inside the bucket. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | required | S3 or R2 API token credentials. |
| `PLAYWRIGHT_SERVER_URL` | required | WebSocket address of the Playwright server, including its `--path`, e.g. `ws://pw:3000/storyshelf`. |
| `PLAYWRIGHT_SERVICE_URL` / `PLAYWRIGHT_SERVICE_ACCESS_TOKEN` | none | Azure Playwright Workspaces browser endpoint and access token. When set, renders run on Azure as `chromium@azure` (takes precedence over `PLAYWRIGHT_SERVER_URL`). See `benchmark/README.md` for the trial. |
| `PLAYWRIGHT_SESSIONS` | `1` | Pages rendered at once across the farm. Set it to what the server(s) can take. |
| `PLAYWRIGHT_SERVER_TOKEN` | none | Bearer token for a reverse proxy in front of the server. |
| `CAPTURE_SHARD_SIZE` | none | Captures per shard. Needed to spread one build over several servers. |
| `CAPTURE_CONCURRENCY` | auto | Builds or shards rendered at once; each opens one connection to the server. |
| `DATA_DIR` | `./data` (`/data` in Docker) | Scratch space where uploaded Storybooks are unpacked during capture. It doesn't need to persist. |
| `SECRET` | required | Signs sessions and encrypts stored credentials. Use at least 32 characters. |
| `AUTH_PASSWORD` | required | Password for the local admin account (at least 12 characters). Re-applied on every boot. |
| `AUTH_EMAIL` | `admin@example.com` | Email of the local admin account. |
| `PUBLIC_BASE_URL` | `http://localhost:$PORT` | Public URL of the server. Set it when deployed behind a hostname. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | none | Enables OpenTelemetry export when set. |

Local email/password accounts are always on, and the server refuses to start without `SECRET`, `AUTH_PASSWORD`, `DATABASE_URL` and `S3_BUCKET`. Sign in as the admin, create projects and CI tokens in the UI, and invite other users from there.

## Uploading a build

Sign in as the admin, create a project and a CI token from the project settings, then upload a built Storybook with the [StoryShelf CLI](https://github.com/GuptaSiddhant/StoryShelf/tree/main/packages/cli):

```sh
npx storyshelf upload --url https://shelf.example.com --slug my-app --token <ci-token> \
  --sha "$(git rev-parse HEAD)" --branch main
```

Create the token while signed in. A token created without a signed-in user only has viewer access and uploads fail with 403.
