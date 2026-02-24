#!/usr/bin/env bash
set -euo pipefail

FILE="${1:-}"
if [ -z "$FILE" ]; then
  echo "Usage: ./restore-db.sh backups/plantak_YYYYMMDD_HHMMSS.sql.gz"
  exit 1
fi

echo "⚠️ Restoring DB from $FILE (will overwrite current database!)"
gunzip -c "$FILE" | docker exec -i plantak_db psql -U plantak -d plantak
echo "✅ Restore complete"
