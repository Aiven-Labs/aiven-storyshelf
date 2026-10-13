import { serve } from "@hono/node-server";
import { createShelfApp } from "@storyshelf/app";
import { createShelfOptions } from "./shelf.ts";

const port = Number(process.env.PORT) || 3000;
const options = await createShelfOptions();
const app = createShelfApp(options);

await app.lifecycle.setup();

const server = serve({ fetch: app.fetch, port }, () => {
  options.logger.info({ port }, "StoryShelf server listening");
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
