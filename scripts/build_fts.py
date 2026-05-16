"""Build (or rebuild) the SQLite FTS5 search index.

Usage:
    python3 scripts/build_fts.py

Safe to re-run — drops and recreates the FTS table from scratch.
The FTS table shares the same data/osho.db database.

Tokenizer choice
----------------
* porter       – English stemming (meditation ↔ meditate ↔ meditating)
* unicode61    – Unicode-aware tokenisation
* remove_diacritics 1 – strips only Latin-script combining marks (é → e).
  We deliberately do NOT use remove_diacritics 2 which would also strip
  Devanagari matras (ा ि ी …) — that causes unrelated Hindi words to
  collapse to the same token.
* categories 'L* N* Co Mn Mc' – CRITICAL for Devanagari. Without this,
  unicode61 defaults to 'L* N* Co' which treats combining marks (Mn, Mc)
  as token separators. That silently splits every Hindi word at every
  matra and virama: धर्म → "धर"+"म", विश्वास → "व"+"श"+"व"+"स",
  धन्य → "धन"+"य". The result was both false positives (a query for
  "धन" matching "धन्य", "धना", etc.) and false negatives (NEAR queries
  failing because position math broke after the splits). Adding Mn
  (nonspacing marks: virama, anusvara, nukta) and Mc (spacing combining
  marks: vowel matras, visarga) keeps Devanagari words whole. Danda (।)
  remains a separator (category Po), as expected.

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

    print("Dropping existing FTS tables (if any)…", flush=True)
    cur.execute("DROP TABLE IF EXISTS paragraphs_fts")
    cur.execute("DROP TABLE IF EXISTS paragraphs_fts_exact")
    conn.commit()

    # Two parallel FTS5 tables side by side:
    #
    #   paragraphs_fts        — porter stemming (English) + Devanagari
    #                           normalisation at index time. Default search.
    #                           "teach" matches teacher / teaching / teaches;
    #                           अनन्त matches अनंत.
    #   paragraphs_fts_exact  — no porter, no normalisation. Used when the
    #                           UI sends `exact=true` so reviewers can find
    #                           a specific spelling literally, the way OCTP
    #                           and the CD-ROM do.
    #
    # Doubles disk usage but the row data is shared and FTS5's term index
    # is compact, so the increase is modest (~30%) and the alternative —
    # querying-time post-filtering — would be much slower and uglier.
    print("Creating paragraphs_fts (porter + unicode61, Mn+Mc)…", flush=True)
    cur.execute(
        """
        CREATE VIRTUAL TABLE paragraphs_fts USING fts5(
            content,
            title       UNINDEXED,
            event_id    UNINDEXED,
            paragraph_id UNINDEXED,
            sequence_number UNINDEXED,
            title_search,
            tokenize = "porter unicode61 remove_diacritics 1 categories 'L* N* Co Mn Mc'"
        )
        """
    )
    print("Creating paragraphs_fts_exact (no porter, no normalisation)…", flush=True)
    cur.execute(
        """
        CREATE VIRTUAL TABLE paragraphs_fts_exact USING fts5(
            content,
            title       UNINDEXED,
            event_id    UNINDEXED,
            paragraph_id UNINDEXED,
            sequence_number UNINDEXED,
            title_search,
            tokenize = "unicode61 remove_diacritics 1 categories 'L* N* Co Mn Mc'"
        )
        """
    )
    conn.commit()

    (total,) = cur.execute("SELECT COUNT(*) FROM paragraphs").fetchone()
    print(f"Indexing {total:,} paragraphs into both tables…", flush=True)

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

        # paragraphs_fts gets Devanagari-normalised text so anusvara and
        # nasal-virama variants collapse into one token at index time.
        # paragraphs_fts_exact gets the *original* text so the reviewer
        # can find the exact spelling they typed.
        normalised: list[tuple] = []
        exact: list[tuple] = []
        for r in rows:
            content_raw = r[3] or ''
            title_raw = r[4] or ''
            content_norm = normalize_devanagari(content_raw)
            title_norm = normalize_devanagari(title_raw)
            normalised.append(
                (content_norm, title_norm, r[1], r[0], r[2], title_norm)
            )
            exact.append(
                (content_raw, title_raw, r[1], r[0], r[2], title_raw)
            )

        cur.executemany(
            """
            INSERT INTO paragraphs_fts
                (content, title, event_id, paragraph_id, sequence_number, title_search)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            normalised,
        )
        cur.executemany(
            """
            INSERT INTO paragraphs_fts_exact
                (content, title, event_id, paragraph_id, sequence_number, title_search)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            exact,
        )
        conn.commit()

        inserted += len(rows)
        offset += batch_size
        pct = (inserted / total) * 100 if total else 100
        print(f"  {inserted:,}/{total:,} ({pct:.1f}%)", flush=True)

    print("Optimising FTS indices…", flush=True)
    cur.execute("INSERT INTO paragraphs_fts(paragraphs_fts) VALUES('optimize')")
    cur.execute("INSERT INTO paragraphs_fts_exact(paragraphs_fts_exact) VALUES('optimize')")
    conn.commit()
    conn.close()
    print(f"Done in {time.perf_counter() - t0:.1f}s", flush=True)


if __name__ == '__main__':
    build()
