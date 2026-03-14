#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../lib/availability_proof_lib.sh"

section "DST_FALLBACK_PROOF"

TOKEN="$(auth_token)"
echo "TOKEN_OK"

FALLBACK_DATE="2026-10-25"
FALLBACK_HOURS_BAK="$(mktemp)"

backup_working_hours "$FALLBACK_HOURS_BAK" "$TOKEN"
cleanup() {
  restore_working_hours "$FALLBACK_HOURS_BAK" "$TOKEN" >/dev/null 2>&1 || true
  rm -f "$FALLBACK_HOURS_BAK"
}
trap cleanup EXIT

set_single_window_hours "$TOKEN" 0 "01:00" "05:00"

AVAIL_FALLBACK="$(curl -fsS "$API/availability?businessId=$BUSINESS_ID&serviceId=$BASE_SERVICE_ID&staffId=$STAFF_ID&date=$FALLBACK_DATE&tz=Europe/Paris&intervalMin=30")"
printf '%s\n' "$AVAIL_FALLBACK"

FALLBACK_COUNT="$(printf '%s' "$AVAIL_FALLBACK" | slot_count_json)"
[ "$FALLBACK_COUNT" = "9" ] || fail "DST_FALLBACK_SLOT_COUNT_BAD"

EXPECTED_FALLBACK='["2026-10-25T01:00+0200","2026-10-25T01:30+0200","2026-10-25T02:00+0200","2026-10-25T02:30+0200","2026-10-25T02:00+0100","2026-10-25T02:30+0100","2026-10-25T03:00+0100","2026-10-25T03:30+0100","2026-10-25T04:00+0100"]'
printf '%s' "$AVAIL_FALLBACK" | assert_local_slots "$EXPECTED_FALLBACK" "Europe/Paris" > /tmp/plantak_dst_fallback_slots.txt
cat /tmp/plantak_dst_fallback_slots.txt

FALLBACK_BOOK_A="$(printf '%s' "$AVAIL_FALLBACK" | slot_start_at 2)"
FALLBACK_BOOK_B="$(printf '%s' "$AVAIL_FALLBACK" | slot_start_at 4)"
FALLBACK_LOCAL_A="$(utc_to_local_with_offset "$FALLBACK_BOOK_A" "Europe/Paris")"
FALLBACK_LOCAL_B="$(utc_to_local_with_offset "$FALLBACK_BOOK_B" "Europe/Paris")"

echo "FALLBACK_BOOK_A=$FALLBACK_BOOK_A"
echo "FALLBACK_LOCAL_A=$FALLBACK_LOCAL_A"
echo "FALLBACK_BOOK_B=$FALLBACK_BOOK_B"
echo "FALLBACK_LOCAL_B=$FALLBACK_LOCAL_B"

CREATE_A="$(create_booking "$TOKEN" "$BASE_SERVICE_ID" "$FALLBACK_BOOK_A")"
printf '%s\n' "$CREATE_A"
HTTP_A="$(printf '%s' "$CREATE_A" | tail -n1 | sed 's/^HTTP=//')"
[ "$HTTP_A" = "201" ] || fail "DST_FALLBACK_BOOKING_A_NOT_201"
ID_A="$(printf '%s' "$CREATE_A" | sed '$d' | json_get id)"

CREATE_B="$(create_booking "$TOKEN" "$BASE_SERVICE_ID" "$FALLBACK_BOOK_B")"
printf '%s\n' "$CREATE_B"
HTTP_B="$(printf '%s' "$CREATE_B" | tail -n1 | sed 's/^HTTP=//')"
[ "$HTTP_B" = "201" ] || fail "DST_FALLBACK_BOOKING_B_NOT_201"
ID_B="$(printf '%s' "$CREATE_B" | sed '$d' | json_get id)"

cancel_booking "$TOKEN" "$ID_A"
cancel_booking "$TOKEN" "$ID_B"

echo "DST_FALLBACK_PROOF_OK"
