"""One-time: build a SQLite FTS5 virtual table over paragraph content so Ask
can do phrase / NEAR / OR / prefix / title-scoped keyword search with BM25
ranking, entirely in-process, without any AI.

Usage:
    python3 scripts/build_fts.py

The FTS table lives inside the same data/osho.db — no extra files.
Safe to re-run; rebuilds from scratch.
"""
import os
import sqlite3
import time

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(BASE_DIR, 'data/osho.db')


def build():
    t0 = time.perf_counter()
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    print("Dropping existing FTS table (if any)...", flush=True)
    cur.execute("DROP TABLE IF EXISTS paragraphs_fts")
    conn.commit()

    print(
        "Creating paragraphs_fts (porter+unicode61, diacritics=1)...",
        flush=True,
    )
    cur.execute(
        """
        CREATE VIRTUAL TABLE paragraphs_fts USING fts5(
            content,
            title UNINDEXED,
            event_id UNINDEXED,
            paragraph_id UNINDEXED,
            sequence_number UNINDEXED,
            title_search,
            tokenize = 'porter unicode61 remove_diacritics 1'
        )
        """
    )
    conn.commit()

    (total,) = cur.execute("SELECT COUNT(*) FROM paragraphs").fetchone()
    print(f"Indexing {total:,} paragraphs...", flush=True)

    batch_size = 10000
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

        # Two title columns: one UNINDEXED for display, one indexed under the
        # column name `title_search` so users can write `title_search:vigyan`.
        # We expose this to the user-facing DSL as `title:` via a simple rewrite.
        cur.executemany(
            """
            INSERT INTO paragraphs_fts
                (content, title, event_id, paragraph_id, sequence_number, title_search)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            [(r[3], r[4] or '', r[1], r[0], r[2], r[4] or '') for r in rows],
        )
        conn.commit()

        inserted += len(rows)
        offset += batch_size
        pct = (inserted / total) * 100 if total else 100
        print(f"  {inserted:,}/{total:,} ({pct:.1f}%)", flush=True)

    print("Optimizing FTS index...", flush=True)
    cur.execute("INSERT INTO paragraphs_fts(paragraphs_fts) VALUES('optimize')")
    conn.commit()
    conn.close()
    print(f"Done in {time.perf_counter() - t0:.1f}s", flush=True)


if __name__ == '__main__':
    build()
