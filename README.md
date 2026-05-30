# Codex ECC Workspace

This directory is a workspace-local Codex + ECC environment for managing many independent projects under `repos/`.

Codex itself is expected to be installed globally. The Nix flake provides the workspace tools, ECC wrappers, a pinned ECC source, and optional package outputs; ECC runtime assets stay inside this directory.

## Template and Instances

This repository is intended to be pushable and reusable as a base capability layer. The marker `.codex-ecc-template` means: keep this root focused on Codex/ECC scaffolding, scripts, Nix packaging, hooks, and skills.

Create a local business workspace instance before adding application repositories:

```bash
scripts/bootstrap-workspace-instance.sh my-apps
cd .workspaces/my-apps
direnv allow
scripts/sync-ecc.sh --force
scripts/add-repo.sh git@github.com:you/repo-a.git
codex
```

The generated instance is an independent Git repository under `.workspaces/`, which is ignored by this template. It can track `repos.yaml`, local routing decisions, and child repository state without dirtying the reusable template repo. Inside the instance, `$codex-ecc-workspace` still works the same way: refresh ECC with `scripts/sync-ecc.sh --update-lock --force`.

## Quick Start

```bash
direnv allow
./scripts/sync-ecc.sh --force
./scripts/bootstrap-workspace-instance.sh my-apps
cd .workspaces/my-apps
direnv allow
./scripts/add-repo.sh git@github.com:you/repo-a.git
codex
```

After direnv loads, `codex` is a workspace-local shim from `scripts/bin/codex`.
It forwards to the globally installed Codex binary with `--cd` set to this
workspace root, so subcommands work too:

```bash
codex resume
codex resume --last
codex exec "只读分析当前 workspace"
```

If direnv is not hooked into your shell, use:

```bash
direnv exec . codex
```

## ECC Runtime

`scripts/sync-ecc.sh --force` now performs a full workspace-local sync:

- `.ecc/source/` mirrors the pinned upstream ECC source from `flake.lock`.
- `.agents/skills/` receives the upstream `.agents/skills` set plus the full root `skills/` catalog.
- `.codex/prompts/` is generated from upstream `commands/*.md`.
- `.codex/hooks.json` is generated for native Codex hooks on Codex 0.133+.
- `.codex/git-hooks/` receives ECC's Codex-oriented `pre-commit` and `pre-push` hooks.
- `AGENTS.ecc.md` and `.codex/` are refreshed and sanitized for project-local Codex config.

The `ecc` command is also shimmed in `scripts/bin/ecc`; it runs with `HOME=.ecc/home` so ECC session, metric, and SQLite state stay local to this workspace:

```bash
ecc --help
ecc plan --profile minimal --target codex
ecc status --json
```

On first use, `scripts/ecc-workspace` bootstraps upstream ECC npm runtime dependencies into `.ecc/source/node_modules` with `npm ci --omit=dev`. Set `CODEX_ECC_AUTO_NPM_INSTALL=0` to disable that behavior and run `scripts/bootstrap-ecc-node-deps.sh` manually. Both `codex` and `ecc` wrappers force npm/npx writes into `.npm-global/` and `.npm-cache/`, so MCP servers launched through `.codex/config.toml` stay workspace-local on NixOS.

`codex` sessions launched from this workspace set `CLAUDE_PLUGIN_ROOT` and `ECC_PLUGIN_ROOT` to the local ECC runtime. The wrapper also runs ECC session start/end hooks around Codex, adapts new Codex rollout JSONL into the ECC session-summary format, replays Codex tool calls into ECC continuous-learning observation hooks, and stores generated lifecycle and learning data under `.ecc/state/` with an isolated hook home under `.ecc/home/`.

Codex 0.133+ has native hook support. This workspace generates `.codex/hooks.json` and routes SessionStart, PreToolUse, PostToolUse, PreCompact, and Stop events through `scripts/codex-native-hook-adapter.js`, which normalizes Codex hook payloads into the Claude-shaped inputs expected by ECC's upstream hook scripts. Codex still requires hook trust review before running project hooks; for throwaway automation you can set `CODEX_ECC_BYPASS_HOOK_TRUST=1`, which forwards `--dangerously-bypass-hook-trust` to Codex.

Set `CODEX_ECC_LOCAL_CODEX_HOME=1` when you want Codex runtime state and rollout transcripts to stay under `.ecc/codex-home` instead of the user-level `~/.codex`. This also avoids Codex PATH-helper warnings on stricter NixOS shells, but the local Codex home must have whatever auth/config your Codex install requires.

The observation bridge is `scripts/codex-observe-session.js`. It converts Codex `function_call` / `function_call_output` rollout entries into ECC-compatible `tool_start` / `tool_complete` observations and writes project-scoped observations under `.ecc/state/ecc-homunculus/`. It defaults to direct JSONL writes for speed; set `CODEX_ECC_OBSERVE_MODE=hook` when you need to debug against upstream `continuous-learning-v2/hooks/observe.sh`. Set `CODEX_ECC_OBSERVE=0` when launching `codex` to temporarily disable this bridge.

`scripts/codex-session-metrics.js` also converts Codex transcript tool calls into ECC `tool-usage.jsonl` rows under `.ecc/home/.claude/metrics/` and maintains the `/tmp/ecc-metrics-<session>.json` bridge used by ECC statusline/context-monitor flows. Set `CODEX_ECC_METRICS=0` to disable that metrics bridge for a session.

`scripts/codex-replay-ecc-hooks.js` replays the Codex transcript through the safe post-session portion of ECC's upstream hook graph. It remains useful as a fallback/complement to native Codex hooks and for transcript-derived session summaries. It runs PostToolUse, Stop, and SessionEnd hooks that can still be meaningful after a Codex run, including quality-gate, design warnings, batch format/typecheck, session summary, evaluate-session, cost tracker, and the SessionEnd marker. It intentionally skips duplicate observation/metrics hooks because `codex-observe-session.js` and `codex-session-metrics.js` already provide Codex-native bridges. Set `CODEX_ECC_HOOK_REPLAY=0` to disable this post-session hook replay, or `CODEX_ECC_REPLAY_PREFLIGHT=1` to run PreToolUse hooks as diagnostic replay only.

When `scripts/codex-workspace` is invoked from inside an already-running Codex session, it detects `CODEX_THREAD_ID` and skips transcript post-processing by default so it does not observe the outer session. Set `CODEX_ECC_ALLOW_NESTED_TRANSCRIPT=1` only when you intentionally want nested transcript processing.

`scripts/codex-ecc-doctor.js` checks the workspace-local ECC surface without reading or writing `~/.codex`: copied config, skills, prompts, git hooks, wrappers, flake entries, and unsupported project-local Codex keys. Run it after refreshes:

```bash
scripts/codex-ecc-doctor.js
```

To install ECC's lightweight Git safeguards into one local repository, use:

```bash
scripts/install-ecc-git-hooks.sh repos/example-project
```

This copies from `.codex/git-hooks/` into that repository's `.git/hooks/` only. It does not set global `core.hooksPath`.

## Nix Flake

Useful flake entries:

```bash
nix run .#ecc -- --help
nix run .#ecc-universal -- --help
nix run .#codex-ecc -- --version
nix run .#codex-ecc-doctor
nix run .#ecc-install-git-hooks -- repos/example-project
nix build .#ecc2
```

`.#ecc` delegates to this workspace's `scripts/ecc-workspace` and keeps ECC state under `.ecc/home`. `.#ecc-universal` runs the Nix-packaged upstream ECC source directly. `.#codex-ecc` delegates to this workspace's `scripts/codex-workspace`. `.#codex-ecc-doctor` and `.#ecc-install-git-hooks` expose the local doctor and per-repository hook installer. `.#ecc2` packages the upstream Rust TUI/control-plane prototype and may fetch/build the Rust dependency graph when built.

## Layout

- `AGENTS.md` is the workspace entry point for Codex.
- `AGENTS.ecc.md` is populated from upstream ECC by `scripts/init-ecc-workspace.sh`.
- `.codex/` holds workspace-local Codex/ECC assets, including native Codex hooks in `.codex/hooks.json`.
- `.agents/skills/` holds workspace-local ECC skills.
- `.ecc/source/` holds the generated full ECC runtime mirror.
- `.ecc/state/` holds generated local session and learning state.
- `.workspaces/` holds ignored local business workspace instances.
- `repos/` contains independent Git repositories.
- `repos.yaml` records each repository path, role, and verification commands.

The template root should not contain product repositories. Business instances can track their own `repos.yaml`; each child repository under an instance still keeps its own Git history.
