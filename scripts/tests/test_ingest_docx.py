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
    Paragraph,
    TalkRecord,
    _canonical_title,
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


# ── Duplicate prevention — Sugit's Issue 8 (2026-06-27) ───────────────────
#
# Two records that look identical on screen ("Sarvasar Upanishad ~ 07",
# English) appeared twice in the archive. Root cause: the upsert matched the
# existing record by a BYTE-EXACT title, so a title differing only by an
# invisible character (Unicode form, whitespace, or which dash/tilde glyph
# was typed) missed and created a second event. `_canonical_title` +
# `_find_existing_event_id`'s fallback fix it; these tests pin the contract.


@pytest.mark.parametrize(
    "a, b",
    [
        # Same talk, different separator glyph.
        ("Sarvasar Upanishad ~ 07", "Sarvasar Upanishad ～ 07"),  # fullwidth tilde
        ("Sarvasar Upanishad ~ 07", "Sarvasar Upanishad – 07"),  # en-dash
        ("Sarvasar Upanishad ~ 07", "Sarvasar Upanishad — 07"),  # em-dash
        ("Sarvasar Upanishad ~ 07", "Sarvasar Upanishad - 07"),       # ASCII hyphen
        ("Sarvasar Upanishad ~ 07", "Sarvasar Upanishad − 07"),  # minus sign
        # Whitespace noise.
        ("Sarvasar Upanishad ~ 07", "Sarvasar  Upanishad ~ 07"),       # double space
        ("Sarvasar Upanishad ~ 07", "Sarvasar Upanishad ~ 07"),   # non-breaking space
        ("Sarvasar Upanishad ~ 07", "  Sarvasar Upanishad ~ 07  "),    # surrounding ws
        # Unicode normal form (NFC vs NFD) and case.
        ("Café Talk ~ 01", "Café Talk ~ 01"),              # composed vs decomposed
        ("The Book Of Secrets ~ 01", "the book of secrets ~ 01"),     # case
    ],
)
def test_canonical_title_collapses_cosmetic_differences(a, b):
    assert _canonical_title(a) == _canonical_title(b)


@pytest.mark.parametrize(
    "a, b",
    [
        # Different part number is a different talk — must NOT collapse.
        ("Sarvasar Upanishad ~ 07", "Sarvasar Upanishad ~ 08"),
        ("The Mustard Seed ~ 04", "The Mustard Seed ~ 14"),
        ("Dhammapada ~ 03", "Dhammapada ~ 30"),
        # Genuinely different titles.
        ("A Rose Is a Rose ~ 01", "A Lotus Is a Lotus ~ 01"),
    ],
)
def test_canonical_title_keeps_distinct_talks_distinct(a, b):
    assert _canonical_title(a) != _canonical_title(b)


def test_upsert_is_idempotent_no_duplicate(tmp_path):
    """Re-ingesting the exact same talk updates in place — one event, not two."""
    db = tmp_path / "test.db"
    _seed_minimal_db(str(db))
    talk = TalkRecord(
        title="Idempotent Talk ~ 01",
        language="English",
        paragraphs=[Paragraph("Body.")],
    )
    with sqlite3.connect(str(db)) as conn:
        _ensure_translated_from_column(conn)
        _ensure_source_short_column(conn)
        _ensure_role_column(conn)
        _, new1 = upsert(conn, talk)
        _, new2 = upsert(conn, talk)
        n = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    assert new1 is True and new2 is False
    assert n == 1


def test_upsert_matches_despite_invisible_title_difference(tmp_path):
    """Issue 8: a second ingest whose title differs only invisibly from an
    existing record updates that record in place instead of duplicating it."""
    db = tmp_path / "test.db"
    _seed_minimal_db(str(db))
    with sqlite3.connect(str(db)) as conn:
        _ensure_translated_from_column(conn)
        _ensure_source_short_column(conn)
        _ensure_role_column(conn)
        # As it sits in the legacy corpus.
        _, new1 = upsert(conn, TalkRecord(
            title="Sarvasar Upanishad ~ 07",
            language="English",
            paragraphs=[Paragraph("Original body.")],
        ))
        # Same talk re-ingested: fullwidth tilde + non-breaking space +
        # trailing whitespace — identical to a human, different bytes.
        _, new2 = upsert(conn, TalkRecord(
            title="Sarvasar Upanishad ～ 07 ",
            language="English",
            paragraphs=[Paragraph("Updated body.")],
        ))
        n_events = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        bodies = [
            r[0] for r in conn.execute(
                "SELECT content FROM paragraphs ORDER BY id"
            ).fetchall()
        ]
    assert new1 is True
    assert new2 is False, "invisible title difference was treated as a new record"
    assert n_events == 1, "a duplicate event was created (Issue 8 regression)"
    assert bodies == ["Updated body."], "existing record was not updated in place"


def test_misnamed_file_upserts_by_internal_title_not_filename(tmp_path):
    """Remark 10 (Sugit): a .docx whose FILENAME disagrees with its internal
    @title= is ingested under the @title — the filename is cosmetic. A file
    named "… ~ 33_LEN.docx" carrying @title=… ~ 01 updates the ~ 01 record and
    creates no ~ 33 record. (This is intended behaviour, documented as a test
    so it isn't mistaken for a bug later.)"""
    db = tmp_path / "test.db"
    _seed_minimal_db(str(db))
    seed_path = tmp_path / "rose01.docx"
    make_docx(str(seed_path), title="A Rose Is a Rose ~ 01", language="EN",
              body=["First version."])
    # Filename says ~ 33, but @title inside says ~ 01.
    misnamed = tmp_path / "A Rose Is a Rose ~ 33_LEN.docx"
    make_docx(str(misnamed), title="A Rose Is a Rose ~ 01", language="EN",
              body=["Second version."])
    with sqlite3.connect(str(db)) as conn:
        _ensure_translated_from_column(conn)
        _ensure_source_short_column(conn)
        _ensure_role_column(conn)
        upsert(conn, parse_docx(seed_path))
        upsert(conn, parse_docx(misnamed))
        titles = [
            r[0] for r in conn.execute(
                "SELECT title FROM events ORDER BY title"
            ).fetchall()
        ]
    assert titles == ["A Rose Is a Rose ~ 01"], "filename leaked into record identity"
