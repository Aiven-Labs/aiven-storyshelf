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

StoryShelf 0.7 sizes its own capture (one page at a time on 1 vCPU, and it restarts the browser periodically), so memory stays flat as the story count grows. Measured with a 555-story design system on 1 vCPU and 2GB:

| Storybook | Container | Result |
|---|---|---|
| 555 stories (heavy) | 1 vCPU, 2GB | All stories captured and approved, no failures. About 14 minutes, peak about 690MiB. |

Notes:
- Capture is CPU-bound: on 1 vCPU, expect roughly 1.5 seconds per story for the first full build.
- A project's first build has no baseline and renders every story. Later builds render only the affected stories, if the built Storybook includes `preview-stats.json` (see `storyshelf doctor`).
- Plan for 2GB. It was not tested below that on 0.7, but the peak was well under 1GB, so 1GB may work for similar Storybooks.
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
| `CAPTURE_CONCURRENCY` | `1` | Captures run at once. Concurrent captures share the CPU and add up their memory, so keep it at 1 on small hosts. Within a capture, StoryShelf sizes the number of open pages from the available CPU and memory itself. |
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
