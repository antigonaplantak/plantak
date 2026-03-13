#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$APP_DIR"

cp -f _baseline_safe_snapshot/bookings.controller.snapshot.ts src/bookings/bookings.controller.ts
cp -f _baseline_safe_snapshot/bookings.service.snapshot.ts src/bookings/bookings.service.ts

rm -rf dist
npm run build

(lsof -ti :3001 | xargs -r kill -9 || true)
: > /tmp/plantak_api.log
nohup bash -lc "cd \"$APP_DIR\" && if [ -f .env ]; then set -a; . ./.env; set +a; fi; exec node dist/main" >/tmp/plantak_api.log 2>&1 < /dev/null &
sleep 6

echo "== HEALTH =="
curl -sS http://localhost:3001/api/health
echo
echo
echo "== LAST LOG =="
tail -n 40 /tmp/plantak_api.log || true
