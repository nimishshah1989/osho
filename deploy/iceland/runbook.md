# Step-by-step runbook (do these in order)

## Step 0 — Prerequisites

On your laptop, confirm you have:

- [ ] SSH key generated at `~/.ssh/osho_iceland` (see README.md Task C)
- [ ] EC2 SSH key still works (`ssh -i ~/.ssh/jsl-wealth-key.pem ubuntu@13.206.34.214 echo ok`)
- [ ] `rsync`, `scp`, `ssh`, `curl`, `openssl` installed
- [ ] This repo cloned locally at the path you're running commands from

## Step 1 — Cloudflare account (you, ~10 min)

Follow [`cloudflare-setup.md`](cloudflare-setup.md) **Phase 1 only** for now.
Send me the two Cloudflare nameservers when you have them.

## Step 2 — FlokiNET account + 2 VPSes (you, ~10 min + waiting)

Order **two Iceland KVM VPSes**, Ubuntu 24.04 LTS:

- `osho-frontend`: smallest tier with ≥ 2 GB RAM
- `osho-backend`: tier with ≥ 4 GB RAM, ≥ 80 GB disk

Wait for the provisioning email with IPs + root passwords. Send me the IPs.

## Step 3 — Harden both servers (you + me, ~10 min each)

For **each** VPS, run from your laptop:

```bash
# Set this to your public key contents (the ssh-ed25519 AAAA... line)
SSH_PUBKEY="ssh-ed25519 AAAA... osho-iceland"

# Frontend
scp deploy/iceland/01-harden-server.sh root@<FRONTEND_IP>:/root/
ssh root@<FRONTEND_IP> "SSH_PUBKEY='$SSH_PUBKEY' HOSTNAME_NEW=osho-frontend bash /root/01-harden-server.sh"

# Backend
scp deploy/iceland/01-harden-server.sh root@<BACKEND_IP>:/root/
ssh root@<BACKEND_IP> "SSH_PUBKEY='$SSH_PUBKEY' HOSTNAME_NEW=osho-backend bash /root/01-harden-server.sh"
```

**Verification** (do this BEFORE closing the root SSH session — you can lock yourself out):

```bash
# From a separate terminal — these should both succeed:
ssh -i ~/.ssh/osho_iceland osho@<FRONTEND_IP> "hostname; sudo whoami"
ssh -i ~/.ssh/osho_iceland osho@<BACKEND_IP>  "hostname; sudo whoami"

# These should both FAIL with "Permission denied":
ssh root@<FRONTEND_IP>
ssh root@<BACKEND_IP>
```

If verification passes, the root login is dead and the firewall is up.

## Step 4 — Push code to both servers (you, ~3 min)

From your laptop, in the repo root:

```bash
# Frontend (no DB needed there)
rsync -av --delete \
  --exclude node_modules --exclude .next --exclude .venv --exclude data \
  --exclude '*.log' --exclude '.git/objects' \
  ./ osho@<FRONTEND_IP>:/home/osho/osho/

# Backend (no node_modules, but yes data/ — though osho.db itself is pulled by step 6)
rsync -av --delete \
  --exclude node_modules --exclude .next --exclude .venv --exclude frontend \
  --exclude '*.log' --exclude '.git/objects' \
  ./ osho@<BACKEND_IP>:/home/osho/osho/
```

## Step 5 — Set up frontend (~5 min of your time + 3-5 min of build)

```bash
ssh osho@<FRONTEND_IP>
cd /home/osho/osho
API_URL=https://api.oshoarchives.com bash deploy/iceland/02-setup-frontend.sh
```

Verify it's running:

```bash
curl -fsS http://127.0.0.1:3000 | head -c 200
pm2 status
```

You should see the Next.js homepage HTML and PM2 reporting `osho-frontend: online`.

## Step 6 — Migrate the database to backend (your laptop, ~10-30 min)

```bash
EC2_HOST=ubuntu@13.206.34.214 \
EC2_SSH_KEY=~/.ssh/jsl-wealth-key.pem \
BACKEND_IP=<BACKEND_IP> \
BACKEND_SSH_KEY=~/.ssh/osho_iceland \
bash deploy/iceland/04-migrate-db.sh
```

The 1.6 GB transfer takes anywhere from 3 minutes (good AWS↔Iceland link)
to 30 minutes (bad weather day). You'll see progress via `scp`.

## Step 7 — Set up backend (~10 min of your time + 5-10 min FTS rebuild)

```bash
ssh osho@<BACKEND_IP>
cd /home/osho/osho

# Generate a fresh ADMIN_KEY first — do NOT reuse the EC2 one
openssl rand -hex 32
# Copy that output, then:
sudo nano /etc/osho/backend.env
# Paste the new key into ADMIN_KEY=... and save.

# Now run the setup
bash deploy/iceland/03-setup-backend.sh
```

The script will pause if `/etc/osho/backend.env` still has the
placeholder. After it finishes, the FTS rebuild takes ~5-10 min. Verify:

```bash
curl -fsS http://127.0.0.1:8000/health
sudo systemctl status osho-backend --no-pager -l
```

## Step 8 — DNS in Cloudflare (you, ~5 min)

In Cloudflare dashboard for `oshoarchives.com`:

1. Delete any existing records for `@`, `www`, or `api` (especially Vercel CNAMEs).
2. Add three A records as **DNS only** (grey cloud) per
   [`cloudflare-setup.md`](cloudflare-setup.md) Phase 2.

## Step 9 — Switch nameservers at registrar (you, ~5 min + propagation)

Phase 3 of `cloudflare-setup.md`. Verify with:

```bash
dig +short ns oshoarchives.com
dig +short A oshoarchives.com
dig +short A api.oshoarchives.com
```

Wait until all three return Cloudflare nameservers / Iceland IPs.

## Step 10 — Issue SSL certs (you, ~3 min)

Phase 4 of `cloudflare-setup.md`. While DNS records are still
**DNS only** (grey cloud), so HTTP-01 challenge reaches the origin:

```bash
# On frontend VPS:
ssh osho@<FRONTEND_IP>
sudo certbot --nginx -d oshoarchives.com -d www.oshoarchives.com \
  --non-interactive --agree-tos --email <you@example.com>

# On backend VPS:
ssh osho@<BACKEND_IP>
sudo certbot --nginx -d api.oshoarchives.com \
  --non-interactive --agree-tos --email <you@example.com>
```

## Step 11 — Flip Cloudflare proxy ON (you, ~30 sec)

Cloudflare dashboard → DNS → all three records → toggle to **Proxied**
(orange cloud).

Then **SSL/TLS → Overview → Full (strict)**.

## Step 12 — End-to-end smoke test (you + me, ~10 min)

Test in a real browser:

- [ ] https://oshoarchives.com loads (HTML, not 502)
- [ ] Run a search — results come back
- [ ] Click into a discourse — paragraphs load with highlights
- [ ] `/archive` — tree explorer loads
- [ ] Try a Hindi search — verify it matches correctly (`अनंत`, `धर्म`)
- [ ] Try a NEAR search — verify highlights only on matching paragraphs
- [ ] `/admin` with the new ADMIN_KEY — verify it works

## Step 13 — Backups (you, ~5 min)

Once happy with the smoke test, set up nightly B2 backup on the backend VPS:

```bash
ssh osho@<BACKEND_IP>

# Install rclone
sudo apt-get install -y rclone

# Write the backup secrets file
sudo tee /etc/osho/backup.env >/dev/null <<'EOF'
B2_KEY_ID=<from-backblaze-console>
B2_APPLICATION_KEY=<from-backblaze-console>
B2_BUCKET=osho-backups
BACKUP_ENCRYPTION_PASSPHRASE=<openssl rand -hex 32>
EOF
sudo chmod 600 /etc/osho/backup.env
sudo chown root:root /etc/osho/backup.env

# Install the script
sudo cp /home/osho/osho/deploy/iceland/backup-db.sh /usr/local/bin/osho-backup-db
sudo chmod +x /usr/local/bin/osho-backup-db

# Test it once manually
sudo /usr/local/bin/osho-backup-db

# Install nightly cron at 03:00 UTC
echo "0 3 * * * root /usr/local/bin/osho-backup-db >> /var/log/osho-backup.log 2>&1" | \
  sudo tee /etc/cron.d/osho-backup
```

Verify the file appeared in B2.

## Step 14 — Decommission old stack (you, after 48 h of stable Iceland traffic)

- [ ] Vercel: delete the project (or pause deployments). Keep the
      Vercel account for a few weeks in case you need to retrieve env vars.
- [ ] EC2: stop the instance (don't terminate yet — wait 2 weeks).
- [ ] Update `CLAUDE.md` to reflect the new topology.

## Step 15 — Move registrar to Njalla (you, ~30 min over 5-7 days)

Independent of everything above. See README.md Step 9 in the original
plan. Site keeps working throughout.
