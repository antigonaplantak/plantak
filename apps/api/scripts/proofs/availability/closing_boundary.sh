#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../lib/availability_proof_lib.sh"

section "CLOSING_BOUNDARY_PROOF"

TOKEN="$(auth_token)"
echo "TOKEN_OK"

DATE_VALUE="2026-03-30"
BAK="$(mktemp)"

backup_working_hours "$BAK" "$TOKEN"
cleanup() {
  restore_working_hours "$BAK" "$TOKEN" >/dev/null 2>&1 || true
  rm -f "$BAK"
}
trap cleanup EXIT

# Monday 09:00-11:00, service totalMin=50, interval=30
# valid starts: 09:00, 09:30, 10:00
# invalid: 10:30 because 10:30+50 > 11:00
curl -fsS -X PUT "$API/staff/$STAFF_ID/working-hours" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS_ID\",\"items\":[{\"dayOfWeek\":1,\"startMin\":540,\"endMin\":660}]}" >/dev/null

BODY="$(curl -fsS "$API/availability?businessId=$BUSINESS_ID&serviceId=$BASE_SERVICE_ID&staffId=$STAFF_ID&date=$DATE_VALUE&tz=Europe/Paris&intervalMin=30")"
printf '%s\n' "$BODY"

BODY="$BODY" python3 - <<'PY'
import json, os
from datetime import datetime
from zoneinfo import ZoneInfo

data = json.loads(os.environ["BODY"])
slots = ((data.get("results") or [{}])[0].get("slots") or [])
tz = ZoneInfo("Europe/Paris")

actual = [
    datetime.fromisoformat(s["start"].replace("Z", "+00:00")).astimezone(tz).strftime("%Y-%m-%d %H:%M %z")
    for s in slots
]

expected = [
    "2026-03-30 09:00 +0200",
    "2026-03-30 09:30 +0200",
    "2026-03-30 10:00 +0200",
]

print("ACTUAL=", actual)
if actual != expected:
    raise SystemExit("CLOSING_BOUNDARY_NOT_GREEN")

print("CLOSING_BOUNDARY_PROOF_OK")
PY
