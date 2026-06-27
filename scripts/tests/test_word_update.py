"""Operational pipeline: Word/Add, Word/Modify, Word/Delete folders driven
by `scripts/word_update.run_update`. Covers the happy path for each action
plus the contract-violation paths (Add of existing record, Modify of
missing record, Delete of missing record) and the transaction guarantee
(any failure rolls the whole batch back)."""

import os
import sqlite3
import sys

import pytest

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

# scripts/ is a sibling package — make its modules importable as `word_update`
# (the module uses `from ingest_docx import ...` directly, same convention).
SCRIPTS_DIR = os.path.join(BASE_DIR, "scripts")
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from word_update import Action, run_update  # noqa: E402
from _helpers import make_docx  # noqa: E402  — shared `.docx` builder


# ─── Helpers ─────────────────────────────────────────────────────────────


def _seed_minimal_db(path):
    """Empty production-shaped DB."""
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE events (
            id TEXT PRIMARY KEY, title TEXT NOT NULL,
            date TEXT, location TEXT, language TEXT
        );
        CREATE TABLE paragraphs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL,
            sequence_number INTEGER NOT NULL,
            content TEXT NOT NULL,
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
    conn.commit()
    conn.close()


def _build_root(tmp_path, *, adds=(), modifies=(), deletes=()):
    """Lay out tmp_path/Add tmp_path/Modify tmp_path/Delete and populate."""
    root = tmp_path / "word_root"
    for sub in ("Add", "Modify", "Delete"):
        (root / sub).mkdir(parents=True, exist_ok=True)
    for i, spec in enumerate(adds):
        body = spec.pop("body_paragraphs", None)
        make_docx(root / "Add" / f"add{i}.docx", body=body, **spec)
    for i, spec in enumerate(modifies):
        body = spec.pop("body_paragraphs", None)
        make_docx(root / "Modify" / f"mod{i}.docx", body=body, **spec)
    for i, spec in enumerate(deletes):
        # Delete files may be empty-bodied — make_docx still writes headers
        body = spec.pop("body_paragraphs", ["irrelevant"])
        make_docx(root / "Delete" / f"del{i}.docx", body=body, **spec)
    return root


def _record_exists(db_path, title, language):
    with sqlite3.connect(db_path) as conn:
        row = conn.execute(
            "SELECT id FROM events WHERE title = ? AND language = ?",
            (title, language),
        ).fetchone()
    return row is not None


# ─── Happy paths ─────────────────────────────────────────────────────────


def test_add_creates_record(tmp_path):
    db = tmp_path / "test.db"
    _seed_minimal_db(str(db))
    root = _build_root(
        tmp_path,
        adds=[{"title": "Fresh Talk", "language": "EN"}],
    )
    report = run_update(root, db)
    assert not report.failed
    assert _record_exists(str(db), "Fresh Talk", "English")
    assert any(r.action is Action.ADD and r.ok for r in report.results)


def test_modify_replaces_paragraphs(tmp_path):
    db = tmp_path / "test.db"
    _seed_minimal_db(str(db))

    # Prime: insert the record via an Add run.
    pre = _build_root(
        tmp_path / "pre",
        adds=[{
            "title": "Talk to Modify",
            "language": "EN",
            "body_paragraphs": ["Old para 1", "Old para 2"],
        }],
    )
    run_update(pre, db)

    # Then modify with brand-new body content.
    mod_root = _build_root(
        tmp_path / "later",
        modifies=[{
            "title": "Talk to Modify",
            "language": "EN",
            "body_paragraphs": ["New para A", "New para B", "New para C"],
        }],
    )
    report = run_update(mod_root, db)
    assert not report.failed

    with sqlite3.connect(str(db)) as conn:
        rows = conn.execute(
            "SELECT content FROM paragraphs"
            " JOIN events ON events.id = paragraphs.event_id"
            " WHERE events.title = ? ORDER BY paragraphs.sequence_number",
            ("Talk to Modify",),
        ).fetchall()
    assert [r[0] for r in rows] == ["New para A", "New para B", "New para C"]


def test_delete_removes_record(tmp_path):
    db = tmp_path / "test.db"
    _seed_minimal_db(str(db))

    # Prime
    pre = _build_root(
        tmp_path / "pre",
        adds=[{"title": "Talk to Delete", "language": "EN"}],
    )
    run_update(pre, db)
    assert _record_exists(str(db), "Talk to Delete", "English")

    # Delete
    del_root = _build_root(
        tmp_path / "later",
        deletes=[{"title": "Talk to Delete", "language": "EN"}],
    )
    report = run_update(del_root, db)
    assert not report.failed
    assert not _record_exists(str(db), "Talk to Delete", "English")


# ─── Contract violations ────────────────────────────────────────────────


def test_add_existing_record_fails_and_rolls_back(tmp_path):
    db = tmp_path / "test.db"
    _seed_minimal_db(str(db))

    pre = _build_root(
        tmp_path / "pre",
        adds=[{"title": "Already Here", "language": "EN",
              "body_paragraphs": ["Original"]}],
    )
    run_update(pre, db)

    # Second batch: tries to Add a duplicate AND add a brand-new one.
    # The duplicate failure must roll the entire batch back, so "Brand New"
    # also doesn't land.
    second = _build_root(
        tmp_path / "second",
        adds=[
            {"title": "Already Here", "language": "EN",
             "body_paragraphs": ["Replacement"]},
            {"title": "Brand New", "language": "EN"},
        ],
    )
    report = run_update(second, db)
    assert report.failed
    assert not _record_exists(str(db), "Brand New", "English")
    # Original content of the existing record must be untouched.
    with sqlite3.connect(str(db)) as conn:
        contents = [
            r[0]
            for r in conn.execute(
                "SELECT content FROM paragraphs"
                " JOIN events ON events.id = paragraphs.event_id"
                " WHERE events.title = ? ORDER BY paragraphs.sequence_number",
                ("Already Here",),
            ).fetchall()
        ]
    assert contents == ["Original"], (
        "Existing record was mutated despite the batch rolling back"
    )


def test_modify_missing_record_fails(tmp_path):
    db = tmp_path / "test.db"
    _seed_minimal_db(str(db))
    root = _build_root(
        tmp_path,
        modifies=[{"title": "Does Not Exist", "language": "EN"}],
    )
    report = run_update(root, db)
    assert report.failed
    assert not _record_exists(str(db), "Does Not Exist", "English")


def test_delete_missing_record_aborts_batch(tmp_path):
    """Issue 7 (Sugit 2026-06-27): deleting an already-absent record is a
    FAILURE, so the all-or-nothing batch aborts. In a curated archive a no-op
    delete almost always means a misfiled document (a file in Delete/ that
    belonged in Add/, or a stale batch), and silently passing it would ship a
    batch that didn't do what its folder layout implied. A valid sibling
    change in the same batch must roll back too."""
    db = tmp_path / "test.db"
    _seed_minimal_db(str(db))
    # Prime a record we will try to Modify alongside the bad Delete.
    pre = _build_root(
        tmp_path / "pre",
        adds=[{"title": "Keep Me", "language": "EN", "body_paragraphs": ["Original"]}],
    )
    run_update(pre, db)

    root = _build_root(
        tmp_path / "batch",
        modifies=[{"title": "Keep Me", "language": "EN", "body_paragraphs": ["Changed"]}],
        deletes=[{"title": "Nothing To Delete", "language": "EN"}],
    )
    report = run_update(root, db)
    assert report.failed, "delete of an absent record should fail the batch"
    assert any(
        r.action is Action.DELETE and not r.ok and "no such record" in (r.error or "")
        for r in report.results
    )
    # All-or-nothing: the valid Modify in the same batch must NOT have landed.
    with sqlite3.connect(str(db)) as conn:
        contents = [
            r[0]
            for r in conn.execute(
                "SELECT content FROM paragraphs"
                " JOIN events ON events.id = paragraphs.event_id"
                " WHERE events.title = ? ORDER BY paragraphs.sequence_number",
                ("Keep Me",),
            ).fetchall()
        ]
    assert contents == ["Original"], "sibling Modify persisted despite the abort"


def test_failed_batch_report_says_nothing_applied(tmp_path):
    """Issue 6 (Sugit): when a batch fails, the report must spell out that
    NOTHING was applied — the per-action counts are 'would-have' numbers, not
    landed changes. Pins the render() Summary wording the admin UI relies on."""
    db = tmp_path / "test.db"
    _seed_minimal_db(str(db))
    # A valid Add + a failing Modify (no such record) → whole batch rolls back.
    root = _build_root(
        tmp_path,
        adds=[{"title": "Brand New", "language": "EN", "body_paragraphs": ["X"]}],
        modifies=[{"title": "Missing Record", "language": "EN", "body_paragraphs": ["Y"]}],
    )
    report = run_update(root, db)
    assert report.failed
    assert not _record_exists(str(db), "Brand New", "English")
    text = report.render()
    assert "NOTHING was applied" in text
    assert "rolled back" in text.lower()


def test_modify_matches_title_despite_separator_difference(tmp_path):
    """Issue 8 in the structured-update path: a Modify whose @title uses a
    different dash/tilde glyph than the stored record still updates it in
    place — it neither fails as 'no such record' nor duplicates the event."""
    db = tmp_path / "test.db"
    _seed_minimal_db(str(db))
    pre = _build_root(
        tmp_path / "pre",
        adds=[{"title": "Sarvasar Upanishad ~ 07", "language": "EN",
               "body_paragraphs": ["Original"]}],
    )
    run_update(pre, db)

    # Same talk, but typed with an en-dash instead of the tilde.
    mod = _build_root(
        tmp_path / "mod",
        modifies=[{"title": "Sarvasar Upanishad – 07", "language": "EN",
                   "body_paragraphs": ["Updated"]}],
    )
    report = run_update(mod, db)
    assert not report.failed, "Modify failed to match a title differing only by separator"
    with sqlite3.connect(str(db)) as conn:
        n = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        bodies = [
            r[0] for r in conn.execute(
                "SELECT content FROM paragraphs ORDER BY id"
            ).fetchall()
        ]
    assert n == 1, "separator difference created a duplicate event (Issue 8)"
    assert bodies == ["Updated"]


# ─── Dry-run ─────────────────────────────────────────────────────────────


def test_dry_run_writes_nothing(tmp_path):
    db = tmp_path / "test.db"
    _seed_minimal_db(str(db))
    root = _build_root(
        tmp_path,
        adds=[{"title": "Dry Run Add", "language": "EN"}],
    )
    report = run_update(root, db, dry_run=True)
    assert not report.failed
    # The report says ok, but the DB must be untouched.
    assert not _record_exists(str(db), "Dry Run Add", "English")
