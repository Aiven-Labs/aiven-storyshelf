import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createAuthSystemHook } from "@storyshelf/app";
import { createShelfAuth, ensurePasswordAdmin } from "@storyshelf/auth";
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
  const secret = process.env.SECRET;
  if (!secret || !process.env.AUTH_PASSWORD) {
    throw new Error("SECRET and AUTH_PASSWORD must be set (local accounts auth is always on)");
  }
  const port = Number(process.env.PORT) || 3000;
  const publicBaseUrl = process.env.PUBLIC_BASE_URL;
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
    auth: createShelfAuth({
      db: database,
      secret,
      baseURL: publicBaseUrl ?? `http://localhost:${port}`,
      onAuthSystemEvent: createAuthSystemHook(),
      logger,
    }).adapter,
    logger,
    observability,
    config: {
      secret,
      publicBaseUrl,
      scratchDir: dataDir,
    },
  };
}

/** Provision the local admin account from AUTH_EMAIL / AUTH_PASSWORD (idempotent, runs on every boot). */
export async function ensureAdmin(database: Parameters<typeof ensurePasswordAdmin>[0]) {
  const email = process.env.AUTH_EMAIL ?? "admin@example.com";
  await ensurePasswordAdmin(database, { email, password: process.env.AUTH_PASSWORD! });
  return email;
}
