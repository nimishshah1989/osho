#!/usr/bin/env bash
# backup-db.sh
#
# Nightly encrypted backup of the SQLite DB to Backblaze B2.
#
# Strategy:
#   1. sqlite3 .backup → consistent snapshot (safe under live writes)
#   2. gzip then encrypt with openssl aes-256-cbc (passphrase in env)
#   3. upload to B2 with rclone, naming by date
#   4. keep 14 daily, 8 weekly, 12 monthly (B2 lifecycle handles this)
#
# Env vars required (from /etc/osho/backup.env):
#   B2_KEY_ID
#   B2_APPLICATION_KEY
#   B2_BUCKET
#   BACKUP_ENCRYPTION_PASSPHRASE
#
# To restore:
#   rclone copy b2:$B2_BUCKET/osho-db-YYYY-MM-DD.db.gz.enc /tmp/
#   openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_ENCRYPTION_PASSPHRASE \
#     -in /tmp/osho-db-YYYY-MM-DD.db.gz.enc | gunzip > restored.db
#
# Installed by 03-setup-backend.sh's optional follow-up step; or manually:
#   sudo cp deploy/iceland/backup-db.sh /usr/local/bin/osho-backup-db
#   sudo chmod +x /usr/local/bin/osho-backup-db
#   sudo crontab -e
#     0 3 * * * /usr/local/bin/osho-backup-db >> /var/log/osho-backup.log 2>&1

set -euo pipefail

# shellcheck source=/dev/null
[ -f /etc/osho/backup.env ] && source /etc/osho/backup.env

: "${B2_KEY_ID:?}"
: "${B2_APPLICATION_KEY:?}"
: "${B2_BUCKET:?}"
: "${BACKUP_ENCRYPTION_PASSPHRASE:?}"

DB_PATH="${DB_PATH:-/home/osho/osho/data/osho.db}"
WORKDIR="$(mktemp -d /tmp/osho-backup.XXXXXX)"
trap 'rm -rf "$WORKDIR"' EXIT

DATE=$(date -u +%Y-%m-%d)
SNAPSHOT="$WORKDIR/osho.db"
ARCHIVE="$WORKDIR/osho-db-$DATE.db.gz.enc"

echo "==> [$(date -u +%FT%TZ)] Snapshotting DB"
sqlite3 "$DB_PATH" ".backup $SNAPSHOT"

echo "==> Compressing + encrypting"
gzip -c "$SNAPSHOT" | \
  openssl enc -aes-256-cbc -pbkdf2 -salt \
    -pass env:BACKUP_ENCRYPTION_PASSPHRASE \
    -out "$ARCHIVE"

ARCHIVE_SIZE=$(stat -c '%s' "$ARCHIVE")
echo "    Archive: $ARCHIVE ($ARCHIVE_SIZE bytes)"

echo "==> Configuring rclone for B2 (one-shot, no persistent config)"
export RCLONE_CONFIG_B2_TYPE=b2
export RCLONE_CONFIG_B2_ACCOUNT="$B2_KEY_ID"
export RCLONE_CONFIG_B2_KEY="$B2_APPLICATION_KEY"

echo "==> Uploading to b2:$B2_BUCKET/"
rclone copy "$ARCHIVE" "b2:$B2_BUCKET/"

echo "==> [$(date -u +%FT%TZ)] Backup complete: osho-db-$DATE.db.gz.enc"
