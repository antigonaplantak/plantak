#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: ./scripts/pg_restore_docker.sh <backup.sql.gz>"
  exit 1
fi

FILE="$1"
CONTAINER="${DB_CONTAINER:-plantak_db}"
DB_USER="${DB_USER:-plantak}"
DB_NAME="${DB_NAME:-plantak}"

echo "Restoring $FILE -> $DB_NAME on $CONTAINER"
gunzip -c "$FILE" | docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME"

echo "✅ Restore done"
