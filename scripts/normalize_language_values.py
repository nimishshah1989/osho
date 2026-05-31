#!/usr/bin/env python3
"""One-shot migration: canonicalise `events.language` to full names.

Background
----------
At some point an ingest path wrote bare ISO codes (`en`, `hi`) into
`events.language` instead of the full canonical names (`English`,
`Hindi`) that the rest of the system has always assumed. With both
forms present (or, as on prod 2026-05-31, only the bare codes), the
language filter — which historically passed the full name straight
through to SQL — returned zero rows.

The runtime fix (cloud_api.py:_expand_language_aliases + the parallel
TS engine helper) makes the SEARCH tolerant to either form so the UI
keeps working forever. This script complements that by **normalising
the stored data** so analytics, exports, and any downstream queries
that don't know about the alias map all see one consistent value.

Idempotent. Safe to re-run. Reports what would change with --dry-run.

Usage
-----
    python3 scripts/normalize_language_values.py --db data/osho.db --dry-run
    python3 scripts/normalize_language_values.py --db data/osho.db

After running, the FTS index does NOT need rebuilding — the language
column lives on events, not on the FTS virtual table.
"""
from __future__ import annotations

import argparse
import sqlite3
import sys


# Canonical forms the rest of the system expects. Add new mappings here
# (e.g. 'zh' -> 'Chinese') if the corpus ever grows beyond EN/HI.
CANONICAL: dict[str, str] = {
    'en': 'English',
    'eng': 'English',
    'english': 'English',
    'hi': 'Hindi',
    'hin': 'Hindi',
    'hindi': 'Hindi',
}


def canonicalise(raw: str | None) -> str | None:
    if raw is None:
        return None
    key = raw.strip().lower()
    return CANONICAL.get(key, raw)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--db', required=True, help='Path to the SQLite DB (e.g. data/osho.db)')
    p.add_argument('--dry-run', action='store_true', help='Report what would change, write nothing.')
    args = p.parse_args()

    conn = sqlite3.connect(args.db)
    try:
        rows = conn.execute(
            "SELECT language, COUNT(*) FROM events GROUP BY language ORDER BY 2 DESC"
        ).fetchall()
        print(f"Before:")
        for value, count in rows:
            print(f"  {(value or 'NULL'):>12}  {count}")

        # Build the UPDATE plan: only those rows whose current value
        # would change. Avoids no-op writes that bloat the journal on a
        # large DB.
        to_update: list[tuple[str, str]] = []  # (canonical, original)
        for value, _count in rows:
            if value is None:
                continue
            canonical = canonicalise(value)
            if canonical != value:
                to_update.append((canonical, value))

        if not to_update:
            print("\nNothing to do — every language value is already canonical.")
            return 0

        print("\nPlanned updates:")
        for canonical, original in to_update:
            print(f"  {original!r:>12} -> {canonical!r}")

        if args.dry_run:
            print("\nDry-run: no changes written.")
            return 0

        with conn:  # transaction
            for canonical, original in to_update:
                conn.execute(
                    "UPDATE events SET language = ? WHERE language = ?",
                    (canonical, original),
                )

        print("\nAfter:")
        rows = conn.execute(
            "SELECT language, COUNT(*) FROM events GROUP BY language ORDER BY 2 DESC"
        ).fetchall()
        for value, count in rows:
            print(f"  {(value or 'NULL'):>12}  {count}")
        print("\nDone. The FTS index does NOT need rebuilding.")
        return 0
    finally:
        conn.close()


if __name__ == '__main__':
    sys.exit(main())
