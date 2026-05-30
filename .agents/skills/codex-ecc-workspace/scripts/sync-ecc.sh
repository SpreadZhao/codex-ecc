#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FORCE=0
UPDATE_LOCK=0
PRUNE=0
MINIMAL=0

usage() {
  cat <<'EOF'
Usage: scripts/sync-ecc.sh [--update-lock] [--force] [--prune] [--minimal]

Update workspace-local ECC assets without writing ~/.codex. By default this
syncs the full ECC runtime mirror and all upstream skills into the workspace.

Options:
  --update-lock  update only the ecc-src flake input before copying
  --force        overwrite existing copied files
  --prune        remove copied ECC runtime/config/skills/prompts before copying
  --minimal      copy only the small Codex reference surface
  -h, --help     show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --update-lock) UPDATE_LOCK=1 ;;
    --force) FORCE=1 ;;
    --prune) PRUNE=1 ;;
    --minimal) MINIMAL=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done

if [ ! -f "$ROOT/flake.nix" ]; then
  echo "Run this from a Codex ECC workspace root containing flake.nix" >&2
  exit 1
fi

if [ "$UPDATE_LOCK" -eq 1 ]; then
  nix flake update ecc-src
fi

if [ "$PRUNE" -eq 1 ]; then
  rm -rf "$ROOT/.codex" "$ROOT/.agents/skills" "$ROOT/.ecc/source" "$ROOT/AGENTS.ecc.md"
fi

mkdir -p "$ROOT/.codex" "$ROOT/.agents/skills" "$ROOT/.ecc"

if command -v direnv >/dev/null 2>&1; then
  ECC_PATH="$(direnv exec "$ROOT" printenv ECC_SRC)"
else
  ECC_PATH="${ECC_SRC:-}"
fi

if [ -z "$ECC_PATH" ] || [ ! -d "$ECC_PATH" ]; then
  echo "Could not resolve ECC_SRC. Run direnv allow or enter the Nix dev shell." >&2
  exit 1
fi

if [ ! -x "$ROOT/scripts/init-ecc-workspace.sh" ]; then
  echo "Missing executable scripts/init-ecc-workspace.sh" >&2
  exit 1
fi

ARGS=()
if [ "$FORCE" -eq 1 ]; then
  ARGS+=(--force)
fi
if [ "$MINIMAL" -eq 1 ]; then
  ARGS+=(--minimal)
fi

ECC_SRC="$ECC_PATH" "$ROOT/scripts/init-ecc-workspace.sh" "${ARGS[@]}"

echo "ECC source: $ECC_PATH"
echo "ECC workspace assets synced."
