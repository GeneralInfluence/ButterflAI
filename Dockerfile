FROM node:20-alpine AS base

# Native build deps for better-sqlite3
RUN apk add --no-cache python3 make g++ su-exec

WORKDIR /app

# Install production deps only
COPY web/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy app source and DB schema/migrations
COPY web/ ./
COPY db/ ./db/

# Stamp BUILD_VERSION into the service worker (so every deploy is a detectably new SW)
# and into update-check.js (so an open page knows which deploy it came from and can
# compare against GET /api/version — the reliable "is this page stale?" signal).
ARG BUILD_VERSION=dev
RUN sed -i "s/__BUILD_VERSION__/${BUILD_VERSION}/" public/sw.js public/update-check.js
ENV BUILD_VERSION=${BUILD_VERSION}

# Persistent volume mount point for SQLite
RUN mkdir -p /data

# Non-root user for least-privilege
RUN addgroup -S butterflai && adduser -S butterflai -G butterflai
RUN chown -R butterflai:butterflai /app /data
# No USER here: docker-entrypoint.sh starts as root to fix /data and /.fly/api
# permissions, then drops to `butterflai` (su-exec) before running the app.
RUN chmod +x /app/docker-entrypoint.sh

ENV DB_PATH=/data/butterflai.sqlite
ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

# Health check — Fly uses this to decide if the machine is healthy
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
