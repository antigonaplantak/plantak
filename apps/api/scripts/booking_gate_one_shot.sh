#!/usr/bin/env bash
set -euo pipefail

cd ~/code/plantak/apps/api

PORT="${BOOKING_GATE_PORT:-3101}"
API_BASE="http://localhost:${PORT}"
API="${API_BASE}/api"

echo "== PRE-CHECK =="
bash scripts/pre_change_safety.sh

echo
echo "== BUILD =="
rm -rf dist
pnpm run build

echo
echo "== RESTART =="
(lsof -ti :"${PORT}" | xargs -r kill -9 || true)
: > /tmp/plantak_api.log
nohup bash -lc "cd ~/code/plantak/apps/api && exec env PORT=${PORT} THROTTLE_BYPASS_TOKEN=${THROTTLE_BYPASS_TOKEN:-} node dist/main" >/tmp/plantak_api.log 2>&1 < /dev/null &
sleep 6

echo
echo "== HEALTH =="
curl -sS "${API_BASE}/api/health"
echo

echo
echo "== SMOKE BOOKINGS REGRESSION =="
API="${API}" bash scripts/smoke_bookings_regression.sh

echo
echo "== LAST LOG =="
tail -n 80 /tmp/plantak_api.log || true

echo
echo "BOOKING_GATE_OK"
