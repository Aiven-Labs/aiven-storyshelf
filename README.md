# aiven-storyshelf

Self-hosted [StoryShelf](https://github.com/GuptaSiddhant/StoryShelf) visual testing server. It uses Postgres for data, S3-compatible object storage (Cloudflare R2) for builds and screenshots, and captures stories with Playwright Chromium.

## Layout

| Path | Purpose |
|---|---|
| `server/index.ts` | Entrypoint: creates the app with `createShelfApp`, serves it with Hono and handles shutdown. |
| `server/shelf.ts` | Adapters, logger, observability and config passed to `createShelfApp`. |
| `Dockerfile` | Single-stage Node 24 image. Node runs the TypeScript directly, so there is no build step. |

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

### Memory and CPU

StoryShelf 0.7 sizes its own capture from the CPUs and memory it sees, so memory stays flat as the story count grows. Capture is **CPU-bound**: memory is not the limit. Measured with a 555-story design system (full capture, no failures in any run):

| Container | Pages at once | Time | Peak memory |
|---|---|---|---|
| 1 vCPU, 2GB | auto | 793s | 923MiB |
| 1 vCPU, 2GB | **2** | **618s** | 755MiB |
| 1 vCPU, 2GB | 3 | 855s | 818MiB |
| 2 vCPU, 4GB | auto | 391s | 1095MiB |
| 2 vCPU, 4GB | **4** | **313s** | 942MiB |
| 2 vCPU, 4GB | 8 | 304s | 1351MiB |
| 2 vCPU, 4GB | auto, build split into 2 shards run in parallel | 384s | 910MiB |

Notes:
- **Set the number of pages explicitly.** The automatic setting starts at one page per CPU. `STORYSHELF_CAPTURE_CONCURRENCY=2` on 1 vCPU and `=4` on 2 vCPU were 20-25% faster than auto. More than that does not help: 3 pages on 1 vCPU was slower than 2, and 8 pages on 2 vCPU used 400MiB more for 3% less time.
- **Extra RAM is not used.** Every run peaked at or under about 1.35GB, so 2GB is plenty even on 2 vCPU. Pay for CPU, not memory.
- **More CPU helps almost linearly:** 2 vCPU was about twice as fast as 1 vCPU.
- **Sharding does not help on one host.** Splitting a build into shards only helps when shards run on different machines.
- A project's first build has no baseline and renders every story. Later builds render only the affected stories, if the built Storybook includes `preview-stats.json` (see `storyshelf doctor`).
- The render time budget scales with the number of captures (at least 15 minutes), so there is no timeout setting to change.
- To cut work, skip stories with `--skip <glob>` on `storyshelf upload`, or use fewer viewports.

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
| `STORYSHELF_CAPTURE_CONCURRENCY` | auto | Story pages Chromium renders at once. Auto starts at one per CPU. Set it to 2 on 1 vCPU, or 4 on 2 vCPU (see Memory and CPU). |
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
