# aiven-storyshelf

Self-hosted [StoryShelf](https://github.com/GuptaSiddhant/StoryShelf) visual testing server. It uses Postgres for data, local-disk storage for uploads, and captures stories with Playwright Chromium.

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
  -e PUBLIC_BASE_URL=https://shelf.example.com \
  -p 3000:3000 \
  -v storyshelf-data:/data \
  storyshelf
```

Check it is up:

```sh
curl localhost:3000/api/v1/health
```

### Memory

Chromium is the main memory cost. In testing, the server idled at about 110MiB and peaked at about 430MiB while capturing a 7-story Storybook, so 512MB is tight. Plan for 1GB.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port. |
| `DATABASE_URL` | required | Postgres connection string. Add `?sslmode=require` for managed Postgres. Migrations run on boot. |
| `DATA_DIR` | `./data` (`/data` in Docker) | Holds uploaded builds and snapshots. Mount a persistent volume here. |
| `SECRET` | required | Signs sessions and encrypts stored credentials. Use at least 32 characters. |
| `AUTH_PASSWORD` | required | Password for the local admin account (at least 12 characters). Re-applied on every boot. |
| `AUTH_EMAIL` | `admin@example.com` | Email of the local admin account. |
| `PUBLIC_BASE_URL` | `http://localhost:$PORT` | Public URL of the server. Set it when deployed behind a hostname. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | none | Enables OpenTelemetry export when set. |

Local email/password accounts are always on, and the server refuses to start without `SECRET`, `AUTH_PASSWORD` and `DATABASE_URL`. Sign in as the admin, create projects and CI tokens in the UI, and invite other users from there.

## Uploading a build

Sign in as the admin, create a project and a CI token from the project settings, then upload a built Storybook with the [StoryShelf CLI](https://github.com/GuptaSiddhant/StoryShelf/tree/main/packages/cli):

```sh
npx storyshelf upload --url https://shelf.example.com --slug my-app --token <ci-token> \
  --sha "$(git rev-parse HEAD)" --branch main
```

Create the token while signed in. A token created without a signed-in user only has viewer access and uploads fail with 403.
