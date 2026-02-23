#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-3001}"
BASE="http://127.0.0.1:${PORT}"

echo "🔎 Testing API on $BASE"

# login (ndrysho email/pass nëse don)
RESP=$(curl -s -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"test@plantak.com","password":"Password123!"}')

TOKEN=$(echo "$RESP" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')

if [ -z "$TOKEN" ]; then
  echo "❌ Login failed. Response:"
  echo "$RESP"
  exit 1
fi

echo "✅ Login OK"

ME=$(curl -s "$BASE/api/auth/me" -H "Authorization: Bearer $TOKEN")
echo "✅ /me OK:"
echo "$ME"
