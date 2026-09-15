#!/usr/bin/env bash
# =============================================================================
# Restore from a backup produced by backup.sh.
#
#   ./deploy/restore.sh backups/exchangepay-20260914T030000Z.db.gz
#
# Stop the app first. The current database is moved aside, not deleted.
# =============================================================================
set -euo pipefail

SRC="${1:?usage: restore.sh <backup.db.gz>}"
DB="${DB_FILE:-./data/exchangepay.db}"

[ -f "$SRC" ] || { echo "no such backup: $SRC" >&2; exit 1; }

TMP="$(mktemp -u "${DB}.restore.XXXXXX")"
gunzip -c "$SRC" > "$TMP"

sqlite3 "$TMP" 'PRAGMA integrity_check;' | grep -q '^ok$' \
  || { echo "that backup does not pass integrity_check - refusing" >&2; rm -f "$TMP"; exit 2; }

echo "backup contains $(sqlite3 "$TMP" 'SELECT COUNT(*) FROM orders;') orders"
read -r -p "replace $DB with this? [y/N] " yn
[ "$yn" = "y" ] || { rm -f "$TMP"; echo "aborted"; exit 0; }

if [ -f "$DB" ]; then
  mv "$DB" "$DB.superseded.$(date -u +%Y%m%dT%H%M%SZ)"
  # the write-ahead log belongs to the old database, not the new one
  rm -f "$DB-wal" "$DB-shm"
fi
mv "$TMP" "$DB"
echo "restored. start the app and check /api/health"
