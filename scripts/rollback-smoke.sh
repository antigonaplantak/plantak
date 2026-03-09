#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TARGET_REF="${1:-production-deploy-discipline-green-20260309}"
STAMP="$(date +%Y%m%d-%H%M%S)"
WORKTREE_DIR="$ROOT_DIR/.rollback-smoke-$STAMP"
TMP_COMPOSE="$WORKTREE_DIR/infra/docker-compose.rollback.yml"
PROJECT_NAME="plantak-rollback-smoke-$STAMP"
API_URL="http://localhost:3011"
DASHBOARD_ROUTE="${QUEUE_DASHBOARD_ROUTE:-/api/ops/queues}"
DASHBOARD_USER="${QUEUE_DASHBOARD_USER:-ops}"
DASHBOARD_PASS="${QUEUE_DASHBOARD_PASS:-change-this-now}"

cleanup() {
  docker compose -p "$PROJECT_NAME" -f "$TMP_COMPOSE" down -v --remove-orphans >/dev/null 2>&1 || true
  git worktree remove --force "$WORKTREE_DIR" >/dev/null 2>&1 || true
}
trap cleanup EXIT

git rev-parse --verify "$TARGET_REF" >/dev/null
git worktree add --detach "$WORKTREE_DIR" "$TARGET_REF" >/dev/null

python3 -c "from pathlib import Path; p=Path('$WORKTREE_DIR/infra/docker-compose.yml'); t=p.read_text(); t=t.replace('\"3001:3001\"','\"3011:3001\"').replace('\"5432:5432\"','\"5433:5432\"').replace('\"6379:6379\"','\"6380:6379\"'); Path('$TMP_COMPOSE').write_text(t)"

export ENABLE_QUEUE_DASHBOARD=true
export QUEUE_DASHBOARD_USER="$DASHBOARD_USER"
export QUEUE_DASHBOARD_PASS="$DASHBOARD_PASS"
export QUEUE_DASHBOARD_ROUTE="$DASHBOARD_ROUTE"

docker compose -p "$PROJECT_NAME" -f "$TMP_COMPOSE" up -d --build
sleep 12

HEALTH_CODE="$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/api/health")"
[ "$HEALTH_CODE" = "200" ] || { echo "ERROR: rollback smoke health failed"; exit 1; }

AUTH_CODE="$(curl -s -u "$DASHBOARD_USER:$DASHBOARD_PASS" -o /dev/null -w '%{http_code}' "$API_URL$DASHBOARD_ROUTE")"
[ "$AUTH_CODE" = "200" ] || { echo "ERROR: rollback smoke dashboard expected 200 got $AUTH_CODE"; exit 1; }

echo "ROLLBACK_SMOKE_OK target=$TARGET_REF"
