# aiven-storyshelf

Self-hosted [StoryShelf](https://github.com/GuptaSiddhant/StoryShelf) visual testing server. It uses SQLite and local-disk storage, and captures stories with Playwright Chromium.

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
SECRET=change-me pnpm start
```

Use `pnpm dev` to restart on changes.

## Run with Docker

```sh
docker build -t storyshelf .
docker run -d --name storyshelf \
  -e SECRET=change-me \
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
| `DATA_DIR` | `./data` (`/data` in Docker) | Holds `shelf.db` and uploaded builds. Mount a volume here. |
| `SECRET` | none | Secret used to encrypt stored credentials. Set it in production. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | none | Enables OpenTelemetry export when set. |

Authentication is off by default, so every route is open. Do not expose the server publicly without configuring auth.

## Uploading a build

Create a project, then upload a built Storybook with the [StoryShelf CLI](https://github.com/GuptaSiddhant/StoryShelf/tree/main/packages/cli):

```sh
npx storyshelf create --url http://localhost:3000 --name my-app --token <admin-token>
npx storyshelf upload --url http://localhost:3000 --slug my-app --token <ci-token> \
  --sha "$(git rev-parse HEAD)" --branch main
```

With auth disabled (the default here), a CI token has only viewer access and the server rejected the CLI upload with a 403 in testing. Configure auth before relying on the CLI.
