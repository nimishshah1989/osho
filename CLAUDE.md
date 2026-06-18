# Osho Discourse Search — Project Memory

This file is the durable context for anyone (human or agent) picking up work on this
codebase. Read top to bottom before suggesting changes.

---

## Product

Search engine + archive for Osho's complete discourses (~1.3M paragraphs, ~10K events).
Production: **oshoarchives.com** — a single sponsor-owned E2E Networks VPS
(`164.52.223.241`) running Next.js + FastAPI + SQLite/FTS5, behind Cloudflare.

> **Corpus size:** the `paragraphs` table holds **1,327,403** rows (measured on
> the production DB, 2026-06-18). Earlier versions of this doc said "~75K" — that
> was a stale early-load estimate, not the live corpus. ~1.3M paragraphs across
> ~10K events (≈130 paragraphs/discourse) is the real scale, and it's why broad
> Hindi all-words queries are the latency-sensitive case (see **Search performance**).

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
        ├── /help        — search guide + corpus version badge  (app/help/page.tsx)
        └── /admin       — ADMIN_KEY-protected ops   (app/admin/page.tsx)
        (/downloadapp was removed 2026-06-17 — Sugit @29; desktop app is the
         going-forward offline path. See Offline section below.)

        API proxies → upstream backend:
        ├── /api/ask       — keyword search
        ├── /api/discourse — single discourse, w/ optional q for FTS highlights
        ├── /api/catalog   — full event list
        ├── /api/languages
        ├── /api/version   — corpus data version date (no auth)
        └── /api/admin/*   — admin ops (forwards x-admin-key header)

127.0.0.1:8000 (FastAPI on the same VPS, /home/osho/osho)
  └── uvicorn scripts.cloud_api:app
        ├── /api/search      — BM25-ranked FTS5 search
        ├── /api/discourse   — paragraphs w/ FTS5 highlight markers \x02 \x03 → «»
        ├── /api/version     — returns corpus_meta["corpus_version"] (no auth)
        ├── /api/catalog, /api/tags, /api/clusters, …
        └── /admin/*         — ingest, edit, tag, delete (x-admin-key required)
              ├── /admin/ingest          — paste a single talk (JSON)
              ├── /admin/upload-docx     — bulk zip of .docx files (multipart)
              └── /admin/batch-update    — Add/Modify/Delete zip batch (multipart)

        DB: data/osho.db (SQLite, ~1.6 GB)
          ├── events          (id, title, date, location, language)
          ├── paragraphs      (id, event_id, sequence_number, content)
          ├── paragraphs_fts  (FTS5 virtual table — see Tokenizer below)
          ├── event_tags      (event_id, tag) — auto-classified topic tags
          └── corpus_meta     (key, value) — e.g. corpus_version → "2026-05-24"
```

---

## FTS5 tokenizer — CRITICAL CONFIG

`scripts/build_fts.py:103-113` is the single source of truth. Any change here requires a
**full index rebuild** on the VPS (~10-15 min for the full ~1.3M-paragraph corpus).

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

**Cross-paragraph NEAR**: now **always used**, for every N (record-level
token-window in `_record_level_search` / TS `recordLevelSearch`). The earlier
`dist_p > 100` gate (PRs #94/#95) was an overcorrection — Sugit confirmed OCTP
matches across paragraph boundaries, so PR #99 removed it. A NEAR hit counts when
the units fall within N tokens of each other across the discourse, not just
within one FTS5 row (= one paragraph).

**Highlights** flow:
- Backend wraps FTS5-matched tokens in `«…»` (search hits + discourse paragraphs when
  `?q=` is passed).
- Frontend `<Highlighted>` prefers `hl` markers; falls back to a client-side regex
  only when no paragraph in the discourse has `hl` (old backend / no query).
- `hasBackendHl` flag suppresses the regex fallback in non-matching paragraphs of the
  full-discourse view — otherwise NEAR queries over-highlight standalone words.

---

## Search performance (latency)

The OCTP-parity record-level search (per-unit event-set intersection + token
windows) is correct but expensive on the broadest queries, because the corpus is
~1.3M paragraphs, not the ~75K this doc once claimed. PRs #105–#109 (2026-06-13
to 2026-06-18) cut the worst cases roughly in half **without changing a single
result**. The optimizations, in order, in `scripts/cloud_api.py`
`_record_level_search` (mirrored in TS `frontend/lib/search/engine.ts`
`recordLevelSearch`):

- **#105/#106 — stop shipping duplicate hit text.** When a hit's `hl` already
  carries the `«…»` markers the frontend renders, the response no longer also
  ships the raw `content` (set `content=''` when `'«' in hl`). Applied to the
  record-level path **and** the single-word/phrase MATCH path (the single-word
  path is separate legacy code — #105 missed it, #106 caught it). ~40% smaller
  payloads on broad queries (e.g. नक्षत्र 143 KB → 83 KB).
- **#107 — defer `highlight()` to displayed hits only.** FTS5 `highlight()` costs
  ~10× a plain column read. It used to run for every matched paragraph; now it
  runs only for the ≤N paragraphs actually returned. A post-pass re-fetches
  `content` + `hl` for just the displayed `pid`s.
- **#108 — batch the per-event lookup.** Event rows are fetched in chunked
  `IN (…)` queries (5000 per chunk) instead of one query per event, and the bulk
  content fetch is skipped (the post-pass covers displayed hits).
- **#109 — compute the all-words count + display set in SQL.** The window-function
  query (`ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY sq)`,
  `COUNT(*) OVER (PARTITION BY event_id)`) does the per-event counting and
  top-N selection in SQLite instead of materializing every matching row in Python.

`_RECORD_LEVEL_EVENT_CAP = 2000`; the inner FTS scan keeps `LIMIT 100000`.

**Measured (production, old → new), parity verified across 17 EN+HI cases:**
- `मन की शांति` (Hindi all-words, the worst case): **8.4 s → 3.0 s**
- `प्रेम ध्यान शांति` all-words: 4.0 s → 2.3 s
- `love intelligence awareness` all-words exact: 3.6 s → 3.3 s
- single-word `meditation`: 2.2 s → 1.0 s
- Every `total` and `hit-count` is **identical** old-vs-new (this was the
  hard constraint — "optimize latency without changing results/logic").

**Still at the parity floor** (not yet improved without a behaviour change):
cross-paragraph NEAR (3.6–10.8 s on broad terms) and `मन की शांति` (~3 s). Going
lower needs either pagination (a UX change) or a different FTS5-positions
mechanism — both deliberately deferred so results stay byte-identical to OCTP.
The parity harness lives in `scripts/tests/test_search.py` +
`frontend/lib/search/__tests__/engine.test.ts`; re-run it before touching this path.

---

## Offline PWA & desktop app

The **desktop Electron app is the going-forward offline path.** The in-browser
"download the corpus" flow was removed 2026-06-17 (Sugit @29): `/downloadapp` and
`components/OfflineSetup.tsx` (the only frontend code that read
`NEXT_PUBLIC_CORPUS_DOWNLOAD_URL`) are gone, and the Help page's "Offline Use"
section with them. **What's removed vs. what's retained:**

- **Removed** — `app/downloadapp/page.tsx`, `components/OfflineSetup.tsx`, the
  Help "Offline Use" section. The live site therefore no longer auto-downloads a
  ~400 MB corpus into the browser. `NEXT_PUBLIC_CORPUS_DOWNLOAD_URL`
  (`frontend/.env.production` → stable `corpus-latest` GitHub Release asset) is
  still set, but **no live frontend component reads it anymore** — it now feeds
  only the corpus-publish tooling and the desktop bundle.
- **Retained** — the PWA shell still installs (`public/manifest.webmanifest`,
  `public/sw.js`, `components/PwaRegistrar.tsx`, `components/DesktopGate.tsx`),
  and the full TypeScript search engine (`frontend/lib/search/`: sqlite-wasm +
  OPFS web worker, `OfflineProvider`, `engine.ts`, …) stays because **the desktop
  build depends on it.** Do not delete `lib/search/` thinking it's dead PWA code.
- **Desktop app** — `desktop/` is an Electron shell that bundles the built
  frontend and the corpus, offline from first launch. Installers are built in CI
  by `.github/workflows/build-desktop.yml`.
- **Corpus publishing** — `.github/workflows/publish-corpus.yml` (nightly +
  manual) rebuilds the compressed `.zst` corpus on the VPS and replaces the
  `corpus-latest` release asset, keeping the desktop/offline copy in sync with the
  live DB. See `docs/OFFLINE_APP.md` for the full runbook.

The TS engine in `frontend/lib/search/` must stay behaviour-compatible with
`scripts/cloud_api.py` — tokenizer, Devanagari normalisation, BM25 ranking, NEAR
semantics, **and the #105–#109 perf shape** are all duplicated and covered by
tests in `frontend/lib/search/__tests__/`.

---

## Deployment

Everything runs on **one sponsor-owned E2E Networks VPS**
(`164.52.223.241`, Ubuntu 24.04). Cloudflare fronts it as DNS + edge
TLS + proxy.

Cloudflare is the only allowed ingress — the two HTTPS server blocks
`include /etc/nginx/snippets/cloudflare-allow.conf`, an `allow` list of
Cloudflare's published IP ranges ending in `deny all`, so any direct-IP
request returns 403. Regenerate that snippet when Cloudflare's ranges
change:

```bash
{ curl -s https://www.cloudflare.com/ips-v4; echo; \
  curl -s https://www.cloudflare.com/ips-v6; } \
  | grep -v '^[[:space:]]*$' | sed 's/^/allow /; s/$/;/' \
  > /etc/nginx/snippets/cloudflare-allow.conf
echo 'deny all;' >> /etc/nginx/snippets/cloudflare-allow.conf
nginx -t && systemctl reload nginx
```

> **HTTP/3 (QUIC) is disabled at Cloudflare** (dashboard → **Speed →
> Optimization → HTTP/3 (with QUIC)**, toggle OFF — Cloudflare moved this
> control out of the old Network tab). Reason: a user in Germany on **O2 /
> Telefónica** got a persistent blank screen; a VPN fixed it. Root cause was
> O2's network mishandling QUIC (UDP/443) — Cloudflare was advertising
> `alt-svc: h3=":443"`, browsers upgraded to HTTP/3, and that path silently
> failed on O2 while HTTP/1.1/2 over TCP worked. Disabling HTTP/3 drops the
> `alt-svc` advertisement so every client stays on TCP. Verify with
> `curl -sI https://oshoarchives.com | grep -i alt-svc` — it should return
> nothing. This is a Cloudflare-dashboard setting, **not in the repo**; re-check
> it if blank-screen-on-one-ISP reports recur.

> **SSH access**: key-based auth for the `osho` user. The private key
> is `~/.ssh/osho_e2e` (ed25519, `osho-e2e`); its public half is in
> `/home/osho/.ssh/authorized_keys` on the box.

```
SSH:   ssh -i ~/.ssh/osho_e2e osho@164.52.223.241
repo:  /home/osho/osho        (Python venv at .venv/, runs as user `osho`)

nginx :80/:443  — /etc/nginx/sites-available/osho, Cloudflare-only ingress
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

### Frontend redeploy (manual — automated via GitHub Actions, see below)
```bash
ssh -i ~/.ssh/osho_e2e osho@164.52.223.241
cd /home/osho/osho
bash scripts/deploy-frontend.sh
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

Both halves deploy on push to `main`:
- **`deploy-frontend.yml`** → `scripts/deploy-frontend.sh` — fires on
  `frontend/**` changes; runs `git pull --ff-only` → `npm ci` (if package files
  changed) → **`rm -rf .next`** → `npm run build` → `pm2 restart osho-frontend` →
  **two-stage healthcheck**. The script was hardened in PR #102 after the
  **2026-06-16 blank-page incident** (see Recurring bugs #6): an in-place rebuild
  had left `.next` referencing chunk hashes that were never written to disk, so
  fresh visitors got 400s on those chunks and a blank page while cached visitors
  saw nothing wrong, and the old `'/' returns 200` healthcheck passed anyway. Now
  it (a) always builds from a clean `.next`, and (b) after restart curls **every**
  `/_next/static` asset the homepage HTML references and fails the deploy loudly
  if any returns non-200.
- **`deploy-backend.yml`** → `scripts/deploy.sh` — fires on backend
  script / `requirements.txt` / `data/**` changes; pull → pip install →
  FTS rebuild (conditional) → `systemctl restart osho-backend.service` →
  healthcheck `/health`.

> **Never commit on the VPS.** Both deploy scripts `git pull --ff-only`, which
> aborts if the box's `main` has diverged. That's exactly what wedged the #102
> deploy: someone had committed UI fixes directly on the box (`78ff821` "UI
> feedback follow-up @32") that were never pushed, so `--ff-only` refused to move.
> Recovery without losing the work: `git fetch origin && git rebase origin/main &&
> git push origin main` (which re-landed that commit as `24eeb65`). The box's repo
> must only ever fast-forward from `origin/main` — all edits flow through git →
> PR → `main` → auto-deploy. `deploy-frontend.sh` also has a lookahead that
> handles untracked working-tree files (the 2026-05-30 `.env.production`
> incident), but it cannot rescue a local *commit* — only the rebase above can.

`scripts/deploy.sh`, `scripts/deploy-frontend.sh` and the
`deploy-backend.yml` / `deploy-frontend.yml` / `publish-corpus.yml`
workflows are E2E-ready: they SSH in as `osho` and use the
`/home/osho/osho` path. The host (`164.52.223.241`) is hardcoded in the
workflows; no `BACKEND_HOST` / `BACKEND_USER` secrets are used. All three
deploy workflows reuse the single `BACKEND_SSH_KEY` secret. For these to
run on the new box:

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

- **`ADMIN_KEY`** — env var on the VPS, read from `/etc/osho/backend.env` (via
  `EnvironmentFile=` in the systemd unit). The default `"osho-admin"` MUST never be live in
  production. Backend hard-fails on startup if `OSHO_ENV=production` and the key
  is default/missing.
- CORS: `ALLOWED_ORIGINS` env var (code default `https://oshoarchives.com`).
- All admin endpoints are gated by `_check_admin` which compares the `x-admin-key`
  header to `ADMIN_KEY` env var.

---

## Data freshness

### Self-service ingestion (preferred — no SSH needed)

The admin UI at `/admin` → **Corpus Update** tab exposes the full pipeline to
non-technical archivists. Two modes, both require the `ADMIN_KEY`:

**Bulk ingest** (`POST /admin/upload-docx`) — for the initial corpus load or a
full re-sync. Upload a `.zip` of `.docx` files in any subdirectory layout
(e.g. `English/`, `Hindi/`). Every file is upserted idempotently on
`(title, language)`. `Texts by Others/` is silently skipped. Best-effort: file
parse errors are recorded and reported but don't abort the rest. Supports
dry-run.

**Structured update** (`POST /admin/batch-update`) — for Antar's monthly
`WordDB YYYY-MM-DD/` batches. Upload a `.zip` containing `Add/`, `Modify/`,
`Delete/` subfolders (top-level or one level inside a dated wrapper folder).
All-or-nothing transaction: any failure rolls back the whole batch. Supports
dry-run.

Both modes accept an optional **corpus version date** (e.g. `"2026-05-24"`)
that is saved to `corpus_meta` on a successful non-dry-run and shown on the
Help page as "Data version YYYY-MM-DD" via `CorpusVersionBadge`.

### CLI (SSH required, for large corpus or scripting)

**Bulk `.docx`**: `python3 scripts/ingest_docx.py <dir>` (walks recursively;
`--dry-run` to parse-only). Upserts by `(title, language)`.

**Batch update**: `python3 scripts/word_update.py <root>` where `<root>`
contains `Add/`, `Modify/`, `Delete/` subfolders. Transactional.

**Staging/review**: `scripts/make_staging.py` copies live DB → `staging.db`;
`scripts/diff_db.py` diffs them before cutover.

### Quick fixes — admin UI

Paste a single talk into `/admin/` → **Upload New Talk** tab. The
`/admin/ingest` endpoint applies `_normalize_devanagari` before FTS insert.

### Note on the DB

The data lives only on the VPS (`/home/osho/osho/data/osho.db`) and is
gitignored — moved between machines by rsync, never committed.

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
5. **HTTP/3 / QUIC blank screen on one ISP** — if the site is blank for a user on
   one network but fine over a VPN or another ISP, suspect QUIC, not your build.
   Some carriers (confirmed: O2/Telefónica Germany) mishandle UDP/443. HTTP/3 is
   now disabled at Cloudflare to avoid it (see Deployment). `curl -sI` the site and
   check `alt-svc` is absent before chasing app-level causes.
6. **Broken build → blank page for *fresh* visitors only** — if the site works for
   you (cached assets) but is blank for others, the served HTML is likely
   referencing `/_next/static` chunks that 400. An in-place `next build` can leave
   `.next` inconsistent (esp. if OOM-killed). The deploy script now `rm -rf .next`
   and verifies every homepage asset resolves; a `'/' returns 200` check alone does
   **not** catch this. (2026-06-16 incident; PR #102.)
7. **Never commit on the VPS** — local commits on the box make `git pull --ff-only`
   (used by both deploy scripts) abort. Recover with
   `git fetch origin && git rebase origin/main && git push origin main`; never force
   a divergent state. See Deployment for the full note.
8. **Record-level search latency on broad queries** — the OCTP-parity record-level
   path is expensive at ~1.3M paragraphs, and the slow cases are broad Hindi
   all-words / NEAR. The fix is always *mechanical* (defer `highlight()`, push
   counting into SQL window functions, batch lookups, slim the payload — PRs
   #105–#109), **never** loosening the matching logic. Every change to this path
   must keep `total` and `hit-count` byte-identical to OCTP — re-run the parity
   harness (`scripts/tests/test_search.py`, `engine.test.ts`) before shipping.

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

## Open known-issues backlog (audited 2026-06-18)

### Resolved — PRs #85–87 (2026-05-22 audit, Sugit's first feedback batch)
- `searchApi` null crash ("can't access property 'total'") — null guard
- No highlights in top-matches card for NEAR/All-words — `_record_level_search` stores `hl`
- Arrow nav halts on discourse title (seq 0) — `isNavParagraph` guard
- Full discourse over-highlights every word for NEAR — `_near_hl_for_discourse` scopes to window
- FTS5 keyword collision ("Or"/"And" in Hindi): `_parse_query_units` only rejects uppercase keywords for whitespace-split
- Self-service ingestion via `/admin` (no SSH needed) — PR #87
- Corpus version badge on Help page

### Resolved — PRs #91–95 (2026-06-03 to 2026-06-06, Sugit's second feedback batch)

**PR #91** — title_search hl leak, record-level improvements
- `paragraphs_fts` title_search column generated spurious hl markers → every paragraph was a nav stop when a title word matched. Fixed: discourse endpoint now skips hl rows with no `\x02` markers.
- `_record_level_search` added `LIMIT 100000` and broad `except Exception` to survive timeout on common Hindi words.
- `_max_hits=None` for `_near_hl_for_discourse` so full proximity window is highlighted.
- `Highlighted` component and `matchIndices` now guard `hl.includes('«')` to skip title-only matches.

**PR #92** — `language=all` returning 0 results
- Backend treated "all" as a literal language name. Fixed: `language.lower() not in ('all', '*', '')` skip.
- Same fix in offline TS engine.

**PR #93** — Mixed-case "Or"/"And" rejected as FTS5 keywords
- `_parse_query_units` used `.upper()` before keyword check. FTS5 keywords are case-sensitive (only `OR`, `AND`, `NOT`, `NEAR` are operators). Fixed: exact string comparison, `re.IGNORECASE` flag removed from TS regex.

**PR #94** — Narrow NEAR (N < 100) false positives via cross-paragraph
- Cross-paragraph record-level NEAR was firing for all N. For N < 100, words in different paragraphs were counted as "within N tokens" producing false positives. Fixed: cross-paragraph only for N > 100 (slider max is 100, so all UI NEAR queries now use FTS5 in-paragraph).

**PR #95** — Sugit's second email: @6 @11 @14–@16 @17
- @6/@11: NEAR=100 exact giving wrong counts vs OCTP. Same fix as PR #94 (threshold now `> 100` not `>= 100`).
- @14/@16: Discourse endpoint ignored `exact` flag — highlights used stemmed FTS even in exact mode. Fixed: `/api/discourse` now accepts `exact` param, uses `paragraphs_fts_exact`, forwarded through proxy route + API client + offline engine.
- @15: "women's liberation" → ~9900 hits. Apostrophe handling in `_rewrite_query` / `_parse_query_units` was replacing `'s` with space, emitting a lone "s" token that matches everything. Fixed: strip possessive `'s` first (`_POSSESSIVE_RE`), then replace remaining apostrophes. Same fix in TS `queryRewrite.ts`.
- @17: Full discourse + right arrow now navigates to next discourse (was: stepped through match paragraphs). When `<details>` is open, `←`/`→` call `navigateEvent`; when closed, original `jumpToMatchAcross` behaviour is kept.

**PR #96** — Backend SyntaxError hotfix (2026-06-06)
- `cloud_api.py` lines 292 and 374 had U+2018/U+2019 (curly apostrophes) used as Python string delimiters in `_POSSESSIVE_RE.sub('', q)`. Python 3 rejects non-ASCII quote characters as string delimiters → `SyntaxError` → 502 on every API request. Fixed: replaced with ASCII straight-quote empty strings.

**PR #97** — Frontend build SyntaxError hotfix (2026-06-06)
- `frontend/lib/search/queryRewrite.ts` had same curly-quote delimiter bug on lines 71, 74, 157. TypeScript/webpack rejects non-ASCII string delimiters → `Build failed`. Fixed: ASCII straight quotes; curly quotes inside regex character classes (`/['']/g`) left untouched (they intentionally match U+2018/U+2019 in user queries).

**PR #98** — @5: broad Hindi query warning (2026-06-08)
- `परमात्मा की तरफ जिसे जाना` All-words Exact was returning 2270 events / 811 KB response → NetworkError. Fixed: `_TOO_MANY_THRESHOLD = 500`. When `true_total_events > 500`, API sets `too_many: true`, trims to 1 hit per event, strips paragraph `content` (keeps `hl`). Frontend shows amber warning: "Query matched N discourses — add more specific words." Applied to both backend and offline TS engine.

### Resolved — PRs #99–100 (2026-06-12, Sugit's third feedback batch)

**PR #99** — re-enabled cross-paragraph NEAR + three @17 discourse-view bugs
- PRs #94/#95 overcorrected: the `dist_p > 100` gate disabled cross-paragraph proximity for all N ≤ 100 (the entire UI slider range). Sugit confirmed OCTP DOES match across paragraph boundaries. Fixed: gate removed, cross-paragraph always used.
- @17-A: exact-phrase mode showed no yellow highlights in hit paragraph. Root cause: `hasBackendHl ? null : pattern` suppressed all regex fallback when ANY paragraph had `«»` markers — but `paragraphs_fts_exact` is contentless on production, so the hit paragraph never gets markers. Fixed: per-paragraph `isMatch ? highlightPattern : null`.
- @17-B: arrow key while discourse panel open was calling `navigateEvent` (jumped to next discourse) instead of `jumpToMatchAcross` (stepped through hits). Fixed: handler checks `discourseDetailsRef.current?.open`; added `pendingOpenDetailsRef` to auto-open panel when stepping into a new discourse.
- @17-C: non-hit context paragraphs (e.g., "You are asking me...") appeared inside the proximity window border box. Root cause: `display_seqs = [...] or window_seqs` fallback. Fixed: removed the fallback — `display_seqs = []` when no FTS-matched paragraphs are in the window.
- @13: Hindi `Agyat Ki Or + अज्ञात` NEAR=100 was returning 0. Fixed by re-enabling cross-paragraph.

**PR #100** — skip stale FTS positions in NEAR window calculation (2026-06-12)
- Root cause of @6 and @2 over-counting: paragraphs deleted from the `paragraphs` table (e.g., discourse re-ingested with fewer paragraphs) leave stale rows in FTS. `seq_off.get(seq, 0)` defaulted to 0 for missing seqs, collapsing all stale positions near zero → they trivially passed any NEAR window check.
- Fix: `seq_off.get(seq)` returns `None` for stale seqs → skip them. If all positions for a unit are stale, `ok = False` → event excluded.
- @6 `love intelligence awareness meditation` NEAR=100 exact: 20 → 10 (OCTP: 10 ✓)
- @2 `enlightenment trust love` NEAR=20 exact: 13 → 8 (OCTP: 5; delta = known stop-word gap)
- @11 `enlightenment trust love awareness` NEAR=100 exact: 2 → 0 (both were false positives; genuine OCTP match needs FTS rebuild on VPS — see item 9 below)

### Resolved — PRs #101–#109 + ops (2026-06-13 to 2026-06-18, Sugit's UI batch + speed + incidents)

**PR #101 — Sugit UI/layout batch @18–@36**
- @18 hide the Spelling (Stemmed/Exact) control in Exact-phrase mode (phrase is always exact). This is the "missing tabs" some users reported — the control is *intentionally hidden in phrase mode*, by Sugit's own request, not removed.
- @22/@23 filters rebuilt as compact labeled **dropdowns** (new `FilterSelect`); "Lang"→"Language". Again — the old inline tab-buttons becoming dropdowns is the other half of the "missing tabs" reports.
- @24 Sort moved to last; @25a new **Time** (chronological) sort — backend + offline engine + types + proxy + tests; @25b "discourses"→"records"; @26 count folded into list header.
- @19 scroll active record into view on keyboard nav; @20 dropped "OSHO · Discourse Search" title, bold active nav tab; @21 bordered rounded search input with inline magnifier.
- @31–@36 record typography: tighter event-info block, sannyas.wiki title linkified (@32), `osho_talking` first-line indent, italics for other-talking & poem, soft line breaks via `whitespace-pre-wrap`.

**PRs #103/#104 — layout/margins (follow-up to the same feedback)**
- Widened the layout shell to `max-w-[1600px]`, trimmed left/right/bottom margins for more reading space; compacted the search box; kept the RANK header on one line (`whitespace-nowrap flex-shrink-0`); taller result panes.

**Commit `24eeb65` — `/downloadapp` removed (@29) + Help accuracy**
- Removed `app/downloadapp/page.tsx` and `components/OfflineSetup.tsx`; desktop app is the going-forward offline path (see Offline section). Help page audited against the live UI (Match filter, Spelling section, Sort Order incl. Time, "records").

**PR #102 — deploy hardening (2026-06-16 blank-page incident)**
- `scripts/deploy-frontend.sh` now `rm -rf .next` before build + verifies every homepage `/_next/static` asset resolves post-restart. See Recurring bugs #6 and Deployment.

**PRs #105–#109 — search latency (no result changes)**
- See **Search performance** above. Worst case `मन की शांति` 8.4 s → 3.0 s; all `total`/`hit-count` byte-identical to OCTP across 17 EN+HI parity cases.

**Ops — HTTP/3 disabled at Cloudflare**
- Disabled QUIC (Speed → Optimization) to fix blank screens for an O2/Germany user. See Recurring bugs #5 and Deployment. Not a repo change.

**FTS rebuild on VPS (2026-06-12)** — `paragraphs_fts_exact` is now content-bearing and all then-stale FTS entries were cleared (closes the prior @11 "exact-mode NEAR finds 0" item).

### Still open (as of 2026-06-18)

**High priority (archivist-visible):**
1. **@3** — Intermittent: title match occasionally lands arrow-key nav on seq=0. Believed fixed in PR #91; needs Sugit confirmation.

**Moderate priority (UX):**
2. Hindi `Enter`-without-space submits Roman text (HindiInput stale closure)
3. Archive / Constellation / Help pages skip `t(...)` — English-only in Hindi locale
4. Date range inputs don't auto-refresh after typing (requires explicit submit)

**Minor / ops:**
5. Dead routes: `/ask`, `/nebula`, `/zen-tree` — return 404, should redirect to `/`
6. `total_hits` over-reports for narrow NEAR (N < 20)
7. Provisioning scripts (`02-setup-single-vps.sh`, `refresh-cloudflare-ips.sh`) live only on the box, not in the repo
8. Stale FTS entries accumulate on each ingest without a full rebuild. Long-term fix: also `DELETE FROM paragraphs_fts WHERE paragraph_id = ?` when paragraphs are removed during batch-update / re-ingest. Short-term: run `build_fts.py` on VPS after each Antar batch (last full rebuild 2026-06-12).
9. **Search latency floor** — broad cross-paragraph NEAR (3.6–10.8 s) and `मन की शांति` (~3 s) remain after PRs #105–#109. Further speedups need pagination (UX change) or a different FTS5-positions mechanism; deferred to keep results identical to OCTP.
