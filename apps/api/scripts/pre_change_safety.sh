#!/usr/bin/env bash
set -euo pipefail

cd ~/code/plantak/apps/api

STAMP=$(date +%s)
mkdir -p _pre_change_backups/$STAMP

cp -f src/bookings/bookings.controller.ts "_pre_change_backups/$STAMP/bookings.controller.snapshot.ts"
cp -f src/bookings/bookings.service.ts "_pre_change_backups/$STAMP/bookings.service.snapshot.ts"

echo "Backup created: _pre_change_backups/$STAMP"

npm run build >/tmp/pre_change_build.log 2>&1 || {
  echo
  echo "BUILD_FAIL"
  tail -n 120 /tmp/pre_change_build.log
  exit 1
}

echo
echo "BUILD_OK"
