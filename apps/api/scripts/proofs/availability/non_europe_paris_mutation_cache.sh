#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../lib/availability_proof_lib.sh"

section "NON_EUROPE_PARIS_MUTATION_CACHE_PROOF"

PROOF_TZ="America/New_York"
TARGET_DATE="2026-04-06"
DAY_OF_WEEK=1
WORKING_BAK="$(mktemp)"
BOOKING_ID=""

TOKEN="$(auth_token)"
echo "TOKEN_OK"

cleanup() {
  if [ -n "${BOOKING_ID:-}" ]; then
    cancel_booking "$TOKEN" "$BOOKING_ID" >/dev/null 2>&1 || true
  fi
  restore_working_hours "$WORKING_BAK" "$TOKEN" >/dev/null 2>&1 || true
  rm -f "$WORKING_BAK"
}
trap cleanup EXIT

backup_working_hours "$WORKING_BAK" "$TOKEN"
set_single_window_hours "$TOKEN" "$DAY_OF_WEEK" "09:00" "12:00"

BASE_URL="$API/availability?businessId=$BUSINESS_ID&serviceId=$BASE_SERVICE_ID&staffId=$STAFF_ID&date=$TARGET_DATE&tz=$PROOF_TZ&intervalMin=30"

echo "## BEFORE"
BEFORE="$(curl -fsS "$BASE_URL")"
printf '%s\n' "$BEFORE"

SLOT_COUNT="$(printf '%s' "$BEFORE" | slot_count_json)"
[ "$SLOT_COUNT" -ge 3 ] || fail "NON_EUROPE_PARIS_SLOT_COUNT_LT_3"

CREATE_START="$(printf '%s' "$BEFORE" | slot_start_at 0)"
RESCHED_START="$(printf '%s' "$BEFORE" | slot_start_at 2)"

echo "CREATE_START=$CREATE_START"
echo "RESCHED_START=$RESCHED_START"

echo
echo "## CREATE"
CREATE_OUT="$(create_booking "$TOKEN" "$BASE_SERVICE_ID" "$CREATE_START")"
printf '%s\n' "$CREATE_OUT"

CREATE_HTTP="$(printf '%s' "$CREATE_OUT" | tail -n1 | sed 's/^HTTP=//')"
[ "$CREATE_HTTP" = "201" ] || fail "NON_EUROPE_PARIS_CREATE_NOT_201"

BOOKING_ID="$(printf '%s' "$CREATE_OUT" | sed '$d' | json_get id)"
[ -n "$BOOKING_ID" ] || fail "NON_EUROPE_PARIS_BOOKING_ID_MISSING"

echo
echo "## AFTER CREATE"
AFTER_CREATE="$(curl -fsS "$BASE_URL")"
printf '%s\n' "$AFTER_CREATE"

AFTER_CREATE="$AFTER_CREATE" python3 - "$CREATE_START" <<'PY'
import json, os, sys
target = sys.argv[1]
data = json.loads(os.environ["AFTER_CREATE"])
slots = ((data.get("results") or [{}])[0].get("slots") or [])
starts = [slot["start"] for slot in slots]
if target in starts:
    raise SystemExit("CREATE_SLOT_STILL_PRESENT")
print("CREATE_SLOT_REMOVED_OK")
PY

RESCHED_LOCAL="$(python3 - "$RESCHED_START" "$PROOF_TZ" <<'PY'
from datetime import datetime
from zoneinfo import ZoneInfo
import sys
dt = datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00")).astimezone(ZoneInfo(sys.argv[2]))
print(dt.strftime("%Y-%m-%dT%H:%M"))
PY
)"

echo "RESCHED_LOCAL=$RESCHED_LOCAL"

echo
echo "## RESCHEDULE"
RESCHED_OUT="$(mktemp)"
RESCHED_HTTP="$(curl -sS -o "$RESCHED_OUT" -w '%{http_code}' -X POST "$API/bookings/$BOOKING_ID/reschedule" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS_ID\",\"newStartLocal\":\"$RESCHED_LOCAL\",\"tz\":\"$PROOF_TZ\"}")"
cat "$RESCHED_OUT"
echo
[ "$RESCHED_HTTP" = "201" ] || fail "NON_EUROPE_PARIS_RESCHEDULE_NOT_201"

echo
echo "## AFTER RESCHEDULE"
AFTER_RESCHEDULE="$(curl -fsS "$BASE_URL")"
printf '%s\n' "$AFTER_RESCHEDULE"

AFTER_RESCHEDULE="$AFTER_RESCHEDULE" python3 - "$CREATE_START" "$RESCHED_START" <<'PY'
import json, os, sys
create_start = sys.argv[1]
resched_start = sys.argv[2]
data = json.loads(os.environ["AFTER_RESCHEDULE"])
slots = ((data.get("results") or [{}])[0].get("slots") or [])
starts = [slot["start"] for slot in slots]
if create_start not in starts:
    raise SystemExit("ORIGINAL_SLOT_NOT_RESTORED")
if resched_start in starts:
    raise SystemExit("RESCHEDULED_SLOT_STILL_PRESENT")
print("RESCHEDULE_CACHE_REFRESH_OK")
PY

echo
echo "## CANCEL"
cancel_booking "$TOKEN" "$BOOKING_ID" >/dev/null
BOOKING_ID=""

echo
echo "## AFTER CANCEL"
AFTER_CANCEL="$(curl -fsS "$BASE_URL")"
printf '%s\n' "$AFTER_CANCEL"

AFTER_CANCEL="$AFTER_CANCEL" python3 - "$CREATE_START" "$RESCHED_START" <<'PY'
import json, os, sys
create_start = sys.argv[1]
resched_start = sys.argv[2]
data = json.loads(os.environ["AFTER_CANCEL"])
slots = ((data.get("results") or [{}])[0].get("slots") or [])
starts = [slot["start"] for slot in slots]
if create_start not in starts:
    raise SystemExit("CREATE_SLOT_NOT_RESTORED_AFTER_CANCEL")
if resched_start not in starts:
    raise SystemExit("RESCHEDULE_SLOT_NOT_RESTORED_AFTER_CANCEL")
print("CANCEL_CACHE_REFRESH_OK")
PY

echo "NON_EUROPE_PARIS_MUTATION_CACHE_PROOF_OK"
