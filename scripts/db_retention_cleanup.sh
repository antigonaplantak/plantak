#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="$ROOT/_db_reports/$STAMP-retention-cleanup"
mkdir -p "$OUT_DIR"

CONTAINER="${PG_CONTAINER:-plantak_db}"
PGUSER="${PGUSER:-plantak}"
PGDB="${PGDB:-plantak}"

LOGINCODE_KEEP_DAYS="${LOGINCODE_KEEP_DAYS:-7}"
REFRESHSESSION_KEEP_DAYS="${REFRESHSESSION_KEEP_DAYS:-30}"
IDEMPOTENCY_KEEP_DAYS="${IDEMPOTENCY_KEEP_DAYS:-14}"
DRY_RUN="${DRY_RUN:-1}"

echo "DRY_RUN=$DRY_RUN" | tee "$OUT_DIR/config.txt"
echo "LOGINCODE_KEEP_DAYS=$LOGINCODE_KEEP_DAYS" | tee -a "$OUT_DIR/config.txt"
echo "REFRESHSESSION_KEEP_DAYS=$REFRESHSESSION_KEEP_DAYS" | tee -a "$OUT_DIR/config.txt"
echo "IDEMPOTENCY_KEEP_DAYS=$IDEMPOTENCY_KEEP_DAYS" | tee -a "$OUT_DIR/config.txt"

preview_sql="
SELECT 'LoginCode' AS table_name, COUNT(*) AS rows_to_delete
FROM \"LoginCode\"
WHERE
  \"expiresAt\" < now() - make_interval(days => ${LOGINCODE_KEEP_DAYS})
  OR (
    \"usedAt\" IS NOT NULL
    AND \"createdAt\" < now() - make_interval(days => ${LOGINCODE_KEEP_DAYS})
  )
UNION ALL
SELECT 'RefreshSession' AS table_name, COUNT(*) AS rows_to_delete
FROM \"RefreshSession\"
WHERE \"expiresAt\" < now() - make_interval(days => ${REFRESHSESSION_KEEP_DAYS})
UNION ALL
SELECT 'IdempotencyKey' AS table_name, COUNT(*) AS rows_to_delete
FROM \"IdempotencyKey\"
WHERE \"createdAt\" < now() - make_interval(days => ${IDEMPOTENCY_KEEP_DAYS});
"

echo "== PREVIEW ==" | tee "$OUT_DIR/summary.txt"
docker exec "$CONTAINER" \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 -P pager=off -c "$preview_sql" \
  | tee "$OUT_DIR/preview.txt"

if [ "$DRY_RUN" = "1" ]; then
  echo
  echo "DRY_RUN=1 -> no rows deleted"
  echo "Report directory: $OUT_DIR"
  exit 0
fi

cleanup_sql="
BEGIN;

DELETE FROM \"LoginCode\"
WHERE
  \"expiresAt\" < now() - make_interval(days => ${LOGINCODE_KEEP_DAYS})
  OR (
    \"usedAt\" IS NOT NULL
    AND \"createdAt\" < now() - make_interval(days => ${LOGINCODE_KEEP_DAYS})
  );

DELETE FROM \"RefreshSession\"
WHERE \"expiresAt\" < now() - make_interval(days => ${REFRESHSESSION_KEEP_DAYS});

DELETE FROM \"IdempotencyKey\"
WHERE \"createdAt\" < now() - make_interval(days => ${IDEMPOTENCY_KEEP_DAYS});

COMMIT;
"

echo
echo "== CLEANUP ==" | tee -a "$OUT_DIR/summary.txt"
docker exec "$CONTAINER" \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 -P pager=off -c "$cleanup_sql" \
  | tee "$OUT_DIR/cleanup.txt"

echo
echo "== VACUUM ANALYZE ==" | tee -a "$OUT_DIR/summary.txt"
docker exec "$CONTAINER" \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 -P pager=off \
  -c 'VACUUM ANALYZE "LoginCode";' \
  -c 'VACUUM ANALYZE "RefreshSession";' \
  -c 'VACUUM ANALYZE "IdempotencyKey";' \
  | tee "$OUT_DIR/vacuum.txt"

echo
echo "== POSTVIEW ==" | tee -a "$OUT_DIR/summary.txt"
docker exec "$CONTAINER" \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 -P pager=off -c "$preview_sql" \
  | tee "$OUT_DIR/postview.txt"

echo
echo "== DONE =="
echo "Report directory: $OUT_DIR"
