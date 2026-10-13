FROM node:lts-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install
COPY server/ ./server/
RUN npx -y esbuild server/index.ts --bundle --platform=node --format=esm \
  --external:playwright \
  --external:@aws-sdk/client-s3 \
  --external:chromium-bidi \
  --outfile=dist/server.mjs

FROM mcr.microsoft.com/playwright:latest
WORKDIR /app
COPY --from=builder /app/dist/server.mjs ./
COPY --from=builder /app/node_modules/playwright \
  ./node_modules/playwright/
EXPOSE 3000
ENV PORT=3000
ENV DATA_DIR=/data
CMD ["node", "dist/server.mjs"]
