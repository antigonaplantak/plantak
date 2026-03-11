#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "FINAL_AVAILABILITY_CLOSURE_FAIL: $1"
  exit 1
}

echo "== GIT =="
git status -sb || true
git log -5 --oneline || true

echo
echo "== HARD AUDIT: DEAD QUERY FIELDS =="
if grep -RInE "format\??:\s*'utc'|format\??:\s*\"utc\"" src scripts 2>/dev/null; then
  fail "DEAD_FORMAT_FIELD_STILL_PRESENT"
fi

echo
echo "== HARD AUDIT: EUROPE_PARIS HARDCODE =="
if grep -RInE "Europe/Paris" src 2>/dev/null | grep -E "booking|availability|cache"; then
  fail "HARDCODED_EUROPE_PARIS_STILL_PRESENT"
fi

echo
echo "== HARD AUDIT: ADDON NORMALIZATION DRIFT =="
grep -RInE "normalizeAddonIds|addonIds.*split\(|split\(.*addonIds|addonIds.*sort\(|addonIds.*Set" src 2>/dev/null | sed -n '1,260p'

echo
echo "== BUILD =="
pnpm build || fail "BUILD_FAILED"

echo
echo "== BOOKING GATE =="
pnpm gate:bookings || fail "BOOKING_GATE_FAILED"

echo
echo "== AVAILABILITY ENTERPRISE PROOF =="
OUT=/tmp/availability_enterprise_final.out
pnpm proof:availability:enterprise | tee "$OUT" || fail "AVAILABILITY_PROOF_COMMAND_FAILED"

grep -q "SLOT_BOUNDARY_PROOF_OK" "$OUT" || fail "SLOT_BOUNDARY_NOT_GREEN"
grep -q "TIMEZONE_CONVERSION_PROOF_OK" "$OUT" || fail "TIMEZONE_CONVERSION_NOT_GREEN"
grep -q "WORKING_HOURS_TIMEOFF_TOTALMIN_PROOF_OK" "$OUT" || fail "WORKING_HOURS_TIMEOFF_TOTALMIN_NOT_GREEN"
grep -q "ADDON_NORMALIZATION_CONSISTENCY_PROOF_OK" "$OUT" || fail "ADDON_NORMALIZATION_CONSISTENCY_NOT_GREEN"
grep -q "DST_JUMP_FORWARD_PROOF_OK" "$OUT" || fail "DST_JUMP_FORWARD_NOT_GREEN"
grep -q "DST_FALLBACK_PROOF_OK" "$OUT" || fail "DST_FALLBACK_NOT_GREEN"
grep -q "OPENING_CLOSING_BOUNDARY_PROOF_OK" "$OUT" || fail "OPENING_CLOSING_BOUNDARY_NOT_GREEN"
grep -q "MULTI_STAFF_REALISM_PROOF_OK" "$OUT" || fail "MULTI_STAFF_REALISM_NOT_GREEN"

echo
echo "FINAL_AVAILABILITY_CLOSURE_GATE_OK"
