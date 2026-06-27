"""Word-document operational pipeline.

Takes one root directory laid out as

    <root>/
      Add/      *.docx files for records that should NOT exist yet
      Modify/   *.docx files for records that MUST exist already
      Delete/   *.docx files (often empty bodies) identifying records to remove

…and applies them in a single transactional pass: every change inside a
folder commits or rolls back together. Designed so Sugit (or anyone else)
can drop a batch of files, run one command, and walk away with a report.

Each Word file MUST carry the canonical `@title=` and `@language=`
headers — that pair is the record's identifier. The filename is for
human convenience only.

Usage
-----
    python3 scripts/word_update.py path/to/Word_root
    python3 scripts/word_update.py path/to/Word_root --dry-run
    python3 scripts/word_update.py path/to/Word_root --db data/staging.db

Exit codes
----------
    0  every file processed successfully
    1  at least one file failed (database left unchanged)
    2  configuration error (missing folder, missing DB, bad CLI args)
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path

# Same module — re-use the parser, upsert, and migrations rather than
# duplicating any of that logic here.
from ingest_docx import (
    DB_PATH,
    _ensure_role_column,
    _ensure_source_short_column,
    _ensure_translated_from_column,
    _find_existing_event_id,
    delete_record,
    parse_docx,
    parse_docx_header,
    upsert,
)


# ─── Result types ───────────────────────────────────────────────────────────


class Action(Enum):
    ADD = "Add"
    MODIFY = "Modify"
    DELETE = "Delete"


@dataclass
class FileResult:
    action: Action
    path: Path
    ok: bool
    summary: str  # short human-readable line for the report
    error: str | None = None


@dataclass
class RunReport:
    results: list[FileResult] = field(default_factory=list)

    def add(self, r: FileResult) -> None:
        self.results.append(r)

    @property
    def failed(self) -> list[FileResult]:
        return [r for r in self.results if not r.ok]

    def render(self) -> str:
        out: list[str] = []
        for action in Action:
            section = [r for r in self.results if r.action is action]
            if not section:
                continue
            ok_n = sum(1 for r in section if r.ok)
            fail_n = len(section) - ok_n
            heading = f"== {action.value} ({ok_n} ok"
            if fail_n:
                heading += f", {fail_n} failed"
            heading += ") =="
            out.append(heading)
            for r in section:
                prefix = "  OK   " if r.ok else "  FAIL "
                out.append(f"{prefix}{r.summary}")
                if r.error:
                    out.append(f"         {r.error}")
            out.append("")
        ok = sum(1 for r in self.results if r.ok)
        fail = len(self.results) - ok
        if fail:
            # Be unambiguous: a single failure rolls the whole batch back, so
            # the per-action "(N ok)" counts above are what *would* have
            # happened, not what landed. Sugit's Issue 6 — the bare
            # "X ok, Y failed" line read as if the X had been applied.
            out.append(
                f"Summary: {fail} failed across {len(self.results)} files — "
                f"NOTHING was applied. This batch is all-or-nothing, so the "
                f"whole thing was rolled back. Fix the failing file(s) and re-run."
            )
        else:
            out.append(f"Summary: {ok} ok across {len(self.results)} files.")
        return "\n".join(out)


# ─── Per-file operations ────────────────────────────────────────────────────


def _process_add(conn: sqlite3.Connection, path: Path) -> FileResult:
    try:
        talk = parse_docx(path)
    except Exception as ex:
        return FileResult(Action.ADD, path, False, path.name, str(ex))

    if _find_existing_event_id(conn, talk.title, talk.language):
        return FileResult(
            Action.ADD,
            path,
            False,
            f"{talk.title}  [{talk.language}]",
            "record already exists — use Modify/ to update it",
        )
    upsert(conn, talk)
    return FileResult(
        Action.ADD,
        path,
        True,
        f"{talk.title}  [{talk.language}]  ({len(talk.paragraphs)} paragraphs)",
    )


def _process_modify(conn: sqlite3.Connection, path: Path) -> FileResult:
    try:
        talk = parse_docx(path)
    except Exception as ex:
        return FileResult(Action.MODIFY, path, False, path.name, str(ex))

    if not _find_existing_event_id(conn, talk.title, talk.language):
        return FileResult(
            Action.MODIFY,
            path,
            False,
            f"{talk.title}  [{talk.language}]",
            "no such record — use Add/ to create it",
        )
    upsert(conn, talk)
    return FileResult(
        Action.MODIFY,
        path,
        True,
        f"{talk.title}  [{talk.language}]  ({len(talk.paragraphs)} paragraphs)",
    )


def _process_delete(conn: sqlite3.Connection, path: Path) -> FileResult:
    try:
        header, language = parse_docx_header(path)
    except Exception as ex:
        return FileResult(Action.DELETE, path, False, path.name, str(ex))

    title = header["title"].strip()
    event_id, para_count = delete_record(conn, title, language)
    if event_id is None:
        # A Delete that matches no record is a FAILURE, so the all-or-nothing
        # batch aborts (Sugit's Issue 7, 2026-06-27). In a curated archive a
        # no-op delete almost always means the operator made a mistake — a
        # file dropped in Delete/ that belonged in Add/, a typo'd @title=, or
        # a stale batch whose target was already removed — and silently
        # waving it through hides that. The earlier "idempotent re-run"
        # rationale doesn't hold under all-or-nothing: a failed batch rolls
        # back entirely, so the records are still present on a re-run.
        return FileResult(
            Action.DELETE,
            path,
            False,
            f"{title}  [{language}]",
            "no such record to delete — check the file is in the right folder "
            "(a Delete/ file that should be in Add/Modify) or was already removed",
        )
    return FileResult(
        Action.DELETE,
        path,
        True,
        f"{title}  [{language}]  ({para_count} paragraphs removed)",
    )


# ─── Orchestration ──────────────────────────────────────────────────────────


def _list_docx(folder: Path) -> list[Path]:
    if not folder.exists():
        return []
    return sorted(
        p for p in folder.iterdir()
        if p.is_file() and p.suffix.lower() == ".docx" and not p.name.startswith("~$")
    )


def run_update(root: Path, db_path: Path, dry_run: bool = False) -> RunReport:
    """Process root/Add, root/Modify, root/Delete in that order.

    Everything happens inside a single transaction. If --dry-run is set,
    the transaction is rolled back at the end; the report still reflects
    what *would* have happened.

    Any failed file (parse error, missing-when-required, exists-when-not)
    aborts the whole run — the transaction is rolled back so the DB is
    never left in a partial state."""
    report = RunReport()
    conn = sqlite3.connect(db_path)
    try:
        _ensure_translated_from_column(conn)
        _ensure_source_short_column(conn)
        _ensure_role_column(conn)
        # Implicit transaction — sqlite3 begins one on the first write.
        for path in _list_docx(root / "Add"):
            report.add(_process_add(conn, path))
        for path in _list_docx(root / "Modify"):
            report.add(_process_modify(conn, path))
        for path in _list_docx(root / "Delete"):
            report.add(_process_delete(conn, path))

        if dry_run or report.failed:
            conn.rollback()
        else:
            conn.commit()
    finally:
        conn.close()
    return report


# ─── CLI ────────────────────────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument(
        "root",
        type=Path,
        help="Directory containing Add/, Modify/, Delete/ subfolders",
    )
    ap.add_argument(
        "--db",
        type=Path,
        default=DB_PATH,
        help=f"SQLite path (default {DB_PATH})",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Process everything, print the report, then roll back",
    )
    args = ap.parse_args(argv)

    if not args.root.exists() or not args.root.is_dir():
        print(f"ERROR: {args.root} is not a directory", file=sys.stderr)
        return 2
    if not args.db.exists():
        print(f"ERROR: DB not found at {args.db}", file=sys.stderr)
        return 2

    have_any = any(
        (args.root / sub).is_dir() for sub in ("Add", "Modify", "Delete")
    )
    if not have_any:
        print(
            f"ERROR: {args.root} contains no Add/ Modify/ or Delete/ subfolder",
            file=sys.stderr,
        )
        return 2

    report = run_update(args.root, args.db, dry_run=args.dry_run)
    print(report.render())
    if args.dry_run:
        print("(dry-run — no changes written)")
    elif report.failed:
        print("(transaction rolled back — fix the failing files and re-run)")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
