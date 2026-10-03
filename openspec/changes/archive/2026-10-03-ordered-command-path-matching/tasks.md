## 1. Configuration And Migration Gate

- [ ] 1.1 Extend config types with top-level `matcherVersion: 2`, array-matcher `flagValues: Record<string, string>`, and `operand: "all"`.
- [ ] 1.2 Require same-source `matcherVersion: 2` for every non-empty effective `permissions` array. Missing marker: scoped ask for every named executable. Explicit non-`2`: global degraded ask. Ignore and warn on a marker inherited from a different source.
- [ ] 1.3 Define one base-flag identity grammar and apply it to scalar flag tokens, dash-prefixed array elements, `flags`, and `flagValues`. Require non-empty tools, array-shaped args, and non-negative safe-integer numeric positions. Reject value-bearing identity spellings containing `=`, invalid selectors, unknown fields, nested `args`, `--` matcher tokens, duplicate presence/`flagValues` predicates, non-flag scalar patterns, and invalid arity values. Invalid scoped entries ask; unscopable top-level or tool errors degrade globally.

## 2. Token Classification

- [ ] 2.1 Implement one quote-aware classification pass after the executable: separator region, base flags, inline values, declared separate values, ordinary pre-separator operands, and post-separator operands.
- [ ] 2.2 Aggregate arity per executable from `flags`, scalar value matchers, and path `flagValues`. Any `0`/`1` disagreement, including cross-subcommand disagreement, suspends that executable into scoped ask; no declaration source wins a conflict.
- [ ] 2.3 Treat undeclared flags followed by any non-`--` successor as ambiguous scoped ask. Treat declared arity-0 `=` occurrences as ask. Keep undeclared `=`-forms deterministic and document the spelling exception.
- [ ] 2.4 Treat an exact declaration for a complete raw flag token as one flag; otherwise expand a short-option cluster only when every one-letter member is explicitly arity `0`. Any possible undeclared or arity-1 member, including attached forms such as `-ofile`, resolves to ask.
- [ ] 2.5 Derive the positional list from ordinary pre-separator operands only. Derive the safety operand list from every non-flag data token: ordinary operands, separate and inline values, and post-separator operands.

## 3. Matching And Resolution

- [ ] 3.1 Match array paths as anchored ordered positional prefixes plus position-independent presence predicates. Match `flagValues` in the same atomic matcher against adjacent separate or inline values.
- [ ] 3.2 Match bare scalar flags against classified base-flag atoms, including safe boolean-cluster members. Keep scalar value matchers structurally adjacent and apply repetition quantifiers: allow requires every occurrence; ask/deny require at least one.
- [ ] 3.3 Make `position` operate on the positional list and `operand: "all"` on the complete safety list. Preserve non-vacuous action-derived `"all"` quantifiers.
- [ ] 3.4 Implement refinement only between structurally comparable matchers. Array paths compare levels plus identical predicates. Different matcher kinds are incomparable. Patterned ask and bare deny are incomparable; patterned allow refines a bare flag only when every repeated occurrence satisfies it.
- [ ] 3.5 Preserve most-restrictive reduction and existing glob fallback only when the executable is valid, migrated, unsuspended, and no matcher has an args-level opinion.

## 4. Documentation And Migration

- [ ] 4.1 Rewrite README permissions documentation around the authoritative classification, the two candidate views, `flagValues`, fail-safe arity, short-cluster ambiguity, and same-source versioning.
- [ ] 4.2 Document that presence-only base-flag identities can be audited into v2, while value-bearing `=` spellings in scalar tokens, arrays, `flags`, or `flagValues` require explicit value-matcher migration and never auto-convert.
- [ ] 4.3 Document that non-flag `token` + `pattern` has no equivalent pair of independent matchers; keep it scoped-ask until an atomic replacement is designed or move the complete policy to native globs.
- [ ] 4.4 Document `operand: "all"` as a conservative whole-operand migration target: it includes ordinary operands, recognized values, and post-separator operands. Re-check allows because the candidate set can grow; deny/ask coverage must never narrow.

## 5. Verification

- [ ] 5.1 Add parser tests for same-source version provenance, every invalid matcher shape and base-flag identity, global versus scoped degradation, and explicit `flagValues` migration.
- [ ] 5.2 Add classification tests for all arity conflicts, separate/inline values, dash-prefixed values, post-`--`, undeclared flags, arity-0 equals forms, exact whole-token declarations, boolean clusters, and ambiguous attached short values.
- [ ] 5.3 Add matcher tests for anchored paths with trailing operands, atomic path-plus-value predicates, complete safety operands, stable positions, repeated values, bare/value scalar families, cross-kind incomparability, and fail-safe refinement.
- [ ] 5.4 Add migration regressions proving that old restrictive rules never reach an allowing glob and old allows never gain new spellings or glob semantics without explicit migration.
- [ ] 5.5 Run focused tests, the full test suite, TypeScript build, and `openspec validate ordered-command-path-matching --strict`.
