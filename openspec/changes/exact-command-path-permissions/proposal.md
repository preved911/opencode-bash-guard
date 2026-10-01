## Why

Nested command permissions currently combine actions across parent and child matchers, which can grant or restrict a command based on a path that was not configured as a complete command. Permission rules need to describe exact command paths at any nesting depth, with predictable defaults for omitted actions.

## What Changes

- Support nested command paths of arbitrary depth and apply an action only when the complete configured path exactly matches the command tokens.
- Treat `a b c d` as distinct from its ancestors and siblings: allowing `a b c d` does not allow `a`, `a b`, `a b c`, or `a b c e`.
- Aggregate multiple matches at the same command-path level with most-restrictive, deny-wins behavior. Do not aggregate actions across ancestor and descendant levels as a least-privilege decision.
- Make matcher `action` optional, defaulting to `ask` when omitted.
- **BREAKING** Change existing nested-rule interpretation from global parent and child aggregation to exact command-path matching. Configurations that relied on an ancestor action applying to descendant commands must add explicit rules for each intended command path.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `args-permission-matching`: Change nested matcher semantics to exact command-path matching, scope same-level action aggregation, and default omitted matcher actions to `ask`.

## Impact

- Plugin permission configuration in `opencode-bash-guard.jsonc`, especially nested `permissions` matcher trees.
- User-visible permission outcomes for nested commands and configurations that omit a matcher action.
- The `args-permission-matching` specification and its tests.
