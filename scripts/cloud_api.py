from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import os
import re
import sqlite3
from collections import Counter
from contextlib import asynccontextmanager

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(BASE_DIR, 'data/osho.db')

ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv("ALLOWED_ORIGINS", "https://osho-zeta.vercel.app").split(",")
    if o.strip()
]

LENS_PALETTE = {
    "Meditation":    "#f59e0b",
    "Zen":           "#10b981",
    "Tantra":        "#ef4444",
    "Sufism":        "#8b5cf6",
    "Love":          "#ec4899",
    "Love & Freedom":"#ec4899",
    "Philosophy":    "#3b82f6",
    "Misc":          "#94a3b8",
    "Bombay":        "#60a5fa",
    "Poona I":       "#d4af37",
    "Rajneeshpuram": "#ef4444",
    "Poona II":      "#10b981",
    "Pune":          "#d4af37",
    "Kathmandu":     "#8b5cf6",
    "Oregon":        "#ef4444",
    "Unknown":       "#94a3b8",
}


def _palette(name: str) -> str:
    return LENS_PALETTE.get(name, "#94a3b8")


def _era_from_date(raw: str) -> str:
    year = (raw or "")[:4]
    if not year.isdigit():
        return "Unknown"
    y = int(year)
    if y < 1970:
        return "Bombay"
    if y < 1981:
        return "Poona I"
    if y < 1986:
        return "Rajneeshpuram"
    return "Poona II"


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not os.path.exists(DB_PATH):
        print(f"WARNING: DB not found at {DB_PATH}", flush=True)
    else:
        conn = sqlite3.connect(DB_PATH)
        cur = conn.cursor()
        has_fts = cur.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='paragraphs_fts'"
        ).fetchone()
        conn.close()
        if has_fts:
            print("Ask Engine: FTS5 index present, keyword search ready.", flush=True)
        else:
            print(
                "Ask Engine: paragraphs_fts missing — run scripts/build_fts.py.",
                flush=True,
            )
    yield


app = FastAPI(title="Osho Archive API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    ok = os.path.exists(DB_PATH)
    fts_ready = False
    if ok:
        conn = sqlite3.connect(DB_PATH)
        fts_ready = bool(
            conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='paragraphs_fts'"
            ).fetchone()
        )
        conn.close()
    return {"status": "present", "db": ok, "fts": fts_ready}


def _series_from_title(title: str) -> str:
    if not title:
        return "Uncategorised"
    if " ~ " in title:
        return title.split(" ~ ", 1)[0].strip()
    return title.strip()


@app.get("/api/catalog")
def catalog():
    if not os.path.exists(DB_PATH):
        return {"events": []}
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute(
        "SELECT id, title, date, location FROM events WHERE title IS NOT NULL ORDER BY COALESCE(date, ''), title"
    )
    events = [
        {"id": r["id"], "title": r["title"], "date": r["date"], "location": r["location"]}
        for r in cur.fetchall()
    ]
    conn.close()
    return {"events": events}


# ---------- Keyword search (pure Osho; no LLM) ----------

# Users type `title : vigyan` (reference app syntax). FTS5 needs `title_search:vigyan`.
_TITLE_FILTER_RE = re.compile(r'\btitle\s*:\s*', re.IGNORECASE)


def _rewrite_query(user_query: str) -> str:
    """Minimal rewrite from the reference app's DSL to FTS5 MATCH syntax.

    All supported operators (phrase "...", NEAR, OR, prefix *) are already
    valid FTS5 syntax — only `title:` needs mapping to our column name.
    """
    return _TITLE_FILTER_RE.sub('title_search:', user_query).strip()


@app.get("/api/search")
def search(
    q: str = Query(..., min_length=1),
    limit: int = Query(200, ge=1, le=500),
    sort: str = Query('rank', pattern='^(rank|title)$'),
):
    """Keyword search with BM25 ranking, phrase / NEAR / OR / prefix / title: support.

    Returns events sorted by rank (or alphabetical by title). For each event
    the top 3 matching paragraphs are included so the client can show the
    first match expanded and link to the rest.
    """
    if not os.path.exists(DB_PATH):
        raise HTTPException(status_code=503, detail="Archive unavailable.")

    fts_query = _rewrite_query(q)
    if not fts_query:
        raise HTTPException(status_code=400, detail="Empty query.")

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    try:
        # Top paragraph hit per event — grouped via a correlated subquery so
        # "rank" on the outer is the best paragraph score within each event.
        rows = conn.execute(
            """
            SELECT
                f.event_id,
                f.paragraph_id,
                f.sequence_number,
                f.content,
                f.title,
                e.date,
                e.location,
                bm25(paragraphs_fts) AS rank
            FROM paragraphs_fts f
            LEFT JOIN events e ON e.id = f.event_id
            WHERE paragraphs_fts MATCH ?
            ORDER BY rank
            LIMIT ?
            """,
            (fts_query, limit * 5),
        ).fetchall()
    except sqlite3.OperationalError as ex:
        conn.close()
        raise HTTPException(status_code=400, detail=f"Invalid query: {ex}")

    # Group by event, keep up to 3 paragraph hits per event (first is the
    # highest-ranked). Event rank = best paragraph rank.
    events: dict = {}
    for r in rows:
        ev_id = r["event_id"]
        if ev_id not in events:
            events[ev_id] = {
                "event_id": ev_id,
                "title": r["title"],
                "date": r["date"],
                "location": r["location"],
                "rank": r["rank"],
                "hits": [],
            }
        if len(events[ev_id]["hits"]) < 3:
            events[ev_id]["hits"].append({
                "paragraph_id": r["paragraph_id"],
                "sequence_number": r["sequence_number"],
                "content": r["content"],
            })

    # Count distinct events (not just returned ones)
    try:
        (total_events,) = conn.execute(
            """
            SELECT COUNT(DISTINCT event_id) FROM paragraphs_fts
            WHERE paragraphs_fts MATCH ?
            """,
            (fts_query,),
        ).fetchone()
    except sqlite3.OperationalError:
        total_events = len(events)
    conn.close()

    out = list(events.values())[:limit]
    if sort == 'title':
        out.sort(key=lambda e: (e["title"] or "").lower())
    # bm25() returns lower-is-better; already sorted that way from the query.
    return {"query": q, "total": total_events, "events": out}


@app.get("/hierarchy")
def hierarchy():
    if not os.path.exists(DB_PATH):
        return {}
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT title, date FROM events WHERE title IS NOT NULL")
    tree: dict = {}
    for r in cur.fetchall():
        raw_date = r["date"] or ""
        year = raw_date[:4]
        if not year.isdigit():
            year = "Undated"
        series = _series_from_title(r["title"])
        tree.setdefault(year, {}).setdefault(series, []).append(r["title"])
    conn.close()
    for y in tree:
        for s in tree[y]:
            tree[y][s].sort()
    return tree


@app.get("/api/clusters")
def clusters(lens: str = "themes", limit: int = 20):
    if not os.path.exists(DB_PATH):
        return {"lens": lens, "clusters": []}
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    if lens == "timeline":
        cur.execute("SELECT date FROM events WHERE date IS NOT NULL")
        buckets = Counter(_era_from_date(r["date"]) for r in cur.fetchall())
        order = ["Bombay", "Poona I", "Rajneeshpuram", "Poona II", "Unknown"]
        clusters_out = [
            {"name": name, "size": buckets[name], "color": _palette(name)}
            for name in order if buckets[name] > 0
        ]
    elif lens == "geography":
        cur.execute(
            "SELECT location, COUNT(*) c FROM events WHERE location IS NOT NULL GROUP BY location ORDER BY c DESC LIMIT ?",
            (limit,),
        )
        clusters_out = [
            {"name": r["location"] or "Unknown", "size": r["c"], "color": _palette(r["location"] or "Unknown")}
            for r in cur.fetchall()
        ]
    else:
        keywords = {
            "Meditation": ["meditation", "dhyan", "silence"],
            "Zen": ["zen", "bodhidharma", "hsin hsin ming"],
            "Tantra": ["tantra", "vigyan bhairav"],
            "Sufism": ["sufi", "rumi"],
            "Love": ["love", "intimacy"],
            "Philosophy": ["philosoph", "heraclitus", "nietzsche"],
        }
        cur.execute("SELECT title FROM events")
        counts = Counter()
        for r in cur.fetchall():
            t = (r["title"] or "").lower()
            matched = False
            for theme, keys in keywords.items():
                if any(k in t for k in keys):
                    counts[theme] += 1
                    matched = True
                    break
            if not matched:
                counts["Misc"] += 1
        clusters_out = [
            {"name": name, "size": size, "color": _palette(name)}
            for name, size in counts.most_common(limit)
        ]

    conn.close()
    return {"lens": lens, "clusters": clusters_out}


@app.get("/api/discourse")
def discourse(title: str | None = None, event_id: str | None = None):
    if not title and not event_id:
        raise HTTPException(status_code=400, detail="Provide title or event_id")
    if not os.path.exists(DB_PATH):
        raise HTTPException(status_code=404, detail="Discourse store unavailable")

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    if event_id:
        cur.execute("SELECT id, title, date, location FROM events WHERE id = ?", (event_id,))
    else:
        cur.execute(
            "SELECT id, title, date, location FROM events WHERE title = ? ORDER BY COALESCE(date, '') LIMIT 1",
            (title,),
        )
    ev = cur.fetchone()
    if not ev:
        conn.close()
        raise HTTPException(status_code=404, detail="Discourse not found")

    cur.execute(
        "SELECT id, sequence_number, content FROM paragraphs WHERE event_id = ? ORDER BY sequence_number",
        (ev["id"],),
    )
    paragraphs = [
        {"id": r["id"], "sequence_number": r["sequence_number"], "content": r["content"]}
        for r in cur.fetchall()
    ]
    conn.close()

    return {
        "event": {
            "id": ev["id"],
            "title": ev["title"],
            "date": ev["date"],
            "location": ev["location"],
        },
        "paragraphs": paragraphs,
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
