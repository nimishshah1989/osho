# Iceland migration runbook — Osho archives

This directory holds everything needed to migrate `oshoarchives.com` off
Vercel (frontend) and AWS Mumbai (backend) onto two FlokiNET Iceland VPSes,
fronted by Cloudflare.

## Why this exists

Vercel suspended the project after a DMCA notice filed in India. AWS Mumbai
(current backend host) is also subject to Indian DMCA. The migration moves
both pieces to Iceland — a jurisdiction without reciprocal copyright
enforcement with India for online intermediaries — and adds Cloudflare in
front to hide origin IPs and absorb abuse traffic.

This is **not** a guarantee against legal process; it raises the cost of
takedown attempts from "fill a webform" to "file in an Icelandic court".

## Topology after migration

```
oshoarchives.com (Cloudflare proxy, orange-cloud DNS)
  ├── @ / www         → osho-frontend VPS (Iceland)    → Next.js on :3000 behind nginx
  └── api.oshoarchives.com → osho-backend VPS (Iceland) → FastAPI on :8000 behind nginx
```

Frontend's `API_URL` env points to `https://api.oshoarchives.com`. Cloudflare
proxies both. SSL is "Full (strict)" — Let's Encrypt on the origin, Cloudflare
edge cert facing the user.

## Server inventory

| Role | OS | Specs (minimum) | Hostname |
|---|---|---|---|
| Frontend | Ubuntu 24.04 LTS | 2 vCPU, 2 GB RAM, 40 GB | `osho-frontend` |
| Backend | Ubuntu 24.04 LTS | 2 vCPU, 4 GB RAM, 80 GB | `osho-backend` |

Backend needs the extra RAM/disk for the 1.6 GB SQLite DB plus the ~1 GB
FTS5 index plus headroom for FTS rebuilds.

## Order of operations

1. **One-time prep** (see [`cloudflare-setup.md`](cloudflare-setup.md)):
   sign up at Cloudflare, add `oshoarchives.com`, capture the assigned
   nameservers. **Do not switch nameservers at the registrar yet.**

2. **Provision servers** at FlokiNET. Note the two public IPs.

3. **Harden** each server with [`01-harden-server.sh`](01-harden-server.sh).
   Runs once per server as `root` immediately after first login.

4. **Frontend setup**: scp this repo to the frontend VPS, run
   [`02-setup-frontend.sh`](02-setup-frontend.sh).

5. **Backend setup**: scp this repo to the backend VPS, run
   [`03-setup-backend.sh`](03-setup-backend.sh). Requires DB to already be
   present at `data/osho.db` (next step).

6. **Migrate the database**: from your laptop, run
   [`04-migrate-db.sh`](04-migrate-db.sh). It pulls the latest snapshot
   from the EC2 backend (or a local copy) and uploads it to the new
   backend VPS. Then SSH in and run `scripts/build_fts.py` to rebuild
   the FTS index from scratch on the new box.

7. **DNS cutover** (see [`cloudflare-setup.md`](cloudflare-setup.md)):
   create A records `@`, `www`, `api` pointing at the two Iceland IPs.
   Enable orange-cloud proxy. Issue Let's Encrypt certs. Switch
   nameservers at the registrar last.

8. **Backups** ([`backup-db.sh`](backup-db.sh)): cron job on the backend
   VPS uploads encrypted nightly DB snapshots to Backblaze B2.

9. **Decommission**: only after 48 h of stable traffic on the new stack,
   shut down the EC2 instance and delete the Vercel project.

10. **Registrar move to Njalla**: independent of everything above, can be
    initiated any time. Takes 5–7 days. Site continues to work normally
    during the transfer.

## Environment variables you must set

Before running the setup scripts, populate `deploy/iceland/.env.deploy`
(this file is gitignored — never commit it):

```bash
# --- Cloudflare ---
CLOUDFLARE_API_TOKEN=...     # scoped to Zone:DNS:Edit for oshoarchives.com only

# --- Backend secrets (will be written into systemd EnvironmentFile) ---
ADMIN_KEY=...                # generate a fresh long random string — do NOT reuse the EC2 one
ALLOWED_ORIGINS=https://oshoarchives.com,https://www.oshoarchives.com
OSHO_ENV=production

# --- Frontend ---
API_URL=https://api.oshoarchives.com

# --- Backups ---
B2_KEY_ID=...
B2_APPLICATION_KEY=...
B2_BUCKET=osho-backups
BACKUP_ENCRYPTION_PASSPHRASE=...   # generate fresh — store in 1Password too

# --- Server IPs (filled in after FlokiNET provisioning) ---
FRONTEND_IP=
BACKEND_IP=
```

## File index

| File | What it does | Where it runs |
|---|---|---|
| `01-harden-server.sh` | SSH keys, firewall, fail2ban, swap, unattended-upgrades | Each VPS, as root, once |
| `02-setup-frontend.sh` | Node 20, nginx, certbot, PM2, builds and starts Next.js | `osho-frontend`, as `osho` user |
| `03-setup-backend.sh` | Python 3.12, venv, FastAPI, nginx, certbot, systemd unit | `osho-backend`, as `osho` user |
| `04-migrate-db.sh` | scp the SQLite DB from EC2 → laptop → Iceland backend | Your laptop |
| `nginx-frontend.conf` | nginx site config for Next.js reverse proxy | Installed by script 02 |
| `nginx-backend.conf` | nginx site config for FastAPI reverse proxy | Installed by script 03 |
| `osho-backend.service` | systemd unit for uvicorn | Installed by script 03 |
| `ecosystem.config.js` | PM2 process definition for Next.js | Installed by script 02 |
| `backup-db.sh` | Encrypted nightly DB snapshot → B2 | Cron on `osho-backend` |
| `cloudflare-setup.md` | Cloudflare onboarding walkthrough | Reference |
| `dns-records.md` | The DNS records to create in Cloudflare | Reference |

## What is intentionally NOT here

- No GitHub Actions auto-deploy yet. We do the first deploy by hand to
  catch surprises. Once stable, we'll wire up a similar workflow to
  what's in `.github/workflows/deploy-backend.yml` but pointed at
  the Iceland backend's secrets.
- No reverse-tunneling. Origin IPs are hidden by Cloudflare proxy +
  origin nginx that **only accepts traffic from Cloudflare IP ranges**
  (configured in the nginx files). If anyone bypasses Cloudflare with
  the raw IP, nginx returns 403.
- No staging environment. The risk of skipping staging is lower than
  the risk of paying for a third VPS that nobody uses. We test locally
  before pushing.
