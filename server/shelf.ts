import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createShelfLogger } from "@storyshelf/core/logger";
import { createSqliteDatabase } from "@storyshelf/db-sqlite";
import { gitHubHost } from "@storyshelf/git-github";
import { slackWebhookNotifier } from "@storyshelf/notify-chat/slack";
import { otelLogMixin } from "@storyshelf/observability";
import { initObservabilityFromEnv } from "@storyshelf/observability/node";
import { createPlaywrightCaptureRunner } from "@storyshelf/runner-playwright";
import { createLocalStorage } from "@storyshelf/storage-local";

/** Adapters, logger and config for `createShelfApp`, built from environment config. */
export async function createShelfOptions() {
  const dataDir = process.env.DATA_DIR || "./data";
  mkdirSync(dataDir, { recursive: true });

  // Adapters — swap these for your deployment
  const storage = createLocalStorage(dataDir);
  const database = createSqliteDatabase(join(dataDir, "shelf.db"));
  const captureRunner = createPlaywrightCaptureRunner();

  // Observability (noop unless OTEL_EXPORTER_OTLP_ENDPOINT is set).
  const observability = await initObservabilityFromEnv();
  const logger = createShelfLogger({ mixin: otelLogMixin });

  return {
    database,
    storage,
    captureRunner,
    notifiers: [slackWebhookNotifier],
    gitHosts: [gitHubHost],
    logger,
    observability,
    config: {
      secret: process.env.SECRET,
      scratchDir: dataDir,
    },
  };
}
