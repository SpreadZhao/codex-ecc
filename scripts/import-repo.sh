#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  cat <<'EOF'
Usage: scripts/import-repo.sh [options] <git-url|local-repo-path>

Import a GitHub/Git URL or an existing local Git repository into a Codex ECC
workspace instance under repos/<name>, add AGENTS.workspace.md, and update the
instance repos.yaml.

Run from an instance root to import into that instance. Run from a reusable
template root with --instance <name> or --new-instance <name>.

Options:
  --instance <name|path>   import into an existing instance
  --new-instance <name>    create .workspaces/<name> first, then import there
  --repo-name <name>       destination name under repos/
  --list-instances         list available .workspaces instances
  -h, --help               show this help
EOF
}

die() {
  echo "$*" >&2
  exit 1
}

is_git_url() {
  case "$1" in
    git@*:*|https://*|http://*|ssh://*|file://*) return 0 ;;
    *) return 1 ;;
  esac
}

expand_path() {
  case "$1" in
    "~") printf '%s\n' "$HOME" ;;
    "~/"*) printf '%s/%s\n' "$HOME" "${1#~/}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

default_repo_name() {
  local source="$1"
  if is_git_url "$source"; then
    basename "$source" .git
  else
    basename "$(expand_path "$source")"
  fi
}

validate_name() {
  local label="$1"
  local value="$2"
  case "$value" in
    ""|.*|*/*)
      die "Invalid $label name: $value"
      ;;
  esac
  if ! printf '%s\n' "$value" | grep -Eq '^[A-Za-z0-9._-]+$'; then
    die "$label name may only contain letters, numbers, dot, underscore, and dash: $value"
  fi
}

list_instances() {
  local dir="$ROOT/.workspaces"
  [ -d "$dir" ] || return 0
  find "$dir" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort
}

resolve_instance() {
  local value="$1"
  case "$value" in
    /*|*/*)
      printf '%s\n' "$(cd "$value" && pwd)"
      ;;
    *)
      validate_name "instance" "$value"
      printf '%s\n' "$ROOT/.workspaces/$value"
      ;;
  esac
}

write_workspace_note() {
  local repo_dir="$1"
  local name="$2"
  local note="$repo_dir/AGENTS.workspace.md"
  [ -e "$note" ] && return 0
  cat > "$note" <<EOF
# Workspace Note for $name

This repository is part of the parent Codex ECC workspace instance.

Repository path:

\`\`\`text
repos/$name
\`\`\`

Treat this repository as independent from sibling repositories unless the user explicitly states otherwise.
EOF
}

update_repos_yaml() {
  local instance="$1"
  local name="$2"
  local source="$3"
  local mode="$4"
  local repos_yaml="$instance/repos.yaml"

  if [ ! -f "$repos_yaml" ]; then
    printf 'repositories: {}\n' > "$repos_yaml"
  fi

  local note
  if [ "$mode" = "copy" ]; then
    note="Copied from $(cd "$(dirname "$(expand_path "$source")")" && pwd)/$(basename "$(expand_path "$source")"). Fill in type, build, and test commands."
  else
    note="Cloned from $source. Fill in type, build, and test commands."
  fi

  if command -v yq >/dev/null 2>&1; then
    NAME="$name" PATH_VALUE="repos/$name" NOTE="$note" yq -i '
      .repositories[strenv(NAME)] = {
        "path": strenv(PATH_VALUE),
        "type": "unknown",
        "build": [],
        "test": [],
        "notes": [strenv(NOTE)]
      }
    ' "$repos_yaml"
    return 0
  fi

  if grep -Fq "  $name:" "$repos_yaml"; then
    echo "repos.yaml already contains $name; leaving existing metadata unchanged"
    return 0
  fi

  if grep -Fxq 'repositories: {}' "$repos_yaml"; then
    tmp="$(mktemp)"
    sed 's/^repositories: {}/repositories:/' "$repos_yaml" > "$tmp"
    mv "$tmp" "$repos_yaml"
  fi

  cat >> "$repos_yaml" <<EOF
  $name:
    path: repos/$name
    type: unknown
    build: []
    test: []
    notes:
      - $note
EOF
}

INSTANCE_ARG=""
NEW_INSTANCE=""
REPO_NAME=""
LIST_INSTANCES=0
SOURCE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --instance)
      INSTANCE_ARG="${2:-}"
      [ -n "$INSTANCE_ARG" ] || die "--instance requires a value"
      shift 2
      ;;
    --new-instance)
      NEW_INSTANCE="${2:-}"
      [ -n "$NEW_INSTANCE" ] || die "--new-instance requires a value"
      shift 2
      ;;
    --repo-name)
      REPO_NAME="${2:-}"
      [ -n "$REPO_NAME" ] || die "--repo-name requires a value"
      shift 2
      ;;
    --list-instances)
      LIST_INSTANCES=1
      shift
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
      if [ -n "$SOURCE" ]; then
        usage >&2
        exit 2
      fi
      SOURCE="$1"
      shift
      ;;
  esac
done

if [ "$LIST_INSTANCES" -eq 1 ]; then
  list_instances
  exit 0
fi

[ -n "$SOURCE" ] || {
  usage >&2
  exit 2
}

if [ -n "$INSTANCE_ARG" ] && [ -n "$NEW_INSTANCE" ]; then
  die "Use only one of --instance or --new-instance"
fi

INSTANCE_ROOT=""
if [ -n "$NEW_INSTANCE" ]; then
  validate_name "instance" "$NEW_INSTANCE"
  "$ROOT/scripts/bootstrap-workspace-instance.sh" "$NEW_INSTANCE"
  INSTANCE_ROOT="$ROOT/.workspaces/$NEW_INSTANCE"
elif [ -n "$INSTANCE_ARG" ]; then
  INSTANCE_ROOT="$(resolve_instance "$INSTANCE_ARG")"
elif [ -f "$ROOT/.codex-ecc-template" ]; then
  cat >&2 <<'EOF'
This command is running from a reusable Codex ECC template.
Choose a target instance first:

  scripts/import-repo.sh --list-instances
  scripts/import-repo.sh --instance <name> <git-url|local-path>
  scripts/import-repo.sh --new-instance <name> <git-url|local-path>
EOF
  exit 1
else
  INSTANCE_ROOT="$ROOT"
fi

[ -d "$INSTANCE_ROOT" ] || die "Instance does not exist: $INSTANCE_ROOT"
[ -d "$INSTANCE_ROOT/repos" ] || die "Instance has no repos/ directory: $INSTANCE_ROOT"

NAME="${REPO_NAME:-$(default_repo_name "$SOURCE")}"
validate_name "repository" "$NAME"

DEST="$INSTANCE_ROOT/repos/$NAME"
[ ! -e "$DEST" ] || die "Repository already exists: $DEST"

if is_git_url "$SOURCE"; then
  git clone "$SOURCE" "$DEST"
  MODE="clone"
else
  LOCAL_SOURCE="$(expand_path "$SOURCE")"
  [ -d "$LOCAL_SOURCE/.git" ] || die "Local source is not a Git repository: $LOCAL_SOURCE"
  cp -a "$LOCAL_SOURCE" "$DEST"
  MODE="copy"
fi

write_workspace_note "$DEST" "$NAME"
update_repos_yaml "$INSTANCE_ROOT" "$NAME" "$SOURCE" "$MODE"

echo "Imported repository: $INSTANCE_ROOT/repos/$NAME"
echo "Updated registry: $INSTANCE_ROOT/repos.yaml"
