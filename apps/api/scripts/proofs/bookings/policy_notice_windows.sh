#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../lib/availability_proof_lib.sh"

ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
[ -f "$ROOT_DIR/.env.local" ] && set -a && . "$ROOT_DIR/.env.local" && set +a
[ -f "$ROOT_DIR/.env" ] && set -a && . "$ROOT_DIR/.env" && set +a

section "BOOKING_POLICY_NOTICE_WINDOWS_PROOF"

PROOF_TZ="Europe/Paris"
WORKING_BAK="$(mktemp)"
BOOKING_ID=""

OWNER_PROOF_EMAIL="proof-booking-owner@example.com"
CUSTOMER_EMAIL="proof-booking-customer@example.com"

token_for_email() {
  OWNER_EMAIL="$1" auth_token
}

user_id_from_token() {
  local token="$1"
  local ctx
  ctx="$(curl -fsS "$API/auth/context" -H "authorization: Bearer $token")"
  CTX="$ctx" python3 - <<'PY'
import json, os
print(json.loads(os.environ["CTX"])["userId"])
PY
}

seed_owner_membership() {
  local owner_id="$1"
  OWNER_ID="$owner_id" BUSINESS_ID="$BUSINESS_ID" node - <<'NODE'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  await prisma.businessMember.upsert({
    where: {
      businessId_userId: {
        businessId: process.env.BUSINESS_ID,
        userId: process.env.OWNER_ID,
      },
    },
    update: { role: 'OWNER' },
    create: {
      businessId: process.env.BUSINESS_ID,
      userId: process.env.OWNER_ID,
      role: 'OWNER',
    },
  });

  console.log("OWNER_MEMBERSHIP_OK");
})()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
NODE
}

near_future_meta() {
  python3 - <<'PY'
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

tz = ZoneInfo("Europe/Paris")
now = datetime.now(tz)
target = now + timedelta(hours=3)

if target.hour >= 18:
    start = (target + timedelta(days=1)).replace(hour=9, minute=0, second=0, microsecond=0)
else:
    start = target.replace(minute=0, second=0, microsecond=0)
    if start <= now + timedelta(hours=2, minutes=30):
        start += timedelta(hours=1)

end = start + timedelta(hours=4)
dow = start.isoweekday() % 7

print(start.date().isoformat())
print(dow)
print(start.strftime("%H:%M"))
print(end.strftime("%H:%M"))
PY
}

http_must_be_ok() {
  case "${1:-}" in
    200|201) return 0 ;;
    *) echo "HTTP_NOT_OK=$1"; return 1 ;;
  esac
}

cleanup() {
  if [ -n "${BOOKING_ID:-}" ] && [ -n "${OWNER_TOKEN:-}" ]; then
    cancel_booking "$OWNER_TOKEN" "$BOOKING_ID" >/dev/null 2>&1 || true
  fi
  if [ -n "${WORKING_BAK:-}" ] && [ -f "$WORKING_BAK" ] && [ -n "${OWNER_TOKEN:-}" ]; then
    restore_working_hours "$WORKING_BAK" "$OWNER_TOKEN" >/dev/null 2>&1 || true
  fi
  rm -f "$WORKING_BAK"
}
trap cleanup EXIT

OWNER_TOKEN="$(token_for_email "$OWNER_PROOF_EMAIL")"
CUSTOMER_TOKEN="$(token_for_email "$CUSTOMER_EMAIL")"

OWNER_ID="$(user_id_from_token "$OWNER_TOKEN")"
CUSTOMER_ID="$(user_id_from_token "$CUSTOMER_TOKEN")"

echo "OWNER_ID=$OWNER_ID"
echo "CUSTOMER_ID=$CUSTOMER_ID"

seed_owner_membership "$OWNER_ID"

readarray -t META < <(near_future_meta)
TARGET_DATE="${META[0]}"
DAY_OF_WEEK="${META[1]}"
WINDOW_START="${META[2]}"
WINDOW_END="${META[3]}"

echo "TARGET_DATE=$TARGET_DATE"
echo "DAY_OF_WEEK=$DAY_OF_WEEK"
echo "WINDOW_START=$WINDOW_START"
echo "WINDOW_END=$WINDOW_END"

backup_working_hours "$WORKING_BAK" "$OWNER_TOKEN"
set_single_window_hours "$OWNER_TOKEN" "$DAY_OF_WEEK" "$WINDOW_START" "$WINDOW_END"

BASE_URL="$API/availability?businessId=$BUSINESS_ID&serviceId=$BASE_SERVICE_ID&staffId=$STAFF_ID&date=$TARGET_DATE&tz=$PROOF_TZ&intervalMin=30"

echo "## AVAILABILITY BEFORE"
BEFORE="$(curl -fsS "$BASE_URL")"
printf '%s\n' "$BEFORE"

SLOT_COUNT="$(printf '%s' "$BEFORE" | slot_count_json)"
[ "$SLOT_COUNT" -ge 3 ] || fail "NOTICE_WINDOW_SLOT_COUNT_LT_3"

CREATE_START="$(printf '%s' "$BEFORE" | slot_start_at 0)"
RESCHED_START="$(printf '%s' "$BEFORE" | slot_start_at 2)"

RESCHED_LOCAL="$(python3 - "$RESCHED_START" "$PROOF_TZ" <<'PY'
from datetime import datetime
from zoneinfo import ZoneInfo
import sys
dt = datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00")).astimezone(ZoneInfo(sys.argv[2]))
print(dt.strftime("%Y-%m-%dT%H:%M"))
PY
)"

echo "CREATE_START=$CREATE_START"
echo "RESCHED_START=$RESCHED_START"
echo "RESCHED_LOCAL=$RESCHED_LOCAL"

echo
echo "## CUSTOMER CREATE"
CREATE_OUT="$(curl -sS -X POST "$API/bookings" \
  -H "authorization: Bearer $CUSTOMER_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS_ID\",\"staffId\":\"$STAFF_ID\",\"serviceId\":\"$BASE_SERVICE_ID\",\"startAt\":\"$CREATE_START\",\"tz\":\"$PROOF_TZ\"}" \
  -w $'\nHTTP=%{http_code}')"
printf '%s\n' "$CREATE_OUT"

CREATE_HTTP="$(printf '%s' "$CREATE_OUT" | tail -n1 | sed 's/^HTTP=//')"
http_must_be_ok "$CREATE_HTTP" || fail "CUSTOMER_CREATE_NOT_OK"

BOOKING_ID="$(printf '%s' "$CREATE_OUT" | sed '$d' | json_get id)"
[ -n "$BOOKING_ID" ] || fail "NOTICE_WINDOW_BOOKING_ID_MISSING"

echo
echo "## CUSTOMER RESCHEDULE MUST FAIL BY WINDOW"
RES_OUT="$(mktemp)"
RES_HTTP="$(curl -sS -o "$RES_OUT" -w '%{http_code}' -X POST "$API/bookings/$BOOKING_ID/reschedule" \
  -H "authorization: Bearer $CUSTOMER_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS_ID\",\"newStartLocal\":\"$RESCHED_LOCAL\",\"tz\":\"$PROOF_TZ\"}")"
cat "$RES_OUT"
echo
[ "$RES_HTTP" = "400" ] || fail "CUSTOMER_RESCHEDULE_WINDOW_NOT_400"
grep -q "Reschedule window has passed" "$RES_OUT" || fail "CUSTOMER_RESCHEDULE_WINDOW_MESSAGE_BAD"

echo
echo "## CUSTOMER CANCEL MUST FAIL BY WINDOW"
CAN_OUT="$(mktemp)"
CAN_HTTP="$(curl -sS -o "$CAN_OUT" -w '%{http_code}' -X POST "$API/bookings/$BOOKING_ID/cancel" \
  -H "authorization: Bearer $CUSTOMER_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS_ID\"}")"
cat "$CAN_OUT"
echo
[ "$CAN_HTTP" = "400" ] || fail "CUSTOMER_CANCEL_WINDOW_NOT_400"
grep -q "Cancellation window has passed" "$CAN_OUT" || fail "CUSTOMER_CANCEL_WINDOW_MESSAGE_BAD"

echo
echo "## OWNER RESCHEDULE MUST BYPASS WINDOW"
OWN_RES_OUT="$(mktemp)"
OWN_RES_HTTP="$(curl -sS -o "$OWN_RES_OUT" -w '%{http_code}' -X POST "$API/bookings/$BOOKING_ID/reschedule" \
  -H "authorization: Bearer $OWNER_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS_ID\",\"newStartLocal\":\"$RESCHED_LOCAL\",\"tz\":\"$PROOF_TZ\"}")"
cat "$OWN_RES_OUT"
echo
[ "$OWN_RES_HTTP" = "201" ] || fail "OWNER_RESCHEDULE_BYPASS_NOT_201"

echo
echo "## OWNER CANCEL MUST BYPASS WINDOW"
OWN_CAN_OUT="$(mktemp)"
OWN_CAN_HTTP="$(curl -sS -o "$OWN_CAN_OUT" -w '%{http_code}' -X POST "$API/bookings/$BOOKING_ID/cancel" \
  -H "authorization: Bearer $OWNER_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS_ID\"}")"
cat "$OWN_CAN_OUT"
echo
http_must_be_ok "$OWN_CAN_HTTP" || fail "OWNER_CANCEL_BYPASS_NOT_OK"

BOOKING_ID=""

echo "BOOKING_POLICY_NOTICE_WINDOWS_PROOF_OK"
