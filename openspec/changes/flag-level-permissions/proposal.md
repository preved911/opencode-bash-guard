## Why

`permission.bash` glob patterns match against the whole command string, so they cannot express flag-level intent. A user who wants `curl -X GET` allowed but every other `curl` invocation asked must resort to fragile full-string patterns — and ordering/overlap between broad and narrow patterns is undefined behavior territory (`"curl *": "ask"` catches `curl -X GET https://api.com` even when a narrower `"curl -X GET *": "allow"` exists elsewhere). Dangerous flags like `find ... -delete`, `git push --force`, or `rm -rf` deserve their own actions independent of the command's general permission. The plugin already splits commands into segments; it is the right place to evaluate segments against arg/flag-aware rules.

## What Changes

- **New config section `permission.bash_args`** — ordered array of rules `{ "pattern": "curl -X GET *", "action": "allow" }` matching a segment's command name and arguments as whitespace tokens
- **Token-based pattern matching** — `*` in a pattern matches any run of zero or more argument tokens (`curl -X GET *`, `find * -delete`); matching is anchored at the first token (the command name)
- **First-match-wins precedence** — rules are evaluated in declared array order; the first matching rule decides the segment's bash action. Specific rules before broad rules is the documented convention
- **Args rules take precedence over glob rules** — a segment is checked against `bash_args` first; if no args rule matches, existing `permission.bash` glob matching applies unchanged
- **Force-allow for flag rules** — when an args rule matches with `allow`, the plugin stores the decision and overrides a native opencode `ask` via `permission.ask` (`status = "allow"`), making `curl -X GET *` → allow genuinely effective even when the native fallback is `"curl *": "ask"`. Glob-only allows keep today's behavior (no intervention)
- **Chain integration** — args-rule actions participate in existing segment resolution and most-restrictive-wins chain aggregation; `deny`/`ask` still wrap and store as today

## Capabilities

### New Capabilities
- `args-permission-matching`: Parse `permission.bash_args` rules, match segments by command + argument tokens with wildcard support, resolve precedence, and enforce flag-level allow/ask/deny decisions

### Modified Capabilities

None (the base `opencode-bash-guard` change is not yet archived; behavioral extensions to `config-reader` and `enforcement` are expressed as added requirements inside `args-permission-matching`).

## Impact

- Config: optional new `permission.bash_args` array in `opencode.json` — absent section means zero behavior change
- Code: `src/config.ts` (new rule type, parsing, token matcher), `src/enforce.ts` (resolution order, stored allow decisions), `src/index.ts` (permission.ask may set `status = "allow"`)
- Docs: README section with rule examples and ordering guidance
- No new dependencies
