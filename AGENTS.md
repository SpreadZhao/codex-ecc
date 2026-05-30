# Codex ECC Workspace

This is a multi-repository workspace managed by Codex with workspace-local ECC assets.

This checkout is also a reusable capability template when `.codex-ecc-template`
exists. In template mode, do not add business repositories directly at the
root; create a local instance first with `scripts/bootstrap-workspace-instance.sh`.
That command defaults to updating the generated instance's `ecc-src` lock and
syncing the latest workspace-local ECC assets.

## Workspace Layout

- `repos/` contains independent Git repositories.
- Each direct child under `repos/` is an independent project unless the user explicitly says otherwise.
- `repos.yaml` is the authoritative registry for repository paths, roles, build commands, and verification commands.
- `.codex/`, `.agents/skills/`, and `.ecc/` are workspace-local ECC/Codex assets. Do not sync them into `~/.codex`.
- `.ecc/source/` is a generated mirror of the pinned ECC source from `flake.lock`.
- `.ecc/state/` and `.ecc/home/` are generated local runtime state and should not be treated as product code.
- `.workspaces/` contains ignored local business workspace instances generated from the reusable template.

Also read these files when they exist:

- `AGENTS.ecc.md`
- `.codex/AGENTS.md`
- `.ecc/source/README.md`
- `repos.yaml`

## Scope Rules

- Before editing, identify which repository or repositories are in scope.
- Do not assume changes in one repository should be mirrored to sibling repositories.
- Prefer minimal, reviewable changes.
- Keep shared workspace changes at the root; keep product code changes inside the relevant `repos/<name>/` repository.
- If `.codex-ecc-template` exists, keep the root as the base capability layer and do product work inside a generated instance under `.workspaces/` or another target directory.

## Template Root Operations

- When the user asks from the template root to create a workspace, run `scripts/bootstrap-workspace-instance.sh <name>` unless they explicitly ask to pin the template lock. Use `--no-update-lock` only when the user wants the current pinned ECC input.
- When the user asks from the template root to update an existing workspace's ECC configuration, run `scripts/sync-workspace-instance.sh <name>`. If the target is unclear, list instances with `scripts/sync-workspace-instance.sh --list` and ask one short question.
- `scripts/sync-workspace-instance.sh <name>` refreshes the selected `.workspaces/<name>` instance only; it should not add business state to the template root.

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
- Prefer `scripts/sync-ecc.sh` and `scripts/ecc-workspace` over upstream global installers.
- If copied ECC MCP definitions conflict with global MCPs, leave them disabled until explicitly requested.
