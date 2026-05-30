---
name: codex-ecc-workspace
description: Create, inspect, or refresh a Codex + ECC multi-repository workspace with workspace-local ECC assets. Use when Codex needs to bootstrap a repo like codex-ecc, support Nix or portable Linux/macOS direnv setup, keep projects under repos/, copy ECC .codex and .agents/skills assets without touching ~/.codex, or update a workspace/instance to the latest ECC configuration.
---

# Codex ECC Workspace

## Operating Boundary

Treat ECC as workspace-local configuration, not as a global Codex installer.

- Do not write to `~/.codex`.
- Do not run ECC global sync scripts by default.
- Keep product repositories as independent Git repos under `repos/`.
- Treat `.ecc/source/` as a generated workspace-local mirror of the pinned ECC runtime.
- Treat `.ecc/state/` and `.ecc/home/` as generated local runtime state, not source.
- Treat `.codex-ecc-template` as the marker for a pushable reusable capability template.
- In template mode, create local business instances with `scripts/bootstrap-workspace-instance.sh`; do not add product repositories directly to the template root.
- Keep the workspace root focused on configuration, scripts, registry, and copied ECC assets.
- Use `repos.yaml` as the source of truth for child repo routing and verification commands.

## Task Router

- **Create a new workspace**: use `scripts/create-workspace.sh <target-dir>` from this skill, then run `direnv allow` in the new workspace and `scripts/sync-ecc.sh --force`.
- **Create a local business instance from a reusable template**: run `scripts/bootstrap-workspace-instance.sh <name>` from the template repo. By default this updates the generated instance's ECC source lock and syncs latest ECC assets, then product work happens inside `.workspaces/<name>`.
- **Refresh ECC assets in an existing workspace**: run `scripts/sync-ecc.sh --update-lock --force` from that workspace root. This syncs the full ECC runtime, all upstream skills, and generated Codex prompts. Use `--source-mode git` to force the portable non-Nix resolver.
- **Refresh one local business instance from the template root**: run `scripts/sync-workspace-instance.sh <name>`. If the target instance is unclear, list `scripts/sync-workspace-instance.sh --list` and ask one short question.
- **Explain or audit the architecture**: read `references/workspace-blueprint.md`, then inspect the current workspace files.
- **Add project repositories**: prefer `scripts/import-repo.sh`, which accepts a Git URL or local Git repository path, creates or targets a workspace instance, writes `AGENTS.workspace.md`, and updates the instance `repos.yaml`.

When the user asks to "add/import this repository" and does not specify the target instance:

1. If running from a template checkout, list existing instances with `scripts/import-repo.sh --list-instances`.
2. Ask one short question: choose an existing `.workspaces/<name>` instance or provide a new instance name.
3. Use `scripts/import-repo.sh --instance <name> <source>` for an existing instance or `scripts/import-repo.sh --new-instance <name> <source>` for a new one.
4. If running from an instance checkout, import into the current instance unless the user explicitly names another one.

Read `references/workspace-blueprint.md` when you need exact file responsibilities, safety rules, or the expected directory structure.

## Creation Workflow

1. Confirm Codex is globally installed with `codex --version`; do not install Codex in the flake.
2. Run:

   ```bash
   <skill-dir>/scripts/create-workspace.sh <target-dir>
   ```

3. Enter the workspace and allow direnv:

   ```bash
   cd <target-dir>
   direnv allow
   ```

4. Copy the pinned ECC assets locally:

   ```bash
   scripts/sync-ecc.sh --force
   ```

5. Verify:

   ```bash
   nix flake check --no-build
   bash -n scripts/ecc-env.sh scripts/resolve-ecc-source.sh scripts/init-ecc-workspace.sh scripts/add-repo.sh scripts/import-repo.sh scripts/codex-workspace scripts/ecc-workspace scripts/sync-ecc.sh scripts/sync-workspace-instance.sh
   node --check scripts/codex-session-adapter.js
   node --check scripts/codex-observe-session.js
   node --check scripts/codex-session-metrics.js
   node --check scripts/codex-replay-ecc-hooks.js
   node --check scripts/codex-native-hook-adapter.js
   node --check scripts/generate-codex-native-hooks.js
   node --check scripts/codex-ecc-doctor.js
   bash -n scripts/bootstrap-workspace-instance.sh
   scripts/codex-ecc-doctor.js
   git status --short
   ```

## ECC Refresh Workflow

From an existing workspace root:

```bash
scripts/sync-ecc.sh --update-lock --force
git diff -- flake.lock AGENTS.ecc.md .codex .agents/skills scripts flake.nix
nix flake check --no-build
```

Portable Linux/macOS refresh:

```bash
scripts/sync-ecc.sh --source-mode git --update-lock --force
git diff -- ecc-source.lock.json AGENTS.ecc.md .codex .agents/skills scripts
```

If strict mirroring is required, pass `--prune` so local `.codex`, `.agents/skills`, and `AGENTS.ecc.md` are replaced from the current ECC source. Use this only when local custom skills do not live under `.agents/skills` or when they are intentionally backed up elsewhere.

From a reusable template root, refresh one generated business instance:

```bash
scripts/sync-workspace-instance.sh <name>
```

This updates and syncs only the selected `.workspaces/<name>` instance. It does not mutate template-root business state.

## Portable Linux/macOS Workflow

When Nix is unavailable, keep the same workspace boundaries and use the Git source lock:

```bash
direnv allow
scripts/sync-ecc.sh --source-mode git --update-lock --force
scripts/codex-ecc-doctor.js
```

Portable mode requires `bash`, `direnv`, `git`, `node >=18` with `npm`, and a globally installed `codex`. It must still keep ECC assets under `.ecc/`, `.codex/`, and `.agents/skills/`; do not write to `~/.codex`.

## Validation Checklist

- `flake.nix` declares `ecc-src = github:affaan-m/ECC` with `flake = false`.
- `ecc-source.lock.json` records the portable Git ECC source repo, ref, and rev.
- `.envrc` contains `use flake` plus a `scripts/ecc-env.sh` fallback for non-Nix direnv.
- `ECC_SRC` resolves inside `direnv exec . printenv ECC_SRC`.
- Root `AGENTS.md` defines multi-repo boundaries and says not to modify `~/.codex`.
- Pushable template repos may contain `.codex-ecc-template`; in that mode `scripts/add-repo.sh` must refuse product repositories unless `CODEX_ECC_ALLOW_TEMPLATE_REPOS=1` is explicitly set.
- `scripts/bootstrap-workspace-instance.sh <name>` creates an ignored independent instance under `.workspaces/<name>` with its own Git repository and refresh scripts.
- `scripts/sync-workspace-instance.sh <name>` can be run from the template root to update one existing `.workspaces/<name>` instance to the latest ECC configuration by default.
- `scripts/import-repo.sh` can import GitHub/Git URLs and local Git repositories into an existing or newly created instance.
- `AGENTS.ecc.md`, `.codex/AGENTS.md`, `.codex/config.toml`, `.codex/agents/`, `.codex/prompts/`, `.agents/skills/`, and `.ecc/source/` exist after sync.
- Synced workspace-local skills must have Codex-compatible YAML frontmatter; in particular `description` must stay at or below Codex's 1024-character limit even when the upstream ECC skill is longer.
- `.codex/hooks.json` exists after sync and routes native Codex SessionStart / PreToolUse / PostToolUse / PreCompact / Stop events through `scripts/codex-native-hook-adapter.js`.
- `.codex/git-hooks/pre-commit` and `.codex/git-hooks/pre-push` exist after sync, and `scripts/install-ecc-git-hooks.sh <repo>` can install them into one local Git repository without changing global `core.hooksPath`.
- `scripts/bin/codex` and `scripts/bin/ecc` exist and route through workspace-local wrappers.
- `NPM_CONFIG_PREFIX` and `NPM_CONFIG_CACHE` are workspace-local so ECC npm bootstrapping and Codex MCP `npx` launches do not write user-level npm state.
- `codex` launches through `scripts/codex-workspace`, sets `CLAUDE_PLUGIN_ROOT` / `ECC_PLUGIN_ROOT`, exposes native Codex hooks through `.codex/hooks.json`, adapts Codex transcripts, writes continuous-learning observation state under `.ecc/state/`, updates ECC tool activity metrics under `.ecc/home/.claude/metrics/`, and replays the safe post-session ECC hook graph through `scripts/codex-replay-ecc-hooks.js` as a fallback/complement.
- `scripts/codex-ecc-doctor.js` passes, proving the local Codex/ECC surface is present without reading or writing `~/.codex`.
- `repos.yaml` exists and child repos live under `repos/`.
- `.gitignore` ignores `repos/*` while keeping `repos/.gitkeep` and `repos/README.md`.
