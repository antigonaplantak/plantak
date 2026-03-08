#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STAMP="$(date +%Y%m%d-%H%M%S)"
NAME="${1:-db-checkpoint}"
SAFE_NAME="$(echo "$NAME" | tr ' /' '__')"
OUT_DIR="$ROOT/_db_backups/$STAMP-$SAFE_NAME"

CONTAINER="${PG_CONTAINER:-plantak_db}"
PGUSER="${PGUSER:-plantak}"
PGDB="${PGDB:-plantak}"
RESTORE_DB="restore_check_${STAMP//[-]/_}"

mkdir -p "$OUT_DIR"

echo "== PG IS READY =="
docker exec "$CONTAINER" pg_isready -U "$PGUSER"
echo

echo "== DUMP DATABASE =="
docker exec "$CONTAINER" pg_dump -U "$PGUSER" -d "$PGDB" -Fc > "$OUT_DIR/db.dump"
docker exec "$CONTAINER" pg_dump -U "$PGUSER" -d "$PGDB" --schema-only > "$OUT_DIR/schema.sql"
docker exec "$CONTAINER" pg_dumpall -U "$PGUSER" --globals-only > "$OUT_DIR/globals.sql"
echo

echo "== CHECKSUMS =="
sha256sum "$OUT_DIR/db.dump" "$OUT_DIR/schema.sql" "$OUT_DIR/globals.sql" | tee "$OUT_DIR/SHA256SUMS.txt"
echo

echo "== RESTORE TEST =="
docker exec "$CONTAINER" psql -U "$PGUSER" -d postgres -c "DROP DATABASE IF EXISTS \"$RESTORE_DB\";" >/dev/null
docker exec "$CONTAINER" psql -U "$PGUSER" -d postgres -c "CREATE DATABASE \"$RESTORE_DB\";" >/dev/null

cat "$OUT_DIR/db.dump" | docker exec -i "$CONTAINER" pg_restore -U "$PGUSER" -d "$RESTORE_DB" --no-owner --no-privileges

docker exec "$CONTAINER" psql -U "$PGUSER" -d "$RESTORE_DB" -c '\dt' > "$OUT_DIR/RESTORE_TABLES.txt"
docker exec "$CONTAINER" psql -U "$PGUSER" -d postgres -c "DROP DATABASE \"$RESTORE_DB\";" >/dev/null
echo

echo "== DONE =="
echo "DB backup directory: $OUT_DIR"
