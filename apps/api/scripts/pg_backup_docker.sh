#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${DB_CONTAINER:-plantak_db}"
DB_USER="${DB_USER:-plantak}"
DB_NAME="${DB_NAME:-plantak}"

OUT_DIR="${OUT_DIR:-./backups}"
mkdir -p "$OUT_DIR"

TS="$(date +%Y%m%d_%H%M%S)"
OUT_FILE="$OUT_DIR/${DB_NAME}_${TS}.sql.gz"

echo "Backing up $DB_NAME from $CONTAINER -> $OUT_FILE"
docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" --no-owner --no-privileges | gzip > "$OUT_FILE"

echo "✅ Backup done: $OUT_FILE"
