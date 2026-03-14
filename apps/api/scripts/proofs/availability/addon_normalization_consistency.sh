#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../lib/availability_proof_lib.sh"

section "ADDON_NORMALIZATION_CONSISTENCY_PROOF"

PROOF_TZ="Europe/Paris"
TARGET_DATE="2026-04-06"
DAY_OF_WEEK=1

WORKING_BAK="$(mktemp)"
VARIANT_ID=""
ADDON_A_ID=""
ADDON_B_ID=""

delete_existing_proof_variants() {
  local list ids
  list="$(curl -fsS "$API/services/$BASE_SERVICE_ID/variants" \
    -H "authorization: Bearer $TOKEN")"

  ids="$(
    VARIANT_LIST="$list" python3 - <<'PY'
import json, os
raw = os.environ["VARIANT_LIST"].strip()
data = json.loads(raw) if raw else []
if isinstance(data, dict):
    data = data.get("items") or []
for item in data:
    name = item.get("name") or ""
    if name.startswith("proof-norm-variant-"):
        print(item["id"])
PY
  )"

  if [ -n "${ids:-}" ]; then
    while IFS= read -r id; do
      [ -n "$id" ] || continue
      curl -fsS -X DELETE "$API/services/$BASE_SERVICE_ID/variants/$id" \
        -H "authorization: Bearer $TOKEN" >/dev/null || true
    done <<< "$ids"
  fi
}

delete_existing_proof_addons() {
  local list ids
  list="$(curl -fsS "$API/services/$BASE_SERVICE_ID/addons" \
    -H "authorization: Bearer $TOKEN")"

  ids="$(
    ADDON_LIST="$list" python3 - <<'PY'
import json, os
raw = os.environ["ADDON_LIST"].strip()
data = json.loads(raw) if raw else []
if isinstance(data, dict):
    data = data.get("items") or []
for item in data:
    name = item.get("name") or ""
    if name.startswith("proof-norm-addon-"):
        print(item["id"])
PY
  )"

  if [ -n "${ids:-}" ]; then
    while IFS= read -r id; do
      [ -n "$id" ] || continue
      curl -fsS -X DELETE "$API/services/$BASE_SERVICE_ID/addons/$id" \
        -H "authorization: Bearer $TOKEN" >/dev/null || true
    done <<< "$ids"
  fi
}

cleanup_proof_state() {
  delete_existing_proof_addons
  delete_existing_proof_variants
}

cleanup() {
  if [ -n "${ADDON_A_ID:-}" ]; then
    curl -fsS -X DELETE "$API/services/$BASE_SERVICE_ID/addons/$ADDON_A_ID" \
      -H "authorization: Bearer $TOKEN" >/dev/null 2>&1 || true
  fi

  if [ -n "${ADDON_B_ID:-}" ]; then
    curl -fsS -X DELETE "$API/services/$BASE_SERVICE_ID/addons/$ADDON_B_ID" \
      -H "authorization: Bearer $TOKEN" >/dev/null 2>&1 || true
  fi

  if [ -n "${VARIANT_ID:-}" ]; then
    curl -fsS -X DELETE "$API/services/$BASE_SERVICE_ID/variants/$VARIANT_ID" \
      -H "authorization: Bearer $TOKEN" >/dev/null 2>&1 || true
  fi

  cleanup_proof_state
  restore_working_hours "$WORKING_BAK" "$TOKEN" >/dev/null 2>&1 || true
  rm -f "$WORKING_BAK"
}
trap cleanup EXIT

TOKEN="$(auth_token)"
echo "TOKEN_OK"

cleanup_proof_state
backup_working_hours "$WORKING_BAK" "$TOKEN"
set_single_window_hours "$TOKEN" "$DAY_OF_WEEK" "09:00" "15:00"

echo "== CREATE TEMP VARIANT ON BASE SERVICE =="
VARIANT_RES="$(curl -fsS -X POST "$API/services/$BASE_SERVICE_ID/variants" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"name\":\"proof-norm-variant-$(date +%s)\",\"durationMin\":80,\"priceCents\":8000,\"bufferBeforeMin\":0,\"bufferAfterMin\":0,\"visibility\":\"PUBLIC\",\"onlineBookingEnabled\":true}")"
printf '%s\n' "$VARIANT_RES"
VARIANT_ID="$(printf '%s' "$VARIANT_RES" | json_get id)"

echo "== CREATE TEMP ADDON A ON BASE SERVICE =="
ADDON_A_RES="$(curl -fsS -X POST "$API/services/$BASE_SERVICE_ID/addons" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"name\":\"proof-norm-addon-a-$(date +%s)\",\"durationMin\":15,\"priceCents\":500,\"bufferBeforeMin\":0,\"bufferAfterMin\":5,\"visibility\":\"PUBLIC\",\"onlineBookingEnabled\":true}")"
printf '%s\n' "$ADDON_A_RES"
ADDON_A_ID="$(printf '%s' "$ADDON_A_RES" | json_get id)"

echo "== CREATE TEMP ADDON B ON BASE SERVICE =="
ADDON_B_RES="$(curl -fsS -X POST "$API/services/$BASE_SERVICE_ID/addons" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"name\":\"proof-norm-addon-b-$(date +%s)\",\"durationMin\":10,\"priceCents\":300,\"bufferBeforeMin\":5,\"bufferAfterMin\":0,\"visibility\":\"PUBLIC\",\"onlineBookingEnabled\":true}")"
printf '%s\n' "$ADDON_B_RES"
ADDON_B_ID="$(printf '%s' "$ADDON_B_RES" | json_get id)"

BASE_URL="$API/availability?businessId=$BUSINESS_ID&serviceId=$BASE_SERVICE_ID&variantId=$VARIANT_ID&staffId=$STAFF_ID&date=$TARGET_DATE&tz=$PROOF_TZ&intervalMin=15"

echo "== QUERY 1 repeated params ordered =="
BODY1="$(curl -fsS "${BASE_URL}&addonIds=${ADDON_A_ID}&addonIds=${ADDON_B_ID}")"
printf '%s\n' "$BODY1"

echo "== QUERY 2 comma reversed =="
BODY2="$(curl -fsS "${BASE_URL}&addonIds=${ADDON_B_ID},${ADDON_A_ID}")"
printf '%s\n' "$BODY2"

echo "== QUERY 3 duplicates mixed =="
BODY3="$(curl -fsS "${BASE_URL}&addonIds=${ADDON_A_ID},${ADDON_B_ID},${ADDON_A_ID}")"
printf '%s\n' "$BODY3"

BODY1="$BODY1" BODY2="$BODY2" BODY3="$BODY3" python3 - <<'PY'
import json, os

def parse(name):
    data = json.loads(os.environ[name])
    total = data.get("totalMin")
    slots = ((data.get("results") or [{}])[0].get("slots") or [])
    sig = [f'{slot["start"]}|{slot["end"]}' for slot in slots]
    return total, sig

t1, s1 = parse("BODY1")
t2, s2 = parse("BODY2")
t3, s3 = parse("BODY3")

print("TOTAL1=", t1)
print("TOTAL2=", t2)
print("TOTAL3=", t3)

if t1 != 115 or t2 != 115 or t3 != 115:
    raise SystemExit("TOTAL_MIN_MISMATCH")

if not s1 or not s2 or not s3:
    raise SystemExit("SIGNATURE_EMPTY")

if s1 != s2 or s1 != s3:
    print("SIG1=", s1)
    print("SIG2=", s2)
    print("SIG3=", s3)
    raise SystemExit("SIGNATURE_MISMATCH")

print("ADDON_NORMALIZATION_CONSISTENCY_PROOF_OK")
PY
