"""One-time migration: remove 'source: Shailendra's Hindi collection'
from paragraph content.

Usage:
    python scripts/clean_shailendra.py [--db data/osho.db] [--dry-run]

This modifies paragraph content in-place and rebuilds FTS rows for affected paragraphs.
Always back up the database before running.
"""

import argparse
import os
import re
import sqlite3
import sys

SHAILENDRA_RE = re.compile(
    r'\s*source\s*:\s*Shailendra.s\s+Hindi\s+collection\s*',
    re.IGNORECASE,
)


def clean_db(db_path: str, dry_run: bool = False) -> None:
    if not os.path.exists(db_path):
        print(f"ERROR: Database not found at {db_path}")
        sys.exit(1)

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    rows = conn.execute(
        "SELECT id, event_id, sequence_number, content FROM paragraphs"
        " WHERE content LIKE '%Shailendra%'"
    ).fetchall()

    print(f"Found {len(rows)} paragraphs containing 'Shailendra' text.")

    if not rows:
        print("Nothing to clean.")
        conn.close()
        return

    updated = 0
    for r in rows:
        original = r["content"]
        cleaned = SHAILENDRA_RE.sub('', original).strip()
        if cleaned != original:
            updated += 1
            if dry_run:
                chars_removed = len(original) - len(cleaned)
                print(
                    f"  [DRY RUN] Paragraph {r['id']}"
                    f" (event {r['event_id']}):"
                    f" would clean {chars_removed} chars"
                )
            else:
                conn.execute(
                    "UPDATE paragraphs SET content = ? WHERE id = ?",
                    (cleaned, r["id"]),
                )
                # Update FTS row too
                conn.execute(
                    "UPDATE paragraphs_fts SET content = ? WHERE paragraph_id = ?",
                    (cleaned, r["id"]),
                )

    if not dry_run:
        conn.commit()
        # Optimize FTS index after updates
        conn.execute("INSERT INTO paragraphs_fts(paragraphs_fts) VALUES('optimize')")
        conn.commit()

    conn.close()
    action = "Would update" if dry_run else "Updated"
    print(f"{action} {updated} paragraphs out of {len(rows)} matches.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Clean Shailendra attribution from paragraphs"
    )
    parser.add_argument("--db", default="data/osho.db", help="Path to SQLite database")
    parser.add_argument(
        "--dry-run", action="store_true", help="Preview changes without modifying"
    )
    args = parser.parse_args()
    clean_db(args.db, args.dry_run)
