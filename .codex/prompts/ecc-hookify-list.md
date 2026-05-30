# ECC Command Prompt: /hookify-list

Source: /nix/store/7bmy0z0ymx3hgjbhiiixxi0f43djs56c-source/commands/hookify-list.md

Use this prompt to run the ECC `hookify-list` workflow in Codex.


Find and display all hookify rules in a formatted table.

## Steps

1. Find all `.claude/hookify.*.local.md` files
2. Read each file's frontmatter:
   - `name`
   - `enabled`
   - `event`
   - `action`
   - `pattern`
3. Display them as a table:

| Rule | Enabled | Event | Pattern | File |
|------|---------|-------|---------|------|

4. Show the rule count and remind the user that `/hookify-configure` can change state later.
