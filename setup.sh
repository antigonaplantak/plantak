#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$ROOT_DIR/apps/api"
INFRA_FILE="$ROOT_DIR/infra/docker-compose.yml"

echo "🚀 Plantak setup (1-click)"

# Checks
command -v node >/dev/null 2>&1 || { echo "❌ Node missing"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "❌ npm missing"; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "❌ Docker missing"; exit 1; }

echo "✅ Node: $(node -v)"
echo "✅ npm:  $(npm -v)"
echo "✅ Docker: $(docker --version | head -n 1)"

# Start infra
echo "🐳 Starting infra (Postgres + Redis)..."
docker compose -f "$INFRA_FILE" up -d

# Create API .env if missing
cd "$API_DIR"
if [ ! -f .env ]; then
  echo "⚙️ Creating .env from .env.example"
  cp .env.example .env
sed -i "s/changeme/1000 4 24 27 30 46 100 1000 1001openssl rand -hex 32)/g" .env
fi

# Install deps
echo "📦 Installing API dependencies..."
npm install

# Prisma
echo "🧠 Prisma generate..."
npx prisma generate

echo "🗄️ Prisma migrate (dev)..."
npx prisma migrate dev --name init --skip-seed || true

echo "✅ Setup finished!"
echo "👉 Next: ./start.sh"
