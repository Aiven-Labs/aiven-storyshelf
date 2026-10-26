# Playwright server for the StoryShelf remote browser target. The image tag and the playwright version
# must equal the `playwright-core` version of @storyshelf/runner-playwright (1.63.0 for StoryShelf 0.7).
FROM mcr.microsoft.com/playwright:v1.63.0-noble
USER pwuser
WORKDIR /home/pwuser
ENV PORT=3000
# `--path` is the only gate a bare run-server has: set a long random value via PLAYWRIGHT_PATH and keep the
# port on a private network. `--max-clients` must cover the renders that can run at once.
ENV PLAYWRIGHT_PATH=/storyshelf
ENV PLAYWRIGHT_MAX_CLIENTS=8
EXPOSE 3000
CMD ["sh", "-c", "exec npx -y playwright@1.63.0 run-server --port $PORT --host 0.0.0.0 --path $PLAYWRIGHT_PATH --max-clients $PLAYWRIGHT_MAX_CLIENTS"]
