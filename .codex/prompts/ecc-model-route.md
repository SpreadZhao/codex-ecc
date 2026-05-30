# ECC Command Prompt: /model-route

Source: /nix/store/7bmy0z0ymx3hgjbhiiixxi0f43djs56c-source/commands/model-route.md

Use this prompt to run the ECC `model-route` workflow in Codex.


# Model Route Command

Recommend the best model tier for the current task by complexity and budget.

## Usage

`/model-route [task-description] [--budget low|med|high]`

## Routing Heuristic

- `haiku`: deterministic, low-risk mechanical changes
- `sonnet`: default for implementation and refactors
- `opus`: architecture, deep review, ambiguous requirements

## Required Output

- recommended model
- confidence level
- why this model fits
- fallback model if first attempt fails

## Arguments

$ARGUMENTS:
- `[task-description]` optional free-text
- `--budget low|med|high` optional
