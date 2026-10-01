## Why

opencode's `permission.bash` matches glob patterns against the full command string. Chaining (`&&`, `||`, `;`, `|`) lets dangerous commands hide behind safe prefixes — `git status && rm -rf /` starts with `git` and matches `"git *": "allow"`. Additionally, `external_directory` checks don't apply to individual segments in a chain. The plugin closes both gaps.

## What Changes

- **New plugin: `opencode-bash-guard`** — parses chained bash commands into segments, checks each against the user's existing `permission.bash` and `external_directory` config
- **Chain detection**: multi-segment commands where not ALL segments are explicitly allowed trigger `ask` — native opencode permission dialog
- **Bash permission matching**: each segment checked against `permission.bash` patterns; deny match → whole chain denied
- **Path scope checking**: file paths extracted and checked against `external_directory` patterns; violations apply `external_directory`'s action
- **Most-restrictive-wins**: deny > ask > no action across all segments and all checks
- **Path extraction**: `unbash` AST + `@withfig/autocomplete` specs for accurate flag vs path distinction

## Capabilities

### New Capabilities
- `chain-detection`: Parse chained bash commands into segments using `unbash` AST
- `config-reader`: Read `permission.bash` and `external_directory` from opencode.json
- `path-extraction`: Walk AST + Fig specs to identify file path arguments
- `enforcement`: Dual-hook to wrap chains and resolve deny/ask/no-action

### Modified Capabilities

None.

## Impact

- New npm package: `opencode-bash-guard` on opencode.cafe
- Dependencies: `unbash`, `@withfig/autocomplete`
- Config: add `"opencode-bash-guard"` to `plugin` array
- Prerequisite: `"*": "ask"` in `permission.bash`
