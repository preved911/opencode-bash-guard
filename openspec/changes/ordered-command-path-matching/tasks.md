## 1. Regression Tests

- [ ] 1.1 Preserve flat-matcher regression coverage in `src/__tests__/tool-permissions.test.ts`: quote-aware tokenization, short-flag cluster expansion, atomic flag-value pairs, positional matching, `position: "all"` quantifiers, multiple tool entries, args force-allow, glob fallback, and degraded mode.
- [ ] 1.2 Add `plugin-config.test.ts` cases: the `flags` arity table parses (`0`/`1` only); `pattern` with a non-flag single-string `token` is dropped with a warning; `pattern` with an array `token` stays invalid; an invalid entry flags its executable for scoped ask; an unscopeable invalid entry (no `tool`) triggers global degraded ask; unmigrated array-token matchers ask until `"matcherVersion": 2`.

## 2. Token Classification

- [ ] 2.1 Implement the linear structural classification pass in `src/config.ts`: after `<executable>` classify tokens into flags (boolean, value-taking by declaration, `=`-form inline value), flag values, pre-separator command operands, and post-separator operands. Classification never decides trailing arguments — that is derived per path matcher.
- [ ] 2.2 Aggregate flag arity per executable before matching with deterministic precedence: an explicit `flags` table declaration wins over value-matcher and value-conditioned-predicate inference; absence is not a declaration; a value matcher on a table-declared value-less flag is a contradiction, and an equal-rank table conflict (`0` vs `1`) is unresolved — both suspend the executable's args policy (scoped ask, warning naming the flag and entries). Arity is uniform across the executable (documented limitation).
- [ ] 2.3 Implement scoped ask: any invalid entry or matcher drops the rule AND forces the affected executable's segments to `ask` with glob allows suspended for that tool, until the config is fixed; an unscopeable invalid entry (no `tool`) triggers global degraded ask; implement the `matcherVersion` gate (covers array-token matchers, value matchers, and `flags` tables; the marker is honored only in the source contributing `permissions`; `2` = migrated, absent = scoped ask for affected executables, any other value = global degraded ask).
- [ ] 2.4 Treat an undeclared flag followed by any successor other than `--` (dash-prefixed or not) as a probable missing arity: the segment resolves to `ask` regardless of the flag's position, and a one-time warning names the flag to declare; an `=`-form occurrence of a flag declared `0` also resolves the segment to `ask` (an undeclared `=`-form is fully classified, no ask).

## 3. Matching

- [ ] 3.1 Redefine array-token matching in `src/config.ts`: non-dash elements are positional levels forming an anchored, contiguous, order-enforced prefix of the command sequence; dash-prefixed elements are position-free flag predicates matched on base flag identity (presence, exact or cluster-expanded), and an `=`-form predicate is additionally value-conditioned (implies flag arity `1`); foreign operands break the match; the remainder after the levels is the matcher's trailing arguments; the separator `--` is rejected as a matcher token and as an array element (warn-and-drop + scoped ask).
- [ ] 3.2 Ground value matchers in the classification: `pattern` binds to the structurally adjacent value token or the `=`-form of the same flag; repeated occurrences use the action-derived quantifier (`allow`: every occurrence; `ask`/`deny`: at least one); reject non-flag `token` + `pattern` matchers at validation (warn-and-drop + scoped ask); keep path rules and value matchers always incomparable (a value-specific deny survives an exact-path allow).
- [ ] 3.3 Split position views: `position` and `position: "all"` index the positional list (value atoms excluded — indices stable under flag placement; post-separator operands included); the `operand: "all"` matcher indexes the safety operand list — every non-flag token (command operands, declared flag values, `=`-form inline atoms, post-separator operands) — the 1:1 whole-operand view, with the same fail-safe quantifiers.
- [ ] 3.4 Extend `refines()` (levels-prefix plus flag-predicate superset, strict in at least one dimension — structurally identical matchers never refine each other; value pattern over the same bare flag token; a path rule and a value matcher are always incomparable) and keep most-restrictive reduction of survivors; keep `resolveSegment` fallback behavior (glob, external-directory, redirect, degraded mode) unchanged for unflagged tools.

## 4. Documentation

- [ ] 4.1 Rewrite the `permissions` section of `README.md` around the token model: anchored ordered paths, flag predicates, flag arity declaration (`flags` table, value matchers), fail-safe undeclared-flag behavior, `=`-form equivalence, `--` handling, scoped ask for invalid policies and arity conflicts.
- [ ] 4.2 Add migration notes: array-token rules are anchored/ordered (dash elements are flag predicates — legacy path-with-flag deny rules keep matching); non-flag `token` + `pattern` matchers must become path matchers or flag matchers; `position` indices count declared flag values; invalid policies and arity conflicts ask per executable until fixed.

## 5. Verification

- [ ] 5.1 Run the focused `src/__tests__/plugin-config.test.ts` and `src/__tests__/tool-permissions.test.ts` test files and confirm the new and preserved matcher scenarios pass.
- [ ] 5.2 Run the full `npm test` suite and `npm run build` TypeScript build successfully.
- [ ] 5.3 Run `openspec validate ordered-command-path-matching --strict` and confirm the change artifacts validate.
