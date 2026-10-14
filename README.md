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

### Memory

**Run with at least 2GB of RAM.** Chromium is the main memory cost, and real design systems use far more than a small fixture:

| Storybook | Container memory | Result |
|---|---|---|
| 7 stories | 1GB | Peak about 330-430MiB. |
| 555 stories (heavy) | 1GB | Chromium pages crash (`Target crashed`) and the container is killed (OOM). |
| 555 stories (heavy) | 2GB | All stories captured, no failures. Peak about 1.9GB. |

Notes:
- CPU matters as much as RAM. On 1 vCPU the 555-story capture took about 17 minutes. That is over StoryShelf's built-in 15 minute render limit, so the Dockerfile raises it (see `RENDER_TIMEOUT_MS`). A first capture on 1 vCPU is slow; later builds render only affected stories.
- A project's first build has no baseline and renders every story, which is the heaviest case. Later builds render only the stories affected by the change.
- Stories are rendered in batches of `CAPTURE_MAX_PAGES` pages at a time, so Chromium's memory stays bounded as the story count grows. Every screenshot is still held in memory until the render finishes, so memory grows with the story count.
- A memory-starved capture can fail with no error in the UI. The build shows `Interrupted by server restart`, and the container log is the only place to see the cause. Check the app's memory graph if builds fail without a message.
- To cut memory further, skip stories you don't need with `--skip <glob>` on `storyshelf upload`, or use fewer viewports.

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
| `CAPTURE_MAX_PAGES` | `6` | Most story pages Chromium renders at once. Stories are captured in batches of this size, so peak memory stays flat for large Storybooks. Lower it if the container is killed mid-capture. |
| `RENDER_TIMEOUT_MS` | `2700000` (45 min) in Docker | Time budget for rendering one build. StoryShelf's built-in limit is 15 minutes and isn't configurable, so the Dockerfile patches it to read this variable. |
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
