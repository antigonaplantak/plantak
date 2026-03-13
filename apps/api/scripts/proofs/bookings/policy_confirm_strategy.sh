#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../lib/availability_proof_lib.sh"

ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
[ -f "$ROOT_DIR/.env.local" ] && set -a && . "$ROOT_DIR/.env.local" && set +a
[ -f "$ROOT_DIR/.env" ] && set -a && . "$ROOT_DIR/.env" && set +a

section "BOOKING_POLICY_CONFIRM_STRATEGY_PROOF"

TARGET_DATE="2026-04-06"
DAY_OF_WEEK=1
PROOF_TZ="Europe/Paris"

WORKING_BAK="$(mktemp)"
BOOKING_ID=""
BOOKING_CANCELLED_ID=""

OWNER_EMAIL="proof-booking-owner@example.com"
CUSTOMER_EMAIL="proof-booking-customer@example.com"

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

assert_confirm_history_once() {
  local booking_id="$1"

  HISTORY_JSON="$(
    BOOKING_ID="$booking_id" node - <<'NODE'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const rows = await prisma.bookingHistory.findMany({
    where: { bookingId: process.env.BOOKING_ID, action: 'CONFIRM' },
    orderBy: { createdAt: 'asc' },
    select: { action: true, actorRole: true, status: true },
  });

  console.log(JSON.stringify(rows));
})()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
NODE
  )"

  HISTORY_JSON="$HISTORY_JSON" python3 - <<'PY'
import json, os

rows = json.loads(os.environ["HISTORY_JSON"])
if len(rows) != 1:
    print(json.dumps(rows, indent=2))
    raise SystemExit("CONFIRM_HISTORY_COUNT_BAD")

row = rows[0]
if row["actorRole"] != "OWNER":
    raise SystemExit("CONFIRM_HISTORY_ACTOR_ROLE_BAD")
if row["status"] != "CONFIRMED":
    raise SystemExit("CONFIRM_HISTORY_STATUS_BAD")

print("CONFIRM_HISTORY_ASSERT_OK")
PY
}

cleanup() {
  [ -n "${BOOKING_ID:-}" ] && [ -n "${OWNER_TOKEN:-}" ] && cancel_booking "$OWNER_TOKEN" "$BOOKING_ID" >/dev/null 2>&1 || true
  [ -n "${BOOKING_CANCELLED_ID:-}" ] && [ -n "${OWNER_TOKEN:-}" ] && cancel_booking "$OWNER_TOKEN" "$BOOKING_CANCELLED_ID" >/dev/null 2>&1 || true
  [ -f "$WORKING_BAK" ] && [ -n "${OWNER_TOKEN:-}" ] && restore_working_hours "$WORKING_BAK" "$OWNER_TOKEN" >/dev/null 2>&1 || true
  rm -f "$WORKING_BAK"
}
trap cleanup EXIT

OWNER_TOKEN="$(token_for_email "$OWNER_EMAIL")"
CUSTOMER_TOKEN="$(token_for_email "$CUSTOMER_EMAIL")"

OWNER_ID="$(user_id_from_token "$OWNER_TOKEN")"
CUSTOMER_ID="$(user_id_from_token "$CUSTOMER_TOKEN")"

echo "OWNER_ID=$OWNER_ID"
echo "CUSTOMER_ID=$CUSTOMER_ID"

seed_owner_membership "$OWNER_ID"

backup_working_hours "$WORKING_BAK" "$OWNER_TOKEN"
set_single_window_hours "$OWNER_TOKEN" "$DAY_OF_WEEK" "09:00" "12:00"

BASE_URL="$API/availability?businessId=$BUSINESS_ID&serviceId=$BASE_SERVICE_ID&staffId=$STAFF_ID&date=$TARGET_DATE&tz=$PROOF_TZ&intervalMin=30"

echo "## AVAILABILITY BEFORE"
BEFORE="$(curl -fsS "$BASE_URL")"
printf '%s\n' "$BEFORE"

SLOT_COUNT="$(printf '%s' "$BEFORE" | slot_count_json)"
[ "$SLOT_COUNT" -ge 3 ] || fail "CONFIRM_STRATEGY_SLOT_COUNT_LT_3"

CREATE_START="$(printf '%s' "$BEFORE" | slot_start_at 0)"
SECOND_START="$(printf '%s' "$BEFORE" | slot_start_at 2)"

echo "CREATE_START=$CREATE_START"
echo "SECOND_START=$SECOND_START"

echo
echo "## CUSTOMER CREATE PRIMARY BOOKING"
CREATE_OUT="$(curl -sS -X POST "$API/bookings" \
  -H "authorization: Bearer $CUSTOMER_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS_ID\",\"staffId\":\"$STAFF_ID\",\"serviceId\":\"$BASE_SERVICE_ID\",\"startAt\":\"$CREATE_START\",\"tz\":\"$PROOF_TZ\"}" \
  -w $'\nHTTP=%{http_code}')"
printf '%s\n' "$CREATE_OUT"

CREATE_HTTP="$(printf '%s' "$CREATE_OUT" | tail -n1 | sed 's/^HTTP=//')"
http_must_be_ok "$CREATE_HTTP" || fail "PRIMARY_CREATE_NOT_OK"

BOOKING_ID="$(printf '%s' "$CREATE_OUT" | sed '$d' | json_get id)"
[ -n "$BOOKING_ID" ] || fail "PRIMARY_BOOKING_ID_MISSING"

echo
echo "## CUSTOMER CONFIRM MUST FAIL"
CUSTOMER_CONFIRM_OUT="$(curl -sS -X POST "$API/bookings/$BOOKING_ID/confirm" \
  -H "authorization: Bearer $CUSTOMER_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS_ID\"}" \
  -w $'\nHTTP=%{http_code}')"
printf '%s\n' "$CUSTOMER_CONFIRM_OUT"

CUSTOMER_CONFIRM_HTTP="$(printf '%s' "$CUSTOMER_CONFIRM_OUT" | tail -n1 | sed 's/^HTTP=//')"
[ "$CUSTOMER_CONFIRM_HTTP" = "403" ] || fail "CUSTOMER_CONFIRM_NOT_403"

echo
echo "## OWNER CONFIRM MUST PASS"
CONFIRM_KEY="proof-confirm-$BOOKING_ID"
OWNER_CONFIRM_1="$(curl -sS -X POST "$API/bookings/$BOOKING_ID/confirm" \
  -H "authorization: Bearer $OWNER_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS_ID\",\"idempotencyKey\":\"$CONFIRM_KEY\"}" \
  -w $'\nHTTP=%{http_code}')"
printf '%s\n' "$OWNER_CONFIRM_1"

OWNER_CONFIRM_1_HTTP="$(printf '%s' "$OWNER_CONFIRM_1" | tail -n1 | sed 's/^HTTP=//')"
http_must_be_ok "$OWNER_CONFIRM_1_HTTP" || fail "OWNER_CONFIRM_FIRST_NOT_OK"

echo
echo "## OWNER CONFIRM SAME KEY MUST BE STABLE"
OWNER_CONFIRM_2="$(curl -sS -X POST "$API/bookings/$BOOKING_ID/confirm" \
  -H "authorization: Bearer $OWNER_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS_ID\",\"idempotencyKey\":\"$CONFIRM_KEY\"}" \
  -w $'\nHTTP=%{http_code}')"
printf '%s\n' "$OWNER_CONFIRM_2"

OWNER_CONFIRM_2_HTTP="$(printf '%s' "$OWNER_CONFIRM_2" | tail -n1 | sed 's/^HTTP=//')"
http_must_be_ok "$OWNER_CONFIRM_2_HTTP" || fail "OWNER_CONFIRM_SECOND_NOT_OK"

STATUS1="$(printf '%s' "$OWNER_CONFIRM_1" | sed '$d' | json_get status)"
STATUS2="$(printf '%s' "$OWNER_CONFIRM_2" | sed '$d' | json_get status)"
[ "$STATUS1" = "CONFIRMED" ] || fail "OWNER_CONFIRM_FIRST_STATUS_BAD"
[ "$STATUS2" = "CONFIRMED" ] || fail "OWNER_CONFIRM_SECOND_STATUS_BAD"

assert_confirm_history_once "$BOOKING_ID"

echo
echo "## CUSTOMER CREATE SECOND BOOKING"
CREATE_CANCEL_OUT="$(curl -sS -X POST "$API/bookings" \
  -H "authorization: Bearer $CUSTOMER_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS_ID\",\"staffId\":\"$STAFF_ID\",\"serviceId\":\"$BASE_SERVICE_ID\",\"startAt\":\"$SECOND_START\",\"tz\":\"$PROOF_TZ\"}" \
  -w $'\nHTTP=%{http_code}')"
printf '%s\n' "$CREATE_CANCEL_OUT"

CREATE_CANCEL_HTTP="$(printf '%s' "$CREATE_CANCEL_OUT" | tail -n1 | sed 's/^HTTP=//')"
http_must_be_ok "$CREATE_CANCEL_HTTP" || fail "SECOND_CREATE_NOT_OK"

BOOKING_CANCELLED_ID="$(printf '%s' "$CREATE_CANCEL_OUT" | sed '$d' | json_get id)"
[ -n "$BOOKING_CANCELLED_ID" ] || fail "SECOND_BOOKING_ID_MISSING"

echo
echo "## OWNER CANCEL SECOND BOOKING"
OWNER_CANCEL_OUT="$(curl -sS -X POST "$API/bookings/$BOOKING_CANCELLED_ID/cancel" \
  -H "authorization: Bearer $OWNER_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS_ID\"}" \
  -w $'\nHTTP=%{http_code}')"
printf '%s\n' "$OWNER_CANCEL_OUT"

OWNER_CANCEL_HTTP="$(printf '%s' "$OWNER_CANCEL_OUT" | tail -n1 | sed 's/^HTTP=//')"
http_must_be_ok "$OWNER_CANCEL_HTTP" || fail "OWNER_CANCEL_SECOND_NOT_OK"

echo
echo "## OWNER CONFIRM CANCELLED MUST FAIL"
OWNER_CONFIRM_CANCELLED="$(curl -sS -X POST "$API/bookings/$BOOKING_CANCELLED_ID/confirm" \
  -H "authorization: Bearer $OWNER_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS_ID\"}" \
  -w $'\nHTTP=%{http_code}')"
printf '%s\n' "$OWNER_CONFIRM_CANCELLED"

OWNER_CONFIRM_CANCELLED_HTTP="$(printf '%s' "$OWNER_CONFIRM_CANCELLED" | tail -n1 | sed 's/^HTTP=//')"
[ "$OWNER_CONFIRM_CANCELLED_HTTP" = "400" ] || fail "OWNER_CONFIRM_CANCELLED_NOT_400"

BODY_CANCELLED="$(printf '%s' "$OWNER_CONFIRM_CANCELLED" | sed '$d')"
printf '%s' "$BODY_CANCELLED" | grep -q "Booking not confirmable" || fail "OWNER_CONFIRM_CANCELLED_MESSAGE_BAD"

echo "BOOKING_POLICY_CONFIRM_STRATEGY_PROOF_OK"
