# One container runs everything: the API, the built web app, and the headless Chromium used for PDFs.
# The Playwright image already has Chromium and the libraries it needs; its version matches playwright-core.
FROM mcr.microsoft.com/playwright:v1.65.0-noble

WORKDIR /app

# Install dependencies first, so a code-only change does not reinstall them.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund

COPY . .
RUN npx prisma generate --schema server/prisma/schema.prisma \
 && npm run build -w @apt/web

ENV NODE_ENV=production \
    SERVE_WEB=true \
    TRUST_PROXY=true \
    PORT=10000
EXPOSE 10000

# On every start: apply any new migrations, make sure the demo accounts and building exist
# (the seed never touches a database that already has units), then serve.
WORKDIR /app/server
CMD ["sh", "-c", "npx prisma migrate deploy && npx tsx prisma/seed.ts && exec npx tsx src/server.ts"]
