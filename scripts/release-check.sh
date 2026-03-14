#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "== RELEASE CHECK =="

if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: working tree not clean"
  git status -sb
  exit 1
fi

pnpm -C apps/api run build
pnpm -C apps/api run ops:queue:alerts
pnpm -C apps/api run ops:observability:proof
pnpm -C apps/api run gate:bookings

docker compose -f infra/docker-compose.yml config >/dev/null
docker compose -f infra/docker-compose.yml build api >/dev/null

echo "RELEASE_CHECK_OK"
