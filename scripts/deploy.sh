#!/usr/bin/env bash
# Deploy script — runs on the EC2 server, invoked by the GitHub Action.
#
# Idempotent: re-running is safe. Decides which steps to run by diffing the
# pre-pull and post-pull HEADs against the paths it cares about.
set -euo pipefail

REPO_DIR="${REPO_DIR:-/home/ubuntu/osho-speaks}"
VENV_PY="${VENV_PY:-$REPO_DIR/.venv/bin/python3}"
APP="${APP:-scripts.cloud_api:app}"
PORT="${PORT:-8000}"
HEALTH_URL="http://localhost:${PORT}/health"

cd "$REPO_DIR"

echo "==> Pre-pull HEAD: $(git rev-parse --short HEAD)"
BEFORE=$(git rev-parse HEAD)

echo "==> git pull"
git pull --ff-only origin main

AFTER=$(git rev-parse HEAD)
echo "==> Post-pull HEAD: $(git rev-parse --short HEAD)"

# Which files changed between BEFORE and AFTER?
if [ "$BEFORE" = "$AFTER" ]; then
  CHANGED=""
  echo "==> No new commits."
else
  CHANGED=$(git diff --name-only "$BEFORE" "$AFTER")
  echo "==> Changed files:"
  echo "$CHANGED" | sed 's/^/    /'
fi

changed() {
  echo "$CHANGED" | grep -q "$1"
}

# 1. Install/update Python deps if requirements changed.
if changed '^requirements\.txt$'; then
  echo "==> requirements.txt changed — installing"
  "$VENV_PY" -m pip install -r requirements.txt
fi

# 2. Rebuild FTS index if the build script or raw data changed.
if changed '^scripts/build_fts\.py$' || changed '^data/'; then
  echo "==> FTS-relevant files changed — rebuilding index (this takes ~5-10 min)"
  "$VENV_PY" scripts/build_fts.py
fi

# 3. Restart uvicorn. pkill first; if that misses, fuser.
echo "==> Restarting uvicorn"
pkill -f "uvicorn $APP" || true
# Give the old process up to 5s to release the port before forcing.
for i in 1 2 3 4 5; do
  if ! ss -ltn "sport = :$PORT" | grep -q LISTEN; then
    break
  fi
  sleep 1
done
sudo -n fuser -k "${PORT}/tcp" 2>/dev/null || true
sleep 2

# Inherit any env vars set by the operator (ADMIN_KEY, ALLOWED_ORIGINS, OSHO_ENV…).
# Use setsid + nohup so the new process survives the SSH session ending.
nohup "$VENV_PY" -m uvicorn "$APP" --host 0.0.0.0 --port "$PORT" \
  > "$REPO_DIR/uvicorn.log" 2>&1 &
disown || true

# 4. Healthcheck. Loop briefly to allow startup, then fail loudly if not OK.
echo "==> Healthchecking $HEALTH_URL"
ok=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if curl -fsS --max-time 3 "$HEALTH_URL" > /tmp/health.json 2>/dev/null; then
    ok=1
    break
  fi
done

if [ "$ok" -eq 1 ]; then
  echo "==> Deploy OK"
  cat /tmp/health.json
else
  echo "==> DEPLOY FAILED — backend not responding on $HEALTH_URL"
  echo "==> Last 50 lines of uvicorn.log:"
  tail -n 50 "$REPO_DIR/uvicorn.log" || true
  exit 1
fi
