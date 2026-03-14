#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../lib/availability_proof_lib.sh"

section "WORKING_HOURS_TIMEOFF_TOTALMIN_PROOF"

PROOF_TZ="Europe/Paris"
TARGET_DATE="2026-04-06"
DAY_OF_WEEK=1

WORKING_BAK="$(mktemp)"
TIMEOFF_ID=""
VARIANT_ID=""
ADDON_A_ID=""
ADDON_B_ID=""

local_to_utc() {
  local ymd="$1"
  local hhmm="$2"
  local tz="$3"
  python3 - "$ymd" "$hhmm" "$tz" <<'PY'
from datetime import datetime
from zoneinfo import ZoneInfo
import sys

ymd, hhmm, tz = sys.argv[1], sys.argv[2], sys.argv[3]
dt = datetime.fromisoformat(f"{ymd}T{hhmm}:00").replace(tzinfo=ZoneInfo(tz))
print(dt.astimezone(ZoneInfo("UTC")).isoformat().replace("+00:00", "Z"))
PY
}

delete_existing_proof_timeoffs() {
  local list ids
  list="$(curl -fsS "$API/staff/$STAFF_ID/time-off?businessId=$BUSINESS_ID" \
    -H "authorization: Bearer $TOKEN")"

  ids="$(
    TIMEOFF_LIST="$list" python3 - <<'PY'
import json, os

raw = os.environ["TIMEOFF_LIST"].strip()
data = json.loads(raw) if raw else []
if isinstance(data, dict):
    data = data.get("items") or []

for item in data:
    reason = (item.get("reason") or "")
    if reason.startswith("proof-wh-timeoff"):
        print(item["id"])
PY
  )"

  if [ -n "${ids:-}" ]; then
    while IFS= read -r id; do
      [ -n "$id" ] || continue
      curl -fsS -X DELETE "$API/staff/$STAFF_ID/time-off/$id?businessId=$BUSINESS_ID" \
        -H "authorization: Bearer $TOKEN" >/dev/null || true
    done <<< "$ids"
  fi
}

delete_existing_proof_variants() {
  local list ids
  list="$(curl -fsS "$API/services/$BASE_SERVICE_ID/variants" \
    -H "authorization: Bearer $TOKEN")"

  ids="$(
    VARIANT_LIST="$list" python3 - <<'PY'
import json, os

raw = os.environ["VARIANT_LIST"].strip()
data = json.loads(raw) if raw else []
if isinstance(data, dict):
    data = data.get("items") or []

for item in data:
    name = (item.get("name") or "")
    if name.startswith("proof-wh-variant-"):
        print(item["id"])
PY
  )"

  if [ -n "${ids:-}" ]; then
    while IFS= read -r id; do
      [ -n "$id" ] || continue
      curl -fsS -X DELETE "$API/services/$BASE_SERVICE_ID/variants/$id" \
        -H "authorization: Bearer $TOKEN" >/dev/null || true
    done <<< "$ids"
  fi
}

delete_existing_proof_addons() {
  local list ids
  list="$(curl -fsS "$API/services/$BASE_SERVICE_ID/addons" \
    -H "authorization: Bearer $TOKEN")"

  ids="$(
    ADDON_LIST="$list" python3 - <<'PY'
import json, os

raw = os.environ["ADDON_LIST"].strip()
data = json.loads(raw) if raw else []
if isinstance(data, dict):
    data = data.get("items") or []

for item in data:
    name = (item.get("name") or "")
    if name.startswith("proof-wh-addon-"):
        print(item["id"])
PY
  )"

  if [ -n "${ids:-}" ]; then
    while IFS= read -r id; do
      [ -n "$id" ] || continue
      curl -fsS -X DELETE "$API/services/$BASE_SERVICE_ID/addons/$id" \
        -H "authorization: Bearer $TOKEN" >/dev/null || true
    done <<< "$ids"
  fi
}

cleanup_proof_state() {
  delete_existing_proof_timeoffs
  delete_existing_proof_addons
  delete_existing_proof_variants
}

cleanup() {
  if [ -n "${TIMEOFF_ID:-}" ]; then
    curl -fsS -X DELETE "$API/staff/$STAFF_ID/time-off/$TIMEOFF_ID?businessId=$BUSINESS_ID" \
      -H "authorization: Bearer $TOKEN" >/dev/null 2>&1 || true
  fi

  if [ -n "${ADDON_A_ID:-}" ]; then
    curl -fsS -X DELETE "$API/services/$BASE_SERVICE_ID/addons/$ADDON_A_ID" \
      -H "authorization: Bearer $TOKEN" >/dev/null 2>&1 || true
  fi

  if [ -n "${ADDON_B_ID:-}" ]; then
    curl -fsS -X DELETE "$API/services/$BASE_SERVICE_ID/addons/$ADDON_B_ID" \
      -H "authorization: Bearer $TOKEN" >/dev/null 2>&1 || true
  fi

  if [ -n "${VARIANT_ID:-}" ]; then
    curl -fsS -X DELETE "$API/services/$BASE_SERVICE_ID/variants/$VARIANT_ID" \
      -H "authorization: Bearer $TOKEN" >/dev/null 2>&1 || true
  fi

  cleanup_proof_state
  restore_working_hours "$WORKING_BAK" "$TOKEN" >/dev/null 2>&1 || true
  rm -f "$WORKING_BAK"
}
trap cleanup EXIT

TOKEN="$(auth_token)"
echo "TOKEN_OK"

cleanup_proof_state
backup_working_hours "$WORKING_BAK" "$TOKEN"
set_single_window_hours "$TOKEN" "$DAY_OF_WEEK" "09:00" "15:00"

echo "== CREATE TEMP VARIANT =="
VARIANT_RES="$(curl -fsS -X POST "$API/services/$BASE_SERVICE_ID/variants" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"name\":\"proof-wh-variant-$(date +%s)\",\"durationMin\":80,\"priceCents\":8000,\"bufferBeforeMin\":0,\"bufferAfterMin\":0,\"visibility\":\"PUBLIC\",\"onlineBookingEnabled\":true}")"
printf '%s\n' "$VARIANT_RES"
VARIANT_ID="$(printf '%s' "$VARIANT_RES" | json_get id)"

echo "== CREATE TEMP ADDON A =="
ADDON_A_RES="$(curl -fsS -X POST "$API/services/$BASE_SERVICE_ID/addons" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"name\":\"proof-wh-addon-a-$(date +%s)\",\"durationMin\":15,\"priceCents\":500,\"bufferBeforeMin\":0,\"bufferAfterMin\":5,\"visibility\":\"PUBLIC\",\"onlineBookingEnabled\":true}")"
printf '%s\n' "$ADDON_A_RES"
ADDON_A_ID="$(printf '%s' "$ADDON_A_RES" | json_get id)"

echo "== CREATE TEMP ADDON B =="
ADDON_B_RES="$(curl -fsS -X POST "$API/services/$BASE_SERVICE_ID/addons" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"name\":\"proof-wh-addon-b-$(date +%s)\",\"durationMin\":10,\"priceCents\":300,\"bufferBeforeMin\":5,\"bufferAfterMin\":0,\"visibility\":\"PUBLIC\",\"onlineBookingEnabled\":true}")"
printf '%s\n' "$ADDON_B_RES"
ADDON_B_ID="$(printf '%s' "$ADDON_B_RES" | json_get id)"

AVAIL_URL="$API/availability?businessId=$BUSINESS_ID&serviceId=$BASE_SERVICE_ID&variantId=$VARIANT_ID&addonIds=$ADDON_A_ID,$ADDON_B_ID&staffId=$STAFF_ID&date=$TARGET_DATE&tz=$PROOF_TZ&intervalMin=15"

echo "== BEFORE TIME OFF =="
BEFORE="$(curl -fsS "$AVAIL_URL")"
printf '%s\n' "$BEFORE"

BEFORE="$BEFORE" python3 - <<'PY'
import json, os
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

data = json.loads(os.environ["BEFORE"])
if data["totalMin"] != 115:
    raise SystemExit(f"TOTAL_MIN_BAD:{data['totalMin']}")

slots = data["results"][0]["slots"]
tz = ZoneInfo("Europe/Paris")
actual = [
    datetime.fromisoformat(s["start"].replace("Z", "+00:00")).astimezone(tz).strftime("%Y-%m-%d %H:%M %z")
    for s in slots
]

expected = []
cur = datetime(2026, 4, 6, 9, 0, tzinfo=tz)
end = datetime(2026, 4, 6, 13, 0, tzinfo=tz)
while cur <= end:
    expected.append(cur.strftime("%Y-%m-%d %H:%M %z"))
    cur += timedelta(minutes=15)

if actual != expected:
    print("EXPECTED=", expected)
    print("ACTUAL=", actual)
    raise SystemExit("BEFORE_SLOTS_BAD")

print("BEFORE_TOTALMIN_AND_SLOTS_OK")
PY

TIMEOFF_START="$(local_to_utc "$TARGET_DATE" "11:00" "$PROOF_TZ")"
TIMEOFF_END="$(local_to_utc "$TARGET_DATE" "12:00" "$PROOF_TZ")"

echo "== CREATE TIME OFF =="
TIMEOFF_RES="$(curl -fsS -X POST "$API/staff/$STAFF_ID/time-off" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS_ID\",\"startAt\":\"$TIMEOFF_START\",\"endAt\":\"$TIMEOFF_END\",\"reason\":\"proof-wh-timeoff-$(date +%s)\"}")"
printf '%s\n' "$TIMEOFF_RES"
TIMEOFF_ID="$(printf '%s' "$TIMEOFF_RES" | json_get id)"

echo "== AFTER TIME OFF =="
AFTER="$(curl -fsS "$AVAIL_URL")"
printf '%s\n' "$AFTER"

AFTER="$AFTER" python3 - <<'PY'
import json, os

data = json.loads(os.environ["AFTER"])
if data["totalMin"] != 115:
    raise SystemExit(f"TOTAL_MIN_AFTER_BAD:{data['totalMin']}")

actual = [slot["start"] for slot in data["results"][0]["slots"]]
expected = [
    "2026-04-06T07:00:00.000Z",
    "2026-04-06T10:00:00.000Z",
    "2026-04-06T10:15:00.000Z",
    "2026-04-06T10:30:00.000Z",
    "2026-04-06T10:45:00.000Z",
    "2026-04-06T11:00:00.000Z",
]

if actual != expected:
    print("EXPECTED=", expected)
    print("ACTUAL=", actual)
    raise SystemExit("AFTER_SLOTS_BAD")

print("AFTER_TIMEOFF_TOTALMIN_AND_SLOTS_OK")
PY

echo "WORKING_HOURS_TIMEOFF_TOTALMIN_PROOF_OK"
