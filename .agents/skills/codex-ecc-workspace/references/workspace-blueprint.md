# Codex + ECC Workspace Blueprint

Use this reference when creating, auditing, or refreshing a Codex + ECC multi-repository workspace on NixOS, non-Nix Linux, or macOS.

## Core Design

The workspace uses:

- Global Codex installation.
- Workspace-local full ECC runtime assets.
- `flake.nix` and `direnv` for Nix tooling.
- `ecc-source.lock.json` and Git for portable non-Nix ECC source resolution.
- `repos.yaml` for multi-repository routing.
- `repos/` for independent child Git repositories.
- Optional `.codex-ecc-template` marker for a pushable base capability repo.
- Ignored `.workspaces/` instances for business/product work.

Do not sync ECC into `~/.codex`. Do not run ECC global sync scripts as the default path.

## Expected Layout

```text
codex-ecc/
├── flake.nix
├── flake.lock
├── ecc-source.lock.json
├── .envrc
├── .gitignore
├── AGENTS.md
├── AGENTS.ecc.md
├── README.md
├── .codex-ecc-template   # optional marker for reusable template checkouts
├── repos.yaml
├── .codex/
│   ├── config.toml
│   ├── AGENTS.md
│   ├── hooks.json
│   ├── agents/
│   ├── git-hooks/
│   └── prompts/
├── .agents/
│   └── skills/
├── .ecc/
│   ├── upstream/     # ignored portable Git ECC checkout
│   ├── source/       # generated full ECC source mirror
│   ├── state/        # generated lifecycle/learning state
│   └── home/         # isolated hook home for ECC lifecycle hooks
├── .workspaces/      # ignored local business instances generated from template
├── repos/
│   ├── .gitkeep
│   └── README.md
└── scripts/
    ├── bin/
    │   ├── codex
    │   └── ecc
    ├── ecc-workspace
    ├── codex-session-adapter.js
    ├── codex-observe-session.js
    ├── codex-session-metrics.js
    ├── codex-replay-ecc-hooks.js
    ├── codex-native-hook-adapter.js
    ├── generate-codex-native-hooks.js
    ├── codex-ecc-doctor.js
    ├── install-ecc-git-hooks.sh
    ├── ecc-env.sh
    ├── resolve-ecc-source.sh
    ├── bootstrap-workspace-instance.sh
    ├── sync-workspace-instance.sh
    ├── init-ecc-workspace.sh
    ├── add-repo.sh
    ├── import-repo.sh
    ├── codex-workspace
    └── sync-ecc.sh
```

## File Responsibilities

| Path | Responsibility |
|---|---|
| `flake.nix` | Provide workspace tools, ECC wrappers, and package outputs; do not install Codex globally. |
| `flake.lock` | Pin ECC and nixpkgs inputs. |
| `ecc-source.lock.json` | Pin the portable Git ECC source repo/ref/rev for non-Nix Linux/macOS. |
| `.envrc` | Load the flake with `use flake` when available, otherwise source `scripts/ecc-env.sh`. |
| `AGENTS.md` | Workspace instructions, multi-repo boundaries, Git rules, ECC boundary. |
| `.codex-ecc-template` | Optional marker meaning this checkout is the reusable capability layer; product repos should be added only in generated instances. |
| `AGENTS.ecc.md` | Copied upstream ECC root instructions. |
| `.codex/` | Copied workspace-local Codex/ECC config, native hook config, role files, and generated command prompts. |
| `.codex/hooks.json` | Workspace-local native Codex hook configuration generated for Codex 0.133+ hook support. |
| `.codex/git-hooks/` | Copied ECC Codex git hooks used by the per-repository installer; never installed globally by default. |
| `.agents/skills/` | Full upstream ECC skill catalog plus any explicitly local workspace skills. |
| `.ecc/source/` | Generated mirror of the pinned ECC source used by local wrappers and hook adapters. |
| `.ecc/upstream/` | Ignored portable Git checkout used to populate `.ecc/source/` without Nix. |
| `.ecc/state/` | Generated Codex lifecycle, transcript, observed-transcript stamps, and continuous-learning state. |
| `.ecc/home/` | Isolated HOME used only while running ECC hooks from the Codex wrapper. |
| `.workspaces/` | Ignored local business workspace instances, each with its own Git repository and `repos.yaml`. |
| `repos/` | Independent child project repositories. |
| `repos.yaml` | Registry of child repo path, type, build/test commands, notes. |
| `scripts/` | Workspace setup, sync, instance refresh, import, add-repo, and launch helpers. |

## Required Tooling

The flake should include at least:

- `bash`
- `coreutils`
- `direnv`
- `fd`
- `gawk`
- `git`
- `gnused`
- `jq`
- `nodejs_24`
- `pnpm`
- `python3`
- `ripgrep`
- `yq-go`

The shell hook should export:

```bash
export CODEX_ECC_WORKSPACE="$PWD"
export ECC_SRC="${ecc-src}"
export CODEX_ECC_RUNTIME="$PWD/.ecc/source" # fallback to ${ecc-src} when unsynced
export CLAUDE_PLUGIN_ROOT="$CODEX_ECC_RUNTIME"
export ECC_PLUGIN_ROOT="$CODEX_ECC_RUNTIME"
export AGENTS_HOME="$PWD/.agents"
export CLV2_HOMUNCULUS_DIR="$PWD/.ecc/state/ecc-homunculus"
export ECC_STATE_DIR="$PWD/.ecc/state"
export ECC_GLOBAL_HOOKS_DIR="$PWD/.codex/git-hooks"
export NPM_CONFIG_PREFIX="$PWD/.npm-global"
export NPM_CONFIG_CACHE="$PWD/.npm-cache"
export npm_config_prefix="$NPM_CONFIG_PREFIX"
export npm_config_cache="$NPM_CONFIG_CACHE"
export CODEX_ECC_BIN="$PWD/scripts/bin"
export PATH="$CODEX_ECC_BIN:$NPM_CONFIG_PREFIX/bin:$PATH"
```

For non-Nix Linux/macOS, `scripts/ecc-env.sh` should export the same workspace-local variables and should not require Nix. Required host tools are `bash`, `direnv`, `git`, `node >=18`, `npm`, and globally installed `codex`.

`scripts/bin/codex` is a workspace-local PATH shim. It should call `scripts/codex-workspace` so commands such as `codex`, `codex resume`, and `codex exec` all start with `--cd <workspace-root>`. `scripts/codex-workspace` must resolve the real global Codex binary while skipping this shim to avoid recursion.

For Codex versions with native hook support, `.codex/hooks.json` should route SessionStart, PreToolUse, PostToolUse, PreCompact, and Stop events through `scripts/codex-native-hook-adapter.js`. The adapter normalizes Codex hook payloads into the Claude-shaped payload expected by ECC hook scripts and runs them against the workspace-local `.ecc/source` runtime with `HOME=.ecc/home`.

After Codex exits, `scripts/codex-workspace` should locate the new Codex rollout JSONL, run `scripts/codex-session-adapter.js` for ECC session summary hooks, run `scripts/codex-observe-session.js` to replay Codex tool calls into ECC continuous-learning observations, run `scripts/codex-session-metrics.js` to maintain ECC `tool-usage.jsonl` plus the `/tmp/ecc-metrics-<session>.json` bridge used by statusline/context-monitor flows, and run `scripts/codex-replay-ecc-hooks.js` to replay the safe post-session portion of ECC's upstream hook graph. The replay remains useful as a fallback/complement and for transcript-derived hooks that are safer after the session. It skips duplicate observe/metrics hooks because Codex-specific bridges own those outputs.

The observation bridge should default to direct `observations.jsonl` writes for speed and allow `CODEX_ECC_OBSERVE_MODE=hook` for debugging through upstream `continuous-learning-v2/hooks/observe.sh`. Set `CODEX_ECC_OBSERVE=0`, `CODEX_ECC_METRICS=0`, or `CODEX_ECC_HOOK_REPLAY=0` to disable a bridge for a session. Set `CODEX_ECC_REPLAY_PREFLIGHT=1` only for diagnostic replay of PreToolUse hooks; Codex cannot let those replayed hooks block tools that already ran. If `CODEX_THREAD_ID` is already set, the wrapper should skip transcript post-processing unless `CODEX_ECC_ALLOW_NESTED_TRANSCRIPT=1` is set; this avoids observing the outer Codex session when the wrapper is tested from inside Codex.

`scripts/bin/ecc` should call `scripts/ecc-workspace`, which executes the pinned local ECC runtime with workspace-local `HOME=.ecc/home`, `CODEX_HOME`, `AGENTS_HOME`, `CLV2_HOMUNCULUS_DIR`, and hook directories.

Both `scripts/codex-workspace` and `scripts/ecc-workspace` should set `NPM_CONFIG_PREFIX`, `NPM_CONFIG_CACHE`, `npm_config_prefix`, and `npm_config_cache` to workspace-local directories. This keeps ECC npm bootstrapping and Codex MCP `npx` launches out of user-level npm state, which is important on NixOS, non-Nix Linux/macOS, and sandboxed runs.

`scripts/codex-workspace` should support `CODEX_ECC_LOCAL_CODEX_HOME=1`, setting `CODEX_HOME` to `.ecc/codex-home` for sessions that must avoid user-level `~/.codex` writes. Keep this opt-in unless the workspace also provisions local Codex auth/config.

`scripts/codex-ecc-doctor.js` should validate the workspace-local Codex/ECC surface: copied config, skills, prompts, git hooks, wrappers, flake entries, and project-local Codex config sanitation. It must not read or write `~/.codex`. `scripts/install-ecc-git-hooks.sh <repo>` should install `.codex/git-hooks/pre-commit` and `.codex/git-hooks/pre-push` into exactly one Git repository's `.git/hooks/` directory; it must not set global `core.hooksPath`.

For a pushable template checkout, add `.codex-ecc-template` and keep `repos.yaml` empty. `scripts/add-repo.sh` should refuse to add repositories in this mode unless `CODEX_ECC_ALLOW_TEMPLATE_REPOS=1` is set. `scripts/bootstrap-workspace-instance.sh <name>` should generate `.workspaces/<name>` by invoking the skill's `create-workspace.sh`, remove the template marker from the generated instance, update the instance's ECC source lock and sync latest ECC assets by default, and leave the instance as an independent Git repository. Work inside that instance for product repos and local routing state.

From the template root, `scripts/sync-workspace-instance.sh <name>` should refresh only the selected `.workspaces/<name>` instance. By default it should run that instance's `scripts/sync-ecc.sh --update-lock --force`, then run the instance doctor when available. It should support `--list` so Codex can ask the user to choose an instance when the target is unclear.

`scripts/import-repo.sh` is the preferred repository onboarding entrypoint. It should accept either a Git URL or a local Git repository path. From an instance root, it imports into the current instance. From a template root, it should require `--instance <name>` or `--new-instance <name>` and support `--list-instances` so Codex can ask the user where to place the repository before mutating anything.

## Sync Semantics

Standard refresh:

```bash
scripts/sync-ecc.sh --update-lock --force
```

This updates the Nix `ecc-src` lock when the workspace is running from a Nix store `ECC_SRC`; otherwise it updates `ecc-source.lock.json` through the portable Git resolver. It then copies upstream ECC assets into:

- `AGENTS.ecc.md`
- `.codex/`
- `.codex/hooks.json`
- `.agents/skills/`
- `.codex/prompts/`
- `.codex/git-hooks/`
- `.ecc/source/`

When refreshing inside an instance, run the same command from the instance root. It updates that instance's copied ECC assets and does not dirty the template repository above `.workspaces/`.

When refreshing an instance from the template root, use:

```bash
scripts/sync-workspace-instance.sh <name>
```

This is the root-level orchestration path for "update this workspace's ECC configuration".

After copying skills into `.agents/skills/`, sanitize Codex skill frontmatter for the current Codex loader. At minimum, ensure each `SKILL.md` has YAML frontmatter and keep `description` at or below 1024 characters. Keep `.ecc/source/` as the upstream mirror; apply compatibility edits only to the workspace-local `.agents/skills/` copy.

After copying, sanitize `.codex/config.toml` for project-local use. In
particular, remove `notify` and `[profiles.*]`; current Codex warns that those
keys are user-level only and should live in `~/.codex/config.toml` if the user
wants them globally.

Strict mirror refresh:

```bash
scripts/sync-ecc.sh --update-lock --force --prune
```

This removes old copied ECC paths before copying. Use it only when removing stale upstream files matters more than preserving local additions under those directories.

## Multi-Repo Rules

- Treat each direct child under `repos/` as an independent project.
- Route tasks from `repos.yaml`, not by guessing.
- In template mode, bootstrap an instance before adding product repositories.
- Before editing a child repo, inspect its README, AGENTS.md, build files, and tests.
- Run verification commands inside each affected child repo.
- Never commit or push unless the user explicitly asks.

## Safety Checks

Run these after creating or refreshing a workspace:

```bash
direnv exec . printenv CODEX_ECC_WORKSPACE
direnv exec . printenv ECC_SRC
direnv exec . printenv CODEX_ECC_RUNTIME
nix flake check --no-build
node --check scripts/codex-session-adapter.js
node --check scripts/codex-observe-session.js
node --check scripts/codex-session-metrics.js
node --check scripts/codex-replay-ecc-hooks.js
node --check scripts/codex-native-hook-adapter.js
node --check scripts/generate-codex-native-hooks.js
node --check scripts/codex-ecc-doctor.js
bash -n scripts/init-ecc-workspace.sh scripts/add-repo.sh scripts/import-repo.sh scripts/codex-workspace scripts/ecc-workspace scripts/sync-ecc.sh scripts/sync-workspace-instance.sh scripts/install-ecc-git-hooks.sh
bash -n scripts/ecc-env.sh scripts/resolve-ecc-source.sh
bash -n scripts/bootstrap-workspace-instance.sh
scripts/codex-ecc-doctor.js
git status --short
```
