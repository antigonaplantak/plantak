#!/usr/bin/env bash

pick_first_slot_json() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);const slots=j?.results?.[0]?.slots ?? [];if(!slots.length) process.exit(2);process.stdout.write(String(slots[0].start));});'
}

pick_next_slot_json() {
  CURRENT_START="$1" node -e 'let s="";const current=process.env.CURRENT_START || "";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);const slots=j?.results?.[0]?.slots ?? [];const chosen=[...slots].reverse().find(x=>x.start!==current);if(!chosen) process.exit(2);process.stdout.write(String(chosen.start));});'
}

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$APP_DIR" || exit 1

API="${API:-http://localhost:3001/api}"
OWNER_EMAIL="${OWNER_EMAIL:-owner@example.com}"
BUSINESS_ID="${BUSINESS_ID:-b1}"
STAFF_ID="${STAFF_ID:-b9b77322-1012-4860-af1b-5b53a6171d06}"
SERVICE_ID="${SERVICE_ID:-f37eca6e-8729-4a73-a498-028436514c1b}"
CUSTOMER_ID="${CUSTOMER_ID:-9ae97f7d-56b1-4e0e-a347-c76776bfd090}"
TZ="${TZ_OVERRIDE:-Europe/Paris}"
DATE_YMD="${DATE_YMD:-$(python3 - <<'PY2'
from datetime import date, timedelta
print((date.today() + timedelta(days=180)).isoformat())
PY2
)}"
START_AT="${START_AT:-${DATE_YMD}T10:00:00.000Z}"
NEW_START_AT="${NEW_START_AT:-${DATE_YMD}T12:00:00.000Z}"
NEW_START_LOCAL="2026-07-07T14:00"

json_read() {
  node -e '
const fs = require("fs");
const raw = fs.readFileSync(0, "utf8");
let data = {};
try { data = JSON.parse(raw || "{}"); } catch {}
const pick = (obj, path) => path.split(".").reduce((acc, key) => acc && acc[key], obj);
for (const path of process.argv.slice(1)) {
  const value = pick(data, path);
  if (value !== undefined && value !== null && value !== "") {
    process.stdout.write(String(value));
    process.exit(0);
  }
}
' "$@"
}

extract_magic_code() {
  local req="${1:-}"
  local code
  code="$(printf '%s' "$req" | json_read code devCode debugCode otp data.code data.devCode data.debugCode data.otp || true)"
  if [ -z "$code" ] && [ -f /tmp/plantak_api.log ]; then
    code="$(grep -oE "\\[MAGIC DEV CODE\\] ${OWNER_EMAIL} => [0-9]+" /tmp/plantak_api.log | tail -1 | grep -oE '[0-9]+$' || true)"
  fi
  printf '%s' "$code"
}

extract_access_token() {
  local body="${1:-}"
  printf '%s' "$body" | json_read \
    accessToken \
    access_token \
    token \
    jwt \
    tokens.accessToken \
    tokens.access_token \
    data.accessToken \
    data.access_token \
    data.token \
    data.jwt \
    data.tokens.accessToken \
    data.tokens.access_token || true
}

availability_key_pattern() {
  printf 'plantak:availability:businessId=%s:serviceId=%s:date=%s:staffId=%s:*' \
    "$BUSINESS_ID" "$SERVICE_ID" "$DATE_YMD" "$STAFF_ID"
}

list_cache_keys() {
  local pattern
  pattern="$(availability_key_pattern)"
  redis-cli --scan --pattern "$pattern" 2>/dev/null || true
}

assert_no_cache_keys() {
  local keys
  keys="$(list_cache_keys)"
  if [ -n "$keys" ]; then
    echo "CACHE_KEYS_SHOULD_BE_EMPTY"
    printf '%s\n' "$keys"
    exit 1
  fi
}

echo "== HEALTH =="
curl -sS "$API/health"
echo

echo
echo "== AUTH =="
REQ="$(curl -sS -X POST "$API/auth/magic/request" \
  -H 'content-type: application/json' \
  --data "{\"email\":\"$OWNER_EMAIL\"}")"
CODE="$(extract_magic_code "$REQ")"
[ -n "$CODE" ] || { echo "MAGIC_REQUEST_RESPONSE=$REQ"; echo "NO_CODE"; exit 1; }

VER="$(curl -sS -X POST "$API/auth/magic/verify" \
  -H 'content-type: application/json' \
  --data "{\"email\":\"$OWNER_EMAIL\",\"code\":\"$CODE\"}")"
TOKEN="$(extract_access_token "$VER")"
[ -n "$TOKEN" ] || { echo "MAGIC_VERIFY_RESPONSE=$VER"; echo "NO_TOKEN"; exit 1; }
echo "TOKEN_OK"

echo
echo "== TRY =="
echo "DATE_YMD=$DATE_YMD"
echo "START_AT=$START_AT"
echo "NEW_START_AT=$NEW_START_AT"

echo
echo "== PRIME BEFORE CREATE =="
AVAIL_BEFORE="$(curl -fsS "$API/availability?businessId=$BUSINESS_ID&serviceId=$SERVICE_ID&staffId=$STAFF_ID&date=$DATE_YMD&tz=Europe/Paris")"
printf '%s\n' "$AVAIL_BEFORE"

if [ "${AUTO_PICK_SLOTS:-1}" = "1" ]; then
  START_AT="$(printf '%s' "$AVAIL_BEFORE" | pick_first_slot_json)" || {
    echo "AUTO_PICK_CREATE_SLOT_FAIL"
    exit 1
  }
fi
echo "AUTO_START_AT=$START_AT"

echo "== CREATE =="
CREATE_BODY="$(printf '{"businessId":"%s","staffId":"%s","serviceId":"%s","customerId":"%s","startAt":"%s","tz":"%s"}' \
  "$BUSINESS_ID" "$STAFF_ID" "$SERVICE_ID" "$CUSTOMER_ID" "$START_AT" "$TZ")"
CREATE_RES="$(curl -sS -w '\nHTTP=%{http_code}\n' -X POST "$API/bookings" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  --data "$CREATE_BODY")"
printf '%s' "$CREATE_RES"
echo
BOOKING_ID="$(printf '%s' "$CREATE_RES" | sed -n '1p' | json_read id || true)"
[ -n "$BOOKING_ID" ] || { echo "NO_BOOKING_ID"; exit 1; }

echo
echo "BOOKING_ID=$BOOKING_ID"

echo
echo "== PRIME CACHE BEFORE CONFIRM =="
curl -sS "$API/availability?businessId=$BUSINESS_ID&serviceId=$SERVICE_ID&staffId=$STAFF_ID&date=$DATE_YMD&tz=$TZ" >/dev/null
echo "== KEYS BEFORE CONFIRM =="
list_cache_keys

echo
echo "== CONFIRM =="
curl -sS -w '\nHTTP=%{http_code}\n' -X POST "$API/bookings/$BOOKING_ID/confirm" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  --data "{\"businessId\":\"$BUSINESS_ID\"}"
echo
echo "== KEYS AFTER CONFIRM =="
assert_no_cache_keys

echo
echo "== PRIME CACHE BEFORE RESCHEDULE =="
AVAIL_FOR_RESCHEDULE="$(curl -fsS "$API/availability?businessId=$BUSINESS_ID&serviceId=$SERVICE_ID&staffId=$STAFF_ID&date=$DATE_YMD&tz=Europe/Paris")"
printf '%s\n' "$AVAIL_FOR_RESCHEDULE"

if [ "${AUTO_PICK_SLOTS:-1}" = "1" ]; then
  NEW_START_AT="$(printf '%s' "$AVAIL_FOR_RESCHEDULE" | pick_next_slot_json "$START_AT")" || {
    echo "AUTO_PICK_RESCHEDULE_SLOT_FAIL"
    exit 1
  }
fi
echo "AUTO_NEW_START_AT=$NEW_START_AT"
NEW_START_LOCAL="$(python3 - "$NEW_START_AT" <<'PY2'
from datetime import datetime
from zoneinfo import ZoneInfo
import sys
dt = datetime.fromisoformat(sys.argv[1].replace("Z","+00:00")).astimezone(ZoneInfo("Europe/Paris"))
print(dt.strftime("%Y-%m-%dT%H:%M"))
PY2
)"
echo "AUTO_NEW_START_LOCAL=$NEW_START_LOCAL"

echo "== RESCHEDULE =="
RESCHEDULE_BODY="$(printf '{"businessId":"%s","newStartLocal":"%s","tz":"%s"}' \
  "$BUSINESS_ID" "$NEW_START_LOCAL" "$TZ")"
RESCHEDULE_RES="$(curl -sS -w '\nHTTP=%{http_code}\n' -X POST "$API/bookings/$BOOKING_ID/reschedule" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  --data "$RESCHEDULE_BODY")"
printf '%s\n' "$RESCHEDULE_RES"
HTTP="$(printf '%s\n' "$RESCHEDULE_RES" | sed -n '$s/^HTTP=//p')"
[ "$HTTP" = "201" ] || { echo "RESCHEDULE_FAILED"; exit 1; }
echo
echo "== KEYS AFTER RESCHEDULE =="
assert_no_cache_keys

echo
echo "== PRIME CACHE BEFORE CANCEL =="
curl -sS "$API/availability?businessId=$BUSINESS_ID&serviceId=$SERVICE_ID&staffId=$STAFF_ID&date=$DATE_YMD&tz=$TZ" >/dev/null
echo "== KEYS BEFORE CANCEL =="
list_cache_keys

echo
echo "== CANCEL =="
curl -sS -w '\nHTTP=%{http_code}\n' -X POST "$API/bookings/$BOOKING_ID/cancel" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  --data "{\"businessId\":\"$BUSINESS_ID\"}"
echo
echo "== KEYS AFTER CANCEL =="
assert_no_cache_keys

echo
echo "== FINAL REGRESSION =="
curl -sS -o /tmp/reg_public_services.json -w 'public/services HTTP=%{http_code} TIME=%{time_total}\n' \
  "$API/public/services?businessId=$BUSINESS_ID"
curl -sS -o /tmp/reg_availability.json -w 'availability HTTP=%{http_code} TIME=%{time_total}\n' \
  "$API/availability?businessId=$BUSINESS_ID&serviceId=$SERVICE_ID&staffId=$STAFF_ID&date=$DATE_YMD&tz=$TZ"
wc -c /tmp/reg_public_services.json /tmp/reg_availability.json

echo
echo "SMOKE_OK"
