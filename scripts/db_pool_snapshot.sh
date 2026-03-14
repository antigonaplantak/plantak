#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="$ROOT/_db_reports/$STAMP-pool"
mkdir -p "$OUT_DIR"

CONTAINER="${PG_CONTAINER:-plantak_db}"
PGUSER="${PGUSER:-plantak}"
PGDB="${PGDB:-plantak}"

run_query() {
  local name="$1"
  local sql="$2"

  echo
  echo "== $name ==" | tee -a "$OUT_DIR/summary.txt"
  docker exec "$CONTAINER" \
    psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 -P pager=off -c "$sql" \
    | tee "$OUT_DIR/${name}.txt"
}

run_query "max_connections" "
SHOW max_connections;
"

run_query "superuser_reserved_connections" "
SHOW superuser_reserved_connections;
"

run_query "current_connections" "
SELECT
  datname,
  application_name,
  state,
  COUNT(*) AS total
FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY datname, application_name, state
ORDER BY total DESC, application_name, state;
"

run_query "client_addresses" "
SELECT
  COALESCE(application_name, '') AS application_name,
  COALESCE(client_addr::text, 'local') AS client_addr,
  state,
  COUNT(*) AS total
FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY 1,2,3
ORDER BY total DESC, 1, 2, 3;
"

run_query "idle_in_transaction" "
SELECT pid, application_name, state, xact_start, query_start, wait_event_type, wait_event, query
FROM pg_stat_activity
WHERE datname = current_database()
  AND state = 'idle in transaction'
ORDER BY xact_start NULLS LAST;
"

run_query "db_pressure" "
SELECT
  numbackends,
  xact_commit,
  xact_rollback,
  blks_read,
  blks_hit,
  tup_returned,
  tup_fetched,
  tup_inserted,
  tup_updated,
  tup_deleted,
  conflicts,
  deadlocks
FROM pg_stat_database
WHERE datname = current_database();
"

echo
echo "== DONE =="
echo "Report directory: $OUT_DIR"
