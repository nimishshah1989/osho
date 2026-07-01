from fastapi import Body, Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
import contextlib
import heapq
import io
import math
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
import threading
import unicodedata
import uuid
import zipfile
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

# Make ingest_docx / word_update importable (they live alongside this file
# and import from build_fts using bare module names, so scripts/ must be on
# sys.path, not just the repo root).
_SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv("ALLOWED_ORIGINS", "https://oshoarchives.com").split(",")
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


_LANGUAGE_ALIASES: dict[str, tuple[str, ...]] = {
    'english': ('English', 'en', 'EN'),
    'hindi':   ('Hindi', 'hi', 'HI'),
    'en':      ('English', 'en', 'EN'),
    'hi':      ('Hindi', 'hi', 'HI'),
}


def _expand_language_aliases(language: str) -> list[str]:
    """Map whatever the caller asked for to every aliased form the DB
    might use. So `?language=English` matches rows with `English` OR
    `en` (and same for Hindi). Unknown languages pass through verbatim
    so a future addition (e.g. `Chinese`) keeps working without code
    changes."""
    key = (language or '').strip().lower()
    return list(_LANGUAGE_ALIASES.get(key, (language,)))


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


def _ensure_corpus_meta(conn: sqlite3.Connection) -> None:
    conn.execute(
        "CREATE TABLE IF NOT EXISTS corpus_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    )
    conn.commit()


def _get_corpus_meta(conn: sqlite3.Connection, key: str) -> Optional[str]:
    row = conn.execute(
        "SELECT value FROM corpus_meta WHERE key = ?", (key,)
    ).fetchone()
    return row[0] if row else None


def _set_corpus_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO corpus_meta (key, value) VALUES (?, ?)", (key, value)
    )
    conn.commit()


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
# Matches an English possessive apostrophe-s ("women's", "it's") so we can
# strip it before the generic apostrophe→space replacement. Without this,
# "women's liberation" becomes "women s liberation": the lone "s" token
# matches every paragraph that contains any apostrophe word (women's, it's,
# that's…), inflating hit counts into the thousands. Stripping "'s" first
# gives "women liberation" — a clean 2-token AND query. Both straight (')
# and curly (') apostrophes are handled; the 's' is case-insensitive to
# cover "Boss'S" etc.
_POSSESSIVE_RE = re.compile(r"[''][Ss]\b")


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
    # Strip English possessives first ("women’s" → "women", "it’s" → "it").
    # Without this the lone "s" token from "women’s" → "women s" matches
    # every paragraph that has any apostrophe word, producing thousands of
    # false hits. Phrases are exempt (handled by the early return above).
    q = _POSSESSIVE_RE.sub('', q)
    # Replace remaining apostrophes with a space (e.g. "rock’n’roll" →
    # "rock n roll"). The unicode61 tokenizer splits on apostrophe at index
    # time so spaces and apostrophes yield the same tokens — but FTS5 treats
    # a bare apostrophe as a grammar error, so we must replace rather than
    # leave. Both straight (U+0027) and curly (U+2019) forms.
    q = q.replace("’", " ").replace("’", " ").strip()
    # A query of nothing but apostrophes collapses to empty here — return
    # empty rather than wrapping `{content} : ()`, which FTS5 also rejects.
    if not q:
        return ""
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

# Function words dropped from "Within N words" (NEAR) proximity matching.
# OCTP (Folio Views) ignores articles / prepositions / pronouns when matching
# within N words, so a sentence pasted into Within-N mode — e.g.
# "falling in love you remain a child", or Hindi "मन की शांति" — matches on its
# content words ("falling love remain child" / "मन शांति"). Keeping the function
# words as proximity units was actively harmful: each matches nearly every
# paragraph in the 1.3M-row corpus, so the record-level gather (a) scanned their
# giant FTS posting lists — pushing such a query to ~25s, past the client's
# fetch timeout, surfacing as "NetworkError" / "Failed to fetch" — and (b)
# flooded the `LIMIT 100000` gather with function-word rows, truncating the
# genuine discourse out before it was ever scored (the query then returned 0
# even though the exact phrase existed).
#
#   English — pruned of spiritually-loaded words common in the discourses
#     (be/being/now/here/no/not/one/self/will/…); those are NEVER stripped, so
#     "be here now" keeps literal proximity.
#   Hindi — the postpositions (का/की/के/को/में/से/पर/ने/तक), conjunctions
#     (और/या/कि), copulas (है/हैं/था/थे/थी/हूँ/हो) and common pronouns: the
#     Devanagari equivalents of a/the/of/in. Pruned of content words
#     (मन/ध्यान/प्रेम/सत्य/मौन/…); negation (नहीं/न) is NOT stripped.
#
# Compared after NFC-normalising both sides (Devanagari can arrive in more than
# one normal form). MUST stay in sync with NEAR_STOPWORDS in
# frontend/lib/search/queryRewrite.ts.
_NEAR_STOPWORD_SOURCE = (
    # ── English ──
    "a an the and or but nor "
    "i you he she it we they me him her us them "
    "my your his its our their mine yours hers ours theirs "
    "this that these those which who whom whose "
    "am is are was were do does did have has had "
    "of in on at to for with by from into onto about as "
    # ── Hindi (Devanagari) ──
    "का की के को में से पर ने तक "          # postpositions
    "और या कि एवं तथा "                      # conjunctions
    "है हैं हूँ हो था थे थी "                  # copulas (होना)
    "मैं मुझे मेरा तू तुम तुम्हें आप "        # 1st/2nd-person pronouns
    "यह ये वह वो वे हम इस उस जो "             # demonstrative/relative pronouns
    "भी ही"                                  # emphasis particles
)
_NEAR_STOPWORDS = frozenset(
    unicodedata.normalize("NFC", w) for w in _NEAR_STOPWORD_SOURCE.split()
)


def _strip_near_stopwords(words: list[str]) -> list[str]:
    """Drop function-word units from a NEAR query so proximity is measured on
    content words (OCTP semantics) — English articles/prepositions/pronouns and
    Hindi postpositions/conjunctions/copulas. Falls back to the original list if
    fewer than two content words remain, so a deliberately function-word query
    ("to be or not to be", "की में से") still searches something."""
    content = [
        w for w in words
        if unicodedata.normalize("NFC", w.strip().lower()) not in _NEAR_STOPWORDS
    ]
    return content if len(content) >= 2 else words


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
    words = _strip_near_stopwords(words)
    return words, int(dist_str)


# Splits an all-words query into its top-level units, treating an
# explicit ` AND ` separator (the shape the frontend's Hindi OR-expansion
# emits: `(अनंत OR अनन्त) AND (मौन OR मौं)`) as the boundary.
_AND_SPLIT_RE = re.compile(r'\s+AND\s+')


def _parse_query_units(user_query: str, exact: bool = False):
    """Split an *all-words* query into the list of independent "units"
    that must each be present somewhere in a record for it to match at
    record level.

    A unit is a self-contained FTS subquery — either a bare term
    (`love`) or a parenthesised OR-group from the frontend's Hindi
    spelling expansion (`अनंत OR अनन्त`, with the surrounding parens
    stripped). The original user query `q` is parsed (not the rewritten
    `{content}:(…)` form) so the units can be re-scoped to the content
    column individually.

    Returns the list of unit subquery strings, or ``None`` when the query
    can't be confidently treated as a flat AND of units — i.e. it
    contains a quote (phrase), an explicit `title:` filter, fewer than
    two units, or any leftover grouping/operator we don't model. Callers
    fall back to the existing single-MATCH path in that case so phrase /
    single-word / title searches keep their current behaviour.
    """
    if not user_query:
        return None
    q = user_query.strip()
    # Phrases and explicit title filters keep the legacy path.
    if '"' in q or _TITLE_FILTER_RE.search(q):
        return None
    if not exact:
        q = _normalize_devanagari(q)
    # Possessive "’s" stripped first (women’s → women), then remaining
    # apostrophes replaced with space — mirrors _rewrite_query.
    q = _POSSESSIVE_RE.sub('', q)
    q = q.replace("’", " ").replace("’", " ").strip()
    if not q:
        return None

    # Hindi OR-expansion shape: `(g1) AND (g2) AND …`. Split on the
    # explicit AND separator the frontend emits.
    has_explicit_and = bool(_AND_SPLIT_RE.search(q))
    parts = _AND_SPLIT_RE.split(q) if has_explicit_and else q.split()

    units: list[str] = []
    for part in parts:
        part = part.strip()
        if not part:
            continue
        if part.startswith('(') and part.endswith(')'):
            # A parenthesised OR-group — strip the outer parens and keep
            # the inner OR expression verbatim (it'll be re-wrapped in a
            # content-scope filter by the caller).
            inner = part[1:-1].strip()
            if not inner or '(' in inner or ')' in inner:
                # Nested grouping we don't model — bail to legacy path.
                return None
            units.append(inner)
        else:
            # A bare run of terms. With an explicit AND separator this is
            # a single term; without one, implicit-AND whitespace means
            # each whitespace token is its own unit. Either way, any
            # stray paren or operator we didn't expect means bail.
            if '(' in part or ')' in part:
                return None
            if has_explicit_and:
                units.append(part)
            else:
                units.extend(part.split())

    # Reject if a unit is a bare boolean operator — but only for whitespace-
    # split queries where `a OR b` (without parens) would emit ["a", "OR",
    # "b"]. With explicit " AND " separators (the frontend's Hindi variant-
    # expansion shape), each part is an intended search token: "Or" in
    # "Agyat Ki Or" is the Hindi word ओर (towards), not the FTS5 operator.
    #
    # FTS5 keywords are case-SENSITIVE: only "OR", "AND", "NOT", "NEAR" (all
    # uppercase) are operators. Mixed-case "Or", "And" etc. are literal tokens
    # and must NOT be rejected — otherwise "Agyat Ki Or समझाया" falls back to
    # paragraph-level AND (requiring all words in one paragraph) instead of
    # discourse-level AND (words anywhere in the same discourse).
    if not has_explicit_and:
        for u in units:
            if u.strip() in ('OR', 'AND', 'NOT', 'NEAR'):
                return None
    if len(units) < 2:
        return None
    return units


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


def _count_tokens(text: str) -> int:
    """Token count for a paragraph using the same tokenisation as
    `_hl_token_positions` (so record-level token offsets line up with the
    in-paragraph positions FTS5 highlight() reports). No markers present,
    so only the total is needed."""
    _, total = _hl_token_positions(text or "")
    return total


def _min_token_window(positions_per_unit: list[list[int]]) -> tuple[int, int, int]:
    """Smallest window that contains at least one position from every
    unit's sorted position list. A k-way merge over the per-unit
    record-level token-position lists. Returns ``(span, lo, hi)`` where
    ``span = hi - lo`` is the window width and ``[lo, hi]`` are the
    record-level token positions bounding the tightest match — so the
    caller can map them back to the paragraphs that actually form the
    proximity hit. Returns ``(sys.maxsize, 0, 0)`` if any unit is absent."""
    if any(not lst for lst in positions_per_unit):
        return sys.maxsize, 0, 0
    heap = [(lst[0], i, 0) for i, lst in enumerate(positions_per_unit)]
    heapq.heapify(heap)
    max_val = max(lst[0] for lst in positions_per_unit)
    best = sys.maxsize
    best_lo = best_hi = 0
    while True:
        min_val, ui, pos = heapq.heappop(heap)
        if max_val - min_val < best:
            best = max_val - min_val
            best_lo, best_hi = min_val, max_val
        if best == 0:
            break
        npos = pos + 1
        if npos >= len(positions_per_unit[ui]):
            break
        nval = positions_per_unit[ui][npos]
        max_val = max(max_val, nval)
        heapq.heappush(heap, (nval, ui, npos))
    return best, best_lo, best_hi


# Cap on how many common events we'll do the (more expensive) paragraph
# gather + token-offset work for. Record-level matching is only reached
# for multi-unit all-words / NEAR queries, where the intersection of
# per-unit event sets is already narrow; the cap is a safety valve against
# a pathological query (e.g. two extremely common stopword-like units)
# blowing up memory. Far above any realistic discourse-count for a real
# multi-word query.
_RECORD_LEVEL_EVENT_CAP = 2000
# When a query matches more than this many discourses, the response is
# trimmed to metadata-only hits (no paragraph text) and flagged
# too_many=true so the frontend can warn the user.
_TOO_MANY_THRESHOLD = 500

# NEAR position-gather fast path: when the Step-B union gather was complete
# (not truncated) and matched at most this many paragraphs, per-unit token
# positions are collected by re-running each unit's MATCH restricted to the
# already-known matched FTS rowids (a rowid seek) instead of re-scanning each
# unit's full posting list. Verified ~25× faster on common stemmed terms with
# byte-identical results; above this size (or when the gather was truncated)
# the original full-scan path is used so results never change. This is what
# cuts the within-N "time-to-first-byte" that a flaky VPN tunnel drops.
_NEAR_ROWID_FASTPATH_MAX = 10000


# SQL fragment mirroring _is_meta_paragraph for use inside FTS MATCH
# queries: drop the title row (sequence 0) and the sannyas-wiki marker so
# they never qualify a record or count as a hit. `f.content NOT LIKE` is
# ASCII-case-insensitive in SQLite, which covers the English marker. Must
# NOT be applied to the all-paragraphs offsets query (offsets need every
# paragraph). Kept in sync with _is_meta_paragraph.
_META_EXCLUDE_SQL = (
    "AND f.sequence_number <> 0 "
    "AND f.content NOT LIKE 'event page in sannyas%'"
)


def _is_meta_paragraph(seq: int, content: str) -> bool:
    """A paragraph that is page metadata, not discourse text: the title
    row (sequence 0) or the "event page in sannyas.wiki" marker. These
    must never count as a search hit — neither in the displayed snippets
    NOR in hit_count / total_hits (the 2026-05-31 record-level bug counted
    them in the totals while hiding them from the snippets)."""
    return (
        seq == 0
        or _strip_shailendra(content or '').lower().startswith("event page in sannyas")
    )


def _record_level_search(
    conn: sqlite3.Connection,
    units: list[str],
    near_dist: Optional[int],
    where_extra: str,
    filter_params: list,
    fts_table: str = "paragraphs_fts",
    _max_hits: Optional[int] = 3,
) -> tuple[dict, int, int]:
    """Record-level All-words / Within-N matching (OCTP semantics).

    A "unit" is a self-contained FTS subquery (a bare term like ``love`` or
    a parenthesised OR-group like ``अनंत OR अनन्त``). Each unit is scoped to
    the content column as ``{content}:(unit)``.

    Matching is over the WHOLE discourse, not a single FTS5 row (= one
    paragraph):

    * **All-words** (``near_dist is None``): a record matches iff every unit
      occurs *somewhere* in it (words may span paragraphs — fixes #7).
    * **Within-N** (``near_dist`` set): additionally, the record-level token
      positions of the units must fit inside a window of ``near_dist`` tokens.
      Token offsets are computed against the full discourse so a match may
      straddle a paragraph break (fixes #2). Within-N events are always a
      subset of the All-words events with the same per-event paragraph-hit
      sets, so Within-N totals are a strict subset of All-words totals
      (fixes #6).

    Returns ``(events_dict, total_events, total_hits)`` where ``total_hits``
    is the sum over qualifying events of the number of matched paragraphs in
    that event (the agreed paragraph-level counting rule).
    """
    if fts_table not in ("paragraphs_fts", "paragraphs_fts_exact"):
        raise ValueError(f"unsupported fts_table: {fts_table!r}")
    # In exact mode we don't normalise Devanagari at index time, so we must
    # not normalise at query time either — same policy as the augmentations.
    unit_norm = (lambda s: s) if fts_table.endswith("_exact") else _normalize_devanagari

    if len(units) < 2:
        return {}, 0, 0

    scoped_units = [f'{{content}} : ({unit_norm(u)})' for u in units]

    # ── Step A: per-unit event-id sets, intersect → records with ALL units.
    # Exclude meta paragraphs (title row / sannyas-wiki marker) from the
    # match so a record that contains a unit ONLY in its metadata is not
    # treated as containing that word — otherwise it would inflate the
    # qualifying-discourse count while having no displayable hit. This
    # keeps `common` (and thus total_events) to records with the words in
    # real discourse text. The offsets query below deliberately does NOT
    # apply this filter — token offsets need every paragraph.
    common: Optional[set] = None
    for su in scoped_units:
        try:
            rows = conn.execute(
                f"""
                SELECT DISTINCT f.event_id
                FROM {fts_table} f
                LEFT JOIN events e ON e.id = f.event_id
                WHERE {fts_table} MATCH ?
                {_META_EXCLUDE_SQL}
                {where_extra}
                """,
                ([su] + filter_params),
            ).fetchall()
        except sqlite3.OperationalError:
            return {}, 0, 0
        ids = {r[0] for r in rows}
        common = ids if common is None else (common & ids)
        if not common:
            return {}, 0, 0

    common = set(common or set())
    if not common:
        return {}, 0, 0
    # The TRUE qualifying-discourse count is the full intersection size —
    # capture it before the cap so the "N discourses" header stays accurate
    # for broad queries (the cap only bounds how many we gather/rank/show,
    # not the reported total). Without this, a query matching >cap events
    # under-reported its discourse count.
    true_total_events = len(common)
    # Sanity cap (see _RECORD_LEVEL_EVENT_CAP). Deterministic order so the
    # cap is reproducible across runs/engines.
    if len(common) > _RECORD_LEVEL_EVENT_CAP:
        common = set(sorted(common)[:_RECORD_LEVEL_EVENT_CAP])

    placeholders = ",".join("?" * len(common))
    common_list = list(common)

    # ── Step B: gather matched paragraphs for the common events only.
    union_query = " OR ".join(f"({unit_norm(u)})" for u in units)
    gather_fts = f'{{content}} : ({union_query})'

    # The NEAR (Within-N) path needs the raw matched-paragraph map per event
    # to feed the proximity-window logic below, so it keeps the original
    # gather + Python meta-filter. The All-words path (near_dist is None)
    # never needs that intermediate map: its only outputs are, per event,
    # the matched-paragraph COUNT (= hit_count) and the ≤_max_hits lowest-
    # sequence paragraphs to display. Both are computed server-side in one
    # window-function query (matched_aw, built afterwards), avoiding pulling
    # up to 100k matched rows into Python only to count and sort them.
    matched: dict[str, dict[int, dict]] = {}
    if near_dist is not None:
        try:
            prows = conn.execute(
                f"""
                SELECT
                    f.rowid AS frid,
                    f.event_id,
                    f.sequence_number,
                    f.paragraph_id,
                    substr(f.content, 1, 200) AS cprefix,
                    p.role AS role
                FROM {fts_table} f
                LEFT JOIN events e ON e.id = f.event_id
                LEFT JOIN paragraphs p ON p.id = f.paragraph_id
                WHERE {fts_table} MATCH ?
                AND f.event_id IN ({placeholders})
                {where_extra}
                LIMIT 100000
                """,
                ([gather_fts] + common_list + filter_params),
            ).fetchall()
        except Exception:
            return {}, 0, 0

        # event_id -> { seq: {pid, role} }
        # Meta paragraphs (title row / sannyas-wiki marker) are dropped here
        # so they count toward neither hit_count nor total_hits nor the NEAR
        # window — an event matched ONLY via a meta paragraph correctly falls
        # out (its para_map becomes empty → skipped below).
        #
        # Full `f.content` is NOT fetched in this gather: it is needed only by
        # the meta check (which inspects only the START of the text, so a 200-
        # char prefix suffices) and by the ≤_max_hits paragraphs we actually
        # display (filled in by the post-pass below, alongside highlight()).
        # Fetching it for every gathered row was the dominant cost on broad
        # multi-word queries (LIMIT 100000 rows × full paragraph text).
        #
        # `highlight()` is likewise NOT computed here: it is ~10× the cost of
        # the bare MATCH and is needed only for the displayed paragraphs. We
        # fill both content and hl in via a small post-pass after the per-
        # event loop. (positions/token_count were also dropped — they were
        # never read downstream; NEAR uses per_unit_pos/offsets.)
        # If the gather hit the LIMIT it may be truncated — the rowid fast path
        # below would then see an incomplete matched set, so it's disabled.
        gather_truncated = len(prows) >= 100000
        matched_rids: list = []
        for r in prows:
            if _is_meta_paragraph(r['sequence_number'], r['cprefix']):
                continue
            matched.setdefault(r['event_id'], {})[r['sequence_number']] = {
                'pid': r['paragraph_id'],
                'role': r['role'],
            }
            matched_rids.append(r['frid'])

    # For NEAR we need per-unit, per-paragraph position info to assign
    # record-level token offsets. Run one scoped query per unit, restricted
    # to the common events, recording each unit's in-paragraph positions.
    # event_id -> unit_index -> { seq: positions }
    per_unit_pos: dict[str, dict[int, dict[int, list[int]]]] = {}
    if near_dist is not None:
        # Fast path (see _NEAR_ROWID_FASTPATH_MAX): when the union gather was
        # complete and small, get each unit's positions by re-running its MATCH
        # against just the already-matched rowids (a rowid seek), instead of
        # re-scanning that unit's full posting list. The row set is identical —
        # a paragraph in a common event that matches a unit is, by definition,
        # in the union gather — so per_unit_pos (and every downstream count) is
        # byte-for-byte the same as the full-scan path.
        use_rowid_fast = (
            not gather_truncated and 0 < len(matched_rids) <= _NEAR_ROWID_FASTPATH_MAX
        )
        for ui, su in enumerate(scoped_units):
            try:
                if use_rowid_fast:
                    urows = []
                    for i in range(0, len(matched_rids), 900):
                        chunk = matched_rids[i:i + 900]
                        rph = ",".join("?" * len(chunk))
                        urows.extend(conn.execute(
                            f"""
                            SELECT f.event_id, f.sequence_number,
                                   highlight({fts_table}, 0, '\x02', '\x03') AS hl,
                                   f.content
                            FROM {fts_table} f
                            WHERE f.rowid IN ({rph}) AND {fts_table} MATCH ?
                            """,
                            (chunk + [su]),
                        ).fetchall())
                else:
                    urows = conn.execute(
                        f"""
                        SELECT
                            f.event_id,
                            f.sequence_number,
                            highlight({fts_table}, 0, '\x02', '\x03') AS hl,
                            f.content
                        FROM {fts_table} f
                        LEFT JOIN events e ON e.id = f.event_id
                        WHERE {fts_table} MATCH ?
                        AND f.event_id IN ({placeholders})
                        {where_extra}
                        """,
                        ([su] + common_list + filter_params),
                    ).fetchall()
            except sqlite3.OperationalError:
                return {}, 0, 0
            for r in urows:
                if _is_meta_paragraph(r['sequence_number'], r['content']):
                    continue
                positions, _ = _hl_token_positions(r['hl'] or r['content'])
                if not positions:
                    continue
                (per_unit_pos
                    .setdefault(r['event_id'], {})
                    .setdefault(ui, {})[r['sequence_number']]) = positions

    # Record-level token offset for each paragraph = sum of the token counts
    # of all *earlier* paragraphs (by sequence_number) in the discourse. We
    # need counts for EVERY paragraph, not just matched ones, so the offsets
    # line up with the true position of a token in the whole talk. Fetch all
    # paragraphs of the common events in one query and prefix-sum per event.
    offsets: dict[str, dict[int, int]] = {}
    if near_dist is not None:
        allp = conn.execute(
            f"SELECT event_id, sequence_number, content FROM paragraphs"
            f" WHERE event_id IN ({placeholders}) ORDER BY event_id, sequence_number",
            common_list,
        ).fetchall()
        by_ev: dict[str, list[tuple[int, str]]] = {}
        for r in allp:
            by_ev.setdefault(r['event_id'], []).append(
                (r['sequence_number'], r['content'])
            )
        for ev_id, plist in by_ev.items():
            plist.sort(key=lambda t: t[0])
            running = 0
            seq_off: dict[int, int] = {}
            for seq, content in plist:
                seq_off[seq] = running
                running += _count_tokens(content)
            offsets[ev_id] = seq_off

    # Batch the per-event metadata lookup (was one SELECT per qualifying
    # event inside the loop below — thousands of round-trips on broad
    # results). One IN-query per 5000 ids → dict keyed by id, same columns
    # in the same order, so each loop iteration just does a dict lookup.
    ev_rows: dict = {}
    for i in range(0, len(common_list), 5000):
        chunk = common_list[i:i + 5000]
        ph = ",".join("?" * len(chunk))
        for row in conn.execute(
            "SELECT id, title, date, location, language, "
            f"translated_from, source_short FROM events WHERE id IN ({ph})",
            chunk,
        ).fetchall():
            ev_rows[row['id']] = row

    events: dict = {}
    total_hits = 0

    if near_dist is None:
        # ── All-words: do the per-event hit_count + ≤_max_hits display-row
        # selection entirely in SQL. The innermost subquery is exactly the
        # Step-B gather (same MATCH / IN / where_extra / LIMIT 100000, no
        # ORDER BY → identical first-100k rows, FTS5 deterministic); the
        # `NOT (sq = 0 OR ct LIKE 'event page in sannyas%')` filter then
        # drops the same meta rows _is_meta_paragraph did (verified byte-for-
        # byte identical on the prod corpus). `cnt` per event = count of
        # surviving rows = old len(para_map) = hit_count; `rn <= _max_hits`
        # picks the lowest-`sq` rows = old sorted(para_map.keys())[:_max_hits].
        # No full paragraph text leaves SQLite here — only a 200-char prefix
        # for the meta check (the marker is far shorter than 200 chars).
        meta_clause = "WHERE NOT (sq = 0 OR ct LIKE 'event page in sannyas%')"
        rn_clause = "" if _max_hits is None else "WHERE rn <= ?"
        aw_params = [gather_fts] + common_list + filter_params
        if _max_hits is not None:
            aw_params = aw_params + [_max_hits]
        try:
            aw_rows = conn.execute(
                f"""
                SELECT event_id, sq, pid, role, cnt FROM (
                  SELECT event_id, sq, pid, role,
                         ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY sq) AS rn,
                         COUNT(*)     OVER (PARTITION BY event_id)            AS cnt
                  FROM (
                    SELECT f.event_id AS event_id, f.sequence_number AS sq,
                           f.paragraph_id AS pid, p.role AS role,
                           substr(f.content, 1, 200) AS ct
                    FROM {fts_table} f
                    LEFT JOIN events e ON e.id = f.event_id
                    LEFT JOIN paragraphs p ON p.id = f.paragraph_id
                    WHERE {fts_table} MATCH ?
                    AND f.event_id IN ({placeholders})
                    {where_extra}
                    LIMIT 100000
                  ) {meta_clause}
                ) {rn_clause}
                """,
                aw_params,
            ).fetchall()
        except Exception:
            return {}, 0, 0

        # Group the (≤_max_hits) display rows per event, in `sq` order. The
        # window-function output is already deterministic, but we sort by
        # `sq` when emitting hits so the display order is identical to the
        # old sorted(display_seqs) regardless of row arrival order. `cnt`
        # (constant per event) is the hit_count and is added to total_hits
        # exactly once per event — the same accounting as the old loop.
        aw_by_ev: dict[str, dict] = {}
        for r in aw_rows:
            ev_id = r['event_id']
            bucket = aw_by_ev.get(ev_id)
            if bucket is None:
                bucket = {'cnt': r['cnt'], 'rows': []}
                aw_by_ev[ev_id] = bucket
            bucket['rows'].append(r)

        for ev_id, bucket in aw_by_ev.items():
            ev_row = ev_rows.get(ev_id)
            if not ev_row:
                continue
            hit_count = bucket['cnt']
            total_hits += hit_count
            hits = []
            for r in sorted(bucket['rows'], key=lambda r: r['sq']):
                hit: dict = {
                    'paragraph_id': r['pid'],
                    'sequence_number': r['sq'],
                }
                if r['role']:
                    hit['role'] = r['role']
                hits.append(hit)
            events[ev_id] = {
                'event_id': ev_id,
                'title': ev_row['title'],
                'date': ev_row['date'],
                'location': ev_row['location'],
                'language': ev_row['language'],
                'translated_from': ev_row['translated_from'],
                'source_short': ev_row['source_short'],
                'best_rank': 0.0,
                'hit_count': hit_count,
                'hits': hits,
                '_record_level': True,
            }

    for ev_id in (common if near_dist is not None else ()):
        para_map = matched.get(ev_id)
        if not para_map:
            continue

        # `display_seqs` selects which paragraphs to show + count as the
        # hit. For Within-N it is narrowed below to just the paragraphs
        # forming the proximity window, so a NEAR hit shows the actual
        # close-together passage — not every paragraph that happens to
        # contain one of the words (the 2026-05-31 bug where Within-N
        # reported All-words counts).
        display_seqs = sorted(para_map.keys())

        if near_dist is not None:
            # Build record-level positions per unit (paragraph offset +
            # in-paragraph position) plus a position→seq map, then find the
            # tightest window covering one position from each unit.
            unit_pos = per_unit_pos.get(ev_id, {})
            seq_off = offsets.get(ev_id, {})
            positions_per_unit: list[list[int]] = []
            pos_seq: dict[int, int] = {}
            ok = True
            for ui in range(len(units)):
                seq_positions = unit_pos.get(ui)
                if not seq_positions:
                    ok = False
                    break
                rec_positions: list[int] = []
                for seq, plist in seq_positions.items():
                    base = seq_off.get(seq)
                    if base is None:
                        # Stale FTS entry: paragraph was deleted from the
                        # paragraphs table but not from the FTS index.
                        # Defaulting to 0 would collapse all positions near
                        # zero and create false NEAR matches, so skip.
                        continue
                    for p in plist:
                        rp = base + p
                        rec_positions.append(rp)
                        pos_seq[rp] = seq
                if not rec_positions:
                    ok = False
                    break
                rec_positions.sort()
                positions_per_unit.append(rec_positions)
            if not ok:
                continue
            span, lo, hi = _min_token_window(positions_per_unit)
            if span > near_dist:
                continue
            # The hit is the passage spanning [lo, hi]: the paragraphs whose
            # matched positions fall inside the window.
            window_seqs = sorted({s for p, s in pos_seq.items() if lo <= p <= hi})
            # Only show paragraphs that the FTS gather query actually matched.
            # The `or window_seqs` fallback was including context paragraphs
            # (e.g. seq N+1 between two matched paragraphs) with no real hit.
            display_seqs = [s for s in window_seqs if s in para_map] or []

        ev_row = ev_rows.get(ev_id)
        if not ev_row:
            continue

        # Hit count for Within-N is 1 — the discourse has one proximity
        # passage. This is what makes the within-N total match OCTP (2 for
        # politicians/mafia, 5 for enlightenment/trust/love) instead of the
        # all-words paragraph count.
        hit_count = 1
        total_hits += hit_count

        # Display hits: up to _max_hits paragraphs from display_seqs, ordered
        # by sequence_number. (para_map is already meta-filtered at gather
        # time.) _max_hits=None means no cap (used by _near_hl_for_discourse
        # to illuminate the full window). Both `content` and `hl` are filled
        # in by the post-pass below — only for the paragraphs that survive
        # this cap — so we pay neither the content fetch nor highlight() for
        # paragraphs we never show.
        hits = []
        for seq in display_seqs:
            if _max_hits is not None and len(hits) >= _max_hits:
                break
            info = para_map.get(seq)
            if info is None:
                continue
            hit: dict = {
                'paragraph_id': info['pid'],
                'sequence_number': seq,
            }
            if info.get('role'):
                hit['role'] = info['role']
            hits.append(hit)

        events[ev_id] = {
            'event_id': ev_id,
            'title': ev_row['title'],
            'date': ev_row['date'],
            'location': ev_row['location'],
            'language': ev_row['language'],
            'translated_from': ev_row['translated_from'],
            'source_short': ev_row['source_short'],
            'best_rank': 0.0,
            'hit_count': hit_count,
            'hits': hits,
            '_record_level': True,
        }

    # ── Post-pass: fetch full content + highlight() for ONLY the paragraphs
    # we display. The gather above deliberately skips both (full content is
    # only needed for the ≤_max_hits displayed hits; highlight() is ~10× the
    # bare MATCH); here we run them for just the hits per event that survived
    # the cap. Same MATCH (`gather_fts`) the gather used, restricted to the
    # displayed paragraph ids, so the markers are identical to what the old
    # per-row highlight() produced and the content is the same paragraph text.
    display_pids = [h['paragraph_id'] for ev in events.values() for h in ev['hits']]
    content_map: dict[int, str] = {}
    hl_map: dict[int, str] = {}
    for i in range(0, len(display_pids), 5000):
        chunk = display_pids[i:i + 5000]
        ph = ",".join("?" * len(chunk))
        try:
            hrows = conn.execute(
                f"""
                SELECT
                    f.paragraph_id,
                    f.content,
                    highlight({fts_table}, 0, '\x02', '\x03') AS hl
                FROM {fts_table} f
                WHERE {fts_table} MATCH ?
                AND f.paragraph_id IN ({ph})
                """,
                ([gather_fts] + chunk),
            ).fetchall()
        except Exception:
            # Defensive: mirror the gather's broad except. On failure leave
            # the maps as-is so these hits fall back to empty content.
            continue
        for r in hrows:
            content_map[r['paragraph_id']] = _strip_shailendra(r['content'] or '')
            hl_map[r['paragraph_id']] = (
                _strip_shailendra(r['hl'] or '')
                .replace('\x02', '«')
                .replace('\x03', '»')
            )

    for ev in events.values():
        new_hits = []
        for h in ev['hits']:
            pid = h['paragraph_id']
            hl = hl_map.get(pid, '')
            content = content_map.get(pid, '')
            # When hl carries «» markers it is the same preview text as
            # content, just annotated; the frontend renders the preview from
            # hl in that case, so shipping content too would just double the
            # JSON payload. Keep content only as the rare no-marker fallback.
            if '«' in hl:
                content = ''
            # Rebuild with the historical key order: paragraph_id,
            # sequence_number, content, hl, (role).
            nh: dict = {
                'paragraph_id': pid,
                'sequence_number': h['sequence_number'],
                'content': content,
                'hl': hl,
            }
            if 'role' in h:
                nh['role'] = h['role']
            new_hits.append(nh)
        ev['hits'] = new_hits

    # total_events:
    #   All-words → the true intersection size (pre-cap), so a broad query's
    #     discourse count is accurate even when the gather/display is capped.
    #   Within-N → the number of discourses that actually passed the
    #     proximity window. (Using the intersection size here was the
    #     2026-05-31 bug that reported 951 for a within-20 query that truly
    #     matched only 5 discourses.)
    if near_dist is not None:
        return events, len(events), total_hits
    return events, true_total_events, total_hits


def _near_hl_for_discourse(
    conn: sqlite3.Connection,
    units: list[str],
    near_dist: int,
    ev_id: str,
    fts_table: str = "paragraphs_fts",
) -> dict[int, str]:
    """Return paragraph_id → «»-marked hl for only the paragraphs that form
    the NEAR proximity window in a single discourse.

    Called from the /api/discourse endpoint when the standard FTS5 NEAR MATCH
    finds no in-paragraph hits (cross-paragraph proximity case). Uses
    _record_level_search restricted to the single event so the window logic is
    shared with the search ranking path.
    """
    events, _, _ = _record_level_search(
        conn, units, near_dist,
        "AND e.id = ?", [ev_id],
        fts_table=fts_table,
        _max_hits=None,  # include ALL proximity-window paragraphs, not just first 3
    )
    ev = events.get(ev_id)
    if not ev:
        return {}
    result: dict[int, str] = {}
    for hit in ev.get("hits", []):
        hl = hit.get("hl", "")
        # Only return hl that actually contains «» markers — plain content
        # without markers (e.g. when FTS5 highlight can't resolve the match)
        # would suppress the frontend's regex fallback without adding value.
        if hl and '«' in hl:
            result[hit["paragraph_id"]] = hl
    return result


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


def _ensure_events_source_short_column(conn: sqlite3.Connection) -> None:
    """Idempotent migration for `events.source_short` — the short book
    title for translated records (Sugit's `@sourceShort=` Word header,
    Anuragi's wish to display the published volume on translation hits).
    Added 2026-05-26 alongside the locked-in @-field set."""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(events)").fetchall()}
    if "source_short" not in cols:
        conn.execute("ALTER TABLE events ADD COLUMN source_short TEXT")
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
            _ensure_events_source_short_column(conn)
            _ensure_corpus_meta(conn)
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
            "SELECT id, title, date, location, language, "
            "translated_from, source_short FROM events"
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
                "id":              r["id"],
                "title":           r["title"],
                "date":            r["date"],
                "location":        r["location"],
                "language":        r["language"],
                "translated_from": r["translated_from"],
                "source_short":    r["source_short"],
                "tags":            sorted(tags_map.get(r["id"], [])),
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
    sort: str = Query('rank', pattern='^(rank|title|date)$'),
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

    filters: list[str] = []
    filter_params: list = []

    if language and language.lower() not in ('all', '*', ''):
        # Accept either form the corpus might use: the full name
        # ("English", "Hindi" — what the ingester writes after _LANG_MAP)
        # or the bare ISO code ("en", "hi" — what a non-normalising
        # ingest can leave in events.language). Mixing the two used to
        # mean filtering by "English" returned zero rows when the DB
        # contained "en". See _LANGUAGE_ALIASES.
        # "all" and "*" mean no restriction — skip the filter entirely so
        # the frontend can always send language=all without breaking results.
        aliases = _expand_language_aliases(language)
        placeholders = ",".join(["LOWER(?)"] * len(aliases))
        filters.append(f"LOWER(e.language) IN ({placeholders})")
        filter_params.extend(aliases)
    if original:
        # Originals: either the column isn't present (legacy rows) or its
        # value is the explicit "none" Antar writes into the @-headers.
        filters.append(
            "(e.translated_from IS NULL OR LOWER(e.translated_from) = 'none')"
        )
    if date_from or date_to:
        # The year-range filter does an overlap test against the years
        # covered by the record's date string. Most records have a clean
        # ISO `YYYY-MM-DD[-slot]`, but archivist notes like `1971/1972 ?`
        # mean "this talk is from somewhere in 1971-1972, exact date
        # unknown" — Sugit asked for those to overlap correctly with any
        # year-range query, and any `?` to be ignored.
        #   first_year = leading 4 chars of e.date  (the "from" year of the record)
        #   last_year  = 4 chars after '/' if present, else first_year ("to" year)
        # SQLite's lexicographic comparison on YYYY strings is order-
        # preserving for valid years, and any garbage prefix (e.g. an
        # unparseable date) sorts strictly above any 4-digit year so it
        # falls out of every range — which matches the "ignore" intent.
        first_year_expr = "SUBSTR(e.date, 1, 4)"
        last_year_expr = (
            "(CASE WHEN INSTR(e.date, '/') > 0 "
            "      THEN SUBSTR(e.date, INSTR(e.date, '/') + 1, 4) "
            "      ELSE SUBSTR(e.date, 1, 4) END)"
        )
        if date_from:
            from_year = date_from[:4]
            # The record's *last* year must reach the filter's start.
            filters.append(f"{last_year_expr} >= ?")
            filter_params.append(from_year)
        if date_to:
            to_year = date_to[:4]
            # The record's *first* year must not exceed the filter's end.
            filters.append(f"{first_year_expr} <= ?")
            filter_params.append(to_year)

    where_extra = (" AND " + " AND ".join(filters)) if filters else ""

    near_parsed = _parse_near(fts_query)

    # Decide whether this query gets RECORD-LEVEL treatment (OCTP
    # semantics): a record matches when its units appear anywhere in the
    # whole discourse (All-words), optionally within N tokens (Within-N).
    # This activates ONLY for NEAR and for multi-unit All-words queries —
    # single-word, phrase, and explicit `title:` queries keep the existing
    # single-MATCH path so we minimise regression to the rest of the suite.
    #
    # All NEAR queries use record-level cross-paragraph proximity.
    # OCTP (Folio Views) finds words within N words across paragraph
    # boundaries — confirmed by Sugit 2026-06-12.
    if near_parsed:
        units_p, dist_p = near_parsed
        record_units = list(units_p)
        record_near_dist = dist_p
    else:
        parsed = _parse_query_units(q, exact=exact)
        record_units = parsed if (parsed and len(parsed) >= 2) else None
        record_near_dist = None


    with contextlib.closing(sqlite3.connect(DB_PATH)) as conn:
        conn.row_factory = sqlite3.Row

        if record_units is not None:
            try:
                events, total_events, total_hits = _record_level_search(
                    conn,
                    record_units,
                    record_near_dist,
                    where_extra,
                    filter_params,
                    fts_table=fts_table,
                )
            except Exception:
                events, total_events, total_hits = {}, 0, 0

            for ev in events.values():
                hit_bonus = math.log1p(ev.get("hit_count", 1))
                best = ev.get("best_rank", 0.0)
                # Record-level events have best_rank 0; rank them by
                # hit_count (more matched paragraphs → earlier) so the
                # display order is stable and meaningful.
                ev["rank"] = best - hit_bonus

            # Tie-break on event_id so the order — and therefore which
            # events survive the `[:limit]` slice when many share a rank —
            # is deterministic and identical to the TS engine (which sorts
            # the same way). Without this, Python set order vs JS Set order
            # could return different subsets for tied results past `limit`.
            out = sorted(
                events.values(), key=lambda e: (e["rank"], e["event_id"])
            )[:limit]
            if sort == 'title':
                out.sort(key=lambda e: ((e["title"] or "").lower(), e["event_id"]))
            elif sort == 'date':
                # Chronological, oldest first (Sugit #25a). Date strings are
                # YYYY / YYYY-MM-DD, which sort lexicographically by leading
                # year; undated records sort last via the "9999" sentinel.
                out.sort(key=lambda e: ((e["date"] or "9999"), e["event_id"]))
            for ev in out:
                ev.pop("best_rank", None)
                ev.pop("_record_level", None)

            too_many = total_events > _TOO_MANY_THRESHOLD
            if too_many:
                for ev in out:
                    if ev.get("hits"):
                        ev["hits"] = ev["hits"][:1]
                        for h in ev["hits"]:
                            h.pop("content", None)

            return {
                "query": q,
                "total": total_events,
                "total_hits": total_hits,
                "too_many": too_many,
                "events": out,
            }

        # ── Phrase / single-word / title: — the existing single-MATCH path.
        # For a single quoted phrase we scope the COUNT/display to the
        # content column so a phrase that happens to equal a discourse
        # TITLE doesn't inflate the hit count to one-per-paragraph (the
        # title is on every paragraph's FTS row). A separate title
        # membership check still RETURNS such a discourse (with a small
        # hit_count) so series can be found by their name (#3).
        is_phrase_only = bool(_PHRASE_ONLY_RE.match(fts_query))
        phrase_inner = None
        if is_phrase_only:
            phrase_inner = fts_query.strip()
            count_query = f'{{content}} : ({phrase_inner})'
        else:
            count_query = fts_query

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
                    e.translated_from AS translated_from,
                    e.source_short AS source_short,
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
                ([count_query] + filter_params + [limit * 10]),
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
                    "translated_from": r["translated_from"],
                    "source_short": r["source_short"],
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
                # When hl carries «» markers it is the same preview text as
                # content; the frontend renders from hl, so drop content to
                # avoid doubling the payload (mirrors the record-level path).
                hit_content = '' if '«' in hl else content
                hit: dict = {
                    "paragraph_id": r["paragraph_id"],
                    "sequence_number": r["sequence_number"],
                    "content": hit_content,
                    "hl": hl,
                }
                if r["role"]:
                    hit["role"] = r["role"]
                ev["hits"].append(hit)

        # The unlimited COUNT(*) over the content-scoped query stays
        # accurate even when the main SELECT was capped by LIMIT. Using
        # `count_query` (content-scoped for phrases) means a phrase that
        # equals a discourse TITLE no longer inflates the count to one hit
        # per paragraph — only the genuine content matches are counted (#3).
        try:
            count_row = conn.execute(
                f"""
                SELECT COUNT(DISTINCT f.event_id) AS ev_count, COUNT(*) AS hit_count
                FROM {fts_table} f
                LEFT JOIN events e ON e.id = f.event_id
                WHERE {fts_table} MATCH ?
                {where_extra}
                """,
                ([count_query] + filter_params),
            ).fetchone()
            total_events = count_row["ev_count"]
            total_hits = count_row["hit_count"]
        except sqlite3.OperationalError:
            total_events = len(events)
            total_hits = sum(e["hit_count"] for e in events.values())

        # #3 — title membership for a single quoted phrase. A phrase that
        # appears only in a discourse's TITLE (the Satyam Shivam series
        # case) must still be FOUND, but without counting one hit per
        # paragraph. We look the phrase up against the title_search column
        # and add any not-yet-present discourse with a hit_count of 1.
        if is_phrase_only and phrase_inner is not None:
            title_query = f'{{title_search}} : ({phrase_inner})'
            try:
                trows = conn.execute(
                    f"""
                    SELECT DISTINCT f.event_id, f.title,
                        e.date, e.location, e.language,
                        e.translated_from AS translated_from,
                        e.source_short AS source_short
                    FROM {fts_table} f
                    LEFT JOIN events e ON e.id = f.event_id
                    WHERE {fts_table} MATCH ?
                    {where_extra}
                    """,
                    ([title_query] + filter_params),
                ).fetchall()
            except sqlite3.OperationalError:
                trows = []
            for r in trows:
                ev_id = r["event_id"]
                if ev_id in events:
                    continue
                events[ev_id] = {
                    "event_id": ev_id,
                    "title": r["title"],
                    "date": r["date"],
                    "location": r["location"],
                    "language": r["language"],
                    "translated_from": r["translated_from"],
                    "source_short": r["source_short"],
                    "best_rank": 0.0,
                    "hit_count": 1,
                    "hits": [],
                }
                total_events += 1

    for ev in events.values():
        hit_bonus = math.log1p(ev.get("hit_count", 1))
        best = ev.get("best_rank", 0.0)
        ev["rank"] = best * max(hit_bonus, 1.0)

    out = sorted(events.values(), key=lambda e: e["rank"])[:limit]
    if sort == 'title':
        out.sort(key=lambda e: (e["title"] or "").lower())
    elif sort == 'date':
        out.sort(key=lambda e: (e["date"] or "9999"))

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
        # Match the year-range filter's first/last extraction so a "1971/1972 ?"
        # record contributes 1972 to MAX (not 1971). Otherwise the UI's max-year
        # slider would stop short of dates the records actually cover.
        row = conn.execute(
            "SELECT MIN(SUBSTR(date,1,4)),"
            " MAX(CASE WHEN INSTR(date, '/') > 0"
            "          THEN SUBSTR(date, INSTR(date, '/') + 1, 4)"
            "          ELSE SUBSTR(date, 1, 4) END)"
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
def discourse(
    title: str | None = None,
    event_id: str | None = None,
    q: str | None = None,
    exact: bool = False,
):
    if not title and not event_id:
        raise HTTPException(status_code=400, detail="Provide title or event_id")
    if not os.path.exists(DB_PATH):
        raise HTTPException(status_code=404, detail="Discourse store unavailable")

    fts_table = "paragraphs_fts_exact" if exact else "paragraphs_fts"
    fts_query = _rewrite_query(q, exact=exact) if q else None

    with contextlib.closing(sqlite3.connect(DB_PATH)) as conn:
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()

        if event_id:
            cur.execute(
                "SELECT id, title, date, location, language, "
                "translated_from, source_short FROM events WHERE id = ?",
                (event_id,),
            )
        else:
            cur.execute(
                "SELECT id, title, date, location, language, "
                "translated_from, source_short FROM events"
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
                    f"""
                    SELECT f.paragraph_id, highlight({fts_table}, 0, '\x02', '\x03') AS hl
                    FROM {fts_table} f
                    WHERE {fts_table} MATCH ?
                    AND f.event_id = ?
                    """,
                    (fts_query, ev["id"]),
                ).fetchall()
                for row in hl_rows:
                    raw_hl = row["hl"] or ''
                    # Only add hl when there are actual match markers — a row
                    # matched via title_search (not content) yields a content
                    # highlight with no \x02\x03 marks. Storing it would set
                    # p.hl on every paragraph in such a discourse, making every
                    # paragraph a nav stop even though none contains the word
                    # in its text (Bug @3, Sugit 2026-06-03).
                    if '\x02' not in raw_hl:
                        continue
                    hl_map[row["paragraph_id"]] = (
                        _strip_shailendra(raw_hl)
                        .replace('\x02', '«')
                        .replace('\x03', '»')
                    )
            except sqlite3.OperationalError:
                pass
            # For NEAR queries: if FTS5's in-paragraph NEAR match returned no
            # highlights (cross-paragraph proximity case), fall back to the
            # window-aware record-level search so only the proximate passage
            # is highlighted — not every occurrence of each word in the talk.
            if not hl_map:
                near_parsed = _parse_near(fts_query)
                if near_parsed:
                    near_units, near_dist = near_parsed
                    hl_map = _near_hl_for_discourse(
                        conn, near_units, near_dist, ev["id"], fts_table=fts_table,
                    )

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
            "translated_from": ev["translated_from"],
            "source_short": ev["source_short"],
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
            aliases = _expand_language_aliases(language)
            placeholders = ",".join(["LOWER(?)"] * len(aliases))
            where_parts.append(f"LOWER(e.language) IN ({placeholders})")
            params.extend(aliases)
        if tag and has_tags:
            where_parts.append("EXISTS (SELECT 1 FROM event_tags et WHERE et.event_id = e.id AND et.tag = ?)")
            params.append(tag)
        where = " AND ".join(where_parts)
        total = cur.execute(f"SELECT COUNT(*) FROM events e WHERE {where}", params).fetchone()[0]
        rows = cur.execute(
            f"SELECT e.id, e.title, e.date, e.location, e.language,"
            f" e.translated_from, e.source_short FROM events e WHERE {where}"
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
                "translated_from": r["translated_from"],
                "source_short": r["source_short"],
                "tags": sorted(tags_map.get(r["id"], [])),
            }
            for r in rows
        ]
    return {"events": events, "total": total, "page": page, "per_page": per_page}


@app.patch("/admin/events/{event_id}")
async def admin_update_event(event_id: str, request: Request, body: dict = Body(...)):
    _check_admin(request)
    allowed = {"title", "date", "location", "language",
               "translated_from", "source_short"}
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


@app.get("/api/version")
def api_version():
    """Public endpoint — returns the corpus data version date set by the last
    successful bulk ingest or batch-update, or null if never set."""
    if not os.path.exists(DB_PATH):
        return {"corpus_version": None}
    with contextlib.closing(sqlite3.connect(DB_PATH)) as conn:
        if not _table_exists(conn, "corpus_meta"):
            return {"corpus_version": None}
        version = _get_corpus_meta(conn, "corpus_version")
    return {"corpus_version": version}


def _find_update_root(tmpdir: str) -> Optional[str]:
    """Locate the directory containing Add/, Modify/, Delete/ subfolders.

    Checks the extracted root first, then one level deep (the WordDB YYYY-MM-DD/
    dated-folder convention Antar uses).
    """
    _UPDATE_DIRS = ("Add", "Modify", "Delete")
    if any(os.path.isdir(os.path.join(tmpdir, d)) for d in _UPDATE_DIRS):
        return tmpdir
    for entry in os.listdir(tmpdir):
        sub = os.path.join(tmpdir, entry)
        if os.path.isdir(sub) and any(
            os.path.isdir(os.path.join(sub, d)) for d in _UPDATE_DIRS
        ):
            return sub
    return None


# ─── Search-index rebuild (admin) ─────────────────────────────────────────────
#
# The FTS index is NOT fully maintained incrementally — ingest updates the
# stemmed table but not the exact one, and deletes leave stale rows — so after a
# batch of archival edits the index must be rebuilt to match the tables. This
# exposes that rebuild as a one-click admin action so an archivist never needs
# SSH. build_fts.rebuild_no_downtime() builds fresh tables alongside the live
# ones and swaps them in atomically, so search keeps serving throughout.

# One lock serialises every admin *write* — bulk ingest, batch-update, and the
# reindex. A rebuild reads all of `paragraphs`; an ingest mutating it mid-build
# would yield an inconsistent index, and two rebuilds must not overlap.
# Non-reentrant: the reindex acquires it in the request and hands the release
# to its background thread.
_ADMIN_WRITE_LOCK = threading.Lock()

# Progress/state for the background reindex, polled by GET /admin/reindex-status.
_reindex_status_lock = threading.Lock()
_reindex_status: dict = {
    "state": "idle",       # idle | running | done | error
    "done": 0,
    "total": 0,
    "started_at": None,
    "finished_at": None,
    "message": "",
}


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _require_admin_write_slot(request: Request):
    """FastAPI dependency for the ingest / batch-update endpoints: check admin
    auth, then refuse (409) if a reindex or another write holds the lock, and
    release it after the request. Stops a rebuild's atomic table-swap from
    racing a write to the same FTS tables."""
    _check_admin(request)
    if not _ADMIN_WRITE_LOCK.acquire(blocking=False):
        raise HTTPException(
            status_code=409,
            detail="A search-index rebuild (or another update) is in progress. "
                   "Please retry once it finishes.",
        )
    try:
        yield
    finally:
        _ADMIN_WRITE_LOCK.release()


def _run_reindex_bg():
    """Background worker: rebuild the FTS index with no downtime, updating
    `_reindex_status` as it goes, and release the admin-write lock when done."""
    try:
        import build_fts

        def _progress(done: int, total: int) -> None:
            with _reindex_status_lock:
                _reindex_status.update(done=done, total=total,
                                       message=f"Indexing {done:,}/{total:,}…")

        total = build_fts.rebuild_no_downtime(DB_PATH, progress=_progress)
        with _reindex_status_lock:
            _reindex_status.update(
                state="done", done=total, total=total, finished_at=_now_iso(),
                message=f"Rebuilt the search index — {total:,} paragraphs.")
    except Exception as ex:  # noqa: BLE001 — surface any failure to the UI
        with _reindex_status_lock:
            _reindex_status.update(state="error", finished_at=_now_iso(),
                                   message=f"Reindex failed: {ex}")
    finally:
        _ADMIN_WRITE_LOCK.release()


@app.post("/admin/reindex")
def admin_reindex(request: Request):
    """Kick off a no-downtime search-index rebuild in the background. Returns
    immediately; poll GET /admin/reindex-status for progress."""
    _check_admin(request)
    if not _ADMIN_WRITE_LOCK.acquire(blocking=False):
        raise HTTPException(status_code=409,
                            detail="A rebuild or update is already in progress.")
    try:
        with _reindex_status_lock:
            _reindex_status.update(state="running", done=0, total=0,
                                   started_at=_now_iso(), finished_at=None,
                                   message="Starting…")
        threading.Thread(target=_run_reindex_bg, name="fts-reindex", daemon=True).start()
    except BaseException:
        # Never leak the lock if we failed to hand it to the worker thread.
        _ADMIN_WRITE_LOCK.release()
        raise
    return {"ok": True, "state": "running"}


@app.get("/admin/reindex-status")
def admin_reindex_status(request: Request):
    """Current state of the background reindex (admin-gated, safe to poll)."""
    _check_admin(request)
    with _reindex_status_lock:
        return dict(_reindex_status)


@app.post("/admin/upload-docx")
async def admin_upload_docx(
    request: Request,
    file: UploadFile = File(...),
    dry_run: str = Form("false"),
    corpus_version: str = Form(""),
    skip_dirs: str = Form("Texts by Others"),
    _slot: None = Depends(_require_admin_write_slot),
):
    """Bulk-ingest a zip of .docx files (best-effort: failed files are skipped
    and reported; successful ones are committed unless dry_run=true).

    Used for the initial full corpus load or a complete re-sync. Mirrors
    ingest_docx.py's upsert-on-(title, language) semantics.
    """
    _check_admin(request)
    is_dry_run = dry_run.lower() == "true"
    skip_set = {d.strip().lower() for d in skip_dirs.split(",") if d.strip()}

    raw = await file.read()
    if len(raw) > 2 * 1024 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Zip too large (max 2 GB)")
    if raw[:4] != b"PK\x03\x04":
        raise HTTPException(status_code=400, detail="File is not a valid zip archive")

    try:
        import ingest_docx as _ingest
    except ImportError as exc:
        raise HTTPException(status_code=500, detail=f"ingest_docx module unavailable: {exc}")

    processed = 0
    failed = 0
    failures: list[dict] = []

    with tempfile.TemporaryDirectory() as tmpdir:
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as zf:
                zf.extractall(tmpdir)
        except zipfile.BadZipFile:
            raise HTTPException(status_code=400, detail="File is not a valid zip archive")

        docx_paths = []
        for dirpath, dirnames, filenames in os.walk(tmpdir):
            rel = os.path.relpath(dirpath, tmpdir)
            parts = rel.split(os.sep) if rel != "." else []
            if any(p.lower() in skip_set for p in parts):
                dirnames.clear()
                continue
            dirnames[:] = [d for d in dirnames if d.lower() not in skip_set]
            for fn in filenames:
                if fn.startswith("~$") or not fn.lower().endswith(".docx"):
                    continue
                docx_paths.append(os.path.join(dirpath, fn))

        if not docx_paths:
            raise HTTPException(status_code=400, detail="No .docx files found in zip")

        with contextlib.closing(sqlite3.connect(DB_PATH)) as conn:
            _ingest._ensure_translated_from_column(conn)
            _ingest._ensure_source_short_column(conn)
            _ingest._ensure_role_column(conn)

            for path in docx_paths:
                rel_path = os.path.relpath(path, tmpdir)
                try:
                    conn.execute("SAVEPOINT sp_file")
                    talk = _ingest.parse_docx(Path(path))
                    _ingest.upsert(conn, talk)
                    conn.execute("RELEASE SAVEPOINT sp_file")
                    processed += 1
                except Exception as ex:
                    conn.execute("ROLLBACK TO SAVEPOINT sp_file")
                    conn.execute("RELEASE SAVEPOINT sp_file")
                    failed += 1
                    if len(failures) < 50:
                        failures.append({"file": rel_path, "error": str(ex)})

            if is_dry_run:
                conn.rollback()
            else:
                conn.commit()

        saved_version: Optional[str] = None
        cv = corpus_version.strip()
        if cv and not is_dry_run and processed > 0:
            with contextlib.closing(sqlite3.connect(DB_PATH)) as conn:
                _ensure_corpus_meta(conn)
                _set_corpus_meta(conn, "corpus_version", cv)
            saved_version = cv

    return {
        "ok": True,
        "dry_run": is_dry_run,
        "processed": processed,
        "failed": failed,
        "corpus_version": saved_version,
        "failures": failures,
    }


@app.post("/admin/batch-update")
async def admin_batch_update(
    request: Request,
    file: UploadFile = File(...),
    dry_run: str = Form("false"),
    corpus_version: str = Form(""),
    _slot: None = Depends(_require_admin_write_slot),
):
    """Apply a structured Add/Modify/Delete update batch (all-or-nothing).

    The zip must contain Add/, Modify/, Delete/ subfolders — either at the
    top level or one level deep inside a dated folder like
    WordDB 2027-01-01/. Mirrors word_update.py's run_update() semantics.
    """
    _check_admin(request)
    is_dry_run = dry_run.lower() == "true"

    raw = await file.read()
    if len(raw) > 2 * 1024 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Zip too large (max 2 GB)")
    if raw[:4] != b"PK\x03\x04":
        raise HTTPException(status_code=400, detail="File is not a valid zip archive")

    try:
        from word_update import run_update, Action as UpdateAction
    except ImportError as exc:
        raise HTTPException(status_code=500, detail=f"word_update module unavailable: {exc}")

    with tempfile.TemporaryDirectory() as tmpdir:
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as zf:
                zf.extractall(tmpdir)
        except zipfile.BadZipFile:
            raise HTTPException(status_code=400, detail="File is not a valid zip archive")

        update_root = _find_update_root(tmpdir)
        if not update_root:
            raise HTTPException(
                status_code=400,
                detail="Zip must contain Add/, Modify/, or Delete/ subfolders",
            )

        import pathlib
        report = run_update(
            pathlib.Path(update_root),
            pathlib.Path(DB_PATH),
            dry_run=is_dry_run,
        )

    counts: dict[str, int] = {a.value: 0 for a in UpdateAction}
    failed = 0
    failures: list[dict] = []
    for r in report.results:
        if r.ok:
            counts[r.action.value] += 1
        else:
            failed += 1
            if len(failures) < 50:
                failures.append({
                    "action": r.action.value,
                    "file": r.path.name,
                    "error": r.error or "",
                })

    saved_version: Optional[str] = None
    cv = corpus_version.strip()
    if cv and not is_dry_run and failed == 0:
        with contextlib.closing(sqlite3.connect(DB_PATH)) as conn:
            _ensure_corpus_meta(conn)
            _set_corpus_meta(conn, "corpus_version", cv)
        saved_version = cv

    return {
        "ok": True,
        "dry_run": is_dry_run,
        "corpus_version": saved_version,
        "report": report.render(),
        "added": counts.get("Add", 0),
        "modified": counts.get("Modify", 0),
        "deleted": counts.get("Delete", 0),
        "failed": failed,
        "failures": failures,
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
