#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  cat <<'EOF'
Usage: scripts/init-ecc-workspace.sh [--force] [--minimal]

Copy ECC Codex assets into this workspace only. This script does not write to
~/.codex and does not run ECC global sync scripts.

Options:
  --force    overwrite existing copied workspace files
  --minimal  copy only the small Codex reference surface, not the full ECC runtime
EOF
}

FORCE=0
FULL=1
while [ "$#" -gt 0 ]; do
  case "$1" in
    --force)
      FORCE=1
      ;;
    --minimal)
      FULL=0
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

if [ -z "${ECC_SRC:-}" ]; then
  echo "ECC_SRC is not set. Run scripts/sync-ecc.sh or source scripts/ecc-env.sh first." >&2
  exit 1
fi

if [ ! -d "$ECC_SRC" ]; then
  echo "ECC_SRC does not point to a directory: $ECC_SRC" >&2
  exit 1
fi

mkdir -p "$ROOT/.codex" "$ROOT/.agents/skills" "$ROOT/repos" "$ROOT/scripts" "$ROOT/.ecc"

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
    cp -R "$src/." "$dest/"
    chmod -R u+w "$dest" 2>/dev/null || true
  else
    chmod u+w "$dest" 2>/dev/null || true
    cp "$src" "$dest"
    chmod u+w "$dest" 2>/dev/null || true
  fi
  echo "copied: ${dest#$ROOT/}"
}

copy_tree_contents() {
  local src="$1"
  local dest="$2"
  local label="$3"

  if [ ! -d "$src" ]; then
    echo "warning: missing $label: $src" >&2
    return 0
  fi

  mkdir -p "$dest"
  chmod -R u+w "$dest" 2>/dev/null || true
  cp -R "$src/." "$dest/"
  chmod -R u+w "$dest" 2>/dev/null || true
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

generate_codex_prompts() {
  local commands_dir="$1"
  local prompts_dir="$ROOT/.codex/prompts"
  local manifest="$prompts_dir/ecc-prompts-manifest.txt"
  local command_file name out

  [ -d "$commands_dir" ] || return 0

  mkdir -p "$prompts_dir"
  : > "$manifest"

  while IFS= read -r command_file; do
    name="$(basename "$command_file" .md)"
    out="$prompts_dir/ecc-$name.md"
    {
      printf '# ECC Command Prompt: /%s\n\n' "$name"
      printf 'Source: %s\n\n' "$command_file"
      printf 'Use this prompt to run the ECC `%s` workflow in Codex.\n\n' "$name"
      awk '
        NR == 1 && $0 == "---" { fm = 1; next }
        fm == 1 && $0 == "---" { fm = 0; next }
        fm == 1 { next }
        { print }
      ' "$command_file"
    } > "$out"
    printf 'ecc-%s.md\n' "$name" >> "$manifest"
  done < <(find "$commands_dir" -maxdepth 1 -type f -name '*.md' -print | sort)

  sort -u "$manifest" -o "$manifest"
  echo "generated: ${prompts_dir#$ROOT/}"
}

sync_codex_git_hooks() {
  local hooks_src="$ECC_SRC/scripts/codex-git-hooks"
  local hooks_dest="$ROOT/.codex/git-hooks"

  [ -d "$hooks_src" ] || return 0
  copy_tree_contents "$hooks_src" "$hooks_dest" "ECC Codex git hooks"
  chmod +x "$hooks_dest/pre-commit" "$hooks_dest/pre-push" 2>/dev/null || true
}

generate_codex_native_hooks() {
  if [ -x "$ROOT/scripts/generate-codex-native-hooks.js" ]; then
    node "$ROOT/scripts/generate-codex-native-hooks.js"
  fi
}

sanitize_codex_skill_frontmatter() {
  node - "$ROOT/.agents/skills" <<'NODE'
'use strict';

const fs = require('fs');
const path = require('path');

const skillsRoot = process.argv[2];
const MAX_DESCRIPTION_CHARS = 1024;

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walk(fullPath));
    else if (entry.isFile() && entry.name === 'SKILL.md') result.push(fullPath);
  }
  return result;
}

function unquote(value) {
  const trimmed = String(value || '').trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function truncateDescription(value) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= MAX_DESCRIPTION_CHARS) return normalized;
  return `${normalized.slice(0, MAX_DESCRIPTION_CHARS - 3).replace(/\s+\S*$/, '').trimEnd()}...`;
}

let changed = 0;
for (const filePath of walk(skillsRoot)) {
  const original = fs.readFileSync(filePath, 'utf8');
  const frontmatter = original.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) continue;

  const lines = frontmatter[1].split('\n');
  const nextLines = lines.map((line) => {
    const match = line.match(/^description:\s*(.*)$/);
    if (!match) return line;

    const description = unquote(match[1]);
    if (description.length <= MAX_DESCRIPTION_CHARS) return line;

    return `description: ${JSON.stringify(truncateDescription(description))}`;
  });

  const nextFrontmatter = nextLines.join('\n');
  if (nextFrontmatter === frontmatter[1]) continue;

  const next = `---\n${nextFrontmatter}\n---${original.slice(frontmatter[0].length)}`;
  fs.writeFileSync(filePath, next);
  changed += 1;
}

if (changed > 0) {
  console.log(`sanitized: ${changed} Codex skill description(s)`);
}
NODE
}

sync_full_ecc_runtime() {
  local runtime="$ROOT/.ecc/source"

  copy_tree_contents "$ECC_SRC" "$runtime" "ECC full source"

  if [ -d "$ECC_SRC/skills" ]; then
    while IFS= read -r skill; do
      copy_entry "$skill" "$ROOT/.agents/skills/$(basename "$skill")"
    done < <(find "$ECC_SRC/skills" -mindepth 1 -maxdepth 1 -type d -print | sort)
  fi

  generate_codex_prompts "$ECC_SRC/commands"
  sync_codex_git_hooks
}

if [ -d "$ECC_SRC/.codex" ]; then
  while IFS= read -r item; do
    copy_entry "$item" "$ROOT/.codex/$(basename "$item")"
  done < <(find "$ECC_SRC/.codex" -mindepth 1 -maxdepth 1 -print | sort)
  sanitize_codex_project_config
else
  echo "warning: ECC source has no .codex directory" >&2
fi

if [ -f "$ECC_SRC/AGENTS.md" ]; then
  copy_entry "$ECC_SRC/AGENTS.md" "$ROOT/AGENTS.ecc.md"
else
  echo "warning: ECC source has no AGENTS.md" >&2
fi

if [ -d "$ECC_SRC/.agents/skills" ]; then
  while IFS= read -r skill; do
    copy_entry "$skill" "$ROOT/.agents/skills/$(basename "$skill")"
  done < <(find "$ECC_SRC/.agents/skills" -mindepth 1 -maxdepth 1 -print | sort)
else
  echo "warning: ECC source has no .agents/skills directory" >&2
fi

if [ "$FULL" -eq 1 ]; then
  sync_full_ecc_runtime
else
  generate_codex_prompts "$ECC_SRC/commands"
  sync_codex_git_hooks
fi

generate_codex_native_hooks
sanitize_codex_skill_frontmatter

if [ ! -f "$ROOT/repos.yaml" ]; then
  printf 'repositories: {}\n' > "$ROOT/repos.yaml"
  echo "created: repos.yaml"
fi

echo "ECC workspace initialized at $ROOT"
