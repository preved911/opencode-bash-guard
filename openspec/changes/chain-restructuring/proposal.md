## Why

Complex one-liners (`a && b && c`, nested `$()`, `eval`/`sh -c` wrappers) are hard for humans to review. Today a not-allowed multi-step command surfaces to the human as an unreadable blob in the permission dialog, and the agent has no incentive to write readable commands. Prompt-level guidance (AGENTS.md) is a soft constraint with no verification loop. The right fix is deterministic: reject the not-allowed one-liner with an instructive error so the agent re-issues it in a reviewable form.

**Allowed actions stay allowed** — restructuring never touches chains that pass permission checks. The feature targets exactly the commands a human will be asked to review.

The enforcement mechanism is verified against opencode's plugin API: an error thrown in `tool.execute.before` is converted into a tool result with `resultType: "error"`, and the error text is sent back to the model (official docs pattern: `throw new Error("Do not read .env files")`). The `permission.ask` hook cannot serve this role — its output carries only `status` with no message field.

## What Changes

- **Separate plugin config file `opencode-bash-guard.jsonc`** — read from the opencode config dirs (global `~/.config/opencode/`, project `.opencode/`), JSONC format (comments allowed), deep-merged with project over global. Permission *actions* stay in `opencode.json`; plugin *behavior tuning* lives here
- **`restructure` section with nested fields** — `{ "enabled": false, "max_segments": 3, "max_depth": 2 }`; **disabled by default** → zero behavior change
- **Complexity detection** — segment count and substitution nesting depth from the existing `unbash`-based chain parse; meta-commands (`eval`, `sh -c`, `bash -c`, `zsh -c`) count as segments
- **Reject-with-guidance on ask-resolving chains only** — when enabled, limits exceeded, and the chain resolves to `ask` (not allowed → human review), the plugin throws in `tool.execute.before`; nothing executes, and the error text tells the model to re-issue as separate bash tool calls or a multi-line script with one command per line
- **One-liner targeting** — the segment limit applies to single-line commands; multi-line scripts are the compliant form and are exempt from the segment limit (still depth-checked), so a compliant re-issue always exists
- **README correction** — remove the stale "multi-segment chains trigger ask (defense-in-depth)" claim (implementation and spec say fully-allowed chains pass through); document the JSONC config and an AGENTS.md snippet (soft layer reducing rejection frequency)

## Capabilities

### New Capabilities
- `chain-restructuring`: Detect overly complex one-liner bash commands that would require human review and reject them with actionable guidance so the agent re-issues readable, individually-checkable commands

### Modified Capabilities

None (README behavioral correction is documentation, not a spec change; the base `opencode-bash-guard` change is not yet archived).

## Impact

- New optional config file `opencode-bash-guard.jsonc` — absent or `restructure.enabled: false` means zero behavior change
- New dependency: `jsonc-parser` (JSONC parsing with comments/trailing commas)
- Code: `src/chain.ts` (expose nesting depth), new config-loader module (file discovery, JSONC parse, merge, validation), `src/enforce.ts` (reject path in `beforeExecute`)
- Docs: README new section + behavior correction + AGENTS.md snippet
