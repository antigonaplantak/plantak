#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="$ROOT/_db_reports/$STAMP-capacity"
mkdir -p "$OUT_DIR"

CONTAINER="${PG_CONTAINER:-plantak_db}"
PGUSER="${PGUSER:-plantak}"
PGDB="${PGDB:-plantak}"

run_query() {
  local name="$1"
  local sql="$2"

  echo
  echo "== $name =="
  docker exec "$CONTAINER" \
    psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 -P pager=off -c "$sql" \
    | tee "$OUT_DIR/${name}.txt"
}

echo "== PG IS READY =="
docker exec "$CONTAINER" pg_isready -U "$PGUSER"
echo

run_query "server_version" "
SELECT version();
"

run_query "max_connections" "
SHOW max_connections;
"

run_query "database_size" "
SELECT current_database() AS db,
       pg_size_pretty(pg_database_size(current_database())) AS size;
"

run_query "connection_states" "
SELECT COALESCE(state, 'null') AS state, count(*) AS total
FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY 1
ORDER BY 2 DESC, 1;
"

run_query "connections_by_app" "
SELECT COALESCE(application_name, '') AS application_name,
       COALESCE(state, 'null') AS state,
       count(*) AS total
FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY 1, 2
ORDER BY 3 DESC, 1, 2;
"

run_query "wait_events" "
SELECT wait_event_type, wait_event, count(*) AS total
FROM pg_stat_activity
WHERE datname = current_database()
  AND wait_event IS NOT NULL
GROUP BY 1, 2
ORDER BY 3 DESC, 1, 2;
"

run_query "db_stats" "
SELECT datname,
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
       stats_reset
FROM pg_stat_database
WHERE datname = current_database();
"

run_query "largest_tables" "
SELECT schemaname,
       relname,
       n_live_tup,
       n_dead_tup,
       pg_size_pretty(pg_total_relation_size(relid)) AS total_size
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC
LIMIT 20;
"

run_query "largest_indexes" "
SELECT schemaname,
       relname,
       indexrelname,
       idx_scan,
       pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
ORDER BY pg_relation_size(indexrelid) DESC
LIMIT 20;
"

run_query "dead_tuple_pressure" "
SELECT schemaname,
       relname,
       n_live_tup,
       n_dead_tup,
       CASE
         WHEN n_live_tup = 0 THEN 0
         ELSE ROUND((n_dead_tup::numeric / NULLIF(n_live_tup, 0)) * 100, 2)
       END AS dead_pct
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC, relname
LIMIT 20;
"

echo
echo "== DONE =="
echo "Report directory: $OUT_DIR"
