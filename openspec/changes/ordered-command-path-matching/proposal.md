## Why

The current command-path matcher accepts an array of tokens and checks their presence in the segment, but preserves neither their order, nor their positions, nor their membership in one contiguous command path. A rule written for `<executable> <primary-command> <secondary-command>` also matches `<executable> <positional> <primary-command> <secondary-command>` and matches when the same tokens surface inside a differently rooted command. A `token` + `pattern` matcher searches for its adjacent pair anywhere in `argv`, so a pair meant to authorize one exact command also authorizes unrelated commands that merely contain the pair. Both hazards can widen permissions without any warning: the config says one command, the engine allows another.

The historical nested `args` form did not provide a correct conjunction either — the parent action was applied before the child matcher was ever checked — and its removal in favor of an order-free token array traded that bug for the anchoring gap above.

## What Changes

- Introduce an explicit token model for every segment: `executable`, command-path levels, flags, flag values, ordinary operands, and operands after `--`. The `=`-form is normalized into a base-flag atom plus an inline value atom, so both spellings behave identically to every policy.
- Redefine an array `token` as an **ordered, anchored, contiguous command path**: non-dash elements are positional levels matched in order against the leading positional-list operands that follow `<executable>`; dash-prefixed elements are **flag predicates** matching on base flag identity (bare, cluster-expanded, or `=`-form; position-free); a foreign operand before the first level or between levels breaks the match; operands after the complete path are allowed.
- Ground flag arity in configuration per **executable** (aggregated across all of the tool's entries before matching, explicit `flags` table over value-matcher inference): a value matcher or a `flags: 1` declaration makes the flag consume exactly one following value atomically, unconditionally. An undeclared flag followed by a non-dash token is a **probable missing arity**: the segment resolves to `ask` regardless of the flag's position. Contradictions (a value matcher on a `flags: 0` flag) and equal-rank table conflicts suspend the executable's args policy into scoped ask.
- Restrict `pattern` to flag tokens: a `token` + `pattern` matcher remains the atomic `<flag>` + `<flag-value>` pair form, with an action-derived repetition quantifier (`allow`: every occurrence; `ask`/`deny`: one suffices). A non-flag token with `pattern` is rejected at validation (warn-and-drop) instead of acting as an implicit command path.
- Split position semantics into two views: `position` / `position: "all"` index the **positional list** (declared flag values and inline value atoms excluded — indices are stable under flag placement), and a new dedicated **operand matcher** (`"operand": "all"`) indexes the **safety operand list** (declared flag values, inline value atoms, post-`--` operands) so `deny`/`ask` policies keep seeing real values everywhere.
- Invalid permission policies drop the offending rules AND fail closed: a scoped ask for the affected executable, or **global degraded ask** when the entry's tool cannot be determined (e.g. missing `tool`).
- Keep refinement-then-most-restrictive resolution (strict in at least one dimension: longer path, proper predicate superset, or added value pattern), fail-safe `ask` defaults, the glob fallback for unflagged tools, chain aggregation, and degraded mode unchanged.
- **BREAKING** Array-token matching becomes anchored and ordered and requires `"matcherVersion": 2` (unmigrated configs ask for affected executables); non-flag `token` + `pattern` matchers are rejected; undeclared value flags resolve segments to `ask`; invalid entries trigger scoped (or global) ask instead of silent fallback; `position` indices no longer count declared flag values (moved to the operand matcher).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `args-permission-matching`: Redefine array-token matching as an ordered, anchored, contiguous command path over an explicit token model; ground flag arity in configuration; restrict `pattern` to flag tokens; align positional matching with the structural positional list.

## Impact

- Plugin permission configuration in `opencode-bash-guard.jsonc`: array-token matchers, value matchers on non-flag tokens, `position` matchers counting over dash-less flag values, and any config relying on order-free path matching.
- User-visible permission outcomes: unsafe matches are removed (fail-closed); order-independence of flags requires declared value flags.
- The `args-permission-matching` specification, its tests, and the matcher engine implementation in a follow-up change.
