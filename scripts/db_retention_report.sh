#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="$ROOT/_db_reports/$STAMP-retention"
mkdir -p "$OUT_DIR"

CONTAINER="${PG_CONTAINER:-plantak_db}"
PGUSER="${PGUSER:-plantak}"
PGDB="${PGDB:-plantak}"

LOGINCODE_KEEP_DAYS="${LOGINCODE_KEEP_DAYS:-7}"
REFRESHSESSION_KEEP_DAYS="${REFRESHSESSION_KEEP_DAYS:-30}"
IDEMPOTENCY_KEEP_DAYS="${IDEMPOTENCY_KEEP_DAYS:-14}"

run_query() {
  local name="$1"
  local sql="$2"

  echo
  echo "== $name ==" | tee -a "$OUT_DIR/summary.txt"
  docker exec "$CONTAINER" \
    psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 -P pager=off -c "$sql" \
    | tee "$OUT_DIR/${name}.txt"
}

echo "LOGINCODE_KEEP_DAYS=$LOGINCODE_KEEP_DAYS" | tee "$OUT_DIR/config.txt"
echo "REFRESHSESSION_KEEP_DAYS=$REFRESHSESSION_KEEP_DAYS" | tee -a "$OUT_DIR/config.txt"
echo "IDEMPOTENCY_KEEP_DAYS=$IDEMPOTENCY_KEEP_DAYS" | tee -a "$OUT_DIR/config.txt"

run_query "logincode_candidates" "
SELECT
  COUNT(*) FILTER (
    WHERE \"expiresAt\" < now() - make_interval(days => ${LOGINCODE_KEEP_DAYS})
  ) AS expired_older_than_keep,
  COUNT(*) FILTER (
    WHERE \"usedAt\" IS NOT NULL
      AND \"createdAt\" < now() - make_interval(days => ${LOGINCODE_KEEP_DAYS})
  ) AS used_older_than_keep,
  COUNT(*) AS total
FROM \"LoginCode\";
"

run_query "refreshsession_candidates" "
SELECT
  COUNT(*) FILTER (
    WHERE \"expiresAt\" < now() - make_interval(days => ${REFRESHSESSION_KEEP_DAYS})
  ) AS expired_older_than_keep,
  COUNT(*) AS total
FROM \"RefreshSession\";
"

run_query "idempotency_candidates" "
SELECT
  COUNT(*) FILTER (
    WHERE \"createdAt\" < now() - make_interval(days => ${IDEMPOTENCY_KEEP_DAYS})
  ) AS older_than_keep,
  COUNT(*) AS total
FROM \"IdempotencyKey\";
"

run_query "oldest_logincode_rows" "
SELECT id, email, purpose, \"createdAt\", \"expiresAt\", \"usedAt\"
FROM \"LoginCode\"
ORDER BY \"createdAt\" ASC
LIMIT 20;
"

run_query "oldest_refreshsession_rows" "
SELECT id, \"userId\", \"createdAt\", \"expiresAt\"
FROM \"RefreshSession\"
ORDER BY \"createdAt\" ASC
LIMIT 20;
"

run_query "oldest_idempotency_rows" "
SELECT id, \"businessId\", action, \"createdAt\"
FROM \"IdempotencyKey\"
ORDER BY \"createdAt\" ASC
LIMIT 20;
"

echo
echo "== DONE =="
echo "Report directory: $OUT_DIR"
