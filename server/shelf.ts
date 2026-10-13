import { mkdirSync } from "node:fs";
import { createAuthSystemHook } from "@storyshelf/app";
import { createShelfAuth, ensurePasswordAdmin } from "@storyshelf/auth";
import { createShelfLogger } from "@storyshelf/core/logger";
import { createPostgresDatabase } from "@storyshelf/db-postgres";
import { gitHubHost } from "@storyshelf/git-github";
import { slackWebhookNotifier } from "@storyshelf/notify-chat/slack";
import { otelLogMixin } from "@storyshelf/observability";
import { initObservabilityFromEnv } from "@storyshelf/observability/node";
import { createPlaywrightCaptureRunner } from "@storyshelf/runner-playwright";
import { createLocalStorage } from "@storyshelf/storage-local";
import postgres from "postgres";

/** Adapters, logger and config for `createShelfApp`, built from environment config. */
export async function createShelfOptions() {
  const secret = process.env.SECRET;
  const databaseUrl = process.env.DATABASE_URL;
  if (!secret || !process.env.AUTH_PASSWORD || !databaseUrl) {
    throw new Error("SECRET, AUTH_PASSWORD and DATABASE_URL must be set");
  }
  const port = Number(process.env.PORT) || 3000;
  const publicBaseUrl = process.env.PUBLIC_BASE_URL;
  const dataDir = process.env.DATA_DIR || "./data";
  mkdirSync(dataDir, { recursive: true });

  // Adapters — swap these for your deployment
  const storage = createLocalStorage(dataDir);
  const database = createPostgresDatabase({ url: databaseUrl });
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

/**
 * Provision the local admin account from AUTH_EMAIL / AUTH_PASSWORD (idempotent, runs on every boot).
 *
 * On Postgres, `ensurePasswordAdmin` stores the admin with `email_verified = false` (it writes with the
 * SQLite table definitions) and then refuses to refresh that "unverified" account on the next boot.
 * Mark the admin verified and retry so restarts and password rotation work.
 */
export async function ensureAdmin(database: Parameters<typeof ensurePasswordAdmin>[0]) {
  const email = (process.env.AUTH_EMAIL ?? "admin@example.com").trim().toLowerCase();
  const input = { email, password: process.env.AUTH_PASSWORD! };
  try {
    await ensurePasswordAdmin(database, input);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("unverified SSO identity")) throw error;
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await sql`update "user" set email_verified = true where lower(email) = ${email}`;
    } finally {
      await sql.end();
    }
    await ensurePasswordAdmin(database, input);
  }
  return email;
}
