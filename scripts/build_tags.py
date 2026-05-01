"""
Build supplementary index tables and fill inferred metadata.

Creates:
  event_tags  — topic keyword tags per talk (from FTS content)

Also fills NULL location / date in the events table using two passes:
  1. Series-level: propagate known values across talks in the same series
  2. Era-level:    use date→location mapping for whole-series blanks
  3. Hard-coded:   known series metadata for series with zero data

Safe to re-run — event_tags is dropped and rebuilt; events rows are
only UPDATEd where the field is currently NULL (never overwrites real data).

Usage:
    python3 scripts/build_tags.py
"""
import os
import re
import sqlite3
import time
from collections import Counter

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH  = os.path.join(BASE_DIR, 'data/osho.db')

# ─── Topic tags ───────────────────────────────────────────────────────────────
# 40 meaningful tags drawn from Osho's core teachings.
# Each value is a valid FTS5 query expression.

TOPIC_TAGS: dict[str, str] = {
    # Spiritual core
    'meditation':     'meditation',
    'love':           'love',
    'death':          'death',
    'god':            'god',
    'freedom':        'freedom',
    'awareness':      'awareness OR witnessing',
    'silence':        'silence',
    'truth':          'truth',
    'bliss':          'bliss OR ecstasy',
    'ego':            'ego',
    'mind':           'mind',
    'surrender':      'surrender',
    'devotion':       'devotion',
    'creativity':     'creativity',
    'prayer':         'prayer',
    'disciple':       'disciple OR seeker',
    'courage':        'courage',
    'laughter':       'laughter OR humor',
    'anger':          'anger',
    'fear':           'fear',
    'loneliness':     'loneliness OR aloneness',
    'dreams':         'dream',
    'energy':         'energy',
    'breath':         'breathing',
    'body':           'body',
    'nature':         'nature',
    'beauty':         'beauty',
    'transformation': 'transformation',
    'enlightenment':  'enlightenment',
    'compassion':     'compassion',
    'trust':          'trust',
    # Society / outer world
    'society':        'society',
    'religion':       'religion',
    'education':      'education',
    'politics':       'politics OR political',
    'women':          'woman OR women',
    'children':       'child OR children',
    'science':        'science OR scientific',
    'art':            'art OR artistic',
    'relationship':   'relationship OR intimacy',
}

# ─── Known series → location ──────────────────────────────────────────────────
# Used ONLY for entire series where NO talk has a location at all.
# Keys are lowercase series name prefixes (matched with str.startswith).

SERIES_LOC: list[tuple[str, str]] = [
    # Early camps & all-India period
    ('meditation: the art',       'Mount Abu, Rajasthan, India'),
    ('the new alchemy',           'Bombay, Maharashtra, India'),
    # Bombay era (1969–1973)
    ('vigyan bhairav tantra',     'Bombay, Maharashtra, India'),
    ('the book of secrets',       'Bombay, Maharashtra, India'),
    ('vedanta: seven steps',      'Bombay, Maharashtra, India'),
    ('the supreme doctrine',      'Bombay, Maharashtra, India'),
    ('the ultimate alchemy',      'Bombay, Maharashtra, India'),
    ('in search of the miraculous','Bombay, Maharashtra, India'),
    ('the eternal quest',         'Bombay, Maharashtra, India'),
    ('divine melody',             'Bombay, Maharashtra, India'),
    ('the path is the goal',      'Bombay, Maharashtra, India'),
    # Poona I (1974–1981) — most series from this era
    ('yoga: the alpha',           'Pune, Maharashtra, India'),
    ('yoga: the mystery',         'Pune, Maharashtra, India'),
    ('come follow me',            'Pune, Maharashtra, India'),
    ('the mustard seed',          'Pune, Maharashtra, India'),
    ('the heart sutra',           'Pune, Maharashtra, India'),
    ('the diamond sutra',         'Pune, Maharashtra, India'),
    ('dhammapada',                'Pune, Maharashtra, India'),
    ('unio mystica',              'Pune, Maharashtra, India'),
    ('the perfect master',        'Pune, Maharashtra, India'),
    ('until you die',             'Pune, Maharashtra, India'),
    ('just like that',            'Pune, Maharashtra, India'),
    ('the beloved',               'Pune, Maharashtra, India'),
    ('the hidden harmony',        'Pune, Maharashtra, India'),
    ('the true sage',             'Pune, Maharashtra, India'),
    ('the grass grows by itself', 'Pune, Maharashtra, India'),
    ('dang dang doko dang',       'Pune, Maharashtra, India'),
    ('no water no moon',          'Pune, Maharashtra, India'),
    ('the white lotus',           'Pune, Maharashtra, India'),
    ('hsin hsin ming',            'Pune, Maharashtra, India'),
    ('returning to the source',   'Pune, Maharashtra, India'),
    ('tao: the three treasures',  'Pune, Maharashtra, India'),
    ('the empty boat',            'Pune, Maharashtra, India'),
    ('when the shoe fits',        'Pune, Maharashtra, India'),
    ('ashtavakra',                'Pune, Maharashtra, India'),
    ('mahageeta',                 'Pune, Maharashtra, India'),
    ('ecstasy: the forgotten',    'Pune, Maharashtra, India'),
    ('nowhere to go but in',      'Pune, Maharashtra, India'),
    ('take it easy',              'Pune, Maharashtra, India'),
    ('the book of wisdom',        'Pune, Maharashtra, India'),
    ('flash of lightning',        'Pune, Maharashtra, India'),
    ('i say unto you',            'Pune, Maharashtra, India'),
    ('a sudden clash of thunder', 'Pune, Maharashtra, India'),
    ('and the flowers showered',  'Pune, Maharashtra, India'),
    ('the further shore',         'Pune, Maharashtra, India'),
    ('sandokai',                  'Pune, Maharashtra, India'),
    ('neither this nor that',     'Pune, Maharashtra, India'),
    ('this very body the buddha', 'Pune, Maharashtra, India'),
    # Oregon era (1981–1985)
    ('the rajneesh bible',        'Rajneeshpuram, Oregon, USA'),
    ('from death to deathlessness','Rajneeshpuram, Oregon, USA'),
    ('from unconsciousness to consciousness','Rajneeshpuram, Oregon, USA'),
    ('from darkness to light',    'Rajneeshpuram, Oregon, USA'),
    ('the goose is out',          'Rajneeshpuram, Oregon, USA'),
    ('the transmigration of souls','Rajneeshpuram, Oregon, USA'),
    ('come, come, yet again come','Rajneeshpuram, Oregon, USA'),
    # World Tour (1985–1986)
    ('the path of the mystic',    'Montevideo, Uruguay'),
    ('beyond psychology',         'Crete, Greece'),
    ('the invitation',            'Pune, Maharashtra, India'),
    # Poona II (1987–1990)
    ('the osho upanishad',        'Pune, Maharashtra, India'),
    ('om shantih shantih shantih','Pune, Maharashtra, India'),
    ('hari om tat sat',           'Pune, Maharashtra, India'),
    ('sat chit anand',            'Pune, Maharashtra, India'),
    ('the new dawn',              'Pune, Maharashtra, India'),
    ('the hidden splendor',       'Pune, Maharashtra, India'),
    ('the transmission of the lamp','Pune, Maharashtra, India'),
    ('beyond enlightenment',      'Pune, Maharashtra, India'),
    ('the razor\'s edge',         'Pune, Maharashtra, India'),
    ('the rebellious spirit',     'Pune, Maharashtra, India'),
    ('light on the path',         'Pune, Maharashtra, India'),
    ('the sword and the lotus',   'Pune, Maharashtra, India'),
    ('the language of existence', 'Pune, Maharashtra, India'),
    ('walking in zen, sitting in zen','Pune, Maharashtra, India'),
    ('rinzai: master of the irrational','Pune, Maharashtra, India'),
    ('nansen: the point of departure','Pune, Maharashtra, India'),
    ('communism and zen fire',    'Pune, Maharashtra, India'),
    ('ma tzu: the empty mirror',  'Pune, Maharashtra, India'),
    ('zen: zest, zip, zap and zing','Pune, Maharashtra, India'),
    ('zen: the mystery and the poetry','Pune, Maharashtra, India'),
    ('the miracle',               'Pune, Maharashtra, India'),
    ('theologia mystica',         'Pune, Maharashtra, India'),
    ('ah, this!',                 'Pune, Maharashtra, India'),
    ('the fish in the sea',       'Pune, Maharashtra, India'),
    ('the secret of secrets',     'Pune, Maharashtra, India'),
    ('the ultimate alchemy ii',   'Pune, Maharashtra, India'),
    ('philosophia ultima',        'Pune, Maharashtra, India'),
    ('one seed makes the whole',  'Pune, Maharashtra, India'),
    ('the wild geese',            'Pune, Maharashtra, India'),
    ('no mind: the flowers',      'Pune, Maharashtra, India'),
    ('om mani padme hum',         'Pune, Maharashtra, India'),
]

# ─── Era → location fallback ──────────────────────────────────────────────────
# When a talk has a date but no location and its series has no location,
# use the era to guess the city.

def _era_location(year: int | None) -> str | None:
    if not year:
        return None
    if year < 1969:
        return 'India'   # early camps — location varies
    if year < 1974:
        return 'Bombay, Maharashtra, India'
    if year < 1981:
        return 'Pune, Maharashtra, India'
    if year < 1986:
        return 'Rajneeshpuram, Oregon, USA'
    if year < 1987:
        return 'World Tour'
    return 'Pune, Maharashtra, India'


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _series(title: str | None) -> str:
    if not title:
        return ''
    i = title.find(' ~ ')
    return title[:i].strip() if i >= 0 else title.strip()


def _year(date_str: str | None) -> int | None:
    if not date_str:
        return None
    m = re.match(r'(\d{4})', date_str)
    return int(m.group(1)) if m else None


# ─── Main ─────────────────────────────────────────────────────────────────────

def build():
    t0 = time.perf_counter()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur  = conn.cursor()

    # ── 1. Infer missing locations ────────────────────────────────────────────

    print("Pass 1: inferring missing locations…", flush=True)

    all_events = cur.execute(
        "SELECT id, title, date, location FROM events"
    ).fetchall()

    # Build series → majority location map from existing data
    series_loc_votes: dict[str, Counter] = {}
    for e in all_events:
        s = _series(e['title'])
        if s and e['location']:
            series_loc_votes.setdefault(s, Counter())[e['location']] += 1

    series_best_loc: dict[str, str] = {
        s: c.most_common(1)[0][0]
        for s, c in series_loc_votes.items()
    }

    # Build series → approximate year map (for era fallback)
    series_years: dict[str, list[int]] = {}
    for e in all_events:
        y = _year(e['date'])
        s = _series(e['title'])
        if s and y:
            series_years.setdefault(s, []).append(y)

    loc_filled = 0
    for e in all_events:
        if e['location']:
            continue
        s      = _series(e['title'])
        new_loc: str | None = None

        # Priority 1: series majority from actual data
        if s in series_best_loc:
            new_loc = series_best_loc[s]

        # Priority 2: hard-coded series lookup
        if not new_loc:
            s_lo = s.lower()
            for prefix, loc in SERIES_LOC:
                if s_lo.startswith(prefix):
                    new_loc = loc
                    break

        # Priority 3: era-based fallback using the talk's own date
        if not new_loc:
            new_loc = _era_location(_year(e['date']))

        # Priority 4: era-based using the series median year
        if not new_loc and s in series_years:
            median_y = sorted(series_years[s])[len(series_years[s]) // 2]
            new_loc = _era_location(median_y)

        if new_loc:
            cur.execute(
                "UPDATE events SET location = ? WHERE id = ? AND location IS NULL",
                (new_loc, e['id']),
            )
            loc_filled += 1

    conn.commit()
    print(f"  Filled {loc_filled:,} missing locations", flush=True)

    # ── 2. Infer missing dates ────────────────────────────────────────────────

    print("Pass 2: inferring missing dates…", flush=True)

    # Re-read after location update
    all_events = cur.execute(
        "SELECT id, title, date FROM events"
    ).fetchall()

    series_year_ranges: dict[str, tuple[int, int]] = {}
    for e in all_events:
        s = _series(e['title'])
        y = _year(e['date'])
        if s and y:
            lo, hi = series_year_ranges.get(s, (y, y))
            series_year_ranges[s] = (min(lo, y), max(hi, y))

    date_filled = 0
    for e in all_events:
        if e['date']:
            continue
        s = _series(e['title'])
        if s not in series_year_ranges:
            continue
        # Use the first year in the series as best approximation
        approx_year = series_year_ranges[s][0]
        cur.execute(
            "UPDATE events SET date = ? WHERE id = ? AND date IS NULL",
            (f"{approx_year}-01-01", e['id']),
        )
        date_filled += 1

    conn.commit()
    print(f"  Filled {date_filled:,} missing dates", flush=True)

    # ── 3. Build topic tags ───────────────────────────────────────────────────

    print("Pass 3: building event_tags table…", flush=True)
    cur.execute("DROP TABLE IF EXISTS event_tags")
    cur.execute("""
        CREATE TABLE event_tags (
            event_id TEXT NOT NULL,
            tag      TEXT NOT NULL,
            PRIMARY KEY (event_id, tag)
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_event_tags_tag ON event_tags(tag)")
    conn.commit()

    # Check if FTS is available
    has_fts = cur.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='paragraphs_fts'"
    ).fetchone()

    if not has_fts:
        print("  WARNING: paragraphs_fts missing — run build_fts.py first. "
              "Falling back to LIKE-based tagging (slower).", flush=True)

    total_tag_rows = 0
    for tag, fts_query in TOPIC_TAGS.items():
        if has_fts:
            try:
                rows = cur.execute(
                    "SELECT DISTINCT event_id FROM paragraphs_fts WHERE paragraphs_fts MATCH ?",
                    (fts_query,),
                ).fetchall()
            except sqlite3.OperationalError as ex:
                print(f"  SKIP {tag}: {ex}", flush=True)
                rows = []
        else:
            # Fallback: search raw paragraphs table with LIKE
            first_term = fts_query.split()[0].strip('"')
            rows = cur.execute(
                "SELECT DISTINCT event_id FROM paragraphs WHERE content LIKE ?",
                (f"%{first_term}%",),
            ).fetchall()

        if rows:
            cur.executemany(
                "INSERT OR IGNORE INTO event_tags (event_id, tag) VALUES (?, ?)",
                [(r[0], tag) for r in rows],
            )
            total_tag_rows += len(rows)
        print(f"  {tag:20s} → {len(rows):5,} events", flush=True)

    conn.commit()
    print(f"\n  Total tag rows: {total_tag_rows:,}", flush=True)

    # ── 4. Summary ────────────────────────────────────────────────────────────

    null_loc  = cur.execute("SELECT COUNT(*) FROM events WHERE location IS NULL").fetchone()[0]
    null_date = cur.execute("SELECT COUNT(*) FROM events WHERE date IS NULL").fetchone()[0]
    total     = cur.execute("SELECT COUNT(*) FROM events").fetchone()[0]

    conn.close()
    print(f"\nDone in {time.perf_counter() - t0:.1f}s", flush=True)
    print(f"  Events total:            {total:,}", flush=True)
    print(f"  Still missing location:  {null_loc:,} ({100*null_loc/total:.1f}%)", flush=True)
    print(f"  Still missing date:      {null_date:,} ({100*null_date/total:.1f}%)", flush=True)


if __name__ == '__main__':
    build()
