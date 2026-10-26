FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
# Browsers to install for local rendering, e.g. --build-arg BROWSERS="chromium firefox webkit". Empty with a remote Playwright server.
ARG BROWSERS=""
RUN if [ -n "$BROWSERS" ]; then npx playwright-core install --with-deps $BROWSERS; fi
COPY server/ ./server/
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data
EXPOSE 3000
CMD ["node", "server/index.ts"]
