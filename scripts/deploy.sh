#!/usr/bin/env bash
# Backend deploy — runs on the E2E VPS, invoked by deploy-backend.yml
# over SSH as user `osho`.
#
# Idempotent: re-running is safe. Decides which steps to run by diffing
# the pre-pull and post-pull HEADs against the paths it cares about.
#
# The backend runs as the systemd unit `osho-backend.service` (uvicorn
# scripts.cloud_api:app on 127.0.0.1:8000). Restarting it needs
# passwordless sudo for user `osho` — add to /etc/sudoers.d/osho:
#
#   osho ALL=(root) NOPASSWD: /usr/bin/systemctl restart osho-backend.service
#
set -euo pipefail

REPO_DIR="${REPO_DIR:-/home/osho/osho}"
VENV_PY="${VENV_PY:-$REPO_DIR/.venv/bin/python3}"
SERVICE="${SERVICE:-osho-backend.service}"
PORT="${PORT:-8000}"
HEALTH_URL="http://127.0.0.1:${PORT}/health"

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

# 3. Restart the backend. systemd handles the process lifecycle (stop,
#    port release, restart, env from the unit file) — no pkill/nohup
#    dance. `-n` makes a missing sudoers entry fail loudly here instead
#    of hanging on a password prompt with no TTY.
echo "==> Restarting $SERVICE"
sudo -n systemctl restart "$SERVICE"

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
  echo "==> Last 50 journal lines for $SERVICE:"
  sudo -n journalctl -u "$SERVICE" -n 50 --no-pager 2>/dev/null \
    || journalctl -u "$SERVICE" -n 50 --no-pager 2>/dev/null || true
  exit 1
fi
