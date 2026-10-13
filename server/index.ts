import { join } from "node:path"
import { serve } from "@hono/node-server";
import { createShelfApp } from "@storyshelf/app";
import { createShelfLogger } from "@storyshelf/core/logger";
import { otelLogMixin } from "@storyshelf/observability";
import { initObservabilityFromEnv } from "@storyshelf/observability/node";
import { createSqliteDatabase } from "@storyshelf/db-sqlite";
import { createLocalStorage } from "@storyshelf/storage-local";
import { gitHubHost } from "@storyshelf/git-github";
import { slackWebhookNotifier } from "@storyshelf/notify-chat/slack";
import { createPlaywrightCaptureRunner } from "@storyshelf/runner-playwright";
import { mkdirSync } from "node:fs";

const dataDir = process.env.DATA_DIR || "./data";
const port = Number(process.env.PORT) || 3000;
mkdirSync(dataDir, {recursive:true})

// Adapters — swap these for your deployment
const storage = createLocalStorage(dataDir);
const database = createSqliteDatabase(join(dataDir, "shelf.db"));
const captureRunner = createPlaywrightCaptureRunner();

// Observability (noop unless OTEL_EXPORTER_OTLP_ENDPOINT is set).
const observability = await initObservabilityFromEnv();
const shelfLogger = createShelfLogger({ mixin: otelLogMixin });

const app = createShelfApp({
  database,
  storage,
  captureRunner,
  notifiers: [slackWebhookNotifier],
  gitHosts: [gitHubHost],
  logger: shelfLogger,
  observability,
  config: {
    secret: process.env.SECRET,
    // Rotation: keep the old SECRET here until credentials are re-encrypted.
    previousSecret: process.env.SECRET_PREVIOUS || undefined,
    migrateCredentialsOnBoot: process.env.SECRET_MIGRATE === "true",
    scratchDir: dataDir,
  },
});

await app.lifecycle.setup();

const server = serve({ fetch: app.fetch, port }, () => {
  shelfLogger.info({ port }, "StoryShelf server listening");
});

const shutdown = async () => {
  await app.lifecycle.teardown();
  server.close();
};
process.on("SIGTERM", () => {
  shutdown().catch(() => {});
});
process.on("SIGINT", () => {
  shutdown().catch(() => {});
});
