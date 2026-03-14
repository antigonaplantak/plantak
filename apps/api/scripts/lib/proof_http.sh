#!/usr/bin/env bash

http_json() {
  local method="$1"
  local url="$2"
  local body="${3:-}"
  local auth_header="${4:-}"
  local out status

  out="$(mktemp)"

  if [ -n "$body" ]; then
    if [ -n "$auth_header" ]; then
      status="$(curl -sS -o "$out" -w '%{http_code}' -X "$method" "$url" \
        -H "$auth_header" \
        -H 'content-type: application/json' \
        --data-binary "$body")"
    else
      status="$(curl -sS -o "$out" -w '%{http_code}' -X "$method" "$url" \
        -H 'content-type: application/json' \
        --data-binary "$body")"
    fi
  else
    if [ -n "$auth_header" ]; then
      status="$(curl -sS -o "$out" -w '%{http_code}' -X "$method" "$url" \
        -H "$auth_header")"
    else
      status="$(curl -sS -o "$out" -w '%{http_code}' -X "$method" "$url")"
    fi
  fi

  echo "HTTP=$status"
  cat "$out"
  echo

  [ "$status" -ge 200 ] && [ "$status" -lt 300 ] || return 22
}
