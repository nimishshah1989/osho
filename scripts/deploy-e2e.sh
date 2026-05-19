#!/usr/bin/env bash
# Deploy script — runs ON the E2E server, invoked by the GitHub Action.
#
# Handles BOTH frontend (Next.js) and backend (FastAPI) on a single VPS.
# Idempotent: re-running is safe. Decides which steps to run by diffing
# pre-pull and post-pull HEADs against the paths it cares about.

set -euo pipefail

REPO_DIR="${REPO_DIR:-/home/osho/osho}"
VENV_PY="${VENV_PY:-$REPO_DIR/.venv/bin/python3}"
FRONTEND_DIR="$REPO_DIR/frontend"
BACKEND_HEALTH="http://127.0.0.1:8000/health"
FRONTEND_HEALTH="http://127.0.0.1:3000"

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

changed() {
  echo "$CHANGED" | grep -q "$1"
}

# ----- Backend ---------------------------------------------------------------

if changed '^requirements\.txt$'; then
  echo "==> requirements.txt changed — installing Python deps"
  "$VENV_PY" -m pip install -r requirements.txt
fi

if changed '^scripts/build_fts\.py$' || changed '^data/'; then
  echo "==> FTS-relevant files changed — rebuilding index (5-10 min)"
  "$VENV_PY" scripts/build_fts.py
fi

# Restart backend if any scripts/ file changed or FTS was rebuilt
if changed '^scripts/' || changed '^requirements\.txt$' || changed '^data/'; then
  echo "==> Restarting backend service"
  sudo systemctl restart osho-backend
fi

# ----- Frontend --------------------------------------------------------------

FRONTEND_TOUCHED=0
if changed '^frontend/'; then
  FRONTEND_TOUCHED=1
fi

if [ "$FRONTEND_TOUCHED" -eq 1 ]; then
  cd "$FRONTEND_DIR"

  if changed '^frontend/package\.json$' || changed '^frontend/package-lock\.json$'; then
    echo "==> Frontend deps changed — npm ci"
    npm ci
  fi

  echo "==> Building Next.js"
  npm run build

  echo "==> Reloading frontend under PM2"
  pm2 reload osho-frontend --update-env

  cd "$REPO_DIR"
fi

# ----- Healthchecks ----------------------------------------------------------

echo "==> Healthchecking backend $BACKEND_HEALTH"
backend_ok=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if curl -fsS --max-time 3 "$BACKEND_HEALTH" > /tmp/backend-health.json 2>/dev/null; then
    backend_ok=1
    break
  fi
done
if [ "$backend_ok" -ne 1 ]; then
  echo "==> BACKEND HEALTH FAILED"
  echo "==> journalctl -u osho-backend -n 50:"
  sudo journalctl -u osho-backend -n 50 --no-pager || true
  exit 1
fi
echo "    backend OK: $(cat /tmp/backend-health.json)"

echo "==> Healthchecking frontend $FRONTEND_HEALTH"
frontend_ok=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if curl -fsS --max-time 3 "$FRONTEND_HEALTH" -o /dev/null 2>/dev/null; then
    frontend_ok=1
    break
  fi
done
if [ "$frontend_ok" -ne 1 ]; then
  echo "==> FRONTEND HEALTH FAILED"
  echo "==> pm2 logs osho-frontend (last 30 lines):"
  pm2 logs osho-frontend --lines 30 --nostream || true
  exit 1
fi
echo "    frontend OK"

echo "==> Deploy OK"
