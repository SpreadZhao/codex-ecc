#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <target-dir>" >&2
  exit 2
fi

TARGET="$1"
mkdir -p "$TARGET/scripts/bin" "$TARGET/repos" "$TARGET/.codex/agents" "$TARGET/.agents/skills"
ROOT="$(cd "$TARGET" && pwd)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

write_if_missing() {
  local path="$1"
  local mode="${2:-0644}"
  if [ -e "$path" ]; then
    echo "skip existing: ${path#$ROOT/}"
    return 0
  fi
  install -m "$mode" /dev/stdin "$path"
  echo "created: ${path#$ROOT/}"
}

source_workspace_root() {
  local candidate
  candidate="$(cd "$SCRIPT_DIR/../../../.." 2>/dev/null && pwd || true)"
  if [ -n "$candidate" ] && [ -f "$candidate/flake.nix" ] && [ -f "$candidate/scripts/codex-workspace" ]; then
    printf '%s\n' "$candidate"
  fi
}

seed_from_source_workspace() {
  local source="$1"
  local spec rel mode dest

  [ -n "$source" ] || return 0

  for spec in \
    "flake.nix:0644" \
    ".gitignore:0644" \
    "AGENTS.md:0644" \
    "README.md:0644" \
    "scripts/init-ecc-workspace.sh:0755" \
    "scripts/sync-ecc.sh:0755" \
    "scripts/add-repo.sh:0755" \
    "scripts/bootstrap-workspace-instance.sh:0755" \
    "scripts/codex-workspace:0755" \
    "scripts/ecc-workspace:0755" \
    "scripts/bootstrap-ecc-node-deps.sh:0755" \
    "scripts/codex-ecc-doctor.js:0755" \
    "scripts/codex-native-hook-adapter.js:0755" \
    "scripts/generate-codex-native-hooks.js:0755" \
    "scripts/install-ecc-git-hooks.sh:0755" \
    "scripts/codex-session-adapter.js:0755" \
    "scripts/codex-observe-session.js:0755" \
    "scripts/codex-session-metrics.js:0755" \
    "scripts/codex-replay-ecc-hooks.js:0755" \
    "scripts/bin/codex:0755" \
    "scripts/bin/ecc:0755"
  do
    rel="${spec%:*}"
    mode="${spec#*:}"
    dest="$ROOT/$rel"
    [ -f "$source/$rel" ] || continue
    if [ -e "$dest" ]; then
      echo "skip existing: $rel"
      continue
    fi
    mkdir -p "$(dirname "$dest")"
    install -m "$mode" "$source/$rel" "$dest"
    echo "created: $rel (from current workspace template)"
  done
}

seed_from_source_workspace "$(source_workspace_root)"

write_if_missing "$ROOT/flake.nix" <<'EOF'
{
  description = "Codex + ECC multi-repository workspace for NixOS";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    ecc-src = {
      url = "github:affaan-m/ECC";
      flake = false;
    };
  };

  outputs = { nixpkgs, ecc-src, ... }:
    let
      supportedSystems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
    in
    {
      devShells = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              bash
              coreutils
              direnv
              fd
              gawk
              git
              gnused
              jq
              nodejs_24
              pnpm
              python3
              ripgrep
              yq-go
            ];

            shellHook = ''
              export CODEX_ECC_WORKSPACE="$PWD"
              export ECC_SRC="${ecc-src}"
              export NPM_CONFIG_PREFIX="$PWD/.npm-global"
              export NPM_CONFIG_CACHE="$PWD/.npm-cache"
              export npm_config_prefix="$NPM_CONFIG_PREFIX"
              export npm_config_cache="$NPM_CONFIG_CACHE"
              export CODEX_ECC_BIN="$PWD/scripts/bin"
              export PATH="$CODEX_ECC_BIN:$NPM_CONFIG_PREFIX/bin:$PATH"
              mkdir -p "$NPM_CONFIG_PREFIX/bin" "$NPM_CONFIG_CACHE"
            '';
          };
        });
    };
}
EOF

write_if_missing "$ROOT/.envrc" <<'EOF'
use flake
EOF

write_if_missing "$ROOT/.gitignore" <<'EOF'
.direnv/
.npm-global/
.npm-cache/
node_modules/
result
result-*
*.log

.workspaces/
.ecc/source/
.ecc/state/
.ecc/home/
.ecc/codex-home/

repos/*
!repos/.gitkeep
!repos/README.md
EOF

write_if_missing "$ROOT/AGENTS.md" <<'EOF'
# Codex ECC Workspace

This is a multi-repository workspace managed by Codex with workspace-local ECC assets.

## Workspace Layout

- `repos/` contains independent Git repositories.
- Each direct child under `repos/` is an independent project unless the user explicitly says otherwise.
- `repos.yaml` is the authoritative registry for repository paths, roles, build commands, and verification commands.
- `.codex/` and `.agents/skills/` are workspace-local ECC/Codex assets. Do not sync them into `~/.codex`.

Also read these files when they exist:

- `AGENTS.ecc.md`
- `.codex/AGENTS.md`
- `repos.yaml`

## Scope Rules

- Before editing, identify which repository or repositories are in scope.
- Do not assume changes in one repository should be mirrored to sibling repositories.
- Prefer minimal, reviewable changes.
- Keep shared workspace changes at the root; keep product code changes inside the relevant `repos/<name>/` repository.

## Multi-Repository Work

When a task spans multiple repositories:

1. Map the affected repositories from `repos.yaml`.
2. For each repository, inspect its README, AGENTS.md, build files, and tests.
3. Produce a per-repository plan.
4. Execute changes repository by repository.
5. Run verification commands inside each affected repository.
6. Summarize changes grouped by repository.

## Git Rules

- Never commit unless explicitly asked.
- Never push unless explicitly asked.
- Do not rewrite history unless explicitly asked.
- Keep branches, worktrees, and remotes isolated per repository.
- The workspace root may be a Git repository for configuration; nested repositories under `repos/` remain independent.

## ECC Boundaries

- Do not run ECC global sync scripts as the default path.
- Do not modify global `~/.codex` from this workspace.
- If copied ECC MCP definitions conflict with global MCPs, leave them disabled until explicitly requested.
EOF

write_if_missing "$ROOT/README.md" <<'EOF'
# Codex ECC Workspace

This directory is a workspace-local Codex + ECC environment for managing many independent projects under `repos/`.

Codex itself is expected to be installed globally. The Nix flake only provides workspace tools, and the ECC rules and skills stay inside this directory.
EOF

write_if_missing "$ROOT/repos.yaml" <<'EOF'
repositories: {}
EOF

write_if_missing "$ROOT/repos/README.md" <<'EOF'
# Project Repositories

Place independent Git repositories in this directory. Every direct child is treated as independent unless `repos.yaml` or the user says otherwise.
EOF

write_if_missing "$ROOT/repos/.gitkeep" <<'EOF'

EOF

write_if_missing "$ROOT/scripts/init-ecc-workspace.sh" 0755 <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FORCE=0

case "${1:-}" in
  "") ;;
  --force) FORCE=1 ;;
  -h|--help)
    echo "Usage: scripts/init-ecc-workspace.sh [--force]"
    exit 0
    ;;
  *)
    echo "Usage: scripts/init-ecc-workspace.sh [--force]" >&2
    exit 2
    ;;
esac

if [ -z "${ECC_SRC:-}" ]; then
  echo "ECC_SRC is not set. Enter the Nix dev shell first, for example: direnv allow" >&2
  exit 1
fi

mkdir -p "$ROOT/.codex" "$ROOT/.agents/skills" "$ROOT/repos" "$ROOT/scripts"

copy_entry() {
  local src="$1"
  local dest="$2"

  if [ -e "$dest" ] && [ "$FORCE" -ne 1 ]; then
    echo "skip existing: ${dest#$ROOT/}"
    return 0
  fi

  if [ -d "$src" ]; then
    mkdir -p "$dest"
    chmod -R u+w "$dest" 2>/dev/null || true
    cp -R --no-preserve=mode,ownership "$src/." "$dest/"
    chmod -R u+w "$dest" 2>/dev/null || true
  else
    chmod u+w "$dest" 2>/dev/null || true
    cp --no-preserve=mode,ownership "$src" "$dest"
    chmod u+w "$dest" 2>/dev/null || true
  fi
  echo "copied: ${dest#$ROOT/}"
}

sanitize_codex_project_config() {
  local config="$ROOT/.codex/config.toml"
  local tmp

  [ -f "$config" ] || return 0
  tmp="$(mktemp)"
  awk '
    BEGIN {
      skip_notify = 0
      skip_profiles = 0
    }

    skip_notify {
      if ($0 ~ /^[[:space:]]*\]/) {
        skip_notify = 0
      }
      next
    }

    $0 ~ /^[[:space:]]*notify[[:space:]]*=/ {
      if ($0 !~ /\]/) {
        skip_notify = 1
      }
      next
    }

    $0 ~ /^[[:space:]]*# External notifications receive/ {
      next
    }

    $0 ~ /^[[:space:]]*# Profiles .*codex -p/ {
      next
    }

    $0 ~ /^[[:space:]]*\[profiles(\.|])/ {
      skip_profiles = 1
      next
    }

    skip_profiles && $0 ~ /^[[:space:]]*\[/ {
      if ($0 ~ /^[[:space:]]*\[profiles(\.|])/) {
        next
      }
      skip_profiles = 0
    }

    skip_profiles {
      next
    }

    { print }
  ' "$config" > "$tmp"
  mv "$tmp" "$config"

  if ! grep -q 'user-level-only keys' "$config"; then
    tmp="$(mktemp)"
    awk '
      {
        print
        if ($0 ~ /^[[:space:]]*web_search[[:space:]]*=/) {
          print ""
          print "# Project-local Codex config intentionally excludes user-level-only keys such as"
          print "# `notify` and `[profiles.*]`; keep those in ~/.codex/config.toml if needed."
        }
      }
    ' "$config" > "$tmp"
    mv "$tmp" "$config"
  fi
}

if [ -d "$ECC_SRC/.codex" ]; then
  while IFS= read -r -d '' item; do
    copy_entry "$item" "$ROOT/.codex/$(basename "$item")"
  done < <(find "$ECC_SRC/.codex" -mindepth 1 -maxdepth 1 -print0)
  sanitize_codex_project_config
fi

if [ -f "$ECC_SRC/AGENTS.md" ]; then
  copy_entry "$ECC_SRC/AGENTS.md" "$ROOT/AGENTS.ecc.md"
fi

if [ -d "$ECC_SRC/.agents/skills" ]; then
  while IFS= read -r -d '' skill; do
    copy_entry "$skill" "$ROOT/.agents/skills/$(basename "$skill")"
  done < <(find "$ECC_SRC/.agents/skills" -mindepth 1 -maxdepth 1 -print0)
fi

if [ ! -f "$ROOT/repos.yaml" ]; then
  printf 'repositories: {}\n' > "$ROOT/repos.yaml"
fi

echo "ECC workspace initialized at $ROOT"
EOF

write_if_missing "$ROOT/scripts/add-repo.sh" 0755 <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPOS="$ROOT/repos"

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "Usage: scripts/add-repo.sh <git-url> [name]" >&2
  exit 2
fi

URL="$1"
NAME="${2:-$(basename "$URL" .git)}"

case "$NAME" in
  ""|.*|*/*)
    echo "Invalid repository name: $NAME" >&2
    exit 2
    ;;
esac

mkdir -p "$REPOS"

if [ -e "$REPOS/$NAME" ]; then
  echo "Repository already exists: repos/$NAME" >&2
  exit 1
fi

git clone "$URL" "$REPOS/$NAME"

cat > "$REPOS/$NAME/AGENTS.workspace.md" <<REPO_EOF
# Workspace Note for $NAME

This repository is part of the parent Codex ECC workspace.

Repository path:

\`\`\`
repos/$NAME
\`\`\`

Treat this repository as independent from sibling repositories unless the user explicitly states otherwise.
REPO_EOF

if [ ! -f "$ROOT/repos.yaml" ]; then
  printf 'repositories: {}\n' > "$ROOT/repos.yaml"
fi

if command -v yq >/dev/null 2>&1; then
  NAME="$NAME" PATH_VALUE="repos/$NAME" yq -i '
    .repositories[strenv(NAME)] = {
      "path": strenv(PATH_VALUE),
      "type": "unknown",
      "build": [],
      "test": [],
      "notes": ["Added by scripts/add-repo.sh. Fill in type, build, and test commands."]
    }
  ' "$ROOT/repos.yaml"
else
  if grep -Fq "  $NAME:" "$ROOT/repos.yaml"; then
    echo "repos.yaml already contains $NAME; leaving existing metadata unchanged"
  else
    if grep -Fxq 'repositories: {}' "$ROOT/repos.yaml"; then
      sed -i 's/^repositories: {}/repositories:/' "$ROOT/repos.yaml"
    fi
    cat >> "$ROOT/repos.yaml" <<REPOS_EOF
  $NAME:
    path: repos/$NAME
    type: unknown
    build: []
    test: []
    notes:
      - Added by scripts/add-repo.sh. Fill in type, build, and test commands.
REPOS_EOF
  fi
fi

echo "Added repo: repos/$NAME"
echo "Review repos.yaml and fill in type, build, and test commands."
EOF

write_if_missing "$ROOT/scripts/codex-workspace" 0755 <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

find_real_codex() {
  local shim="$ROOT/scripts/bin/codex"
  local shim_real
  shim_real="$(readlink -f "$shim" 2>/dev/null || printf '%s\n' "$shim")"

  local dir candidate candidate_real
  local old_ifs="$IFS"
  IFS=:
  for dir in $PATH; do
    IFS="$old_ifs"
    [ -n "$dir" ] || dir=.
    candidate="$dir/codex"
    if [ -x "$candidate" ]; then
      candidate_real="$(readlink -f "$candidate" 2>/dev/null || printf '%s\n' "$candidate")"
      if [ "$candidate_real" != "$shim_real" ]; then
        printf '%s\n' "$candidate"
        return 0
      fi
    fi
    IFS=:
  done
  IFS="$old_ifs"
  return 1
}

REAL_CODEX="$(find_real_codex || true)"
if [ -z "$REAL_CODEX" ]; then
  echo "codex command not found. Codex is expected to be installed globally." >&2
  exit 1
fi

exec "$REAL_CODEX" --cd "$ROOT" "$@"
EOF

write_if_missing "$ROOT/scripts/bin/codex" 0755 <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec "$ROOT/scripts/codex-workspace" "$@"
EOF

if [ ! -e "$ROOT/scripts/sync-ecc.sh" ]; then
  cp "$SCRIPT_DIR/sync-ecc.sh" "$ROOT/scripts/sync-ecc.sh"
  chmod +x "$ROOT/scripts/sync-ecc.sh"
  echo "created: scripts/sync-ecc.sh"
else
  echo "skip existing: scripts/sync-ecc.sh"
fi

if [ ! -d "$ROOT/.git" ]; then
  git -C "$ROOT" init -b main 2>/dev/null || {
    git -C "$ROOT" init
    git -C "$ROOT" branch -m main
  }
fi

echo "Workspace scaffold ready at $ROOT"
echo "Next: cd $ROOT && git add . && direnv allow && scripts/sync-ecc.sh --force"
