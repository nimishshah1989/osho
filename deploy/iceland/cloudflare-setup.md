# Cloudflare setup walkthrough

## Phase 1 — Add site (do this immediately, before anything else)

1. Sign up at https://dash.cloudflare.com/sign-up.
2. **Add a Site** → `oshoarchives.com` → **Free** plan.
3. Cloudflare scans your existing DNS. **Important:** verify the records
   it found match what's at your current registrar / Vercel. If anything
   is missing (e.g. MX records for email), add them manually before
   switching nameservers.
4. Cloudflare shows two assigned nameservers
   (e.g. `xena.ns.cloudflare.com`, `kirk.ns.cloudflare.com`).
   **Save these — you'll change them at the registrar in Phase 4.**
5. **STOP.** Do not switch nameservers at the registrar yet.

## Phase 2 — Set up DNS records for the new servers

Inside the Cloudflare dashboard for `oshoarchives.com` → **DNS → Records**:

Create (or update) these records. Leave **Proxy status** as **DNS only**
(grey cloud) for now — we'll flip to **Proxied** (orange cloud) after the
SSL certs are issued.

| Type | Name | Content | Proxy | TTL |
|---|---|---|---|---|
| A | `@` | `<FRONTEND_IP>` | DNS only | Auto |
| A | `www` | `<FRONTEND_IP>` | DNS only | Auto |
| A | `api` | `<BACKEND_IP>` | DNS only | Auto |

Delete or update any existing records pointing to Vercel
(`cname.vercel-dns.com`) or the old EC2 IP. Keep MX/SPF/DKIM intact if
you use email on this domain.

## Phase 3 — Switch nameservers at the current registrar

Only do this once Phase 2 records are in place.

1. Log into the current registrar (GoDaddy / Namecheap / wherever
   `oshoarchives.com` is today).
2. Replace the existing nameservers with the two Cloudflare nameservers
   from Phase 1.4.
3. Propagation usually completes within an hour, occasionally up to 24 h.
   During propagation some users will still hit the old (Vercel/EC2)
   stack — that's fine, keep both alive until propagation is complete.
4. Verify with `dig +short ns oshoarchives.com` — should return the
   Cloudflare nameservers.

## Phase 4 — Issue Let's Encrypt certificates on the origins

Wait until `dig +short A oshoarchives.com` returns `<FRONTEND_IP>` and
`dig +short A api.oshoarchives.com` returns `<BACKEND_IP>`. Then on each
VPS:

```bash
# Frontend VPS:
sudo certbot --nginx -d oshoarchives.com -d www.oshoarchives.com \
  --non-interactive --agree-tos --email you@example.com

# Backend VPS:
sudo certbot --nginx -d api.oshoarchives.com \
  --non-interactive --agree-tos --email you@example.com
```

certbot uses HTTP-01 challenge by default, hitting
`/.well-known/acme-challenge/`. Our nginx configs explicitly allow that
path for all clients (not just Cloudflare) so the challenge succeeds.

certbot also auto-renews via systemd timer — verify with:
```bash
sudo systemctl list-timers | grep certbot
```

## Phase 5 — Turn on Cloudflare proxy

Back in Cloudflare DNS, flip all three records (`@`, `www`, `api`) from
**DNS only** (grey) to **Proxied** (orange). This:

- Hides the origin IPs (people see Cloudflare's IPs, not FlokiNET's)
- Routes traffic through the Cloudflare CDN
- Triggers Cloudflare's free DDoS protection

## Phase 6 — SSL/TLS mode → Full (strict)

In Cloudflare dashboard → **SSL/TLS → Overview**:

- Set encryption mode to **Full (strict)**.

This means:
- Cloudflare → origin uses HTTPS (encrypted)
- Cloudflare validates the origin cert (must be a real Let's Encrypt cert, not self-signed)
- User → Cloudflare uses HTTPS with Cloudflare's edge cert

In **SSL/TLS → Edge Certificates**:
- Enable **Always Use HTTPS** (redirects http → https at the edge)
- Enable **Automatic HTTPS Rewrites**
- Min TLS version: **TLS 1.2**

## Phase 7 — Origin firewall lock-down (extra paranoia, optional)

To make sure no one can bypass Cloudflare and hit your origin IPs
directly even if they discover them:

1. FlokiNET-side firewall: in their control panel, restrict ports
   80 and 443 to only accept traffic from
   [Cloudflare's published IP ranges](https://www.cloudflare.com/ips/).
2. Server-side: our nginx config already enforces this via the
   `is_cloudflare` geo map and returns 403 to non-Cloudflare clients.
   Belt and braces is fine.

## Phase 8 — Useful Cloudflare settings to tweak

- **Caching → Configuration → Browser Cache TTL:** 4 hours (default)
- **Caching → Configuration → Caching Level:** Standard
- **Rules → Page Rules** (free plan: 3 rules):
  1. `api.oshoarchives.com/*` — Cache Level: Bypass (don't cache API responses)
  2. `oshoarchives.com/api/*` — Cache Level: Bypass (Next.js API routes)
  3. `oshoarchives.com/admin*` — Cache Level: Bypass, Security Level: High
- **Security → Bots → Bot Fight Mode:** ON (free, blocks the worst scrapers)
- **Security → Settings → Security Level:** Medium

## What this gives you against future DMCA

- Random complainant trying to find the host: they see Cloudflare's IPs
  in `dig` / `whois` / `host`. To find the actual origin they'd need to
  subpoena Cloudflare.
- Cloudflare's DMCA response is **forward to origin host** — they don't
  terminate proxy service for non-extreme content claims. So a DMCA
  notice arrives at FlokiNET, who require an Icelandic court order to
  act.
- DDoS / brute-force scrapers: absorbed by Cloudflare's edge.
- Domain transfer to Njalla later removes the registrar layer of attack.
