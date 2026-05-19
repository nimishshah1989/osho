#!/usr/bin/env bash
# 02-setup-frontend.sh
#
# Run on the `osho-frontend` VPS as the `osho` user, after 01-harden-server.sh.
#
# Usage (from your laptop):
#   rsync -av --exclude node_modules --exclude .next --exclude data --exclude .venv \
#     ./ osho@<frontend-ip>:/home/osho/osho/
#   ssh osho@<frontend-ip>
#   cd /home/osho/osho
#   API_URL=https://api.oshoarchives.com bash deploy/iceland/02-setup-frontend.sh
#
# What it does:
#   - Installs Node 20 LTS via NodeSource
#   - Installs nginx + certbot (cert issued later, after DNS is live)
#   - Installs PM2 globally
#   - Installs frontend dependencies, builds, starts under PM2
#   - Installs nginx site config that only accepts traffic from Cloudflare IPs
#
# Idempotent: re-running is safe.

set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  echo "Run as the 'osho' user, not root. Use sudo where needed." >&2
  exit 1
fi

: "${API_URL:?Set API_URL (e.g. https://api.oshoarchives.com)}"

REPO_DIR="${REPO_DIR:-/home/osho/osho}"
FRONTEND_DIR="$REPO_DIR/frontend"

echo "==> Installing Node 20 LTS"
if ! command -v node >/dev/null 2>&1 || ! node --version | grep -q '^v20\.'; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node --version
npm --version

echo "==> Installing nginx + certbot"
sudo apt-get install -y nginx certbot python3-certbot-nginx

echo "==> Installing PM2 globally"
if ! command -v pm2 >/dev/null 2>&1; then
  sudo npm install -g pm2
fi

echo "==> Writing frontend .env.production"
cat > "$FRONTEND_DIR/.env.production" <<EOF
API_URL=$API_URL
NEXT_PUBLIC_API_URL=$API_URL
EOF

echo "==> Installing frontend dependencies"
cd "$FRONTEND_DIR"
npm ci

echo "==> Building Next.js"
npm run build

echo "==> Installing PM2 ecosystem config"
mkdir -p /home/osho/osho/deploy/iceland
cp /home/osho/osho/deploy/iceland/ecosystem.config.js "$FRONTEND_DIR/ecosystem.config.js"

echo "==> Starting Next.js under PM2"
cd "$FRONTEND_DIR"
pm2 startOrReload ecosystem.config.js
pm2 save

echo "==> Enabling PM2 on boot"
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u osho --hp /home/osho

echo "==> Installing nginx site config"
sudo cp "$REPO_DIR/deploy/iceland/nginx-frontend.conf" /etc/nginx/sites-available/osho-frontend
sudo ln -sf /etc/nginx/sites-available/osho-frontend /etc/nginx/sites-enabled/osho-frontend
sudo rm -f /etc/nginx/sites-enabled/default

echo "==> Refreshing Cloudflare IP allowlist"
sudo bash "$REPO_DIR/deploy/iceland/refresh-cloudflare-ips.sh"

echo "==> Testing nginx config and reloading"
sudo nginx -t
sudo systemctl reload nginx

echo ""
echo "==> Frontend is up on http://localhost:3000 (via PM2)"
echo "==> nginx is listening on :80 but will only accept Cloudflare IPs"
echo ""
echo "Next steps:"
echo "  1. Set up DNS in Cloudflare (see deploy/iceland/cloudflare-setup.md)"
echo "  2. Once DNS is live and proxied through Cloudflare, issue SSL cert:"
echo "       sudo certbot --nginx -d oshoarchives.com -d www.oshoarchives.com \\"
echo "                    --non-interactive --agree-tos --email you@example.com"
echo "     (note: Cloudflare proxy must be set to 'DNS only' temporarily for"
echo "      the HTTP-01 challenge to reach this server; flip back to 'Proxied'"
echo "      immediately after the cert is issued)"
echo "  3. Set Cloudflare SSL/TLS mode to 'Full (strict)'"
