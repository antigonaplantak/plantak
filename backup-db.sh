#!/usr/bin/env bash
set -euo pipefail

TS="$(date +%Y%m%d_%H%M%S)"
OUT="backups/plantak_${TS}.sql.gz"

mkdir -p backups

echo "📦 Dumping postgres from Docker -> $OUT"
docker exec -t plantak_db pg_dump -U plantak plantak | gzip > "$OUT"
echo "✅ Backup created: $OUT"
