#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../lib/availability_proof_lib.sh"

ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
[ -f "$ROOT_DIR/.env.local" ] && set -a && . "$ROOT_DIR/.env.local" && set +a
[ -f "$ROOT_DIR/.env" ] && set -a && . "$ROOT_DIR/.env" && set +a

section "BOOKING_POLICY_HISTORY_HTTP_CONTRACT_PROOF"

PROOF_TZ="Europe/Paris"
TARGET_DATE="2026-04-06"
DAY_OF_WEEK=1

WORKING_BAK="$(mktemp)"
BOOKING_ID=""

OWNER_EMAIL="proof-booking-owner@example.com"
CUSTOMER_EMAIL="proof-booking-customer@example.com"
OTHER_EMAIL="proof-booking-other@example.com"

http_must_be_ok() {
  case "${1:-}" in
    200|201) return 0 ;;
    *) echo "HTTP_NOT_OK=$1"; return 1 ;;
  esac
}

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

assert_history_payload() {
  local payload="$1"
  HISTORY_JSON="$payload" python3 - <<'PY'
import json, os

data = json.loads(os.environ["HISTORY_JSON"])
items = data["items"]

actions = [row["action"] for row in items]
expected = ["CREATE", "RESCHEDULE", "CONFIRM", "CANCEL"]

if actions != expected:
    print("EXPECTED=", expected)
    print("ACTUAL=", actions)
    raise SystemExit("BOOKING_HISTORY_HTTP_ACTIONS_BAD")

if len(items) != 4:
    print(json.dumps(items, indent=2, default=str))
    raise SystemExit("BOOKING_HISTORY_HTTP_COUNT_BAD")

print("BOOKING_HISTORY_HTTP_ASSERT_OK")
PY
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

OWNER_TOKEN="$(token_for_email "$OWNER_EMAIL")"
CUSTOMER_TOKEN="$(token_for_email "$CUSTOMER_EMAIL")"
OTHER_TOKEN="$(token_for_email "$OTHER_EMAIL")"

OWNER_ID="$(user_id_from_token "$OWNER_TOKEN")"
CUSTOMER_ID="$(user_id_from_token "$CUSTOMER_TOKEN")"
OTHER_ID="$(user_id_from_token "$OTHER_TOKEN")"

echo "OWNER_ID=$OWNER_ID"
echo "CUSTOMER_ID=$CUSTOMER_ID"
echo "OTHER_ID=$OTHER_ID"

seed_owner_membership "$OWNER_ID"

backup_working_hours "$WORKING_BAK" "$OWNER_TOKEN"
set_single_window_hours "$OWNER_TOKEN" "$DAY_OF_WEEK" "09:00" "12:00"

BASE_URL="$API/availability?businessId=$BUSINESS_ID&serviceId=$BASE_SERVICE_ID&staffId=$STAFF_ID&date=$TARGET_DATE&tz=$PROOF_TZ&intervalMin=30"

echo "## AVAILABILITY BEFORE"
BEFORE="$(curl -fsS "$BASE_URL")"
printf '%s\n' "$BEFORE"

SLOT_COUNT="$(printf '%s' "$BEFORE" | slot_count_json)"
[ "$SLOT_COUNT" -ge 3 ] || fail "BOOKING_HISTORY_HTTP_SLOT_COUNT_LT_3"

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
[ -n "$BOOKING_ID" ] || fail "BOOKING_ID_MISSING"

echo
echo "## OWNER RESCHEDULE"
curl -fsS -X POST "$API/bookings/$BOOKING_ID/reschedule" \
  -H "authorization: Bearer $OWNER_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS_ID\",\"newStartLocal\":\"$RESCHED_LOCAL\",\"tz\":\"$PROOF_TZ\"}" >/dev/null

echo
echo "## OWNER CONFIRM"
curl -fsS -X POST "$API/bookings/$BOOKING_ID/confirm" \
  -H "authorization: Bearer $OWNER_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS_ID\"}" >/dev/null

echo
echo "## OWNER CANCEL"
curl -fsS -X POST "$API/bookings/$BOOKING_ID/cancel" \
  -H "authorization: Bearer $OWNER_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS_ID\"}" >/dev/null

echo
echo "## OWNER HISTORY GET"
OWNER_HISTORY="$(curl -sS -w $'\nHTTP=%{http_code}' \
  "$API/bookings/$BOOKING_ID/history?businessId=$BUSINESS_ID&order=asc&limit=20" \
  -H "authorization: Bearer $OWNER_TOKEN")"
printf '%s\n' "$OWNER_HISTORY"
OWNER_HTTP="$(printf '%s' "$OWNER_HISTORY" | tail -n1 | sed 's/^HTTP=//')"
http_must_be_ok "$OWNER_HTTP" || fail "OWNER_HISTORY_HTTP_BAD"
assert_history_payload "$(printf '%s' "$OWNER_HISTORY" | sed '$d')"

echo
echo "## CUSTOMER HISTORY GET"
CUSTOMER_HISTORY="$(curl -sS -w $'\nHTTP=%{http_code}' \
  "$API/bookings/$BOOKING_ID/history?businessId=$BUSINESS_ID&order=asc&limit=20" \
  -H "authorization: Bearer $CUSTOMER_TOKEN")"
printf '%s\n' "$CUSTOMER_HISTORY"
CUSTOMER_HTTP="$(printf '%s' "$CUSTOMER_HISTORY" | tail -n1 | sed 's/^HTTP=//')"
http_must_be_ok "$CUSTOMER_HTTP" || fail "CUSTOMER_HISTORY_HTTP_BAD"
assert_history_payload "$(printf '%s' "$CUSTOMER_HISTORY" | sed '$d')"

echo
echo "## OTHER CUSTOMER HISTORY MUST FAIL"
OTHER_HISTORY="$(curl -sS -w $'\nHTTP=%{http_code}' \
  "$API/bookings/$BOOKING_ID/history?businessId=$BUSINESS_ID&order=asc&limit=20" \
  -H "authorization: Bearer $OTHER_TOKEN")"
printf '%s\n' "$OTHER_HISTORY"
OTHER_HTTP="$(printf '%s' "$OTHER_HISTORY" | tail -n1 | sed 's/^HTTP=//')"
[ "$OTHER_HTTP" = "403" ] || fail "OTHER_HISTORY_NOT_403"

echo "BOOKING_POLICY_HISTORY_HTTP_CONTRACT_PROOF_OK"
