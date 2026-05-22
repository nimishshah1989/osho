# Osho Archive

A full-text search engine and browsable library over the complete discourses of
Osho (~10,000 talks, ~75,000 paragraphs, English and Hindi). Every word on
screen is Osho's own — no AI paraphrasing or generated summaries.

**Live:** <https://oshoarchives.com>

For deep architectural context — FTS tokenizer rationale, Devanagari pipeline,
recurring bugs, deployment runbook — read [`CLAUDE.md`](./CLAUDE.md).

---

## What's here

- **Search** (`/`) — three modes: exact phrase, all words, within N words; with
  Hindi transliteration input (type Roman, get Devanagari suggestions); language
  + date-range filters; BM25 ranking with a per-discourse hit-count boost.
- **Archive** (`/archive`) — drill down by theme, year, or place.
- **Constellation** (`/constellation`) — clustered visualization of the library.
- **Reader** (`/read`) — full discourse, paragraph-numbered.
- **Help** (`/help`) — search syntax guide.
- **Admin** (`/admin`) — `ADMIN_KEY`-protected ingest / edit / tag / delete.

---

## Architecture

```
Browser
  │
Cloudflare (DNS, edge TLS, proxy — only allowed ingress)
  │
E2E VPS 164.52.223.241  (single box, Ubuntu 24.04)
  │
  ├── oshoarchives.com  →  Next.js 14 app router  (PM2, :3000)
  │     ├── Pages:    /, /archive, /constellation, /read, /help, /admin
  │     └── /api/*    server-side proxies → FastAPI over loopback
  │
  └── 127.0.0.1:8000   →  FastAPI + SQLite FTS5  (systemd, uvicorn)
        ├── /api/search, /api/discourse, /api/catalog, /api/tags, …
        └── /admin/*  (gated by x-admin-key header)

      Data: /home/osho/osho/data/osho.db  (~1.6 GB)
        ├── events            (id, title, date, location, language, translated_from)
        ├── paragraphs        (id, event_id, sequence_number, content)
        ├── paragraphs_fts    (FTS5 virtual table — see tokenizer below)
        └── event_tags        (event_id, tag) — auto-classified topics
```

---

## Quick reference

### Search DSL

| Form | Meaning |
|---|---|
| `silence awareness` (mode = All words) | both terms anywhere, BM25-ranked |
| `"silence is golden"` (mode = Exact phrase) | exact phrase, in order |
| `silence awareness` (mode = Within N words, N=30) | within 30 tokens of each other |
| `silenc*` | prefix wildcard |
| `zen OR tantra` | boolean OR |
| `title:vigyan` | match the discourse title only |

Hindi works natively. Hindi queries are also expanded into vowel-length and
anusvara variants (`a/ā, i/ī, u/ū`, `ं ↔ नन्/न्/म्…`) in **All words** mode so
common spelling variations all match.

### FTS5 tokenizer (the foundation)

```sql
tokenize = "porter unicode61 remove_diacritics 1 categories 'L* N* Co Mn Mc'"
```

The `categories 'L* N* Co Mn Mc'` part is critical for Hindi. Without `Mn` and
`Mc` (Unicode combining-mark categories), SQLite's default tokenizer splits
every Hindi word at every vowel matra and virama:

| Word | Default tokens | With Mn+Mc |
|---|---|---|
| `धर्म` | `धर` + `म` | `धर्म` |
| `विश्वास` | `व` + `श` + `व` + `स` | `विश्वास` |
| `धन्य` | `धन` + `य` | `धन्य` |

This is the difference between matching `धन` everywhere it appears as a
substring vs. matching it as a whole word. See `CLAUDE.md` for full history.

---

## Environment variables

| Variable | Where | Required | Description |
|---|---|---|---|
| `API_URL` | frontend | optional | Backend base for the `/api/*` proxy. Defaults to `http://127.0.0.1:8000` (FastAPI on the same VPS). |
| `NEXT_PUBLIC_CORPUS_URL` | frontend | optional | GitHub Release asset the offline PWA downloads. Unset → online-only. |
| `ADMIN_KEY` | backend | yes in prod | Password for `/admin/*` endpoints. Backend hard-fails on startup if `OSHO_ENV=production` and this is unset or equals the default `osho-admin`. |
| `OSHO_ENV` | backend | yes in prod | Set to `production` to enable the ADMIN_KEY hard-fail. |
| `ALLOWED_ORIGINS` | backend | optional | Comma-separated CORS origins (default `https://oshoarchives.com`). |

---

## Local development

### Backend

```bash
pip install -r requirements.txt

# place data/osho.db in the repo root (copy from the VPS or rebuild)
python3 scripts/build_fts.py        # one-time index build (~5–10 min)

ADMIN_KEY=dev-secret python3 -m uvicorn scripts.cloud_api:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
echo "API_URL=http://localhost:8000" > .env.local
npm run dev   # http://localhost:3000
```

---

## Adding new content

### Recommended — bulk `.docx` ingestion

Each `.docx` carries metadata as `@field=value` header lines, then `@eventText=`
followed by the paragraphs. Filename convention:
`Talk_Title_~_01_LHI.docx` (Hindi), `Talk_Title_~_01_LEN.docx` (English).

```
@title=The Book of Secrets ~ Chapter 1
@language=EN
@time=1972-01-15
@place=Bombay
@theme=tantra
@translatedFrom=none
@eventText=
Full paragraph 1 ...

Full paragraph 2 ...
```

Run:
```bash
python3 scripts/ingest_docx.py /path/to/docs/        # walks recursively
python3 scripts/ingest_docx.py one_file.docx         # single file
python3 scripts/ingest_docx.py /path --dry-run       # parse-only, no DB writes
```

The script **upserts by `(title, language)`** — re-running the same `.docx`
updates the existing event in place. Devanagari is normalised to canonical
form on insert so search results are consistent.

### Quick fixes — admin web UI

`/admin` → "Upload New Talk" form. Paste text, fill metadata, submit. Useful
for one-off corrections; not designed for bulk import.

---

## Deployment

Frontend and backend share one E2E VPS (`164.52.223.241`) behind
Cloudflare. See `CLAUDE.md` → **Deployment** for the full layout.

### Frontend (manual)

```bash
ssh osho@164.52.223.241
cd /home/osho/osho && git pull origin main
cd frontend && npm install && npm run build
pm2 restart osho-frontend
```

### Backend (GitHub Actions — fully automated)

Any push to `main` touching `scripts/cloud_api.py`, `scripts/build_fts.py`,
`scripts/ingest_docx.py`, `scripts/deploy.sh`, `requirements.txt`, or `data/**`
runs the `Deploy Backend` workflow, which SSHes into the VPS and runs
`scripts/deploy.sh`. The script:

1. `git pull` (fast-forward only)
2. `pip install -r requirements.txt` if requirements changed
3. Rebuilds the FTS index if `build_fts.py` or `data/**` changed
4. Restarts `osho-backend.service` (systemd)
5. Curls `/health` and exits non-zero if it doesn't come back 200

### Manual backend deploy (one-time setup / debugging)

```bash
ssh osho@164.52.223.241
cd /home/osho/osho
bash scripts/deploy.sh
```

---

## API reference

All endpoints return JSON. Auth endpoints require `X-Admin-Key`.

### Public

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | DB + FTS readiness |
| `GET` | `/api/search` | Full-text search |
| `GET` | `/api/discourse` | Full paragraphs for one talk (with optional `q` for FTS highlights) |
| `GET` | `/api/catalog` | All events with tags + language |
| `GET` | `/api/tags` | Topic tags with event counts |
| `GET` | `/api/languages` | Distinct languages |
| `GET` | `/api/date-range` | Min/max date in archive |
| `GET` | `/api/clusters?lens=timeline|geography|themes` | Cluster groups |

`/api/search` params: `q` (required), `sort` (`rank`/`title`), `limit`,
`language`, `date_from`, `date_to`.

`/api/discourse` params: `event_id` **or** `title`, plus optional `q` —
when present the backend returns `hl` markers (FTS5 highlight `«…»`) on
matching paragraphs so the frontend can highlight proximity-aware matches.

### Admin (require `X-Admin-Key`)

| Method | Path | Description |
|---|---|---|
| `GET` | `/admin/events` | Paginated event list |
| `PATCH` | `/admin/events/{id}` | Update title/date/location/language |
| `PUT` | `/admin/events/{id}/tags` | Replace tag list |
| `DELETE` | `/admin/events/{id}` | Delete event + paragraphs + FTS rows + tags |
| `POST` | `/admin/ingest` | Single-talk ingest (web form path) |
| `GET` | `/admin/all-tags` | All tags with counts |

---

## Repository layout

```
osho/
├── CLAUDE.md                project memory — read first
├── README.md                this file
├── data/                    SQLite database (gitignored — lives on the VPS)
│   └── osho.db
├── db/
│   └── schema.sql           base table definitions
├── scripts/
│   ├── cloud_api.py         FastAPI backend
│   ├── build_fts.py         (re)build FTS5 index
│   ├── build_tags.py        location/date inference + topic tagging
│   ├── ingest_docx.py       bulk-ingest .docx with @-field headers
│   └── deploy.sh            server-side deploy script (run by GH Actions)
├── frontend/                Next.js 14 app router
│   ├── app/                 pages + /api/* proxy routes
│   ├── components/          Nav, HindiInput, Archive, Constellation, …
│   ├── lib/                 i18n, theme, analytics, transliterate
│   └── styles/globals.css
├── .github/workflows/
│   └── deploy-backend.yml   triggers deploy.sh over SSH
├── requirements.txt
└── .env.example
```

---

## Hindi specifics

- **Tokenizer** keeps Devanagari words whole (Mn+Mc included). See the
  table above for what breaks without this.
- **Anusvara/nasal-virama normalisation** runs at both index time
  (`build_fts.normalize_devanagari`) and query time
  (`cloud_api._normalize_devanagari`) so `अनन्त` and `अनंत` match each other.
- **Query expansion** in the frontend (`lib/transliterate.ts`
  `buildHindiFtsQuery`) generates OR variants for vowel length (a/ā, i/ī,
  u/ū) and anusvara forms — only in "All words" mode, since you can't OR
  inside `NEAR(…)` or `"…"`.
- **Font**: Inter has no Devanagari glyphs, so the layout loads Noto Sans
  Devanagari alongside Inter and stacks them in CSS — guarantees the same
  shaping for every reader regardless of OS.
- **Devanagari input**: in Hindi mode (`हिं` toggle in the nav), the search
  input is powered by the Google Input Tools API — type Roman, get
  Devanagari suggestions, accept with `Space` / number keys / `Enter`.

---

## Security

- `ADMIN_KEY` is a shared secret passed via the `X-Admin-Key` header. The
  backend refuses to start in production if it's unset or equals the default.
- The admin key is held in `sessionStorage` on the frontend — adequate for a
  trusted-device admin workflow.
- All admin traffic goes through the Next.js proxy so the backend IP is
  never exposed to browsers.

---

## License

Discourse content © Osho International Foundation. Indexing / search
infrastructure is open for educational / research use; commercial use
requires permission from the foundation.
