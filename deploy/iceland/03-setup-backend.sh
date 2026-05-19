#!/usr/bin/env bash
# 03-setup-backend.sh
#
# Run on the `osho-backend` VPS as the `osho` user, after 01-harden-server.sh.
#
# Usage (from your laptop):
#   rsync -av --exclude node_modules --exclude .next --exclude .venv \
#     ./ osho@<backend-ip>:/home/osho/osho/
#   ssh osho@<backend-ip>
#   cd /home/osho/osho
#   # Make sure data/osho.db exists (uploaded by 04-migrate-db.sh)
#   bash deploy/iceland/03-setup-backend.sh
#
# What it does:
#   - Installs Python 3.12 + venv tooling
#   - Installs nginx + certbot
#   - Creates a Python venv, pip installs requirements
#   - Rebuilds the FTS5 index against the migrated DB
#   - Installs systemd unit for uvicorn (port 8000, loopback only)
#   - Installs nginx site config that fronts uvicorn on 443, Cloudflare-only
#   - Loads secrets from /etc/osho/backend.env (you must populate this)
#
# Idempotent: re-running is safe.

set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  echo "Run as the 'osho' user, not root. Use sudo where needed." >&2
  exit 1
fi

REPO_DIR="${REPO_DIR:-/home/osho/osho}"
VENV_DIR="$REPO_DIR/.venv"

echo "==> Installing Python 3.12 + system deps"
sudo apt-get update -y
sudo apt-get install -y \
  python3.12 python3.12-venv python3.12-dev \
  build-essential \
  nginx certbot python3-certbot-nginx \
  sqlite3

echo "==> Creating venv"
if [ ! -d "$VENV_DIR" ]; then
  python3.12 -m venv "$VENV_DIR"
fi
"$VENV_DIR/bin/pip" install --upgrade pip wheel
"$VENV_DIR/bin/pip" install -r "$REPO_DIR/requirements.txt"

echo "==> Checking for data/osho.db"
if [ ! -f "$REPO_DIR/data/osho.db" ]; then
  echo "ERROR: $REPO_DIR/data/osho.db not found." >&2
  echo "Run deploy/iceland/04-migrate-db.sh from your laptop first." >&2
  exit 1
fi

echo "==> Rebuilding FTS5 index from migrated DB (5-10 min for 75k paragraphs)"
"$VENV_DIR/bin/python3" "$REPO_DIR/scripts/build_fts.py"

echo "==> Creating /etc/osho/backend.env (placeholder if not present)"
sudo install -d -m 750 -o osho -g osho /etc/osho
if [ ! -f /etc/osho/backend.env ]; then
  sudo tee /etc/osho/backend.env >/dev/null <<'EOF'
# Backend environment — populate these before starting the service
# DO NOT commit this file to git.
ADMIN_KEY=CHANGE_ME_BEFORE_STARTING
ALLOWED_ORIGINS=https://oshoarchives.com,https://www.oshoarchives.com
OSHO_ENV=production
PORT=8000
EOF
  sudo chmod 600 /etc/osho/backend.env
  sudo chown osho:osho /etc/osho/backend.env
  echo ""
  echo "!! IMPORTANT: edit /etc/osho/backend.env and set ADMIN_KEY to a real value"
  echo "   before continuing. Use: openssl rand -hex 32"
  echo ""
fi

echo "==> Installing systemd unit for uvicorn"
sudo cp "$REPO_DIR/deploy/iceland/osho-backend.service" /etc/systemd/system/osho-backend.service
sudo systemctl daemon-reload
sudo systemctl enable osho-backend

echo "==> Starting uvicorn"
sudo systemctl restart osho-backend
sleep 3
sudo systemctl status osho-backend --no-pager -l | head -20

echo "==> Healthcheck"
if curl -fsS --max-time 5 http://127.0.0.1:8000/health; then
  echo ""
  echo "==> Backend healthy."
else
  echo ""
  echo "==> Backend NOT healthy. Check: journalctl -u osho-backend -n 100"
  exit 1
fi

echo "==> Installing nginx site config"
sudo cp "$REPO_DIR/deploy/iceland/nginx-backend.conf" /etc/nginx/sites-available/osho-backend
sudo ln -sf /etc/nginx/sites-available/osho-backend /etc/nginx/sites-enabled/osho-backend
sudo rm -f /etc/nginx/sites-enabled/default

echo "==> Refreshing Cloudflare IP allowlist"
sudo bash "$REPO_DIR/deploy/iceland/refresh-cloudflare-ips.sh"

echo "==> Testing nginx config and reloading"
sudo nginx -t
sudo systemctl reload nginx

echo ""
echo "==> Backend is up on http://127.0.0.1:8000 and nginx is proxying on :80"
echo ""
echo "Next steps:"
echo "  1. Confirm DNS A record api.oshoarchives.com → this VPS IP is set in Cloudflare"
echo "     and temporarily flipped to 'DNS only' (grey cloud) for cert issuance"
echo "  2. Issue cert:"
echo "       sudo certbot --nginx -d api.oshoarchives.com \\"
echo "                    --non-interactive --agree-tos --email you@example.com"
echo "  3. Flip Cloudflare proxy back to 'Proxied' (orange cloud)"
echo "  4. Set SSL/TLS mode in Cloudflare to 'Full (strict)'"
