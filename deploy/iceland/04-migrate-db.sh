#!/usr/bin/env bash
# 04-migrate-db.sh
#
# Run from YOUR LAPTOP (not on any VPS).
#
# Copies the SQLite database from the live EC2 backend → your laptop → the
# new Iceland backend VPS. Uses `sqlite3 .backup` on the source so the copy
# is consistent even if uvicorn is mid-write.
#
# Usage:
#   EC2_HOST=ubuntu@13.206.34.214 \
#   EC2_SSH_KEY=~/.ssh/jsl-wealth-key.pem \
#   BACKEND_IP=<iceland-backend-ip> \
#   BACKEND_SSH_KEY=~/.ssh/osho_iceland \
#   bash deploy/iceland/04-migrate-db.sh
#
# What it does:
#   1. SSH to EC2 → run `sqlite3 data/osho.db ".backup /tmp/osho.snapshot.db"`
#      (this is the safe way to snapshot a live SQLite file)
#   2. scp the snapshot down to your laptop ./data/osho.snapshot.db
#   3. scp it up to the Iceland VPS at /home/osho/osho/data/osho.db
#   4. Verify file size matches on both ends
#
# Why through the laptop and not EC2 → Iceland directly?
#   - Lets you keep a local copy (insurance)
#   - Avoids opening SSH between EC2 and Iceland just for this one transfer

set -euo pipefail

: "${EC2_HOST:?Set EC2_HOST (e.g. ubuntu@13.206.34.214)}"
: "${EC2_SSH_KEY:?Set EC2_SSH_KEY (path to PEM)}"
: "${BACKEND_IP:?Set BACKEND_IP (Iceland backend IP)}"
: "${BACKEND_SSH_KEY:?Set BACKEND_SSH_KEY (path to ed25519 key)}"

EC2_DB_PATH="${EC2_DB_PATH:-/home/ubuntu/osho-speaks/data/osho.db}"
LOCAL_SNAPSHOT="${LOCAL_SNAPSHOT:-./data/osho.snapshot.db}"
REMOTE_DB_PATH="${REMOTE_DB_PATH:-/home/osho/osho/data/osho.db}"

mkdir -p "$(dirname "$LOCAL_SNAPSHOT")"

echo "==> [1/4] Snapshotting DB on EC2 (uses sqlite3 .backup — safe under writes)"
ssh -i "$EC2_SSH_KEY" "$EC2_HOST" bash <<EOF
set -e
rm -f /tmp/osho.snapshot.db
sqlite3 $EC2_DB_PATH ".backup /tmp/osho.snapshot.db"
ls -lh /tmp/osho.snapshot.db
EOF

echo "==> [2/4] Downloading snapshot to laptop"
scp -i "$EC2_SSH_KEY" "$EC2_HOST:/tmp/osho.snapshot.db" "$LOCAL_SNAPSHOT"
EC2_SIZE=$(ssh -i "$EC2_SSH_KEY" "$EC2_HOST" "stat -c '%s' /tmp/osho.snapshot.db")
LOCAL_SIZE=$(stat -c '%s' "$LOCAL_SNAPSHOT" 2>/dev/null || stat -f '%z' "$LOCAL_SNAPSHOT")
if [ "$EC2_SIZE" != "$LOCAL_SIZE" ]; then
  echo "ERROR: snapshot size mismatch (EC2=$EC2_SIZE laptop=$LOCAL_SIZE)" >&2
  exit 1
fi
echo "    OK: $LOCAL_SIZE bytes"

echo "==> [3/4] Uploading snapshot to Iceland backend"
ssh -i "$BACKEND_SSH_KEY" "osho@$BACKEND_IP" "mkdir -p $(dirname "$REMOTE_DB_PATH")"
scp -i "$BACKEND_SSH_KEY" "$LOCAL_SNAPSHOT" "osho@$BACKEND_IP:$REMOTE_DB_PATH"

echo "==> [4/4] Verifying size on Iceland backend"
REMOTE_SIZE=$(ssh -i "$BACKEND_SSH_KEY" "osho@$BACKEND_IP" "stat -c '%s' $REMOTE_DB_PATH")
if [ "$REMOTE_SIZE" != "$LOCAL_SIZE" ]; then
  echo "ERROR: remote size mismatch (laptop=$LOCAL_SIZE remote=$REMOTE_SIZE)" >&2
  exit 1
fi
echo "    OK: $REMOTE_SIZE bytes on Iceland backend"

echo "==> Cleaning up EC2 /tmp snapshot"
ssh -i "$EC2_SSH_KEY" "$EC2_HOST" "rm -f /tmp/osho.snapshot.db"

echo ""
echo "==> DB migration complete."
echo "    Local copy kept at:  $LOCAL_SNAPSHOT"
echo "    Now SSH to the Iceland backend and run 03-setup-backend.sh — it will"
echo "    rebuild the FTS5 index from the migrated DB."
