#!/usr/bin/env bash
set -euo pipefail

cd /app/apps/api

echo "== PRISMA GENERATE =="
pnpm exec prisma generate

echo "== PRISMA MIGRATE DEPLOY =="
pnpm exec prisma migrate deploy

echo "== START API =="
exec node dist/main
