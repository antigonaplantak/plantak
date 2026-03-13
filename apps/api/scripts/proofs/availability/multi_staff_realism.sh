#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../lib/availability_proof_lib.sh"

section "MULTI_STAFF_REALISM_PROOF"

TOKEN="$(auth_token)"
echo "TOKEN_OK"

TARGET_DATE="2026-04-06"   # Monday, away from DST edge dates
DAY_OF_WEEK=1
ORIG_STAFF_ID="${STAFF_ID}"

SEED_JSON="$(
  BUSINESS_ID="$BUSINESS_ID" BASE_SERVICE_ID="$BASE_SERVICE_ID" ORIG_STAFF_ID="$ORIG_STAFF_ID" node - <<'NODE'
const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const prisma = new PrismaClient();

(async () => {
  const businessId = process.env.BUSINESS_ID;
  const serviceId = process.env.BASE_SERVICE_ID;
  const origStaffId = process.env.ORIG_STAFF_ID;

  const existing = await prisma.staff.findMany({
    where: {
      businessId,
      active: true,
      serviceLinks: {
        some: {
          serviceId,
          isActive: true,
          onlineBookingEnabled: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });

  let secondStaffId = existing.find((x) => x.id !== origStaffId)?.id || null;
  let created = false;

  if (!secondStaffId) {
    secondStaffId = crypto.randomUUID();

    await prisma.staff.create({
      data: {
        id: secondStaffId,
        businessId,
        active: true,
        displayName: 'Proof Multi Staff',
      },
    });

    await prisma.serviceStaff.create({
      data: {
        serviceId,
        staffId: secondStaffId,
        isActive: true,
        onlineBookingEnabled: true,
      },
    });

    created = true;
  }

  const all = await prisma.staff.findMany({
    where: {
      businessId,
      active: true,
      id: { in: [origStaffId, secondStaffId] },
      serviceLinks: {
        some: {
          serviceId,
          isActive: true,
          onlineBookingEnabled: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });

  console.log(JSON.stringify({
    created,
    firstStaffId: origStaffId,
    secondStaffId,
    totalQualified: all.length,
  }));
})()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
NODE
)"

echo "$SEED_JSON"

FIRST_STAFF_ID="$(printf '%s' "$SEED_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["firstStaffId"])')"
SECOND_STAFF_ID="$(printf '%s' "$SEED_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["secondStaffId"])')"
TOTAL_QUALIFIED="$(printf '%s' "$SEED_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["totalQualified"])')"

[ "$TOTAL_QUALIFIED" -ge 2 ] || fail "MULTI_STAFF_TOTAL_LT_2"

FIRST_BAK="$(mktemp)"
SECOND_BAK="$(mktemp)"

backup_hours_for_staff() {
  local staff_id="$1"
  local out_file="$2"
  curl -fsS "$API/staff/$staff_id/working-hours?businessId=$BUSINESS_ID" \
    -H "authorization: Bearer $TOKEN" > "$out_file"
}

restore_hours_for_staff() {
  local staff_id="$1"
  local backup_file="$2"
  local payload_file
  payload_file="$(mktemp)"

  python3 - "$backup_file" "$BUSINESS_ID" > "$payload_file" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], "r", encoding="utf-8"))
business_id = sys.argv[2]
items = data.get("items") if isinstance(data, dict) else data
items = items or []
clean = []
for item in items:
    clean.append({
        "dayOfWeek": item["dayOfWeek"],
        "startMin": item["startMin"],
        "endMin": item["endMin"],
    })
print(json.dumps({"businessId": business_id, "items": clean}, separators=(",", ":")))
PY

  curl -fsS -X PUT "$API/staff/$staff_id/working-hours" \
    -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' \
    --data-binary @"$payload_file" >/dev/null

  rm -f "$payload_file"
}

set_single_window_hours_for_staff() {
  local staff_id="$1"
  local day_of_week="$2"
  local start_min="$3"
  local end_min="$4"

  curl -fsS -X PUT "$API/staff/$staff_id/working-hours" \
    -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' \
    -d "{\"businessId\":\"$BUSINESS_ID\",\"items\":[{\"dayOfWeek\":$day_of_week,\"startMin\":$start_min,\"endMin\":$end_min}]}" >/dev/null
}

cleanup() {
  restore_hours_for_staff "$FIRST_STAFF_ID" "$FIRST_BAK" >/dev/null 2>&1 || true
  restore_hours_for_staff "$SECOND_STAFF_ID" "$SECOND_BAK" >/dev/null 2>&1 || true
  rm -f "$FIRST_BAK" "$SECOND_BAK"
}
trap cleanup EXIT

backup_hours_for_staff "$FIRST_STAFF_ID" "$FIRST_BAK"
backup_hours_for_staff "$SECOND_STAFF_ID" "$SECOND_BAK"

# staff 1 morning window
set_single_window_hours_for_staff "$FIRST_STAFF_ID"  "$DAY_OF_WEEK" 540 720
# staff 2 afternoon window
set_single_window_hours_for_staff "$SECOND_STAFF_ID" "$DAY_OF_WEEK" 780 960

BODY="$(curl -fsS "$API/availability?businessId=$BUSINESS_ID&serviceId=$BASE_SERVICE_ID&date=$TARGET_DATE&tz=Europe/Paris&intervalMin=30")"
printf '%s\n' "$BODY"

BODY_JSON="$BODY" FIRST_STAFF_ID="$FIRST_STAFF_ID" SECOND_STAFF_ID="$SECOND_STAFF_ID" python3 - <<'PY'
import json, os, sys
from datetime import datetime
from zoneinfo import ZoneInfo

body = json.loads(os.environ["BODY_JSON"])
first_staff_id = os.environ["FIRST_STAFF_ID"]
second_staff_id = os.environ["SECOND_STAFF_ID"]
tz = ZoneInfo("Europe/Paris")

results = body.get("results") or []
if len(results) < 2:
    print("RESULT_COUNT_LT_2")
    sys.exit(1)

by_staff = {r["staffId"]: r for r in results}

if first_staff_id not in by_staff:
    print("FIRST_STAFF_RESULT_MISSING")
    sys.exit(1)

if second_staff_id not in by_staff:
    print("SECOND_STAFF_RESULT_MISSING")
    sys.exit(1)

first_slots = by_staff[first_staff_id].get("slots") or []
second_slots = by_staff[second_staff_id].get("slots") or []

if len(first_slots) < 2:
    print("FIRST_STAFF_SLOTS_LT_2")
    sys.exit(1)

if len(second_slots) < 2:
    print("SECOND_STAFF_SLOTS_LT_2")
    sys.exit(1)

def local_list(slots):
    return [
        datetime.fromisoformat(s["start"].replace("Z", "+00:00")).astimezone(tz).strftime("%Y-%m-%d %H:%M %z")
        for s in slots
    ]

first_local = local_list(first_slots)
second_local = local_list(second_slots)

print("FIRST_STAFF_LOCAL_SLOTS=")
for row in first_local:
    print(row)

print("SECOND_STAFF_LOCAL_SLOTS=")
for row in second_local:
    print(row)

if first_local == second_local:
    print("MULTI_STAFF_SLOT_SETS_IDENTICAL")
    sys.exit(1)

first_first = first_local[0]
second_first = second_local[0]

if not first_first.startswith("2026-04-06 09:00"):
    print("FIRST_STAFF_OPENING_UNEXPECTED", first_first)
    sys.exit(1)

if not second_first.startswith("2026-04-06 13:00"):
    print("SECOND_STAFF_OPENING_UNEXPECTED", second_first)
    sys.exit(1)

print("MULTI_STAFF_REALISM_PROOF_OK")
PY
