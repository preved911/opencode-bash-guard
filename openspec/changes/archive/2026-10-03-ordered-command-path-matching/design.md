## Context

See [proposal.md](proposal.md). The matcher engine evaluates every matcher independently against the raw segment token list. An array `token` matches when each element equals some distinct segment token — anywhere, in any order. A `token` + `pattern` matcher locates its flag token anywhere and requires the immediately following token to glob-match. Neither matcher consults any notion of command structure: there is no distinction between a command level, a flag value, and an unrelated positional, so both matcher forms can match inside commands they were never written for. The removed nested `args` form had a different defect — the parent action contributed before the child was checked — which a conjunction must not reintroduce.

## Goals / Non-Goals

**Goals:**

- A path rule matches exactly `<executable> <primary-command> <secondary-command> [<trailing-arg>...]` for the configured levels, at any supported depth.
- No match when levels are reordered, a level is missing, a token matches only partially, a foreign positional precedes the path or sits between levels, or the expected token run appears inside a differently rooted command.
- Flags and their recognized values are position-independent: placing the same flag set before, between, or after the path levels yields the same result.
- Fail-safe behavior for every ambiguity: partial knowledge never widens permissions.
- Keep refinement-then-most-restrictive resolution, `ask` defaults, glob fallback, chain aggregation, and degraded mode unchanged.

**Non-Goals:**

- No semantic understanding of specific tools; arity comes only from configuration.
- No variadic flags (an arity greater than one is unsupported and rejected).
- No changes to the glob pipeline, chain splitting, permission wrapping, or degraded mode.
- No silent compatibility shims that keep ambiguous matches working.

## Token Model

Every segment is parsed once, after `<executable>`, by a linear, deterministic, shared classification. The classification separates flags (with their values) from operands, and never decides what a "trailing argument" is — that is derived per path matcher:

1. Scan tokens left to right.
2. The first token equal to `--` switches to the post-separator region: every later token is a post-separator operand — never a command level, never a flag, never a flag value — but visible to operand-based safety policies. A later `--` is an ordinary operand. A lone `-` is an ordinary operand.
3. A base-flag identity starts with `-`, is neither `-` nor `--`, and contains neither whitespace nor `=`. A token starting with such an identity is a flag:
   - `<flag>=<flag-value>` (`=`-form) is normalized into two atoms: the base flag `<flag>` (flag identity — participates in flag matching and flag predicates) and an inline `flag-value` atom (participates in value matching and in the safety operand list; never a command level). Once arity is declared consistently, separate and `=` forms behave identically. An undeclared `=`-form is deterministic because the spelling carries its own value boundary; this is the documented exception to separate-form missing-arity handling.
   - Otherwise the flag's arity is looked up (see below). If consistently declared value-taking, the next token is consumed unconditionally as its `flag-value` (even when it starts with `-` — negative numbers and options-as-values are values), provided a next token exists and is not `--`. Otherwise the flag is value-less. Conflicting declarations suspend matching rather than choosing a winner.
4. Every remaining token is an operand.

Two ordered views are derived from the classification:

- **Positional list** — pre-separator operands excluding declared flag values and inline value atoms, in segment order. Used by path matchers (levels form an anchored, contiguous prefix; the remainder is *that matcher's* trailing arguments) and by `position` matchers. Excluding values makes positional indices stable under flag and value placement.
- **Safety operand list** — every non-flag data token: ordinary pre-separator operands, separate-token values of declared flags, `=`-form inline values, and post-separator operands, in segment order. Used by the dedicated operand matcher (`"operand": "all"`) as the complete whole-operand safety view. Ordinary positionals intentionally appear in both views: the positional list provides stable indexing, while the safety list provides complete policy coverage.

**Flag arity sources (normative):**

1. *Value matcher declaration*: a matcher `{ "token": "<global-flag>", "pattern": "<flag-value>" }` declares that flag value-taking — the matcher consumes the `<flag>` + `<flag-value>` pair atomically.
2. *Path value predicate*: an array-token matcher MAY declare `"flagValues": { "<global-flag>": "<flag-value-glob>" }`; each key is a base-flag identity, declares that flag value-taking, and constrains its value atomically with the path. This is the only supported path-plus-value conjunction. A flag MUST NOT appear both as a presence predicate in `token` and in `flagValues` in one matcher. Repeated occurrences use the same action-derived quantifier as standalone value matchers.
3. *Declarative arity table*: the tool entry MAY declare `"flags": { "<global-flag>": 1, "<local-flag>": 0 }`. Only `0` and `1` are valid; any other value invalidates the entry (warn-and-drop). Arity keys are base-flag identities and match whole flag tokens exactly.
4. *Undeclared separate-form flags* are provisionally value-less, and **any successor other than `--` leaves the classification ambiguous**: an undeclared flag followed by any token — dash-prefixed or not — is a **probable missing arity**: the segment SHALL resolve to `ask` regardless of where the flag sits — before, between, or after the path levels — and the engine SHALL emit a one-time warning naming the flag. An undeclared `=`-form remains the explicit deterministic value-bearing exception because its spelling supplies the boundary. Only an arity declaration (`flags` table, value matcher, or path value predicate) removes separate-form ambiguity. Position independence for value flags requires declaring them.

**Arity is aggregated per executable before any matching.** Declarations are collected from every entry of that executable; absence is not a declaration, so any single declaration wins. Every `0` versus `1` disagreement is ambiguous and suspends the executable's args policy (every segment resolves to `ask`, glob allows suspended for that tool), regardless of whether the `1` came from a table, value matcher, or path value predicate. Choosing `0` is not fail-safe: a real value could become a positional and activate a path or positional allow. Consistent declarations merge; every contradiction is warned with the flag and conflicting entries. Arity is uniform across the executable. Subcommand-conditional arity is unsupported: if declarations disagree across subcommands, the executable asks until the policy is redesigned rather than guessing one grammar.

**Short-option clusters are classification-sensitive.** An exact arity declaration for the complete raw token classifies it as one base flag. Without one, a cluster may expand only when every one-letter member is explicitly known arity `0`. If a token can contain an arity-1 or undeclared short flag — including attached forms such as `-ofile` or `-XPOST` — classification is ambiguous and the segment resolves to `ask`. Cluster expansion never invents a value boundary.

**Invalid policies fail closed.** An entry or matcher that fails validation is dropped from the rule set, and the affected executable is flagged: its segments resolve to `ask` (glob allows suspended for that tool) until the config is fixed. An invalid entry whose tool cannot be determined (e.g. missing `tool`) is unscopeable: it SHALL trigger **global degraded ask** — every segment of every executable resolves to `ask` — exactly like broken JSONC, with a warning naming the entry.

**Flag identities are never value spellings.** Every `flags` key, `flagValues` key, scalar flag token, and dash-prefixed array element must be a base-flag identity. A value-bearing spelling containing `=` in any of those positions is invalid and triggers scoped ask, rather than becoming a matcher that can never see the normalized base flag. Duplicate presence predicates are invalid.

**Path matchers carry flag predicates.** Within an array `token`, dash-prefixed elements are presence predicates (the base flag must appear somewhere in the segment — bare, an unambiguous all-boolean cluster member, or as the flag part of an `=`-form; position-free by definition) and non-dash elements are positional levels (anchored, contiguous, order-enforced). Array elements containing `=` are invalid legacy value-bearing predicates and trigger scoped ask until explicitly migrated to `flagValues`; silently reinterpreting exact raw tokens as value globs would widen legacy allows. Array order across positional levels and presence predicates is ignored, but authors SHOULD group predicates after the path. A command level starting with `-` is unrepresentable. The separator `--` is invalid in every matcher token form.

## Design Variants

### Variant 1 — Ordered, anchored path matcher (chosen)

Keep `token: string[]` and redefine its semantics: non-dash elements are positional levels forming an anchored, contiguous, order-enforced prefix of the command sequence; dash-prefixed elements are position-free flag predicates; trailing operands follow only after the complete path.

- Readability: one line per path; the config mirrors the command.
- Semantics: unambiguous — anchoring plus contiguity plus order fully determine the match; flag predicates are presence checks, immune to ordering.
- Fail-safe: foreign positionals, undeclared flag values before the path, and missing levels break matches (fail-closed); no partial-path action exists because the matcher is atomic.
- Depth: array length — arbitrary.
- Flag independence: by the token model; requires declaring value flags.
- Flag-value matchers: standalone atomic `<flag>` + `<flag-value>` pairs with action-derived repetition quantifiers. Path-scoped value conditions use the matcher's explicit `flagValues` map, never an independent sibling matcher.
- Refinement: lineage rule extended — levels-prefix plus flag-predicate superset.
- Compatibility: legacy `["<command>", "<dangerous-flag>"]` presence rules become path + flag predicate with equivalent-or-narrower meaning. Legacy array elements containing `=` are rejected until explicitly migrated because their exact raw-token meaning cannot be preserved by implicit value-pattern conversion.
- Implementation: one linear classification pass + prefix comparison + presence checks; no recursion, no backtracking.
- Unexpected-match risk: eliminated for the reported hazards (see Decisions).

### Variant 2 — Nested matchers with neutral intermediate nodes

Restore `args` nesting; nodes with children are pure grouping (no action); the action attaches only to the full path (leaf or explicit composite).

- Readability: poor beyond two levels; deep nesting mirrors the removed v0.2 form.
- Semantics: the conjunction is natural, but "neutral node" needs a rule for what an action on a grouping node means (forbid? warn?), and the v0.2 bug — parent action before child check — is exactly the trap being re-created.
- Fail-safe: acceptable, but legacy nested configs carried actions on intermediate nodes; re-accepting the syntax invites silent reinterpretation.
- Depth, flag independence: same token model still required — nesting alone does not provide anchoring.
- Refinement: lineage over trees is harder to define and review.
- Implementation: recursion and copied consumption state return.
- Unexpected-match risk: unchanged unless the token model is added anyway.

### Variant 3 — Composite matcher with logical `all`

`{ "all": [ … ] }` combines positional conditions (and any matcher kind) with explicit token consumption.

- Readability: verbose; every level becomes an indexed condition.
- Semantics: unambiguous but positional indices are fragile — declared flag values would shift indices unless the model hides them, and depth requires counting by hand.
- Fail-safe: an out-of-range index fails closed, but brittleness produces accidental non-matches (fail-closed, yet unusable).
- Depth: arbitrary in principle, tedious in practice.
- Flag independence: inherits from the token model.
- Refinement: no natural lineage between composites.
- Implementation: the most complex — a logical combinator over a shared consumption model.
- Unexpected-match risk: low, at the cost of usability.

### Decision

**Variant 1.** It fixes both reported hazards with the smallest schema change, keeps the config a direct transcription of the command, preserves the refinement model, and needs only the linear token classification that any variant requires anyway. Variant 2 reintroduces the removed syntax together with its historical defect class and still depends on the same token model for anchoring. Variant 3 is strictly more machinery for the same expressiveness with worse ergonomics; its indexing fragility directly conflicts with the flag-position-independence goal.

## Permission Semantics

- A path matcher is **fully matched** only when every positional level equals, in order, the leading positional-list operands (flags and declared flag values excluded from that list), no foreign operand precedes or separates the levels, and every flag predicate of the matcher is present somewhere in the segment. `action` applies to the matcher as a whole; levels are not nodes and carry no action — a partial path contributes nothing, so a parent can never `allow` before a deeper condition is checked.
- A bare scalar base-flag matcher matches an equal classified base-flag atom anywhere, including a member of a safely expanded all-boolean cluster. A bare scalar non-flag matcher matches an equal safety-operand atom. All matchers evaluate independently against the same immutable classification.
- Overlap resolution stays: matchers refined by another matching matcher are discarded; survivors reduce most-restrictive (`deny` > `ask` > `allow`). One array path refines another only when the general path's positional levels are a prefix, every presence predicate and `flagValues` pair is structurally identical in the specific path, and at least one dimension is strict (longer levels or a proper predicate superset). Presence and value predicates for one base flag are incomparable. Structurally identical matchers never refine each other. Array paths, scalar flag matcher families, position/operand matchers, and non-flag scalar token matchers are mutually incomparable across matcher kinds. Within one scalar flag family, different flag identities or value patterns are incomparable. A standalone patterned `allow` may refine the same bare flag only when every repeated occurrence satisfies the value pattern; patterned `ask` and bare `deny` remain incomparable so one benign occurrence cannot downgrade a general deny. All incomparable matches reduce most-restrictive.
- Value matchers repeat deterministically with an action-derived quantifier, mirroring `position: "all"`: with `allow`, **every** occurrence of the flag must carry a value glob-matching the pattern (a missing value fails the allow); with `ask`/`deny`, **one** matching occurrence suffices. Without this, a single benign occurrence would let refinement discard a general deny while a malignant occurrence remains — fail-open.
- `token` + `pattern` remains an atomic `<flag>` + `<flag-value>` pair matcher: the `pattern` MUST bind to the structurally adjacent value (next token or `=`-form). It MUST NOT have a non-flag `token`: such matchers are rejected at validation, because an adjacent pair found inside an arbitrary `argv` position must never authorize a command path.
- Numeric positions are non-negative safe integers. Position matchers index the **positional list** (pre-separator operands excluding declared flag values and inline value atoms) — stable under flag and value placement; post-separator operands are excluded and covered by the operand matcher.
- The dedicated **operand matcher** (`"operand": "all"`) indexes the complete safety operand list (ordinary positionals, declared flag values, `=`-form inline value atoms, and post-separator operands) with the same fail-safe, action-derived quantifiers.
- An undeclared flag followed by **any** successor other than `--` (dash-prefixed or not) is a probable missing arity: the segment SHALL resolve to `ask` regardless of the flag's position, with the one-time warning naming the flag. Declaring the flag removes the ambiguity and the ask.
- **Changed semantics are version-gated.** The plugin config gains `matcherVersion`; the only recognized value is `2`. Every non-empty `permissions` section requires `"matcherVersion": 2`, because classification changes can affect arrays, value matchers, arity tables, scalar tokens, and position candidates indirectly. Without the marker, every executable named by that section resolves to `ask` with glob allows suspended and a one-time migration warning. Any explicit value other than `2` is invalid and triggers global degraded ask. The marker is read only from the config source that contributes the effective `permissions` array: a global marker cannot opt in a project-local permissions block.
- Invalid policies and arity contradictions trigger the scoped ask described in the token model; unscopeable invalid entries (no `tool`) trigger global degraded ask.
- No matcher matched (tool not flagged) → the existing `permission.bash` glob pipeline, external-directory checks, and native checks apply unchanged. Broken JSONC → degraded mode before matching; invalid matchers are warned, dropped from the rule set, and never reinterpreted.

## Risks / Trade-offs

- [Array-token configs written for order-free matching would silently narrow under anchoring] → The `matcherVersion` gate prevents it: unmigrated configs ask for the affected executables instead of falling to a possibly-allowing glob; setting `"matcherVersion": 2` is the explicit, audited opt-in.
- [Value-specific denies must survive exact-path allows] → Path rules and value matchers are incomparable by construction (value constraints are not provable from path levels); they always reduce most-restrictive. Normative scenario added.
- [Legacy `["<command>", "<dangerous-flag>"]` presence rules must keep working] → Presence predicates match on base flag identity (including `=`-forms), preserving them with equivalent-or-narrower meaning. Value-bearing elements containing `=` are different: they stay invalid until explicit `flagValues` migration so legacy allows cannot widen silently.
- [Probable missing arity makes segments ask] → Deliberately conservative: any successor other than `--` (including `-`-prefixed tokens) leaves an undeclared flag's arity unknowable, and ambiguity resolves to human review regardless of the flag's position. Declaring the flag removes the ask; the one-time warning points at it.
- [`flags: 0` with an `=`-form occurrence makes segments ask] → A value on a declared value-less flag contradicts the declaration; asking is the fail-safe (hiding the value would be fail-open). Undeclared `=`-forms are fully classified and deterministic.
- [Non-flag `token` + `pattern` matchers are dropped at startup] → Dropping a restrictive rule alone is fail-open — control would fall to a possibly-allowing glob. The scoped ask (or global degrade when unscopeable) closes that gap; the warning names the entry and the migration path.
- [`position` indices change for configs that relied on dash-less flag values counted as positionals] → Every non-empty permissions section is version-gated. After opt-in, declared values leave the positional list but remain in the complete safety operand list; position indices become stable under declared flags.
- [Arity contradictions suspend a whole executable's args policy to ask] → Deliberately conservative. Choosing `0` or `1` can each widen a different policy, so no precedence is safe. The warning identifies every conflicting declaration.
- [Flag arity is executable-wide] → Subcommand-conditional arity is unsupported. Conflicting declarations ask rather than guessing; users must avoid the ambiguous flag or split policy at a boundary that has its own executable.
- [Attached short-option values are tool-dependent] → An exact declaration for the complete raw token classifies it as one flag. Otherwise, a cluster expands only when all one-letter members are declared arity `0`; any possible value-taking or undeclared member asks, so the model never guesses between a boolean cluster and an attached value.
- [Omitted actions silently restrict] → Default is `ask`, never allow; normalization is covered by parser tests.

## Migration Plan

1. Gate: every non-empty `permissions` section without `"matcherVersion": 2` in the same config source runs unmigrated — all named executables resolve to `ask` with glob allows suspended. A marker in a different config source is ignored with a warning.
2. Audit every flag identity before setting version 2. Presence-only base flags keep equivalent-or-narrower meaning. Value-bearing `=` spellings are rejected in scalar flag tokens, dash-prefixed array elements, `flags`, and `flagValues`; migrate an atomic path-plus-value rule explicitly to `flagValues`, or a standalone value rule to scalar `token` plus `pattern`. The new value pattern is a glob and intentionally matches both separate and `=` forms, so migration is a rule-level opt-in rather than an implicit reinterpretation. The separator `--` is always invalid.
3. Non-flag `token` + `pattern` matchers are rejected with warnings (the executable asks until fixed). They have no equivalent in the current args grammar: independent path and operand matchers are not a conjunction. Keep the rule in scoped ask until an atomic replacement is designed, or move the complete restriction to the native glob layer.
4. Declare value-taking flags (`flags` table or a value matcher) wherever order independence is required across their values; declare boolean flags for documentation. An undeclared flag followed by any non-`--` successor resolves to `ask` — the warning and the ask point exactly at the declaration to add.
5. Whole-operand `position: "all"` policies migrate to `operand: "all"`. The new safety list is a conservative superset: it includes ordinary positionals, all recognized values, and all post-separator operands. Re-check `allow` rules because extra candidates can make them stop matching; `deny`/`ask` coverage never narrows. Indexed `position: N` keeps only ordinary pre-separator positionals.
6. Fix every arity contradiction, including table `0` versus table `1`, a value matcher, or `flagValues`; the executable asks until declarations agree.
7. Re-check scalar-token versus path overlap: different matcher kinds are incomparable and reduce most-restrictive.
8. No compatibility shims: ambiguous forms are rejected with warnings, never silently reinterpreted. Release as a breaking version.
