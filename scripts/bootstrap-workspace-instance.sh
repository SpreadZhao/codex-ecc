#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  cat <<'EOF'
Usage: scripts/bootstrap-workspace-instance.sh [--no-sync] [--no-update-lock] <name|target-dir>

Create a local business workspace instance from this reusable Codex ECC
template. A simple name is created under .workspaces/<name>, which is ignored
by the template repository. The generated instance is its own Git repository
and can track repos.yaml, child repository routing, and local workspace state
without dirtying the template.

By default this creates the instance, updates the instance ecc-src flake lock,
and syncs the latest ECC assets into the instance.

Options:
  --no-sync        create the instance without running scripts/sync-ecc.sh
  --no-update-lock sync using the template-pinned ECC lock instead of latest
  --sync           accepted for backwards compatibility; sync is now default
  --update-lock    accepted for backwards compatibility; update is now default
  -h, --help       show this help
EOF
}

SYNC=1
UPDATE_LOCK=1
TARGET_ARG=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --sync)
      SYNC=1
      ;;
    --no-sync)
      SYNC=0
      ;;
    --update-lock)
      UPDATE_LOCK=1
      ;;
    --no-update-lock)
      UPDATE_LOCK=0
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

if [ -z "$TARGET_ARG" ]; then
  usage >&2
  exit 2
fi

case "$TARGET_ARG" in
  /*|*/*)
    TARGET="$TARGET_ARG"
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
    TARGET="$ROOT/.workspaces/$TARGET_ARG"
    ;;
esac

CREATE_SCRIPT="$ROOT/.agents/skills/codex-ecc-workspace/scripts/create-workspace.sh"
if [ ! -x "$CREATE_SCRIPT" ]; then
  echo "Missing executable $CREATE_SCRIPT" >&2
  exit 1
fi

if [ -e "$TARGET" ] && [ -n "$(find "$TARGET" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null || true)" ]; then
  echo "Target already exists and is not empty: $TARGET" >&2
  exit 1
fi

mkdir -p "$(dirname "$TARGET")"
"$CREATE_SCRIPT" "$TARGET"

INSTANCE_ROOT="$(cd "$TARGET" && pwd)"
rm -f "$INSTANCE_ROOT/.codex-ecc-template"
mkdir -p "$INSTANCE_ROOT/.ecc/state/bootstrap"

cat > "$INSTANCE_ROOT/.ecc/state/bootstrap/source-template.json" <<EOF
{
  "source_template": "$ROOT",
  "instance_root": "$INSTANCE_ROOT",
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

if [ "$SYNC" -eq 1 ]; then
  SYNC_ARGS=(--force)
  if [ "$UPDATE_LOCK" -eq 1 ]; then
    SYNC_ARGS=(--update-lock "${SYNC_ARGS[@]}")
  fi

  (
    cd "$INSTANCE_ROOT"
    "$INSTANCE_ROOT/scripts/sync-ecc.sh" "${SYNC_ARGS[@]}"
  )
fi

cat <<EOF
Created Codex ECC workspace instance:
  $INSTANCE_ROOT

Next:
  cd "$INSTANCE_ROOT"
  direnv allow
  scripts/import-repo.sh <git-url-or-local-repo-path>
  codex
EOF
