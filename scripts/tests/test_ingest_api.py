"""Tests for the self-service ingestion endpoints:
    GET  /api/version
    POST /admin/upload-docx
    POST /admin/batch-update
"""
import io
import os
import time
import zipfile

import pytest
from _helpers import make_docx


# ── Helpers ──────────────────────────────────────────────────────────────────


def _make_zip(files: dict) -> bytes:
    """Build an in-memory zip.

    files: { "path/inside/zip.docx": pathlib.Path | bytes }
    Pass a Path to embed a real docx; pass bytes for raw content.
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, src in files.items():
            if isinstance(src, (str, type(None))):
                zf.writestr(name, src or b"")
            elif hasattr(src, "read_bytes"):
                zf.writestr(name, src.read_bytes())
            else:
                zf.writestr(name, src)
    return buf.getvalue()


ADMIN_HEADERS = {"x-admin-key": "osho-admin"}
BAD_ADMIN_HEADERS = {"x-admin-key": "wrong-key"}


# ── /api/version ─────────────────────────────────────────────────────────────


def test_version_returns_null_when_not_set(app_client):
    r = app_client.get("/api/version")
    assert r.status_code == 200
    assert r.json()["corpus_version"] is None


# ── /admin/upload-docx ───────────────────────────────────────────────────────


def test_upload_docx_rejects_wrong_admin_key(app_client, tmp_path):
    docx = tmp_path / "talk.docx"
    make_docx(docx)
    z = _make_zip({"talk.docx": docx})
    r = app_client.post(
        "/admin/upload-docx",
        headers=BAD_ADMIN_HEADERS,
        files={"file": ("corpus.zip", z, "application/zip")},
    )
    assert r.status_code == 401


def test_upload_docx_single_file(app_client, tmp_path):
    docx = tmp_path / "Sample Discourse ~ 01_LEN.docx"
    make_docx(docx)
    z = _make_zip({"Sample Discourse ~ 01_LEN.docx": docx})
    r = app_client.post(
        "/admin/upload-docx",
        headers=ADMIN_HEADERS,
        files={"file": ("corpus.zip", z, "application/zip")},
        data={"dry_run": "false"},
    )
    assert r.status_code == 200
    d = r.json()
    assert d["ok"] is True
    assert d["processed"] == 1
    assert d["failed"] == 0
    assert d["dry_run"] is False


def test_upload_docx_dry_run_makes_no_change(app_client, tmp_path):
    docx = tmp_path / "DryRun Discourse ~ 01_LEN.docx"
    make_docx(docx, title="DryRun Discourse ~ 01")
    z = _make_zip({"DryRun Discourse ~ 01_LEN.docx": docx})
    r = app_client.post(
        "/admin/upload-docx",
        headers=ADMIN_HEADERS,
        files={"file": ("corpus.zip", z, "application/zip")},
        data={"dry_run": "true"},
    )
    assert r.status_code == 200
    d = r.json()
    assert d["dry_run"] is True
    assert d["processed"] == 1
    # Event must NOT be in the DB after a dry run.
    search = app_client.get("/api/search?q=DryRun+Discourse")
    assert all(
        e["title"] != "DryRun Discourse ~ 01"
        for e in search.json().get("events", [])
    )


def test_upload_docx_skips_texts_by_others(app_client, tmp_path):
    good = tmp_path / "good.docx"
    make_docx(good, title="Good Discourse ~ 01")
    bad = tmp_path / "bad.docx"
    make_docx(bad, title="Bad Discourse ~ 01")
    z = _make_zip({
        "English/good.docx": good,
        "Texts by Others/bad.docx": bad,
    })
    r = app_client.post(
        "/admin/upload-docx",
        headers=ADMIN_HEADERS,
        files={"file": ("corpus.zip", z, "application/zip")},
        data={"dry_run": "false"},
    )
    assert r.status_code == 200
    d = r.json()
    assert d["processed"] == 1
    assert d["failed"] == 0


def test_upload_docx_invalid_file_recorded_as_failure(app_client):
    z = _make_zip({"not_a_docx.docx": b"this is not a docx"})
    r = app_client.post(
        "/admin/upload-docx",
        headers=ADMIN_HEADERS,
        files={"file": ("corpus.zip", z, "application/zip")},
        data={"dry_run": "false"},
    )
    assert r.status_code == 200
    d = r.json()
    assert d["failed"] == 1
    assert len(d["failures"]) == 1
    assert "not_a_docx.docx" in d["failures"][0]["file"]


def test_upload_docx_not_a_zip_returns_400(app_client):
    r = app_client.post(
        "/admin/upload-docx",
        headers=ADMIN_HEADERS,
        files={"file": ("fake.zip", b"not a zip at all", "application/zip")},
        data={"dry_run": "false"},
    )
    assert r.status_code == 400


def test_upload_docx_saves_corpus_version(app_client, tmp_path):
    docx = tmp_path / "talk.docx"
    make_docx(docx)
    z = _make_zip({"talk.docx": docx})
    r = app_client.post(
        "/admin/upload-docx",
        headers=ADMIN_HEADERS,
        files={"file": ("corpus.zip", z, "application/zip")},
        data={"dry_run": "false", "corpus_version": "2026-05-24"},
    )
    assert r.status_code == 200
    assert r.json()["corpus_version"] == "2026-05-24"
    ver = app_client.get("/api/version")
    assert ver.json()["corpus_version"] == "2026-05-24"


# ── /admin/batch-update ───────────────────────────────────────────────────────


def _batch_zip(subfolder: str, files: dict, wrapper: str | None = None) -> bytes:
    """Build a batch-update zip with Add/Modify/Delete structure.

    wrapper: if set, wraps everything under a dated folder, e.g. "WordDB 2027-01-01".
    """
    prefix = f"{wrapper}/" if wrapper else ""
    return _make_zip({f"{prefix}{subfolder}/{name}": src for name, src in files.items()})


def test_batch_update_add(app_client, tmp_path):
    docx = tmp_path / "New Talk ~ 01_LEN.docx"
    make_docx(docx, title="New Talk ~ 01")
    z = _batch_zip("Add", {"New Talk ~ 01_LEN.docx": docx})
    r = app_client.post(
        "/admin/batch-update",
        headers=ADMIN_HEADERS,
        files={"file": ("update.zip", z, "application/zip")},
        data={"dry_run": "false"},
    )
    assert r.status_code == 200
    d = r.json()
    assert d["added"] == 1
    assert d["failed"] == 0


def test_batch_update_modify(app_client, tmp_path):
    # First add the record.
    add_docx = tmp_path / "mod_talk.docx"
    make_docx(add_docx, title="Modifiable Talk ~ 01", body=["Original content paragraph."])
    z_add = _batch_zip("Add", {"mod_talk.docx": add_docx})
    app_client.post(
        "/admin/batch-update",
        headers=ADMIN_HEADERS,
        files={"file": ("add.zip", z_add, "application/zip")},
        data={"dry_run": "false"},
    )
    # Now modify it.
    mod_docx = tmp_path / "mod_talk2.docx"
    make_docx(mod_docx, title="Modifiable Talk ~ 01", body=["Updated content paragraph."])
    z_mod = _batch_zip("Modify", {"mod_talk2.docx": mod_docx})
    r = app_client.post(
        "/admin/batch-update",
        headers=ADMIN_HEADERS,
        files={"file": ("mod.zip", z_mod, "application/zip")},
        data={"dry_run": "false"},
    )
    assert r.status_code == 200
    d = r.json()
    assert d["modified"] == 1
    assert d["failed"] == 0


def test_batch_update_delete(app_client, tmp_path):
    # Add first.
    add_docx = tmp_path / "del_talk.docx"
    make_docx(add_docx, title="Deletable Talk ~ 01")
    z_add = _batch_zip("Add", {"del_talk.docx": add_docx})
    app_client.post(
        "/admin/batch-update",
        headers=ADMIN_HEADERS,
        files={"file": ("add.zip", z_add, "application/zip")},
        data={"dry_run": "false"},
    )
    # Delete it.
    del_docx = tmp_path / "del_talk_del.docx"
    make_docx(del_docx, title="Deletable Talk ~ 01", body=[])
    z_del = _batch_zip("Delete", {"del_talk_del.docx": del_docx})
    r = app_client.post(
        "/admin/batch-update",
        headers=ADMIN_HEADERS,
        files={"file": ("del.zip", z_del, "application/zip")},
        data={"dry_run": "false"},
    )
    assert r.status_code == 200
    assert r.json()["deleted"] == 1


def test_batch_update_dry_run(app_client, tmp_path):
    docx = tmp_path / "dry_talk.docx"
    make_docx(docx, title="DryBatch Talk ~ 01")
    z = _batch_zip("Add", {"dry_talk.docx": docx})
    r = app_client.post(
        "/admin/batch-update",
        headers=ADMIN_HEADERS,
        files={"file": ("update.zip", z, "application/zip")},
        data={"dry_run": "true"},
    )
    assert r.status_code == 200
    d = r.json()
    assert d["dry_run"] is True
    assert d["added"] == 1
    # Nothing committed.
    search = app_client.get("/api/search?q=DryBatch+Talk")
    assert all(e["title"] != "DryBatch Talk ~ 01" for e in search.json().get("events", []))


def test_batch_update_nested_dated_folder(app_client, tmp_path):
    docx = tmp_path / "nested.docx"
    make_docx(docx, title="Nested Update Talk ~ 01")
    z = _batch_zip("Add", {"nested.docx": docx}, wrapper="WordDB 2027-01-01")
    r = app_client.post(
        "/admin/batch-update",
        headers=ADMIN_HEADERS,
        files={"file": ("update.zip", z, "application/zip")},
        data={"dry_run": "false"},
    )
    assert r.status_code == 200
    assert r.json()["added"] == 1


def test_batch_update_add_fails_if_record_exists(app_client, tmp_path):
    """Adding a record that already exists must fail and roll back."""
    docx = tmp_path / "exists.docx"
    make_docx(docx, title="Existing Talk ~ 01")
    z = _batch_zip("Add", {"exists.docx": docx})
    # Add once — succeeds.
    app_client.post(
        "/admin/batch-update",
        headers=ADMIN_HEADERS,
        files={"file": ("add1.zip", z, "application/zip")},
        data={"dry_run": "false"},
    )
    # Add again — the existing record should cause a failure and rollback.
    r = app_client.post(
        "/admin/batch-update",
        headers=ADMIN_HEADERS,
        files={"file": ("add2.zip", z, "application/zip")},
        data={"dry_run": "false"},
    )
    assert r.status_code == 200
    d = r.json()
    assert d["failed"] == 1


def test_batch_update_saves_corpus_version(app_client, tmp_path):
    docx = tmp_path / "ver_talk.docx"
    make_docx(docx, title="Version Talk ~ 01")
    z = _batch_zip("Add", {"ver_talk.docx": docx})
    r = app_client.post(
        "/admin/batch-update",
        headers=ADMIN_HEADERS,
        files={"file": ("update.zip", z, "application/zip")},
        data={"dry_run": "false", "corpus_version": "2027-01-01"},
    )
    assert r.status_code == 200
    assert r.json()["corpus_version"] == "2027-01-01"
    assert app_client.get("/api/version").json()["corpus_version"] == "2027-01-01"


def test_batch_update_no_subdirs_returns_400(app_client, tmp_path):
    docx = tmp_path / "stray.docx"
    make_docx(docx)
    # Zip with a .docx at the top level (no Add/Modify/Delete dirs).
    z = _make_zip({"stray.docx": docx})
    r = app_client.post(
        "/admin/batch-update",
        headers=ADMIN_HEADERS,
        files={"file": ("bad.zip", z, "application/zip")},
        data={"dry_run": "false"},
    )
    assert r.status_code == 400


# ── /admin/reindex (no-downtime search-index rebuild) ─────────────────────────


def _wait_reindex(app_client, timeout=15.0):
    """Poll the status endpoint until the background rebuild finishes."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = app_client.get("/admin/reindex-status", headers=ADMIN_HEADERS)
        assert r.status_code == 200
        st = r.json()
        if st["state"] in ("done", "error"):
            return st
        time.sleep(0.05)
    raise AssertionError("reindex did not finish within the timeout")


def test_reindex_rejects_wrong_admin_key(app_client):
    assert app_client.post("/admin/reindex", headers=BAD_ADMIN_HEADERS).status_code == 401
    assert app_client.get("/admin/reindex-status", headers=BAD_ADMIN_HEADERS).status_code == 401


def test_reindex_runs_and_search_still_works(app_client):
    # Search works before the rebuild.
    assert app_client.get("/api/search?q=meditation").status_code == 200

    r = app_client.post("/admin/reindex", headers=ADMIN_HEADERS)
    assert r.status_code == 200
    assert r.json()["state"] == "running"

    st = _wait_reindex(app_client)
    assert st["state"] == "done", st
    assert st["total"] > 0
    assert st["done"] == st["total"]

    # Search still works after the atomic table swap.
    after = app_client.get("/api/search?q=meditation")
    assert after.status_code == 200
    assert after.json()["total"] >= 1


def test_reindex_syncs_the_exact_index_that_ingest_leaves_stale(app_client, tmp_path):
    """The point of the button: bulk ingest populates the stemmed index but
    NOT the exact one, so a freshly-ingested record is invisible to Exact
    search until a rebuild. The reindex is what closes that gap."""
    docx = tmp_path / "Reindex Proof ~ 01_LEN.docx"
    make_docx(docx, title="Reindex Proof ~ 01",
              body=["A uniquewordxyz marker paragraph."])
    z = _make_zip({"Reindex Proof ~ 01_LEN.docx": docx})
    r = app_client.post("/admin/upload-docx", headers=ADMIN_HEADERS,
                        files={"file": ("c.zip", z, "application/zip")},
                        data={"dry_run": "false"})
    assert r.json()["processed"] == 1

    # Exact search MISSES before a reindex (ingest never touched the exact table).
    miss = app_client.get("/api/search?q=uniquewordxyz&exact=true")
    assert miss.status_code == 200
    assert miss.json()["total"] == 0

    app_client.post("/admin/reindex", headers=ADMIN_HEADERS)
    assert _wait_reindex(app_client)["state"] == "done"

    # After the rebuild the exact index carries it.
    hit = app_client.get("/api/search?q=uniquewordxyz&exact=true")
    assert hit.status_code == 200
    assert hit.json()["total"] == 1


# ── /admin/records-csv (dump title;language for corpus reconciliation) ────────


def test_records_csv_rejects_wrong_admin_key(app_client):
    assert (
        app_client.get("/admin/records-csv", headers=BAD_ADMIN_HEADERS).status_code
        == 401
    )


def test_records_csv_dumps_every_record(app_client):
    r = app_client.get("/admin/records-csv", headers=ADMIN_HEADERS)
    assert r.status_code == 200
    d = r.json()

    # The count matches the number of titled events the admin list reports,
    # so the dump can't silently drop or duplicate records.
    events_total = app_client.get(
        "/admin/events?per_page=1", headers=ADMIN_HEADERS
    ).json()["total"]
    assert d["count"] == events_total
    assert d["count"] >= 17  # sanity: the seed corpus

    lines = d["csv"].splitlines()
    assert lines[0] == "title;language"          # header first
    assert len(lines) == d["count"] + 1          # then one row per record

    # Known English + Hindi records are present, semicolon-delimited.
    assert "The Book of Secrets ~ 01;English" in lines
    assert "Dekh Kabira Roya ~ 17;Hindi" in lines

    # Rows are grouped by language (ORDER BY language, title) — English before
    # Hindi — which is what makes the file easy to diff against source folders.
    langs = [ln.rsplit(";", 1)[1] for ln in lines[1:]]
    first_hindi = langs.index("Hindi")
    assert all(l == "English" for l in langs[:first_hindi])
    assert all(l == "Hindi" for l in langs[first_hindi:])


def test_records_csv_quotes_a_title_containing_the_delimiter(app_client, tmp_path):
    """A title that itself contains ';' must be CSV-quoted, so a stray
    delimiter can't split one record into a phantom extra column."""
    docx = tmp_path / "weird.docx"
    make_docx(docx, title="Weird; Title ~ 01")
    z = _make_zip({"weird.docx": docx})
    app_client.post(
        "/admin/upload-docx",
        headers=ADMIN_HEADERS,
        files={"file": ("c.zip", z, "application/zip")},
        data={"dry_run": "false"},
    )

    csv_text = app_client.get("/admin/records-csv", headers=ADMIN_HEADERS).json()["csv"]
    assert '"Weird; Title ~ 01"' in csv_text  # the field is quoted

    # And it round-trips through a real CSV parser into exactly two columns.
    import csv as _csv

    rows = list(_csv.reader(io.StringIO(csv_text), delimiter=";"))
    weird = [row for row in rows if row and row[0] == "Weird; Title ~ 01"]
    assert len(weird) == 1 and len(weird[0]) == 2


# ── Importer hardening — Sugit's 2026-07-02 double-zip / mislabel incident ──


def test_upload_docx_double_zip_rejected(app_client):
    """A zip that contains only another zip (no .docx) is rejected loudly with a
    'double-zipped' hint — never silently accepted as a 0-file success."""
    inner = _make_zip({"talk.docx": b"stub"})
    outer = _make_zip({"from X to Y/OCTP.zip": inner})
    r = app_client.post(
        "/admin/upload-docx", headers=ADMIN_HEADERS,
        files={"file": ("corpus.zip", outer, "application/zip")},
        data={"dry_run": "true"},
    )
    assert r.status_code == 400
    assert "double-zip" in r.json()["detail"].lower()


def test_upload_docx_surfaces_title_content_warning(app_client, tmp_path):
    """A file whose @title names a different discourse than its body imports but
    is flagged in the response `warnings` (would have caught the Zen/Birthday)."""
    docx = tmp_path / "zen.docx"
    make_docx(docx, title="Zen The Path of Paradox Vol 1 ~ 01",
              body=["Birthday Celebration 1978 ~ 01", "body text"])
    z = _make_zip({"zen.docx": docx})
    r = app_client.post(
        "/admin/upload-docx", headers=ADMIN_HEADERS,
        files={"file": ("corpus.zip", z, "application/zip")},
        data={"dry_run": "true"},
    )
    assert r.status_code == 200
    d = r.json()
    assert d["processed"] == 1
    assert len(d["warnings"]) == 1
    assert "mismatch" in d["warnings"][0]["warning"].lower()


def test_batch_update_empty_folders_rejected(app_client):
    """Add/Modify/Delete present but no .docx inside → rejected, not a silent
    0-change 'success'."""
    z = _make_zip({"Add/readme.txt": b"not a docx"})
    r = app_client.post(
        "/admin/batch-update", headers=ADMIN_HEADERS,
        files={"file": ("update.zip", z, "application/zip")},
        data={"dry_run": "true"},
    )
    assert r.status_code == 400
    assert "no .docx" in r.json()["detail"].lower()


# ── Chunked upload ───────────────────────────────────────────────────────────
#
# nginx caps a request body at 10 MB and Cloudflare at 100 MB, neither raisable
# from the deploy account — that ceiling is what silently failed the 2026-08-01
# corpus update. Big zips are therefore sliced client-side and reassembled here.


def _upload_in_chunks(client, payload: bytes, chunk_size: int, headers=ADMIN_HEADERS):
    """Mirror the browser's slice loop; return the final upload id."""
    upload_id = ""
    for start in range(0, len(payload), chunk_size):
        data = {"upload_id": upload_id} if upload_id else {}
        r = client.post(
            "/admin/upload-chunk", headers=headers,
            files={"chunk": ("slice", payload[start:start + chunk_size],
                             "application/octet-stream")},
            data=data,
        )
        assert r.status_code == 200, r.text
        upload_id = r.json()["upload_id"]
    return upload_id


def test_chunked_upload_matches_a_direct_upload(app_client, tmp_path):
    """The whole point: a zip delivered in slices must ingest exactly as if it
    had been posted in one request."""
    docx = tmp_path / "talk.docx"
    make_docx(docx, title="Chunked Talk ~ 01", body=["first line", "second line"])
    z = _make_zip({"English/talk.docx": docx})

    # Slice small enough that this zip genuinely spans several requests.
    upload_id = _upload_in_chunks(app_client, z, chunk_size=64)

    r = app_client.post(
        "/admin/upload-docx", headers=ADMIN_HEADERS,
        data={"upload_id": upload_id, "dry_run": "false"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["processed"] == 1
    assert r.json()["failed"] == 0

    # And the record really landed.
    rows = app_client.get("/admin/events?q=Chunked Talk", headers=ADMIN_HEADERS)
    assert any(e["title"] == "Chunked Talk ~ 01" for e in rows.json()["events"])


def test_chunked_batch_update_applies(app_client, tmp_path):
    """The structured Add/Modify/Delete path accepts a chunked upload too."""
    docx = tmp_path / "add.docx"
    make_docx(docx, title="Chunked Added ~ 01", body=["body"])
    z = _make_zip({"Add/add.docx": docx})

    upload_id = _upload_in_chunks(app_client, z, chunk_size=100)
    r = app_client.post(
        "/admin/batch-update", headers=ADMIN_HEADERS,
        data={"upload_id": upload_id, "dry_run": "false"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["added"] == 1
    assert r.json()["failed"] == 0


def test_chunked_upload_reassembles_bytes_exactly(app_client):
    """A corrupt reassembly would show up as a bad zip, not a wrong result —
    assert the boundary case where the payload doesn't divide evenly."""
    z = _make_zip({f"Add/f{i}.docx": b"x" * 500 for i in range(20)})
    assert len(z) % 333 != 0, "pick a chunk size that leaves a partial tail"
    upload_id = _upload_in_chunks(app_client, z, chunk_size=333)

    # Not valid .docx content, so the batch is rejected for that reason —
    # proving the zip itself was reassembled and opened correctly.
    r = app_client.post(
        "/admin/batch-update", headers=ADMIN_HEADERS,
        data={"upload_id": upload_id, "dry_run": "true"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["failed"] == 20


def test_upload_chunk_requires_admin(app_client):
    r = app_client.post(
        "/admin/upload-chunk", headers=BAD_ADMIN_HEADERS,
        files={"chunk": ("slice", b"data", "application/octet-stream")},
    )
    assert r.status_code == 401


def test_upload_chunk_rejects_forged_upload_id(app_client):
    """The id becomes a filesystem path, so a traversal attempt must be
    refused rather than appended to some file outside the staging dir."""
    for forged in ("../../../../tmp/pwned", "not-hex", "a" * 31, ""):
        r = app_client.post(
            "/admin/upload-chunk", headers=ADMIN_HEADERS,
            files={"chunk": ("slice", b"data", "application/octet-stream")},
            data={"upload_id": forged},
        )
        # "" means "start a new upload" and is legitimately accepted.
        expected = 200 if forged == "" else 400
        assert r.status_code == expected, f"{forged!r} → {r.status_code}"


def test_ingest_with_unknown_upload_id_is_rejected(app_client):
    """An expired/swept upload must fail loudly, never ingest nothing and
    report success (the 2026-07-02 silent-no-op lesson)."""
    r = app_client.post(
        "/admin/batch-update", headers=ADMIN_HEADERS,
        data={"upload_id": "0" * 32, "dry_run": "true"},
    )
    assert r.status_code == 409
    assert "try again" in r.json()["detail"].lower()


def test_ingest_without_file_or_upload_id_is_rejected(app_client):
    r = app_client.post(
        "/admin/upload-docx", headers=ADMIN_HEADERS, data={"dry_run": "true"},
    )
    assert r.status_code == 400
    assert "no file" in r.json()["detail"].lower()


def test_staged_upload_is_deleted_after_ingest(app_client, tmp_path):
    """Staging files are hundreds of MB; leaving them behind fills the box."""
    from scripts.cloud_api import _upload_path

    docx = tmp_path / "talk.docx"
    make_docx(docx, title="Cleanup Talk ~ 01", body=["body"])
    upload_id = _upload_in_chunks(app_client, _make_zip({"t.docx": docx}), chunk_size=128)
    assert os.path.exists(_upload_path(upload_id))

    app_client.post(
        "/admin/upload-docx", headers=ADMIN_HEADERS,
        data={"upload_id": upload_id, "dry_run": "true"},
    )
    assert not os.path.exists(_upload_path(upload_id))


# ── Background ingest ────────────────────────────────────────────────────────
#
# The admin UI runs every ingest with background=true: the POST returns
# immediately and the result arrives via GET /admin/ingest-status. This is
# what makes the flow immune to the proxies' request timeouts (nginx 30 s,
# Cloudflare ~100 s) that killed Anuragi's 295-file Add batch on 2026-08-02.


def _poll_ingest_done(client, timeout_s: float = 30.0) -> dict:
    """Poll /admin/ingest-status until it leaves 'running'; return the status."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        s = client.get("/admin/ingest-status", headers=ADMIN_HEADERS).json()
        if s["state"] in ("done", "error"):
            return s
        time.sleep(0.05)
    raise AssertionError("background ingest did not finish in time")


def test_background_bulk_ingest_returns_immediately_then_completes(app_client, tmp_path):
    docx = tmp_path / "bg.docx"
    make_docx(docx, title="Background Talk ~ 01", body=["body text"])
    z = _make_zip({"English/bg.docx": docx})

    r = app_client.post(
        "/admin/upload-docx", headers=ADMIN_HEADERS,
        files={"file": ("corpus.zip", z, "application/zip")},
        data={"dry_run": "false", "background": "true"},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "state": "running"}

    s = _poll_ingest_done(app_client)
    assert s["state"] == "done", s
    assert s["kind"] == "bulk"
    assert s["result"]["processed"] == 1
    assert s["result"]["failed"] == 0

    rows = app_client.get("/admin/events?q=Background Talk", headers=ADMIN_HEADERS)
    assert any(e["title"] == "Background Talk ~ 01" for e in rows.json()["events"])


def test_background_batch_update_completes_with_result(app_client, tmp_path):
    docx = tmp_path / "add.docx"
    make_docx(docx, title="Background Added ~ 01", body=["body"])
    z = _make_zip({"Add/add.docx": docx})

    r = app_client.post(
        "/admin/batch-update", headers=ADMIN_HEADERS,
        files={"file": ("update.zip", z, "application/zip")},
        data={"dry_run": "false", "background": "true"},
    )
    assert r.status_code == 200, r.text
    s = _poll_ingest_done(app_client)
    assert s["state"] == "done", s
    assert s["result"]["added"] == 1
    assert s["result"]["failed"] == 0


def test_background_failure_surfaces_via_status_not_a_hang(app_client):
    """A bad zip in background mode must land in state=error with the same
    actionable message the sync path would have 400'd with."""
    inner = _make_zip({"Add/talk.docx": b"fake"})
    outer = _make_zip({"batch/inner.zip": inner})  # double-zipped
    r = app_client.post(
        "/admin/batch-update", headers=ADMIN_HEADERS,
        files={"file": ("update.zip", outer, "application/zip")},
        data={"dry_run": "true", "background": "true"},
    )
    assert r.status_code == 200, r.text
    s = _poll_ingest_done(app_client)
    assert s["state"] == "error"
    assert "double-zip" in s["message"].lower()


def test_background_run_releases_the_write_lock(app_client, tmp_path):
    """After a background run finishes — success OR failure — the next update
    must be accepted, not 409'd by a leaked lock."""
    docx = tmp_path / "t.docx"
    make_docx(docx, title="Lock Release Talk ~ 01", body=["body"])
    for dry in ("true", "false"):
        z = _make_zip({"English/t.docx": docx})
        r = app_client.post(
            "/admin/upload-docx", headers=ADMIN_HEADERS,
            files={"file": ("corpus.zip", z, "application/zip")},
            data={"dry_run": dry, "background": "true"},
        )
        assert r.status_code == 200, r.text
        assert _poll_ingest_done(app_client)["state"] == "done"


def test_ingest_status_requires_admin(app_client):
    r = app_client.get("/admin/ingest-status", headers=BAD_ADMIN_HEADERS)
    assert r.status_code == 401
