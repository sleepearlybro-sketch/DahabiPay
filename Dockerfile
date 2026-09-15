# =============================================================================
# Dahabi Pay
# Runs with Railway PostgreSQL when DATABASE_URL is set; SQLite remains a
# local fallback for development and tests.
# =============================================================================
FROM node:22-alpine

# tini reaps zombies and forwards SIGTERM, so the graceful shutdown in
# server/index.js actually runs
RUN apk add --no-cache tini curl

WORKDIR /app

# dependencies first, so a code change does not re-install them
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# the database lives on a volume, never in the image layer
RUN mkdir -p /data/kyc && chown -R node:node /data /app
ENV DB_FILE=/data/exchangepay.db \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

USER node
EXPOSE 3000

# Health status supports monitoring; Compose does not restart solely on unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
# Seeding is idempotent and never overwrites live reserves or existing users.
# Running it here keeps startup reliable as Railway retires railway.json hooks.
CMD ["sh", "-c", "npm run seed && exec node --no-warnings server/index.js"]
