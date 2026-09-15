#!/usr/bin/env bash
# =============================================================================
# Consistent SQLite backup.
#
# Copying the database file while the app is writing produces a corrupt copy.
# `sqlite3 .backup` takes a proper snapshot of a live database, which is why
# this does not just use cp.
#
#   ./deploy/backup.sh                       -> ./backups
#   BACKUP_DIR=/mnt/vol ./deploy/backup.sh   -> elsewhere
#   0 3 * * *  /opt/exchangepay/deploy/backup.sh   (nightly via cron)
# =============================================================================
set -euo pipefail

DB="${DB_FILE:-./data/exchangepay.db}"
KYC_DIR="$(dirname "$DB")/kyc"
OUT="${BACKUP_DIR:-./backups}"
KEEP="${KEEP_DAYS:-30}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

[ -f "$DB" ] || { echo "no database at $DB" >&2; exit 1; }
command -v sqlite3 >/dev/null || { echo "sqlite3 is not installed" >&2; exit 1; }

mkdir -p "$OUT"
TARGET="$OUT/exchangepay-$STAMP.db"

echo "snapshotting $DB"
sqlite3 "$DB" ".backup '$TARGET'"

# Prove the copy is readable before trusting it. A backup you have not
# verified is not a backup.
if ! sqlite3 "$TARGET" 'PRAGMA integrity_check;' | grep -q '^ok$'; then
  echo "integrity check FAILED - keeping $TARGET for inspection" >&2
  exit 2
fi

ORDERS=$(sqlite3 "$TARGET" 'SELECT COUNT(*) FROM orders;')
USERS=$(sqlite3 "$TARGET" 'SELECT COUNT(*) FROM users;')
echo "verified: $ORDERS orders, $USERS users"

gzip -9 "$TARGET"
echo "wrote $TARGET.gz ($(du -h "$TARGET.gz" | cut -f1))"

# uploaded identity documents live outside the database
if [ -d "$KYC_DIR" ] && [ -n "$(ls -A "$KYC_DIR" 2>/dev/null)" ]; then
  tar -czf "$OUT/kyc-$STAMP.tar.gz" -C "$(dirname "$KYC_DIR")" "$(basename "$KYC_DIR")"
  echo "wrote $OUT/kyc-$STAMP.tar.gz"
fi

find "$OUT" -name 'exchangepay-*.db.gz' -mtime "+$KEEP" -delete
find "$OUT" -name 'kyc-*.tar.gz' -mtime "+$KEEP" -delete
echo "pruned anything older than $KEEP days"

# Copy off the machine. A backup on the same disk as the database does not
# survive the failure it exists for.
if [ -n "${BACKUP_S3_URI:-}" ]; then
  aws s3 cp "$TARGET.gz" "$BACKUP_S3_URI/" --only-show-errors
  echo "uploaded to $BACKUP_S3_URI"
else
  echo "note: BACKUP_S3_URI is unset, so this backup is only on this machine"
fi
