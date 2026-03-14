#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="$ROOT/_db_reports/$STAMP-hot-queries"
mkdir -p "$OUT_DIR"

CONTAINER="${PG_CONTAINER:-plantak_db}"
PGUSER="${PGUSER:-plantak}"
PGDB="${PGDB:-plantak}"

PRELOAD="$(docker exec "$CONTAINER" psql -U "$PGUSER" -d "$PGDB" -At -c "SHOW shared_preload_libraries;")"
HAS_EXT="$(docker exec "$CONTAINER" psql -U "$PGUSER" -d "$PGDB" -At -c "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') THEN 1 ELSE 0 END;")"

echo "shared_preload_libraries=$PRELOAD" | tee "$OUT_DIR/STATUS.txt"
echo "pg_stat_statements_extension=$HAS_EXT" | tee -a "$OUT_DIR/STATUS.txt"

if [ "$HAS_EXT" != "1" ]; then
  echo
  echo "pg_stat_statements is not enabled yet."
  echo "Hot query report skipped."
  echo "Report directory: $OUT_DIR"
  exit 0
fi

echo
echo "== TOP TOTAL EXEC TIME =="
docker exec "$CONTAINER" \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 -P pager=off -c "
SELECT queryid,
       calls,
       ROUND(total_exec_time::numeric, 2) AS total_ms,
       ROUND(mean_exec_time::numeric, 2) AS mean_ms,
       rows,
       LEFT(REGEXP_REPLACE(query, E'[[:space:]]+', ' ', 'g'), 220) AS query
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 20;
" | tee "$OUT_DIR/top_total_exec_time.txt"

echo
echo "== TOP MEAN EXEC TIME =="
docker exec "$CONTAINER" \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 -P pager=off -c "
SELECT queryid,
       calls,
       ROUND(mean_exec_time::numeric, 2) AS mean_ms,
       ROUND(total_exec_time::numeric, 2) AS total_ms,
       rows,
       LEFT(REGEXP_REPLACE(query, E'[[:space:]]+', ' ', 'g'), 220) AS query
FROM pg_stat_statements
WHERE calls >= 5
ORDER BY mean_exec_time DESC
LIMIT 20;
" | tee "$OUT_DIR/top_mean_exec_time.txt"

echo
echo "== DONE =="
echo "Report directory: $OUT_DIR"
