#!/usr/bin/env bash
# Frontend deploy — runs on the E2E VPS, invoked by deploy-frontend.yml
# over SSH as user `osho`.
#
# Idempotent: re-running is safe. The frontend runs under PM2 as the app
# `osho-frontend` (`next start` on :3000). PM2 runs as the `osho` user,
# so — unlike the backend's systemd restart — no sudo is needed here.
#
set -euo pipefail

REPO_DIR="${REPO_DIR:-/home/osho/osho}"
APP="${APP:-osho-frontend}"
PORT="${PORT:-3000}"
HEALTH_URL="http://127.0.0.1:${PORT}/"

cd "$REPO_DIR"

echo "==> Pre-pull HEAD: $(git rev-parse --short HEAD)"
BEFORE=$(git rev-parse HEAD)

echo "==> git pull"
git pull --ff-only origin main

AFTER=$(git rev-parse HEAD)
echo "==> Post-pull HEAD: $(git rev-parse --short HEAD)"

if [ "$BEFORE" = "$AFTER" ]; then
  CHANGED=""
  echo "==> No new commits."
else
  CHANGED=$(git diff --name-only "$BEFORE" "$AFTER")
  echo "==> Changed files:"
  echo "$CHANGED" | sed 's/^/    /'
fi

cd "$REPO_DIR/frontend"

# Install deps only when the lockfile or manifest changed — npm ci keeps
# node_modules in exact lockfile sync.
if echo "$CHANGED" | grep -qE '^frontend/package(-lock)?\.json$'; then
  echo "==> package manifest changed — npm ci"
  npm ci
fi

echo "==> npm run build"
npm run build

echo "==> Restarting PM2 app $APP"
pm2 restart "$APP" --update-env

# Healthcheck. Loop briefly to allow `next start` to come up, then fail
# loudly if it doesn't answer.
echo "==> Healthchecking $HEALTH_URL"
ok=0
for i in $(seq 1 15); do
  sleep 1
  if curl -fsS --max-time 3 -o /dev/null "$HEALTH_URL"; then
    ok=1
    break
  fi
done

if [ "$ok" -eq 1 ]; then
  echo "==> Frontend deploy OK"
else
  echo "==> DEPLOY FAILED — frontend not responding on $HEALTH_URL"
  echo "==> Last 50 PM2 log lines for $APP:"
  pm2 logs "$APP" --lines 50 --nostream 2>/dev/null || true
  exit 1
fi
