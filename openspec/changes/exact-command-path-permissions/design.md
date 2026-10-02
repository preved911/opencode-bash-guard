## Context

See [proposal.md](proposal.md) for motivation. Today `evalMatcher` walks nested `args` trees and appends the action of every matched matcher — ancestors and descendants alike — to one shared list; `mostRestrictive` then reduces the whole list. Three consequences: an ancestor `deny` always wins, so allow exceptions under it are dead config; the action on a matcher that has `args` has no coherent meaning (it either uselessly joins the accumulation or would silently vanish under exact-path semantics); and nothing in the config tells the reader which rule actually decided a command. Global flags (`git -c …`, cobra persistent flags that may appear on either side of the subcommand) and "restrict this flag everywhere" rules have no clean story either.

## Goals / Non-Goals

**Goals:**

- One rule = one command path, readable on a single line: `token: ["push", "--force"]`.
- Overrides in both directions via refinement; most-restrictive-wins for genuine ambiguity — with `ask` as a full participant, not only `deny`.
- Global flags and reordered arguments match the same rule as the canonical order.
- Flat-argument tools (`find`, `grep`) keep released behavior.
- Fail-safe defaults: no rule silently vanishes, and no rule is silently loosened by an unrelated one.

**Non-Goals:**

- No flag-name prefix matching: `--force` never matches `--force-with-lease`.
- No consecutive-position path semantics; paths are order-free.
- No changes to position-matcher mechanics, the glob fallback, chain aggregation, permission wrapping, or degraded mode.
- No new dependencies; no changes to plugin config loading or merging.

## Decisions

### Flatten matcher trees into path matchers

`ArgMatcher.token` becomes `string | string[]`; nested `args` is removed from the schema — declaring it invalidates the entry, which is dropped with a warning naming it (migration is a mechanical flatten, see below). A path matches when every element matches a distinct segment token: elements are consumed in array order from the matcher's own evaluation, each anywhere among the remaining tokens, so `[ "get", "--namespace=kube-system" ]` matches `kubectl get --namespace=kube-system pods` and `kubectl --namespace=kube-system get pods` alike. Elements match whole tokens exactly, and leftover trailing tokens never invalidate a match — `["push", "--force"]` fires on `git push --force origin main`. Matchers are evaluated independently of each other; no matcher consumes tokens on behalf of another. This removes the shared-state machinery entirely and makes evaluation recursion-free, so configuration depth costs nothing at runtime.

Alternative considered: keep nested trees with exact-path selection (a branch consumes its token, returns only its child's result, an unmatched branch falls through to the glob level). Rejected: branch actions become inert, unmatched prefixes silently loosen configured denies by delegating to the glob level, and the evaluator stays stateful and recursive.

Alternative considered: branch actions as inherited defaults (longest-prefix inheritance on the tree). Rejected: it expresses the same outcomes as prefix path rules with a stateful evaluator; the flat form states the inheritance explicitly — a prefix rule is just a shorter path.

### Decide overlaps by refinement, then most-restrictive

Matching matchers resolve as follows. First, discard every matcher another matching matcher *refines*: A refines B iff both are token matchers and either (1) B's token path is a proper element-prefix of A's token path — a longer path describes a narrower command; or (2) A and B declare the same single-string token and A adds a `pattern` B lacks — a value-constrained matcher describes a narrower command set. Second, reduce the survivors most-restrictive: `deny` > `ask` > `allow`, regardless of declaration order. Position matchers never refine and are never refined; incomparable matchers — including any matcher against a position matcher, or two different same-length paths — always reduce together most-restrictive.

The split matches intent: refinement means "this rule describes the command more precisely" and wins in whichever direction it points (a refined `allow` beats a general `deny`; a refined `deny` or `ask` beats a general `allow`); MRW resolves genuine ambiguity and always errs toward restriction, so a global-flag `deny` or `ask` (`["--force"] → deny`) can never be silently defeated by an unrelated exact-path `allow`, and `ask` survives the same way.

Alternative considered: pure longest-path-wins. Rejected: a bare global-flag rule loses to any longer allow — "deny this flag everywhere" silently fails exactly when an allowed subcommand exists. Alternative considered: global most-restrictive only (today's accumulation). Rejected: allow exceptions are inexpressible, which is the bug this change fixes.

### Default omitted actions to ask at the validation boundary

`action` becomes optional in the raw configuration shape. Validation normalizes each accepted matcher so `action` is always present; an omitted action becomes `ask` — never allow. An explicitly invalid action still invalidates the containing entry under the current warning-and-drop behavior. The evaluator never sees a partially specified matcher.

### Keep `pattern` bound to single-token value matching

`pattern` stays required with `position` and optional with a single-string `token` (globbing the value token that follows the matched flag). `pattern` combined with an array `token` is invalid and warns-and-drops: value matching is a per-flag concern, paths are token selectors, and per-element value constraints would add consumption semantics with no demonstrated need. Refinement by pattern covers the value-exception case (`{ "token": "-X", "pattern": "GET", "action": "allow" }` refines `{ "token": "-X", "action": "deny" }`).

### Keep everything outside matcher evaluation unchanged

No matching rule → the existing glob, external-directory, and redirect pipeline decides, exactly as released. Args-level `allow` still records the force-allow decision consumed by `permission.ask`; `ask` and `deny` wrap and store as before; `resolveChain` still aggregates segments with deny over ask. Broken JSONC still enters degraded mode before matching. Clustered short-flag expansion, case sensitivity, positional-slot counting, and the `position: "all"` fail-safe quantifiers are unchanged.

### Test at the existing boundaries

Update `plugin-config.test.ts` for array tokens, omitted-action normalization, legacy `args` dropped with warnings, and `pattern`-with-array invalidity. Update `tool-permissions.test.ts` for order-free path matching, trailing-argument coverage, distinct-token consumption inside a path, whole-token elements, refinement discard in both directions, global-flag `ask`/`deny` surviving exact-path allows, and MRW ties. Preserve the flat regression suite: flat tools must behave exactly as released, except the intended value-exception case where a `pattern` matcher now refines its bare token instead of hiding behind MRW.

## Risks / Trade-offs

- [A refinement can loosen a broader deny] → That is the feature (exceptions), and it requires a visible, specific rule; blanket rules keep covering every unlisted path. Release notes must state that overlapping rules resolve to the more specific one, even when looser.
- [Value-exception behavior differs from the release for overlapping pattern/bare matchers] → Documented; previously the bare rule always hid the pattern rule via MRW. Flat tools are otherwise bit-identical.
- [Users expect length-based precedence between unrelated rules] → Document the lineage rule: generality never beats specificity across lineages because incomparable rules go to MRW, which is always fail-safe.
- [Flattened trees change some outcomes] → Old accumulation equals the new reduction except allow leaves that were dead under deny-accumulation now act as the exceptions they were written to be; the migration note leads with this.
- [Omitted actions silently restrict] → Default is `ask`, never allow; normalization is covered by parser tests.

## Migration Plan

1. Flatten: replace each nested tree with one rule per root-to-leaf path (`token: [a, b, c]`, leaf action); re-express a desired intermediate action as an explicit prefix rule (`token: [a, b]`).
2. Release as a breaking version. Deny rules keep covering every nested path they covered; allow leaves previously dead under deny-accumulation now take effect.
3. Roll back by releasing the prior plugin version; there is no compatibility mode — one syntax, one semantics.
