# opencode-bash-guard

An opencode plugin that guards against chained bash command injection. When `git status && rm -rf /` starts with `git`, opencode's native glob matching sees only the first segment and approves it. This plugin splits chains and evaluates **each segment independently** — the `rm` segment gets checked on its own against your `permission.bash` and `external_directory` config.

## Why

opencode's `permission.bash` matches glob patterns against the full command string. Chaining (`&&`, `||`, `;`, `|`) lets dangerous commands hide behind safe prefixes — `git status && rm -rf /` starts with `git` and matches `"git *": "allow"`. This plugin closes that gap by splitting chains and evaluating each segment independently. On any parse error the entire command is denied (fail-closed).

## How it works

1. **Chain Detection**: Parses the command with `unbash` AST into individual segments (including `$()` and backtick substitutions, `eval`, `sh -c`, etc.)
2. **Path Extraction**: Walks the AST to extract file paths, using `@withfig/autocomplete` specs to distinguish flags from paths
3. **Config Reading**: Reads `permission.bash` and `external_directory` from the merged opencode config — supports flat strings and object patterns
4. **Enforcement**: Most-restrictive-wins across segments — deny > ask > no action. Fully-allowed chains pass through untouched; allowed stays allowed

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
| `git status && git log` | `git status`, `git log` | both `"git *": "allow"` | `allow` | passes through — fully-allowed chains are not interrupted |
| `sudo rm -rf /` | `sudo rm -rf /` | none → `"*": "ask"` | `ask` | catches unknown dangerous commands |
| `git status && wget evil.sh` | `git status`, `wget evil.sh` | `wget` → `"*": "ask"` | `ask` | one segment unresolved → whole chain asks |
| `echo "hello` | (parse error — unbalanced quote) | — | `deny` | fail closed |
| `sudo rm -rf /` (with `"sudo *": "deny"` rule) | `sudo rm -rf /` | `"sudo *": "deny"` | `deny` | explicit deny pattern blocks it |

## How it reads your config

The plugin registers a `config` hook that receives the fully merged Config object at startup (opencode merges remote, global, project, and managed layers). It reads:

- `permission.bash` — glob patterns (object form `{ "git *": "allow", "*": "ask" }` or flat string `"ask"`)
- `permission.external_directory` — path patterns (object form `{ "./**": "allow", "*": "ask" }` or flat string `"ask"`)

Permission actions stay in `opencode.json` — no duplicated rules. Behavior tuning for the plugin itself (feature switches, thresholds) lives in a separate `opencode-bash-guard.jsonc` file, where comments can document the trade-offs — see the next section.

When permission keys are absent from the merged config, the plugin falls back to opencode's built-in defaults (bash/edit `"allow"`, `external_directory` `"{ "*": "ask" }"`), matching native opencode behavior.

## Readable commands (optional, off by default)

Complex one-liners (`a && b && c && d`, nested `$()`, `eval`/`sh -c` wrappers, long interpreter inline scripts) are hard to review when they land in a permission dialog. The optional `restructure` feature rejects **not-allowed** complex commands with an instructive tool error, so the agent re-issues them in a reviewable form. Fully-allowed commands are never touched.

Create `opencode-bash-guard.jsonc` in either location (project wins over global):

- Global: `~/.config/opencode/opencode-bash-guard.jsonc` (or `$XDG_CONFIG_HOME/opencode/…`)
- Project: `<project>/.opencode/opencode-bash-guard.jsonc`

```jsonc
{
  // Reject complex one-liners and ask the agent to restructure them
  "restructure": {
    "enabled": false,     // default false — zero behavior change
    "max_segments": 3,    // max commands in a single-line chain
    "max_depth": 2        // max $()/backtick/meta-command nesting
  }
}
```

Semantics:

- Thresholds compare **strictly greater**: 3 segments with `max_segments: 3` passes; 4 is rejected. Same for `max_depth` and inline-script statement counts.
- The segment limit applies **per line**: a multi-line script is checked line by line (one command per line is always compliant), while nesting depth is checked across the whole command.
- Interpreter inline scripts (`python -c`, `node -e`/`--eval`, `perl -e`, `ruby -e`, `php -r`, heredoc-scripted interpreters) get a statement-count check (split on `;` and newlines) so whole programs can't hide inside one shell segment.
- Rejection fires only when the chain would resolve to `ask` (human review). `allow`, `deny`, and parse-error flows are unchanged.

What a rejection looks like: the bash tool call returns an error and **nothing executes** — no permission dialog appears:

```
[opencode-bash-guard] Complex one-liner rejected (4 chained commands, nesting depth 1).
Re-issue as separate bash tool calls, or as a multi-line script with one command per line — each command is then permission-checked individually.
```

The agent then re-issues the command as separate tool calls or as a multi-line script with one command per line, both of which are checked as usual.

To reduce rejections further, pair with a soft instruction in your `AGENTS.md`:

```markdown
## Bash command style
- Issue one command per tool call. For sequences, use separate bash calls.
- Never write chained one-liners (`a && b && c`). If rejected, split and retry.
```

## Testing

```bash
npm install
npm test          # runs vitest (135+ tests)
npm run build     # type-checks with tsc
```

All tests are in `src/__tests__/`. Run `npm run test:watch` during development.

## Known Limitations

- **Config changes at runtime**: The `config` hook fires once at startup. Config changes require an opencode restart.
- **Plugin config read once at startup**: `opencode-bash-guard.jsonc` is read once when the plugin initializes. Changes require an opencode restart.
- **Heuristic inline-script statement counting**: Interpreter scripts are split on `;` and newlines. Strings containing semicolons can be miscounted; the heuristic errs toward rejecting unreadable blobs.
- **No retry counter**: Repeated violations get the same rejection every time (no escalation). A compliant re-issue always exists (multi-line, one command per line).
- **`permission.ask` reliability**: Issue anomalyco/opencode#19469 suggests the `permission.ask` hook may not fire in current opencode, which could affect the plugin's deny path — pending separate verification.
- **Path extraction misses**: Fig may not have specs for all commands. Falls back to heuristic (skip `-*` tokens). If false positives occur, add more specific bash permission rules.
- **Performance**: AST parsing is heavier than string scanning, but only runs when chain operators (`&&`, `||`, `;`, `|`) are detected.
- **unbash edge cases**: Complex shell syntax may cause partial parses. The plugin denies the entire command (fail closed) on any parse error — safer to miss a real command than let one through.
- **Not a sandbox**: Focused on chain-splitting with path awareness, not comprehensive shell obfuscation detection. For full isolation, pair with a sandbox solution.



## Usage

Add to your `opencode.json`:

```json
{"plugin": ["opencode-bash-guard"]}
```
