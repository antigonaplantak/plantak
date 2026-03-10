#!/usr/bin/env bash
set -euo pipefail

cd ~/code/plantak/apps/api

echo "== PRE-CHECK =="
bash scripts/pre_change_safety.sh

echo
echo "== SEED BOOKING GATE =="
pnpm run ops:seed:booking-gate

echo
echo "== BUILD =="
rm -rf dist
pnpm run build

echo
echo "== RESTART =="
(lsof -ti :3001 | xargs -r kill -9 || true)
: > /tmp/plantak_api.log
nohup bash -lc "cd ~/code/plantak/apps/api && exec env THROTTLE_BYPASS_TOKEN=${THROTTLE_BYPASS_TOKEN:-} node dist/main" >/tmp/plantak_api.log 2>&1 < /dev/null &
sleep 6

echo
echo "== HEALTH =="
curl -sS http://localhost:3001/api/health
echo

echo
echo "== SMOKE BOOKINGS REGRESSION =="
bash scripts/smoke_bookings_regression.sh

echo
echo "== LAST LOG =="
tail -n 60 /tmp/plantak_api.log || true

echo
echo "BOOKING_GATE_OK"
