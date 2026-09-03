## Why

Complex one-liners (`a && b && c`, nested `$()`, `eval`/`sh -c` wrappers) are hard for humans to review, and today they pass **silently** when every segment matches an allow rule — the agent has no incentive to write readable commands, and no mechanism tells it to restructure. Prompt-level guidance (AGENTS.md) is a soft constraint with no verification loop. The right fix is a deterministic one: reject the command with an instructive error so the agent re-issues it in a reviewable form.

The enforcement mechanism is verified against opencode's plugin API: an error thrown in `tool.execute.before` is converted into a tool result with `resultType: "error"`, and the error text is sent back to the model (official docs pattern: `throw new Error("Do not read .env files")`). The `permission.ask` hook cannot serve this role — its output carries only `status` with no message field.

## What Changes

- **Complexity detection** — segment count and substitution nesting depth, computed from the existing `unbash`-based chain parse; meta-commands (`eval`, `sh -c`, `bash -c`, `zsh -c`) already count as segments
- **Reject-with-guidance** — when limits are exceeded, the plugin throws in `tool.execute.before`; nothing executes, and the error text tells the model exactly how to comply: re-issue as separate bash tool calls or a multi-line script with one command per line (each line is then parsed and permission-checked individually)
- **New config section `permission.bash_restructure`** — `{ "max_segments": 3, "max_depth": 2 }`; presence enables the feature, absent means zero behavior change; values validated, defaults applied for missing fields
- **Scope: silent-pass chains only** — restructuring fires when the chain would run without interruption (no opinion or fully allowed); `deny`/`ask`/parse-error flows are unchanged (deny means "don't do it at all"; ask already surfaces the command to a human)
- **README correction** — remove the stale "multi-segment chains trigger ask (defense-in-depth)" claim (implementation and spec say fully-allowed chains pass through); document the actual behavior
- **AGENTS.md guidance** — README snippet users can add for a soft layer that reduces rejection frequency

## Capabilities

### New Capabilities
- `chain-restructuring`: Detect overly complex one-liner bash commands and reject them with actionable guidance so the agent re-issues readable, individually-checkable commands

### Modified Capabilities

None (README behavioral correction is documentation, not a spec change; the base `opencode-bash-guard` change is not yet archived).

## Impact

- Config: optional new `permission.bash_restructure` object in `opencode.json` — absent section means zero behavior change
- Code: `src/chain.ts` (expose nesting depth), `src/config.ts` (parse new section), `src/enforce.ts` (reject path in `beforeExecute`)
- Docs: README new section + behavior correction + AGENTS.md snippet
- No new dependencies
