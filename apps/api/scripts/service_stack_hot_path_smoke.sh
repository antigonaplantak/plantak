#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

set -a
[ -f .env ] && . ./.env
[ -f .env.local ] && . ./.env.local
set +a

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
if (!raw.trim()) {
  console.error('JSON_GET_EMPTY_INPUT');
  process.exit(1);
}
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

slot_at() {
  local idx="$1"
  local raw
  raw="$(cat)"
  JSON_INPUT="$raw" IDX="$idx" node <<'NODE'
const data = JSON.parse(process.env.JSON_INPUT || '{}');
const idx = Number(process.env.IDX || '0');
const slot = data.results?.[0]?.slots?.[idx]?.start ?? '';
process.stdout.write(slot);
NODE
}

add_minutes_utc() {
  local iso="$1"
  local mins="$2"
  ISO="$iso" MINS="$mins" node <<'NODE'
const iso = process.env.ISO;
const mins = Number(process.env.MINS || '0');
const d = new Date(iso);
if (Number.isNaN(d.getTime())) process.exit(1);
d.setUTCMinutes(d.getUTCMinutes() + mins);
process.stdout.write(d.toISOString());
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

assert_eq() {
  local actual="$1"
  local expected="$2"
  if [ "$actual" != "$expected" ]; then
    echo "ASSERT_EQ_FAILED expected=$expected actual=$actual"
    exit 1
  fi
  echo "ASSERT_EQ_OK $expected"
}

echo "== HEALTH =="
curl -fsS "$API/health" >/dev/null
echo HEALTH_OK

REQ="$(curl -fsS -X POST "$API/auth/magic/request" \
  -H 'content-type: application/json' \
  -d '{"email":"owner@example.com"}')"
CODE="$(printf '%s' "$REQ" | json_get devCode)"
[ -n "$CODE" ] || { echo "TOKEN_CODE_MISSING"; exit 1; }

VERIFY="$(curl -fsS -X POST "$API/auth/magic/verify" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"owner@example.com\",\"code\":\"$CODE\"}")"
TOKEN="$(printf '%s' "$VERIFY" | json_get accessToken)"
[ -n "$TOKEN" ] || { echo "TOKEN_MISSING"; exit 1; }
echo TOKEN_OK

UNIQ="$(date +%s)"

echo
echo "== CREATE TEMP SERVICE =="
SERVICE_CREATE="$(curl -fsS -X POST "$API/services" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{
    \"businessId\":\"$BUSINESS_ID\",
    \"name\":\"contract-hot-path-$UNIQ\",
    \"durationMin\":60,
    \"priceCents\":6000,
    \"currency\":\"EUR\",
    \"bufferBeforeMin\":0,
    \"bufferAfterMin\":0,
    \"onlineBookingEnabled\":true
  }")"
printf '%s\n' "$SERVICE_CREATE"
SERVICE_ID="$(printf '%s' "$SERVICE_CREATE" | json_get id)"
[ -n "$SERVICE_ID" ] || exit 1

echo
echo "== CREATE VARIANT =="
VARIANT_CREATE="$(curl -fsS -X POST "$API/services/$SERVICE_ID/variants" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "name":"contract-variant",
    "durationMin":80,
    "priceCents":8000,
    "bufferBeforeMin":0,
    "bufferAfterMin":0,
    "onlineBookingEnabled":true
  }')"
printf '%s\n' "$VARIANT_CREATE"
VARIANT_ID="$(printf '%s' "$VARIANT_CREATE" | json_get id)"
[ -n "$VARIANT_ID" ] || exit 1

echo
echo "== CREATE ADDON =="
ADDON_CREATE="$(curl -fsS -X POST "$API/services/$SERVICE_ID/addons" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "name":"contract-addon",
    "durationMin":15,
    "priceCents":500,
    "bufferBeforeMin":0,
    "bufferAfterMin":5,
    "onlineBookingEnabled":true
  }')"
printf '%s\n' "$ADDON_CREATE"
ADDON_ID="$(printf '%s' "$ADDON_CREATE" | json_get id)"
[ -n "$ADDON_ID" ] || exit 1

echo
echo "== PRESERVE STAFF ASSIGNMENTS + APPLY OVERRIDE =="
CURRENT_ASSIGNMENTS="$(curl -fsS "$API/staff/$STAFF_ID/services?businessId=$BUSINESS_ID" \
  -H "authorization: Bearer $TOKEN")"

REPLACE_PAYLOAD="$(
  CURRENT_ASSIGNMENTS="$CURRENT_ASSIGNMENTS" \
  BUSINESS_ID="$BUSINESS_ID" \
  SERVICE_ID="$SERVICE_ID" \
  node <<'NODE'
const current = JSON.parse(process.env.CURRENT_ASSIGNMENTS || '[]');
const businessId = process.env.BUSINESS_ID;
const serviceId = process.env.SERVICE_ID;

const items = current.map((row) => ({
  serviceId: row.serviceId,
  isActive: row.isActive,
  onlineBookingEnabled: row.onlineBookingEnabled,
  durationMinOverride: row.durationMinOverride,
  priceCentsOverride: row.priceCentsOverride,
  bufferBeforeMinOverride: row.bufferBeforeMinOverride,
  bufferAfterMinOverride: row.bufferAfterMinOverride,
}));

const override = {
  serviceId,
  isActive: true,
  onlineBookingEnabled: true,
  durationMinOverride: 70,
  priceCentsOverride: 7000,
  bufferBeforeMinOverride: 5,
  bufferAfterMinOverride: 0,
};

const idx = items.findIndex((x) => x.serviceId === serviceId);
if (idx >= 0) items[idx] = { ...items[idx], ...override };
else items.push(override);

process.stdout.write(JSON.stringify({ businessId, items }));
NODE
)"

ASSIGN_RES="$(curl -fsS -X PUT "$API/staff/$STAFF_ID/services" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "$REPLACE_PAYLOAD")"
printf '%s\n' "$ASSIGN_RES" >/dev/null
echo STAFF_ASSIGNMENT_OK

echo
echo "== PICK AVAILABLE DAY + SLOTS =="
PICKED_DATE=""
START_AT=""
NEW_START_AT=""
AVAIL_BEFORE=""
for offset in $(seq 0 14); do
  DAY="$(date -u -d "$BASE_DATE +$offset day" +%F)"
  AVAIL="$(availability_with_retry "$API/availability?businessId=$BUSINESS_ID&serviceId=$SERVICE_ID&variantId=$VARIANT_ID&addonIds=$ADDON_ID&staffId=$STAFF_ID&date=$DAY&tz=Europe/Paris")"
  SLOT1="$(printf '%s' "$AVAIL" | slot_at 0)"
  SLOT2="$(printf '%s' "$AVAIL" | slot_at 1)"
  if [ -n "$SLOT1" ] && [ -n "$SLOT2" ]; then
    PICKED_DATE="$DAY"
    START_AT="$SLOT1"
    NEW_START_AT="$SLOT2"
    AVAIL_BEFORE="$AVAIL"
    break
  fi
done

[ -n "$PICKED_DATE" ] || { echo "NO_SLOT_FOUND_IN_15D_WINDOW"; exit 1; }
printf '%s\n' "$AVAIL_BEFORE"
echo "DATE_YMD=$PICKED_DATE"
echo "START_AT=$START_AT"
echo "NEW_START_AT=$NEW_START_AT"

TOTAL_MIN_BEFORE="$(printf '%s' "$AVAIL_BEFORE" | json_get 'results.0.totalMin')"
assert_eq "$TOTAL_MIN_BEFORE" "95"

echo
echo "== CREATE BOOKING WITH VARIANT + ADDON =="
CREATE_RES="$(curl -fsS -X POST "$API/bookings" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{
    \"businessId\":\"$BUSINESS_ID\",
    \"staffId\":\"$STAFF_ID\",
    \"serviceId\":\"$SERVICE_ID\",
    \"variantId\":\"$VARIANT_ID\",
    \"addonIds\":[\"$ADDON_ID\"],
    \"startAt\":\"$START_AT\",
    \"idempotencyKey\":\"contract-hot-path-create-$UNIQ\"
  }")"
printf '%s\n' "$CREATE_RES"
BOOKING_ID="$(printf '%s' "$CREATE_RES" | json_get id)"
CREATE_END="$(printf '%s' "$CREATE_RES" | json_get endAt)"
CREATE_TOTAL="$(printf '%s' "$CREATE_RES" | json_get totalMinSnapshot)"
CREATE_VARIANT="$(printf '%s' "$CREATE_RES" | json_get serviceVariantId)"
CREATE_SERVICE_NAME="$(printf '%s' "$CREATE_RES" | json_get serviceNameSnapshot)"
CREATE_PRICE="$(printf '%s' "$CREATE_RES" | json_get priceCentsSnapshot)"
EXPECTED_CREATE_END="$(add_minutes_utc "$START_AT" "95")"

assert_eq "$CREATE_VARIANT" "$VARIANT_ID"
assert_eq "$CREATE_TOTAL" "95"
assert_eq "$CREATE_END" "$EXPECTED_CREATE_END"
assert_eq "$CREATE_SERVICE_NAME" "contract-hot-path-$UNIQ"
assert_eq "$CREATE_PRICE" "7500"

echo
echo "== MUTATE LIVE CONFIG AFTER CREATE =="
PATCH_VARIANT="$(curl -fsS -X PATCH "$API/services/$SERVICE_ID/variants/$VARIANT_ID" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "durationMin":10,
    "priceCents":100,
    "bufferBeforeMin":0,
    "bufferAfterMin":0
  }')"
printf '%s\n' "$PATCH_VARIANT" >/dev/null

PATCH_ADDON="$(curl -fsS -X PATCH "$API/services/$SERVICE_ID/addons/$ADDON_ID" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "durationMin":0,
    "priceCents":0,
    "bufferBeforeMin":0,
    "bufferAfterMin":0
  }')"
printf '%s\n' "$PATCH_ADDON" >/dev/null
echo LIVE_CONFIG_MUTATION_OK

echo
echo "== RESCHEDULE MUST KEEP SNAPSHOT =="
RESCHEDULE_RES="$(curl -fsS -X POST "$API/bookings/$BOOKING_ID/reschedule" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{
    \"businessId\":\"$BUSINESS_ID\",
    \"newStartAt\":\"$NEW_START_AT\",
    \"idempotencyKey\":\"contract-hot-path-reschedule-$UNIQ\"
  }")"
printf '%s\n' "$RESCHEDULE_RES"

RESCHEDULE_END="$(printf '%s' "$RESCHEDULE_RES" | json_get endAt)"
RESCHEDULE_TOTAL="$(printf '%s' "$RESCHEDULE_RES" | json_get totalMinSnapshot)"
EXPECTED_RESCHEDULE_END="$(add_minutes_utc "$NEW_START_AT" "95")"
assert_eq "$RESCHEDULE_TOTAL" "95"
assert_eq "$RESCHEDULE_END" "$EXPECTED_RESCHEDULE_END"

echo
echo "== CLEANUP TEMP SERVICE =="
ARCHIVE_RES="$(curl -fsS -X PATCH "$API/services/$SERVICE_ID" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"active":false,"onlineBookingEnabled":false}')"
printf '%s\n' "$ARCHIVE_RES" >/dev/null
echo TEMP_SERVICE_ARCHIVED_OK

echo
echo "SERVICE_STACK_HOT_PATH_SMOKE_OK"
