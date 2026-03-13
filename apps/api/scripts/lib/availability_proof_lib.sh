#!/usr/bin/env bash
set -euo pipefail

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$LIB_DIR/../.." && pwd)"

source "$LIB_DIR/proof_http.sh"
[ -f "$PROJECT_DIR/.env.local" ] && . "$PROJECT_DIR/.env.local"

API="${API_URL:-http://localhost:3101/api}"
BUSINESS_ID="${BUSINESS_ID:-b1}"
STAFF_ID="${STAFF_ID:-b9b77322-1012-4860-af1b-5b53a6171d06}"
BASE_SERVICE_ID="${BASE_SERVICE_ID:-f37eca6e-8729-4a73-a498-028436514c1b}"
CUSTOMER_ID="${CUSTOMER_ID:-d50451d5-6431-4069-abbc-dadd904bb806}"
OWNER_EMAIL="${OWNER_EMAIL:-owner@example.com}"
TZ_NAME="${TZ_NAME:-Europe/Paris}"

fail() {
  echo "$1"
  exit 1
}

section() {
  echo
  echo "== $1 =="
}

json_get() {
  local path="$1"
  python3 -c '
import json, sys
data = json.load(sys.stdin)
value = data
for part in sys.argv[1].split("."):
    if isinstance(value, list) and part.isdigit():
        value = value[int(part)]
    else:
        value = value[part]
if isinstance(value, (dict, list)):
    print(json.dumps(value, separators=(",", ":")))
elif value is None:
    print("null")
else:
    print(value)
' "$path"
}

slot_count_json() {
  python3 -c '
import json, sys
data = json.load(sys.stdin)
results = data.get("results") or []
slots = results[0].get("slots") if results else []
print(len(slots or []))
'
}

slot_start_at() {
  local idx="$1"
  python3 -c '
import json, sys
idx = int(sys.argv[1])
data = json.load(sys.stdin)
print(data["results"][0]["slots"][idx]["start"])
' "$idx"
}

hhmm_to_min() {
  local value="$1"
  python3 - "$value" <<'PY'
import sys
hh, mm = sys.argv[1].split(":")
print(int(hh) * 60 + int(mm))
PY
}

auth_token() {
  local req_out verify_out req_http verify_http code token

  req_out="$(mktemp)"
  verify_out="$(mktemp)"

  req_http="$(curl -sS -o "$req_out" -w '%{http_code}' -X POST "$API/auth/magic/request" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$OWNER_EMAIL\"}")"

  echo "AUTH_REQUEST_HTTP=$req_http" >&2
  cat "$req_out" >&2 || true
  echo >&2

  [ "$req_http" -ge 200 ] && [ "$req_http" -lt 300 ] || fail "AUTH_REQUEST_FAILED"

  code="$(python3 - "$req_out" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], "r", encoding="utf-8"))
code = data.get("devCode")
if not code:
    raise SystemExit("DEV_CODE_MISSING")
print(code)
PY
)" || fail "TOKEN_CODE_NOT_FOUND"

  echo "MAGIC_CODE=$code" >&2

  verify_http="$(curl -sS -o "$verify_out" -w '%{http_code}' -X POST "$API/auth/magic/verify" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$OWNER_EMAIL\",\"code\":\"$code\"}")"

  echo "AUTH_VERIFY_HTTP=$verify_http" >&2
  cat "$verify_out" >&2 || true
  echo >&2

  [ "$verify_http" -ge 200 ] && [ "$verify_http" -lt 300 ] || fail "AUTH_VERIFY_FAILED"

  token="$(python3 - "$verify_out" <<'PY'
import json, sys
raw = open(sys.argv[1], "r", encoding="utf-8").read().strip()
if not raw:
    raise SystemExit("EMPTY_VERIFY_BODY")
data = json.loads(raw)
token = data.get("accessToken")
if not token:
    raise SystemExit("ACCESS_TOKEN_MISSING")
print(token)
PY
)" || fail "ACCESS_TOKEN_PARSE_FAILED"

  printf '%s' "$token"
}

backup_working_hours() {
  local out_file="$1"
  local token="$2"
  curl -fsS "$API/staff/$STAFF_ID/working-hours?businessId=$BUSINESS_ID" \
    -H "authorization: Bearer $token" > "$out_file"
}

restore_working_hours() {
  local backup_file="$1"
  local token="$2"
  local payload_file
  payload_file="$(mktemp)"

  python3 - "$backup_file" "$BUSINESS_ID" > "$payload_file" <<'PY'
import json, sys

data = json.load(open(sys.argv[1], "r", encoding="utf-8"))
business_id = sys.argv[2]

items = data.get("items") if isinstance(data, dict) else data
items = items or []

clean = []
for item in items:
    clean.append({
        "dayOfWeek": item["dayOfWeek"],
        "startMin": item["startMin"],
        "endMin": item["endMin"],
    })

print(json.dumps({
    "businessId": business_id,
    "items": clean,
}, separators=(",", ":")))
PY

  curl -fsS -X PUT "$API/staff/$STAFF_ID/working-hours" \
    -H "authorization: Bearer $token" \
    -H 'content-type: application/json' \
    --data-binary @"$payload_file" >/dev/null

  rm -f "$payload_file"
}

set_single_window_hours() {
  local token="$1"
  local day_of_week="$2"
  local start_hhmm="$3"
  local end_hhmm="$4"
  local start_min end_min

  start_min="$(hhmm_to_min "$start_hhmm")"
  end_min="$(hhmm_to_min "$end_hhmm")"

  curl -fsS -X PUT "$API/staff/$STAFF_ID/working-hours" \
    -H "authorization: Bearer $token" \
    -H 'content-type: application/json' \
    -d "{\"businessId\":\"$BUSINESS_ID\",\"items\":[{\"dayOfWeek\":$day_of_week,\"startMin\":$start_min,\"endMin\":$end_min}]}" >/dev/null
}

utc_to_local_with_offset() {
  local utc_value="$1"
  local tz_name="$2"

  python3 - "$utc_value" "$tz_name" <<'PY'
from datetime import datetime
from zoneinfo import ZoneInfo
import sys

dt = datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00"))
print(dt.astimezone(ZoneInfo(sys.argv[2])).strftime("%Y-%m-%dT%H:%M%z"))
PY
}

assert_local_slots() {
  local expected_json="$1"
  local tz_name="$2"

  python3 -c '
import json, sys
from datetime import datetime
from zoneinfo import ZoneInfo

expected = json.loads(sys.argv[1])
tz = ZoneInfo(sys.argv[2])
data = json.load(sys.stdin)

slots = data["results"][0]["slots"]
actual = [
    datetime.fromisoformat(slot["start"].replace("Z", "+00:00")).astimezone(tz).strftime("%Y-%m-%dT%H:%M%z")
    for slot in slots
]

if actual != expected:
    print("EXPECTED=", json.dumps(expected))
    print("ACTUAL=", json.dumps(actual))
    raise SystemExit(1)

for row in actual:
    print(row)
' "$expected_json" "$tz_name"
}

create_booking() {
  local token="$1"
  local service_id="$2"
  local start_at="$3"

  local body
  body="$(printf '{"businessId":"%s","staffId":"%s","serviceId":"%s","customerId":"%s","startAt":"%s","tz":"%s"}' \
    "$BUSINESS_ID" "$STAFF_ID" "$service_id" "$CUSTOMER_ID" "$start_at" "$TZ_NAME")"

  curl -sS -X POST "$API/bookings" \
    -H "authorization: Bearer $token" \
    -H 'content-type: application/json' \
    -d "$body" -w $'\nHTTP=%{http_code}'
}

cancel_booking() {
  local token="$1"
  local booking_id="$2"
  local out status

  out="$(mktemp)"
  status="$(curl -sS -o "$out" -w '%{http_code}' -X POST "$API/bookings/$booking_id/cancel" \
    -H "authorization: Bearer $token" \
    -H 'content-type: application/json' \
    -d "{\"businessId\":\"$BUSINESS_ID\"}")"

  cat "$out" >&2 || true
  echo >&2
  rm -f "$out"

  case "$status" in
    200|201|204) ;;
    *) fail "CANCEL_BOOKING_FAILED_HTTP_$status" ;;
  esac
}
