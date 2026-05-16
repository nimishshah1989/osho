# Osho Discourse Search — Project Memory

This file is the durable context for anyone (human or agent) picking up work on this
codebase. Read top to bottom before suggesting changes.

---

## Product

Search engine + archive for Osho's complete discourses (~75K paragraphs, ~10K events).
Production: **oshoarchives.com** (Next.js on Vercel) → **EC2 13.206.34.214:8000**
(FastAPI + SQLite + FTS5).

Two user audiences:
- **Sannyasins worldwide** — search/read Osho's words verbatim, English + Hindi
- **Archivists (Antar, Rudra, et al.)** — ingest new talks, fix metadata, cross-check
  against ElasticSearch / OCTP / FileMaker Pro

---

## Architecture at a glance

```
oshoarchives.com (Vercel)
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

13.206.34.214:8000 (EC2, /home/ubuntu/osho-speaks)
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

### Frontend (auto)
Push to `main` → Vercel builds and deploys within ~2-3 min. **Caveat:** Vercel
sometimes silently skips builds — if production behaviour doesn't update 5 min after
merge, manually click "Redeploy" in the Vercel dashboard.

### Backend (auto via GitHub Actions — verify secrets exist)
PR #34 (2026-05-11) rewrote the workflow. `deploy-backend.yml` SSHes into
EC2 and runs `scripts/deploy.sh`, which does: git pull → `pip install`
(only when `requirements.txt` changed) → FTS rebuild (only when
`build_fts.py` or `data/**` changed) → uvicorn restart → `/health` probe
(fails CI loudly if not 200). Trigger paths in the workflow's `on.push.paths`
gate which commits actually fire it.

The only remaining failure mode is missing/stale repo secrets:
`BACKEND_HOST`, `BACKEND_USER`, `BACKEND_SSH_KEY`, and the optional
`BACKEND_PORT` (defaults to 22). If a merge to main touches a backend
path but no run appears in the Actions tab, the secrets need attention.

### Manual backend redeploy (fallback when the auto-deploy hasn't run)
```bash
ssh -i ~/.ssh/jsl-wealth-key.pem ubuntu@13.206.34.214
cd /home/ubuntu/osho-speaks
git pull origin main
# only when scripts/build_fts.py or data/** changed:
.venv/bin/python3 scripts/build_fts.py
# restart uvicorn:
pkill -f 'uvicorn scripts.cloud_api' || sudo fuser -k 8000/tcp
sleep 2
nohup /home/ubuntu/osho-speaks/.venv/bin/python3 -m uvicorn scripts.cloud_api:app \
  --host 0.0.0.0 --port 8000 > uvicorn.log 2>&1 &
sleep 3
curl -s http://localhost:8000/health
```

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
