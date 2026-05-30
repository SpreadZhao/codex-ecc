#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  cat <<'EOF'
Usage: scripts/sync-workspace-instance.sh [--no-update-lock] <name|instance-path>

Refresh one local .workspaces instance from the template root. By default this
updates the instance ECC source lock and syncs latest ECC assets.

Options:
  --no-update-lock  sync using the instance-pinned ECC lock
  --list            list available .workspaces instances
  -h, --help        show this help
EOF
}

UPDATE_LOCK=1
LIST=0
TARGET_ARG=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-update-lock)
      UPDATE_LOCK=0
      ;;
    --list)
      LIST=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      usage >&2
      exit 2
      ;;
    *)
      if [ -n "$TARGET_ARG" ]; then
        usage >&2
        exit 2
      fi
      TARGET_ARG="$1"
      ;;
  esac
  shift
done

if [ "$LIST" -eq 1 ]; then
  if [ -d "$ROOT/.workspaces" ]; then
    find "$ROOT/.workspaces" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort
  fi
  exit 0
fi

[ -n "$TARGET_ARG" ] || {
  usage >&2
  exit 2
}

case "$TARGET_ARG" in
  /*|*/*)
    INSTANCE="$TARGET_ARG"
    ;;
  ""|.*)
    echo "Invalid instance name: $TARGET_ARG" >&2
    exit 2
    ;;
  *)
    if ! printf '%s\n' "$TARGET_ARG" | grep -Eq '^[A-Za-z0-9._-]+$'; then
      echo "Instance name may only contain letters, numbers, dot, underscore, and dash: $TARGET_ARG" >&2
      exit 2
    fi
    INSTANCE="$ROOT/.workspaces/$TARGET_ARG"
    ;;
esac

[ -d "$INSTANCE" ] || {
  echo "Instance does not exist: $INSTANCE" >&2
  exit 1
}
[ -x "$INSTANCE/scripts/sync-ecc.sh" ] || {
  echo "Instance is missing scripts/sync-ecc.sh: $INSTANCE" >&2
  exit 1
}

ARGS=(--force)
if [ "$UPDATE_LOCK" -eq 1 ]; then
  ARGS=(--update-lock "${ARGS[@]}")
fi

(
  cd "$INSTANCE"
  "$INSTANCE/scripts/sync-ecc.sh" "${ARGS[@]}"
)

if [ -x "$INSTANCE/scripts/codex-ecc-doctor.js" ]; then
  (
    cd "$INSTANCE"
    scripts/codex-ecc-doctor.js
  )
fi
