## Context

See [proposal.md](proposal.md) for motivation. `ArgMatcher.action` is currently required by the TypeScript model and validation. `evalMatcher` walks nested `args` by appending both a matching parent action and every matching child action to one shared action list. `mostRestrictive` then applies deny, ask, allow precedence across that entire list.

That behavior makes nesting an accumulating policy chain instead of a command path. For example, a matching `git` `push` branch can contribute its action even when the command does not reach a configured leaf, and a child action can combine with the parent action. The evaluator also keeps a consumed-token state for token matching, short-flag clusters, flag values, and positional candidates. `resolveSegment` treats a non-null args result as authoritative and otherwise falls through to bash glob, external-directory, and redirect policy. Degraded mode bypasses args matching and forces ask before that pipeline.

## Goals / Non-Goals

**Goals:**

- Represent a recursive match as one selected command-path result, not a global collection of actions from ancestor and descendant nodes.
- Resolve conflicts only among alternatives that match at the same recursion level, with deny winning over ask and allow.
- Make an omitted matcher action become `ask` during configuration validation, so runtime matching receives a complete internal matcher tree.
- Keep current token, pattern, positional, clustered-flag, flag-value consumption, and degraded-mode behavior unless the exact-path rule requires otherwise.
- Preserve the existing segment pipeline: a path result decides the segment, while no path result falls through to the current glob and path policy.

**Non-Goals:**

- Change bash glob precedence, external-directory evaluation, redirects, chain-level aggregation, or permission wrapping.
- Add a compatibility switch for accumulated nested actions or change declaration-order semantics.
- Redefine tokenization, positional heuristics, short-flag expansion, or `position: "all"` quantifiers.
- Add dependencies or change the plugin config loading and merge model.

## Decisions

### Normalize matcher actions at the validation boundary

`ArgMatcher.action` will become optional in the raw configuration shape. Validation will copy each accepted matcher into a normalized internal matcher tree where `action` is always present. A missing action becomes `ask`; an explicitly invalid action still invalidates the containing permission entry under the current warning and drop behavior. Recursive children are normalized using the same function.

This makes omission deterministic before matching begins and keeps evaluator code independent of configuration syntax. It also means the parser can validate a nested tree once, rather than repeatedly applying defaults at every recursion level.

Alternative considered: default missing actions inside the evaluator. Rejected because validation would still reject omitted actions or the evaluator would need to handle partially valid runtime data. Boundary normalization gives one internal contract.

### Split leaf matchers from branch matchers

A matcher without `args` is a leaf. If it matches according to its existing token or position semantics, it yields that matcher's normalized action.

A matcher with `args` is a branch selector. It can only participate after its own `token` matches and consumes that token in a copied matcher state. Its own action is not a decision for the command. The evaluator recurses into its children using that copied state and returns only the selected child result. A branch with no matching child produces no result.

Consequently, a configured branch such as `git` then `push` applies only to a complete matched path. `git`, `git status`, and `git push --force` do not inherit an ancestor branch action unless each command reaches a matching leaf. A leaf may still have no `pattern`, preserving current token-only leaf matching. Validation continues to reject the currently unsupported `token` plus `pattern` plus `args` combination, so branches remain command-token selectors rather than flag-value rules.

Alternative considered: let a branch action act as a default when no child matches. Rejected because it preserves ancestor inheritance and conflicts with exact command-path semantics.

### Return a local recursive selection result

Replace the recursive `actions: PermissionAction[]` accumulator with an internal result such as `MatcherResult | null`. A result contains the action selected by one complete leaf path. The recursive function continues to receive `argv` and `MatcherEvalState`, including the copied consumption state used for a branch.

At each matcher-array level, evaluate every sibling independently from the state supplied to that level. Collect only each sibling's returned result. Reduce that local result set with the existing action precedence: deny, then ask, then allow. Return the resulting one action to the caller. A branch returns the action chosen by its child level without combining it with the branch's own action.

The root `entry.args` level uses the same local reduction. `evalToolEntry` returns its one action or null, and `matchToolActions` keeps combining completed tool-entry results as it does today. Thus deny-wins remains true for alternatives at one recursion level and for multiple matching tool entries, but it is not least-privilege aggregation over an ancestor-to-descendant chain.

Alternative considered: preserve the shared action array and suppress only parent actions. Rejected because child siblings would still write into a global collection, making recursion boundaries invisible and easy to regress. A scalar recursive return makes the selected-path contract explicit.

### Preserve matching and consumption mechanics within a selected path

Leaf matching keeps existing behavior:

- Exact token matching remains case-sensitive. Single-letter short-flag targets still match inside clustered flags, while value-pattern matchers still require an exact flag token.
- A token matcher with a value pattern consumes the flag and its value in the current state. A token-only leaf consumes its matched token.
- Numeric positions and `position: "all"` retain their existing candidate rules and allow versus ask or deny quantifiers.
- A selected branch receives a copied state with its selector token consumed. Its descendants cannot rematch that selector. Siblings at the parent level evaluate against the parent state, so no sibling inherits another sibling's consumption.

The recursive algorithm has no level-specific condition or fixed nesting limit. Every branch calls the same matcher-array evaluator for its children, so configuration depth is bounded only by the supplied tree and normal runtime stack limits.

Alternative considered: flatten nested matchers into fixed two or three token levels. Rejected because it would cap valid command paths and duplicate matching rules for every depth.

### Keep unmatched paths on the existing fallback pipeline

`matchToolPermissions` returns null when no complete leaf path matches. This includes an unmatched branch prefix, a branch whose descendants do not match, and a sibling that does not match. `resolveSegment` then continues unchanged into bash glob matching, path extraction, external-directory checks, and redirect checks.

This preserves the current boundary between structured args policy and the native glob policy. It also prevents a partial structured rule from becoming an implicit deny or ask for unrelated subcommands.

Alternative considered: return ask for every matched branch prefix. Rejected because it turns incomplete structured paths into policy decisions and blocks the configured glob fallback.

### Keep enforcement and degraded behavior unchanged

After an args-level path selects allow, ask, or deny, `resolveSegment` continues to treat that result as authoritative. Args-level allow still records the force-allow decision needed by `permission.ask`; args ask and deny still wrap and store as before. `resolveChain` still aggregates segment decisions with deny over ask, and all segments must allow for a chain allow.

Invalid JSONC still enters degraded mode before matching, removes tool permissions, suspends glob allows, and asks for every parseable bash command. Invalid permission entries continue to be warned and dropped without forcing degraded mode. The new omitted-action default applies only to otherwise valid matcher objects.

Alternative considered: make nested-path changes alter chain aggregation or degraded mode. Rejected because neither behavior is part of command-path selection and changing either would widen this breaking change.

### Test the recursive contract at the existing boundaries

Update `tool-permissions.test.ts` to cover omitted action normalization, arbitrary-depth exact paths, a matching branch with no matching leaf, sibling fallthrough, and local deny-wins conflicts. Cases must show that parent and descendant actions do not combine, while overlapping leaves at one array level still reduce to deny.

Keep regression coverage for quoted tokens, clustered flags, values, positions, `position: "all"`, consumption, multiple entries, glob fallback, args force-allow, and degraded mode. These tests protect the behavior intentionally preserved by the design.

## Risks / Trade-offs

- [Existing nested configurations rely on parent actions applying to descendants] → This is a documented breaking change. Migration requires explicit leaf rules for every intended command path.
- [A local deny is mistaken for a chain-wide ancestor restriction] → Tests will pair conflicting parent and child actions and assert that only sibling alternatives at the same recursion level are reduced together.
- [State copying changes consumption visibility] → Keep the current branch-copy rule, and add tests that prove descendants cannot rematch a branch selector while siblings remain independent.
- [Deep user configuration can grow the call stack] → The evaluator supports arbitrary logical depth without a configured cap. Typical command paths are shallow, and no new traversal is introduced beyond the existing recursive tree walk.
- [Omitted actions silently become more restrictive than prior invalid-entry dropping] → Default to `ask`, never allow, and cover the normalization behavior with parser tests and warning expectations for explicit invalid values.
- [The breaking semantic change is hard to notice] → Document it in the modified capability spec and release notes, with before and after examples that require explicit leaves.

## Migration Plan

1. Implement normalization and recursive local-result selection behind the existing `permissions` schema. No new option or dependency is added.
2. Update unit and pipeline tests to establish the exact-path contract and protect unchanged behavior.
3. Update the `args-permission-matching` specification and user-facing configuration documentation to mark nested behavior as breaking. Show that ancestor rules must be expanded into explicit leaves and that omitted matcher actions now default to `ask`.
4. Release as a breaking version. Users review nested `args` trees and add explicit leaf matchers for every command path they previously expected an ancestor action to cover.
5. Roll back by releasing the prior plugin version if users cannot migrate immediately. There is no runtime compatibility mode, because supporting both accumulated and exact-path interpretation would make the same configuration ambiguous.
