"""Build (or rebuild) the SQLite FTS5 search index.

Usage:
    python3 scripts/build_fts.py

Safe to re-run — drops and recreates the FTS table from scratch.
The FTS table shares the same data/osho.db database.

Tokenizer choice
----------------
* porter       – English stemming (meditation ↔ meditate ↔ meditating)
* unicode61    – Unicode-aware tokenisation, handles Devanagari correctly
* remove_diacritics 1 – strips only Latin-script combining marks (é → e).
  We deliberately do NOT use remove_diacritics 2 which would also strip
  Devanagari matras (ा ि ी …) — that causes unrelated Hindi words to
  collapse to the same token.

Devanagari normalisation
------------------------
Before indexing we normalise Devanagari text so that the two common
conventions for writing nasal sounds are treated as identical:
  explicit nasal consonant + virama   →   anusvara (ं)
Examples: अनन्त → अनंत, सन्न्यास → संन्यास, मन्त्र → मंत्र

The same normalisation is applied at query time in cloud_api.py so
that searching for either spelling variant finds all occurrences.
"""
import os
import re
import sqlite3
import time
import unicodedata

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(BASE_DIR, 'data/osho.db')

# ─── Devanagari normalisation ────────────────────────────────────────────────
#
# Convert "nasal consonant + virama" to anusvara (ं, U+0902) when the nasal
# belongs to the same phonological class as the following consonant.
# This collapses common spelling variants without affecting conjuncts where
# the nasal is genuinely from a different class (e.g. न्य in न्याय stays).
#
# Unicode ranges used (Devanagari block):
#   Velar    consonants: क-ङ  (U+0915–U+0919)
#   Palatal  consonants: च-ञ  (U+091A–U+091E)
#   Retroflex consonants: ट-ण (U+091F–U+0923)
#   Dental   consonants: त-न  (U+0924–U+0928)
#   Labial   consonants: प-म  (U+092A–U+092E)
#   Virama (halant):     ्   (U+094D)
#   Anusvara:            ं   (U+0902)

_NASAL_RULES = [
    # (nasal_codepoint, consonant_range_start, consonant_range_end)
    ('ङ', 'क', 'ङ'),  # ङ before क-ङ (velar)
    ('ञ', 'च', 'ञ'),  # ञ before च-ञ (palatal)
    ('ण', 'ट', 'ण'),  # ण before ट-ण (retroflex)
    ('न', 'त', 'न'),  # न before त-न (dental)
    ('म', 'प', 'म'),  # म before प-म (labial)
]

_VIRAMA = '्'
_ANUSVARA = 'ं'

# Build compiled patterns once
_NASAL_PATTERNS = [
    re.compile(
        re.escape(nasal + _VIRAMA) + r'(?=[' + re.escape(lo) + '-' + re.escape(hi) + '])'
    )
    for nasal, lo, hi in _NASAL_RULES
]


def normalize_devanagari(text: str) -> str:
    """Normalise Devanagari text to canonical anusvara form.

    Converts nasal-consonant+virama sequences to anusvara (ं) where the
    nasal belongs to the same phonological class as the following consonant.
    Non-Devanagari text is returned unchanged.
    """
    if not text:
        return text
    text = unicodedata.normalize('NFC', text)
    for pat in _NASAL_PATTERNS:
        text = pat.sub(_ANUSVARA, text)
    return text


# ─── Index builder ────────────────────────────────────────────────────────────

def build():
    t0 = time.perf_counter()
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    print("Dropping existing FTS table (if any)…", flush=True)
    cur.execute("DROP TABLE IF EXISTS paragraphs_fts")
    conn.commit()

    print("Creating paragraphs_fts (porter + unicode61, remove_diacritics 1)…", flush=True)
    cur.execute(
        """
        CREATE VIRTUAL TABLE paragraphs_fts USING fts5(
            content,
            title       UNINDEXED,
            event_id    UNINDEXED,
            paragraph_id UNINDEXED,
            sequence_number UNINDEXED,
            title_search,
            tokenize = 'porter unicode61 remove_diacritics 1'
        )
        """
    )
    conn.commit()

    (total,) = cur.execute("SELECT COUNT(*) FROM paragraphs").fetchone()
    print(f"Indexing {total:,} paragraphs…", flush=True)

    batch_size = 10_000
    inserted = 0
    offset = 0
    while True:
        rows = cur.execute(
            """
            SELECT p.id, p.event_id, p.sequence_number, p.content, e.title
            FROM paragraphs p
            LEFT JOIN events e ON e.id = p.event_id
            ORDER BY p.id
            LIMIT ? OFFSET ?
            """,
            (batch_size, offset),
        ).fetchall()
        if not rows:
            break

        # Normalise Devanagari in both content and title before indexing so
        # that अनन्त and अनंत (etc.) produce the same FTS tokens.
        normalised = []
        for r in rows:
            content = normalize_devanagari(r[3] or '')
            title   = normalize_devanagari(r[4] or '')
            normalised.append((content, title, r[1], r[0], r[2], title))

        cur.executemany(
            """
            INSERT INTO paragraphs_fts
                (content, title, event_id, paragraph_id, sequence_number, title_search)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            normalised,
        )
        conn.commit()

        inserted += len(rows)
        offset += batch_size
        pct = (inserted / total) * 100 if total else 100
        print(f"  {inserted:,}/{total:,} ({pct:.1f}%)", flush=True)

    print("Optimising FTS index…", flush=True)
    cur.execute("INSERT INTO paragraphs_fts(paragraphs_fts) VALUES('optimize')")
    conn.commit()
    conn.close()
    print(f"Done in {time.perf_counter() - t0:.1f}s", flush=True)


if __name__ == '__main__':
    build()
