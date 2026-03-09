#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILE="infra/docker-compose.yml"
API_URL="${API_URL:-http://localhost:3001}"
DASHBOARD_ROUTE="${QUEUE_DASHBOARD_ROUTE:-/api/ops/queues}"
DASHBOARD_USER="${QUEUE_DASHBOARD_USER:-ops}"
DASHBOARD_PASS="${QUEUE_DASHBOARD_PASS:-change-this-now}"

export ENABLE_QUEUE_DASHBOARD="${ENABLE_QUEUE_DASHBOARD:-true}"
export QUEUE_DASHBOARD_USER="$DASHBOARD_USER"
export QUEUE_DASHBOARD_PASS="$DASHBOARD_PASS"
export QUEUE_DASHBOARD_ROUTE="$DASHBOARD_ROUTE"

docker compose -f "$COMPOSE_FILE" up -d
sleep 10

echo "== PS =="
docker compose -f "$COMPOSE_FILE" ps

echo
echo "== HEALTH =="
HEALTH_CODE="$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/api/health")"
[ "$HEALTH_CODE" = "200" ] || { echo "ERROR: health check failed"; exit 1; }
curl -fsS "$API_URL/api/health"
echo

echo
echo "== DASHBOARD 401 =="
UNAUTH_CODE="$(curl -s -o /dev/null -w '%{http_code}' "$API_URL$DASHBOARD_ROUTE")"
[ "$UNAUTH_CODE" = "401" ] || { echo "ERROR: dashboard unauth expected 401 got $UNAUTH_CODE"; exit 1; }
echo "DASHBOARD_401_OK"

echo
echo "== DASHBOARD 200 =="
AUTH_CODE="$(curl -s -u "$DASHBOARD_USER:$DASHBOARD_PASS" -o /dev/null -w '%{http_code}' "$API_URL$DASHBOARD_ROUTE")"
[ "$AUTH_CODE" = "200" ] || { echo "ERROR: dashboard auth expected 200 got $AUTH_CODE"; exit 1; }
echo "DASHBOARD_200_OK"

echo
echo "== EFFECTIVE ENV =="
docker compose -f "$COMPOSE_FILE" exec -T api env | grep -E '^(REDIS_URL|REDIS_HOST|REDIS_PORT)='
docker compose -f "$COMPOSE_FILE" exec -T api env | grep -F 'REDIS_URL=redis://redis:6379' >/dev/null || { echo "ERROR: REDIS_URL mismatch"; exit 1; }
docker compose -f "$COMPOSE_FILE" exec -T api env | grep -F 'REDIS_HOST=redis' >/dev/null || { echo "ERROR: REDIS_HOST mismatch"; exit 1; }
docker compose -f "$COMPOSE_FILE" exec -T api env | grep -F 'REDIS_PORT=6379' >/dev/null || { echo "ERROR: REDIS_PORT mismatch"; exit 1; }

echo
echo "== ASSERT NO RUNTIME PNPM DOWNLOAD =="
if docker compose -f "$COMPOSE_FILE" logs api 2>&1 | grep -F "Corepack is about to download" >/dev/null; then
  echo "ERROR: runtime pnpm download detected"
  exit 1
fi
echo "NO_RUNTIME_DOWNLOAD_OK"

echo
echo "== ASSERT NO LOCALHOST REDIS FALLBACK =="
if docker compose -f "$COMPOSE_FILE" logs api 2>&1 | grep -F "ECONNREFUSED 127.0.0.1:6379" >/dev/null; then
  echo "ERROR: localhost redis fallback detected"
  exit 1
fi
echo "REDIS_RUNTIME_WIRING_OK"

echo
echo "== RESTART API =="
docker compose -f "$COMPOSE_FILE" restart api
sleep 10

RESTART_HEALTH_CODE="$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/api/health")"
[ "$RESTART_HEALTH_CODE" = "200" ] || { echo "ERROR: health after restart failed"; exit 1; }

RESTART_AUTH_CODE="$(curl -s -u "$DASHBOARD_USER:$DASHBOARD_PASS" -o /dev/null -w '%{http_code}' "$API_URL$DASHBOARD_ROUTE")"
[ "$RESTART_AUTH_CODE" = "200" ] || { echo "ERROR: dashboard after restart expected 200 got $RESTART_AUTH_CODE"; exit 1; }

echo "GO_LIVE_CHECK_OK"
