#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "== Plantak: GO-LIVE CHECK =="

# Load .env if present
if [ -f .env ]; then
  set -a; source .env; set +a
fi

PORT="${PORT:-3000}"
BASE_URL="${BASE_URL:-http://localhost:${PORT}}"
COMPOSE_FILE="${COMPOSE_FILE:-infra/docker-compose.yml}"

# Optional smoke credentials (used if /auth/login exists)
SMOKE_EMAIL="${SMOKE_EMAIL:-demo@plantak.local}"
SMOKE_PASSWORD="${SMOKE_PASSWORD:-DemoPass123!}"

# Optional booking test inputs (only if you have these endpoints ready)
BUSINESS_ID="${BUSINESS_ID:-}"
SERVICE_ID="${SERVICE_ID:-}"
STAFF_ID="${STAFF_ID:-}"

echo "BASE_URL: $BASE_URL"
echo "COMPOSE_FILE: $COMPOSE_FILE"
echo

fail() { echo "❌ $1"; exit 1; }
warn() { echo "⚠️ $1"; }
ok()   { echo "✅ $1"; }

# 1) Docker/Infra check (optional; skips if compose file missing)
if [ -f "$COMPOSE_FILE" ]; then
  if ! command -v docker >/dev/null 2>&1; then
    warn "Docker not found - skipping infra checks."
  else
    echo "-- Infra: docker compose status --"
    docker compose -f "$COMPOSE_FILE" ps || warn "docker compose ps failed"

    DB_ID="$(docker compose -f "$COMPOSE_FILE" ps -q db 2>/dev/null || true)"
    REDIS_ID="$(docker compose -f "$COMPOSE_FILE" ps -q redis 2>/dev/null || true)"

    if [ -n "$DB_ID" ]; then
      DB_HEALTH="$(docker inspect --format='{{.State.Health.Status}}' "$DB_ID" 2>/dev/null || echo unknown)"
      [ "$DB_HEALTH" = "healthy" ] && ok "Postgres healthy" || warn "Postgres health: $DB_HEALTH"
    else
      warn "No 'db' service container found in compose (skipping DB health)"
    fi

    if [ -n "$REDIS_ID" ]; then
      REDIS_HEALTH="$(docker inspect --format='{{.State.Health.Status}}' "$REDIS_ID" 2>/dev/null || echo unknown)"
      [ "$REDIS_HEALTH" = "healthy" ] && ok "Redis healthy" || warn "Redis health: $REDIS_HEALTH"
    else
      warn "No 'redis' service container found in compose (skipping Redis health)"
    fi
  fi
else
  warn "Compose file not found ($COMPOSE_FILE). Skipping infra checks."
fi

echo
echo "-- API: health check --"

# 2) API health
if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
  ok "/health OK"
else
  warn "/health not found (recommended). Trying base route..."
  if curl -fsS "$BASE_URL" >/dev/null 2>&1; then
    ok "Base route responds"
  else
    fail "API not responding on $BASE_URL (start backend first)"
  fi
fi

echo
echo "-- Auth: smoke test (optional) --"

# 3) Auth login -> token -> /auth/me (optional)
TOKEN=""
LOGIN_RES=""

if curl -fsS -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$SMOKE_EMAIL\",\"password\":\"$SMOKE_PASSWORD\"}" >/tmp/plantak_login.json 2>/dev/null; then
  LOGIN_RES="$(cat /tmp/plantak_login.json || true)"
else
  warn "/auth/login not available yet OR credentials invalid. Skipping auth check."
fi

if [ -n "$LOGIN_RES" ]; then
  if command -v jq >/dev/null 2>&1; then
    TOKEN="$(echo "$LOGIN_RES" | jq -r '.accessToken // .access_token // .token // empty')"
  else
    TOKEN="$(echo "$LOGIN_RES" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')"
    [ -z "$TOKEN" ] && TOKEN="$(echo "$LOGIN_RES" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')"
    [ -z "$TOKEN" ] && TOKEN="$(echo "$LOGIN_RES" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
  fi

  if [ -n "$TOKEN" ]; then
    ok "Login OK (token extracted)"
    if curl -fsS "$BASE_URL/auth/me" -H "Authorization: Bearer $TOKEN" >/tmp/plantak_me.json 2>/dev/null; then
      ok "/auth/me OK"
    else
      warn "/auth/me failed (maybe endpoint different or cookie-based)."
    fi
  else
    warn "Login response received but no token found. Response saved at /tmp/plantak_login.json"
  fi
fi

echo
echo "-- Booking: core checks (optional, only if you already built these endpoints) --"

# Helper: check endpoint exists
endpoint_exists() {
  local url="$1"
  curl -fsS -I "$url" >/dev/null 2>&1 || curl -fsS "$url" >/dev/null 2>&1
}

# 4) Slots check (optional)
# Tries: GET /businesses/:businessId/slots?serviceId=...&date=YYYY-MM-DD&staffId=...
TODAY="$(date +%F)"
SLOTS_URL=""

if [ -n "${BUSINESS_ID}" ] && [ -n "${SERVICE_ID}" ]; then
  if [ -n "${STAFF_ID}" ]; then
    SLOTS_URL="$BASE_URL/businesses/$BUSINESS_ID/slots?serviceId=$SERVICE_ID&date=$TODAY&staffId=$STAFF_ID"
  else
    SLOTS_URL="$BASE_URL/businesses/$BUSINESS_ID/slots?serviceId=$SERVICE_ID&date=$TODAY"
  fi

  if endpoint_exists "$SLOTS_URL"; then
    ok "Slots endpoint reachable"
  else
    warn "Slots endpoint not reachable at: $SLOTS_URL (ok if not implemented yet)"
  fi
else
  warn "Skipping slots check (set BUSINESS_ID and SERVICE_ID in .env to enable)"
fi

# 5) No-double-booking check (optional)
# Requires:
# - POST /businesses/:businessId/bookings
# Payload: { staffId, startAt, serviceId }  (adjust if yours differs)
# Script sends 5 parallel requests for same slot; expects only 1 success if no-double-booking works.
BOOK_URL=""
if [ -n "${BUSINESS_ID}" ] && [ -n "${SERVICE_ID}" ] && [ -n "${STAFF_ID}" ]; then
  BOOK_URL="$BASE_URL/businesses/$BUSINESS_ID/bookings"

  if ! endpoint_exists "$BOOK_URL"; then
    warn "Booking endpoint not reachable at: $BOOK_URL (ok if not implemented yet)"
    echo
    ok "GO-LIVE CHECK finished (with optional checks skipped/warned)."
    exit 0
  fi

  if [ -z "$TOKEN" ]; then
    warn "No token available; booking test needs auth. (Set SMOKE_EMAIL/SMOKE_PASSWORD and ensure /auth/login works.)"
    echo
    ok "GO-LIVE CHECK finished (with optional checks skipped/warned)."
    exit 0
  fi

  # Use a startAt a few minutes ahead, rounded to next 10 minutes
  NOW_EPOCH="$(date +%s)"
  START_EPOCH="$((NOW_EPOCH + 600))"
  # round down to 10-minute
  START_EPOCH="$((START_EPOCH - (START_EPOCH % 600)))"
  START_AT="$(date -u -d "@$START_EPOCH" +"%Y-%m-%dT%H:%M:%SZ")"

  echo "Attempting parallel booking test at startAt=$START_AT"
  PAYLOAD="$(printf '{"staffId":"%s","serviceId":"%s","startAt":"%s"}' "$STAFF_ID" "$SERVICE_ID" "$START_AT")"

  TMPDIR="$(mktemp -d)"
  SUCCESS=0
  FAILS=0

  for i in 1 2 3 4 5; do
    (
      HTTP_CODE="$(curl -sS -o "$TMPDIR/r$i.json" -w "%{http_code}" \
        -X POST "$BOOK_URL" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $TOKEN" \
        -d "$PAYLOAD" || true)"
      echo "$HTTP_CODE" > "$TMPDIR/c$i.txt"
    ) &
  done
  wait

  for i in 1 2 3 4 5; do
    CODE="$(cat "$TMPDIR/c$i.txt" 2>/dev/null || echo 000)"
    if [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; then
      SUCCESS=$((SUCCESS+1))
    else
      FAILS=$((FAILS+1))
    fi
  done

  echo "Parallel booking results: success=$SUCCESS fails=$FAILS (expect success=1 if no-double-booking is enforced)"
  if [ "$SUCCESS" -eq 1 ]; then
    ok "No-double-booking looks OK (only 1 request succeeded)"
  else
    warn "No-double-booking may be missing OR payload/endpoints differ. Inspect responses in: $TMPDIR/"
  fi
else
  warn "Skipping booking concurrency test (set BUSINESS_ID, SERVICE_ID, STAFF_ID to enable)"
fi

echo
ok "GO-LIVE CHECK finished."
echo "If you saw warnings, that's OK—only ❌ means you are blocked."
