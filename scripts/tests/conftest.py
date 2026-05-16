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
# Ensure scripts/tests is on sys.path so `from _helpers import …` works in tests.
TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
if TESTS_DIR not in sys.path:
    sys.path.insert(0, TESTS_DIR)


def _seed_db(path: str) -> None:
    conn = sqlite3.connect(path)
    cur = conn.cursor()
    cur.executescript(
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
            role TEXT
        );
        -- Tokenizer strings match scripts/build_fts.py exactly. `remove_diacritics 1`
        -- strips only Latin combining marks (é → e), never Devanagari matras —
        -- per CLAUDE.md the `remove_diacritics 2` shortcut collapses unrelated
        -- Hindi words and used to live here as a test-only divergence from prod.
        -- The `categories 'L* N* Co Mn Mc'` directive keeps virama (U+094D) and
        -- anusvara (U+0902) inside tokens, which is what makes the exact-mode
        -- Hindi tests meaningful rather than incidental.
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
        """
    )
    # Tuple: (id, title, date, location, language, translated_from).
    # translated_from = "none" means Osho gave the talk originally in `language`;
    # any other value identifies the source language of a translation.
    events = [
        ("e1", "The Book of Secrets ~ 01",    "1973-01-01", "Bombay",  "English", "none"),
        ("e2", "The Mustard Seed ~ 04",       "1974-08-21", "Poona",   "English", "none"),
        ("e3", "Vigyan Bhairav Tantra ~ 12",  "1984-05-10", "Pune",    "English", "none"),
        ("e4", "A Course on Meditation ~ 03", "1988-03-03", "Pune",    "English", "none"),
        ("e5", "Zen: The Quantum Leap ~ 02",  "1989-04-04", "Pune",    "English", "none"),
        # Hindi events — all originals
        ("h1", "Dekh Kabira Roya ~ 17",       "1978-06-15", "Pune",    "Hindi",   "none"),
        ("h2", "Dhammapada ~ 03",             "1979-09-10", "Pune",    "Hindi",   "none"),
        ("h3", "Ek Omkar Satnam ~ 05",        "1975-02-20", "Bombay",  "Hindi",   "none"),
        # Translated event — English translation of a Hindi original
        ("t1", "The Path of Meditation (Translation)", "1980-01-01", "Pune", "English", "Hindi"),
        # Event for proximity search testing
        ("p1", "Light on the Path ~ 29",      "1986-02-25", "Pune",    "English", "none"),
        ("p2", "The Messiah Vol 1 ~ 15",      "1987-01-10", "Pune",    "English", "none"),
    ]
    cur.executemany(
        "INSERT INTO events (id,title,date,location,language,translated_from)"
        " VALUES (?,?,?,?,?,?)",
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
        # Cross-paragraph case (on a *different* discourse so FTS5 in-row
        # NEAR cannot find it): 'politicians' near the end of seq 4,
        # 'mafia' at the start of seq 5. NEAR(..., 30) must still match.
        (24, "e2", 4,
         "Power corrupts every government and every assembly of politicians."),
        (25, "e2", 5,
         "Mafia bosses thrive whenever such corruption goes unchecked."),
        # False-positive guard: the two words exist in adjacent paragraphs
        # of this event, but they are far apart in tokens — NEAR(..., 30)
        # must NOT match this discourse.
        (26, "e5", 80,
         "Politicians appear at the very beginning of this short paragraph "
         "and the rest of the paragraph rambles on about altogether unrelated "
         "matters, listing names of philosophers and saints, painting "
         "long tableaus of imagined gardens, weaving sentence after sentence "
         "of digression so the reader entirely forgets where the topic began "
         "before the paragraph eventually wanders to an unrelated close."),
        (27, "e5", 81,
         "Through pages of unrelated meditations the discourse meanders, "
         "touching upon silence, breath, dreams, longing, despair, "
         "compassion, surrender, prayer, fragrance, song, courage, "
         "music, wonder, awe, devotion, and only at the very end of all "
         "this digression does the word mafia surface again."),
        # Metadata paragraphs (should be filtered from display hits)
        (22, "e3", 0, "Vigyan Bhairav Tantra ~ 12"),
        (23, "e3", 2,
         "event page in sannyas.wiki: Vigyan Bhairav Tantra ~ 12."),
        # Stemmed vs exact coverage:
        #   "teaching" appears only as the inflected form — stemmed search
        #   for "teach" should find it, exact should not.
        (30, "e1", 50, "The teaching of the masters is one and the same."),
        # Hindi anusvara variants: same word with the two acceptable
        # spellings. Stemmed (normalised) search treats them as one
        # token; exact search does not.
        (31, "h1", 80, "अनन्त — समय के पार जो है, वही अनन्त है।"),
        (32, "h2", 90, "अनंत यात्रा है, अंत नहीं।"),
    ]
    cur.executemany(
        "INSERT INTO paragraphs (id,event_id,sequence_number,content) VALUES (?,?,?,?)",
        paragraphs,
    )
    # Mirror into both FTS tables, matching build_fts.py:
    #   paragraphs_fts        — content runs through Devanagari nasal+virama
    #                           → anusvara normalisation so अनन्त and अनंत
    #                           collapse to one token.
    #   paragraphs_fts_exact  — raw content, no normalisation, so the two
    #                           spellings remain distinct.
    from scripts.build_fts import normalize_devanagari
    for p_id, ev_id, seq, content in paragraphs:
        title = next((t for i, t, *_ in events if i == ev_id), "")
        norm_content = normalize_devanagari(content)
        norm_title   = normalize_devanagari(title)
        cur.execute(
            "INSERT INTO paragraphs_fts"
            " (content,title,event_id,paragraph_id,sequence_number,title_search)"
            " VALUES (?,?,?,?,?,?)",
            (norm_content, norm_title, ev_id, p_id, seq, norm_title),
        )
        cur.execute(
            "INSERT INTO paragraphs_fts_exact"
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
