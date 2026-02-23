#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$ROOT_DIR/apps/api"

cd "$API_DIR"

PORT="${PORT:-$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 || echo 3001)}"
echo "🚀 Starting API on port $PORT ..."

npx --yes nest start --watch
