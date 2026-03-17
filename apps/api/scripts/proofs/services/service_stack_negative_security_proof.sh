#!/usr/bin/env bash
set -euo pipefail

API="${API_URL:-http://localhost:${PORT:-3001}/api}"
BUSINESS_ID="${BUSINESS_ID:-b1}"
STAFF_ID="${STAFF_ID:-b9b77322-1012-4860-af1b-5b53a6171d06}"
BASE_DATE="${DATE_YMD:-2026-07-07}"

json_get() {
  local path="$1"
  local raw
  raw="$(cat)"
  JSON_INPUT="$raw" node - "$path" <<'NODE'
const path = process.argv[2].split('.');
const raw = process.env.JSON_INPUT ?? '';
if (!raw.trim()) process.exit(1);
const data = JSON.parse(raw);
let cur = data;
for (const key of path) {
  if (cur == null) process.exit(2);
  cur = cur[key];
}
if (typeof cur === 'object') process.stdout.write(JSON.stringify(cur));
else process.stdout.write(String(cur));
NODE
}

availability_with_retry() {
  local url="$1"
  local attempt=1
  local max=5
  local body=""
  while [ "$attempt" -le "$max" ]; do
    local tmp code
    tmp="$(mktemp)"
    code="$(curl -sS -o "$tmp" -w "%{http_code}" "$url")"
    body="$(cat "$tmp")"
    rm -f "$tmp"
    if [ "$code" = "200" ]; then
      printf '%s' "$body"
      return 0
    fi
    if [ "$code" != "429" ]; then
      echo "$body"
      echo "AVAILABILITY_HTTP_$code"
      return 1
    fi
    sleep "$attempt"
    attempt=$((attempt + 1))
  done
  echo "AVAILABILITY_RATE_LIMITED_429"
  return 1
}

expect_non_2xx() {
  local code="$1"
  if [[ "$code" =~ ^2 ]]; then
    echo "EXPECTED_NON_2XX_GOT_$code"
    exit 1
  fi
  echo "NON_2XX_OK $code"
}

expect_eq() {
  local a="$1"
  local b="$2"
  if [ "$a" != "$b" ]; then
    echo "EXPECT_EQ_FAILED expected=$b actual=$a"
    exit 1
  fi
  echo "EXPECT_EQ_OK $b"
}

echo "== HEALTH =="
curl -fsS "$API/health" >/dev/null
echo HEALTH_OK

REQ="$(curl -fsS -X POST "$API/auth/magic/request" \
  -H 'content-type: application/json' \
  -d '{"email":"owner@example.com"}')"
CODE="$(printf '%s' "$REQ" | json_get devCode)"
VERIFY="$(curl -fsS -X POST "$API/auth/magic/verify" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"owner@example.com\",\"code\":\"$CODE\"}")"
TOKEN="$(printf '%s' "$VERIFY" | json_get accessToken)"
[ -n "$TOKEN" ] || { echo TOKEN_MISSING; exit 1; }
echo TOKEN_OK

UNIQ="$(date +%s)"

echo
echo "== SECURITY NO TOKEN =="
TMP="$(mktemp)"
CODE="$(curl -sS -o "$TMP" -w "%{http_code}" -X POST "$API/services" \
  -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS_ID\",\"name\":\"unauth-$UNIQ\",\"durationMin\":30,\"priceCents\":1000,\"currency\":\"EUR\"}")"
cat "$TMP"
rm -f "$TMP"
expect_non_2xx "$CODE"

echo
echo "== CREATE SERVICE A =="
SERVICE_A="$(curl -fsS -X POST "$API/services" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS_ID\",\"name\":\"svc-a-$UNIQ\",\"durationMin\":60,\"priceCents\":6000,\"currency\":\"EUR\",\"onlineBookingEnabled\":true}")"
SERVICE_A_ID="$(printf '%s' "$SERVICE_A" | json_get id)"
echo "$SERVICE_A"

echo
echo "== CREATE VARIANT A =="
VARIANT_A="$(curl -fsS -X POST "$API/services/$SERVICE_A_ID/variants" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"va","durationMin":80,"priceCents":8000,"onlineBookingEnabled":true}')"
VARIANT_A_ID="$(printf '%s' "$VARIANT_A" | json_get id)"
echo "$VARIANT_A"

echo
echo "== CREATE ADDON A =="
ADDON_A="$(curl -fsS -X POST "$API/services/$SERVICE_A_ID/addons" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"aa","durationMin":15,"priceCents":500,"bufferAfterMin":5,"onlineBookingEnabled":true}')"
ADDON_A_ID="$(printf '%s' "$ADDON_A" | json_get id)"
echo "$ADDON_A"

echo
echo "== CREATE SERVICE B =="
SERVICE_B="$(curl -fsS -X POST "$API/services" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS_ID\",\"name\":\"svc-b-$UNIQ\",\"durationMin\":45,\"priceCents\":4500,\"currency\":\"EUR\",\"onlineBookingEnabled\":true}")"
SERVICE_B_ID="$(printf '%s' "$SERVICE_B" | json_get id)"
echo "$SERVICE_B"

echo
echo "== CREATE VARIANT B =="
VARIANT_B="$(curl -fsS -X POST "$API/services/$SERVICE_B_ID/variants" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"vb","durationMin":50,"priceCents":5000,"onlineBookingEnabled":true}')"
VARIANT_B_ID="$(printf '%s' "$VARIANT_B" | json_get id)"
echo "$VARIANT_B"

echo
echo "== ASSIGN STAFF TO BOTH SERVICES =="
CURRENT_ASSIGNMENTS="$(curl -fsS "$API/staff/$STAFF_ID/services?businessId=$BUSINESS_ID" \
  -H "authorization: Bearer $TOKEN")"

REPLACE_PAYLOAD="$(
  CURRENT_ASSIGNMENTS="$CURRENT_ASSIGNMENTS" \
  SERVICE_A_ID="$SERVICE_A_ID" \
  SERVICE_B_ID="$SERVICE_B_ID" \
  BUSINESS_ID="$BUSINESS_ID" \
  node <<'NODE'
const current = JSON.parse(process.env.CURRENT_ASSIGNMENTS || '[]');
const businessId = process.env.BUSINESS_ID;
const wanted = [process.env.SERVICE_A_ID, process.env.SERVICE_B_ID].filter(Boolean);
const map = new Map();
for (const row of current) {
  map.set(row.serviceId, {
    serviceId: row.serviceId,
    isActive: row.isActive,
    onlineBookingEnabled: row.onlineBookingEnabled,
    durationMinOverride: row.durationMinOverride,
    priceCentsOverride: row.priceCentsOverride,
    bufferBeforeMinOverride: row.bufferBeforeMinOverride,
    bufferAfterMinOverride: row.bufferAfterMinOverride,
  });
}
for (const serviceId of wanted) {
  map.set(serviceId, {
    serviceId,
    isActive: true,
    onlineBookingEnabled: true,
    durationMinOverride: null,
    priceCentsOverride: null,
    bufferBeforeMinOverride: null,
    bufferAfterMinOverride: null,
  });
}
process.stdout.write(JSON.stringify({ businessId, items: [...map.values()] }));
NODE
)"
curl -fsS -X PUT "$API/staff/$STAFF_ID/services" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "$REPLACE_PAYLOAD" >/dev/null
echo STAFF_ASSIGNMENT_OK

echo
echo "== PICK AVAILABLE SLOT =="
START_AT=""
for offset in $(seq 0 14); do
  DAY="$(date -u -d "$BASE_DATE +$offset day" +%F)"
  AVAIL="$(availability_with_retry "$API/availability?businessId=$BUSINESS_ID&serviceId=$SERVICE_A_ID&variantId=$VARIANT_A_ID&addonIds=$ADDON_A_ID&staffId=$STAFF_ID&date=$DAY&tz=Europe/Paris")"
  START_AT="$(printf '%s' "$AVAIL" | json_get 'results.0.slots.0.start' || true)"
  if [ -n "$START_AT" ]; then
    echo "START_AT=$START_AT"
    break
  fi
done
[ -n "$START_AT" ] || { echo "NO_SLOT_FOUND_IN_15D_WINDOW"; exit 1; }

echo
echo "== INVALID VARIANT MISMATCH =="
TMP="$(mktemp)"
CODE="$(curl -sS -o "$TMP" -w "%{http_code}" -X POST "$API/bookings" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS_ID\",\"staffId\":\"$STAFF_ID\",\"serviceId\":\"$SERVICE_A_ID\",\"variantId\":\"$VARIANT_B_ID\",\"startAt\":\"$START_AT\",\"idempotencyKey\":\"bad-variant-$UNIQ\"}")"
cat "$TMP"
rm -f "$TMP"
expect_non_2xx "$CODE"

echo
echo "== INVALID ADDON MISMATCH =="
TMP="$(mktemp)"
CODE="$(curl -sS -o "$TMP" -w "%{http_code}" -X POST "$API/bookings" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS_ID\",\"staffId\":\"$STAFF_ID\",\"serviceId\":\"$SERVICE_B_ID\",\"addonIds\":[\"$ADDON_A_ID\"],\"startAt\":\"$START_AT\",\"idempotencyKey\":\"bad-addon-$UNIQ\"}")"
cat "$TMP"
rm -f "$TMP"
expect_non_2xx "$CODE"

echo
echo "== IDEMPOTENT CREATE REPLAY =="
GOOD1="$(curl -fsS -X POST "$API/bookings" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS_ID\",\"staffId\":\"$STAFF_ID\",\"serviceId\":\"$SERVICE_A_ID\",\"variantId\":\"$VARIANT_A_ID\",\"addonIds\":[\"$ADDON_A_ID\"],\"startAt\":\"$START_AT\",\"idempotencyKey\":\"idem-$UNIQ\"}")"
GOOD2="$(curl -fsS -X POST "$API/bookings" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS_ID\",\"staffId\":\"$STAFF_ID\",\"serviceId\":\"$SERVICE_A_ID\",\"variantId\":\"$VARIANT_A_ID\",\"addonIds\":[\"$ADDON_A_ID\"],\"startAt\":\"$START_AT\",\"idempotencyKey\":\"idem-$UNIQ\"}")"
echo "$GOOD1"
echo "$GOOD2"

B1="$(printf '%s' "$GOOD1" | json_get id)"
B2="$(printf '%s' "$GOOD2" | json_get id)"
expect_eq "$B1" "$B2"

echo
echo "SERVICE_STACK_NEGATIVE_SECURITY_IDEMPOTENCY_OK"
