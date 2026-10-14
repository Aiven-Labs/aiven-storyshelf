FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
# @storyshelf/core hardcodes a 15 minute render budget that ShelfConfig can't change, which a first capture of a
# large Storybook on 1 vCPU exceeds. Read it from RENDER_TIMEOUT_MS instead; fail the build if the line moves.
RUN sed -i 's/options.renderTimeoutMs ?? 9e5/options.renderTimeoutMs ?? (Number(process.env.RENDER_TIMEOUT_MS) || 9e5)/' node_modules/@storyshelf/core/dist/capture/orchestrator.mjs \
 && grep -q 'process.env.RENDER_TIMEOUT_MS' node_modules/@storyshelf/core/dist/capture/orchestrator.mjs
RUN npx playwright-core install --with-deps chromium
COPY server/ ./server/
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data
ENV RENDER_TIMEOUT_MS=2700000
EXPOSE 3000
CMD ["node", "server/index.ts"]
