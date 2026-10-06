#!/bin/sh
# ButterflAI container entrypoint.
#
# Runs as root only to fix permissions, then drops to the non-root `butterflai`
# user and execs the app:
#  1. The Fly volume at /data may be owned by root — chown it so the app can
#     write the SQLite database.
#  2. Fly's OIDC socket /.fly/api is root-only. The app mints its Anthropic
#     identity tokens from it (keyless auth, web/anthropic-client.js), so the
#     app user needs access. Without this every Claude call failed with
#     "connect EACCES /.fly/api" (2026-10-06).
set -e

chown -R butterflai:butterflai /data

if [ -S /.fly/api ]; then
  if chgrp butterflai /.fly/api && chmod 0660 /.fly/api; then
    echo "[entrypoint] /.fly/api opened to the butterflai group"
  else
    echo "[entrypoint] WARNING: could not open /.fly/api to the app user — keyless Anthropic auth will fail"
  fi
fi

exec su-exec butterflai:butterflai "$@"
