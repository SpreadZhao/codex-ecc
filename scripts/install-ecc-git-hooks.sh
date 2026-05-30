#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-$ROOT}"

usage() {
  cat <<'EOF'
Usage: scripts/install-ecc-git-hooks.sh [repo-dir]

Install workspace-local ECC Codex git hooks into one Git repository. This does
not modify global git config or ~/.codex.

Environment:
  ECC_FORCE_GIT_HOOKS=1  overwrite existing non-ECC hooks
EOF
}

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
esac

TARGET="$(cd "$TARGET" && pwd)"
HOOKS_SRC="$ROOT/.codex/git-hooks"

if [ ! -d "$HOOKS_SRC" ]; then
  echo "Missing .codex/git-hooks. Run scripts/sync-ecc.sh --force first." >&2
  exit 1
fi

if ! git -C "$TARGET" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Not a Git repository: $TARGET" >&2
  exit 1
fi

GIT_DIR="$(git -C "$TARGET" rev-parse --git-dir)"
case "$GIT_DIR" in
  /*) ;;
  *) GIT_DIR="$TARGET/$GIT_DIR" ;;
esac

install_hook() {
  local name="$1"
  local source="$HOOKS_SRC/$name"
  local target="$GIT_DIR/hooks/$name"

  if [ ! -f "$source" ]; then
    echo "Missing hook source: ${source#$ROOT/}" >&2
    exit 1
  fi

  mkdir -p "$GIT_DIR/hooks"
  if [ -e "$target" ] && ! cmp -s "$source" "$target"; then
    if [ "${ECC_FORCE_GIT_HOOKS:-0}" != "1" ]; then
      echo "Refusing to overwrite existing hook: $target" >&2
      echo "Set ECC_FORCE_GIT_HOOKS=1 to overwrite." >&2
      exit 1
    fi
  fi

  install -m 0755 "$source" "$target"
  echo "installed: $target"
}

install_hook pre-commit
install_hook pre-push
