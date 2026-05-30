---
name: codex-ecc-workspace
description: Create, inspect, or refresh a NixOS Codex + ECC multi-repository workspace with workspace-local ECC assets. Use when Codex needs to bootstrap a repo like codex-ecc, add the flake/direnv/Codex scaffolding, keep projects under repos/, copy ECC .codex and .agents/skills assets without touching ~/.codex, or update the workspace to the latest pinned ECC configuration.
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
- **Create a local business instance from a reusable template**: run `scripts/bootstrap-workspace-instance.sh <name>` from the template repo, then work inside `.workspaces/<name>`.
- **Refresh ECC assets in an existing workspace**: run `scripts/sync-ecc.sh --update-lock --force` from the workspace root. This syncs the full ECC runtime, all upstream skills, and generated Codex prompts.
- **Explain or audit the architecture**: read `references/workspace-blueprint.md`, then inspect the current workspace files.
- **Add project repositories**: use the workspace's `scripts/add-repo.sh`, then update `repos.yaml` with type, build, test, and notes.

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
   bash -n scripts/init-ecc-workspace.sh scripts/add-repo.sh scripts/codex-workspace scripts/ecc-workspace scripts/sync-ecc.sh
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

If strict mirroring is required, pass `--prune` so local `.codex`, `.agents/skills`, and `AGENTS.ecc.md` are replaced from the current ECC source. Use this only when local custom skills do not live under `.agents/skills` or when they are intentionally backed up elsewhere.

## Validation Checklist

- `flake.nix` declares `ecc-src = github:affaan-m/ECC` with `flake = false`.
- `.envrc` contains `use flake`.
- `ECC_SRC` resolves inside `direnv exec . printenv ECC_SRC`.
- Root `AGENTS.md` defines multi-repo boundaries and says not to modify `~/.codex`.
- Pushable template repos may contain `.codex-ecc-template`; in that mode `scripts/add-repo.sh` must refuse product repositories unless `CODEX_ECC_ALLOW_TEMPLATE_REPOS=1` is explicitly set.
- `scripts/bootstrap-workspace-instance.sh <name>` creates an ignored independent instance under `.workspaces/<name>` with its own Git repository and refresh scripts.
- `AGENTS.ecc.md`, `.codex/AGENTS.md`, `.codex/config.toml`, `.codex/agents/`, `.codex/prompts/`, `.agents/skills/`, and `.ecc/source/` exist after sync.
- `.codex/hooks.json` exists after sync and routes native Codex SessionStart / PreToolUse / PostToolUse / PreCompact / Stop events through `scripts/codex-native-hook-adapter.js`.
- `.codex/git-hooks/pre-commit` and `.codex/git-hooks/pre-push` exist after sync, and `scripts/install-ecc-git-hooks.sh <repo>` can install them into one local Git repository without changing global `core.hooksPath`.
- `scripts/bin/codex` and `scripts/bin/ecc` exist and route through workspace-local wrappers.
- `NPM_CONFIG_PREFIX` and `NPM_CONFIG_CACHE` are workspace-local so ECC npm bootstrapping and Codex MCP `npx` launches do not write user-level npm state.
- `codex` launches through `scripts/codex-workspace`, sets `CLAUDE_PLUGIN_ROOT` / `ECC_PLUGIN_ROOT`, exposes native Codex hooks through `.codex/hooks.json`, adapts Codex transcripts, writes continuous-learning observation state under `.ecc/state/`, updates ECC tool activity metrics under `.ecc/home/.claude/metrics/`, and replays the safe post-session ECC hook graph through `scripts/codex-replay-ecc-hooks.js` as a fallback/complement.
- `scripts/codex-ecc-doctor.js` passes, proving the local Codex/ECC surface is present without reading or writing `~/.codex`.
- `repos.yaml` exists and child repos live under `repos/`.
- `.gitignore` ignores `repos/*` while keeping `repos/.gitkeep` and `repos/README.md`.
