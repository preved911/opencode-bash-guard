## Why

opencode's `permission.bash` globs match against the whole command string, so they cannot express flag-level intent. A user who wants `curl -X GET` allowed but every other `curl` invocation asked must resort to fragile full-string patterns, and dangerous flags like `find ... -delete`, `git push --force`, or `rm -rf` deserve their own actions independent of the command's general permission. The plugin already splits chains into segments; it is the right place to evaluate segments against arg/flag-aware rules.

Because these rules are bash-guard's own vocabulary — structured per-tool arg matching that opencode's permission block cannot express — they belong in the **plugin's own config** (`opencode-bash-guard.jsonc`), not in opencode's config. The existing check pipeline is preserved:

1. **bash-guard config level** — arg/flag rules decide the segment when they match
2. **opencode's permission block level, evaluated by bash-guard** — existing `permission.bash` glob checks apply when no arg rule matched
3. **opencode's permission checks** — the native prompt/dialog still fires when required

## What Changes

- **New plugin config section `permissions`** in `opencode-bash-guard.jsonc` — an array of per-tool entries `{ "tool": "find", "args": [...] }`, one entry per command whose flags need their own policy
- **Structured arg matchers** (replaces whole-string patterns):
  - `token` — exact arg token match, for flags (`-delete`) and subcommands (`push`)
  - `position` + `pattern` — a positional slot (`position: 0`) or every remaining positional token (`position: "each"`, all of them must match) checked against a value glob (e.g. first path argument under `/Users/me/work/*`, or all paths of a variable-arity command confined to the work tree)
  - `valuePattern` — glob against the value that follows a matched flag (`-name "*.log"`)
  - `action` — `"allow" | "ask" | "deny"` per matcher
- **Most-restrictive-wins** — all arg matchers a segment matches contribute their actions; the most restrictive one decides (deny > ask > allow). Declaration order is irrelevant; no shadowing
- **Nested permission declarations** — an arg matcher that matches a subcommand token can declare nested `args` for the remaining tokens (`git push --force` → `push` allows, nested `--force` denies)
- **Check pipeline** — args rules first; unmatched segments fall through to the existing `permission.bash` glob evaluation unchanged; `ask` still reaches the native opencode dialog
- **Args-level allow overrides a native ask** — stored decision + `permission.ask` (`status = "allow"`), so `curl -X GET * → allow` genuinely works over a native `"curl *": "ask"` fallback
- **Zero behavior change** when the `permissions` section is absent

## Capabilities

### New Capabilities
- `args-permission-matching`: Read the plugin config file, parse `permissions` tool entries, match segments by structured arg matchers (token / position+pattern / valuePattern, with nesting), resolve most-restrictive-wins, and enforce flag-level allow/ask/deny decisions ahead of the existing glob checks

### Modified Capabilities

None (the base `opencode-bash-guard` change is not yet archived; behavioral extensions to `config-reader` and `enforcement` are expressed as added requirements inside `args-permission-matching`).

## Impact

- Config: optional new `permissions` array in `opencode-bash-guard.jsonc` (plugin-owned file; absent file/section means zero behavior change)
- Code: config file reader (JSONC via `jsonc-parser` — new dependency), `src/config.ts` (rule schema, validation, matcher engine), `src/enforce.ts` (resolution order, stored allow decisions), `src/index.ts` (`permission.ask` may set `status = "allow"`)
- Docs: README section describing the two-level permission model with examples
- No changes to opencode's config format; `permission.bash` and `external_directory` keep working exactly as today
