import { createAuthSystemHook, type ShelfOptions } from "@storyshelf/app";
import { createShelfAuth, ensurePasswordAdmin } from "@storyshelf/auth";
import {
  gitHubNotifier,
  slackWebhookNotifier,
} from "@storyshelf/core/integrations";
import { createShelfLogger } from "@storyshelf/core/logger";
import { createPostgresDatabase } from "@storyshelf/db-postgres";
import { otelLogMixin } from "@storyshelf/observability";
import { initObservabilityFromEnv } from "@storyshelf/observability/node";
import { createPlaywrightCaptureRunner } from "@storyshelf/runner-playwright";
import { createS3Storage } from "@storyshelf/storage-s3";
import postgres from "postgres";

/** Adapters, logger and config for `createShelfApp`, built from environment config. */
export async function createShelfOptions(): Promise<ShelfOptions> {
  const missing = [
    "SECRET",
    "AUTH_PASSWORD",
    "DATABASE_URL",
    "S3_BUCKET",
  ].filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }

  // Presence is guaranteed by the `missing` check above.
  const secret = process.env.SECRET!;
  const databaseUrl = process.env.DATABASE_URL!;
  const bucket = process.env.S3_BUCKET!;

  const port = Number(process.env.PORT) || 3000;
  const publicBaseUrl = process.env.PUBLIC_BASE_URL;

  // Observability (noop unless OTEL_EXPORTER_OTLP_ENDPOINT is set).
  const observability = await initObservabilityFromEnv();
  const logger = createShelfLogger({ mixin: otelLogMixin });

  // Adapters — swap these for your deployment
  // S3-compatible storage (Cloudflare R2: S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com, S3_REGION=auto).
  // Credentials come from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.
  const storage = createS3Storage({
    bucket,
    prefix: process.env.S3_PREFIX,
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION || "auto",
  });

  // db-postgres passes `ssl: undefined` to postgres.js, which overrides `?sslmode=` in the URL, so set it here.
  const sslmode = new URL(databaseUrl).searchParams.get("sslmode");
  const ssl =
    sslmode && sslmode !== "disable"
      ? ("require" as unknown as boolean)
      : undefined;
  const database = createPostgresDatabase({ url: databaseUrl, ssl });
  const captureRunner = createPlaywrightCaptureRunner();
  const auth = createShelfAuth({
    db: database,
    secret,
    baseURL: publicBaseUrl ?? `http://localhost:${port}`,
    onAuthSystemEvent: createAuthSystemHook(),
    logger,
    passkeys: {},
  });

  return {
    database,
    storage,
    testing: { runner: captureRunner },
    notifications: { notifiers: [slackWebhookNotifier, gitHubNotifier] },
    auth: auth.adapter,
    logger,
    observability,
    config: { secret, publicBaseUrl },
  };
}

/**
 * Provision the local admin account from AUTH_EMAIL / AUTH_PASSWORD (idempotent, runs on every boot).
 *
 * On Postgres, `ensurePasswordAdmin` stores the admin with `email_verified = false` (it writes with the
 * SQLite table definitions) and then refuses to refresh that "unverified" account on the next boot.
 * Mark the admin verified and retry so restarts and password rotation work.
 */
export async function ensureAdmin(
  database: Parameters<typeof ensurePasswordAdmin>[0],
) {
  const email = (process.env.AUTH_EMAIL ?? "admin@example.com")
    .trim()
    .toLowerCase();
  const input = { email, password: process.env.AUTH_PASSWORD! };
  try {
    await ensurePasswordAdmin(database, input);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes("unverified SSO identity")
    )
      throw error;
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
