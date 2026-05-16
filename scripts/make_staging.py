"""Snapshot the production SQLite archive into a staging copy.

Used when we want to ingest a batch of new / modified records into a
*parallel* database without touching the live one. Sugit's review flow
is:

  1. make_staging.py             → data/staging.db (copy of prod)
  2. word_update.py Word/ --db data/staging.db
  3. diff_db.py data/osho.db data/staging.db
  4. point a preview deploy at staging.db while review continues
  5. swap (or roll back) once approved

Implementation detail: SQLite's "online backup" API copies the file
*including* the FTS5 virtual table and all its shadow tables in a
single transaction, so we don't need to rebuild the FTS index after
the copy. That's ~10× faster than a full FTS rebuild on the full
75K-paragraph archive.

Usage
-----
    python3 scripts/make_staging.py
    python3 scripts/make_staging.py --target data/staging-2026-05-16.db
    python3 scripts/make_staging.py --source data/osho.db --target /tmp/scratch.db
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import time
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = BASE_DIR / "data" / "osho.db"
DEFAULT_TARGET = BASE_DIR / "data" / "staging.db"


def copy_database(source: Path, target: Path) -> int:
    """Backup `source` into `target`. Returns bytes written. Raises on error."""
    if not source.exists():
        raise FileNotFoundError(f"Source DB not found: {source}")
    target.parent.mkdir(parents=True, exist_ok=True)

    src = sqlite3.connect(str(source))
    dst = sqlite3.connect(str(target))
    try:
        # The official online-backup path. pages=-1 means "copy everything
        # in one step" — fine for archive-size DBs (~1.6 GB) on a server
        # where we're not contending with live traffic.
        src.backup(dst, pages=-1)
    finally:
        dst.close()
        src.close()
    return target.stat().st_size


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument(
        "--source",
        type=Path,
        default=DEFAULT_SOURCE,
        help=f"Path to the live DB (default {DEFAULT_SOURCE})",
    )
    ap.add_argument(
        "--target",
        type=Path,
        default=DEFAULT_TARGET,
        help=f"Where to write the staging copy (default {DEFAULT_TARGET})",
    )
    ap.add_argument(
        "--force",
        action="store_true",
        help="Overwrite the target file if it already exists",
    )
    args = ap.parse_args(argv)

    if args.target.exists() and not args.force:
        print(
            f"ERROR: {args.target} already exists. Pass --force to overwrite "
            f"(or pick a different --target).",
            file=sys.stderr,
        )
        return 2

    print(f"Copying {args.source}  →  {args.target}")
    t0 = time.perf_counter()
    size = copy_database(args.source, args.target)
    elapsed = time.perf_counter() - t0
    print(f"Wrote {size:,} bytes in {elapsed:.1f}s")
    print(
        "Next: run scripts/word_update.py against this staging DB with --db "
        f"{args.target}, then diff with scripts/diff_db.py."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
