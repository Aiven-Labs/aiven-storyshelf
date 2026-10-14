import { createPlaywrightCaptureRunner } from "@storyshelf/runner-playwright";

type CaptureRunner = ReturnType<typeof createPlaywrightCaptureRunner>;

/**
 * The Playwright runner opens a page for every story and viewport at once, so a large Storybook
 * exhausts memory and the container is killed mid-capture. Render in batches instead: each batch
 * gets its own browser, which is closed before the next one starts.
 */
export function createBatchedCaptureRunner(inner: CaptureRunner, maxPages: number): CaptureRunner {
  const cancelled = new Set<string>();
  return {
    metadata: inner.metadata,
    async render(input) {
      cancelled.delete(input.buildId);
      const storiesPerBatch = Math.max(1, Math.floor(maxPages / Math.max(1, input.viewports.length)));
      const batches = Math.ceil(input.stories.length / storiesPerBatch);
      const result: Awaited<ReturnType<CaptureRunner["render"]>> = { captures: [], failures: [] };
      for (let batch = 0; batch < batches; batch++) {
        if (cancelled.has(input.buildId)) throw new Error("Capture cancelled");
        input.logger?.info({ batch: batch + 1, batches, storiesPerBatch }, "rendering batch");
        const stories = input.stories.slice(batch * storiesPerBatch, (batch + 1) * storiesPerBatch);
        const part = await inner.render({ ...input, stories });
        result.captures.push(...part.captures);
        result.failures.push(...part.failures);
      }
      return result;
    },
    async cancel(buildId) {
      cancelled.add(buildId);
      await inner.cancel(buildId);
    },
  };
}
