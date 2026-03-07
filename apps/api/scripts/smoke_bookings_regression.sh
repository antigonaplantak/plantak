#!/usr/bin/env bash
set -euo pipefail

API="http://localhost:3001/api"
OWNER_EMAIL="owner@example.com"
BUSINESS_ID="b1"
SERVICE_ID="f37eca6e-8729-4a73-a498-028436514c1b"
STAFF_ID="b9b77322-1012-4860-af1b-5b53a6171d06"
TZ="Europe/Paris"
RUN_ID="${RUN_ID:-$(date +%s)}"

REDIS_CLI_CMD="${REDIS_CLI_CMD:-docker exec plantak_redis redis-cli}"

redis_keys() {
  bash -lc "$REDIS_CLI_CMD KEYS 'plantak:availability*'" 2>/dev/null || true
}

auth_token() {
  REQ="$(curl -sS -X POST "$API/auth/magic/request" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$OWNER_EMAIL\"}")"

  CODE="$(printf "%s" "$REQ" | python3 -c "import sys,json; print(json.load(sys.stdin).get(\"devCode\",\"\"))")"

  VER="$(curl -sS -X POST "$API/auth/magic/verify" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$OWNER_EMAIL\",\"code\":\"$CODE\"}")"

  printf "%s" "$VER" | python3 -c "import sys,json; print(json.load(sys.stdin).get(\"accessToken\",\"\"))"
}

candidate_slots() {
  python3 - <<'PY'
from datetime import datetime, timedelta, timezone

base = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)

# spread dates far enough to avoid hotspot collisions
day_offsets = [120, 137, 154, 171, 188, 205, 222, 239, 256, 273]
hours = [10, 11, 12, 13, 14, 15]

for d in day_offsets:
    for h in hours:
        start = base + timedelta(days=d, hours=h)
        new = start + timedelta(hours=2)
        print(
            start.strftime("%Y-%m-%d"),
            start.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            new.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        )
PY
}

echo "== HEALTH =="
curl -sS "$API/health"
echo; echo

echo "== AUTH =="
TOKEN="$(auth_token)"
[ -n "$TOKEN" ] || { echo "NO_TOKEN"; exit 1; }
echo "TOKEN_OK"
echo

SUCCESS=""

while read -r DATE_YMD START_AT NEW_START_AT; do
  echo "== TRY =="
  echo "DATE_YMD=$DATE_YMD"
  echo "START_AT=$START_AT"
  echo "NEW_START_AT=$NEW_START_AT"
  echo

  echo "== PRIME BEFORE CREATE =="
  curl -sS "$API/availability?businessId=$BUSINESS_ID&serviceId=$SERVICE_ID&staffId=$STAFF_ID&date=$DATE_YMD&tz=$TZ"
  echo; echo

  echo "== CREATE =="
  CREATE_RES="$(curl -sS -w "\nHTTP=%{http_code}\n" -X POST "$API/bookings" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"businessId\":\"$BUSINESS_ID\",\"staffId\":\"$STAFF_ID\",\"serviceId\":\"$SERVICE_ID\",\"startAt\":\"$START_AT\",\"tz\":\"$TZ\",\"idempotencyKey\":\"smoke-create-$RUN_ID-$DATE_YMD-$START_AT\"}")"
  echo "$CREATE_RES"
  echo

  CREATE_HTTP="$(printf "%s" "$CREATE_RES" | sed -n "s/^HTTP=//p")"
  [ "$CREATE_HTTP" = "201" ] || { echo "CREATE_SKIPPED"; echo; continue; }

  BOOKING_JSON="$(printf "%s" "$CREATE_RES" | sed "/^HTTP=/d")"
  BOOKING_ID="$(printf "%s" "$BOOKING_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get(\"id\",\"\"))")"
  [ -n "$BOOKING_ID" ] || { echo "NO_BOOKING_ID"; echo; continue; }

  echo "BOOKING_ID=$BOOKING_ID"
  echo

  echo "== PRIME CACHE BEFORE CONFIRM =="
  curl -sS "$API/availability?businessId=$BUSINESS_ID&serviceId=$SERVICE_ID&staffId=$STAFF_ID&date=$DATE_YMD&tz=$TZ" >/dev/null
  echo "== KEYS BEFORE CONFIRM =="
  redis_keys
  echo; echo

  echo "== CONFIRM =="
  CONFIRM_RES="$(curl -sS -w "\nHTTP=%{http_code}\n" -X POST "$API/bookings/$BOOKING_ID/confirm" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"businessId\":\"$BUSINESS_ID\"}")"
  echo "$CONFIRM_RES"
  echo

  CONFIRM_HTTP="$(printf "%s" "$CONFIRM_RES" | sed -n "s/^HTTP=//p")"
  [ "$CONFIRM_HTTP" = "201" ] || { echo "CONFIRM_FAILED"; echo; continue; }

  echo "== KEYS AFTER CONFIRM =="
  AFTER_CONFIRM="$(redis_keys)"
  printf "%s\n" "$AFTER_CONFIRM"
  [ -z "$AFTER_CONFIRM" ] || { echo "CACHE_NOT_CLEARED_AFTER_CONFIRM"; exit 1; }
  echo

  echo "== PRIME CACHE BEFORE RESCHEDULE =="
  curl -sS "$API/availability?businessId=$BUSINESS_ID&serviceId=$SERVICE_ID&staffId=$STAFF_ID&date=$DATE_YMD&tz=$TZ" >/dev/null
  echo "== KEYS BEFORE RESCHEDULE =="
  redis_keys
  echo; echo

  echo "== RESCHEDULE =="
  RESCHEDULE_RES="$(curl -sS -w "\nHTTP=%{http_code}\n" -X POST "$API/bookings/$BOOKING_ID/reschedule" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"businessId\":\"$BUSINESS_ID\",\"newStartAt\":\"$NEW_START_AT\",\"tz\":\"$TZ\",\"idempotencyKey\":\"smoke-reschedule-$RUN_ID-$DATE_YMD-$NEW_START_AT\"}")"
  echo "$RESCHEDULE_RES"
  echo

  RESCHEDULE_HTTP="$(printf "%s" "$RESCHEDULE_RES" | sed -n "s/^HTTP=//p")"

  if [ "$RESCHEDULE_HTTP" = "409" ]; then
    echo "RESCHEDULE_CONFLICT_TRY_NEXT_SLOT"
    curl -sS -X POST "$API/bookings/$BOOKING_ID/cancel" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"businessId\":\"$BUSINESS_ID\"}" >/dev/null 2>&1 || true
    echo
    continue
  fi

  [ "$RESCHEDULE_HTTP" = "201" ] || { echo "RESCHEDULE_FAILED"; exit 1; }

  echo "== KEYS AFTER RESCHEDULE =="
  AFTER_RESCHEDULE="$(redis_keys)"
  printf "%s\n" "$AFTER_RESCHEDULE"
  [ -z "$AFTER_RESCHEDULE" ] || { echo "CACHE_NOT_CLEARED_AFTER_RESCHEDULE"; exit 1; }
  echo

  echo "== PRIME CACHE BEFORE CANCEL =="
  curl -sS "$API/availability?businessId=$BUSINESS_ID&serviceId=$SERVICE_ID&staffId=$STAFF_ID&date=$DATE_YMD&tz=$TZ" >/dev/null
  echo "== KEYS BEFORE CANCEL =="
  redis_keys
  echo; echo

  echo "== CANCEL =="
  CANCEL_RES="$(curl -sS -w "\nHTTP=%{http_code}\n" -X POST "$API/bookings/$BOOKING_ID/cancel" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"businessId\":\"$BUSINESS_ID\"}")"
  echo "$CANCEL_RES"
  echo

  CANCEL_HTTP="$(printf "%s" "$CANCEL_RES" | sed -n "s/^HTTP=//p")"
  [ "$CANCEL_HTTP" = "201" ] || { echo "CANCEL_FAILED"; exit 1; }

  echo "== KEYS AFTER CANCEL =="
  AFTER_CANCEL="$(redis_keys)"
  printf "%s\n" "$AFTER_CANCEL"
  [ -z "$AFTER_CANCEL" ] || { echo "CACHE_NOT_CLEARED_AFTER_CANCEL"; exit 1; }
  echo

  echo "== FINAL REGRESSION =="
  curl -sS -o /tmp/reg_public_services.json -w "public/services HTTP=%{http_code} TIME=%{time_total}\n" "$API/public/services?businessId=$BUSINESS_ID"
  curl -sS -o /tmp/reg_availability.json -w "availability HTTP=%{http_code} TIME=%{time_total}\n" "$API/availability?businessId=$BUSINESS_ID&serviceId=$SERVICE_ID&staffId=$STAFF_ID&date=$DATE_YMD&tz=$TZ"
  echo
  wc -c /tmp/reg_public_services.json /tmp/reg_availability.json
  echo
  echo "SMOKE_OK"
  SUCCESS="1"
  break
done < <(candidate_slots)

[ -n "$SUCCESS" ] || { echo "NO_FREE_CANDIDATE_FOUND"; exit 1; }
