#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCK_FILE="$ROOT/ecc-source.lock.json"
CHECKOUT_DIR="$ROOT/.ecc/upstream/ECC"
UPDATE_LOCK=0

usage() {
  cat <<'EOF'
Usage: scripts/resolve-ecc-source.sh [--update-lock]

Resolve the workspace-local ECC source checkout without Nix. The resolver uses
ecc-source.lock.json for reproducible refreshes and stores the Git checkout
under .ecc/upstream/ECC.

Options:
  --update-lock  fetch the configured ref and update ecc-source.lock.json
  -h, --help     show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --update-lock)
      UPDATE_LOCK=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
  shift
done

command -v git >/dev/null 2>&1 || {
  echo "git is required to resolve ECC source without Nix" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || {
  echo "node >=18 is required to resolve ECC source without Nix" >&2
  exit 1
}

if [ ! -f "$LOCK_FILE" ]; then
  cat > "$LOCK_FILE" <<'EOF'
{
  "repo": "https://github.com/affaan-m/ECC.git",
  "ref": "main",
  "rev": "",
  "updated_at": ""
}
EOF
fi

read_lock_field() {
  node -e '
    const fs = require("fs");
    const lock = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(lock[process.argv[2]] || ""));
  ' "$LOCK_FILE" "$1"
}

REPO="$(read_lock_field repo)"
REF="$(read_lock_field ref)"
REV="$(read_lock_field rev)"

[ -n "$REPO" ] || {
  echo "ecc-source.lock.json is missing repo" >&2
  exit 1
}
[ -n "$REF" ] || REF="main"

mkdir -p "$(dirname "$CHECKOUT_DIR")"
if [ ! -d "$CHECKOUT_DIR/.git" ]; then
  git clone "$REPO" "$CHECKOUT_DIR" >&2
else
  current_origin="$(git -C "$CHECKOUT_DIR" remote get-url origin 2>/dev/null || true)"
  if [ "$current_origin" != "$REPO" ]; then
    git -C "$CHECKOUT_DIR" remote set-url origin "$REPO"
  fi
fi

if [ "$UPDATE_LOCK" -eq 1 ]; then
  git -C "$CHECKOUT_DIR" fetch origin "$REF" >&2
  REV="$(git -C "$CHECKOUT_DIR" rev-parse FETCH_HEAD)"
  UPDATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  REPO="$REPO" REF="$REF" REV="$REV" UPDATED_AT="$UPDATED_AT" node - "$LOCK_FILE" <<'NODE'
'use strict';

const fs = require('fs');
const lockPath = process.argv[2];
const lock = {
  repo: process.env.REPO,
  ref: process.env.REF,
  rev: process.env.REV,
  updated_at: process.env.UPDATED_AT,
};

fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
NODE
elif [ -z "$REV" ]; then
  echo "ecc-source.lock.json has no rev. Run scripts/resolve-ecc-source.sh --update-lock first." >&2
  exit 1
else
  git -C "$CHECKOUT_DIR" cat-file -e "$REV^{commit}" 2>/dev/null \
    || git -C "$CHECKOUT_DIR" fetch origin "$REV" >&2 \
    || git -C "$CHECKOUT_DIR" fetch origin "$REF" >&2
fi

git -C "$CHECKOUT_DIR" checkout --detach "$REV" >&2
printf '%s\n' "$CHECKOUT_DIR"
