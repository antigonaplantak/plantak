#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DURATION="${1:-25}"
INTERVAL="${INTERVAL_SEC:-0.2}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="$ROOT/_db_reports/$STAMP-peak-watch"
mkdir -p "$OUT_DIR"

CONTAINER="${PG_CONTAINER:-plantak_db}"
PGUSER="${PGUSER:-plantak}"
PGDB="${PGDB:-plantak}"

END_AT=$((SECONDS + DURATION))

echo "watch_duration=$DURATION" | tee "$OUT_DIR/meta.txt"
echo "interval_sec=$INTERVAL" | tee -a "$OUT_DIR/meta.txt"

while [ $SECONDS -lt $END_AT ]; do
  TS="$(date --iso-8601=seconds)"
  docker exec "$CONTAINER" psql -U "$PGUSER" -d "$PGDB" -At -F $'\t' -c "
    SELECT
      COALESCE(sum(CASE WHEN state = 'active' THEN 1 ELSE 0 END), 0),
      COALESCE(sum(CASE WHEN state = 'idle' THEN 1 ELSE 0 END), 0),
      COALESCE(sum(CASE WHEN state = 'idle in transaction' THEN 1 ELSE 0 END), 0),
      count(*)
    FROM pg_stat_activity
    WHERE datname = current_database();
  " | awk -v ts="$TS" -F '\t' '{print ts"\tactive="$1"\tidle="$2"\tidle_in_tx="$3"\ttotal="$4}' >> "$OUT_DIR/samples.tsv"
  sleep "$INTERVAL"
done

awk '
BEGIN { max_active=0; max_total=0; max_idle_tx=0; }
{
  for (i=1;i<=NF;i++) {
    if ($i ~ /^active=/) { split($i,a,"="); if (a[2] > max_active) max_active=a[2]; }
    if ($i ~ /^total=/) { split($i,a,"="); if (a[2] > max_total) max_total=a[2]; }
    if ($i ~ /^idle_in_tx=/) { split($i,a,"="); if (a[2] > max_idle_tx) max_idle_tx=a[2]; }
  }
}
END {
  print "max_active=" max_active;
  print "max_total=" max_total;
  print "max_idle_in_tx=" max_idle_tx;
}
' "$OUT_DIR/samples.tsv" | tee "$OUT_DIR/summary.txt"

echo "Report directory: $OUT_DIR"
