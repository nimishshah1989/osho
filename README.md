# Osho Archive

A full-text search engine and browsable library over the complete discourses of
Osho (~11,000 talks, ~1.3M paragraphs, English and Hindi). Every word on screen
is Osho's own — no AI paraphrasing or generated summaries.

Live: <https://osho-zeta.vercel.app>

---

## Architecture

```
Browser
  │
  ├─── Next.js (Vercel)          frontend/
  │      ├── /                   Search page
  │      ├── /archive            Tree-drill archive (by theme / year / place)
  │      ├── /constellation      Library browser (era + theme + topic filters)
  │      ├── /read               Full discourse reader
  │      ├── /admin              Content admin panel (password-protected)
  │      └── /api/*              Proxy routes → EC2 backend
  │
  └─── FastAPI (AWS EC2)         scripts/cloud_api.py
         └── SQLite              data/osho.db
               ├── events
               ├── paragraphs
               ├── paragraphs_fts  (FTS5 virtual table)
               └── event_tags      (built by build_tags.py)
```

The Next.js server routes (`/api/*`) proxy every request to the FastAPI backend,
keeping the backend IP server-side and avoiding CORS issues.

---

## Repository Structure

```
osho/
├── data/                   SQLite database (not in git — lives on EC2)
│   └── osho.db
├── db/
│   └── schema.sql          Base table definitions
├── scripts/
│   ├── cloud_api.py        FastAPI backend (search, catalog, admin endpoints)
│   ├── build_fts.py        One-time: builds paragraphs_fts FTS5 index
│   └── build_tags.py       One-time: fills missing location/date, builds event_tags
├── frontend/
│   ├── app/
│   │   ├── page.tsx                Search UI
│   │   ├── archive/page.tsx        Archive page
│   │   ├── constellation/page.tsx  Library browser page
│   │   ├── read/page.tsx           Discourse reader
│   │   ├── admin/page.tsx          Admin panel
│   │   └── api/                    Next.js proxy routes
│   │       ├── ask/route.ts        → /api/search
│   │       ├── catalog/route.ts    → /api/catalog
│   │       ├── discourse/route.ts  → /api/discourse
│   │       ├── languages/route.ts  → /api/languages
│   │       └── admin/[...path]/route.ts  → /admin/*
│   └── components/
│       ├── Nav.tsx
│       ├── HindiInput.tsx          Devanagari input (Google Input Tools)
│       ├── Archive/
│       │   └── TreeExplorer.tsx    Hierarchical archive navigation
│       └── Constellation/
│           └── Constellation.tsx   Library browser with era/theme/tag filters
├── requirements.txt
└── .env.example
```

---

## Environment Variables

Copy `.env.example` and fill in your values.

| Variable | Where | Description |
|---|---|---|
| `API_URL` | Vercel (server-side) | Backend URL e.g. `http://1.2.3.4:8000`. Prefer this over `NEXT_PUBLIC_API_URL` — keeps the IP out of the browser bundle. |
| `ADMIN_KEY` | EC2 (backend env) | Password for the `/admin` endpoints. Pass at uvicorn startup. |
| `ALLOWED_ORIGINS` | EC2 (backend env) | Comma-separated CORS origins e.g. `https://osho-zeta.vercel.app` |

---

## Local Development

### Backend

```bash
# Install dependencies
pip install -r requirements.txt

# Place the database at data/osho.db (copy from EC2 or build from source)

# Build the FTS index (first time, or after adding new content)
python3 scripts/build_fts.py

# Fill missing metadata and build topic tags (first time, or after new content)
python3 scripts/build_tags.py

# Start the API
ADMIN_KEY=dev-secret python3 -m uvicorn scripts.cloud_api:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install

# Create a local env file
echo "API_URL=http://localhost:8000" > .env.local

npm run dev   # http://localhost:3000
```

---

## Database

### Schema (`db/schema.sql`)

```sql
events (
  id TEXT PRIMARY KEY,
  title TEXT,         -- e.g. "The Book of Secrets ~ Chapter 1"
  date TEXT,          -- YYYY-MM-DD; YYYY-01-01 means only year is known
  location TEXT,      -- free-text city/country
  language TEXT       -- "English" or "Hindi"
)

paragraphs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT,
  sequence_number INTEGER,
  content TEXT,
  is_embedded BOOLEAN DEFAULT 0
)

paragraphs_fts   -- FTS5 virtual table (built by build_fts.py)
event_tags       -- (event_id, tag) built by build_tags.py
```

**Date convention**: dates inferred from series context only (no exact day known)
are stored as `YYYY-01-01`. The UI shows only the year for these.

**Title convention**: `Series Name ~ Chapter Title`. The `~` separator is used
everywhere to split series from chapter.

### FTS5 tokenizer

```
porter unicode61 remove_diacritics 1
```

`remove_diacritics 1` strips only Latin diacritics, preserving Devanagari
anusvara / virama. Devanagari nasal normalization (अनन्त ↔ अनंत) is applied at
both index time (`build_fts.py`) and query time (`cloud_api.py`) via
`_normalize_devanagari()`.

---

## Scripts

### `scripts/build_fts.py`

Drops and rebuilds `paragraphs_fts`. Run after bulk data imports or when the
tokenizer config changes. Takes ~3 minutes for 11k talks.

```bash
python3 scripts/build_fts.py
```

### `scripts/build_tags.py`

Three passes:
1. **Location inference** — fills `NULL` location using series-majority-vote →
   hard-coded series→city map → era-based fallback.
2. **Date inference** — fills `NULL` date with series first-year approximation.
3. **Topic tagging** — builds `event_tags` by running 40 FTS5 keyword queries
   (bilingual English + Hindi) over `paragraphs_fts`.

Safe to re-run. Takes ~2 minutes.

```bash
python3 scripts/build_tags.py
```

---

## API Reference

All endpoints return JSON. Auth-required endpoints need `X-Admin-Key` header.

### Public

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Server status, FTS readiness |
| `GET` | `/api/search` | Full-text search (see below) |
| `GET` | `/api/discourse` | Full paragraphs for one talk |
| `GET` | `/api/catalog` | All events with tags and language |
| `GET` | `/api/tags` | All topic tags with event counts |
| `GET` | `/api/languages` | Distinct language values |
| `GET` | `/api/date-range` | Min/max date in archive |
| `GET` | `/api/clusters` | Cluster groups for constellation view |
| `GET` | `/api/hierarchy` | Year → series tree |

#### `/api/search` parameters

| Param | Default | Description |
|---|---|---|
| `q` | required | FTS5 query (see Search DSL below) |
| `sort` | `rank` | `rank` or `title` |
| `limit` | `200` | Max results (1–500) |
| `language` | — | Filter by language (case-insensitive) |
| `date_from` | — | `YYYY` or `YYYY-MM-DD` |
| `date_to` | — | `YYYY` or `YYYY-MM-DD` |

### Admin (require `X-Admin-Key` header)

| Method | Path | Description |
|---|---|---|
| `GET` | `/admin/events` | Paginated list with tags. Params: `page`, `per_page`, `q`, `language`, `tag` |
| `PATCH` | `/admin/events/{id}` | Update `title`, `date`, `location`, `language` |
| `PUT` | `/admin/events/{id}/tags` | Replace tags: `{"tags": ["love", "death"]}` |
| `DELETE` | `/admin/events/{id}` | Delete event, paragraphs, FTS entries, tags |
| `POST` | `/admin/ingest` | Ingest new talk (see below) |
| `GET` | `/admin/all-tags` | All tags with counts |

#### `POST /admin/ingest` body

```json
{
  "title": "The Book of Secrets ~ Chapter 1",
  "date": "1972-01-15",
  "location": "Bombay, Maharashtra, India",
  "language": "English",
  "content": "Full text of the talk...\n\nParagraphs split by blank lines.",
  "tags": ["meditation", "tantra"]
}
```

Returns `{"ok": true, "event_id": "...", "paragraphs": 42, "tags": [...]}`.
Auto-classifies additional tags from content using bilingual keyword matching.

---

## Search DSL

| Form | Meaning |
|---|---|
| `become silent` | both words in any order (BM25-ranked) |
| `"become silent"` | exact phrase |
| `NEAR(silence awareness)` | within 10 words |
| `NEAR(silence awareness, 30)` | within 30 words (cross-paragraph if N≥30) |
| `zen OR tantra` | boolean OR |
| `silenc*` | prefix wildcard |
| `title:vigyan` | search by discourse title only |

Hindi queries work natively — the FTS index contains Devanagari text with
nasal normalization so अनन्त and अनंत match each other.

---

## Deployment

### Backend (EC2 / Ubuntu)

```bash
git clone <repo> && cd osho
pip install -r requirements.txt
# Place data/osho.db on the server
python3 scripts/build_fts.py       # ~3 min
python3 scripts/build_tags.py      # ~2 min

ADMIN_KEY=your-secret \
ALLOWED_ORIGINS=https://your-domain.com \
python3 -m uvicorn scripts.cloud_api:app --host 0.0.0.0 --port 8000 &
```

### After pulling new code

```bash
cd ~/osho-speaks && git pull
sudo pkill -f uvicorn
ADMIN_KEY=your-secret python3 -m uvicorn scripts.cloud_api:app --host 0.0.0.0 --port 8000 &
```

### After adding new content

```bash
python3 scripts/build_fts.py    # rebuild FTS index
python3 scripts/build_tags.py   # rebuild tags + fill metadata
# then restart uvicorn (above)
```

### Frontend (Vercel)

Vercel auto-deploys on every push to `main`. Set `API_URL` in the Vercel
project environment variables (Settings → Environment Variables).

---

## Admin Panel

Available at `/admin`. Password is the `ADMIN_KEY` value set on the backend.

- **Upload New Talk** — paste text, fill metadata, submit. Content is chunked,
  FTS-indexed, and auto-tagged immediately.
- **Browse & Edit** — search/filter all talks. Click any row to edit its
  metadata or tags inline, or delete it.

---

## Adding New Hindi Translations

1. Open `/admin` → Upload New Talk.
2. Paste the Hindi text, set Language to `Hindi`.
3. Submit — it will be searchable and tagged immediately.

Or use the ingest API directly for bulk imports. Tags are matched bilingually
(English keywords + Hindi equivalents) so Hindi talks get topic tags
automatically.

---

## Security Notes

- The `ADMIN_KEY` is a simple shared secret. For a production hardening pass,
  replace it with bcrypt-hashed password verification and HTTP-only session
  cookies.
- The admin key is stored in `sessionStorage` on the frontend — adequate for a
  trusted-device admin workflow, but vulnerable to XSS if third-party scripts
  are ever added.
- All admin traffic goes through the Next.js proxy — the backend IP is never
  exposed to the browser.
