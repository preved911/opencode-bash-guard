## Why

The current command-path matcher accepts an array of tokens and checks their presence in the segment, but preserves neither their order, nor their positions, nor their membership in one contiguous command path. A rule written for `<executable> <primary-command> <secondary-command>` also matches `<executable> <positional> <primary-command> <secondary-command>` and matches when the same tokens surface inside a differently rooted command. A `token` + `pattern` matcher searches for its adjacent pair anywhere in `argv`, so a pair meant to authorize one exact command also authorizes unrelated commands that merely contain the pair. Both hazards can widen permissions without any warning: the config says one command, the engine allows another.

The historical nested `args` form did not provide a correct conjunction either — the parent action was applied before the child matcher was ever checked — and its removal in favor of an order-free token array traded that bug for the anchoring gap above.

## What Changes

- Introduce an explicit token model for every segment: `executable`, command-path levels, flags, flag values, ordinary operands, and operands after `--`.
- Redefine an array `token` as an **ordered, anchored, contiguous command path**: non-dash elements are positional levels matched in order against the leading positional command tokens that follow `<executable>`; dash-prefixed elements are **flag predicates** (the flag must appear somewhere, position-free); flags and their declared values may appear before, between, and after levels without affecting the result; a foreign positional before the first level or between levels breaks the match; operands after the complete path are allowed.
- Ground flag arity in configuration per **executable** (aggregated across all of the tool's entries before matching): a value matcher (`token` + `pattern`) or the per-entry `flags` arity table declares a flag value-taking; such a flag consumes exactly one following value atomically, unconditionally (including `-`-prefixed values). An undeclared flag is treated as value-less (fail-closed). Conflicting arity declarations suspend the executable's args policy into scoped ask.
- Restrict `pattern` to flag tokens: a `token` + `pattern` matcher remains the atomic `<flag>` + `<flag-value>` pair form; its value quantifier follows the action (`allow`: every occurrence must match; `ask`/`deny`: one is enough). A non-flag token with `pattern` is rejected at validation (warn-and-drop) instead of acting as an implicit command path.
- Position matching operates on the **operand list** — every non-flag token in segment order, including declared flag values and operands after `--` — so `deny`/`ask` position policies keep seeing real operands.
- Invalid permission policies (invalid entry or matcher, arity conflict) drop the offending rules AND put the affected executable into **scoped ask** (its segments resolve to `ask`, glob allows suspended for that tool) instead of silently falling back to a possibly-allowing glob.
- Keep refinement-then-most-restrictive resolution (extended to flag predicates), fail-safe `ask` defaults, the glob fallback for unmatched tools, chain aggregation, and degraded mode unchanged.
- **BREAKING** Array-token matching becomes anchored and ordered (previously order-free anywhere in `argv`); non-flag `token` + `pattern` matchers are rejected; invalid entries now trigger scoped ask for their executable; `position` indices count declared flag values.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `args-permission-matching`: Redefine array-token matching as an ordered, anchored, contiguous command path over an explicit token model; ground flag arity in configuration; restrict `pattern` to flag tokens; align positional matching with the structural positional list.

## Impact

- Plugin permission configuration in `opencode-bash-guard.jsonc`: array-token matchers, value matchers on non-flag tokens, `position` matchers counting over dash-less flag values, and any config relying on order-free path matching.
- User-visible permission outcomes: unsafe matches are removed (fail-closed); order-independence of flags requires declared value flags.
- The `args-permission-matching` specification, its tests, and the matcher engine implementation in a follow-up change.
