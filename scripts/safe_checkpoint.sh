#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STAMP="$(date +%Y%m%d-%H%M%S)"
NAME="${1:-backend-checkpoint}"
SAFE_NAME="$(echo "$NAME" | tr ' /' '__')"
OUT_DIR="$ROOT/_repo_backups/$STAMP-$SAFE_NAME"

mkdir -p "$OUT_DIR"

echo "== PRECHECK =="
git status --short | tee "$OUT_DIR/GIT_STATUS.txt"
echo

echo "== FSCK BEFORE =="
git fsck --full | tee "$OUT_DIR/FSCK.txt"
echo

echo "== HEAD =="
git rev-parse HEAD | tee "$OUT_DIR/HEAD.txt"
git show --stat --name-status --oneline HEAD > "$OUT_DIR/HEAD_SUMMARY.txt"
echo

echo "== SAVE DIRTY STATE =="
git diff > "$OUT_DIR/WORKTREE.diff" || true
git diff --cached > "$OUT_DIR/INDEX.diff" || true

git ls-files --others --exclude-standard | grep -v '^_repo_backups/' > "$OUT_DIR/UNTRACKED_FILES.txt" || true

if [ -s "$OUT_DIR/UNTRACKED_FILES.txt" ]; then
  tar -czf "$OUT_DIR/untracked.tar.gz" -T "$OUT_DIR/UNTRACKED_FILES.txt"
fi
echo

echo "== TAG =="
TAG_NAME="backup/$STAMP-$SAFE_NAME"
git tag -a "$TAG_NAME" -m "Checkpoint: $NAME ($STAMP)"
echo "$TAG_NAME" | tee "$OUT_DIR/TAG.txt"
echo

echo "== BUNDLE =="
git bundle create "$OUT_DIR/repo.bundle" --all
git bundle verify "$OUT_DIR/repo.bundle" | tee "$OUT_DIR/BUNDLE_VERIFY.txt"
echo

echo "== ARCHIVE =="
git archive --format=tar.gz --output="$OUT_DIR/source.tar.gz" HEAD
sha256sum "$OUT_DIR/repo.bundle" "$OUT_DIR/source.tar.gz" "$OUT_DIR/WORKTREE.diff" "$OUT_DIR/INDEX.diff" | tee "$OUT_DIR/SHA256SUMS.txt"

if [ -f "$OUT_DIR/untracked.tar.gz" ]; then
  sha256sum "$OUT_DIR/untracked.tar.gz" >> "$OUT_DIR/SHA256SUMS.txt"
fi
echo

echo "== RESTORE TEST =="
git clone "$OUT_DIR/repo.bundle" "$OUT_DIR/restore-test" >/dev/null 2>&1
git -C "$OUT_DIR/restore-test" fsck --full > "$OUT_DIR/RESTORE_FSCK.txt"
git -C "$OUT_DIR/restore-test" rev-parse HEAD | tee "$OUT_DIR/RESTORE_HEAD.txt"
echo

echo "== DONE =="
echo "Backup directory: $OUT_DIR"
echo "Tag: $TAG_NAME"
