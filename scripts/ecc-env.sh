#!/usr/bin/env bash
# Source this file from direnv or an interactive shell to use the workspace
# without Nix. It intentionally keeps all generated state local to the repo.

if [ -n "${BASH_SOURCE:-}" ]; then
  CODEX_ECC_ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
else
  CODEX_ECC_ENV_DIR="$(pwd)"
fi

export CODEX_ECC_WORKSPACE="$CODEX_ECC_ENV_DIR"
CODEX_ECC_PARENT_DIR="$(dirname "$CODEX_ECC_WORKSPACE")"
if [ "$(basename "$CODEX_ECC_PARENT_DIR")" = ".workspaces" ]; then
  case ":${GIT_CEILING_DIRECTORIES:-}:" in
    *":$CODEX_ECC_PARENT_DIR:"*) ;;
    *) export GIT_CEILING_DIRECTORIES="$CODEX_ECC_PARENT_DIR${GIT_CEILING_DIRECTORIES:+:$GIT_CEILING_DIRECTORIES}" ;;
  esac
fi

if [ -d "$CODEX_ECC_WORKSPACE/.ecc/source" ]; then
  export CODEX_ECC_RUNTIME="$CODEX_ECC_WORKSPACE/.ecc/source"
else
  export CODEX_ECC_RUNTIME="${CODEX_ECC_RUNTIME:-$CODEX_ECC_WORKSPACE/.ecc/source}"
fi

export ECC_SRC="${ECC_SRC:-$CODEX_ECC_RUNTIME}"
export CLAUDE_PLUGIN_ROOT="$CODEX_ECC_RUNTIME"
export ECC_PLUGIN_ROOT="$CODEX_ECC_RUNTIME"
export AGENTS_HOME="${AGENTS_HOME:-$CODEX_ECC_WORKSPACE/.agents}"
export CLV2_HOMUNCULUS_DIR="${CLV2_HOMUNCULUS_DIR:-$CODEX_ECC_WORKSPACE/.ecc/state/ecc-homunculus}"
export ECC_STATE_DIR="${ECC_STATE_DIR:-$CODEX_ECC_WORKSPACE/.ecc/state}"
export ECC_GLOBAL_HOOKS_DIR="${ECC_GLOBAL_HOOKS_DIR:-$CODEX_ECC_WORKSPACE/.codex/git-hooks}"

export NPM_CONFIG_PREFIX="${NPM_CONFIG_PREFIX:-$CODEX_ECC_WORKSPACE/.npm-global}"
export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$CODEX_ECC_WORKSPACE/.npm-cache}"
export npm_config_prefix="$NPM_CONFIG_PREFIX"
export npm_config_cache="$NPM_CONFIG_CACHE"

export CODEX_ECC_BIN="$CODEX_ECC_WORKSPACE/scripts/bin"
case ":$PATH:" in
  *":$CODEX_ECC_BIN:"*) ;;
  *) export PATH="$CODEX_ECC_BIN:$PATH" ;;
esac
case ":$PATH:" in
  *":$NPM_CONFIG_PREFIX/bin:"*) ;;
  *) export PATH="$NPM_CONFIG_PREFIX/bin:$PATH" ;;
esac

mkdir -p "$NPM_CONFIG_PREFIX/bin" "$NPM_CONFIG_CACHE" "$ECC_STATE_DIR" 2>/dev/null || true
