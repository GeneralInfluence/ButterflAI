FROM node:20-alpine

# sqlite3 native build deps
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY web/package*.json ./
RUN npm ci --omit=dev

COPY web/ ./
COPY db/ ./db/

# Data dir for SQLite volume mount
RUN mkdir -p /data

ENV DB_PATH=/data/butterflai.sqlite
ENV PORT=3000

EXPOSE 3000
CMD ["node", "server.js"]
