#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../lib/availability_proof_lib.sh"

section "MULTI_STAFF_REALISM_PROOF"

echo "TODO: prove two staff with different working hours / time off produce distinct realistic result sets"

exit 1
