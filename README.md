# opencode-bash-guard

opencode plugin that guards against dangerous bash command chaining. Detects when chaining operators (`&&`, `||`, `;`, `|`) are used to hide dangerous commands behind safe prefixes like `git *`.

## Problem

opencode's `permission.bash` matches glob patterns against the full command string. This means `git status && rm -rf /` starts with `git` and matches `"git *": "allow"` — the `rm -rf /` is invisible to the permission system. Only `bash` has this vulnerability; other tools use structured single-intent inputs.

## Prerequisite

Your `permission.bash` config MUST have `"*": "ask"`:

```json
{
  "permission": {
    "bash": {
      "*": "ask",
      "git *": "allow",
      "go mod tidy*": "allow"
    }
  }
}
```

Without `"*": "ask"`, the `permission.ask` hook never fires and the plugin cannot intercept commands. The plugin will warn and disable itself at startup if `"bash": "allow"` is detected.

## Installation

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-bash-guard"]
}
```

opencode auto-installs npm plugins at startup — no manual `npm install` needed.

## How it works

1. `tool.execute.before` hook intercepts every bash call
2. `unbash` parser splits the command into chain segments (`&&`, `||`, `;`, `|`, `$()`, backticks)
3. Recursively extracts commands from `eval`, `sh -c`, `bash -c` arguments
4. Each segment's command name is checked against your `permission.bash` patterns
5. File paths are extracted via `unbash` AST + `@withfig/autocomplete` specs and checked against `external_directory`
6. `permission.ask` hook applies the resolved action

### Decision logic

| Scenario | Action |
|---|---|
| Single segment, matches allow pattern | Let through — existing permission rules handle it |
| Multi-segment chain, ALL segments explicitly allowed | Let through — `git status && git log` |
| Multi-segment chain, any segment NOT allowed | Wrap in `{ ... }` → `"*": "ask"` catches → native opencode dialog |
| Any segment matches deny pattern | Wrap → `permission.ask` sets deny → blocked silently |
| Path outside `external_directory` | Apply `external_directory`'s action (ask/deny/allow) |
| Parse error | Deny (fail closed) |

### Example flows

```
git status                              → runs (matches "git *": "allow")
git status && git log                   → runs (both match "git *": "allow")
git status && rm -rf /                  → wrapped → user prompted
sudo rm -rf /                           → wrapped → permission.ask denies
cat /etc/passwd                         → external_directory → user prompted
echo "hello"                            → no rule match → opencode handles via "*": "ask"
eval "rm -rf /"                         → recursive parse catches rm → user prompted
```

## Dependencies

- `unbash` — zero-dependency TypeScript bash AST parser
- `@withfig/autocomplete` — CLI argument specs for flag vs path detection

## Configuration

No custom configuration required. The plugin reads your existing `permission.bash` and `external_directory` from opencode's merged config via the `config` hook.

## License

ISC
# test
