#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ORIGINAL_ARGS=("$@")
ROOT_PARENT="$(dirname "$ROOT")"
FLAKE_REF="$ROOT"
if [ "$(basename "$ROOT_PARENT")" = ".workspaces" ]; then
  case ":${GIT_CEILING_DIRECTORIES:-}:" in
    *":$ROOT_PARENT:"*) ;;
    *) export GIT_CEILING_DIRECTORIES="$ROOT_PARENT${GIT_CEILING_DIRECTORIES:+:$GIT_CEILING_DIRECTORIES}" ;;
  esac
  FLAKE_REF="path:$ROOT"
fi
FORCE=0
UPDATE_LOCK=0
PRUNE=0
MINIMAL=0
SOURCE_MODE="${CODEX_ECC_SYNC_MODE:-auto}"

usage() {
  cat <<'EOF'
Usage: scripts/sync-ecc.sh [--update-lock] [--force] [--prune] [--minimal] [--source-mode auto|nix|git]

Update workspace-local ECC assets without writing ~/.codex. By default this
syncs the full ECC runtime mirror and all upstream skills into the workspace.

Options:
  --update-lock       update the ECC source lock before copying
  --force             overwrite existing copied files
  --prune             remove copied ECC runtime/config/skills/prompts before copying
  --minimal           copy only the small Codex reference surface
  --source-mode MODE  source resolver: auto, nix, or git
  --portable          alias for --source-mode git
  --nix               alias for --source-mode nix
  -h, --help          show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --update-lock) UPDATE_LOCK=1 ;;
    --force) FORCE=1 ;;
    --prune) PRUNE=1 ;;
    --minimal) MINIMAL=1 ;;
    --source-mode)
      SOURCE_MODE="${2:-}"
      [ -n "$SOURCE_MODE" ] || {
        usage >&2
        exit 2
      }
      shift
      ;;
    --portable) SOURCE_MODE="git" ;;
    --nix) SOURCE_MODE="nix" ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done

case "$SOURCE_MODE" in
  auto|nix|git) ;;
  *)
    echo "Invalid --source-mode: $SOURCE_MODE" >&2
    exit 2
    ;;
esac

if [ "$PRUNE" -eq 1 ]; then
  rm -rf "$ROOT/.codex" "$ROOT/.agents/skills" "$ROOT/.ecc/source" "$ROOT/AGENTS.ecc.md"
fi

mkdir -p "$ROOT/.codex" "$ROOT/.agents/skills" "$ROOT/.ecc"
RESOLVED_ECC_PATH=""

is_nix_store_path() {
  case "$1" in
    /nix/store/*) return 0 ;;
    *) return 1 ;;
  esac
}

resolve_nix_ecc_path() {
  local path=""

  if [ ! -f "$ROOT/flake.nix" ]; then
    return 1
  fi

  if [ -n "${ECC_SRC:-}" ] && [ -d "$ECC_SRC" ]; then
    path="$ECC_SRC"
  elif command -v direnv >/dev/null 2>&1; then
    path="$(direnv exec "$ROOT" printenv ECC_SRC 2>/dev/null || true)"
  fi

  if [ "$SOURCE_MODE" = "auto" ] && ! is_nix_store_path "$path"; then
    return 1
  fi

  if [ "$UPDATE_LOCK" -eq 1 ] && [ "${CODEX_ECC_SYNC_LOCK_UPDATED:-0}" != "1" ]; then
    command -v nix >/dev/null 2>&1 || return 1
    nix flake update ecc-src --flake "$FLAKE_REF"
    export CODEX_ECC_SYNC_LOCK_UPDATED=1
    if [ "${CODEX_ECC_SYNC_NIX_DEVELOP:-0}" != "1" ]; then
      exec env \
        CODEX_ECC_SYNC_MODE=nix \
        CODEX_ECC_SYNC_NIX_DEVELOP=1 \
        CODEX_ECC_SYNC_LOCK_UPDATED=1 \
        nix develop "$FLAKE_REF" --command "$0" "${ORIGINAL_ARGS[@]}"
    fi
  fi

  if [ -n "$path" ] && [ -d "$path" ]; then
    RESOLVED_ECC_PATH="$path"
    return 0
  fi

  if [ "$SOURCE_MODE" = "nix" ] \
    && command -v nix >/dev/null 2>&1 \
    && [ "${CODEX_ECC_SYNC_NIX_DEVELOP:-0}" != "1" ]; then
    exec env \
      CODEX_ECC_SYNC_MODE=nix \
      CODEX_ECC_SYNC_NIX_DEVELOP=1 \
      CODEX_ECC_SYNC_LOCK_UPDATED="${CODEX_ECC_SYNC_LOCK_UPDATED:-0}" \
      nix develop "$FLAKE_REF" --command "$0" "${ORIGINAL_ARGS[@]}"
  fi

  return 1
}

resolve_git_ecc_path() {
  local args=()
  if [ "$UPDATE_LOCK" -eq 1 ]; then
    args+=(--update-lock)
  fi

  [ -x "$ROOT/scripts/resolve-ecc-source.sh" ] || {
    echo "Missing executable scripts/resolve-ecc-source.sh" >&2
    return 1
  }

  "$ROOT/scripts/resolve-ecc-source.sh" "${args[@]}"
}

ECC_PATH=""
if [ "$SOURCE_MODE" = "nix" ]; then
  resolve_nix_ecc_path || {
    echo "Could not resolve ECC_SRC through Nix. Run direnv allow or use --source-mode git." >&2
    exit 1
  }
  ECC_PATH="$RESOLVED_ECC_PATH"
elif [ "$SOURCE_MODE" = "git" ]; then
  ECC_PATH="$(resolve_git_ecc_path)"
else
  if resolve_nix_ecc_path; then
    ECC_PATH="$RESOLVED_ECC_PATH"
    :
  else
    ECC_PATH="$(resolve_git_ecc_path)"
  fi
fi

if [ -z "$ECC_PATH" ] || [ ! -d "$ECC_PATH" ]; then
  echo "Could not resolve ECC source. Use Nix/direnv or run scripts/sync-ecc.sh --source-mode git." >&2
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
