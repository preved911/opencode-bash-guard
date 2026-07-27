# opencode-bash-guard

An opencode plugin that parses chained bash commands into segments and checks each against your existing `permission.bash` and `external_directory` config.

## Why

opencode's `permission.bash` matches glob patterns against the full command string. Chaining (`&&`, `||`, `;`, `|`) lets dangerous commands hide behind safe prefixes — `git status && rm -rf /` starts with `git` and matches `"git *": "allow"`. This plugin closes that gap by splitting chains and evaluating each segment independently.

## How It Works

1. **Chain Detection**: Parses the bash command string using `unbash` AST parser into individual segments
2. **Path Extraction**: Walks the AST to extract file paths, using `@withfig/autocomplete` specs to distinguish flags from paths
3. **Config Reading**: Reads your existing `permission.bash` and `external_directory` from opencode.json — no custom rules needed
4. **Enforcement**: Most-restrictive-wins — deny > ask > no action

## Install

```json
{
  "plugin": ["opencode-bash-guard"]
}
```

## Prerequisite

Your bash permission config must use `"*": "ask"` as the fallback (not `"allow"`):

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

If `"bash": "allow"` or `"*": "allow"`, the plugin disables itself with a warning.

## How It Reads Your Config

The plugin registers a `config` hook to receive the merged Config object at startup. It reads:

- `permission.bash` — glob patterns (object form or flat string)
- `permission.external_directory` — path patterns (object form or flat string)

No custom configuration files or duplicated rules needed.

## Known Limitations

- **Config changes at runtime**: The `config` hook fires once at startup. Config changes require an opencode restart.
- **Path extraction misses**: Fig may not have specs for all commands. Falls back to heuristic (skip `-*` tokens).
- **Performance**: AST parsing is heavier than string scanning, but only runs when chain ops are detected.
- **unbash edge cases**: Complex shell syntax may cause partial parses. The plugin denies the entire command (fail closed) on any parse error.
- **Not a sandbox**: Focused on chain-splitting with path awareness, not comprehensive shell obfuscation detection.


