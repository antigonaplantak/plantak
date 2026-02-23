#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_FILE="$ROOT_DIR/infra/docker-compose.yml"

echo "⚠️ This will stop containers and DELETE DB data (volumes)."
read -p "Type YES to continue: " CONF
if [ "$CONF" != "YES" ]; then
  echo "Cancelled."
  exit 0
fi

docker compose -f "$INFRA_FILE" down -v
echo "✅ Reset complete."
