"""Tests for the self-service ingestion endpoints:
    GET  /api/version
    POST /admin/upload-docx
    POST /admin/batch-update
"""
import io
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
