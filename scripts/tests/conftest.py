"""Test harness: seeds an in-memory SQLite (with FTS5) so cloud_api tests run
without depending on the ~2GB production archive.

Includes both English and Hindi seed data to cover:
- Basic keyword search and BM25 ranking
- Exact phrase matching
- NEAR proximity search
- Hindi/Devanagari search
- Language filtering
- Date range filtering
- Shailendra text stripping
- Duplicate detection
"""

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
            id TEXT PRIMARY KEY, title TEXT NOT NULL,
            date TEXT, location TEXT, language TEXT
        );
        CREATE TABLE paragraphs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL,
            sequence_number INTEGER NOT NULL,
            content TEXT NOT NULL
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
        ("e1", "The Book of Secrets ~ 01",    "1973-01-01", "Bombay",  "English"),
        ("e2", "The Mustard Seed ~ 04",       "1974-08-21", "Poona",   "English"),
        ("e3", "Vigyan Bhairav Tantra ~ 12",  "1984-05-10", "Pune",    "English"),
        ("e4", "A Course on Meditation ~ 03", "1988-03-03", "Pune",    "English"),
        ("e5", "Zen: The Quantum Leap ~ 02",  "1989-04-04", "Pune",    "English"),
        # Hindi events
        ("h1", "Dekh Kabira Roya ~ 17",       "1978-06-15", "Pune",    "Hindi"),
        ("h2", "Dhammapada ~ 03",             "1979-09-10", "Pune",    "Hindi"),
        ("h3", "Ek Omkar Satnam ~ 05",        "1975-02-20", "Bombay",  "Hindi"),
        # Translated event (English translation of Hindi)
        ("t1", "The Path of Meditation (Translation)", "1980-01-01", "Pune", "English"),
        # Event for proximity search testing
        ("p1", "Light on the Path ~ 29",      "1986-02-25", "Pune",    "English"),
        ("p2", "The Messiah Vol 1 ~ 15",      "1987-01-10", "Pune",    "English"),
    ]
    cur.executemany(
        "INSERT INTO events (id,title,date,location,language) VALUES (?,?,?,?,?)",
        events,
    )
    paragraphs = [
        # English paragraphs
        (1,  "e1", 1, "Meditation is not concentration. It is a state of no-mind."),
        (2,  "e1", 2, "Become silent and the universe begins to speak."),
        (3,  "e2", 7, "Love is the ultimate alchemy. Love transforms everything."),
        (4,  "e3", 1,
         "Vigyan Bhairav Tantra — one hundred and twelve techniques of meditation."),
        (5,  "e4", 3,
         "Silence is not absence of sound; silence is presence of awareness."),
        (6,  "e5", 2, "Zen is the only religion that will survive."),
        # Hindi paragraphs
        (7,  "h1", 1, "नहीं वह तो ठीक है, लेकिन बात कुछ और है।"),
        (8,  "h1", 5, "जीवन में धन और धर्म दोनों जरूरी हैं। विश्वास रखो।"),
        (9,  "h1", 17, "कहानियों से मुझे कुछ प्रेम है, यह बात सच है।"),
        (10, "h2", 3, "धन धर्म और विश्वास — ये तीनों साथ चलते हैं।"),
        (11, "h2", 8, "ध्यान में बैठो और मौन हो जाओ।"),
        (12, "h3", 2, "धन का मूल्य धर्म से है और विश्वास से जीवन चलता है।"),
        (13, "h3", 5,
         "source: Shailendra's Hindi collection\nयह प्रवचन बहुत महत्वपूर्ण है।"),
        # Translation paragraph
        (14, "t1", 1, "The path of meditation is the path of silence and awareness."),
        # Proximity search: many Nietzsche mentions in Light on the Path
        (15, "p1", 1,
         "Nietzsche was a great philosopher. Nietzsche understood the superman."),
        (16, "p1", 3,
         "Nietzsche proclaimed God is dead. This was Nietzsche's greatest insight."),
        (17, "p1", 7,
         "Nietzsche's Zarathustra is one of the most significant books ever written."),
        (18, "p1", 12,
         "Beyond good and evil — Nietzsche saw clearly what others could not."),
        # Fewer Nietzsche mentions in The Messiah
        (19, "p2", 5, "Nietzsche once said that God is dead."),
        # Politicians and mafia proximity test
        (20, "p1", 20,
         "The politicians have always been in alliance with the mafia."),
        (21, "p2", 10,
         "When politicians and the mafia join hands, the common man suffers."),
        # Metadata paragraphs (should be filtered from display hits)
        (22, "e3", 0, "Vigyan Bhairav Tantra ~ 12"),
        (23, "e3", 2,
         "event page in sannyas.wiki: Vigyan Bhairav Tantra ~ 12."),
    ]
    cur.executemany(
        "INSERT INTO paragraphs (id,event_id,sequence_number,content) VALUES (?,?,?,?)",
        paragraphs,
    )
    # Mirror into FTS table
    for p_id, ev_id, seq, content in paragraphs:
        title = next((t for i, t, *_ in events if i == ev_id), "")
        cur.execute(
            "INSERT INTO paragraphs_fts"
            " (content,title,event_id,paragraph_id,sequence_number,title_search)"
            " VALUES (?,?,?,?,?,?)",
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
