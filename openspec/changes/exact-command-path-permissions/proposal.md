## Why

Nested command permissions today accumulate the action of every matched parent and child into one global most-restrictive decision. That makes three things impossible: carving an allow exception under a broader deny, expressing "restrict this flag wherever it appears" without the rule being silently outvoted, and telling which rule decided a command. Permission rules need to describe exact command paths — including global flags anywhere on the line — with predictable refinement and a fail-safe fallback.

## What Changes

- Replace nested `args` matcher trees with flat path matchers: `token: string | string[]`. An array token declares the command path; all its elements must appear in the segment as distinct whole tokens, matched anywhere (order-free), so global flags and reordered arguments match the same rule. Leftover trailing tokens never invalidate a match.
- Decide overlapping rules by refinement, not accumulation: when one matching rule refines another (its path extends the other's, or a value `pattern` constrains a bare token), the refined rule is discarded; the survivors reduce most-restrictive-wins (`deny` > `ask` > `allow`). Incomparable rules — e.g. a global-flag rule against an exact-path rule — always reduce most-restrictive, so a `deny` or `ask` on a flag can never be silently defeated by an unrelated `allow`.
- Support overrides in both directions: refine an allow with a deny or ask (restrict a flag under an allowed subcommand) and refine a deny with an allow (carve an exception for one flag variant).
- Make matcher `action` optional, defaulting to `ask` when omitted.
- **BREAKING** Remove nested `args` from the schema. Existing trees must be flattened: root-to-leaf tokens become the path array and the leaf action stays. Deny rules keep covering every nested path they covered before; allow leaves that were dead under deny-accumulation now take effect as the exceptions they were written to be.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `args-permission-matching`: Replace nested matcher trees with flat order-free path matchers, decide overlaps by refinement-then-most-restrictive, and default omitted matcher actions to `ask`.

## Impact

- Plugin permission configuration in `opencode-bash-guard.jsonc`, especially existing nested `args` trees (must be flattened).
- User-visible permission outcomes for subcommand/flag rules and omitted matcher actions.
- The `args-permission-matching` specification and its tests.
