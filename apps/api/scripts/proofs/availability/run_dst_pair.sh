#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bash "$SCRIPT_DIR/dst_jump_forward.sh"
bash "$SCRIPT_DIR/dst_fallback.sh"

echo "DST_PAIR_PROOF_OK"
