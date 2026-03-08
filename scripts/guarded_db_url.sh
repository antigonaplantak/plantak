#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

find_db_url() {
  if [ -n "${DATABASE_URL:-}" ]; then
    printf '%s' "$DATABASE_URL"
    return 0
  fi

  for f in apps/api/.env apps/api/.env.local apps/api/.env.development .env; do
    if [ -f "$f" ]; then
      val="$(grep -E '^DATABASE_URL=' "$f" | tail -n1 | sed 's/^DATABASE_URL=//')"
      val="${val%\"}"; val="${val#\"}"
      val="${val%\'}"; val="${val#\'}"
      if [ -n "$val" ]; then
        printf '%s' "$val"
        return 0
      fi
    fi
  done

  echo "DATABASE_URL not found" >&2
  return 1
}

RAW_URL="$(find_db_url)"

python3 - "$RAW_URL" <<'PY'
import sys
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

raw = sys.argv[1]
parts = urlsplit(raw)
q = dict(parse_qsl(parts.query, keep_blank_values=True))

# conservative per-instance guard for scale discipline
q["connection_limit"] = q.get("connection_limit", "5")
q["pool_timeout"] = q.get("pool_timeout", "2")
q["connect_timeout"] = q.get("connect_timeout", "5")

print(urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(q), parts.fragment)))
PY
