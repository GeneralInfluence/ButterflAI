FROM node:20-alpine AS base

# Native build deps for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install production deps only
COPY web/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy app source and DB schema/migrations
COPY web/ ./
COPY db/ ./db/

# Stamp BUILD_VERSION into service worker so every deploy produces a detectably new SW file
ARG BUILD_VERSION=dev
RUN sed -i "s/__BUILD_VERSION__/${BUILD_VERSION}/" public/sw.js

# Persistent volume mount point for SQLite
RUN mkdir -p /data

# Non-root user for least-privilege
RUN addgroup -S butterflai && adduser -S butterflai -G butterflai
RUN chown -R butterflai:butterflai /app /data
USER butterflai

ENV DB_PATH=/data/butterflai.sqlite
ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

# Health check — Fly uses this to decide if the machine is healthy
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
