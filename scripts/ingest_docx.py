"""Bulk-ingest Osho discourses from `.docx` files into the search database.

Each `.docx` follows the format Antar uses (see the example files in the
project root):

    @title=A New Vision of Women's Liberation ~ 01
    @language=EN
    @translatedFrom=none
    @time=1987-03-08-xm
    @theme=         (optional)
    @place=         (optional)
    @eventText=
    <full paragraph 1>

    <full paragraph 2>

    ...

Filename convention (recommended but not required):
    "Talk Title ~ 01_LHI.docx"   — Hindi
    "Talk Title ~ 01_LEN.docx"   — English

Idempotency
-----------
Records are upserted on the composite key (title, language). Re-running this
script on the same `.docx` file updates the existing event in place instead
of creating a duplicate. The FTS rows for that event are regenerated.

Usage
-----
    python3 scripts/ingest_docx.py /path/to/docs/
    python3 scripts/ingest_docx.py one_file.docx

Run on the server. The backend reads from the same `data/osho.db` that this
script writes to, so changes are visible immediately — no restart required
(the FTS5 virtual table is updated transactionally).
"""
from __future__ import annotations

import argparse
import os
import re
import sqlite3
import sys
import unicodedata
import uuid
from dataclasses import dataclass, field
from pathlib import Path

# Re-use the same Devanagari normalisation as build_fts / cloud_api so the
# anusvara-equivalence promise holds for every ingested talk.
from build_fts import normalize_devanagari


BASE_DIR = Path(__file__).resolve().parent.parent
DB_PATH = BASE_DIR / "data" / "osho.db"

# Whitelisted @-fields we read from the doc header.
_HEADER_FIELDS = {
    "title", "language", "translatedfrom", "time", "theme", "place",
    "eventtext",
}

# Match a header line like "@field=value" — the `=` is required; trailing
# whitespace is preserved on the value (we strip it ourselves).
_HEADER_RE = re.compile(r"^@(\w+)\s*=\s*(.*)$")

# Language code from filename suffix _LHI / _LEN / _LZH …
_FILENAME_LANG_RE = re.compile(r"_L([A-Z]{2,3})\.docx$", re.IGNORECASE)

# Two-letter language codes → canonical full names matching the existing DB.
_LANG_MAP = {
    "EN": "English",
    "HI": "Hindi",
}


@dataclass
class Paragraph:
    text: str
    role: str | None = None  # see _normalise_role


@dataclass
class TalkRecord:
    title: str
    language: str
    translated_from: str | None = None
    time: str | None = None
    theme: str | None = None
    place: str | None = None
    paragraphs: list[Paragraph] = field(default_factory=list)
    source_path: str = ""

    @property
    def event_key(self) -> tuple[str, str]:
        """Composite upsert key — same talk in the same language is the same row."""
        return (self.title.strip(), self.language.strip())


# Antar's Word documents tag every paragraph with a `ctp - ...` style that
# carries the semantic role (Osho speaking vs. interviewer vs. sutra vs. poem
# vs. footnote, etc). We strip the prefix and slugify the rest so the role is
# a stable machine identifier the frontend can map to a CSS class. Paragraphs
# without a `ctp -` style get role=None and render as plain body text.
_CTP_STYLE_RE = re.compile(r"^ctp\s*-\s*(.+?)\s*$", re.IGNORECASE)


def _normalise_role(style_name: str | None) -> str | None:
    if not style_name:
        return None
    m = _CTP_STYLE_RE.match(style_name)
    if not m:
        return None
    label = m.group(1).strip().lower()
    # "Sutra/Question" → "sutra_question", "Other Talking 1" → "other_talking_1",
    # "Q & A" → "q_a". `[^\w]+` collapses any run of non-identifier characters
    # so the slug is always a safe map-key / CSS-class fragment.
    slug = re.sub(r"[^\w]+", "_", label).strip("_")
    return slug or None


def _import_python_docx():
    try:
        import docx  # type: ignore
    except ImportError:
        sys.exit(
            "python-docx is not installed. Run: pip install python-docx\n"
            "(or `pip install -r requirements.txt`)"
        )
    return docx


def _read_docx_paragraphs(path: Path) -> list[Paragraph]:
    """Return non-empty paragraphs (text + semantic role) in document order."""
    docx = _import_python_docx()
    doc = docx.Document(str(path))
    out: list[Paragraph] = []
    for p in doc.paragraphs:
        text = p.text
        if not text or not text.strip():
            continue
        style_name = p.style.name if p.style else None
        out.append(Paragraph(text=text, role=_normalise_role(style_name)))
    return out


def _parse_header_and_body(
    paragraphs: list[Paragraph],
) -> tuple[dict[str, str], list[Paragraph]]:
    """Split a list of paragraphs into (header_dict, body_paragraphs).

    The header continues until we hit `@eventText=` (anything after the `=`
    on that line is treated as the first body paragraph, in case the author
    pasted the first paragraph inline). All subsequent paragraphs are body.
    """
    header: dict[str, str] = {}
    body: list[Paragraph] = []
    in_body = False

    for para in paragraphs:
        if in_body:
            body.append(para)
            continue

        m = _HEADER_RE.match(para.text.strip())
        if not m:
            # Header is over the moment we see a non-@ line.
            in_body = True
            body.append(para)
            continue

        key = m.group(1).lower()
        value = m.group(2).rstrip()

        if key == "eventtext":
            in_body = True
            if value:  # rare: content inline on same line as @eventText=
                body.append(Paragraph(text=value, role=para.role))
        elif key in _HEADER_FIELDS:
            header[key] = value
        # silently ignore unknown @-fields so old docs don't error

    return header, body


def _language_from(header: dict[str, str], filename: Path) -> str:
    """Resolve a canonical language name, preferring the @language header.

    Falls back to the `_LXX` suffix on the filename. Codes are mapped to the
    full names already used in the events table (English, Hindi, …).
    """
    raw = header.get("language", "").strip().upper()
    if not raw:
        m = _FILENAME_LANG_RE.search(filename.name)
        raw = m.group(1).upper() if m else ""
    if not raw:
        return "Unknown"
    return _LANG_MAP.get(raw, raw.title())


def parse_docx_header(path: Path) -> tuple[dict[str, str], str]:
    """Parse just the @-field headers from a .docx and return (header, language).

    Used by the Delete flow, where a "delete this record" Word file may be
    empty below the headers (Sugit's convention). `parse_docx` itself
    insists on body paragraphs because it's about ingesting content; for
    deletion we only need the (title, language) identifier."""
    paras = _read_docx_paragraphs(path)
    if not paras:
        raise ValueError(f"{path.name}: empty document (no @title= header found)")
    header, _ = _parse_header_and_body(paras)
    if not header.get("title"):
        raise ValueError(
            f"{path.name}: missing @title= header line "
            f"(found headers: {sorted(header.keys()) or 'none'})"
        )
    return header, _language_from(header, path)


def parse_docx(path: Path) -> TalkRecord:
    """Read a single `.docx` and return a TalkRecord."""
    paras = _read_docx_paragraphs(path)
    if not paras:
        raise ValueError(f"{path.name}: empty document")

    header, body = _parse_header_and_body(paras)
    if not header.get("title"):
        raise ValueError(
            f"{path.name}: missing @title= header line "
            f"(found headers: {sorted(header.keys()) or 'none'})"
        )

    body = [Paragraph(text=p.text.strip(), role=p.role) for p in body if p.text.strip()]
    if not body:
        raise ValueError(f"{path.name}: no body paragraphs after @eventText=")

    return TalkRecord(
        title=header["title"].strip(),
        language=_language_from(header, path),
        translated_from=(header.get("translatedfrom") or "").strip() or None,
        time=(header.get("time") or "").strip() or None,
        theme=(header.get("theme") or "").strip() or None,
        place=(header.get("place") or "").strip() or None,
        paragraphs=body,
        source_path=str(path),
    )


# ─── Database upsert ────────────────────────────────────────────────────────

def _ensure_translated_from_column(conn: sqlite3.Connection) -> None:
    cols = {r[1] for r in conn.execute("PRAGMA table_info(events)").fetchall()}
    if "translated_from" not in cols:
        conn.execute("ALTER TABLE events ADD COLUMN translated_from TEXT")


def _ensure_role_column(conn: sqlite3.Connection) -> None:
    cols = {r[1] for r in conn.execute("PRAGMA table_info(paragraphs)").fetchall()}
    if "role" not in cols:
        conn.execute("ALTER TABLE paragraphs ADD COLUMN role TEXT")


def _find_existing_event_id(conn: sqlite3.Connection, title: str, language: str) -> str | None:
    row = conn.execute(
        "SELECT id FROM events WHERE title = ? AND COALESCE(language, '') = ?",
        (title, language),
    ).fetchone()
    return row[0] if row else None


def _delete_event_rows(conn: sqlite3.Connection, event_id: str) -> None:
    """Remove all paragraph + FTS + tag rows for an event. Used before re-inserting."""
    para_ids = [
        r[0]
        for r in conn.execute(
            "SELECT id FROM paragraphs WHERE event_id = ?", (event_id,)
        ).fetchall()
    ]
    if para_ids:
        placeholders = ",".join("?" * len(para_ids))
        conn.execute(
            f"DELETE FROM paragraphs_fts WHERE rowid IN ({placeholders})",
            para_ids,
        )
    conn.execute("DELETE FROM paragraphs WHERE event_id = ?", (event_id,))


def delete_record(
    conn: sqlite3.Connection, title: str, language: str
) -> tuple[str | None, int]:
    """Remove the (title, language) record entirely. Returns (event_id, paragraph_count)
    of what was deleted, or (None, 0) if no such record existed."""
    event_id = _find_existing_event_id(conn, title, language)
    if not event_id:
        return None, 0
    para_count = conn.execute(
        "SELECT COUNT(*) FROM paragraphs WHERE event_id = ?", (event_id,)
    ).fetchone()[0]
    _delete_event_rows(conn, event_id)
    if conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='event_tags'"
    ).fetchone():
        conn.execute("DELETE FROM event_tags WHERE event_id = ?", (event_id,))
    conn.execute("DELETE FROM events WHERE id = ?", (event_id,))
    return event_id, para_count


def upsert(conn: sqlite3.Connection, talk: TalkRecord) -> tuple[str, bool]:
    """Insert or replace a talk in the DB. Returns (event_id, created_new)."""
    existing_id = _find_existing_event_id(conn, talk.title, talk.language)

    if existing_id:
        # Refresh metadata + paragraph rows. Keep the same event_id so
        # external references (bookmarks, analytics) stay stable.
        conn.execute(
            "UPDATE events SET date = ?, location = ?, language = ?, "
            "translated_from = ? WHERE id = ?",
            (talk.time, talk.place, talk.language, talk.translated_from, existing_id),
        )
        _delete_event_rows(conn, existing_id)
        event_id, created_new = existing_id, False
    else:
        event_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO events (id, title, date, location, language, translated_from) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (event_id, talk.title, talk.time, talk.place, talk.language, talk.translated_from),
        )
        created_new = True

    conn.executemany(
        "INSERT INTO paragraphs (event_id, sequence_number, content, role, is_embedded) "
        "VALUES (?, ?, ?, ?, 0)",
        [
            (event_id, i, p.text, p.role)
            for i, p in enumerate(talk.paragraphs, start=1)
        ],
    )

    # Reinsert the FTS rows from the fresh paragraph rows, normalising
    # Devanagari to the same canonical form the rest of the index uses.
    norm_title = normalize_devanagari(talk.title)
    rows = conn.execute(
        "SELECT id, sequence_number, content FROM paragraphs WHERE event_id = ?",
        (event_id,),
    ).fetchall()
    conn.executemany(
        """
        INSERT INTO paragraphs_fts
            (content, title, event_id, paragraph_id, sequence_number, title_search)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        [
            (
                normalize_devanagari(content or ""),
                norm_title,
                event_id,
                pid,
                seq,
                norm_title,
            )
            for pid, seq, content in rows
        ],
    )

    # Optional @theme override — write as an event tag.
    if talk.theme:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS event_tags ("
            "event_id TEXT, tag TEXT, PRIMARY KEY (event_id, tag))"
        )
        conn.execute(
            "INSERT OR IGNORE INTO event_tags (event_id, tag) VALUES (?, ?)",
            (event_id, talk.theme.lower()),
        )

    return event_id, created_new


# ─── CLI ────────────────────────────────────────────────────────────────────

def _walk(path: Path) -> list[Path]:
    if path.is_file():
        return [path] if path.suffix.lower() == ".docx" else []
    return sorted(p for p in path.rglob("*.docx") if not p.name.startswith("~$"))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("path", type=Path, help="A .docx file, or a directory to walk")
    ap.add_argument("--dry-run", action="store_true", help="Parse but do not write to DB")
    ap.add_argument("--db", type=Path, default=DB_PATH, help=f"SQLite path (default {DB_PATH})")
    args = ap.parse_args(argv)

    if not args.path.exists():
        print(f"ERROR: {args.path} does not exist", file=sys.stderr)
        return 2

    files = _walk(args.path)
    if not files:
        print(f"No .docx files found under {args.path}", file=sys.stderr)
        return 0

    print(f"Found {len(files)} .docx file(s)")

    if args.dry_run:
        for f in files:
            try:
                talk = parse_docx(f)
                print(
                    f"  OK   {f.name}: title={talk.title!r} "
                    f"language={talk.language} paragraphs={len(talk.paragraphs)}"
                )
            except Exception as ex:
                print(f"  FAIL {f.name}: {ex}")
        return 0

    if not args.db.exists():
        print(f"ERROR: DB not found at {args.db}", file=sys.stderr)
        return 2

    new_count = 0
    updated_count = 0
    failed_count = 0
    with sqlite3.connect(args.db) as conn:
        _ensure_translated_from_column(conn)
        _ensure_role_column(conn)
        for f in files:
            try:
                talk = parse_docx(f)
                _, created_new = upsert(conn, talk)
                if created_new:
                    new_count += 1
                    print(f"  NEW    {talk.title}  [{talk.language}]  ({len(talk.paragraphs)} para)")
                else:
                    updated_count += 1
                    print(f"  UPDATE {talk.title}  [{talk.language}]  ({len(talk.paragraphs)} para)")
            except Exception as ex:
                failed_count += 1
                print(f"  FAIL   {f.name}: {ex}", file=sys.stderr)
        conn.commit()

    print(
        f"\nDone: {new_count} new, {updated_count} updated, {failed_count} failed."
    )
    if failed_count:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
