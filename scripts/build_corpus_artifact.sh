#!/usr/bin/env bash
# Build the compressed SQLite corpus the offline PWA downloads on first
# launch. Runs on the E2E VPS that hosts the live DB — designed to be
# cheap enough to schedule nightly (cron).
#
# Output: data/artifacts/osho.db.zst
#
# Steps:
#   1. Copy the live DB into a temp file (online backup so we don't
#      block the API process serving live traffic).
#   2. VACUUM + FTS optimize on the copy to shrink the file before
#      compression.
#   3. zstd -19 -T0 — NO --long. The offline/desktop app decompresses
#      this file in-browser with fzstd (a pure-JS decoder), which cannot
#      correctly decode a large ("long") zstd window and silently corrupts
#      the DB on the client. See the window guard below.
#   4. Move the artifact into place atomically so any in-flight web
#      readers see either the old file or the new one, never a partial.
#
# The artifact is then published as the stable `corpus-latest` GitHub
# release asset (see publish_corpus.sh). The PWA points at that URL via
# NEXT_PUBLIC_CORPUS_DOWNLOAD_URL (frontend/.env.production) and the
# desktop app bundles the same file. The worker verifies the magic
# bytes (zstd vs raw SQLite) before opening the file.
set -euo pipefail

REPO_DIR="${REPO_DIR:-/home/osho/osho}"
DB_PATH="${DB_PATH:-${REPO_DIR}/data/osho.db}"
ART_DIR="${ART_DIR:-${REPO_DIR}/data/artifacts}"
PY="${PY:-${REPO_DIR}/.venv/bin/python3}"

mkdir -p "$ART_DIR"

# Fail fast on a missing / unreadable source. sqlite3.connect() will
# happily create an empty database at $DB_PATH, which would silently
# publish an empty corpus to every offline user.
if [ ! -f "$DB_PATH" ]; then
  echo "ERROR: source DB not found at $DB_PATH" >&2
  exit 2
fi

# Place temp files inside the same target directory so the final mv is
# a true rename (atomic on the same filesystem). mktemp in /var/tmp can
# land on a different mount and silently degrade to a copy.
tmp_db="$(mktemp --tmpdir="$ART_DIR" osho.db.XXXXXX)"
tmp_zst="${tmp_db}.zst"

cleanup() { rm -f "$tmp_db" "${tmp_db}-journal" "${tmp_db}-wal" "${tmp_db}-shm" "$tmp_zst"; }
trap cleanup EXIT

echo "==> Online backup → $tmp_db"
"$PY" - <<PY
import sqlite3
# `mode=ro` opens read-only and refuses to create. Paired with the
# existence check above this means a typo'd $DB_PATH errors loudly
# instead of producing an empty artifact.
src = sqlite3.connect("file:$DB_PATH?mode=ro", uri=True)
dst = sqlite3.connect("$tmp_db")
try:
    src.backup(dst, pages=-1)
finally:
    dst.close()
    src.close()
PY

echo "==> VACUUM + FTS optimize"
"$PY" - <<PY
import sqlite3
conn = sqlite3.connect("$tmp_db")
# Optimise both FTS5 tables if they're present.
for table in ("paragraphs_fts", "paragraphs_fts_exact"):
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    if row:
        conn.execute(f"INSERT INTO {table}({table}) VALUES('optimize')")
conn.commit()
# VACUUM has to be the last statement (can't be inside a transaction).
conn.isolation_level = None
conn.execute("VACUUM")
conn.close()
PY

raw_size=$(stat -c %s "$tmp_db")
printf "==> Raw DB:        %'d bytes (%.1f MiB)\n" "$raw_size" "$(echo "$raw_size / 1048576" | bc -l)"

# IMPORTANT: NO --long. The offline PWA / desktop app decompresses this
# archive in the browser with fzstd (pure-JS). fzstd cannot correctly decode
# a large zstd *window* (--long defaults to a 128 MiB window); it returns the
# right number of bytes but with corrupted regions, producing a malformed
# SQLite DB on the client (SQLITE_CORRUPT + garbled Hindi — Anuragi 2026-07-09,
# verified byte-for-byte: fzstd on a --long frame ≠ the source DB; on a plain
# -19 frame it matches exactly). Plain -19 keeps an 8 MiB window fzstd handles.
echo "==> zstd -19 -T0 (no --long — fzstd-safe window)"
zstd -19 -T0 --quiet --force -o "$tmp_zst" "$tmp_db"
zst_size=$(stat -c %s "$tmp_zst")

# Guard against a silent regression: if anyone re-adds --long/--ultra (or a
# level whose window exceeds fzstd's safe range) the client would corrupt the
# corpus again with no error. Assert the frame window stayed within 8 MiB and
# fail the build loudly otherwise, so a bad corpus never reaches offline users.
win_bytes=$(zstd -lv "$tmp_zst" 2>&1 | sed -n 's/.*Window Size:[^(]*(\([0-9]\+\) B).*/\1/p')
if [ -z "$win_bytes" ] || [ "$win_bytes" -gt 8388608 ]; then
  echo "ERROR: corpus zstd window is ${win_bytes:-unknown} B (> 8 MiB / 8388608)." >&2
  echo "       The offline app's fzstd decoder will CORRUPT this archive." >&2
  echo "       Do NOT use --long/--ultra when compressing the offline corpus." >&2
  exit 4
fi
printf "==> zstd window: %'d B (fzstd-safe, <= 8 MiB)\n" "$win_bytes"
printf "==> Compressed:    %'d bytes (%.1f MiB, %.1f%% of raw)\n" \
  "$zst_size" \
  "$(echo "$zst_size / 1048576" | bc -l)" \
  "$(echo "$zst_size * 100 / $raw_size" | bc -l)"

# Atomic move into place.
mv "$tmp_zst" "$ART_DIR/osho.db.zst"
echo "==> Artifact ready: $ART_DIR/osho.db.zst"

# Convenience: SHA-256 for cache-busting downstream.
sha=$(sha256sum "$ART_DIR/osho.db.zst" | awk '{print $1}')
echo "$sha" > "$ART_DIR/osho.db.zst.sha256"
echo "==> SHA-256: $sha"
