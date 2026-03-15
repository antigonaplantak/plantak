#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://localhost:3001/api}"
BASE_DATE="${DATE_YMD:-2027-01-16}"

day() {
  date -u -d "$BASE_DATE + $1 day" +%F
}

echo "== PAYMENTS PROOF STACK =="
echo "API_URL=$API_URL"
echo "BASE_DATE=$BASE_DATE"

API_URL="$API_URL" DATE_YMD="$(day 0)" node scripts/proofs/payments/payment_settle_proof.mjs
API_URL="$API_URL" DATE_YMD="$(day 1)" node scripts/proofs/payments/payment_waive_proof.mjs
API_URL="$API_URL" DATE_YMD="$(day 2)" node scripts/proofs/payments/payment_forfeit_proof.mjs
API_URL="$API_URL" DATE_YMD="$(day 3)" node scripts/proofs/payments/payment_refund_proof.mjs
API_URL="$API_URL" DATE_YMD="$(day 4)" node scripts/proofs/payments/payment_partial_refund_proof.mjs
API_URL="$API_URL" DATE_YMD="$(day 5)" node scripts/proofs/payments/payment_state_machine_invalid_proof.mjs
API_URL="$API_URL" DATE_YMD="$(day 6)" node scripts/proofs/payments/payment_deposit_expire_proof.mjs

echo "PAYMENTS_PROOF_STACK_OK"
