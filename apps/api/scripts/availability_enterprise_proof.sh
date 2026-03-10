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
  curl -fsS -X POST "$API/auth/magic/request" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$OWNER_EMAIL\"}" >/dev/null

  local code
  code="$(tail -n 200 /tmp/plantak_api.log 2>/dev/null | grep '\[MAGIC DEV CODE\]' | grep "$OWNER_EMAIL" | tail -n1 | sed -E 's/.* => ([0-9]{6}).*/\1/')" || true
  [ -n "${code:-}" ] || fail "TOKEN_CODE_NOT_FOUND"

  curl -fsS -X POST "$API/auth/magic/verify" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$OWNER_EMAIL\",\"code\":\"$code\"}" | json_get accessToken
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

section "DST_JUMP_FORWARD_PROOF"
echo "TODO: prove jump-forward local-day slot correctness around Europe/Paris DST start"
echo "DST_JUMP_FORWARD_PROOF_PENDING"

section "DST_FALLBACK_PROOF"
echo "TODO: prove fallback local-day slot correctness around Europe/Paris DST end"
echo "DST_FALLBACK_PROOF_PENDING"

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

section "WORKING_HOURS_TIMEOFF_TOTALMIN_PROOF"

echo "TOKEN_OK"

slot_count() {
  node -e '
let s="";
process.stdin.on("data", d => s += d);
process.stdin.on("end", () => {
  const j = JSON.parse(s);
  const n = ((((j || {}).results || [])[0] || {}).slots || []).length;
  process.stdout.write(String(n));
});
'
}

slot_present() {
  SLOT_START="$1" node -e '
let s="";
const target = process.env.SLOT_START || "";
process.stdin.on("data", d => s += d);
process.stdin.on("end", () => {
  const j = JSON.parse(s);
  const slots = ((((j || {}).results || [])[0] || {}).slots || []);
  const ok = slots.some(x => String(x.start) === target);
  process.stdout.write(ok ? "1" : "0");
});
'
}

TEMP_VARIANT_NAME="proof-wh-variant-$(date +%s)"
TEMP_ADDON_A_NAME="proof-wh-addon-a-$(date +%s)"
TEMP_ADDON_B_NAME="proof-wh-addon-b-$(date +%s)"

echo "== CREATE TEMP VARIANT ON BASE SERVICE =="
VARIANT_RES="$(curl -fsS -X POST "$API/services/$BASE_SERVICE_ID/variants" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data "$(printf '{"name":"%s","durationMin":80,"priceCents":8000,"onlineBookingEnabled":true}' "$TEMP_VARIANT_NAME")")"
printf '%s
' "$VARIANT_RES"
VARIANT_ID="$(printf '%s' "$VARIANT_RES" | json_get id)"
[ -n "$VARIANT_ID" ] || fail "VARIANT_ID_EMPTY"

echo "== CREATE TEMP ADDON A ON BASE SERVICE =="
ADDON_A_RES="$(curl -fsS -X POST "$API/services/$BASE_SERVICE_ID/addons" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data "$(printf '{"name":"%s","durationMin":15,"priceCents":500,"bufferAfterMin":5,"onlineBookingEnabled":true}' "$TEMP_ADDON_A_NAME")")"
printf '%s
' "$ADDON_A_RES"
ADDON_A_ID="$(printf '%s' "$ADDON_A_RES" | json_get id)"
[ -n "$ADDON_A_ID" ] || fail "ADDON_A_ID_EMPTY"

echo "== CREATE TEMP ADDON B ON BASE SERVICE =="
ADDON_B_RES="$(curl -fsS -X POST "$API/services/$BASE_SERVICE_ID/addons" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data "$(printf '{"name":"%s","durationMin":10,"priceCents":300,"bufferBeforeMin":5,"onlineBookingEnabled":true}' "$TEMP_ADDON_B_NAME")")"
printf '%s
' "$ADDON_B_RES"
ADDON_B_ID="$(printf '%s' "$ADDON_B_RES" | json_get id)"
[ -n "$ADDON_B_ID" ] || fail "ADDON_B_ID_EMPTY"

echo "== FIND CLEAN PROOF DATE =="
PROOF_DATE=""
AVAIL_BEFORE=""
for offset in $(seq 30 220); do
  CANDIDATE_DATE="$(python3 - "$offset" <<'PY2'
from datetime import date, timedelta
import sys
print((date.today() + timedelta(days=int(sys.argv[1]))).isoformat())
PY2
)"
  RES="$(curl -fsS "$API/availability?businessId=$BUSINESS_ID&serviceId=$BASE_SERVICE_ID&variantId=$VARIANT_ID&addonIds=$ADDON_A_ID,$ADDON_B_ID&staffId=$STAFF_ID&date=$CANDIDATE_DATE&tz=$TZ_NAME" || true)"
  [ -n "$RES" ] || continue

  COUNT="$(printf '%s' "$RES" | slot_count)"
  TOTAL="$(printf '%s' "$RES" | json_get totalMin || true)"

  if [ "${COUNT:-0}" -ge 7 ] && [ -n "${TOTAL:-}" ] && [ "$TOTAL" != "null" ]; then
    PROOF_DATE="$CANDIDATE_DATE"
    AVAIL_BEFORE="$RES"
    break
  fi
done

[ -n "$PROOF_DATE" ] || fail "PROOF_DATE_NOT_FOUND"
printf 'PROOF_DATE=%s
' "$PROOF_DATE"
printf '%s
' "$AVAIL_BEFORE"

TOTAL_MIN_BEFORE="$(printf '%s' "$AVAIL_BEFORE" | json_get totalMin)"
[ -n "$TOTAL_MIN_BEFORE" ] || fail "TOTAL_MIN_BEFORE_EMPTY"

SLOT_EARLY="$(printf '%s' "$AVAIL_BEFORE" | json_get results.0.slots.0.start)"
SLOT_BLOCKED_START="$(printf '%s' "$AVAIL_BEFORE" | json_get results.0.slots.3.start)"
SLOT_BLOCKED_END="$(printf '%s' "$AVAIL_BEFORE" | json_get results.0.slots.3.end)"
SLOT_LATE="$(printf '%s' "$AVAIL_BEFORE" | json_get results.0.slots.6.start)"

[ -n "$SLOT_EARLY" ] || fail "SLOT_EARLY_EMPTY"
[ -n "$SLOT_BLOCKED_START" ] || fail "SLOT_BLOCKED_START_EMPTY"
[ -n "$SLOT_BLOCKED_END" ] || fail "SLOT_BLOCKED_END_EMPTY"
[ -n "$SLOT_LATE" ] || fail "SLOT_LATE_EMPTY"

printf 'TOTAL_MIN_BEFORE=%s
' "$TOTAL_MIN_BEFORE"
printf 'SLOT_EARLY=%s
' "$SLOT_EARLY"
printf 'SLOT_BLOCKED_START=%s
' "$SLOT_BLOCKED_START"
printf 'SLOT_BLOCKED_END=%s
' "$SLOT_BLOCKED_END"
printf 'SLOT_LATE=%s
' "$SLOT_LATE"

echo "== CREATE TIME OFF TO BLOCK MIDDLE SLOT =="
TIMEOFF_RES="$(curl -fsS -X POST "$API/staff/$STAFF_ID/time-off" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data "$(printf '{"startAt":"%s","endAt":"%s"}' "$SLOT_BLOCKED_START" "$SLOT_BLOCKED_END")")"
printf '%s
' "$TIMEOFF_RES"
TIMEOFF_ID="$(printf '%s' "$TIMEOFF_RES" | json_get id)"
[ -n "$TIMEOFF_ID" ] || fail "TIMEOFF_ID_EMPTY"

echo "== AVAILABILITY AFTER TIME OFF =="
AVAIL_AFTER="$(curl -fsS "$API/availability?businessId=$BUSINESS_ID&serviceId=$BASE_SERVICE_ID&variantId=$VARIANT_ID&addonIds=$ADDON_A_ID,$ADDON_B_ID&staffId=$STAFF_ID&date=$PROOF_DATE&tz=$TZ_NAME")"
printf '%s
' "$AVAIL_AFTER"

TOTAL_MIN_AFTER="$(printf '%s' "$AVAIL_AFTER" | json_get totalMin)"
[ "$TOTAL_MIN_AFTER" = "$TOTAL_MIN_BEFORE" ] || fail "TOTAL_MIN_CHANGED_BEFORE=$TOTAL_MIN_BEFORE AFTER=$TOTAL_MIN_AFTER"

EARLY_PRESENT="$(printf '%s' "$AVAIL_AFTER" | slot_present "$SLOT_EARLY")"
BLOCKED_PRESENT="$(printf '%s' "$AVAIL_AFTER" | slot_present "$SLOT_BLOCKED_START")"
LATE_PRESENT="$(printf '%s' "$AVAIL_AFTER" | slot_present "$SLOT_LATE")"

[ "$EARLY_PRESENT" = "1" ] || fail "EARLY_SLOT_MISSING_AFTER_TIMEOFF"
[ "$BLOCKED_PRESENT" = "0" ] || fail "BLOCKED_SLOT_STILL_PRESENT"
[ "$LATE_PRESENT" = "1" ] || fail "LATE_SLOT_MISSING_AFTER_TIMEOFF"

echo "== CLEANUP TIME OFF =="
curl -fsS -X DELETE "$API/staff/$STAFF_ID/time-off/$TIMEOFF_ID" \
  -H "Authorization: Bearer $TOKEN" >/dev/null || fail "TIMEOFF_DELETE_FAILED"

echo "== VERIFY SLOT RETURNS AFTER CLEANUP =="
AVAIL_CLEAN="$(curl -fsS "$API/availability?businessId=$BUSINESS_ID&serviceId=$BASE_SERVICE_ID&variantId=$VARIANT_ID&addonIds=$ADDON_A_ID,$ADDON_B_ID&staffId=$STAFF_ID&date=$PROOF_DATE&tz=$TZ_NAME")"
BLOCKED_RETURNED="$(printf '%s' "$AVAIL_CLEAN" | slot_present "$SLOT_BLOCKED_START")"
[ "$BLOCKED_RETURNED" = "1" ] || fail "BLOCKED_SLOT_DID_NOT_RETURN_AFTER_CLEANUP"

echo "WORKING_HOURS_TIMEOFF_TOTALMIN_PROOF_OK"


section "ADDON_NORMALIZATION_CONSISTENCY_PROOF"

slot_signature() {
  node -e '
let s="";
process.stdin.on("data", d => s += d);
process.stdin.on("end", () => {
  const j = JSON.parse(s);
  const slots = (((j || {}).results || [])[0] || {}).slots || [];
  process.stdout.write(slots.map(x => String(x.start)).join(","));
});
'
}

total_min_of() {
  printf '%s' "$1" | json_get 'results.0.totalMin'
}

echo "PROOF_DATE=${PROOF_DATE:-2026-08-07}"
PROOF_DATE="${PROOF_DATE:-2026-08-07}"

[ -n "${TOKEN:-}" ] || fail "TOKEN_EMPTY"
echo "TOKEN_OK"

TMP_SUFFIX="$(date +%s)"

echo "== CREATE TEMP VARIANT ON BASE SERVICE =="
VARIANT_RES="$(curl -fsS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"proof-norm-variant-'"$TMP_SUFFIX"'","durationMin":80,"priceCents":8000,"onlineBookingEnabled":true,"visibility":"PUBLIC"}' \
  "$API/services/$BASE_SERVICE_ID/variants")"
printf '%s\n' "$VARIANT_RES"
VARIANT_ID="$(printf '%s' "$VARIANT_RES" | json_get id)"
[ -n "$VARIANT_ID" ] || fail "VARIANT_ID_EMPTY"

echo "== CREATE TEMP ADDON A ON BASE SERVICE =="
ADDON_A_RES="$(curl -fsS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"proof-norm-addon-a-'"$TMP_SUFFIX"'","durationMin":15,"priceCents":500,"bufferAfterMin":5,"onlineBookingEnabled":true,"visibility":"PUBLIC"}' \
  "$API/services/$BASE_SERVICE_ID/addons")"
printf '%s\n' "$ADDON_A_RES"
ADDON_A_ID="$(printf '%s' "$ADDON_A_RES" | json_get id)"
[ -n "$ADDON_A_ID" ] || fail "ADDON_A_ID_EMPTY"

echo "== CREATE TEMP ADDON B ON BASE SERVICE =="
ADDON_B_RES="$(curl -fsS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"proof-norm-addon-b-'"$TMP_SUFFIX"'","durationMin":10,"priceCents":300,"bufferBeforeMin":5,"onlineBookingEnabled":true,"visibility":"PUBLIC"}' \
  "$API/services/$BASE_SERVICE_ID/addons")"
printf '%s\n' "$ADDON_B_RES"
ADDON_B_ID="$(printf '%s' "$ADDON_B_RES" | json_get id)"
[ -n "$ADDON_B_ID" ] || fail "ADDON_B_ID_EMPTY"

BASE_URL="$API/availability?businessId=$BUSINESS_ID&serviceId=$BASE_SERVICE_ID&staffId=$STAFF_ID&date=$PROOF_DATE&tz=$TZ_NAME&variantId=$VARIANT_ID"

echo "== QUERY 1 repeated params ordered =="
Q1="$(curl -fsS "${BASE_URL}&addonIds=$ADDON_A_ID&addonIds=$ADDON_B_ID")"
printf '%s\n' "$Q1"

echo "== QUERY 2 comma reversed =="
Q2="$(curl -fsS "${BASE_URL}&addonIds=$ADDON_B_ID,$ADDON_A_ID")"
printf '%s\n' "$Q2"

echo "== QUERY 3 duplicates mixed =="
Q3="$(curl -fsS "${BASE_URL}&addonIds=$ADDON_A_ID&addonIds=$ADDON_B_ID&addonIds=$ADDON_A_ID&addonIds=$ADDON_B_ID")"
printf '%s\n' "$Q3"

TOTAL1="$(total_min_of "$Q1")"
TOTAL2="$(total_min_of "$Q2")"
TOTAL3="$(total_min_of "$Q3")"

SIG1="$(printf '%s' "$Q1" | slot_signature)"
SIG2="$(printf '%s' "$Q2" | slot_signature)"
SIG3="$(printf '%s' "$Q3" | slot_signature)"

echo "TOTAL1=$TOTAL1"
echo "TOTAL2=$TOTAL2"
echo "TOTAL3=$TOTAL3"

[ -n "$TOTAL1" ] || fail "TOTAL1_EMPTY"
[ "$TOTAL1" = "$TOTAL2" ] || fail "TOTAL_MISMATCH_Q1_Q2"
[ "$TOTAL1" = "$TOTAL3" ] || fail "TOTAL_MISMATCH_Q1_Q3"

[ -n "$SIG1" ] || fail "SIG1_EMPTY"
[ "$SIG1" = "$SIG2" ] || fail "SLOT_SIGNATURE_MISMATCH_Q1_Q2"
[ "$SIG1" = "$SIG3" ] || fail "SLOT_SIGNATURE_MISMATCH_Q1_Q3"

echo "ADDON_NORMALIZATION_CONSISTENCY_PROOF_OK"

echo
echo "AVAILABILITY_ENTERPRISE_PROOF_PARTIAL_OK"

