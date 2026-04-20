"""Test harness that stubs out heavy ML / DB dependencies so the FastAPI app can boot."""

import os
import sys
import sqlite3
import tempfile
import types

import pytest

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)


class _StubSearcher:
    def __init__(self):
        self.results = [
            {
                "id": "1",
                "content": "Meditation is not concentration.",
                "distance": 0.1,
                "event_title": "The Book of Secrets",
                "event_date": "1973-01-01",
                "event_location": "Bombay",
                "sequence_number": 1,
                "source_url": "https://example.com/1",
            },
            {
                "id": "2",
                "content": "Love is the ultimate alchemy.",
                "distance": 0.2,
                "event_title": "The Mustard Seed",
                "event_date": "1974-08-21",
                "event_location": "Poona",
                "sequence_number": 7,
                "source_url": "https://example.com/2",
            },
        ]

    def search(self, query, n_results=5):
        return self.results[:n_results]

    def close(self):
        pass


async def _stub_stream(prompt, context):
    for piece in ["Silence ", "is ", "the ", "mother ", "tongue."]:
        yield piece


def _seed_db(path):
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
        """
    )
    cur.executemany(
        "INSERT INTO events (id,title,date,location,language) VALUES (?,?,?,?,?)",
        [
            ("e1", "The Book of Secrets ~ 01",    "1973-01-01", "Bombay", "English"),
            ("e2", "The Mustard Seed ~ 04",       "1974-08-21", "Poona",  "English"),
            ("e3", "Rajneeshpuram Talk ~ 12",     "1984-05-10", "Oregon", "English"),
            ("e4", "A Course on Meditation ~ 03", "1988-03-03", "Pune",   "English"),
            ("e5", "Zen: The Quantum Leap ~ 02",  "1989-04-04", "Pune",   "English"),
        ],
    )
    cur.executemany(
        "INSERT INTO paragraphs (id,event_id,sequence_number,content) VALUES (?,?,?,?)",
        [
            (1, "e1", 1, "Meditation is not concentration."),
            (2, "e1", 2, "It is a state of no-mind."),
            (3, "e2", 7, "Love is the ultimate alchemy."),
        ],
    )
    conn.commit()
    conn.close()


@pytest.fixture()
def app_client(monkeypatch):
    from fastapi.testclient import TestClient

    # Stub heavy modules BEFORE importing cloud_api
    search_stub = types.ModuleType("scripts.search")
    search_stub.HybridSearcher = _StubSearcher
    monkeypatch.setitem(sys.modules, "scripts.search", search_stub)

    rag_stub = types.ModuleType("scripts.openrouter_rag")
    rag_stub.ask_osho_stream = _stub_stream
    monkeypatch.setitem(sys.modules, "scripts.openrouter_rag", rag_stub)

    # Seeded SQLite db for cluster + particle endpoints
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    _seed_db(tmp.name)

    # Reload cloud_api cleanly
    sys.modules.pop("scripts.cloud_api", None)
    from scripts import cloud_api as cloud_api_module  # type: ignore

    monkeypatch.setattr(cloud_api_module, "DB_PATH", tmp.name)
    monkeypatch.setattr(cloud_api_module, "searcher", _StubSearcher())

    with TestClient(cloud_api_module.app) as client:
        yield client

    os.unlink(tmp.name)
