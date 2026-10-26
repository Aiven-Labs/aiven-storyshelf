FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
RUN npx playwright-core install --with-deps chromium
COPY server/ ./server/
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data
EXPOSE 3000
CMD ["node", "server/index.ts"]
