"""End-to-end check of the staging-and-diff operational scripts:

    make_staging.copy_database         — snapshots a live DB
    diff_db.diff                       — walks two DBs by (title, language)

The flow exercised here mirrors what we do for a real production
ingest: copy → apply changes via word_update → diff the two DBs.
"""

import os
import sqlite3
import sys

import pytest

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

SCRIPTS_DIR = os.path.join(BASE_DIR, "scripts")
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from make_staging import copy_database  # noqa: E402
from diff_db import _load_snapshots, diff  # noqa: E402
from word_update import run_update  # noqa: E402
from _helpers import make_docx  # noqa: E402


# ─── Helpers ─────────────────────────────────────────────────────────────


def _seed_minimal_db(path, *, events=()):
    """Build an empty prod-shaped DB and seed with the given event tuples
    (title, language, date, location, translated_from, body_paragraphs)."""
    conn = sqlite3.connect(str(path))
    conn.executescript(
        """
        CREATE TABLE events (
            id TEXT PRIMARY KEY, title TEXT NOT NULL,
            date TEXT, location TEXT, language TEXT,
            translated_from TEXT
        );
        CREATE TABLE paragraphs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL,
            sequence_number INTEGER NOT NULL,
            content TEXT NOT NULL,
            role TEXT,
            is_embedded BOOLEAN DEFAULT 0
        );
        CREATE VIRTUAL TABLE paragraphs_fts USING fts5(
            content, title UNINDEXED, event_id UNINDEXED,
            paragraph_id UNINDEXED, sequence_number UNINDEXED,
            title_search,
            tokenize = 'porter unicode61 remove_diacritics 2'
        );
        """
    )
    for i, ev in enumerate(events):
        title, language, date, location, tf, paragraphs = ev
        ev_id = f"ev{i}"
        conn.execute(
            "INSERT INTO events (id, title, date, location, language, translated_from)"
            " VALUES (?,?,?,?,?,?)",
            (ev_id, title, date, location, language, tf),
        )
        for seq, content in enumerate(paragraphs, start=1):
            conn.execute(
                "INSERT INTO paragraphs (event_id, sequence_number, content)"
                " VALUES (?,?,?)",
                (ev_id, seq, content),
            )
    conn.commit()
    conn.close()


# ─── make_staging.copy_database ───────────────────────────────────────────


def test_copy_database_is_byte_identical(tmp_path):
    """A fresh copy is independently usable and contains the same records."""
    src = tmp_path / "src.db"
    dst = tmp_path / "dst.db"
    _seed_minimal_db(
        src,
        events=[
            ("Alpha", "English", "1973-01-01", "Bombay", "none", ["body alpha"]),
            ("Beta",  "Hindi",   "1975-02-02", "Pune",   "none", ["body beta"]),
        ],
    )
    copy_database(src, dst)
    assert dst.exists()

    src_snaps = _load_snapshots(src)
    dst_snaps = _load_snapshots(dst)
    assert src_snaps == dst_snaps, "Snapshots diverged after copy"


def test_copy_writes_to_a_new_path(tmp_path):
    src = tmp_path / "src.db"
    dst = tmp_path / "subdir" / "dst.db"
    _seed_minimal_db(src, events=[("Solo", "English", None, None, "none", ["x"])])
    copy_database(src, dst)
    assert dst.exists()
    assert dst.stat().st_size > 0


# ─── diff_db.diff ─────────────────────────────────────────────────────────


def test_diff_unchanged_when_identical(tmp_path):
    src = tmp_path / "src.db"
    dst = tmp_path / "dst.db"
    _seed_minimal_db(
        src,
        events=[("Alpha", "English", "1973-01-01", "Bombay", "none", ["a", "b"])],
    )
    copy_database(src, dst)
    diffs = diff(_load_snapshots(src), _load_snapshots(dst))
    assert all(d.status == "UNCHANGED" for d in diffs)


def test_diff_after_word_update_run(tmp_path):
    """Real-world flow: copy prod → apply Add/Modify/Delete via the word
    pipeline → diff. The diff should reflect exactly the operations we ran."""
    src = tmp_path / "prod.db"
    dst = tmp_path / "staging.db"
    _seed_minimal_db(
        src,
        events=[
            ("To Keep",   "English", "1973", "Bombay", "none", ["keep me unchanged"]),
            ("To Modify", "English", "1974", "Pune",   "none", ["original body"]),
            ("To Delete", "Hindi",   "1975", "Pune",   "none", ["please remove"]),
        ],
    )
    copy_database(src, dst)

    # Build a word_root with one Add, one Modify, one Delete
    root = tmp_path / "word_root"
    for sub in ("Add", "Modify", "Delete"):
        (root / sub).mkdir(parents=True, exist_ok=True)
    make_docx(
        root / "Add" / "added.docx",
        title="Brand New",
        language="EN",
        body=["fresh content"],
    )
    make_docx(
        root / "Modify" / "modified.docx",
        title="To Modify",
        language="EN",
        body=["completely new body"],
    )
    make_docx(
        root / "Delete" / "deleted.docx",
        title="To Delete",
        language="HI",
        body=["does not matter"],
    )
    report = run_update(root, dst)
    assert not report.failed, [r.error for r in report.failed]

    diffs = diff(_load_snapshots(src), _load_snapshots(dst))
    by_status = {d.status: [] for d in diffs}
    for d in diffs:
        by_status.setdefault(d.status, []).append(d.title)

    assert "Brand New" in by_status.get("ADDED", [])
    assert "To Modify" in by_status.get("MODIFIED", [])
    assert "To Delete" in by_status.get("REMOVED", [])
    assert "To Keep" in by_status.get("UNCHANGED", [])


def test_diff_modified_reports_paragraph_delta(tmp_path):
    src = tmp_path / "src.db"
    dst = tmp_path / "dst.db"
    _seed_minimal_db(
        src,
        events=[("Talk", "English", "1973", "Pune", "none", ["one", "two"])],
    )
    copy_database(src, dst)

    # Modify in-place via raw SQL — bypasses the ingester so we test
    # the diff in isolation.
    with sqlite3.connect(str(dst)) as conn:
        conn.execute(
            "INSERT INTO paragraphs (event_id, sequence_number, content)"
            " VALUES ((SELECT id FROM events WHERE title='Talk'), 3, 'three')"
        )
        conn.commit()

    diffs = diff(_load_snapshots(src), _load_snapshots(dst))
    mod = next(d for d in diffs if d.status == "MODIFIED")
    assert mod.title == "Talk"
    assert "paragraphs: 2 → 3" in mod.note


def test_diff_detects_translated_from_change(tmp_path):
    src = tmp_path / "src.db"
    dst = tmp_path / "dst.db"
    _seed_minimal_db(
        src,
        events=[("Talk", "English", "1973", "Pune", "none", ["body"])],
    )
    copy_database(src, dst)
    with sqlite3.connect(str(dst)) as conn:
        conn.execute(
            "UPDATE events SET translated_from='Hindi' WHERE title='Talk'"
        )
        conn.commit()

    diffs = diff(_load_snapshots(src), _load_snapshots(dst))
    mod = next(d for d in diffs if d.status == "MODIFIED")
    assert "translated_from" in mod.note
