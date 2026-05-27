"""Ingester round-trips Word `ctp - …` paragraph styles into the
`paragraphs.role` column, and the API surfaces them on /discourse and /search.

These tests build a real .docx in-memory using python-docx so we cover the
full path from style-name → role → DB → JSON, not just the regex normaliser.
"""

import os
import sqlite3
import sys
import tempfile

import pytest

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from scripts.ingest_docx import (  # noqa: E402
    _normalise_role,
    parse_docx,
    upsert,
    _ensure_role_column,
    _ensure_source_short_column,
    _ensure_translated_from_column,
)


# ── Style → role normalisation ────────────────────────────────────────────

@pytest.mark.parametrize(
    "style_name, expected",
    [
        ("ctp - Osho Talking", "osho_talking"),
        ("ctp - Other Talking 1", "other_talking_1"),
        ("ctp - Other Talking 2", "other_talking_2"),
        ("ctp - Sutra/Question", "sutra_question"),
        ("ctp - Poem", "poem"),
        ("ctp - Comments", "comments"),
        ("ctp - Short comments", "short_comments"),
        ("ctp - Our translation", "our_translation"),
        ("ctp - Notes", "notes"),
        ("ctp - Title", "title"),
        ("ctp - Event Info", "event_info"),
        # case-insensitive on the prefix
        ("CTP - Osho Talking", "osho_talking"),
        # whitespace tolerant
        ("ctp -   Osho   Talking", "osho_talking"),
        # Punctuation in the label is collapsed into a single underscore so the
        # slug is always a safe map key / CSS class fragment. Guards against
        # future style names like "ctp - Q & A" leaking ampersands into the role.
        ("ctp - Q & A", "q_a"),
        ("ctp - Footnote (1)", "footnote_1"),
        # Language qualifiers on Hindi-template styles collapse to the same
        # slug as the unqualified version — both are semantically the same
        # paragraph role, only the Word font differs (Sugit's 2026-05-21).
        ("ctp - Osho Talking (Hindi)", "osho_talking"),
        ("ctp - Other Talking 1 (Hindi)", "other_talking_1"),
        ("ctp - Sutra/Question (Devanagari)", "sutra_question"),
        ("ctp - Osho Talking (English)", "osho_talking"),
        # Case-insensitive on the qualifier
        ("ctp - Poem (HINDI)", "poem"),
        ("ctp - !!!", None),  # nothing identifier-like left → None
        # Non-ctp styles → None (treated as plain body text)
        ("Normal", None),
        ("Heading 1", None),
        ("", None),
        (None, None),
    ],
)
def test_normalise_role(style_name, expected):
    assert _normalise_role(style_name) == expected


# ── End-to-end: docx → DB → role round-trips ──────────────────────────────

from _helpers import make_docx  # noqa: E402 — keeps the import near use


def _make_mixed_role_docx(path: str) -> None:
    """A .docx with one paragraph per body style we care about, plus one
    paragraph with no `ctp -` style (role=None — the "plain body" path)."""
    make_docx(
        path,
        body=[
            ("INTERVIEWER: Why are you saying this?", "ctp - Other Talking 1"),
            ("OSHO: Because the question itself reveals the answer.", "ctp - Osho Talking"),
            ("Sutra to be commented upon today.", "ctp - Sutra/Question"),
            ("A short verse for the moment.", "ctp - Poem"),
            ("A bare paragraph with no ctp style.", None),
        ],
    )


def _seed_minimal_db(path: str) -> None:
    """Empty DB matching production schema, including the FTS table the
    upsert path expects to populate."""
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


def test_ingest_round_trips_role_to_db(tmp_path):
    docx_path = tmp_path / "sample.docx"
    db_path = tmp_path / "test.db"
    _make_mixed_role_docx(str(docx_path))
    _seed_minimal_db(str(db_path))

    talk = parse_docx(docx_path)
    assert talk.title == "Sample Discourse ~ 01"
    assert talk.language == "English"
    # Roles parsed off the in-memory paragraphs
    roles = [p.role for p in talk.paragraphs]
    assert roles == [
        "other_talking_1",
        "osho_talking",
        "sutra_question",
        "poem",
        None,
    ]

    with sqlite3.connect(db_path) as conn:
        _ensure_translated_from_column(conn)
        _ensure_source_short_column(conn)
        _ensure_role_column(conn)
        upsert(conn, talk)
        rows = conn.execute(
            "SELECT sequence_number, content, role FROM paragraphs"
            " ORDER BY sequence_number"
        ).fetchall()

    assert [r[2] for r in rows] == [
        "other_talking_1",
        "osho_talking",
        "sutra_question",
        "poem",
        None,
    ]
    # Content survived intact too
    assert "Why are you saying this" in rows[0][1]
    assert "the question itself reveals" in rows[1][1]


# ── @sourceShort header — Sugit's 2026-05-26 addition ─────────────────────


def test_source_short_parsed_and_stored_on_translation(tmp_path):
    """A translated record carries the book title from @sourceShort
    through parse → upsert → events.source_short."""
    docx_path = tmp_path / "translation.docx"
    db_path = tmp_path / "test.db"
    make_docx(
        str(docx_path),
        title="The Path of Meditation",
        language="EN",
        translated_from="Hindi",
        source_short="The Path of Meditation",
        body=["A translated paragraph."],
    )
    _seed_minimal_db(str(db_path))

    talk = parse_docx(docx_path)
    assert talk.translated_from == "Hindi"
    assert talk.source_short == "The Path of Meditation"

    with sqlite3.connect(db_path) as conn:
        _ensure_translated_from_column(conn)
        _ensure_source_short_column(conn)
        _ensure_role_column(conn)
        upsert(conn, talk)
        row = conn.execute(
            "SELECT translated_from, source_short FROM events WHERE title = ?",
            (talk.title,),
        ).fetchone()
    assert row == ("Hindi", "The Path of Meditation")


def test_source_short_dropped_on_original_record(tmp_path, capsys):
    """Sugit's convention: @sourceShort only applies to translations. If
    it appears on an original-language record the parser warns and drops
    the value rather than mis-storing it as a book-of-origin."""
    docx_path = tmp_path / "original.docx"
    make_docx(
        str(docx_path),
        title="An Original Discourse",
        language="EN",
        translated_from="none",
        source_short="Should Not Stick",
        body=["A body paragraph."],
    )

    talk = parse_docx(docx_path)
    # parse_docx keeps the literal "none" (it's a non-empty string); the
    # drop-rule fires off translated_from.lower() == "none", so the book
    # title is removed even though translated_from itself stays "none".
    assert talk.translated_from == "none"
    assert talk.source_short is None

    err = capsys.readouterr().err
    assert "@sourceShort ignored" in err


def test_translated_from_code_normalised_to_full_name(tmp_path):
    """Sugit writes `@translatedFrom=HI` (or `EN`), same codes as on
    `@language=`. The ingester maps them through `_LANG_MAP` so the
    stored value is the canonical "Hindi"/"English" — matching the
    existing prod data so language-based filters don't fragment."""
    docx_path = tmp_path / "translation.docx"
    make_docx(
        str(docx_path),
        title="Translated Talk",
        language="EN",
        translated_from="HI",
        source_short="A Book",
        body=["body"],
    )
    talk = parse_docx(docx_path)
    assert talk.translated_from == "Hindi"
    assert talk.language == "English"


def test_translated_from_none_passes_through(tmp_path):
    """The literal "none" sentinel must NOT be mapped — it's the
    canonical "this is an original" marker."""
    docx_path = tmp_path / "original.docx"
    make_docx(
        str(docx_path),
        title="Original Talk",
        language="EN",
        translated_from="none",
        body=["body"],
    )
    talk = parse_docx(docx_path)
    assert talk.translated_from == "none"


def test_translated_from_full_name_idempotent(tmp_path):
    """An already-full-name value must pass through unchanged so
    re-ingesting an old-format doc doesn't double-rewrite."""
    docx_path = tmp_path / "old_format.docx"
    make_docx(
        str(docx_path),
        title="Old Format Talk",
        language="EN",
        translated_from="Hindi",
        body=["body"],
    )
    talk = parse_docx(docx_path)
    assert talk.translated_from == "Hindi"


def test_source_short_absent_header_yields_none(tmp_path):
    """Old documents that don't carry @sourceShort still parse cleanly
    with source_short = None — the field is optional."""
    docx_path = tmp_path / "no_source.docx"
    make_docx(
        str(docx_path),
        title="Legacy Talk",
        language="EN",
        translated_from="none",
        body=["A body paragraph."],
    )
    talk = parse_docx(docx_path)
    assert talk.source_short is None
