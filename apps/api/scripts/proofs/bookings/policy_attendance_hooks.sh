#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../lib/availability_proof_lib.sh"

ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
[ -f "$ROOT_DIR/.env.local" ] && set -a && . "$ROOT_DIR/.env.local" && set +a
[ -f "$ROOT_DIR/.env" ] && set -a && . "$ROOT_DIR/.env" && set +a

section "BOOKING_POLICY_ATTENDANCE_HOOKS_PROOF"

TARGET_DATE="2026-04-06"
DAY_OF_WEEK=1
PROOF_TZ="Europe/Paris"

WORKING_BAK="$(mktemp)"
OWNER_EMAIL="proof-booking-owner@example.com"
CUSTOMER_EMAIL="proof-booking-customer@example.com"
BOOKING_LATE_ID=""
BOOKING_NOSHOW_ID=""

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
    where: { businessId_userId: { businessId: process.env.BUSINESS_ID, userId: process.env.OWNER_ID } },
    update: { role: 'OWNER' },
    create: { businessId: process.env.BUSINESS_ID, userId: process.env.OWNER_ID, role: 'OWNER' },
  });
  console.log("OWNER_MEMBERSHIP_OK");
})().finally(async () => prisma.$disconnect());
NODE
}

mutate_booking_start_minutes_ago() {
  local booking_id="$1"
  local minutes_ago="$2"
  BOOKING_ID="$booking_id" MINUTES_AGO="$minutes_ago" node - <<'NODE'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const b = await prisma.booking.findUnique({
    where: { id: process.env.BOOKING_ID },
    select: { id: true, startAt: true, endAt: true },
  });
  if (!b) throw new Error('BOOKING_NOT_FOUND');
  const durationMs = new Date(b.endAt).getTime() - new Date(b.startAt).getTime();
  const newStart = new Date(Date.now() - Number(process.env.MINUTES_AGO) * 60_000);
  const newEnd = new Date(newStart.getTime() + durationMs);
  await prisma.booking.update({
    where: { id: b.id },
    data: { startAt: newStart, endAt: newEnd },
  });
  console.log("BOOKING_TIME_MUTATED_OK");
})().finally(async () => prisma.$disconnect());
NODE
}

assert_last_history_meta() {
  local booking_id="$1"
  local expected_state="$2"
  local expect_late="$3"
  local expect_noshow="$4"

  BOOKING_ID="$booking_id" EXPECTED_STATE="$expected_state" EXPECT_LATE="$expect_late" EXPECT_NOSHOW="$expect_noshow" node - <<'NODE'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const row = await prisma.bookingHistory.findFirst({
    where: { bookingId: process.env.BOOKING_ID },
    orderBy: { createdAt: 'desc' },
    select: { action: true, meta: true },
  });
  if (!row) throw new Error('BOOKING_HISTORY_NOT_FOUND');
  const meta = row.meta || {};
  if (meta.state !== process.env.EXPECTED_STATE) throw new Error(`BAD_STATE:${meta.state}`);
  if (String(meta.latePolicyTriggered) !== process.env.EXPECT_LATE) throw new Error(`BAD_LATE:${meta.latePolicyTriggered}`);
  if (String(meta.noShowPolicyTriggered) !== process.env.EXPECT_NOSHOW) throw new Error(`BAD_NOSHOW:${meta.noShowPolicyTriggered}`);
  console.log("HISTORY_META_ASSERT_OK");
})().finally(async () => prisma.$disconnect());
NODE
}

cleanup() {
  [ -n "${BOOKING_LATE_ID:-}" ] && cancel_booking "$OWNER_TOKEN" "$BOOKING_LATE_ID" >/dev/null 2>&1 || true
  [ -n "${BOOKING_NOSHOW_ID:-}" ] && cancel_booking "$OWNER_TOKEN" "$BOOKING_NOSHOW_ID" >/dev/null 2>&1 || true
  [ -f "$WORKING_BAK" ] && restore_working_hours "$WORKING_BAK" "$OWNER_TOKEN" >/dev/null 2>&1 || true
  rm -f "$WORKING_BAK"
}
trap cleanup EXIT

OWNER_TOKEN="$(token_for_email "$OWNER_EMAIL")"
CUSTOMER_TOKEN="$(token_for_email "$CUSTOMER_EMAIL")"
OWNER_ID="$(user_id_from_token "$OWNER_TOKEN")"
seed_owner_membership "$OWNER_ID"

backup_working_hours "$WORKING_BAK" "$OWNER_TOKEN"
set_single_window_hours "$OWNER_TOKEN" "$DAY_OF_WEEK" "09:00" "12:00"

BASE_URL="$API/availability?businessId=$BUSINESS_ID&serviceId=$BASE_SERVICE_ID&staffId=$STAFF_ID&date=$TARGET_DATE&tz=$PROOF_TZ&intervalMin=30"
BEFORE="$(curl -fsS "$BASE_URL")"
CREATE_A="$(printf '%s' "$BEFORE" | slot_start_at 0)"
CREATE_B=""

LATE_CREATE="$(curl -sS -X POST "$API/bookings" \
  -H "authorization: Bearer $CUSTOMER_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS_ID\",\"staffId\":\"$STAFF_ID\",\"serviceId\":\"$BASE_SERVICE_ID\",\"startAt\":\"$CREATE_A\",\"tz\":\"$PROOF_TZ\"}")"
BOOKING_LATE_ID="$(printf '%s' "$LATE_CREATE" | json_get id)"
echo "BOOKING_LATE_ID=$BOOKING_LATE_ID"

echo "## AVAILABILITY AFTER FIRST CREATE"
AFTER_FIRST="$(curl -fsS "$BASE_URL")"
printf '%s
' "$AFTER_FIRST"

AFTER_FIRST_COUNT="$(printf '%s' "$AFTER_FIRST" | slot_count_json)"
[ "$AFTER_FIRST_COUNT" -ge 1 ] || fail "ATTENDANCE_AFTER_FIRST_SLOT_COUNT_LT_1"

CREATE_B="$(printf '%s' "$AFTER_FIRST" | slot_start_at 0)"
echo "CREATE_B=$CREATE_B"

NOSHOW_CREATE="$(curl -sS -X POST "$API/bookings" \
  -H "authorization: Bearer $CUSTOMER_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS_ID\",\"staffId\":\"$STAFF_ID\",\"serviceId\":\"$BASE_SERVICE_ID\",\"startAt\":\"$CREATE_B\",\"tz\":\"$PROOF_TZ\"}")"
BOOKING_NOSHOW_ID="$(printf '%s' "$NOSHOW_CREATE" | json_get id)"

mutate_booking_start_minutes_ago "$BOOKING_LATE_ID" 15
mutate_booking_start_minutes_ago "$BOOKING_NOSHOW_ID" 90

curl -fsS -X POST "$API/bookings/$BOOKING_LATE_ID/confirm" \
  -H "authorization: Bearer $OWNER_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS_ID\"}" >/dev/null

curl -fsS -X POST "$API/bookings/$BOOKING_NOSHOW_ID/cancel" \
  -H "authorization: Bearer $OWNER_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS_ID\"}" >/dev/null

assert_last_history_meta "$BOOKING_LATE_ID" "LATE_WINDOW" "true" "false"
assert_last_history_meta "$BOOKING_NOSHOW_ID" "NO_SHOW_WINDOW" "false" "true"

echo "BOOKING_POLICY_ATTENDANCE_HOOKS_PROOF_OK"
