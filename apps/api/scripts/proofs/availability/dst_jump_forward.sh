#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../lib/availability_proof_lib.sh"

section "DST_JUMP_FORWARD_PROOF"
echo "DEBUG_API=$API"
echo "DEBUG_BUSINESS_ID=$BUSINESS_ID"
echo "DEBUG_STAFF_ID=$STAFF_ID"
echo "DEBUG_OWNER_EMAIL=$OWNER_EMAIL"

TOKEN="$(auth_token)"
echo "TOKEN_OK"

echo
echo "## AUTH CONTEXT"
AUTH_CTX_OUT="$(mktemp)"
AUTH_CTX_HTTP="$(curl -sS -o "$AUTH_CTX_OUT" -w '%{http_code}' \
  -H "authorization: Bearer $TOKEN" \
  "$API/auth/context")"
echo "AUTH_CONTEXT_HTTP=$AUTH_CTX_HTTP"
cat "$AUTH_CTX_OUT"
echo

echo
echo "## WORKING HOURS GET"
WH_OUT="$(mktemp)"
WH_HTTP="$(curl -sS -o "$WH_OUT" -w '%{http_code}' \
  -H "authorization: Bearer $TOKEN" \
  "$API/staff/$STAFF_ID/working-hours?businessId=$BUSINESS_ID")"
echo "WORKING_HOURS_HTTP=$WH_HTTP"
cat "$WH_OUT"
echo

[ "$AUTH_CTX_HTTP" -ge 200 ] && [ "$AUTH_CTX_HTTP" -lt 300 ] || exit 31
[ "$WH_HTTP" -ge 200 ] && [ "$WH_HTTP" -lt 300 ] || exit 32


JUMP_DATE="2026-03-29"
JUMP_HOURS_BAK="$(mktemp)"

backup_working_hours "$JUMP_HOURS_BAK" "$TOKEN"
cleanup() {
  restore_working_hours "$JUMP_HOURS_BAK" "$TOKEN" >/dev/null 2>&1 || true
  rm -f "$JUMP_HOURS_BAK"
}
trap cleanup EXIT

set_single_window_hours "$TOKEN" 0 "01:00" "05:00"

AVAIL_JUMP="$(curl -fsS "$API/availability?businessId=$BUSINESS_ID&serviceId=$BASE_SERVICE_ID&staffId=$STAFF_ID&date=$JUMP_DATE&tz=Europe/Paris&intervalMin=30")"
printf '%s\n' "$AVAIL_JUMP"

JUMP_COUNT="$(printf '%s' "$AVAIL_JUMP" | slot_count_json)"
[ "$JUMP_COUNT" = "5" ] || fail "DST_JUMP_FORWARD_SLOT_COUNT_BAD"

EXPECTED_JUMP='["2026-03-29T01:00+0100","2026-03-29T01:30+0100","2026-03-29T03:00+0200","2026-03-29T03:30+0200","2026-03-29T04:00+0200"]'
printf '%s' "$AVAIL_JUMP" | assert_local_slots "$EXPECTED_JUMP" "Europe/Paris" > /tmp/plantak_dst_jump_slots.txt
cat /tmp/plantak_dst_jump_slots.txt

JUMP_BOOK_START="$(printf '%s' "$AVAIL_JUMP" | slot_start_at 2)"
JUMP_BOOK_LOCAL="$(utc_to_local_with_offset "$JUMP_BOOK_START" "Europe/Paris")"
echo "JUMP_BOOK_START=$JUMP_BOOK_START"
echo "JUMP_BOOK_LOCAL=$JUMP_BOOK_LOCAL"

CREATE_JUMP="$(create_booking "$TOKEN" "$BASE_SERVICE_ID" "$JUMP_BOOK_START")"
printf '%s\n' "$CREATE_JUMP"

JUMP_HTTP="$(printf '%s' "$CREATE_JUMP" | tail -n1 | sed 's/^HTTP=//')"
[ "$JUMP_HTTP" = "201" ] || fail "DST_JUMP_FORWARD_BOOKING_NOT_201"

JUMP_BOOKING_ID="$(printf '%s' "$CREATE_JUMP" | sed '$d' | json_get id)"
cancel_booking "$TOKEN" "$JUMP_BOOKING_ID"

echo "DST_JUMP_FORWARD_PROOF_OK"
