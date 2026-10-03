## Why

The current command-path matcher accepts an array of tokens and checks their presence in the segment, but preserves neither their order, nor their positions, nor their membership in one contiguous command path. A rule written for `<executable> <primary-command> <secondary-command>` also matches `<executable> <positional> <primary-command> <secondary-command>` and matches when the same tokens surface inside a differently rooted command. A `token` + `pattern` matcher searches for its adjacent pair anywhere in `argv`, so a pair meant to authorize one exact command also authorizes unrelated commands that merely contain the pair. Both hazards can widen permissions without any warning: the config says one command, the engine allows another.

The historical nested `args` form did not provide a correct conjunction either — the parent action was applied before the child matcher was ever checked — and its removal in favor of an order-free token array traded that bug for the anchoring gap above.

## What Changes

- Introduce an explicit token model for every segment: command-path levels, flags, values, ordinary operands, and operands after `--`. Declared separate and `=` values normalize identically; undeclared `=` spelling is the explicit deterministic exception to separate-form missing-arity handling.
- Redefine an array `token` as an **ordered, anchored, contiguous command path**. Non-dash elements are positional levels; dash-prefixed elements are position-independent presence predicates. Add an explicit `flagValues` map for atomic path-plus-value predicates instead of silently reinterpreting legacy `--flag=value` array elements.
- Aggregate flag arity per executable from `flags`, value matchers, and `flagValues`. Any `0`/`1` disagreement suspends the executable into scoped `ask`; no declaration source wins an ambiguous classification. Undeclared flags followed by any non-`--` successor ask. Ambiguous short clusters or attached short values ask rather than being guessed value-less.
- Use one base-flag identity grammar across scalar flag matchers, array predicates, `flags`, and `flagValues`. Value-bearing `=` spellings are invalid in identity positions; bare scalar flags continue to match classified base-flag atoms, including safely expanded boolean-cluster members.
- Restrict scalar `pattern` to flag tokens and keep repeated-value quantifiers fail-safe (`allow`: every occurrence; `ask`/`deny`: one suffices). Non-flag `token` + `pattern` remains invalid and has no fake two-matcher migration because independent matchers are not a conjunction.
- Define two consistent views: `position` indexes ordinary pre-separator operands only, while `operand: "all"` indexes every non-flag data token (ordinary operands, values, and post-`--` operands) as the complete safety view.
- Invalid permission policies drop the offending rules AND fail closed: a scoped ask for the affected executable, or **global degraded ask** when the entry's tool cannot be determined (e.g. missing `tool`).
- Keep refinement only where match-set inclusion is structurally proven; different matcher kinds are incomparable and reduce most-restrictive. Preserve fail-safe `ask`, glob fallback for valid unopinionated tools, chain aggregation, and degraded mode.
- **BREAKING** Every non-empty permissions section requires same-source `matcherVersion: 2`. Unsupported legacy shapes remain scoped-ask until explicitly migrated; opt-in never silently widens an existing allow.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `args-permission-matching`: Redefine array-token matching as an ordered anchored path, add atomic `flagValues`, make arity ambiguity ask, split stable positional indexing from complete safety operands, and version-gate all non-empty permission configs.

## Impact

- Plugin permission configuration in `opencode-bash-guard.jsonc`: every non-empty permissions section, array-token matchers, value-bearing spellings in flag-identity fields, value matchers on non-flag tokens, short-option clusters, position matchers counting over flag values, and configs relying on order-free path matching.
- User-visible permission outcomes: unsafe matches are removed (fail-closed); order-independence of flags requires declared value flags.
- The `args-permission-matching` specification, its tests, and the matcher engine implementation in a follow-up change.
