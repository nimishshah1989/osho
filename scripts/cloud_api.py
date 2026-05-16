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

# Load env vars from .env file in repo root, BEFORE we read os.getenv() below.
# Lets ADMIN_KEY / OSHO_ENV / ALLOWED_ORIGINS live in a file on disk so it
# doesn't matter who starts uvicorn (supervisor, watchdog, manual) — the
# config always comes from the same place. dotenv is in requirements.txt.
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.env'))
except ImportError:
    pass  # dotenv is optional — env vars from the shell still work

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(BASE_DIR, 'data/osho.db')

ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv("ALLOWED_ORIGINS", "https://osho-zeta.vercel.app").split(",")
    if o.strip()
]

ADMIN_KEY = os.getenv("ADMIN_KEY", "osho-admin")
OSHO_ENV = os.getenv("OSHO_ENV", "development")

if OSHO_ENV == "production" and (not ADMIN_KEY or ADMIN_KEY == "osho-admin"):
    raise RuntimeError(
        "ADMIN_KEY must be set to a non-default value when OSHO_ENV=production. "
        "Refusing to start with the default key — it would let anyone edit/delete events."
    )

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
_NASAL_RULES = [
    ('ङ', 'क', 'ङ'),
    ('ञ', 'च', 'ञ'),
    ('ण', 'ट', 'ण'),
    ('न', 'त', 'न'),
    ('म', 'प', 'म'),
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
# Matches a query consisting of exactly one quoted phrase ("…") and nothing
# else. Used to decide whether a query is a literal phrase the user wants
# matched against everything (titles included), versus a bag-of-words / NEAR
# query where matching the title would just inflate the count with the
# discourse-series name (Sugit 2026-05-16: "Satyam Shivam").
_PHRASE_ONLY_RE = re.compile(r'^\s*"[^"]+"\s*$')


def _rewrite_query(user_query: str, exact: bool = False) -> str:
    """Normalise the user's query for FTS5.

    When `exact` is False (default) we apply Devanagari nasal-virama →
    anusvara collapsing so अनन्त and अनंत find each other. When `exact`
    is True we leave the text alone so the reviewer can find the literal
    spelling they typed — the paragraphs_fts_exact index they're hitting
    in that mode was built with the same hands-off policy.

    Also restricts the search to the `content` column unless the user
    asked for either a literal phrase or an explicit `title:` filter.
    Otherwise a multi-word query like `Satyam Shivam` matches every
    discourse in the `Satyam Shivam Sundaram ~ NN` series via the
    indexed title column and the hit count balloons with results that
    don't help the reader. Phrase mode (`"…"`) still matches both
    columns so the user can still find the series by its title."""
    q = _TITLE_FILTER_RE.sub('title_search:', user_query).strip()
    if not exact:
        q = _normalize_devanagari(q)
    if not q:
        return q
    # Leave alone if the user is already filtering by column (title:foo)
    # or if the entire query is a single quoted phrase.
    if 'title_search:' in q or _PHRASE_ONLY_RE.match(q):
        return q
    # Otherwise scope to the content column. FTS5 column-filter syntax:
    #   {colname} : (subquery)
    return f'{{content}} : ({q})'


# ─── Cross-paragraph NEAR support ────────────────────────────────────────────

_NEAR_RE = re.compile(
    r'^NEAR\s*\(\s*(.+?)\s*,\s*(\d+)\s*\)\s*$',
    re.IGNORECASE,
)
# `_rewrite_query` may have wrapped the user's NEAR(…) in a column-scope
# filter (e.g. `{content} : (NEAR(politicians mafia, 30))`). Peel that
# wrapper off before pattern-matching so the augmentation paths still
# fire after the title-exclusion change (Sugit 2026-05-16).
_COLUMN_FILTER_WRAP_RE = re.compile(
    r'^\s*\{[^}]+\}\s*:\s*\((?P<inner>.+)\)\s*$',
    re.DOTALL,
)


def _parse_near(fts_query: str):
    q = fts_query.strip()
    wrap = _COLUMN_FILTER_WRAP_RE.match(q)
    if wrap:
        q = wrap.group('inner').strip()
    m = _NEAR_RE.match(q)
    if not m:
        return None
    words_raw, dist_str = m.group(1), m.group(2)
    words = [w.strip().strip('"') for w in words_raw.split() if w.strip().strip('"')]
    if len(words) < 2:
        return None
    return words, int(dist_str)


def _min_para_span(seqs_per_word: list[list[int]]) -> int:
    if any(not lst for lst in seqs_per_word):
        return sys.maxsize
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


_TOKEN_RE = re.compile(r"[\wऀ-ॿ]+", re.UNICODE)


def _hl_token_positions(hl: str) -> tuple[list[int], int]:
    """Parse an FTS5 highlight() result containing \\x02 .. \\x03 markers.

    Returns ([positions of matched tokens, 0-indexed], total_token_count).
    Markers are padded with whitespace before tokenising so a marker that
    butts up against a token character doesn't get swallowed into the
    token. Lowercasing matches the unicode61 default folding.
    """
    if not hl:
        return [], 0
    padded = hl.replace('\x02', ' \x02 ').replace('\x03', ' \x03 ').lower()
    parts = re.findall(r"\x02|\x03|[\wऀ-ॿ]+", padded)
    positions: list[int] = []
    total = 0
    in_match = False
    for p in parts:
        if p == '\x02':
            in_match = True
        elif p == '\x03':
            in_match = False
        else:
            if in_match:
                positions.append(total)
            total += 1
    return positions, total


def _augment_near_adjacent_strict(
    conn: sqlite3.Connection,
    words: list[str],
    near_dist: int,
    where_extra: str,
    filter_params: list,
    fts_table: str = "paragraphs_fts",
) -> dict:
    """Find pairs of *adjacent* paragraphs whose tokens span a NEAR match.

    FTS5's NEAR() operates within a single FTS row (= one paragraph), so it
    cannot find a match when the two query terms straddle a paragraph break.
    This augmentation closes that gap for the common 2-word case by
    measuring real token distance across consecutive paragraphs:

        distance = (tokens after `word_a` in para_n)
                   + (tokens before `word_b` in para_{n+1})

    A pair is included only if distance <= near_dist, so it does NOT
    re-introduce the false positives the paragraph-adjacency heuristic
    produced (see commit 8c69841).

    Only handles len(words) == 2. For 3+-word NEAR, fall back to the
    existing paragraph-span heuristic via `_augment_near_cross_paragraph`.

    `fts_table` selects the stemmed (default) or exact FTS index. The
    name is taken only from the closed set
    {paragraphs_fts, paragraphs_fts_exact}, never from user input — so
    the f-string SQL stays injection-safe.
    """
    if len(words) != 2:
        return {}
    if fts_table not in ("paragraphs_fts", "paragraphs_fts_exact"):
        raise ValueError(f"unsupported fts_table: {fts_table!r}")
    # In exact mode we don't normalise Devanagari at index time, so we must
    # not normalise at query time either — otherwise the query token won't
    # match the stored token.
    word_norm = (lambda s: s) if fts_table.endswith("_exact") else _normalize_devanagari

    per_word: list[dict[str, dict[int, dict]]] = []
    for word in words:
        # Restrict to the content column for the same reason as
        # _rewrite_query — augmentation should not pick up title-only
        # word matches that wouldn't survive the cross-paragraph check
        # in the first place.
        word_fts = f'{{content}} : ({word_norm(word)})'
        try:
            wrows = conn.execute(
                f"""
                SELECT
                    f.event_id,
                    f.sequence_number,
                    f.paragraph_id,
                    f.content,
                    p.role AS role,
                    highlight({fts_table}, 0, '\x02', '\x03') AS hl
                FROM {fts_table} f
                LEFT JOIN events e ON e.id = f.event_id
                LEFT JOIN paragraphs p ON p.id = f.paragraph_id
                WHERE {fts_table} MATCH ?
                {where_extra}
                """,
                ([word_fts] + filter_params),
            ).fetchall()
        except sqlite3.OperationalError:
            return {}
        per_ev: dict[str, dict[int, dict]] = {}
        for r in wrows:
            positions, total = _hl_token_positions(r['hl'] or r['content'])
            if not positions:
                continue
            per_ev.setdefault(r['event_id'], {})[r['sequence_number']] = {
                'pid': r['paragraph_id'],
                'content': r['content'],
                'role': r['role'],
                'positions': positions,
                'token_count': total,
            }
        per_word.append(per_ev)

    if not per_word or not per_word[0] or not per_word[1]:
        return {}

    common_ids = set(per_word[0].keys()) & set(per_word[1].keys())
    events: dict = {}
    for ev_id in common_ids:
        wa = per_word[0][ev_id]
        wb = per_word[1][ev_id]
        best: tuple[int, int, int, dict, dict] | None = None  # (dist, seq_a, seq_b, info_a, info_b)
        for seq_a, info_a in wa.items():
            for delta in (-1, 1):
                seq_b = seq_a + delta
                if seq_b == seq_a or seq_b not in wb:
                    continue
                info_b = wb[seq_b]
                if delta == 1:
                    last_a = max(info_a['positions'])
                    first_b = min(info_b['positions'])
                    dist = (info_a['token_count'] - 1 - last_a) + first_b
                else:
                    first_a = min(info_a['positions'])
                    last_b = max(info_b['positions'])
                    dist = (info_b['token_count'] - 1 - last_b) + first_a
                if dist <= near_dist and (best is None or dist < best[0]):
                    best = (dist, seq_a, seq_b, info_a, info_b)
        if best is None:
            continue

        _, seq_a, seq_b, info_a, info_b = best
        ev_row = conn.execute(
            "SELECT title, date, location, language FROM events WHERE id = ?",
            (ev_id,),
        ).fetchone()
        if not ev_row:
            continue

        hits = []
        for seq, info in sorted([(seq_a, info_a), (seq_b, info_b)]):
            content = _strip_shailendra(info['content'] or '')
            is_meta = (
                seq == 0
                or content.lower().startswith('event page in sannyas')
            )
            if not is_meta:
                hit: dict = {
                    'paragraph_id': info['pid'],
                    'sequence_number': seq,
                    'content': content,
                    'hl': None,
                }
                if info.get('role'):
                    hit['role'] = info['role']
                hits.append(hit)

        events[ev_id] = {
            'event_id': ev_id,
            'title': ev_row[0],
            'date': ev_row[1],
            'location': ev_row[2],
            'language': ev_row[3],
            'rank': 0.0,
            'hit_count': 2,
            'hits': hits,
            '_cross_para': True,
        }

    return events


def _augment_near_cross_paragraph(
    conn: sqlite3.Connection,
    words: list[str],
    para_span: int,
    where_extra: str,
    filter_params: list,
    fts_table: str = "paragraphs_fts",
) -> dict:
    if fts_table not in ("paragraphs_fts", "paragraphs_fts_exact"):
        raise ValueError(f"unsupported fts_table: {fts_table!r}")
    word_norm = (lambda s: s) if fts_table.endswith("_exact") else _normalize_devanagari

    per_word: list[dict[int, list[int]]] = []
    for word in words:
        # Restrict to the content column for the same reason as
        # _rewrite_query — augmentation should not pick up title-only
        # word matches that wouldn't survive the cross-paragraph check
        # in the first place.
        word_fts = f'{{content}} : ({word_norm(word)})'
        try:
            wrows = conn.execute(
                f"""
                SELECT f.event_id, f.sequence_number
                FROM {fts_table} f
                LEFT JOIN events e ON e.id = f.event_id
                WHERE {fts_table} MATCH ?
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

        ev_row = conn.execute(
            "SELECT title, date, location, language FROM events WHERE id = ?",
            (ev_id,),
        ).fetchone()
        if not ev_row:
            continue

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


def _ensure_paragraph_role_column(conn: sqlite3.Connection) -> None:
    """Idempotent migration. Older DBs (built before the Word-style ingester)
    don't have `paragraphs.role`; add it on startup so the API can SELECT it
    unconditionally. Existing rows get NULL, which the frontend renders as
    plain body text — same as today's behaviour."""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(paragraphs)").fetchall()}
    if "role" not in cols:
        conn.execute("ALTER TABLE paragraphs ADD COLUMN role TEXT")
        conn.commit()


def _ensure_events_translated_from_column(conn: sqlite3.Connection) -> None:
    """Idempotent migration. The `original=true` search filter references
    `events.translated_from`; on a prod DB built before the ingester
    introduced that column, the bare SELECT raises OperationalError and
    the API returns "Invalid search syntax." This adds the column on
    startup so the filter works against legacy DBs without a reingest.
    Existing rows get NULL, which the filter treats as "Original" — the
    only sensible default for records that pre-date the translated_from
    metadata."""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(events)").fetchall()}
    if "translated_from" not in cols:
        conn.execute("ALTER TABLE events ADD COLUMN translated_from TEXT")
        conn.commit()


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not os.path.exists(DB_PATH):
        print(f"WARNING: DB not found at {DB_PATH}", flush=True)
    else:
        with contextlib.closing(sqlite3.connect(DB_PATH)) as conn:
            has_fts = _table_exists(conn, 'paragraphs_fts')
            _ensure_paragraph_role_column(conn)
            _ensure_events_translated_from_column(conn)
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
    original: bool = Query(
        False,
        description=(
            "When true, return only records Osho originally gave in their "
            "language (translated_from is NULL or 'none')."
        ),
    ),
    exact: bool = Query(
        False,
        description=(
            "When true, search the un-stemmed / un-normalised FTS index. "
            "'teach' matches only 'teach' (not 'teacher' or 'teaching'); "
            "'अनन्त' matches only 'अनन्त' (not 'अनंत')."
        ),
    ),
    date_from: Optional[str] = Query(None, description="Start date YYYY or YYYY-MM-DD"),
    date_to: Optional[str] = Query(None, description="End date YYYY or YYYY-MM-DD"),
):
    if not os.path.exists(DB_PATH):
        raise HTTPException(status_code=503, detail="Archive unavailable.")

    # Resolve which FTS table to hit. The names are hard-coded — never
    # interpolated from user input — so the f-strings below are safe.
    fts_table = "paragraphs_fts_exact" if exact else "paragraphs_fts"
    fts_query = _rewrite_query(q, exact=exact)
    if not fts_query:
        raise HTTPException(status_code=400, detail="Empty query.")

    if date_from and date_to and date_from > date_to:
        raise HTTPException(status_code=400, detail="date_from must be ≤ date_to")

    filters = []
    filter_params: list = []
    padded_from = ''
    padded_to = ''

    if language:
        filters.append("LOWER(e.language) = LOWER(?)")
        filter_params.append(language)
    if original:
        # Originals: either the column isn't present (legacy rows) or its
        # value is the explicit "none" Antar writes into the @-headers.
        filters.append(
            "(e.translated_from IS NULL OR LOWER(e.translated_from) = 'none')"
        )
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
                    highlight({fts_table}, 0, '\x02', '\x03') AS hl,
                    f.title,
                    e.date,
                    e.location,
                    e.language,
                    p.role AS role,
                    bm25({fts_table}) AS rank
                FROM {fts_table} f
                LEFT JOIN events e ON e.id = f.event_id
                LEFT JOIN paragraphs p ON p.id = f.paragraph_id
                WHERE {fts_table} MATCH ?
                {where_extra}
                ORDER BY rank
                LIMIT ?
                """,
                ([fts_query] + filter_params + [limit * 10]),
            ).fetchall()
        except sqlite3.OperationalError as ex:
            raise HTTPException(status_code=400, detail="Invalid search syntax.")

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
                hit: dict = {
                    "paragraph_id": r["paragraph_id"],
                    "sequence_number": r["sequence_number"],
                    "content": content,
                    "hl": hl,
                }
                if r["role"]:
                    hit["role"] = r["role"]
                ev["hits"].append(hit)

        augmented_cross_para = False
        if near_parsed:
            near_words, near_dist = near_parsed
            # Strict adjacent-paragraph augmentation (2-word NEAR only).
            # Catches matches where the two terms straddle a paragraph break
            # but are still within `near_dist` actual tokens of each other —
            # something FTS5's row-bound NEAR cannot find on its own.
            if len(near_words) == 2:
                adj = _augment_near_adjacent_strict(
                    conn, near_words, near_dist, where_extra, filter_params,
                    fts_table=fts_table,
                )
                for ev_id, cev in adj.items():
                    if ev_id not in events:
                        events[ev_id] = cev
                        augmented_cross_para = True
            if near_dist >= 100:
                para_span = max(1, near_dist // 30)
                cross = _augment_near_cross_paragraph(
                    conn, near_words, para_span, where_extra, filter_params,
                    fts_table=fts_table,
                )
                for ev_id, cev in cross.items():
                    if ev_id not in events:
                        events[ev_id] = cev
                        augmented_cross_para = True

        # Count strategy:
        #   - Whenever cross-paragraph augmentation added events that FTS5's
        #     in-row NEAR didn't, derive counts from the merged events dict so
        #     the total reflects what the user actually sees.
        #   - Otherwise (all-words / phrase / pure in-row NEAR), the unlimited
        #     COUNT(*) over the FTS index stays accurate even when the main
        #     SELECT is capped by LIMIT.
        near_words, near_dist = near_parsed if near_parsed else (None, 0)
        if augmented_cross_para:
            total_events = len(events)
            total_hits = sum(e["hit_count"] for e in events.values())
        else:
            try:
                count_row = conn.execute(
                    f"""
                    SELECT COUNT(DISTINCT f.event_id) AS ev_count, COUNT(*) AS hit_count
                    FROM {fts_table} f
                    LEFT JOIN events e ON e.id = f.event_id
                    WHERE {fts_table} MATCH ?
                    {where_extra}
                    """,
                    ([fts_query] + filter_params),
                ).fetchone()
                total_events = count_row["ev_count"]
                total_hits = count_row["hit_count"]
            except sqlite3.OperationalError:
                total_events = len(events)
                total_hits = sum(e["hit_count"] for e in events.values())

    for ev in events.values():
        hit_bonus = math.log1p(ev.get("hit_count", 1))
        best = ev.get("best_rank", 0.0)
        ev["rank"] = best * max(hit_bonus, 1.0)

    out = sorted(events.values(), key=lambda e: e["rank"])[:limit]
    if sort == 'title':
        out.sort(key=lambda e: (e["title"] or "").lower())

    for ev in out:
        ev.pop("best_rank", None)
        ev.pop("_cross_para", None)

    return {
        "query": q,
        "total": total_events,
        "total_hits": total_hits,
        "events": out,
    }


@app.get("/api/languages")
def languages():
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
def discourse(title: str | None = None, event_id: str | None = None, q: str | None = None):
    if not title and not event_id:
        raise HTTPException(status_code=400, detail="Provide title or event_id")
    if not os.path.exists(DB_PATH):
        raise HTTPException(status_code=404, detail="Discourse store unavailable")

    fts_query = _rewrite_query(q) if q else None

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
            "SELECT id, sequence_number, content, role FROM paragraphs"
            " WHERE event_id = ? ORDER BY sequence_number",
            (ev["id"],),
        )
        para_rows = cur.fetchall()

        hl_map: dict = {}
        if fts_query:
            try:
                hl_rows = conn.execute(
                    """
                    SELECT f.paragraph_id, highlight(paragraphs_fts, 0, '\x02', '\x03') AS hl
                    FROM paragraphs_fts f
                    WHERE paragraphs_fts MATCH ?
                    AND f.event_id = ?
                    """,
                    (fts_query, ev["id"]),
                ).fetchall()
                for row in hl_rows:
                    raw_hl = row["hl"] or ''
                    hl_map[row["paragraph_id"]] = (
                        _strip_shailendra(raw_hl)
                        .replace('\x02', '«')
                        .replace('\x03', '»')
                    )
            except sqlite3.OperationalError:
                pass

        paragraphs = [
            {
                "sequence_number": r["sequence_number"],
                "content": _strip_shailendra(r["content"]),
                **({"role": r["role"]} if r["role"] else {}),
                **({"hl": hl_map[r["id"]]} if r["id"] in hl_map else {}),
            }
            for r in para_rows
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
        # FTS rows must use the normalised form so anusvara/nasal-virama variants
        # search identically. Raw paragraphs keep the original spelling for display.
        norm_title = _normalize_devanagari(title)
        para_rows = conn.execute(
            "SELECT id, sequence_number, content FROM paragraphs WHERE event_id = ?",
            (event_id,),
        ).fetchall()
        conn.executemany(
            """
            INSERT INTO paragraphs_fts
                (content, title, event_id, paragraph_id, sequence_number, title_search)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    _normalize_devanagari(content or ""),
                    norm_title,
                    event_id,
                    pid,
                    seq,
                    norm_title,
                )
                for pid, seq, content in para_rows
            ],
        )
        conn.executemany(
            "INSERT OR IGNORE INTO event_tags (event_id, tag) VALUES (?, ?)",
            [(event_id, tag) for tag in all_tags],
        )
        conn.commit()

    return {"ok": True, "event_id": event_id, "paragraphs": len(paragraphs), "tags": all_tags}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
