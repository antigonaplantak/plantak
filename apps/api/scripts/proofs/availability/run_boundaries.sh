#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bash "$SCRIPT_DIR/opening_boundary.sh"
bash "$SCRIPT_DIR/closing_boundary.sh"

echo "BOUNDARY_PAIR_PROOF_OK"
