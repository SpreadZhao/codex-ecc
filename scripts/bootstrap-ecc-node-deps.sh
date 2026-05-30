#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ECC_RUNTIME="${CODEX_ECC_RUNTIME:-$ROOT/.ecc/source}"
if [ ! -d "$ECC_RUNTIME" ]; then
  ECC_RUNTIME="${ECC_SRC:-}"
fi

if [ -z "$ECC_RUNTIME" ] || [ ! -d "$ECC_RUNTIME" ]; then
  echo "Could not find ECC runtime. Run scripts/sync-ecc.sh --force first." >&2
  exit 1
fi

if [ ! -f "$ECC_RUNTIME/package-lock.json" ]; then
  echo "ECC runtime has no package-lock.json: $ECC_RUNTIME" >&2
  exit 1
fi

if [ -d "$ECC_RUNTIME/node_modules/ajv" ] && [ -d "$ECC_RUNTIME/node_modules/@iarna/toml" ]; then
  echo "ECC node dependencies already present: $ECC_RUNTIME/node_modules"
  exit 0
fi

export NPM_CONFIG_PREFIX="${NPM_CONFIG_PREFIX:-$ROOT/.npm-global}"
export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$ROOT/.npm-cache}"
export npm_config_prefix="$NPM_CONFIG_PREFIX"
export npm_config_cache="$NPM_CONFIG_CACHE"
mkdir -p "$npm_config_prefix" "$npm_config_cache"

echo "Installing ECC runtime npm dependencies into ${ECC_RUNTIME#$ROOT/}/node_modules"
npm ci --omit=dev --no-audit --no-fund --loglevel=error --prefix "$ECC_RUNTIME"
