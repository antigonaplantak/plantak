#!/usr/bin/env bash
set -euo pipefail

[ -f .env.local ] && . ./.env.local

API="${API_URL:-http://localhost:3101/api}"
OWNER_EMAIL="${OWNER_EMAIL:-owner@example.com}"
TZ_NAME="${TZ_NAME:-Europe/Paris}"

BUSINESS_ID="${BUSINESS_ID:-b1}"
STAFF_ID="${STAFF_ID:-b9b77322-1012-4860-af1b-5b53a6171d06}"
BASE_SERVICE_ID="${BASE_SERVICE_ID:-f37eca6e-8729-4a73-a498-028436514c1b}"
CUSTOMER_ID="${CUSTOMER_ID:-d50451d5-6431-4069-abbc-dadd904bb806}"

fail() {
  echo "PROOF_FAIL: $*"
  exit 1
}

section() {
  echo
  echo "== $1 =="
}

json_get() {
  local path="$1"
  node -e '
let s="";
const path=(process.argv[1]||"").split(".");
process.stdin.on("data",d=>s+=d);
process.stdin.on("end",()=>{
  const j=JSON.parse(s);
  let cur=j;
  for (const p of path) {
    if (p === "") continue;
    if (cur == null) process.exit(2);
    if (/^\d+$/.test(p)) cur = cur[Number(p)];
    else cur = cur[p];
  }
  if (typeof cur === "object") process.stdout.write(JSON.stringify(cur));
  else process.stdout.write(String(cur));
});
' "$path"
}

slot_count_json() {
  node -e '
let s="";
process.stdin.on("data",d=>s+=d);
process.stdin.on("end",()=>{
  const j=JSON.parse(s);
  const n=((j?.results?.[0]?.slots)||[]).length;
  process.stdout.write(String(n));
});
'
}

first_slot_json() {
  node -e '
let s="";
process.stdin.on("data",d=>s+=d);
process.stdin.on("end",()=>{
  const j=JSON.parse(s);
  const slots=j?.results?.[0]?.slots || [];
  if (!slots.length) process.exit(2);
  process.stdout.write(String(slots[0].start));
});
'
}

last_slot_json() {
  node -e '
let s="";
process.stdin.on("data",d=>s+=d);
process.stdin.on("end",()=>{
  const j=JSON.parse(s);
  const slots=j?.results?.[0]?.slots || [];
  if (!slots.length) process.exit(2);
  process.stdout.write(String(slots[slots.length-1].start));
});
'
}

availability_signature() {
  node -e '
let s="";
process.stdin.on("data",d=>s+=d);
process.stdin.on("end",()=>{
  const j=JSON.parse(s);
  const totalMin=j?.results?.[0]?.totalMin ?? j?.totalMin ?? null;
  const slots=(j?.results?.[0]?.slots || []).map(x => `${x.start}|${x.end}`).join(",");
  process.stdout.write(`${totalMin}::${slots}`);
});
'
}

future_date() {
  python3 - "$1" <<'PY'
from datetime import date, timedelta
import sys
print((date.today() + timedelta(days=int(sys.argv[1]))).isoformat())
PY
}

shift_date() {
  python3 - "$1" "$2" <<'PY'
from datetime import date, timedelta
import sys
d = date.fromisoformat(sys.argv[1]) + timedelta(days=int(sys.argv[2]))
print(d.isoformat())
PY
}

shift_utc_minutes() {
  python3 - "$1" "$2" <<'PY'
from datetime import datetime, timedelta, timezone
import sys
dt = datetime.fromisoformat(sys.argv[1].replace("Z","+00:00"))
dt = dt + timedelta(minutes=int(sys.argv[2]))
print(dt.astimezone(timezone.utc).isoformat().replace("+00:00","Z"))
PY
}

utc_to_local_min() {
  python3 - "$1" "$2" <<'PY'
from datetime import datetime
from zoneinfo import ZoneInfo
import sys
dt = datetime.fromisoformat(sys.argv[1].replace("Z","+00:00")).astimezone(ZoneInfo(sys.argv[2]))
print(dt.strftime("%Y-%m-%dT%H:%M"))
PY
}

find_day_with_slots() {
  local service_id="$1"
  local extra_qs="${2:-}"
  local start_offset="${3:-180}"
  local end_offset="${4:-240}"
  local min_count="${5:-2}"

  local off ymd url res count
  for off in $(seq "$start_offset" "$end_offset"); do
    ymd="$(future_date "$off")"
    url="$API/availability?businessId=$BUSINESS_ID&serviceId=$service_id&staffId=$STAFF_ID&date=$ymd&tz=$TZ_NAME$extra_qs"
    res="$(curl -fsS "$url" 2>/dev/null || true)"
    [ -n "$res" ] || continue
    count="$(printf '%s' "$res" | slot_count_json 2>/dev/null || echo 0)"
    if [ "${count:-0}" -ge "$min_count" ]; then
      printf '%s\n' "$ymd"
      return 0
    fi
  done
  return 1
}

find_day_from_base_with_slots() {
  local base_date="$1"
  local service_id="$2"
  local extra_qs="${3:-}"
  local min_count="${4:-1}"

  local delta ymd url res count
  for delta in 7 14 21 28 35; do
    ymd="$(shift_date "$base_date" "$delta")"
    url="$API/availability?businessId=$BUSINESS_ID&serviceId=$service_id&staffId=$STAFF_ID&date=$ymd&tz=$TZ_NAME$extra_qs"
    res="$(curl -fsS "$url" 2>/dev/null || true)"
    [ -n "$res" ] || continue
    count="$(printf '%s' "$res" | slot_count_json 2>/dev/null || echo 0)"
    if [ "${count:-0}" -ge "$min_count" ]; then
      printf '%s\n' "$ymd"
      return 0
    fi
  done
  return 1
}

auth_token() {
  local req_out verify_out req_http verify_http code token

  req_out="$(mktemp)"
  verify_out="$(mktemp)"

  req_http="$(curl -sS -o "$req_out" -w '%{http_code}' -X POST "$API/auth/magic/request" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$OWNER_EMAIL\"}")"

  [ "$req_http" -ge 200 ] && [ "$req_http" -lt 300 ] || fail "AUTH_REQUEST_FAILED"

  code="$(python3 - "$req_out" <<'PY2'
import json, sys
data = json.load(open(sys.argv[1], "r", encoding="utf-8"))
code = data.get("devCode")
if not code:
    raise SystemExit("DEV_CODE_MISSING")
print(code)
PY2
)" || fail "TOKEN_CODE_NOT_FOUND"

  verify_http="$(curl -sS -o "$verify_out" -w '%{http_code}' -X POST "$API/auth/magic/verify" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$OWNER_EMAIL\",\"code\":\"$code\"}")"

  [ "$verify_http" -ge 200 ] && [ "$verify_http" -lt 300 ] || fail "AUTH_VERIFY_FAILED"

  token="$(python3 - "$verify_out" <<'PY2'
import json, sys
data = json.load(open(sys.argv[1], "r", encoding="utf-8"))
token = data.get("accessToken")
if not token:
    raise SystemExit("ACCESS_TOKEN_MISSING")
print(token)
PY2
)" || fail "ACCESS_TOKEN_PARSE_FAILED"

  printf '%s' "$token"
}

create_booking() {
  local service_id="$1"
  local start_at="$2"
  local body
  body="$(printf '{"businessId":"%s","staffId":"%s","serviceId":"%s","customerId":"%s","startAt":"%s","tz":"%s"}' \
    "$BUSINESS_ID" "$STAFF_ID" "$service_id" "$CUSTOMER_ID" "$start_at" "$TZ_NAME")"

  curl -sS -X POST "$API/bookings" \
    -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' \
    -d "$body" -w $'\nHTTP=%{http_code}'
}

cancel_booking() {
  local booking_id="$1"
  curl -fsS -X POST "$API/bookings/$booking_id/cancel" \
    -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' \
    -d "{\"businessId\":\"$BUSINESS_ID\"}" >/dev/null
}

TOKEN="$(auth_token)"
echo "TOKEN_OK"

bash scripts/proofs/availability/dst_jump_forward.sh

bash scripts/proofs/availability/dst_fallback.sh

section "SLOT_BOUNDARY_PROOF"
DATE_BOUNDARY="$(find_day_with_slots "$BASE_SERVICE_ID" "" 180 260 2)" || fail "BOUNDARY_DAY_NOT_FOUND"
AVAIL_BOUNDARY="$(curl -fsS "$API/availability?businessId=$BUSINESS_ID&serviceId=$BASE_SERVICE_ID&staffId=$STAFF_ID&date=$DATE_BOUNDARY&tz=$TZ_NAME")"
FIRST_START="$(printf '%s' "$AVAIL_BOUNDARY" | first_slot_json)"
LAST_START="$(printf '%s' "$AVAIL_BOUNDARY" | last_slot_json)"
INTERVAL_MIN="$(printf '%s' "$AVAIL_BOUNDARY" | json_get intervalMin)"

echo "BOUNDARY_DATE=$DATE_BOUNDARY"
echo "FIRST_START=$FIRST_START"
echo "LAST_START=$LAST_START"
echo "INTERVAL_MIN=$INTERVAL_MIN"

CREATE_FIRST="$(create_booking "$BASE_SERVICE_ID" "$FIRST_START")"
printf '%s\n' "$CREATE_FIRST"
FIRST_HTTP="$(printf '%s' "$CREATE_FIRST" | tail -n1 | sed 's/^HTTP=//')"
[ "$FIRST_HTTP" = "201" ] || fail "FIRST_BOUNDARY_CREATE_NOT_201"
FIRST_ID="$(printf '%s' "$CREATE_FIRST" | sed '$d' | json_get id)"

CREATE_LAST="$(create_booking "$BASE_SERVICE_ID" "$LAST_START")"
printf '%s\n' "$CREATE_LAST"
LAST_HTTP="$(printf '%s' "$CREATE_LAST" | tail -n1 | sed 's/^HTTP=//')"
[ "$LAST_HTTP" = "201" ] || fail "LAST_BOUNDARY_CREATE_NOT_201"
LAST_ID="$(printf '%s' "$CREATE_LAST" | sed '$d' | json_get id)"

BEYOND_LAST_START="$(shift_utc_minutes "$LAST_START" "$INTERVAL_MIN")"
echo "BEYOND_LAST_START=$BEYOND_LAST_START"

BEYOND_BODY="$(printf '{"businessId":"%s","staffId":"%s","serviceId":"%s","customerId":"%s","startAt":"%s","tz":"%s"}' \
  "$BUSINESS_ID" "$STAFF_ID" "$BASE_SERVICE_ID" "$CUSTOMER_ID" "$BEYOND_LAST_START" "$TZ_NAME")"

BEYOND_HTTP="$(curl -sS -o /tmp/availability_boundary_beyond.json -w '%{http_code}' \
  -X POST "$API/bookings" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "$BEYOND_BODY")"

cat /tmp/availability_boundary_beyond.json
echo
echo "HTTP=$BEYOND_HTTP"

[ "$BEYOND_HTTP" = "409" ] || fail "BEYOND_LAST_BOUNDARY_EXPECTED_409"

cancel_booking "$FIRST_ID"
cancel_booking "$LAST_ID"

echo "SLOT_BOUNDARY_PROOF_OK"

section "TIMEZONE_CONVERSION_PROOF"
DATE_TZ_PROOF="$(find_day_with_slots "$BASE_SERVICE_ID" "" 261 340 2)" || fail "TZ_DAY_NOT_FOUND"
AVAIL_TZ="$(curl -fsS "$API/availability?businessId=$BUSINESS_ID&serviceId=$BASE_SERVICE_ID&staffId=$STAFF_ID&date=$DATE_TZ_PROOF&tz=$TZ_NAME")"
START_A="$(printf '%s' "$AVAIL_TZ" | first_slot_json)"
START_B="$(printf '%s' "$AVAIL_TZ" | last_slot_json)"
[ "$START_A" != "$START_B" ] || fail "TZ_PROOF_NEEDS_DISTINCT_SLOTS"

echo "TZ_DATE=$DATE_TZ_PROOF"
echo "START_A=$START_A"
echo "START_B=$START_B"

CREATE_TZ="$(create_booking "$BASE_SERVICE_ID" "$START_A")"
printf '%s\n' "$CREATE_TZ"
TZ_HTTP="$(printf '%s' "$CREATE_TZ" | tail -n1 | sed 's/^HTTP=//')"
[ "$TZ_HTTP" = "201" ] || fail "TZ_CREATE_NOT_201"
TZ_ID="$(printf '%s' "$CREATE_TZ" | sed '$d' | json_get id)"

NEW_START_LOCAL="$(utc_to_local_min "$START_B" "$TZ_NAME")"
echo "NEW_START_LOCAL=$NEW_START_LOCAL"

RESCHED_BODY="$(printf '{"businessId":"%s","newStartLocal":"%s","tz":"%s"}' \
  "$BUSINESS_ID" "$NEW_START_LOCAL" "$TZ_NAME")"

RESCHED_TZ="$(curl -fsS -X POST "$API/bookings/$TZ_ID/reschedule" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "$RESCHED_BODY")"
printf '%s\n' "$RESCHED_TZ"

RESCHED_START="$(printf '%s' "$RESCHED_TZ" | json_get startAt)"
[ "$RESCHED_START" = "$START_B" ] || fail "TZ_RESCHEDULE_UTC_MISMATCH expected=$START_B actual=$RESCHED_START"

cancel_booking "$TZ_ID"

echo "TIMEZONE_CONVERSION_PROOF_OK"

bash scripts/proofs/availability/working_hours_timeoff_totalmin.sh

bash scripts/proofs/availability/addon_normalization_consistency.sh

echo "AVAILABILITY_ENTERPRISE_PROOF_OK"
