#!/usr/bin/env bash
set -euo pipefail

API_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"

echo "== BUILD =="
pnpm -C "$API_DIR" build

echo
echo "== LINT =="
pnpm -C "$API_DIR" lint

echo
echo "== HOT PATH SMOKE =="
bash "$API_DIR/scripts/service_stack_hot_path_smoke.sh"

echo
echo "== NEGATIVE SECURITY PROOF =="
bash "$API_DIR/scripts/proofs/services/service_stack_negative_security_proof.sh"

echo
echo "SERVICE_STACK_GATE_OK"
