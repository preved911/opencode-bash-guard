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

Every segment is parsed once, after `<executable>`, by a linear, deterministic, shared classification. The classification never decides what a "trailing argument" is — that is derived per path matcher — it only separates flags, flag values, and operands:

1. Scan tokens left to right.
2. The first token equal to `--` switches to the post-separator region: every later token is a post-separator **operand** (never a command level, never a flag, never a flag value — but visible to position-based safety policies). A later `--` is an ordinary operand.
3. A token starting with `-` is a flag:
   - `<flag>=<flag-value>` (`=`-form) is self-contained: flag with inline value, never an operand.
   - Otherwise the flag's arity is looked up (see below). If declared value-taking, the next token is consumed unconditionally as its `flag-value` (even when it starts with `-` — negative numbers and options-as-values are values), provided a next token exists and is not `--`. An explicit arity declaration always wins — no dash-based second-guessing. Otherwise the flag is value-less.
4. Every remaining token is an operand.

Two ordered views are derived from the classification:

- **Command sequence** — the pre-separator operands (declared flag values excluded), in segment order. Used by path matchers: levels form an anchored, contiguous prefix; the remainder is *that matcher's* trailing arguments.
- **Operand list** — every non-flag token in segment order: command operands, declared flag values, and post-separator operands. Used by `position` matchers, so `deny`/`ask` policies see real operands everywhere, including after `--`.

**Flag arity sources (normative):**

1. *Value matcher declaration*: a matcher `{ "token": "<global-flag>", "pattern": "<flag-value>" }` declares that flag value-taking — the matcher consumes the `<flag>` + `<flag-value>` pair atomically.
2. *Declarative arity table*: the tool entry MAY declare `"flags": { "<global-flag>": 1, "<local-flag>": 0 }`. Only `0` and `1` are valid; any other value invalidates the entry (warn-and-drop). Arity keys match whole flag tokens exactly (no cluster expansion).
3. *Undeclared flags* are value-less by assumption (fail-safe): an intended value remains an operand and therefore breaks anchored path matching before the path completes. Declaration is authoritative: a declared value-taking flag consumes its value unconditionally; only a missing next token or the `--` separator prevents consumption. Because legacy rule sets rarely registered value flags explicitly, the engine SHALL emit a one-time warning per undeclared flag the first time it is observed followed by a non-dash token — a probable missing arity declaration — and the migration guide lists this as the primary upgrade check.

**Arity is aggregated per executable before any matching.** Declarations are collected from every entry of that executable and resolved by a deterministic precedence: an explicit `flags` table declaration wins over value-matcher inference (the table is a deliberate statement; the matcher only implies arity); absence is not a declaration, so any single declaration wins. Only a conflict between two explicit declarations of equal rank (table vs table declaring `0` and `1` for one flag) is unresolved: it suspends the executable's args policy — every segment of that executable resolves to `ask`, glob allows are suspended for that tool — and a warning names the flag and the conflicting entries. One entry seeing a token as a flag value while another sees it as a command level is exactly such an unresolved conflict; it must never produce divergent outcomes for the same `argv`.

**Invalid policies fail closed per executable.** An entry or matcher that fails validation is dropped from the rule set, and the affected executable is flagged: its segments resolve to `ask` (glob allows suspended for that tool) until the config is fixed, with a warning naming the entry. Dropping a restrictive rule alone is fail-open — control would fall to a possibly-allowing glob — so the scoped ask is mandatory, not optional.

**Path matchers carry flag predicates.** Within an array `token`, dash-prefixed elements are *flag predicates* (the flag must appear somewhere in the segment, exact or cluster-expanded; position-free by definition) and non-dash elements are *positional levels* (anchored, contiguous, order-enforced). Class-splitting keeps both requirements deterministic: array order across the two classes is ignored, authors MAY interleave, and a command level that starts with `-` is unrepresentable (documented). This keeps legacy `["<command>", "<dangerous-flag>"]` rules working as path + flag predicate — they must not fail open into a glob fallback.

## Design Variants

### Variant 1 — Ordered, anchored path matcher (chosen)

Keep `token: string[]` and redefine its semantics: non-dash elements are positional levels forming an anchored, contiguous, order-enforced prefix of the command sequence; dash-prefixed elements are position-free flag predicates; trailing operands follow only after the complete path.

- Readability: one line per path; the config mirrors the command.
- Semantics: unambiguous — anchoring plus contiguity plus order fully determine the match; flag predicates are presence checks, immune to ordering.
- Fail-safe: foreign positionals, undeclared flag values before the path, and missing levels break matches (fail-closed); no partial-path action exists because the matcher is atomic.
- Depth: array length — arbitrary.
- Flag independence: by the token model; requires declaring value flags.
- Flag-value matchers: atomic `<flag>` + `<flag-value>` pairs with action-derived repetition quantifiers, structurally grounded, never a path substitute.
- Refinement: lineage rule extended — levels-prefix plus flag-predicate superset.
- Compatibility: legacy `["<command>", "<dangerous-flag>"]` rules become path + flag predicate with equivalent-or-narrower meaning — no fail-open migration gap. Array-token behavior intentionally changes otherwise.
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

- A path matcher is **fully matched** only when every positional level equals, in order, the leading command-sequence operands (flags and declared flag values excluded from that sequence), no foreign operand precedes or separates the levels, and every flag predicate of the matcher is present somewhere in the segment. `action` applies to the matcher as a whole; levels are not nodes and carry no action — a partial path contributes nothing, so a parent can never `allow` before a deeper condition is checked.
- Overlap resolution stays: matchers refined by another matching matcher are discarded; survivors reduce most-restrictive (`deny` > `ask` > `allow`). A refines B iff B's positional levels are a prefix of A's levels **and** A's flag predicates are a superset of B's (the refined match set is a strict subset), or A and B share the same single flag token and A adds a `pattern`. A precise path can therefore loosen a general rule, and a flag-scoped `deny` beats a general `allow` — both by the same subset rule. Incomparable matchers always reduce most-restrictive, so an independent flag `deny`/`ask` survives refinement and constrains the result.
- Value matchers repeat deterministically with an action-derived quantifier, mirroring `position: "all"`: with `allow`, **every** occurrence of the flag must carry a value glob-matching the pattern (a missing value fails the allow); with `ask`/`deny`, **one** matching occurrence suffices. Without this, a single benign occurrence would let refinement discard a general deny while a malignant occurrence remains — fail-open.
- `token` + `pattern` remains an atomic `<flag>` + `<flag-value>` pair matcher: the `pattern` MUST bind to the structurally adjacent value (next token or `=`-form). It MUST NOT have a non-flag `token`: such matchers are rejected at validation, because an adjacent pair found inside an arbitrary `argv` position must never authorize a command path.
- Position matchers index the **operand list** — every non-flag token in segment order: command operands, declared flag values, and post-separator operands. `position: "all"` keeps its fail-safe quantifiers over that list; `deny`/`ask` therefore keep seeing sensitive operands wherever they sit — as flag values or after `--`.
- Invalid policies (invalid entry or matcher) and arity conflicts trigger the scoped ask described in the token model: the affected executable's segments resolve to `ask` — glob allows suspended for that tool — until the config is fixed.
- No matcher matched (tool not flagged) → the existing `permission.bash` glob pipeline, external-directory checks, and native checks apply unchanged. Broken JSONC → degraded mode before matching; invalid matchers are warned, dropped from the rule set, and never reinterpreted.

## Risks / Trade-offs

- [Array-token configs written for order-free matching may stop matching] → Intentional: those matches are the reported hazard. Migration documents the anchored semantics; failures are fail-closed (fall through to the glob pipeline).
- [Legacy `["<command>", "<dangerous-flag>"]` rules must keep working] → Flag predicates in paths preserve them with equivalent-or-narrower meaning; a validation rejection here would be fail-open and is explicitly not done.
- [Undeclared value flags are position-dependent] → Inherent to missing arity knowledge: before the path the would-be value breaks the match (fail-closed); after the path it behaves exactly as if the flag were absent — never wider than the no-flag baseline. Position independence is guaranteed for declared flags only; documented normatively.
- [Non-flag `token` + `pattern` matchers are dropped at startup] → Dropping a restrictive rule alone is fail-open — control would fall to a possibly-allowing glob. The scoped ask for the affected executable closes that gap; the warning names the entry and the migration path.
- [Position indices now count declared flag values] → Honest operand indexing: `deny`/`ask` must see real operands wherever they sit. Configs re-index or declare fewer flags; documented.
- [Arity conflicts suspend a whole executable's args policy to ask] → Deliberately conservative: divergent classification across entries of one executable must never produce per-entry outcomes for the same `argv`. The warning names the flag and the conflicting entries.
- [Omitted actions silently restrict] → Default is `ask`, never allow; normalization is covered by parser tests.

## Migration Plan

1. Treat every array `token` as an ordered anchored path of positional levels; dash-prefixed elements are now flag predicates — legacy `["<command>", "<dangerous-flag>"]` deny rules keep matching with equivalent-or-narrower meaning; no action required for them.
2. Convert every non-flag `token` + `pattern` matcher into a path matcher (`token: [a, b]`), or into a flag matcher if the token is actually a flag. Startup warnings name each rejected entry, and the affected executable asks until fixed.
3. Declare value-taking flags (`flags` table or a value matcher) wherever order independence is required across their values; declare boolean flags for documentation. The engine warns once per undeclared flag observed followed by a non-dash token — treat that warning as a probable missing arity declaration.
4. Re-check `position` / `position: "all"` indices that now count declared flag values; re-index or declare fewer flags.
5. Fix any unresolved arity conflicts (explicit table vs table declaring different arities for one flag) — the executable asks until resolved. Table-vs-inference differences resolve deterministically (table wins).
6. Refinement precedence is unchanged for patternless single-token rules; no action needed for configs using only those.
7. No compatibility shims: ambiguous forms are rejected with warnings, never silently reinterpreted. Release as a breaking version.
