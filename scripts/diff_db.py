"""Diff two osho-archive SQLite databases by (title, language) record.

Outputs a per-record changelog so a reviewer (Sugit) can see exactly
what an ingestion run changed before we cut staging over to production.

For each (title, language) pair the script reports one of four states:
  - ADDED:        present only in target
  - REMOVED:      present only in source
  - MODIFIED:     present in both but with different metadata or
                  paragraph contents
  - UNCHANGED:    identical (suppressed by default — `--show-unchanged`
                  to include)

The "paragraph contents" check compares the SHA-1 of the concatenated
paragraph texts in `sequence_number` order, so any insertion, deletion,
or edit shows up as MODIFIED with a short summary of what changed
(paragraph count delta, first changed paragraph, etc.).

Usage
-----
    python3 scripts/diff_db.py data/osho.db data/staging.db
    python3 scripts/diff_db.py data/osho.db data/staging.db --json
    python3 scripts/diff_db.py data/osho.db data/staging.db --show-unchanged

Exit codes
----------
    0  every record matched
    1  at least one record differs (the expected state during a real
       staging run)
    2  configuration error
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import sqlite3
import sys
from dataclasses import dataclass
from pathlib import Path


# ─── DB access ─────────────────────────────────────────────────────────────


@dataclass
class RecordSnapshot:
    """Everything we need from one event to compare it across DBs."""
    title: str
    language: str
    date: str | None
    location: str | None
    translated_from: str | None
    source_short: str | None
    paragraph_count: int
    body_hash: str  # SHA-1 of concatenated paragraph contents


def _load_snapshots(db_path: Path) -> dict[tuple[str, str], RecordSnapshot]:
    """Return {(title, language): RecordSnapshot}. Missing translated_from
    or source_short columns (legacy DBs) become None."""
    snaps: dict[tuple[str, str], RecordSnapshot] = {}
    with contextlib.closing(sqlite3.connect(str(db_path))) as conn:
        conn.row_factory = sqlite3.Row
        cols = {r[1] for r in conn.execute("PRAGMA table_info(events)").fetchall()}
        tf_col = "translated_from" if "translated_from" in cols else "NULL AS translated_from"
        ss_col = "source_short" if "source_short" in cols else "NULL AS source_short"

        ev_rows = conn.execute(
            f"SELECT id, title, language, date, location, {tf_col}, {ss_col} FROM events"
        ).fetchall()

        # Pre-fetch paragraphs grouped by event_id so we hit the DB only twice
        # instead of N+1 times.
        para_rows_by_event: dict[str, list[tuple[int, str]]] = {}
        for r in conn.execute(
            "SELECT event_id, sequence_number, content FROM paragraphs"
            " ORDER BY event_id, sequence_number"
        ).fetchall():
            para_rows_by_event.setdefault(r["event_id"], []).append(
                (r["sequence_number"], r["content"])
            )

        for ev in ev_rows:
            paras = para_rows_by_event.get(ev["id"], [])
            joined = "\n".join(content or "" for _seq, content in paras)
            body_hash = hashlib.sha1(joined.encode("utf-8")).hexdigest()
            key = ((ev["title"] or "").strip(), (ev["language"] or "").strip())
            snaps[key] = RecordSnapshot(
                title=ev["title"] or "",
                language=ev["language"] or "",
                date=ev["date"],
                location=ev["location"],
                translated_from=ev["translated_from"],
                source_short=ev["source_short"],
                paragraph_count=len(paras),
                body_hash=body_hash,
            )
    return snaps


# ─── Diff ──────────────────────────────────────────────────────────────────


@dataclass
class RecordDiff:
    status: str  # "ADDED" | "REMOVED" | "MODIFIED" | "UNCHANGED"
    title: str
    language: str
    note: str = ""

    def render(self) -> str:
        prefix = {
            "ADDED":    "  + ",
            "REMOVED":  "  - ",
            "MODIFIED": "  ~ ",
            "UNCHANGED": "    ",
        }[self.status]
        line = f"{prefix}{self.title}  [{self.language}]"
        if self.note:
            line += f"\n         {self.note}"
        return line


def _describe_change(a: RecordSnapshot, b: RecordSnapshot) -> list[str]:
    notes: list[str] = []
    if a.date != b.date:
        notes.append(f"date: {a.date!r} → {b.date!r}")
    if a.location != b.location:
        notes.append(f"location: {a.location!r} → {b.location!r}")
    if a.translated_from != b.translated_from:
        notes.append(f"translated_from: {a.translated_from!r} → {b.translated_from!r}")
    if a.source_short != b.source_short:
        notes.append(f"source_short: {a.source_short!r} → {b.source_short!r}")
    if a.body_hash != b.body_hash:
        if a.paragraph_count != b.paragraph_count:
            notes.append(
                f"paragraphs: {a.paragraph_count} → {b.paragraph_count}"
            )
        else:
            notes.append(
                f"paragraphs: same count ({a.paragraph_count}) but content changed"
            )
    return notes


def diff(
    source: dict[tuple[str, str], RecordSnapshot],
    target: dict[tuple[str, str], RecordSnapshot],
) -> list[RecordDiff]:
    """Walk every (title, language) key present in either DB. Order:
    ADDED first, then MODIFIED, then REMOVED, then UNCHANGED. Within each
    section, sorted by title for predictable review."""
    out: list[RecordDiff] = []
    added_keys = sorted(target.keys() - source.keys())
    removed_keys = sorted(source.keys() - target.keys())
    common_keys = sorted(source.keys() & target.keys())

    for key in added_keys:
        t, l = key
        out.append(RecordDiff(
            "ADDED", t, l,
            f"{target[key].paragraph_count} paragraphs",
        ))
    for key in common_keys:
        a, b = source[key], target[key]
        notes = _describe_change(a, b)
        if notes:
            out.append(RecordDiff("MODIFIED", key[0], key[1], "; ".join(notes)))
    for key in removed_keys:
        t, l = key
        out.append(RecordDiff(
            "REMOVED", t, l,
            f"{source[key].paragraph_count} paragraphs",
        ))
    for key in common_keys:
        a, b = source[key], target[key]
        if not _describe_change(a, b):
            out.append(RecordDiff("UNCHANGED", key[0], key[1]))
    return out


# ─── CLI ───────────────────────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("source", type=Path, help="Live DB (the reference)")
    ap.add_argument("target", type=Path, help="DB to compare against source")
    ap.add_argument(
        "--show-unchanged",
        action="store_true",
        help="Include UNCHANGED records in the output",
    )
    ap.add_argument(
        "--json",
        action="store_true",
        help="Emit machine-readable JSON instead of the human report",
    )
    args = ap.parse_args(argv)

    for p in (args.source, args.target):
        if not p.exists():
            print(f"ERROR: {p} does not exist", file=sys.stderr)
            return 2

    src_snaps = _load_snapshots(args.source)
    tgt_snaps = _load_snapshots(args.target)
    diffs = diff(src_snaps, tgt_snaps)
    changed = [d for d in diffs if d.status != "UNCHANGED"]

    if args.json:
        print(json.dumps(
            {
                "summary": {
                    "source": str(args.source),
                    "target": str(args.target),
                    "source_records": len(src_snaps),
                    "target_records": len(tgt_snaps),
                    "added": sum(1 for d in diffs if d.status == "ADDED"),
                    "removed": sum(1 for d in diffs if d.status == "REMOVED"),
                    "modified": sum(1 for d in diffs if d.status == "MODIFIED"),
                    "unchanged": sum(1 for d in diffs if d.status == "UNCHANGED"),
                },
                "records": [
                    {
                        "status": d.status,
                        "title": d.title,
                        "language": d.language,
                        "note": d.note,
                    }
                    for d in diffs
                    if args.show_unchanged or d.status != "UNCHANGED"
                ],
            },
            indent=2,
            ensure_ascii=False,
        ))
        return 0 if not changed else 1

    # Human-readable report
    print(f"Source: {args.source}  ({len(src_snaps)} records)")
    print(f"Target: {args.target}  ({len(tgt_snaps)} records)")
    print()

    counts = {
        "ADDED": sum(1 for d in diffs if d.status == "ADDED"),
        "MODIFIED": sum(1 for d in diffs if d.status == "MODIFIED"),
        "REMOVED": sum(1 for d in diffs if d.status == "REMOVED"),
        "UNCHANGED": sum(1 for d in diffs if d.status == "UNCHANGED"),
    }
    for status in ("ADDED", "MODIFIED", "REMOVED"):
        section = [d for d in diffs if d.status == status]
        if not section:
            continue
        print(f"== {status} ({counts[status]}) ==")
        for d in section:
            print(d.render())
        print()

    if args.show_unchanged:
        section = [d for d in diffs if d.status == "UNCHANGED"]
        if section:
            print(f"== UNCHANGED ({counts['UNCHANGED']}) ==")
            for d in section:
                print(d.render())
            print()

    print(
        f"Summary: {counts['ADDED']} added, {counts['MODIFIED']} modified, "
        f"{counts['REMOVED']} removed, {counts['UNCHANGED']} unchanged."
    )
    return 0 if not changed else 1


if __name__ == "__main__":
    sys.exit(main())
