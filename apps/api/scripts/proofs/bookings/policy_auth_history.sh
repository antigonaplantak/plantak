#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../lib/availability_proof_lib.sh"

ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
[ -f "$ROOT_DIR/.env.local" ] && set -a && . "$ROOT_DIR/.env.local" && set +a
[ -f "$ROOT_DIR/.env" ] && set -a && . "$ROOT_DIR/.env" && set +a

section "BOOKING_POLICY_AUTH_HISTORY_PROOF"

PROOF_TZ="Europe/Paris"
TARGET_DATE="2026-04-06"
DAY_OF_WEEK=1

WORKING_BAK="$(mktemp)"
BOOKING_ID=""

OWNER_PROOF_EMAIL="proof-booking-owner@example.com"
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

history_assert() {
  local booking_id="$1"
  local customer_id="$2"
  local owner_id="$3"

  HISTORY_JSON="$(
    BOOKING_ID="$booking_id" node - <<'NODE'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const rows = await prisma.bookingHistory.findMany({
    where: { bookingId: process.env.BOOKING_ID },
    orderBy: { createdAt: 'asc' },
    select: {
      action: true,
      actorUserId: true,
      actorRole: true,
      status: true,
      fromStartAt: true,
      toStartAt: true,
    },
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

  HISTORY_JSON="$HISTORY_JSON" CUSTOMER_ID="$customer_id" OWNER_ID="$owner_id" python3 - <<'PY'
import json, os, sys

rows = json.loads(os.environ["HISTORY_JSON"])
customer_id = os.environ["CUSTOMER_ID"]
owner_id = os.environ["OWNER_ID"]

expected_actions = ["CREATE", "RESCHEDULE", "CONFIRM", "CANCEL"]
actions = [r["action"] for r in rows]
if actions != expected_actions:
    print("EXPECTED_ACTIONS=", expected_actions)
    print("ACTUAL_ACTIONS=", actions)
    raise SystemExit("BOOKING_HISTORY_ACTIONS_BAD")

if len(rows) != 4:
    print("ROWS=", json.dumps(rows, default=str, indent=2))
    raise SystemExit("BOOKING_HISTORY_COUNT_BAD")

if rows[0]["actorUserId"] != customer_id:
    raise SystemExit("CREATE_ACTOR_USER_BAD")

for idx in [1, 2, 3]:
    if rows[idx]["actorUserId"] != owner_id:
        raise SystemExit(f"OPERATOR_ACTOR_USER_BAD_{idx}")

if rows[0]["actorRole"] != "CUSTOMER":
    raise SystemExit("CREATE_ACTOR_ROLE_BAD")

for idx in [1, 2, 3]:
    if rows[idx]["actorRole"] != "OWNER":
        raise SystemExit(f"OPERATOR_ACTOR_ROLE_BAD_{idx}")

print("BOOKING_HISTORY_ASSERT_OK")
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

OWNER_TOKEN="$(token_for_email "$OWNER_PROOF_EMAIL")"
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
[ "$SLOT_COUNT" -ge 3 ] || fail "BOOKING_POLICY_SLOT_COUNT_LT_3"

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

echo "BOOKING_ID=$BOOKING_ID"

echo
echo "## OTHER CUSTOMER RESCHEDULE MUST FAIL"
OTHER_RES_OUT="$(mktemp)"
OTHER_RES_HTTP="$(curl -sS -o "$OTHER_RES_OUT" -w '%{http_code}' -X POST "$API/bookings/$BOOKING_ID/reschedule" \
  -H "authorization: Bearer $OTHER_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS_ID\",\"newStartLocal\":\"$RESCHED_LOCAL\",\"tz\":\"$PROOF_TZ\"}")"
cat "$OTHER_RES_OUT"
echo
[ "$OTHER_RES_HTTP" = "403" ] || fail "OTHER_CUSTOMER_RESCHEDULE_NOT_403"
rm -f "$OTHER_RES_OUT"

echo
echo "## OWNER RESCHEDULE MUST PASS"
OWNER_RES_OUT="$(mktemp)"
OWNER_RES_HTTP="$(curl -sS -o "$OWNER_RES_OUT" -w '%{http_code}' -X POST "$API/bookings/$BOOKING_ID/reschedule" \
  -H "authorization: Bearer $OWNER_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS_ID\",\"newStartLocal\":\"$RESCHED_LOCAL\",\"tz\":\"$PROOF_TZ\"}")"
cat "$OWNER_RES_OUT"
echo
http_must_be_ok "$OWNER_RES_HTTP" || fail "OWNER_RESCHEDULE_NOT_OK"

OWNER_RES_START="$(python3 - "$OWNER_RES_OUT" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], "r", encoding="utf-8"))
print(data["startAt"])
PY
)"
[ "$OWNER_RES_START" = "$RESCHED_START" ] || fail "OWNER_RESCHEDULE_START_BAD"
rm -f "$OWNER_RES_OUT"

echo
echo "## OWNER CONFIRM MUST PASS"
OWNER_CONFIRM_OUT="$(mktemp)"
OWNER_CONFIRM_HTTP="$(curl -sS -o "$OWNER_CONFIRM_OUT" -w '%{http_code}' -X POST "$API/bookings/$BOOKING_ID/confirm" \
  -H "authorization: Bearer $OWNER_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS_ID\"}")"
cat "$OWNER_CONFIRM_OUT"
echo
http_must_be_ok "$OWNER_CONFIRM_HTTP" || fail "OWNER_CONFIRM_NOT_OK"
rm -f "$OWNER_CONFIRM_OUT"

echo
echo "## OTHER CUSTOMER CANCEL MUST FAIL"
OTHER_CANCEL_OUT="$(mktemp)"
OTHER_CANCEL_HTTP="$(curl -sS -o "$OTHER_CANCEL_OUT" -w '%{http_code}' -X POST "$API/bookings/$BOOKING_ID/cancel" \
  -H "authorization: Bearer $OTHER_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS_ID\"}")"
cat "$OTHER_CANCEL_OUT"
echo
[ "$OTHER_CANCEL_HTTP" = "403" ] || fail "OTHER_CUSTOMER_CANCEL_NOT_403"
rm -f "$OTHER_CANCEL_OUT"

echo
echo "## OWNER CANCEL MUST PASS"
OWNER_CANCEL_OUT="$(mktemp)"
OWNER_CANCEL_HTTP="$(curl -sS -o "$OWNER_CANCEL_OUT" -w '%{http_code}' -X POST "$API/bookings/$BOOKING_ID/cancel" \
  -H "authorization: Bearer $OWNER_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS_ID\"}")"
cat "$OWNER_CANCEL_OUT"
echo
http_must_be_ok "$OWNER_CANCEL_HTTP" || fail "OWNER_CANCEL_NOT_OK"
rm -f "$OWNER_CANCEL_OUT"

echo
echo "## BOOKING HISTORY ASSERT"
history_assert "$BOOKING_ID" "$CUSTOMER_ID" "$OWNER_ID"

echo "BOOKING_POLICY_AUTH_HISTORY_PROOF_OK"
