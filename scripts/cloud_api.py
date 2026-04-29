from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
import os
import re
import sqlite3
from collections import Counter
from contextlib import asynccontextmanager
from typing import Optional

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

_SHAILENDRA_RE = re.compile(
    r'\s*source\s*:\s*Shailendra.s\s+Hindi\s+collection\s*',
    re.IGNORECASE,
)


def _strip_shailendra(text: str) -> str:
    return _SHAILENDRA_RE.sub('', text).strip()


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
                "SELECT 1 FROM sqlite_master"
                " WHERE type='table' AND name='paragraphs_fts'"
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
        "SELECT id, title, date, location FROM events"
        " WHERE title IS NOT NULL ORDER BY COALESCE(date, ''), title"
    )
    events = [
        {
            "id": r["id"],
            "title": r["title"],
            "date": r["date"],
            "location": r["location"],
        }
        for r in cur.fetchall()
    ]
    conn.close()
    return {"events": events}


# ---------- Keyword search (pure Osho; no LLM) ----------

_TITLE_FILTER_RE = re.compile(r'\btitle\s*:\s*', re.IGNORECASE)
_HAS_DEVANAGARI = re.compile(r'[ऀ-ॿ]')
_NEAR_RE = re.compile(r'^NEAR\s*\((.+?),\s*(\d+)\)\s*$', re.IGNORECASE)


def _rewrite_query(user_query: str) -> str:
    return _TITLE_FILTER_RE.sub('title_search:', user_query).strip()


def _parse_near(fts_query: str):
    """Return (words, distance) if query is a bare NEAR(...) expression, else None."""
    m = _NEAR_RE.match(fts_query.strip())
    if not m:
        return None
    words = [w.strip() for w in m.group(1).split() if w.strip()]
    dist = int(m.group(2))
    return (words, dist) if len(words) >= 2 else None


def _min_para_span(seqs_per_word: list) -> int:
    """
    Minimum paragraph span (max_seq - min_seq) of any window that contains
    at least one sequence number from every word's list.
    Two-pointer sweep over the merged sorted list of (seq_num, word_index) points.
    """
    points = sorted(
        (seq, wi)
        for wi, seqs in enumerate(seqs_per_word)
        for seq in seqs
    )
    n = len(seqs_per_word)
    counts: dict = {}
    covered = 0
    lo = 0
    best = 10 ** 9
    for hi, (seq_hi, wi_hi) in enumerate(points):
        counts[wi_hi] = counts.get(wi_hi, 0) + 1
        if counts[wi_hi] == 1:
            covered += 1
        while covered == n:
            best = min(best, seq_hi - points[lo][0])
            _, wi_lo = points[lo]
            counts[wi_lo] -= 1
            if counts[wi_lo] == 0:
                covered -= 1
            lo += 1
    return best


def _augment_near_cross_paragraph(
    conn, words: list, near_dist: int,
    filter_params: list, where_extra: str,
    events: dict,
) -> None:
    """
    Extend `events` with discourses where NEAR words appear in different
    paragraphs that are still close together (within max_span paragraph
    sequence numbers). Called only for NEAR queries, after the main FTS pass.
    """
    # Token distance → paragraph boundary allowance: 30 tokens ≈ one paragraph edge
    max_span = max(1, near_dist // 30)

    # For each word, collect event_id → [sequence_numbers] from the FTS index
    word_ev_seqs: list = []
    for word in words:
        try:
            rows = conn.execute(
                f"""
                SELECT f.event_id, f.sequence_number
                FROM paragraphs_fts f
                LEFT JOIN events e ON e.id = f.event_id
                WHERE paragraphs_fts MATCH ?
                {where_extra}
                """,
                (word, *filter_params),
            ).fetchall()
        except sqlite3.OperationalError:
            return
        ev_seqs: dict = {}
        for r in rows:
            ev_seqs.setdefault(r["event_id"], []).append(r["sequence_number"])
        word_ev_seqs.append(ev_seqs)

    if not word_ev_seqs:
        return

    # Events that contain ALL words (across any paragraphs)
    common = set(word_ev_seqs[0])
    for d in word_ev_seqs[1:]:
        common &= set(d)

    # Keep only events not already found by the NEAR FTS pass, with span <= max_span
    extra_ids = [
        ev_id for ev_id in common
        if ev_id not in events
        and _min_para_span([d.get(ev_id, []) for d in word_ev_seqs]) <= max_span
    ]
    if not extra_ids:
        return

    # For each word, fetch its best paragraph per extra event so the snippet
    # always shows one paragraph per word (making both words visible in the UI).
    ph = ','.join('?' * len(extra_ids))
    seen_para_ids: set = set()

    for word in words:
        try:
            word_rows = conn.execute(
                f"""
                SELECT
                    f.event_id, f.paragraph_id, f.sequence_number, f.content,
                    f.title, e.date, e.location, e.language,
                    bm25(paragraphs_fts) AS rank
                FROM paragraphs_fts f
                LEFT JOIN events e ON e.id = f.event_id
                WHERE paragraphs_fts MATCH ?
                  AND f.event_id IN ({ph})
                ORDER BY rank
                """,
                (word, *extra_ids),
            ).fetchall()
        except sqlite3.OperationalError:
            continue

        # Keep only the best (lowest BM25) paragraph per event for this word
        best_for_event: dict = {}
        for r in word_rows:
            ev_id = r["event_id"]
            if ev_id not in best_for_event:
                best_for_event[ev_id] = r

        for ev_id, r in best_for_event.items():
            if ev_id not in events:
                events[ev_id] = {
                    "event_id": ev_id,
                    "title": r["title"],
                    "date": r["date"],
                    "location": r["location"],
                    "language": r["language"],
                    "best_rank": r["rank"],
                    "rank_sum": 0.0,
                    "hit_count": 0,
                    "hits": [],
                }
            ev = events[ev_id]
            ev["rank_sum"] += r["rank"]
            ev["hit_count"] += 1
            content = _strip_shailendra(r["content"])
            is_meta = (
                r["sequence_number"] == 0
                or content.lower().startswith("event page in sannyas")
            )
            # Add this word's best paragraph if not already shown
            if (
                not is_meta
                and r["paragraph_id"] not in seen_para_ids
                and len(ev["hits"]) < 3
            ):
                seen_para_ids.add(r["paragraph_id"])
                ev["hits"].append({
                    "paragraph_id": r["paragraph_id"],
                    "sequence_number": r["sequence_number"],
                    "content": content,
                })


def _phrase_text(fts_query: str) -> str:
    """If query is a bare phrase (starts+ends with "), return the inner text; else ''."""
    q = fts_query.strip()
    if q.startswith('"') and q.endswith('"') and len(q) > 2:
        return q[1:-1]
    return ''


@app.get("/api/search")
def search(
    q: str = Query(..., min_length=1),
    limit: int = Query(200, ge=1, le=500),
    sort: str = Query('rank', pattern='^(rank|title)$'),
    language: Optional[str] = Query(
        None, description="Filter by language: English, Hindi"
    ),
    date_from: Optional[str] = Query(None, description="Start date YYYY or YYYY-MM-DD"),
    date_to: Optional[str] = Query(None, description="End date YYYY or YYYY-MM-DD"),
):
    """Keyword search with BM25 ranking, phrase / NEAR / OR / prefix / title: support.

    Returns events sorted by rank (or alphabetical by title). For each event
    the top 3 matching paragraphs are included. Ranking uses combined BM25
    score across paragraphs so events with more hits rank higher.
    """
    if not os.path.exists(DB_PATH):
        raise HTTPException(status_code=503, detail="Archive unavailable.")

    fts_query = _rewrite_query(q)
    if not fts_query:
        raise HTTPException(status_code=400, detail="Empty query.")

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    # Build filter clauses
    filters = []
    params: list = [fts_query]

    if language:
        filters.append("LOWER(e.language) = LOWER(?)")
        params.append(language)
    if date_from:
        padded_from = date_from if len(date_from) > 4 else f"{date_from}-01-01"
        filters.append("e.date >= ?")
        params.append(padded_from)
    if date_to:
        padded_to = date_to if len(date_to) > 4 else f"{date_to}-12-31"
        filters.append("e.date <= ?")
        params.append(padded_to)

    where_extra = (" AND " + " AND ".join(filters)) if filters else ""

    try:
        rows = conn.execute(
            f"""
            SELECT
                f.event_id,
                f.paragraph_id,
                f.sequence_number,
                f.content,
                f.title,
                e.date,
                e.location,
                e.language,
                bm25(paragraphs_fts) AS rank
            FROM paragraphs_fts f
            LEFT JOIN events e ON e.id = f.event_id
            WHERE paragraphs_fts MATCH ?
            {where_extra}
            ORDER BY rank
            LIMIT ?
            """,
            (*params, limit * 10),
        ).fetchall()
    except sqlite3.OperationalError as ex:
        conn.close()
        raise HTTPException(status_code=400, detail=f"Invalid query: {ex}")

    # For Devanagari phrase queries, FTS5 tokenises away matras so "मेरा"
    # and "मेरी" collapse to the same token. Post-filter to exact string match.
    phrase = _phrase_text(fts_query)
    if phrase and _HAS_DEVANAGARI.search(phrase):
        rows = [r for r in rows if phrase in r["content"]]

    # Group by event. Track all hits for ranking, keep top 3 for display.
    events: dict = {}
    total_hits = 0
    for r in rows:
        total_hits += 1
        ev_id = r["event_id"]
        if ev_id not in events:
            events[ev_id] = {
                "event_id": ev_id,
                "title": r["title"],
                "date": r["date"],
                "location": r["location"],
                "language": r["language"],
                "best_rank": r["rank"],
                "rank_sum": 0.0,
                "hit_count": 0,
                "hits": [],
            }
        ev = events[ev_id]
        ev["rank_sum"] += r["rank"]
        ev["hit_count"] += 1
        # Skip metadata paragraphs from display hits:
        # seq 0 = title row, boilerplate like "event page in sannyas.wiki:"
        content = _strip_shailendra(r["content"])
        is_meta = (
            r["sequence_number"] == 0
            or content.lower().startswith("event page in sannyas")
        )
        if len(ev["hits"]) < 3 and not is_meta:
            ev["hits"].append({
                "paragraph_id": r["paragraph_id"],
                "sequence_number": r["sequence_number"],
                "content": content,
            })

    # Cross-paragraph NEAR: extend results with events where words span
    # adjacent paragraphs (missed by FTS5's within-paragraph NEAR operator)
    near_parsed = _parse_near(fts_query)
    if near_parsed is not None:
        _augment_near_cross_paragraph(
            conn,
            words=near_parsed[0],
            near_dist=near_parsed[1],
            filter_params=params[1:],   # language / date filters (no fts_query)
            where_extra=where_extra,
            events=events,
        )

    # Count total distinct events matching (may exceed fetched rows)
    count_params: list = [fts_query]
    if language:
        count_params.append(language)
    if date_from:
        count_params.append(padded_from)
    if date_to:
        count_params.append(padded_to)

    if phrase and _HAS_DEVANAGARI.search(phrase):
        # Counts come from the already-filtered events dict (post-filter applied above)
        total_events = len(events)
        total_hits = sum(ev["hit_count"] for ev in events.values())
    else:
        try:
            row = conn.execute(
                f"""
                SELECT COUNT(DISTINCT f.event_id) AS ev_count, COUNT(*) AS hit_count
                FROM paragraphs_fts f
                LEFT JOIN events e ON e.id = f.event_id
                WHERE paragraphs_fts MATCH ?
                {where_extra}
                """,
                count_params,
            ).fetchone()
            total_events = row["ev_count"]
            total_hits = row["hit_count"]
        except sqlite3.OperationalError:
            total_events = len(events)

    conn.close()

    # Compute combined rank: BM25 is negative (lower=better).
    # Multiply best paragraph score by a bonus that rewards more hits.
    # More hits → larger multiplier → more negative score → ranks higher.
    import math
    for ev in events.values():
        hit_bonus = math.log1p(ev["hit_count"])
        ev["rank"] = ev["best_rank"] * max(hit_bonus, 1.0)

    out = sorted(events.values(), key=lambda e: e["rank"])[:limit]
    if sort == 'title':
        out.sort(key=lambda e: (e["title"] or "").lower())

    # Clean up internal fields before response
    for ev in out:
        del ev["best_rank"]
        del ev["rank_sum"]

    return {
        "query": q,
        "total": total_events,
        "total_hits": total_hits,
        "events": out,
    }


@app.get("/api/languages")
def languages():
    """Return distinct languages in the archive for filter UI."""
    if not os.path.exists(DB_PATH):
        return {"languages": []}
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        "SELECT DISTINCT language FROM events"
        " WHERE language IS NOT NULL ORDER BY language"
    ).fetchall()
    conn.close()
    return {"languages": [r[0] for r in rows]}


@app.get("/api/date-range")
def date_range():
    """Return min/max year in the archive for date filter UI."""
    if not os.path.exists(DB_PATH):
        return {"min_year": None, "max_year": None}
    conn = sqlite3.connect(DB_PATH)
    row = conn.execute(
        "SELECT MIN(SUBSTR(date,1,4)), MAX(SUBSTR(date,1,4))"
        " FROM events WHERE date IS NOT NULL AND LENGTH(date) >= 4"
    ).fetchone()
    conn.close()
    return {"min_year": row[0], "max_year": row[1]}


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
            "SELECT location, COUNT(*) c FROM events"
            " WHERE location IS NOT NULL"
            " GROUP BY location ORDER BY c DESC LIMIT ?",
            (limit,),
        )
        clusters_out = [
            {
                "name": r["location"] or "Unknown",
                "size": r["c"],
                "color": _palette(r["location"] or "Unknown"),
            }
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
        cur.execute(
            "SELECT id, title, date, location, language FROM events WHERE id = ?",
            (event_id,),
        )
    else:
        cur.execute(
            "SELECT id, title, date, location, language FROM events"
            " WHERE title = ? ORDER BY COALESCE(date, '') LIMIT 1",
            (title,),
        )
    ev = cur.fetchone()
    if not ev:
        conn.close()
        raise HTTPException(status_code=404, detail="Discourse not found")

    cur.execute(
        "SELECT id, sequence_number, content FROM paragraphs"
        " WHERE event_id = ? ORDER BY sequence_number",
        (ev["id"],),
    )
    paragraphs = [
        {
            "id": r["id"],
            "sequence_number": r["sequence_number"],
            "content": _strip_shailendra(r["content"]),
        }
        for r in cur.fetchall()
    ]
    conn.close()

    return {
        "event": {
            "id": ev["id"],
            "title": ev["title"],
            "date": ev["date"],
            "location": ev["location"],
            "language": ev["language"],
        },
        "paragraphs": paragraphs,
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
