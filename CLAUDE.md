# Osho Discourse Search — Project Memory

This file is the durable context for anyone (human or agent) picking up work on this
codebase. Read top to bottom before suggesting changes.

---

## Product

Search engine + archive for Osho's complete discourses (~75K paragraphs, ~10K events).
Production: **oshoarchives.com** — a single sponsor-owned E2E Networks VPS
(`164.52.223.241`) running Next.js + FastAPI + SQLite/FTS5, behind Cloudflare.

Two user audiences:
- **Sannyasins worldwide** — search/read Osho's words verbatim, English + Hindi
- **Archivists (Antar, Rudra, et al.)** — ingest new talks, fix metadata, cross-check
  against ElasticSearch / OCTP / FileMaker Pro

---

## Architecture at a glance

> **Hosting history**: originally Vercel + EC2 (`13.206.34.214`).
> Moved 2026-05-19 to an E2E Networks VPS (`151.185.42.16`). Migrated
> again 2026-05-22 to a **sponsor-owned** E2E Networks VPS
> (`164.52.223.241`) so the project lives under the sponsor's account
> for long-term continuity. Both earlier boxes are retired. Cloudflare
> sits in front as DNS + edge TLS + proxy. See **Deployment** below for
> the full layout.

```
Cloudflare (DNS, edge TLS, proxy — ingress is Cloudflare-only)
  │
oshoarchives.com / api.oshoarchives.com
  │
E2E VPS 164.52.223.241  (Ubuntu 24.04)
  └── Next.js 14 app router  (frontend/)
        ├── /            — search                    (app/page.tsx)
        ├── /archive     — tree explorer             (components/Archive/TreeExplorer.tsx)
        ├── /constellation — clustered visualization (components/Constellation/Constellation.tsx)
        ├── /read        — full discourse reader     (app/read/page.tsx)
        ├── /help        — search guide              (app/help/page.tsx)
        └── /admin       — ADMIN_KEY-protected ops   (app/admin/page.tsx)

        API proxies → upstream backend:
        ├── /api/ask       — keyword search
        ├── /api/discourse — single discourse, w/ optional q for FTS highlights
        ├── /api/catalog   — full event list
        ├── /api/languages
        └── /api/admin/*   — admin ops (forwards x-admin-key header)

127.0.0.1:8000 (FastAPI on the same VPS, /home/osho/osho)
  └── uvicorn scripts.cloud_api:app
        ├── /api/search      — BM25-ranked FTS5 search
        ├── /api/discourse   — paragraphs w/ FTS5 highlight markers \x02 \x03 → «»
        ├── /api/catalog, /api/tags, /api/clusters, …
        └── /admin/*         — ingest, edit, tag, delete (x-admin-key required)

        DB: data/osho.db (SQLite, ~1.6 GB)
          ├── events          (id, title, date, location, language)
          ├── paragraphs      (id, event_id, sequence_number, content)
          ├── paragraphs_fts  (FTS5 virtual table — see Tokenizer below)
          └── event_tags      (event_id, tag) — auto-classified topic tags
```

---

## FTS5 tokenizer — CRITICAL CONFIG

`scripts/build_fts.py:103-113` is the single source of truth. Any change here requires a
**full index rebuild** on the VPS (~5-10 min for 75K paragraphs).

```sql
tokenize = "porter unicode61 remove_diacritics 1 categories 'L* N* Co Mn Mc'"
```

Why each piece matters:
- **`porter`** — English stemming (meditation ↔ meditate). Hindi unaffected (porter only
  stems Latin alphabetic).
- **`unicode61`** — Unicode-aware tokenisation.
- **`remove_diacritics 1`** — strips Latin combining marks (é → e). **NEVER use 2** —
  it also strips Devanagari matras and collapses unrelated words.
- **`categories 'L* N* Co Mn Mc'`** — includes Mn (Nonspacing Marks: virama, anusvara,
  nukta) and Mc (Spacing Combining Marks: vowel matras, visarga). The SQLite default
  `'L* N* Co'` treats these as separators, which silently splits every Hindi word at
  every matra/virama:
  - `धर्म` → `धर`+`म` (split at virama)
  - `विश्वास` → `व`+`श`+`व`+`स` (split at every matra)
  - `धन्य` → `धन`+`य` (so query `धन` falsely matches `धन्य`)

  This was the source of months of "why does my Hindi search match unrelated words"
  bugs (Antar's feedback re: Surya Ki Or Udan, Sermons in Stones, Anand Ki Khoj
  falsely matching `धन धर्म विश्वास`). Fixed in PR #32 (2026-05-11).

Devanagari danda `।` (category Po) remains a separator — correct.

---

## Devanagari query-time normalisation

Same code in two places (must stay in sync):
- `scripts/build_fts.py` `normalize_devanagari` (index-time)
- `scripts/cloud_api.py` `_normalize_devanagari` (query-time)

Both apply NFC + collapse `nasal-consonant + virama` → `anusvara (ं)` so `अनन्त` and
`अनंत` index/query identically.

Frontend (`frontend/lib/transliterate.ts` `buildHindiFtsQuery`) further expands queries
into OR variants for vowel-length (`a/ā, i/ī, u/ū`) and anusvara forms. **Only applies
in `mode === 'all'`** — phrase and NEAR modes use literal terms (correct, since you
can't OR inside `NEAR(…)` or `"…"`).

---

## Search modes & ranking

Three modes in `frontend/app/page.tsx` `buildQuery`:
- **phrase** → `"…"` (FTS5 phrase match, in order)
- **all** → bag of words (AND)
- **near** → `NEAR(w1 w2 …, N)` — N=tokens, default 30

**BM25 rank** + hit-count multiplier `cloud_api.py:597-599`:
```python
ev["rank"] = best_bm25 * max(log1p(hit_count), 1.0)
```
Lower = better. Discourses with more matching paragraphs rank higher even at the same BM25.

**Cross-paragraph NEAR** (`_augment_near_cross_paragraph`): only for `N >= 100`. For
narrower N, FTS5's in-row NEAR is used directly (FTS5 row = 1 paragraph).

**Highlights** flow:
- Backend wraps FTS5-matched tokens in `«…»` (search hits + discourse paragraphs when
  `?q=` is passed).
- Frontend `<Highlighted>` prefers `hl` markers; falls back to a client-side regex
  only when no paragraph in the discourse has `hl` (old backend / no query).
- `hasBackendHl` flag suppresses the regex fallback in non-matching paragraphs of the
  full-discourse view — otherwise NEAR queries over-highlight standalone words.

---

## Deployment

Everything runs on **one sponsor-owned E2E Networks VPS**
(`164.52.223.241`, Ubuntu 24.04). Cloudflare fronts it as DNS + edge
TLS + proxy.

> **Pending hardening**: the Cloudflare-only nginx restriction (return
> 403 to any non-Cloudflare source IP) that the previous box had has
> not yet been re-applied on this box. Until it is, the origin is
> reachable by direct IP. Re-add it from Cloudflare's published IP
> ranges.

> **SSH access**: key-based auth for the `osho` user. The private key
> is `~/.ssh/osho_e2e` (ed25519, `osho-e2e`); its public half is in
> `/home/osho/.ssh/authorized_keys` on the box.

```
SSH:   ssh -i ~/.ssh/osho_e2e osho@164.52.223.241
repo:  /home/osho/osho        (Python venv at .venv/, runs as user `osho`)

nginx :80/:443  — /etc/nginx/sites-available/osho (Cloudflare-only ingress: pending — see above)
  ├── oshoarchives.com  (+ www)  → 127.0.0.1:3000  (Next.js)
  └── api.oshoarchives.com       → 127.0.0.1:8000  (FastAPI)
       TLS via Certbot (/etc/letsencrypt/live/oshoarchives.com/)

Frontend  — PM2 app `osho-frontend`, runs `next start` on :3000
Backend   — systemd unit `osho-backend.service`, uvicorn
            `scripts.cloud_api:app` on 127.0.0.1:8000
            (--proxy-headers --forwarded-allow-ips=127.0.0.1)
```

Because frontend and backend share the box, the Next.js `/api/*`
proxy talks to FastAPI over **loopback** (`127.0.0.1:8000`) — never
the public IP or `api.oshoarchives.com` (the latter would 403, being
non-Cloudflare).

### Frontend redeploy
```bash
ssh -i ~/.ssh/osho_e2e osho@164.52.223.241
cd /home/osho/osho && git pull origin main
cd frontend && npm install && npm run build
pm2 restart osho-frontend
```

### Backend redeploy
```bash
ssh -i ~/.ssh/osho_e2e osho@164.52.223.241
cd /home/osho/osho && git pull origin main
# only when scripts/build_fts.py or data/** changed:
.venv/bin/python3 scripts/build_fts.py
sudo systemctl restart osho-backend.service
curl -s http://127.0.0.1:8000/health
```

### Automated deploy (GitHub Actions)

`scripts/deploy.sh` and the `deploy-backend.yml` / `publish-corpus.yml`
workflows are E2E-ready: they SSH in as `osho`, use `systemctl restart
osho-backend.service` and the `/home/osho/osho` path. The host
(`164.52.223.241`) is hardcoded in the workflows; no `BACKEND_HOST` /
`BACKEND_USER` secrets are used. For these to run on the new box:

1. **Repo secret `BACKEND_SSH_KEY`** — a private key whose public half
   is in `/home/osho/.ssh/authorized_keys` on the new box.
2. **Passwordless sudo** for the restart — add to
   `/etc/sudoers.d/osho` on the box:
   `osho ALL=(root) NOPASSWD: /usr/bin/systemctl restart osho-backend.service`
3. `publish-corpus.yml` also needs `gh` + `zstd` on the box (the
   workflow installs them on first run).

Until the `BACKEND_SSH_KEY` secret points at the new box, deploy by
hand with the blocks above.

### Provisioning scripts (live on the box, not yet in the repo)
`02-setup-single-vps.sh` and `refresh-cloudflare-ips.sh` configured
nginx + the Cloudflare IP allowlist. Worth pulling into the repo so
the box is reproducible.

---

## Security posture

- **`ADMIN_KEY`** — env var on EC2 (`ADMIN_KEY=...`). The default `"osho-admin"` in
  `cloud_api.py:26` MUST never be live in production. Backend now hard-fails on
  startup if `OSHO_ENV=production` and the key is default/missing.
- CORS: `ALLOWED_ORIGINS` env var (defaults to `https://osho-zeta.vercel.app`).
- All admin endpoints are gated by `_check_admin` which compares the `x-admin-key`
  header to `ADMIN_KEY` env var.

---

## Data freshness

Currently no repeatable bulk-ingestion pipeline. Adding a new talk:

**Preferred** (when docx pipeline is built): drop `*.docx` files with `@field=` headers
into the import directory, run `python3 scripts/ingest_docx.py <dir>`.

**Stopgap (today)**: paste the talk into `/admin/` → New event form. The admin ingest
applies `_normalize_devanagari` to both title and content before FTS insert.

---

## Recurring bugs / lessons learned

1. **Hindi tokenization at index time** — see FTS5 tokenizer section. The single
   biggest source of false positives / false negatives.
2. **Inter has no Devanagari glyphs** — must load Noto Sans Devanagari alongside Inter.
   Without it, browsers fall back to OS Devanagari fonts (Mangal/Devanagari MT) with
   inconsistent shaping. Fixed in PR #33.
3. **Vercel proxy silently dropping query params** — every API route under
   `frontend/app/api/` must explicitly forward each query param. Especially `q` to
   `/api/discourse` so the backend can return FTS5 `hl` markers. Fixed in PR #29.
4. **Anusvara vs. nasal-consonant** — both must be normalised at both index AND query
   time. Mismatch = silent zero matches.

---

## Code conventions

- Frontend: Next.js 14 app router, TypeScript, Tailwind. Use `t(...)` from
  `lib/i18n.tsx` for any user-visible string. Never inline `'भाषा' : 'Lang'`-style
  literals in components.
- Backend: FastAPI + raw sqlite3 (no ORM). Use parameterised queries always; never
  format SQL with f-strings except for the `where_extra` fragment which is built from
  trusted column names only.
- All Devanagari content/titles MUST be passed through `_normalize_devanagari` before
  insert / FTS match.

---

## Open known-issues backlog (audited 2026-05-11)

Tracked separately in this branch's PR; high-impact items first:

1. CRITICAL — ADMIN_KEY default in production (security)
2. CRITICAL — Deploy workflow broken (forces manual SSH every time)
3. CRITICAL — No docx ingestion pipeline
4. MODERATE — Hindi `Enter`-without-space submits Roman text (HindiInput stale closure)
5. MODERATE — Archive / Constellation / Help skip `t(...)` (English-only in Hindi locale)
6. MODERATE — Date range inputs don't auto-refresh
7. MINOR — Dead routes: `/ask`, `/nebula`, `/zen-tree`
8. MINOR — `total_hits` over-reports for narrow NEAR queries
