## Context

opencode's `permission.bash` evaluates glob patterns against the full command string as-is. A command like `echo "ok" && rm -rf /` does not match `"rm *": "deny"` because the string starts with `echo`. Only `bash` has this vulnerability — other tools (edit, read, grep) use structured single-intent inputs.

The user's config: `"bash": { "*": "ask", "git *": "allow", "go mod tidy*": "allow", "go get *": "allow" }`, `"external_directory": "ask"`. The plugin must integrate with this setup.

## Goals / Non-Goals

**Goals:**
- Parse chained bash commands into segments (`&&`, `||`, `;`, `|`, `$()`, backticks, newlines) using `unbash` AST
- Read `permission.bash` and `external_directory` from opencode.json
- Extract file paths from each segment using `unbash` AST + `@withfig/autocomplete` specs
- For each segment, make a decision based on: bash permission patterns, external_directory path checks, and chain position
- If any segment resolves to `deny` → deny whole chain
- If chain has 2+ segments → ask whole chain
- If a path-based command touches paths outside `external_directory` → apply `external_directory`'s action
- Single segment, no deny, paths within scope → let opencode handle normally

**Non-Goals:**
- Not maintaining its own rule lists — relies on user's existing permission config
- Not a sandbox — purely a chain-splitting guard with path awareness
- Not handling every possible obfuscation

## Decisions

1. **Chain parser using `unbash`** — Zero-dependency TypeScript bash AST parser. Parses the full command string into AST. Extract each top-level command (separated by `&&`, `||`, `;`, `|`, newlines) as a segment. Additionally, recursively walk the AST to extract commands nested inside `$(...)` and backtick `` `...` `` substitutions. Also recognize meta-commands (`eval`, `sh -c`, `bash -c`, `zsh -c`) and recursively parse their string arguments as command strings. More reliable than regex — handles quotes, escapes, substitutions correctly.

2. **Path extraction via `unbash` AST + optional `@withfig/autocomplete`** — Walk the AST of each segment to find word arguments. Use heuristic first (skip tokens starting with `-`). Optionally load `@withfig/autocomplete` specs to distinguish flags from path arguments more accurately — loaded lazily only when needed, not at startup. Resolve relative paths against cwd.

3. **Read config via opencode's `config` hook** — The plugin registers a `config` hook that receives the fully merged Config object (remote + global + project + managed layers). Extract:
   - `permission.bash` patterns — glob patterns for command matching with allow/ask/deny actions
   - `external_directory` — path patterns for filesystem scoping with ask/allow/deny
   
   The merged config is authoritative — it reflects all layers that opencode itself uses.

4. **Segment resolution logic** — For each segment, resolve to the most restrictive action:
   ```
   If segment matches bash permission "deny"    → deny
   If segment's paths violate external_directory  → apply external_directory's action
   Otherwise                                     → allow (segment is safe)
   ```
   **Whole chain action**: if ALL segments are `allow`, let through without interruption. If ANY segment is not `allow` (either has no match in bash patterns, or resolved to `ask`/`deny`), the whole chain takes that segment's action. Most restrictive across segments: deny > ask > allow.

5. **Enforcement via dual-hook**:
   - `tool.execute.before`:
     - **No action** → do nothing, opencode handles normally
     - **Deny** → wrap chain in `{ ... ; }`, store `callID → "deny"`
     - **Ask** → wrap chain in `{ ... ; }`, store `callID → "ask"`
   - `permission.ask`:
     - `"deny"` stored → `output.status = "deny"`
     - `"ask"` stored → do nothing, user sees native opencode prompt
     - Not found → plugin has no opinion, opencode proceeds normally

6. **Prerequisite**: `"*": "ask"` in bash permission. Plugin warns and disables if `"bash": "allow"`.

7. **Distribution as npm package on opencode.cafe**.

## Risks / Trade-offs

- **[Path extraction misses]** Fig may not have specs for all commands. Mitigation: heuristic fallback (skip `-*` tokens). Fig is loaded lazily, not at startup.
- **[Config availability]** `config` hook fires once at startup. If the config changes at runtime, the plugin won't see it. Mitigation: config changes require opencode restart anyway.
- **[Performance]** AST parsing is heavier than string scanning. Mitigation: unbash is fast, only parse when chain is detected.
- **[unbash parsing edge cases]** Complex shell syntax may cause partial parses. Mitigation: any parse error causes the plugin to deny the entire command (fail closed).
