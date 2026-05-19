#!/usr/bin/env bash
# 02-setup-single-vps.sh
#
# Consolidated frontend + backend deploy on a SINGLE Ubuntu VPS.
# Use this instead of 02-setup-frontend.sh and 03-setup-backend.sh when
# you're running both pieces on one box (Hostinger KVM, cheap FlokiNET, etc.)
#
# Run on the VPS as the `osho` user, after 01-harden-server.sh.
#
# Usage:
#   1. From your laptop, rsync the repo up (data/osho.db can be empty for now;
#      04-migrate-db.sh fills it in step 2).
#        rsync -av --exclude node_modules --exclude .next --exclude .venv \
#          --exclude '*.log' --exclude '.git/objects' \
#          ./ osho@<VPS_IP>:/home/osho/osho/
#   2. From your laptop, run 04-migrate-db.sh to seed data/osho.db.
#   3. SSH in and run this script:
#        ssh osho@<VPS_IP>
#        cd /home/osho/osho
#        DOMAIN=oshoarchives.com bash deploy/iceland/02-setup-single-vps.sh
#
# What it does:
#   - Installs Node 20 + Python 3.12 + nginx + certbot + PM2
#   - Builds Next.js and starts it under PM2 on 127.0.0.1:3000
#   - Sets up Python venv, FTS rebuild, uvicorn under systemd on 127.0.0.1:8000
#   - Installs a single nginx config serving both vhosts:
#       oshoarchives.com / www.oshoarchives.com  → :3000
#       api.oshoarchives.com                      → :8000
#   - Cloudflare-only ingress (other source IPs get 403)
#
# Idempotent: safe to re-run.

set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  echo "Run as the 'osho' user, not root." >&2
  exit 1
fi

DOMAIN="${DOMAIN:-oshoarchives.com}"
API_DOMAIN="${API_DOMAIN:-api.$DOMAIN}"
REPO_DIR="${REPO_DIR:-/home/osho/osho}"
FRONTEND_DIR="$REPO_DIR/frontend"
VENV_DIR="$REPO_DIR/.venv"

echo "==> Domain: $DOMAIN"
echo "==> API:    $API_DOMAIN"

echo "==> apt update"
sudo apt-get update -y

echo "==> Installing system packages (Node 20, Python 3.12, nginx, certbot, sqlite, build tools)"
if ! command -v node >/dev/null 2>&1 || ! node --version | grep -q '^v20\.'; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
fi
sudo apt-get install -y --no-install-recommends \
  nodejs \
  python3.12 python3.12-venv python3.12-dev \
  build-essential \
  nginx certbot python3-certbot-nginx \
  sqlite3

if ! command -v pm2 >/dev/null 2>&1; then
  sudo npm install -g pm2
fi

echo "==> Checking for data/osho.db"
if [ ! -f "$REPO_DIR/data/osho.db" ]; then
  echo "ERROR: $REPO_DIR/data/osho.db not found." >&2
  echo "Run deploy/iceland/04-migrate-db.sh from your laptop first." >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# Backend
# -----------------------------------------------------------------------------

echo "==> Creating Python venv"
if [ ! -d "$VENV_DIR" ]; then
  python3.12 -m venv "$VENV_DIR"
fi
"$VENV_DIR/bin/pip" install --upgrade pip wheel
"$VENV_DIR/bin/pip" install -r "$REPO_DIR/requirements.txt"

echo "==> Creating /etc/osho/backend.env (placeholder if not present)"
sudo install -d -m 750 -o osho -g osho /etc/osho
if [ ! -f /etc/osho/backend.env ]; then
  sudo tee /etc/osho/backend.env >/dev/null <<EOF
# Backend env — populate ADMIN_KEY before service starts.
ADMIN_KEY=CHANGE_ME_BEFORE_STARTING
ALLOWED_ORIGINS=https://$DOMAIN,https://www.$DOMAIN
OSHO_ENV=production
PORT=8000
EOF
  sudo chmod 600 /etc/osho/backend.env
  sudo chown osho:osho /etc/osho/backend.env

  echo ""
  echo "!! Generate a fresh ADMIN_KEY and edit /etc/osho/backend.env:"
  echo "     openssl rand -hex 32"
  echo "     sudo nano /etc/osho/backend.env"
  echo "   Then re-run this script."
  exit 1
fi

if grep -q "CHANGE_ME_BEFORE_STARTING" /etc/osho/backend.env; then
  echo "ERROR: /etc/osho/backend.env still has placeholder ADMIN_KEY." >&2
  echo "Generate one with: openssl rand -hex 32" >&2
  echo "Then: sudo nano /etc/osho/backend.env" >&2
  exit 1
fi

echo "==> Rebuilding FTS5 index (5-10 min for 75k paragraphs)"
"$VENV_DIR/bin/python3" "$REPO_DIR/scripts/build_fts.py"

echo "==> Installing systemd unit for uvicorn"
sudo cp "$REPO_DIR/deploy/iceland/osho-backend.service" /etc/systemd/system/osho-backend.service
sudo systemctl daemon-reload
sudo systemctl enable osho-backend
sudo systemctl restart osho-backend
sleep 3

echo "==> Backend healthcheck"
if ! curl -fsS --max-time 5 http://127.0.0.1:8000/health; then
  echo ""
  echo "ERROR: backend failed to start. Check: journalctl -u osho-backend -n 100" >&2
  exit 1
fi
echo ""

# -----------------------------------------------------------------------------
# Frontend
# -----------------------------------------------------------------------------

echo "==> Writing frontend .env.production"
cat > "$FRONTEND_DIR/.env.production" <<EOF
API_URL=https://$API_DOMAIN
NEXT_PUBLIC_API_URL=https://$API_DOMAIN
EOF

echo "==> npm ci (frontend)"
cd "$FRONTEND_DIR"
npm ci

echo "==> next build"
npm run build

echo "==> Copying PM2 ecosystem config"
cp "$REPO_DIR/deploy/iceland/ecosystem.config.js" "$FRONTEND_DIR/ecosystem.config.js"

echo "==> Starting Next.js under PM2"
pm2 startOrReload ecosystem.config.js
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u osho --hp /home/osho >/dev/null

echo "==> Frontend healthcheck"
sleep 2
if ! curl -fsS --max-time 5 http://127.0.0.1:3000 >/dev/null; then
  echo "ERROR: frontend failed to start. Check: pm2 logs osho-frontend" >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# nginx (combined vhosts)
# -----------------------------------------------------------------------------

echo "==> Refreshing Cloudflare IP allowlist"
sudo bash "$REPO_DIR/deploy/iceland/refresh-cloudflare-ips.sh"

echo "==> Installing nginx config (single VPS with both vhosts)"
# Render the template with the actual domains
sudo sed \
  -e "s/__DOMAIN__/$DOMAIN/g" \
  -e "s/__API_DOMAIN__/$API_DOMAIN/g" \
  "$REPO_DIR/deploy/iceland/nginx-single-vps.conf" \
  | sudo tee /etc/nginx/sites-available/osho >/dev/null
sudo ln -sf /etc/nginx/sites-available/osho /etc/nginx/sites-enabled/osho
sudo rm -f /etc/nginx/sites-enabled/default

echo "==> Testing nginx config and reloading"
sudo nginx -t
sudo systemctl reload nginx

echo ""
echo "==> Deploy complete."
echo ""
echo "Both services are up on loopback. nginx is fronting them on :80."
echo "Currently nginx allows only Cloudflare IPs (other sources get 403)."
echo ""
echo "Next:"
echo "  1. In Cloudflare, set DNS records (DNS only / grey cloud for now):"
echo "       A  @                 $(curl -s ifconfig.me)"
echo "       A  www               $(curl -s ifconfig.me)"
echo "       A  api               $(curl -s ifconfig.me)"
echo "     (use this VPS's public IP shown above)"
echo "  2. Wait for DNS propagation (dig +short A $DOMAIN should return that IP)."
echo "  3. Issue SSL certs:"
echo "       sudo certbot --nginx -d $DOMAIN -d www.$DOMAIN -d $API_DOMAIN \\"
echo "                    --non-interactive --agree-tos --email you@example.com"
echo "  4. Flip Cloudflare DNS records to Proxied (orange cloud)."
echo "  5. Cloudflare → SSL/TLS → Full (strict)."
