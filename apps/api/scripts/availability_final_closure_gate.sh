#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "FINAL_AVAILABILITY_CLOSURE_FAIL: $1"
  exit 1
}

echo "== HARD AUDIT: DEAD QUERY FIELDS =="
if grep -RInE "format\??:\s*'utc'|format\??:\s*\"utc\"" src/availability src/bookings 2>/dev/null; then
  fail "DEAD_FORMAT_FIELD_STILL_PRESENT"
fi

echo
echo "== HARD AUDIT: EUROPE_PARIS HARDCODE =="
if grep -RInE "tz = 'Europe/Paris'|tz\s*\?\?\s*'Europe/Paris'|invalidateAvailabilityCacheForBooking\(.*Europe/Paris" src/bookings src/availability 2>/dev/null; then
  fail "HARDCODED_EUROPE_PARIS_STILL_PRESENT"
fi

echo
echo "== HARD AUDIT: ADDON NORMALIZATION IMPLEMENTATIONS =="
DRIFT="$(
  grep -RInE "function normalizeAddonIds|private normalizeAddonIds|private normalizeIds" src/availability src/bookings src/services 2>/dev/null     | grep -v "src/availability/addon-ids.util.ts" || true
)"
if [ -n "$DRIFT" ]; then
  printf '%s
' "$DRIFT"
  fail "ADDON_NORMALIZATION_DRIFT_STILL_PRESENT"
fi

echo
echo "== BUILD =="
pnpm build
echo "BUILD_OK"

echo
echo "== PROOF =="
OUT="$(mktemp)"
pnpm run proof:availability:enterprise | tee "$OUT"

grep -q "SLOT_BOUNDARY_PROOF_OK" "$OUT" || fail "SLOT_BOUNDARY_NOT_GREEN"
grep -q "TIMEZONE_CONVERSION_PROOF_OK" "$OUT" || fail "TIMEZONE_CONVERSION_NOT_GREEN"
grep -q "WORKING_HOURS_TIMEOFF_TOTALMIN_PROOF_OK" "$OUT" || fail "WORKING_HOURS_TIMEOFF_TOTALMIN_NOT_GREEN"
grep -q "ADDON_NORMALIZATION_CONSISTENCY_PROOF_OK" "$OUT" || fail "ADDON_NORMALIZATION_CONSISTENCY_NOT_GREEN"

if grep -q "DST_JUMP_FORWARD_PROOF_PENDING" "$OUT"; then
  fail "DST_JUMP_FORWARD_NOT_GREEN"
fi

if grep -q "DST_FALLBACK_PROOF_PENDING" "$OUT"; then
  fail "DST_FALLBACK_NOT_GREEN"
fi

echo
echo "AVAILABILITY_FINAL_CLOSURE_GATE_OK"
