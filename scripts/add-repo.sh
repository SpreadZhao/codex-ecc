#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPOS="$ROOT/repos"

usage() {
  cat <<'EOF'
Usage: scripts/add-repo.sh <git-url> [name]

Clone a repository into repos/<name>, add a workspace note, and register it in
repos.yaml with placeholder metadata for type/build/test commands.
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

if [ -f "$ROOT/.codex-ecc-template" ] && [ "${CODEX_ECC_ALLOW_TEMPLATE_REPOS:-0}" != "1" ]; then
  cat >&2 <<'EOF'
This repository is marked as a reusable Codex ECC template.

Do not add business repositories directly here. Create a local instance first:

  scripts/bootstrap-workspace-instance.sh <name>

Then run scripts/add-repo.sh from the generated instance.
Set CODEX_ECC_ALLOW_TEMPLATE_REPOS=1 only for deliberate template development.
EOF
  exit 1
fi

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  usage >&2
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

if ! printf '%s\n' "$NAME" | grep -Eq '^[A-Za-z0-9._-]+$'; then
  echo "Repository name may only contain letters, numbers, dot, underscore, and dash: $NAME" >&2
  exit 2
fi

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
      tmp="$(mktemp)"
      sed 's/^repositories: {}/repositories:/' "$ROOT/repos.yaml" > "$tmp"
      mv "$tmp" "$ROOT/repos.yaml"
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
