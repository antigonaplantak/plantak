#!/usr/bin/env bash
set -euo pipefail

LABEL="${1:-manual-db-checkpoint}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_ROOT="$ROOT_DIR/_db_backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="$BACKUP_ROOT/${STAMP}-${LABEL}"

POSTGRES_USER="${POSTGRES_USER:-plantak}"
POSTGRES_DB="${POSTGRES_DB:-plantak}"

mkdir -p "$OUT_DIR"

find_db_container() {
  docker ps --format '{{.Names}} {{.Label "com.docker.compose.service"}}' \
    | awk '$2=="db"{print $1; exit}'
}

DB_CONTAINER="${DB_CONTAINER_NAME:-$(find_db_container || true)}"

if [ -z "${DB_CONTAINER}" ]; then
  docker compose -f "$ROOT_DIR/infra/docker-compose.yml" up -d db >/dev/null 2>&1 || true
  sleep 4
  DB_CONTAINER="$(find_db_container || true)"
fi

if [ -z "${DB_CONTAINER}" ]; then
  echo "ERROR: no running db container found for safe_db_checkpoint"
  exit 1
fi

echo "== PG IS READY =="
docker exec "$DB_CONTAINER" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"

echo
echo "== DUMP DATABASE =="
docker exec "$DB_CONTAINER" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$OUT_DIR/db.dump"
docker exec "$DB_CONTAINER" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -s > "$OUT_DIR/schema.sql"
docker exec "$DB_CONTAINER" pg_dumpall -U "$POSTGRES_USER" --globals-only > "$OUT_DIR/globals.sql"

echo
echo "== CHECKSUMS =="
sha256sum "$OUT_DIR/db.dump" "$OUT_DIR/schema.sql" "$OUT_DIR/globals.sql"

TMP_DB="restore_check_${STAMP//-/_}"

echo
echo "== RESTORE TEST =="
docker exec "$DB_CONTAINER" dropdb --if-exists -U "$POSTGRES_USER" "$TMP_DB" >/dev/null 2>&1 || true
docker exec "$DB_CONTAINER" createdb -U "$POSTGRES_USER" "$TMP_DB"
cat "$OUT_DIR/db.dump" | docker exec -i "$DB_CONTAINER" pg_restore -U "$POSTGRES_USER" -d "$TMP_DB" >/dev/null
docker exec "$DB_CONTAINER" dropdb -U "$POSTGRES_USER" "$TMP_DB" >/dev/null

echo
echo "== DONE =="
echo "DB backup directory: $OUT_DIR"
