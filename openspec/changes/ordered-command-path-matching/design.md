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

Every segment is parsed once, after `<executable>`, into a classified sequence. The parse is linear, deterministic, and shared by all matchers of the tool entry:

1. Scan tokens left to right.
2. The first token equal to `--` ends classification: every later token is a `trailing-arg` (positional class; never a command level, never a flag, never a flag value). A later `--` is an ordinary trailing argument.
3. A token starting with `-` is a flag:
   - `<flag>=<flag-value>` (`=`-form) is self-contained: flag with inline value, never a positional.
   - Otherwise the flag's arity is looked up (see below). If declared value-taking **and** the next token exists, is not `--`, and does not start with `-`, the next token is consumed as its `flag-value`; otherwise the flag is value-less.
4. Every remaining token is a positional. Positionals before the path completes are command-level candidates; after the path completes they are `trailing-arg`s.

**Flag arity sources (normative):**

1. *Value matcher declaration*: a matcher `{ "token": "<global-flag>", "pattern": "<flag-value>" }` declares that flag value-taking — the matcher consumes the `<flag>` + `<flag-value>` pair atomically.
2. *Declarative arity table*: the tool entry MAY declare `"flags": { "<global-flag>": 1, "<local-flag>": 0 }`. Only `0` and `1` are valid; any other value invalidates the entry (warn-and-drop). Arity keys match whole flag tokens exactly (no cluster expansion).
3. *Undeclared flags* are value-less by assumption (fail-safe): an intended value that does not start with `-` remains a positional and therefore breaks anchored path matching — fail-closed. To get position independence for a value flag, declare it via 1 or 2.

One token is never both a command level and a flag value: classification happens once, before any matcher runs, and matchers evaluate against the classified sequence (the separate representation). Path elements, flag tokens, and flag values come from disjoint classes by construction.

## Design Variants

### Variant 1 — Ordered, anchored path matcher (chosen)

Keep `token: string[]` and redefine its semantics: the path matches the *leading* positional command tokens in order, contiguously; flags and declared flag values interleave freely; trailing arguments follow only after the complete path.

- Readability: one line per path; the config mirrors the command.
- Semantics: unambiguous — anchoring plus contiguity plus order fully determine the match.
- Fail-safe: foreign positionals and undeclared flag values break matches (fail-closed); no partial-path action exists because the matcher is atomic.
- Depth: array length — arbitrary.
- Flag independence: by the token model; requires declaring value flags.
- Flag-value matchers: atomic `<flag>` + `<flag-value>` pairs, structurally grounded (the value is the classified neighbor or the `=`-form), never a path substitute.
- Refinement: unchanged lineage rule (path-prefix; pattern over bare token).
- Compatibility: array-token behavior intentionally changes (this is the fix); schema gains the optional `flags` arity table; `pattern` restricted to flag tokens.
- Implementation: one linear classification pass + prefix comparison; no recursion, no backtracking.
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

- A path matcher is **fully matched** only when every configured level equals, in order, the leading positional command tokens (flags and declared values excluded from that sequence), with no foreign positional before or between levels. `action` applies to the matcher as a whole; intermediate levels are not nodes and carry no action — a partial path contributes nothing, so a parent can never `allow` before a deeper condition is checked.
- Overlap resolution stays: matchers refined by another matching matcher (path-prefix extension, or a value `pattern` over the same bare flag token) are discarded; survivors reduce most-restrictive (`deny` > `ask` > `allow`). A precise child path therefore can loosen a general ancestor rule, while an independent flag `deny`/`ask` — incomparable with the path rule — always survives refinement and constrains the result.
- `token` + `pattern` remains an atomic `<flag>` + `<flag-value>` pair matcher: the `pattern` MUST bind to the structurally adjacent value (next token or `=`-form). It MUST NOT have a non-flag `token`: such matchers are rejected at validation, because an adjacent pair found inside an arbitrary `argv` position must never authorize a command path.
- Position matchers index the structural positional list (declared flag values excluded; `--` never counted). `position: "all"` keeps its fail-safe quantifiers over that list.
- No matcher matched → the existing `permission.bash` glob pipeline, external-directory checks, and native checks apply unchanged. Broken JSONC → degraded mode before matching; invalid matchers are warned and dropped, never reinterpreted.

## Risks / Trade-offs

- [Array-token configs written for order-free matching may stop matching] → Intentional: those matches are the reported hazard. Migration documents the anchored semantics; failures are fail-closed (fall through to the glob pipeline).
- [Undeclared value flags break path matches for value-carrying invocations] → Fail-closed by design; the normative rule and the `flags` arity table make the fix explicit in config.
- [Non-flag `token` + `pattern` matchers are dropped at startup] → A dropped rule never adds permissions; the warning names the entry and the migration path (convert to a path matcher).
- [Position indices shift for configs that relied on dash-less flag values counted as positionals] → Only when the flag is declared; declared values leaving the positional pool is the documented correction of the old heuristic.
- [Boolean unknown flags in front of the path still work; unknown value flags do not] → Deterministic, documented, fail-closed; declaring the flag restores order independence.

## Migration Plan

1. Treat every array `token` as an ordered anchored path. Audit rules whose elements could appear out of order or inside longer commands; split or scope them.
2. Convert every non-flag `token` + `pattern` matcher into a path matcher (`token: [a, b]`), or into a flag matcher if the token is actually a flag. Startup warnings name each rejected entry.
3. Declare value-taking flags (`flags` table or a value matcher) wherever order independence is required across their values.
4. Re-check `position` / `position: "all"` indices that counted dash-less flag values of now-declared flags; re-index or declare fewer flags.
5. Refinement precedence is unchanged; no action needed for configs using only single-token matchers without `pattern`.
6. No compatibility shims: ambiguous forms are rejected with warnings, never silently reinterpreted. Release as a breaking version.
