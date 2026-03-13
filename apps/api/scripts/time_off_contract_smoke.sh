#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

set -a
[ -f .env ] && . ./.env
[ -f .env.local ] && . ./.env.local
set +a

API="${API_URL:-http://localhost:3101/api}"
BUSINESS_ID="${BUSINESS_ID:-b1}"
STAFF_ID="${STAFF_ID:-b9b77322-1012-4860-af1b-5b53a6171d06}"
SERVICE_ID="${SERVICE_ID:-f37eca6e-8729-4a73-a498-028436514c1b}"
DATE_YMD="${DATE_YMD:-2026-07-07}"
TZ="${TZ_NAME:-Europe/Paris}"

BLOCK_START="${BLOCK_START:-2026-07-07T10:00:00.000Z}"
BLOCK_END="${BLOCK_END:-2026-07-07T11:00:00.000Z}"
MOVED_START="${MOVED_START:-2026-07-07T13:00:00.000Z}"
MOVED_END="${MOVED_END:-2026-07-07T14:00:00.000Z}"

echo "== HEALTH =="
curl -fsS "$API/health" >/dev/null
echo HEALTH_OK

TOKEN="$(
node - <<'NODE'
const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');

(async () => {
  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUnique({
      where: { email: 'owner@example.com' },
      select: { id: true, email: true, role: true },
    });
    if (!user) throw new Error('OWNER_USER_NOT_FOUND');

    const secret =
      process.env.JWT_ACCESS_SECRET ||
      process.env.JWT_SECRET ||
      process.env.JWT_SECRET_KEY;

    if (!secret) throw new Error('JWT_ACCESS_SECRET_MISSING');

    const ttl = Number(process.env.JWT_ACCESS_TTL_SECONDS || 15 * 60);

    const token = jwt.sign(
      { sub: user.id, email: user.email, role: user.role },
      secret,
      { expiresIn: ttl },
    );

    process.stdout.write(token);
  } catch (err) {
    console.error(err?.message || String(err));
    process.exit(1);
  }
})();
NODE
)"

[ -n "$TOKEN" ] || { echo "TOKEN_MISSING"; exit 1; }
echo TOKEN_OK

check_slot() {
  local file="$1"
  local slot="$2"
  local mode="$3"

  node - "$file" "$slot" "$mode" <<'NODE'
const fs = require('fs');

const [file, slot, mode] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const starts = (data.results || []).flatMap(r => (r.slots || []).map(s => s.start));
const has = starts.includes(slot);

if (mode === 'present' && !has) {
  console.error(`SLOT_EXPECTED_PRESENT_BUT_MISSING ${slot}`);
  process.exit(1);
}
if (mode === 'absent' && has) {
  console.error(`SLOT_EXPECTED_ABSENT_BUT_PRESENT ${slot}`);
  process.exit(1);
}
console.log(`SLOT_${mode.toUpperCase()}_OK ${slot}`);
NODE
}

echo
echo "== BASELINE AVAILABILITY =="
curl -fsS \
  "$API/availability?businessId=$BUSINESS_ID&serviceId=$SERVICE_ID&staffId=$STAFF_ID&date=$DATE_YMD&tz=$TZ" \
  > /tmp/timeoff_availability_before.json
check_slot /tmp/timeoff_availability_before.json "$BLOCK_START" present
check_slot /tmp/timeoff_availability_before.json "$MOVED_START" present

echo
echo "== INVALID RANGE CONTRACT =="
INVALID_RES="$(
  curl -sS -w '\nHTTP=%{http_code}\n' \
    -X POST "$API/staff/$STAFF_ID/time-off" \
    -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' \
    --data "{\"businessId\":\"$BUSINESS_ID\",\"startAt\":\"2026-07-07T12:00:00.000Z\",\"endAt\":\"2026-07-07T11:00:00.000Z\",\"reason\":\"invalid-range-proof\"}"
)"
printf '%s\n' "$INVALID_RES"
INVALID_HTTP="$(printf '%s\n' "$INVALID_RES" | sed -n '$s/^HTTP=//p')"
[ "$INVALID_HTTP" = "400" ] || { echo "TIME_OFF_INVALID_RANGE_CONTRACT_FAILED"; exit 1; }
echo TIME_OFF_INVALID_RANGE_CONTRACT_OK

echo
echo "== CREATE TIME OFF =="
CREATE_RES="$(
  curl -sS -w '\nHTTP=%{http_code}\n' \
    -X POST "$API/staff/$STAFF_ID/time-off" \
    -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' \
    --data "{\"businessId\":\"$BUSINESS_ID\",\"startAt\":\"$BLOCK_START\",\"endAt\":\"$BLOCK_END\",\"reason\":\"contract-proof-create\"}"
)"
printf '%s\n' "$CREATE_RES"
CREATE_HTTP="$(printf '%s\n' "$CREATE_RES" | sed -n '$s/^HTTP=//p')"
[ "$CREATE_HTTP" = "201" ] || { echo "TIME_OFF_CREATE_FAILED"; exit 1; }
printf '%s\n' "$CREATE_RES" | sed '$d' > /tmp/timeoff_create.json

TIME_OFF_ID="$(
node - <<'NODE'
const fs = require('fs');
const body = JSON.parse(fs.readFileSync('/tmp/timeoff_create.json', 'utf8'));
if (!body.id) process.exit(1);
process.stdout.write(body.id);
NODE
)"
[ -n "$TIME_OFF_ID" ] || { echo "TIME_OFF_ID_MISSING"; exit 1; }
echo "TIME_OFF_ID=$TIME_OFF_ID"

echo
echo "== LIST AFTER CREATE =="
curl -fsS \
  -H "authorization: Bearer $TOKEN" \
  "$API/staff/$STAFF_ID/time-off?businessId=$BUSINESS_ID" \
  > /tmp/timeoff_list_after_create.json

node - "$TIME_OFF_ID" <<'NODE'
const fs = require('fs');
const id = process.argv[2];
const rows = JSON.parse(fs.readFileSync('/tmp/timeoff_list_after_create.json', 'utf8'));
if (!Array.isArray(rows) || !rows.some(r => r.id === id)) {
  console.error('TIME_OFF_LIST_MISSING_CREATED_ROW');
  process.exit(1);
}
console.log('TIME_OFF_LIST_CREATE_OK');
NODE

echo
echo "== AVAILABILITY BLOCKED AFTER CREATE =="
curl -fsS \
  "$API/availability?businessId=$BUSINESS_ID&serviceId=$SERVICE_ID&staffId=$STAFF_ID&date=$DATE_YMD&tz=$TZ" \
  > /tmp/timeoff_availability_after_create.json
check_slot /tmp/timeoff_availability_after_create.json "$BLOCK_START" absent
check_slot /tmp/timeoff_availability_after_create.json "$MOVED_START" present

echo
echo "== UPDATE TIME OFF =="
UPDATE_RES="$(
  curl -sS -w '\nHTTP=%{http_code}\n' \
    -X PATCH "$API/staff/$STAFF_ID/time-off/$TIME_OFF_ID" \
    -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' \
    --data "{\"businessId\":\"$BUSINESS_ID\",\"startAt\":\"$MOVED_START\",\"endAt\":\"$MOVED_END\",\"reason\":\"contract-proof-update\"}"
)"
printf '%s\n' "$UPDATE_RES"
UPDATE_HTTP="$(printf '%s\n' "$UPDATE_RES" | sed -n '$s/^HTTP=//p')"
[ "$UPDATE_HTTP" = "200" ] || { echo "TIME_OFF_UPDATE_FAILED"; exit 1; }

echo
echo "== AVAILABILITY AFTER UPDATE =="
curl -fsS \
  "$API/availability?businessId=$BUSINESS_ID&serviceId=$SERVICE_ID&staffId=$STAFF_ID&date=$DATE_YMD&tz=$TZ" \
  > /tmp/timeoff_availability_after_update.json
check_slot /tmp/timeoff_availability_after_update.json "$BLOCK_START" present
check_slot /tmp/timeoff_availability_after_update.json "$MOVED_START" absent

echo
echo "== DELETE TIME OFF =="
DELETE_RES="$(
  curl -sS -w '\nHTTP=%{http_code}\n' \
    -X DELETE "$API/staff/$STAFF_ID/time-off/$TIME_OFF_ID?businessId=$BUSINESS_ID" \
    -H "authorization: Bearer $TOKEN"
)"
printf '%s\n' "$DELETE_RES"
DELETE_HTTP="$(printf '%s\n' "$DELETE_RES" | sed -n '$s/^HTTP=//p')"
[ "$DELETE_HTTP" = "200" ] || { echo "TIME_OFF_DELETE_FAILED"; exit 1; }

echo
echo "== AVAILABILITY UNBLOCKED AFTER DELETE =="
curl -fsS \
  "$API/availability?businessId=$BUSINESS_ID&serviceId=$SERVICE_ID&staffId=$STAFF_ID&date=$DATE_YMD&tz=$TZ" \
  > /tmp/timeoff_availability_after_delete.json
check_slot /tmp/timeoff_availability_after_delete.json "$BLOCK_START" present
check_slot /tmp/timeoff_availability_after_delete.json "$MOVED_START" present

echo
echo "TIME_OFF_CONTRACT_SMOKE_OK"
