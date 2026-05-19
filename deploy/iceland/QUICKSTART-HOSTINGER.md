# Hostinger VPS — fast deploy (single box, both vhosts)

This is the express path: one Hostinger KVM VPS, both Next.js frontend and
FastAPI backend on the same machine, fronted by Cloudflare. Target time
end-to-end: **~90 minutes**, mostly waiting for builds and FTS rebuild.

## Step 1 — Order Hostinger KVM 2 (you, 3 min)

- https://www.hostinger.com/vps-hosting → **KVM 2**
- Specs: 2 vCPU, 8 GB RAM, 100 GB NVMe
- **Datacenter: Netherlands or Lithuania** (NOT India / Mumbai)
- **OS: Ubuntu 24.04 LTS** (plain — no control panel)
- Hostname: `osho-server`
- Paste SSH public key during setup if Hostinger asks; otherwise the
  hardening script installs it.

Wait 2–5 minutes for provisioning. Hostinger emails you the IP and root password.

## Step 2 — Harden the server (3 min)

From your laptop:

```bash
SSH_PUBKEY="$(cat ~/.ssh/osho_iceland.pub)"   # or whichever key you generated
IP=<hostinger-ip>

scp deploy/iceland/01-harden-server.sh root@$IP:/root/
ssh root@$IP "SSH_PUBKEY='$SSH_PUBKEY' HOSTNAME_NEW=osho-server bash /root/01-harden-server.sh"

# Verify in a second terminal BEFORE closing the root session:
ssh -i ~/.ssh/osho_iceland osho@$IP "hostname; sudo whoami"
# Should print: osho-server / root
```

## Step 3 — Push the repo to the VPS (2 min)

```bash
rsync -av --delete \
  --exclude node_modules --exclude .next --exclude .venv \
  --exclude '*.log' --exclude '.git/objects' \
  ./ osho@$IP:/home/osho/osho/
```

## Step 4 — Migrate the database from EC2 (10–30 min depending on link)

```bash
EC2_HOST=ubuntu@13.206.34.214 \
EC2_SSH_KEY=~/.ssh/jsl-wealth-key.pem \
BACKEND_IP=$IP \
BACKEND_SSH_KEY=~/.ssh/osho_iceland \
bash deploy/iceland/04-migrate-db.sh
```

This pulls a consistent snapshot from EC2 and uploads it to the Hostinger box.

## Step 5 — Set ADMIN_KEY and run the consolidated setup (15 min)

```bash
ssh osho@$IP
cd /home/osho/osho

# First run will create /etc/osho/backend.env with a placeholder and exit.
DOMAIN=oshoarchives.com bash deploy/iceland/02-setup-single-vps.sh

# Generate a real ADMIN_KEY and put it in the env file:
openssl rand -hex 32                # copy the output
sudo nano /etc/osho/backend.env     # paste into ADMIN_KEY=...

# Re-run — this time it builds frontend, rebuilds FTS, starts services.
DOMAIN=oshoarchives.com bash deploy/iceland/02-setup-single-vps.sh
```

The script prints the VPS public IP at the end. Note it.

## Step 6 — Cloudflare DNS (5 min)

In Cloudflare dashboard → oshoarchives.com → DNS → Records. Delete the
old Vercel / EC2 records, then add:

| Type | Name | Content | Proxy | TTL |
|---|---|---|---|---|
| A | `@`   | `<HOSTINGER_IP>` | **DNS only** (grey) | Auto |
| A | `www` | `<HOSTINGER_IP>` | **DNS only** (grey) | Auto |
| A | `api` | `<HOSTINGER_IP>` | **DNS only** (grey) | Auto |

Verify nameservers are set at the registrar (`dig +short ns oshoarchives.com`).
Verify the A records resolve to the Hostinger IP (`dig +short A oshoarchives.com`).

## Step 7 — SSL certs (3 min)

```bash
ssh osho@$IP
sudo certbot --nginx \
  -d oshoarchives.com -d www.oshoarchives.com -d api.oshoarchives.com \
  --non-interactive --agree-tos --email <your-email>
```

## Step 8 — Flip Cloudflare proxy ON (1 min)

In Cloudflare DNS, toggle all three records from **DNS only** (grey) to
**Proxied** (orange).

Then SSL/TLS → Overview → **Full (strict)**.

## Step 9 — Smoke test (5 min)

In a real browser:

- [ ] https://oshoarchives.com loads
- [ ] Search a known phrase — results come back
- [ ] Click a discourse — paragraphs render with highlights
- [ ] /archive — tree explorer works
- [ ] Hindi search (`अनंत`, `धर्म`) returns expected matches
- [ ] /admin — accepts the new ADMIN_KEY

If all green, you're live.

## Step 10 — Decommission EC2 and Vercel (after 48 h of stable traffic)

- Vercel: delete the project
- AWS: stop (don't terminate) the EC2 for 2 weeks as insurance

## Swap to the new domain later

When your colleague's domain is ready:

1. In Cloudflare (or the new DNS provider for that domain), point A
   records `@`, `www`, `api` at the same Hostinger IP.
2. Add the new domain to nginx: edit
   `/etc/nginx/sites-available/osho`, add the new domain to both
   `server_name` lines.
3. Re-issue certs to cover the new domain:
   `sudo certbot --nginx -d ... -d <newdomain> -d www.<newdomain> -d api.<newdomain>`
4. Update `/etc/osho/backend.env` → add the new domain to
   `ALLOWED_ORIGINS=...`. Restart: `sudo systemctl restart osho-backend`.
5. Update `frontend/.env.production` → set `API_URL` to the new
   `api.<newdomain>`. Rebuild and pm2 reload:
   `cd /home/osho/osho/frontend && npm run build && pm2 reload osho-frontend`.

No server rebuild needed. Whole swap is ~15 minutes.
