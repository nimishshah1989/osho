from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
import contextlib
import heapq
import math
import os
import re
import sqlite3
import sys
import unicodedata
import uuid
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

ADMIN_KEY = os.getenv("ADMIN_KEY", "osho-admin")

# Tags used for auto-classification on ingest
_ADMIN_TOPIC_TAGS: dict[str, str] = {
    'meditation':     'meditation ध्यान',
    'love':           'love प्रेम',
    'death':          'death मृत्यु',
    'god':            'god ईश्वर परमात्मा भगवान',
    'freedom':        'freedom स्वतंत्रता मुक्ति',
    'awareness':      'awareness witnessing साक्षी जागरूकता होश',
    'silence':        'silence मौन',
    'truth':          'truth सत्य',
    'bliss':          'bliss ecstasy आनंद परमानंद',
    'ego':            'ego अहंकार',
    'mind':           'mind मन चित्त',
    'surrender':      'surrender समर्पण',
    'devotion':       'devotion bhakti भक्ति श्रद्धा',
    'creativity':     'creativity सृजन',
    'prayer':         'prayer प्रार्थना',
    'disciple':       'disciple seeker शिष्य साधक',
    'courage':        'courage साहस हिम्मत',
    'laughter':       'laughter humor हास्य हंसी',
    'anger':          'anger क्रोध गुस्सा',
    'fear':           'fear भय डर',
    'loneliness':     'loneliness aloneness एकाकीपन अकेलापन',
    'dreams':         'dream सपना स्वप्न',
    'energy':         'energy ऊर्जा शक्ति',
    'breath':         'breath breathing श्वास प्राण',
    'body':           'body शरीर देह',
    'nature':         'nature प्रकृति',
    'beauty':         'beauty सुंदर सौंदर्य',
    'transformation': 'transformation रूपांतरण परिवर्तन',
    'enlightenment':  'enlightenment awakening बोध समाधि ज्ञान',
    'compassion':     'compassion करुणा',
    'trust':          'trust विश्वास श्रद्धा',
    'society':        'society समाज',
    'religion':       'religion religious धर्म',
    'education':      'education शिक्षा',
    'politics':       'politics political राजनीति',
    'women':          'women woman स्त्री नारी महिला',
    'children':       'children child बच्चा बच्चे',
    'science':        'science scientific विज्ञान',
    'art':            'art कला',
    'relationship':   'relationship intimacy संबंध रिश्ता',
}


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    return bool(conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone())


def _check_admin(request: Request) -> None:
    key = request.headers.get("x-admin-key", "")
    if not key or key != ADMIN_KEY:
        raise HTTPException(status_code=401, detail="Unauthorized")


def _ensure_event_tags(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS event_tags (
            event_id TEXT, tag TEXT, PRIMARY KEY (event_id, tag)
        )
    """)


def _auto_classify(title: str, content: str) -> list[str]:
    text = (title + " " + content).lower()
    matched = []
    for tag, keywords_str in _ADMIN_TOPIC_TAGS.items():
        if any(kw in text for kw in keywords_str.split()):
            matched.append(tag)
    return sorted(matched)


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


# ─── Devanagari normalisation ────────────────────────────────────────────────
# Mirrors the same logic in build_fts.py — must stay in sync.
# Converts nasal-consonant+virama → anusvara (ं) when the nasal belongs to
# the same phonological class as the following consonant.
# This collapses अनन्त ↔ अनंत, मन्त्र ↔ मंत्र, etc. at query time,
# matching the canonical form stored in the FTS index.

_NASAL_RULES = [
    ('ङ', 'क', 'ङ'),  # velar
    ('ञ', 'च', 'ञ'),  # palatal
    ('ण', 'ट', 'ण'),  # retroflex
    ('न', 'त', 'न'),  # dental
    ('म', 'प', 'म'),  # labial
]
_VIRAMA   = '्'
_ANUSVARA = 'ं'

_NASAL_PATTERNS = [
    re.compile(
        re.escape(nasal + _VIRAMA) + r'(?=[' + re.escape(lo) + '-' + re.escape(hi) + '])'
    )
    for nasal, lo, hi in _NASAL_RULES
]


def _normalize_devanagari(text: str) -> str:
    if not text:
        return text
    text = unicodedata.normalize('NFC', text)
    for pat in _NASAL_PATTERNS:
        text = pat.sub(_ANUSVARA, text)
    return text


# ─── Query rewriting ─────────────────────────────────────────────────────────

_TITLE_FILTER_RE = re.compile(r'\btitle\s*:\s*', re.IGNORECASE)


def _rewrite_query(user_query: str) -> str:
    q = _TITLE_FILTER_RE.sub('title_search:', user_query).strip()
    return _normalize_devanagari(q)


# ─── Cross-paragraph NEAR support ────────────────────────────────────────────
# FTS5 NEAR() only matches within a single row (paragraph). For large distances
# (N ≥ 30) we also look for events where each query word appears in paragraphs
# whose sequence_numbers are within N // 30 steps of each other.

_NEAR_RE = re.compile(
    r'^NEAR\s*\(\s*(.+?)\s*,\s*(\d+)\s*\)\s*$',
    re.IGNORECASE,
)


def _parse_near(fts_query: str):
    """Return (words, distance) if query is a bare NEAR(...) expression, else None."""
    m = _NEAR_RE.match(fts_query.strip())
    if not m:
        return None
    words_raw, dist_str = m.group(1), m.group(2)
    words = [w.strip().strip('"') for w in words_raw.split() if w.strip().strip('"')]
    if len(words) < 2:
        return None
    return words, int(dist_str)


def _min_para_span(seqs_per_word: list[list[int]]) -> int:
    """Given sorted sequence-number lists per word, return the minimum
    window width that contains at least one paragraph per word.

    Uses a sliding-window / merge-pointer approach over sorted lists.
    Returns sys.maxsize if any word list is empty.
    """
    if any(not lst for lst in seqs_per_word):
        return sys.maxsize
    # Heap entries: (seq_number, word_index, position_in_that_list)
    heap = [(seqs[0], i, 0) for i, seqs in enumerate(seqs_per_word)]
    heapq.heapify(heap)
    max_val = max(seqs[0] for seqs in seqs_per_word)
    best = sys.maxsize
    while True:
        min_val, wi, pos = heapq.heappop(heap)
        best = min(best, max_val - min_val)
        if best == 0:
            break
        npos = pos + 1
        if npos >= len(seqs_per_word[wi]):
            break
        nval = seqs_per_word[wi][npos]
        max_val = max(max_val, nval)
        heapq.heappush(heap, (nval, wi, npos))
    return best


def _augment_near_cross_paragraph(
    conn: sqlite3.Connection,
    words: list[str],
    para_span: int,
    where_extra: str,
    filter_params: list,
) -> dict:
    """Return event dicts for cross-paragraph matches of all words in `words`.

    For each word we query FTS independently. Then for each event that appears
    in ALL per-word result sets, we compute the minimum paragraph window that
    covers one occurrence of each word. Events whose window ≤ para_span are
    returned with up to 3 sample hit paragraphs.
    """
    # Per-word: {event_id → sorted list of sequence_numbers}
    per_word: list[dict[int, list[int]]] = []
    for word in words:
        word_fts = _normalize_devanagari(word)
        try:
            wrows = conn.execute(
                f"""
                SELECT f.event_id, f.sequence_number
                FROM paragraphs_fts f
                LEFT JOIN events e ON e.id = f.event_id
                WHERE paragraphs_fts MATCH ?
                {where_extra}
                """,
                ([word_fts] + filter_params),
            ).fetchall()
        except sqlite3.OperationalError:
            return {}
        d: dict[int, list[int]] = {}
        for r in wrows:
            d.setdefault(r[0], []).append(r[1])
        per_word.append(d)

    # Intersect: events present in every word's result
    if not per_word:
        return {}
    common_ids = set(per_word[0].keys())
    for d in per_word[1:]:
        common_ids &= d.keys()

    events: dict = {}
    for ev_id in common_ids:
        seqs_per_word = [sorted(d[ev_id]) for d in per_word]
        span = _min_para_span(seqs_per_word)
        if span > para_span:
            continue

        # Fetch event metadata and a few sample paragraphs
        ev_row = conn.execute(
            "SELECT title, date, location, language FROM events WHERE id = ?",
            (ev_id,),
        ).fetchone()
        if not ev_row:
            continue

        # Collect the closest paragraphs (union of matching seqs, keep first 5)
        all_seqs: list[int] = []
        for seqs in seqs_per_word:
            all_seqs.extend(seqs)
        all_seqs = sorted(set(all_seqs))[:5]

        hits = []
        for seq in all_seqs:
            para = conn.execute(
                "SELECT id, content FROM paragraphs WHERE event_id = ? AND sequence_number = ?",
                (ev_id, seq),
            ).fetchone()
            if para and len(hits) < 3:
                content = _strip_shailendra(para[1] or '')
                is_meta = (
                    seq == 0
                    or content.lower().startswith("event page in sannyas")
                )
                if not is_meta:
                    hits.append({
                        "paragraph_id": para[0],
                        "sequence_number": seq,
                        "content": content,
                        "hl": None,
                    })

        events[ev_id] = {
            "event_id": ev_id,
            "title": ev_row[0],
            "date": ev_row[1],
            "location": ev_row[2],
            "language": ev_row[3],
            "rank": 0.0,
            "hit_count": len(all_seqs),
            "hits": hits,
            "_cross_para": True,
        }

    return events


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not os.path.exists(DB_PATH):
        print(f"WARNING: DB not found at {DB_PATH}", flush=True)
    else:
        with contextlib.closing(sqlite3.connect(DB_PATH)) as conn:
            has_fts = _table_exists(conn, 'paragraphs_fts')
        if has_fts:
            print("Ask Engine: FTS5 index present, keyword search ready.", flush=True)
        else:
            print("Ask Engine: paragraphs_fts missing — run scripts/build_fts.py.", flush=True)
    if ADMIN_KEY == "osho-admin":
        print("WARNING: ADMIN_KEY is using the default value. Set ADMIN_KEY env var.", flush=True)
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
        with contextlib.closing(sqlite3.connect(DB_PATH)) as conn:
            fts_ready = bool(
                conn.execute(
                    "SELECT 1 FROM sqlite_master"
                    " WHERE type='table' AND name='paragraphs_fts'"
                ).fetchone()
            )
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
    with contextlib.closing(sqlite3.connect(DB_PATH)) as conn:
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute(
            "SELECT id, title, date, location, language FROM events"
            " WHERE title IS NOT NULL ORDER BY COALESCE(date, ''), title"
        )
        rows = cur.fetchall()

        has_tags = _table_exists(conn, 'event_tags')

        # Build tags map: event_id → sorted list of tags
        tags_map: dict = {}
        if has_tags:
            for r in cur.execute("SELECT event_id, tag FROM event_tags").fetchall():
                tags_map.setdefault(r[0], []).append(r[1])

        events = [
            {
                "id":       r["id"],
                "title":    r["title"],
                "date":     r["date"],
                "location": r["location"],
                "language": r["language"],
                "tags":     sorted(tags_map.get(r["id"], [])),
            }
            for r in rows
        ]
    return {"events": events}


@app.get("/api/tags")
def tags():
    """Return all topic tags with event counts, sorted by frequency."""
    if not os.path.exists(DB_PATH):
        return {"tags": []}
    with contextlib.closing(sqlite3.connect(DB_PATH)) as conn:
        if not _table_exists(conn, 'event_tags'):
            return {"tags": []}
        rows = conn.execute(
            "SELECT tag, COUNT(*) as cnt FROM event_tags GROUP BY tag ORDER BY cnt DESC"
        ).fetchall()
    return {"tags": [{"tag": r[0], "count": r[1]} for r in rows]}


@app.get("/api/search")
def search(
    q: str = Query(..., min_length=1, max_length=500),
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

    # Validate date range
    if date_from and date_to and date_from > date_to:
        raise HTTPException(status_code=400, detail="date_from must be ≤ date_to")

    # Build filter clauses
    filters = []
    filter_params: list = []
    padded_from = ''
    padded_to = ''

    if language:
        filters.append("LOWER(e.language) = LOWER(?)")
        filter_params.append(language)
    if date_from:
        padded_from = date_from if len(date_from) > 4 else f"{date_from}-01-01"
        filters.append("e.date >= ?")
        filter_params.append(padded_from)
    if date_to:
        padded_to = date_to if len(date_to) > 4 else f"{date_to}-12-31"
        filters.append("e.date <= ?")
        filter_params.append(padded_to)

    where_extra = (" AND " + " AND ".join(filters)) if filters else ""

    near_parsed = _parse_near(fts_query)

    with contextlib.closing(sqlite3.connect(DB_PATH)) as conn:
        conn.row_factory = sqlite3.Row

        try:
            rows = conn.execute(
                f"""
                SELECT
                    f.event_id,
                    f.paragraph_id,
                    f.sequence_number,
                    f.content,
                    highlight(paragraphs_fts, 0, '\x02', '\x03') AS hl,
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
                ([fts_query] + filter_params + [limit * 10]),
            ).fetchall()
        except sqlite3.OperationalError as ex:
            raise HTTPException(status_code=400, detail="Invalid search syntax.")

        # Group by event. Track all hits for ranking, keep top 3 for display.
        events: dict = {}
        for r in rows:
            ev_id = r["event_id"]
            if ev_id not in events:
                events[ev_id] = {
                    "event_id": ev_id,
                    "title": r["title"],
                    "date": r["date"],
                    "location": r["location"],
                    "language": r["language"],
                    "best_rank": r["rank"],
                    "hit_count": 0,
                    "hits": [],
                }
            ev = events[ev_id]
            ev["hit_count"] += 1
            content = _strip_shailendra(r["content"])
            is_meta = (
                r["sequence_number"] == 0
                or content.lower().startswith("event page in sannyas")
            )
            if len(ev["hits"]) < 3 and not is_meta:
                raw_hl = r["hl"] or r["content"]
                hl = _strip_shailendra(raw_hl).replace('\x02', '«').replace('\x03', '»')
                ev["hits"].append({
                    "paragraph_id": r["paragraph_id"],
                    "sequence_number": r["sequence_number"],
                    "content": content,
                    "hl": hl,
                })

        # Augment with cross-paragraph NEAR matches only for large distances.
        # FTS5 NEAR is exact within a single paragraph row, so for distance < 100
        # same-paragraph matching is sufficient and correct.
        # For distance ≥ 100, words may genuinely span paragraphs, so we also
        # search across adjacent paragraphs (para_span = distance // 30).
        if near_parsed:
            near_words, near_dist = near_parsed
            if near_dist >= 100:
                para_span = max(1, near_dist // 30)
                cross = _augment_near_cross_paragraph(
                    conn, near_words, para_span, where_extra, filter_params
                )
                for ev_id, cev in cross.items():
                    if ev_id not in events:
                        events[ev_id] = cev

        # Count distinct events and hits.
        # For NEAR queries with cross-paragraph augmentation the SQL MATCH count
        # only reflects same-paragraph FTS5 hits, not the augmented results, so
        # the two numbers would disagree. Always derive counts from the events
        # dict after augmentation so that "N discourses · M hits" matches the list.
        near_words, near_dist = near_parsed if near_parsed else (None, 0)
        if near_parsed and near_dist >= 30:
            total_events = len(events)
            total_hits = sum(e["hit_count"] for e in events.values())
        else:
            try:
                count_row = conn.execute(
                    f"""
                    SELECT COUNT(DISTINCT f.event_id) AS ev_count, COUNT(*) AS hit_count
                    FROM paragraphs_fts f
                    LEFT JOIN events e ON e.id = f.event_id
                    WHERE paragraphs_fts MATCH ?
                    {where_extra}
                    """,
                    ([fts_query] + filter_params),
                ).fetchone()
                total_events = count_row["ev_count"]
                total_hits = count_row["hit_count"]
            except sqlite3.OperationalError:
                total_events = len(events)
                total_hits = sum(e["hit_count"] for e in events.values())

    # Compute combined rank: BM25 is negative (lower=better).
    for ev in events.values():
        hit_bonus = math.log1p(ev.get("hit_count", 1))
        best = ev.get("best_rank", 0.0)
        ev["rank"] = best * max(hit_bonus, 1.0)

    out = sorted(events.values(), key=lambda e: e["rank"])[:limit]
    if sort == 'title':
        out.sort(key=lambda e: (e["title"] or "").lower())

    # Remove internal ranking fields before response
    for ev in out:
        ev.pop("best_rank", None)

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
    with contextlib.closing(sqlite3.connect(DB_PATH)) as conn:
        rows = conn.execute(
            "SELECT DISTINCT language FROM events"
            " WHERE language IS NOT NULL ORDER BY language"
        ).fetchall()
    return {"languages": [r[0] for r in rows]}


@app.get("/api/date-range")
def date_range():
    """Return min/max year in the archive for date filter UI."""
    if not os.path.exists(DB_PATH):
        return {"min_year": None, "max_year": None}
    with contextlib.closing(sqlite3.connect(DB_PATH)) as conn:
        row = conn.execute(
            "SELECT MIN(SUBSTR(date,1,4)), MAX(SUBSTR(date,1,4))"
            " FROM events WHERE date IS NOT NULL AND LENGTH(date) >= 4"
        ).fetchone()
    return {"min_year": row[0], "max_year": row[1]}


@app.get("/hierarchy")
def hierarchy():
    if not os.path.exists(DB_PATH):
        return {}
    with contextlib.closing(sqlite3.connect(DB_PATH)) as conn:
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
    for y in tree:
        for s in tree[y]:
            tree[y][s].sort()
    return tree


@app.get("/api/clusters")
def clusters(lens: str = "themes", limit: int = 20):
    if not os.path.exists(DB_PATH):
        return {"lens": lens, "clusters": []}
    with contextlib.closing(sqlite3.connect(DB_PATH)) as conn:
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
            counts: Counter = Counter()
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

    return {"lens": lens, "clusters": clusters_out}


@app.get("/api/discourse")
def discourse(title: str | None = None, event_id: str | None = None):
    if not title and not event_id:
        raise HTTPException(status_code=400, detail="Provide title or event_id")
    if not os.path.exists(DB_PATH):
        raise HTTPException(status_code=404, detail="Discourse store unavailable")

    with contextlib.closing(sqlite3.connect(DB_PATH)) as conn:
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


# ─── Admin endpoints ─────────────────────────────────────────────────────────

@app.get("/admin/events")
def admin_events(
    request: Request,
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=200),
    q: str = Query(""),
    language: str = Query(""),
    tag: str = Query(""),
):
    _check_admin(request)
    if not os.path.exists(DB_PATH):
        return {"events": [], "total": 0}
    with contextlib.closing(sqlite3.connect(DB_PATH)) as conn:
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        has_tags = _table_exists(conn, 'event_tags')
        where_parts, params = ["e.title IS NOT NULL"], []
        if q:
            where_parts.append("(e.title LIKE ? OR e.location LIKE ?)")
            params += [f"%{q}%", f"%{q}%"]
        if language:
            where_parts.append("LOWER(e.language) = LOWER(?)")
            params.append(language)
        if tag and has_tags:
            where_parts.append("EXISTS (SELECT 1 FROM event_tags et WHERE et.event_id = e.id AND et.tag = ?)")
            params.append(tag)
        where = " AND ".join(where_parts)
        total = cur.execute(f"SELECT COUNT(*) FROM events e WHERE {where}", params).fetchone()[0]
        rows = cur.execute(
            f"SELECT e.id, e.title, e.date, e.location, e.language FROM events e WHERE {where}"
            f" ORDER BY COALESCE(e.date,''), e.title LIMIT ? OFFSET ?",
            params + [per_page, (page - 1) * per_page],
        ).fetchall()
        tags_map: dict = {}
        if has_tags and rows:
            ids = [r["id"] for r in rows]
            ph = ",".join("?" * len(ids))
            for r in cur.execute(
                f"SELECT event_id, tag FROM event_tags WHERE event_id IN ({ph})", ids
            ).fetchall():
                tags_map.setdefault(r[0], []).append(r[1])
        events = [
            {
                "id": r["id"], "title": r["title"], "date": r["date"],
                "location": r["location"], "language": r["language"],
                "tags": sorted(tags_map.get(r["id"], [])),
            }
            for r in rows
        ]
    return {"events": events, "total": total, "page": page, "per_page": per_page}


@app.patch("/admin/events/{event_id}")
async def admin_update_event(event_id: str, request: Request, body: dict = Body(...)):
    _check_admin(request)
    allowed = {"title", "date", "location", "language"}
    updates = {k: v for k, v in body.items() if k in allowed}
    if not updates:
        raise HTTPException(status_code=400, detail="No valid fields")
    with contextlib.closing(sqlite3.connect(DB_PATH)) as conn:
        sets = ", ".join(f"{k} = ?" for k in updates)
        conn.execute(f"UPDATE events SET {sets} WHERE id = ?", list(updates.values()) + [event_id])
        conn.commit()
    return {"ok": True}


@app.put("/admin/events/{event_id}/tags")
async def admin_set_tags(event_id: str, request: Request, body: dict = Body(...)):
    _check_admin(request)
    tags = [t.strip().lower() for t in body.get("tags", []) if str(t).strip()]
    with contextlib.closing(sqlite3.connect(DB_PATH)) as conn:
        _ensure_event_tags(conn)
        conn.execute("DELETE FROM event_tags WHERE event_id = ?", (event_id,))
        for tag in tags:
            conn.execute(
                "INSERT OR IGNORE INTO event_tags (event_id, tag) VALUES (?, ?)", (event_id, tag)
            )
        conn.commit()
    return {"ok": True, "tags": sorted(tags)}


@app.delete("/admin/events/{event_id}")
async def admin_delete_event(event_id: str, request: Request):
    _check_admin(request)
    with contextlib.closing(sqlite3.connect(DB_PATH)) as conn:
        para_ids = [
            r[0] for r in
            conn.execute("SELECT id FROM paragraphs WHERE event_id = ?", (event_id,)).fetchall()
        ]
        if para_ids:
            ph = ",".join("?" * len(para_ids))
            conn.execute(f"DELETE FROM paragraphs_fts WHERE rowid IN ({ph})", para_ids)
        conn.execute("DELETE FROM paragraphs WHERE event_id = ?", (event_id,))
        conn.execute("DELETE FROM event_tags WHERE event_id = ?", (event_id,))
        conn.execute("DELETE FROM events WHERE id = ?", (event_id,))
        conn.commit()
    return {"ok": True}


@app.get("/admin/all-tags")
def admin_all_tags(request: Request):
    _check_admin(request)
    if not os.path.exists(DB_PATH):
        return {"tags": []}
    with contextlib.closing(sqlite3.connect(DB_PATH)) as conn:
        if not _table_exists(conn, 'event_tags'):
            return {"tags": []}
        rows = conn.execute(
            "SELECT tag, COUNT(*) as cnt FROM event_tags GROUP BY tag ORDER BY cnt DESC"
        ).fetchall()
    return {"tags": [{"tag": r[0], "count": r[1]} for r in rows]}


@app.post("/admin/ingest")
async def admin_ingest(request: Request, body: dict = Body(...)):
    _check_admin(request)
    title    = (body.get("title") or "").strip()
    date     = (body.get("date") or "").strip() or None
    location = (body.get("location") or "").strip() or None
    language = (body.get("language") or "English").strip()
    content  = (body.get("content") or "").strip()
    manual_tags = [t.strip().lower() for t in body.get("tags", []) if str(t).strip()]

    if not title or not content:
        raise HTTPException(status_code=400, detail="title and content are required")

    # Split into paragraphs
    raw = [p.strip() for p in re.split(r'\n{2,}', content)]
    paragraphs = [p for p in raw if len(p) >= 20]
    if not paragraphs:
        paragraphs = [p for p in [ln.strip() for ln in content.split('\n')] if len(p) >= 10]
    if not paragraphs:
        raise HTTPException(status_code=400, detail="No usable paragraphs in content")

    auto_tags = _auto_classify(title, content)
    all_tags = sorted(set(manual_tags) | set(auto_tags))
    event_id = str(uuid.uuid4())

    with contextlib.closing(sqlite3.connect(DB_PATH)) as conn:
        _ensure_event_tags(conn)
        conn.execute(
            "INSERT INTO events (id, title, date, location, language) VALUES (?, ?, ?, ?, ?)",
            (event_id, title, date, location, language),
        )
        conn.executemany(
            "INSERT INTO paragraphs (event_id, sequence_number, content, is_embedded)"
            " VALUES (?, ?, ?, 0)",
            [(event_id, seq, para, 0) for seq, para in enumerate(paragraphs, 1)],
        )
        # Index into FTS
        norm_title = _normalize_devanagari(title)
        conn.execute("""
            INSERT INTO paragraphs_fts
                (content, title, event_id, paragraph_id, sequence_number, title_search)
            SELECT content, ?, event_id, id, sequence_number, ?
            FROM paragraphs WHERE event_id = ?
        """, (norm_title, norm_title, event_id))
        conn.executemany(
            "INSERT OR IGNORE INTO event_tags (event_id, tag) VALUES (?, ?)",
            [(event_id, tag) for tag in all_tags],
        )
        conn.commit()

    return {"ok": True, "event_id": event_id, "paragraphs": len(paragraphs), "tags": all_tags}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
