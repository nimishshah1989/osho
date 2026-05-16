"""Schema migrations applied on cloud_api startup.

These cover the case where an older production database lacks columns
that newer code SELECTs from — the migrations must run idempotently and
must not break a DB that already has the columns."""

import os
import sqlite3
import sys
import tempfile

import pytest
from fastapi.testclient import TestClient

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)


def _seed_legacy_db(path: str) -> None:
    """A DB shaped like the original 2025-vintage schema: no `role` column
    on paragraphs, no `translated_from` column on events."""
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
            tokenize = "porter unicode61 remove_diacritics 1 categories 'L* N* Co Mn Mc'"
        );
        CREATE VIRTUAL TABLE paragraphs_fts_exact USING fts5(
            content, title UNINDEXED, event_id UNINDEXED,
            paragraph_id UNINDEXED, sequence_number UNINDEXED,
            title_search,
            tokenize = "unicode61 remove_diacritics 1 categories 'L* N* Co Mn Mc'"
        );
        INSERT INTO events (id,title,date,location,language)
            VALUES ('e1','A Talk','1975','Pune','English');
        INSERT INTO paragraphs (event_id,sequence_number,content)
            VALUES ('e1',1,'Body about meditation.');
        INSERT INTO paragraphs_fts (content,title,event_id,paragraph_id,sequence_number,title_search)
            VALUES ('Body about meditation.','A Talk','e1',1,1,'A Talk');
        INSERT INTO paragraphs_fts_exact (content,title,event_id,paragraph_id,sequence_number,title_search)
            VALUES ('Body about meditation.','A Talk','e1',1,1,'A Talk');
        """
    )
    conn.commit()
    conn.close()


@pytest.fixture()
def legacy_client(monkeypatch):
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    _seed_legacy_db(tmp.name)

    sys.modules.pop("scripts.cloud_api", None)
    from scripts import cloud_api as cloud_api_module  # type: ignore
    monkeypatch.setattr(cloud_api_module, "DB_PATH", tmp.name)

    with TestClient(cloud_api_module.app) as client:
        yield client, tmp.name

    os.unlink(tmp.name)


def _columns(db_path: str, table: str) -> set[str]:
    with sqlite3.connect(db_path) as conn:
        return {r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def test_startup_adds_role_column(legacy_client):
    """Old DB had no paragraphs.role — startup migration should add it."""
    _, db_path = legacy_client
    assert "role" in _columns(db_path, "paragraphs")


def test_startup_adds_translated_from_column(legacy_client):
    """Old DB had no events.translated_from — startup migration should add it."""
    _, db_path = legacy_client
    assert "translated_from" in _columns(db_path, "events")


def test_original_filter_works_against_migrated_legacy_db(legacy_client):
    """End-to-end: a legacy DB (no translated_from column at file-open
    time) should be queryable with `?original=true` after startup. This
    was failing in prod with 'Invalid search syntax.' because the SQL
    referenced a column that didn't exist."""
    client, _ = legacy_client
    r = client.get("/api/search?q=meditation&original=true")
    assert r.status_code == 200, r.text
    # Legacy rows have translated_from NULL → treated as Original →
    # they appear in the results.
    data = r.json()
    assert data["total"] >= 1
    assert any(e["title"] == "A Talk" for e in data["events"])
