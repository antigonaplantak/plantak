#!/usr/bin/env bash
set -euo pipefail

echo "== BUILD =="
pnpm build
echo "BUILD_OK"

echo
echo "== POLICY AUTH HISTORY =="
bash scripts/proofs/bookings/policy_auth_history.sh
echo "BOOKING_POLICY_AUTH_HISTORY_OK"

echo
echo "== POLICY NOTICE WINDOWS =="
bash scripts/proofs/bookings/policy_notice_windows.sh
echo "BOOKING_POLICY_NOTICE_WINDOWS_OK"

echo
echo "== POLICY ATTENDANCE HOOKS =="
bash scripts/proofs/bookings/policy_attendance_hooks.sh
echo "BOOKING_POLICY_ATTENDANCE_HOOKS_OK"

echo
echo "== POLICY CONFIRM STRATEGY =="
bash scripts/proofs/bookings/policy_confirm_strategy.sh
echo "BOOKING_POLICY_CONFIRM_STRATEGY_OK"

echo
echo "== POLICY HISTORY HTTP CONTRACT =="
bash scripts/proofs/bookings/policy_history_http_contract.sh
echo "BOOKING_POLICY_HISTORY_HTTP_CONTRACT_OK"

echo
echo "BOOKING_POLICY_FINAL_GATE_OK"
