# opencode-bash-guard

An opencode plugin that guards against chained bash command injection. When `git status && rm -rf /` starts with `git`, opencode's native glob matching sees a safe command. This plugin splits chains and checks each segment independently against your `permission.bash` and `external_directory` config, so the `rm` segment gets evaluated on its own.

## Why

opencode's `permission.bash` matches glob patterns against the full command string. Chaining (`&&`, `||`, `;`, `|`) lets dangerous commands hide behind safe prefixes — `git status && rm -rf /` starts with `git` and matches `"git *": "allow"`. This plugin closes that gap by splitting chains and evaluating each segment independently. On any parse error the entire command is denied (fail-closed).

## How it works

1. **Chain Detection**: Parses the command with `unbash` AST into individual segments (including `$()` and backtick substitutions, `eval`, `sh -c`, etc.)
2. **Path Extraction**: Walks the AST to extract file paths, using `@withfig/autocomplete` specs to distinguish flags from paths
3. **Config Reading**: Reads `permission.bash` and `external_directory` from the merged opencode config — supports flat strings and object patterns
4. **Enforcement**: Most-restrictive-wins across segments — deny > ask > no action. Multi-segment chains trigger `ask` even when all segments are allowed individually (defense-in-depth)

## Install

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-bash-guard"]
}
```

## Prerequisite

Your bash permission **must** use `"*": "ask"` as the fallback pattern. Without this catch-all, commands that don't match any explicit rule would bypass permission checks:

```json
{
  "permission": {
    "bash": {
      "*": "ask",
      "git *": "allow",
      "npm *": "allow"
    }
  }
}
```

If `"bash": "allow"` or `"*": "allow"` is set, the plugin disables itself with a warning — allowing all bash commands defeats the purpose of chain-level guards.

## Example

| Command | Segments | Bash match | Chain action | Why |
|---|---|---|---|---|
| `git status` | `git status` | `"git *": "allow"` | `allow` | single segment, explicitly allowed |
| `git status && git log` | `git status`, `git log` | both `"git *": "allow"` | `ask` | multi-segment — defense-in-depth |
| `sudo rm -rf /` | `sudo rm -rf /` | none → `"*": "ask"` | `ask` | catches unknown dangerous commands |
| `git status && sudo rm -rf /` | `git status`, `sudo rm -rf /` | `sudo rm -rf /` → `"*": "ask"` | `deny` | parse error → fail closed |
| `echo "hello` | (parse error — unbalanced quote) | — | `deny` | fail closed |

## How it reads your config

The plugin registers a `config` hook that receives the fully merged Config object at startup (opencode merges remote, global, project, and managed layers). It reads:

- `permission.bash` — glob patterns (object form `{ "git *": "allow", "*": "ask" }` or flat string `"ask"`)
- `permission.external_directory` — path patterns (object form `{ "./**": "allow", "*": "ask" }` or flat string `"ask"`)

No custom configuration files or duplicated rules.

## Known Limitations

- **Config changes at runtime**: The `config` hook fires once at startup. Config changes require an opencode restart.
- **Path extraction misses**: Fig may not have specs for all commands. Falls back to heuristic (skip `-*` tokens). If false positives occur, add more specific bash permission rules.
- **Performance**: AST parsing is heavier than string scanning, but only runs when chain operators (`&&`, `||`, `;`, `|`) are detected.
- **unbash edge cases**: Complex shell syntax may cause partial parses. The plugin denies the entire command (fail closed) on any parse error — safer to miss a real command than let one through.
- **Not a sandbox**: Focused on chain-splitting with path awareness, not comprehensive shell obfuscation detection. For full isolation, pair with a sandbox solution.


