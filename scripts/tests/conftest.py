"""Test harness: seeds an in-memory SQLite (with FTS5) so cloud_api tests run
without depending on the ~2GB production archive."""

import os
import sys
import sqlite3
import tempfile

import pytest

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)


def _seed_db(path: str) -> None:
    conn = sqlite3.connect(path)
    cur = conn.cursor()
    cur.executescript(
        """
        CREATE TABLE events (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, date TEXT, location TEXT, language TEXT
        );
        CREATE TABLE paragraphs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL, sequence_number INTEGER NOT NULL, content TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE paragraphs_fts USING fts5(
            content, title UNINDEXED, event_id UNINDEXED,
            paragraph_id UNINDEXED, sequence_number UNINDEXED,
            title_search,
            tokenize = 'porter unicode61 remove_diacritics 2'
        );
        """
    )
    events = [
        ("e1", "The Book of Secrets ~ 01",    "1973-01-01", "Bombay", "English"),
        ("e2", "The Mustard Seed ~ 04",       "1974-08-21", "Poona",  "English"),
        ("e3", "Vigyan Bhairav Tantra ~ 12",  "1984-05-10", "Pune",   "English"),
        ("e4", "A Course on Meditation ~ 03", "1988-03-03", "Pune",   "English"),
        ("e5", "Zen: The Quantum Leap ~ 02",  "1989-04-04", "Pune",   "English"),
    ]
    cur.executemany(
        "INSERT INTO events (id,title,date,location,language) VALUES (?,?,?,?,?)", events
    )
    paragraphs = [
        (1, "e1", 1, "Meditation is not concentration. It is a state of no-mind."),
        (2, "e1", 2, "Become silent and the universe begins to speak."),
        (3, "e2", 7, "Love is the ultimate alchemy. Love transforms everything."),
        (4, "e3", 1, "Vigyan Bhairav Tantra — one hundred and twelve techniques of meditation."),
        (5, "e4", 3, "Silence is not absence of sound; silence is presence of awareness."),
        (6, "e5", 2, "Zen is the only religion that will survive."),
    ]
    cur.executemany(
        "INSERT INTO paragraphs (id,event_id,sequence_number,content) VALUES (?,?,?,?)",
        paragraphs,
    )
    # Mirror into FTS table
    for p_id, ev_id, seq, content in paragraphs:
        title = next((t for i, t, *_ in events if i == ev_id), "")
        cur.execute(
            "INSERT INTO paragraphs_fts (content,title,event_id,paragraph_id,sequence_number,title_search) "
            "VALUES (?,?,?,?,?,?)",
            (content, title, ev_id, p_id, seq, title),
        )
    conn.commit()
    conn.close()


@pytest.fixture()
def app_client(monkeypatch):
    from fastapi.testclient import TestClient

    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    _seed_db(tmp.name)

    sys.modules.pop("scripts.cloud_api", None)
    from scripts import cloud_api as cloud_api_module  # type: ignore
    monkeypatch.setattr(cloud_api_module, "DB_PATH", tmp.name)

    with TestClient(cloud_api_module.app) as client:
        yield client

    os.unlink(tmp.name)
