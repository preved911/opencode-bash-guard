## Why

The current command-path matcher accepts an array of tokens and checks their presence in the segment, but preserves neither their order, nor their positions, nor their membership in one contiguous command path. A rule written for `<executable> <primary-command> <secondary-command>` also matches `<executable> <positional> <primary-command> <secondary-command>` and matches when the same tokens surface inside a differently rooted command. A `token` + `pattern` matcher searches for its adjacent pair anywhere in `argv`, so a pair meant to authorize one exact command also authorizes unrelated commands that merely contain the pair. Both hazards can widen permissions without any warning: the config says one command, the engine allows another.

The historical nested `args` form did not provide a correct conjunction either — the parent action was applied before the child matcher was ever checked — and its removal in favor of an order-free token array traded that bug for the anchoring gap above.

## What Changes

- Introduce an explicit token model for every segment: `executable`, command-path levels, flags, flag values, ordinary positionals, and trailing arguments after `--`.
- Redefine an array `token` as an **ordered, anchored, contiguous command path**: levels are matched in order against the leading positional command tokens that follow `<executable>`; flags and their recognized values may appear before, between, and after levels without affecting the result; a foreign positional before the first level or between levels breaks the match; trailing arguments after the complete path are allowed.
- Ground flag arity in configuration: a value matcher (`token` + `pattern`) or the per-entry `flags` arity table declares a flag value-taking; such a flag consumes exactly one following value atomically. An undeclared flag is treated as value-less (fail-closed: its would-be value stays a positional and therefore breaks anchored path matching).
- Restrict `pattern` to flag tokens: a `token` + `pattern` matcher remains the atomic `<flag>` + `<flag-value>` pair form, but its `token` MUST start with `-`; a non-flag token with `pattern` is rejected at validation (warn-and-drop) instead of acting as an implicit command path.
- Position matching operates on the structural positional list (declared flag values are no longer positionals).
- Keep refinement-then-most-restrictive resolution, fail-safe `ask` defaults, the glob fallback, chain aggregation, and degraded mode unchanged.
- **BREAKING** Array-token matching becomes anchored and ordered (previously order-free anywhere in `argv`); non-flag `token` + `pattern` matchers are rejected; declared flag values no longer occupy positional slots.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `args-permission-matching`: Redefine array-token matching as an ordered, anchored, contiguous command path over an explicit token model; ground flag arity in configuration; restrict `pattern` to flag tokens; align positional matching with the structural positional list.

## Impact

- Plugin permission configuration in `opencode-bash-guard.jsonc`: array-token matchers, value matchers on non-flag tokens, `position` matchers counting over dash-less flag values, and any config relying on order-free path matching.
- User-visible permission outcomes: unsafe matches are removed (fail-closed); order-independence of flags requires declared value flags.
- The `args-permission-matching` specification, its tests, and the matcher engine implementation in a follow-up change.
