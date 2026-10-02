## MODIFIED Requirements

### Requirement: Parse permissions rules from the plugin config file

The system SHALL read an optional `permissions` array from the plugin config file `opencode-bash-guard.jsonc` (project `.opencode/` and global opencode config dir, project wins) into typed tool entries `{ tool: string, args: ArgMatcher[], flags?: Record<string, 0 | 1> }`. Each arg matcher SHALL declare exactly one of `token: string | string[]`, `position: number | "all"`, or `operand: "all"`. An array `token` declares an ordered, anchored command path (see the matching requirement). `pattern: string` is REQUIRED with `position` and with `operand` (globs that slot's candidates) and OPTIONAL with a single-string `token` that MUST start with `-` (when present it globs the value token immediately following the matched flag); `pattern` combined with an array `token` or with a non-flag single-string `token` is invalid. A matcher MAY omit `action`; an omitted action SHALL normalize to `"ask"`. When present, `action` MUST be `"allow" | "ask" | "deny"`. The optional per-entry `flags` table declares flag arity: keys are whole flag tokens, values are `0` (value-less) or `1` (takes one value); any other key or value shape invalidates the entry. Nested `args` trees are not part of the schema: a matcher declaring `args` is invalid. Entries failing validation SHALL be dropped with a warning naming them; when the affected executable can be determined (a valid `tool` is present), that executable SHALL resolve to `ask` (glob allows suspended for that tool) until the config is fixed, and an entry whose tool cannot be determined SHALL trigger global degraded ask — every segment of every executable resolves to `ask` — because the affected executable cannot be scoped. A config whose entries contain array-token matchers without `"matcherVersion": 2` is unmigrated: the affected executables SHALL resolve to `ask` (glob allows suspended for that tool) with a one-time migration warning, so legacy order-free denies can never silently narrow under the anchored semantics; any `matcherVersion` value other than `2` SHALL trigger global degraded ask; the gate covers array-token matchers, value matchers, and `flags` arity tables, and the marker is honored only in the config source that contributes the effective `permissions` array (a marker from a different source is ignored with a warning). When the file or section is absent, the parsed rule list SHALL be empty and plugin behavior SHALL be identical to before this change. When the file fails to parse as JSONC, the plugin SHALL enter degraded mode: `permissions` is treated as absent AND glob allows are suspended for that run, every bash segment SHALL resolve to `ask` (parse-error segments still deny), with a warning naming the file, so a broken config can never silently disable `deny` rules that were meant to be active.

#### Scenario: Valid entries parse

- **WHEN** `permissions` contains `{ "tool": "<executable>", "flags": { "<global-flag>": 1 }, "args": [{ "token": "<local-flag>", "action": "ask" }, { "position": 0, "pattern": "<positional>", "action": "allow" }] }`
- **THEN** one tool entry is stored with two validated arg matchers and a one-entry flag arity table

#### Scenario: Array token parses as a path

- **WHEN** `permissions` contains `{ "tool": "<executable>", "args": [{ "token": ["<primary-command>", "<secondary-command>"], "action": "deny" }] }`
- **THEN** one matcher is stored with a two-level ordered command path and action `deny`

#### Scenario: Omitted action defaults to ask

- **WHEN** `permissions` contains `{ "tool": "<executable>", "args": [{ "token": "<local-flag>" }] }`
- **THEN** the matcher is stored with its action normalized to `ask`

#### Scenario: Invalid entries dropped with warning

- **WHEN** `permissions` contains an entry without `tool`, a matcher with both `token` and `position`, a matcher with neither `token` nor `position`, one with `action: "block"`, a legacy matcher declaring nested `args`, a matcher combining `pattern` with an array `token`, a matcher combining `pattern` with a non-flag single-string `token`, a matcher whose `token` is `--`, an array `token` containing a `--` element, an entry with a `flags` value other than `0` or `1`, and an entry with an empty array `token`
- **THEN** each invalid entry is dropped from the rule set, a warning names it, and the affected executable resolves to `ask` (glob allows suspended for that tool) until the config is fixed — dropping a restrictive rule alone must not fall through to a possibly-allowing glob

#### Scenario: Section absent

- **WHEN** `opencode-bash-guard.jsonc` does not exist or has no `permissions` section
- **THEN** the args rule list is empty and no behavior changes vs. the previous release

#### Scenario: Unmigrated array-token matchers ask until the version marker is set

- **WHEN** the config omits `matcherVersion` and contains an entry with an array `token` matcher, and native config allows that command via a glob
- **THEN** the config is treated as unmigrated: the entry's executable resolves to `ask` (glob allows suspended for that tool) with a one-time migration warning — legacy order-free denies can never silently narrow under the anchored semantics

#### Scenario: Broken config file degrades to ask-everything

- **WHEN** `opencode-bash-guard.jsonc` contains a JSONC syntax error and native config has `"*": "ask"` as the fallback
- **THEN** a warning names the parse error and every bash segment resolves to `ask`; the prompt persists until the config is fixed

### Requirement: Structured arg matcher semantics

The system SHALL parse every segment once, after `<executable>`, by a linear shared classification, and every matcher SHALL evaluate against it. The separator token `--` SHALL be rejected as a matcher `token` and as an array element at validation (warn-and-drop with scoped ask): classification absorbs it as the separator before any matching, so a `--` rule would be a valid-but-unreachable deny. A token equal to `--` switches to the post-separator region: every later token is a post-separator operand — never a command level, never a flag, never a flag value, but visible to the operand matcher; a later `--` is an ordinary operand. A token starting with `-` is a flag: a `<flag>=<flag-value>` token SHALL be normalized into two atoms — the base flag `<flag>` (the flag identity used by flag matching and flag predicates) and an inline `flag-value` atom (matched by value matchers and listed in the safety operand list; never a command level); an `=`-form occurrence of a flag declared value-less (`0`) SHALL resolve the segment to `ask` (a value on a declared value-less flag contradicts the declaration, and hiding the value would be fail-open), while an undeclared flag in `=`-form is fully classified and deterministic; otherwise the flag's arity is resolved from the entry configuration (a value matcher on that flag, or the `flags` arity table), and a declared value-taking flag SHALL consume the next token unconditionally as its `flag-value` — including tokens that start with `-` (negative numbers, options-as-values): an explicit arity declaration is authoritative and is never second-guessed — provided that next token exists and is not `--`; an undeclared flag SHALL be treated as value-less, and an undeclared flag followed by **any** successor other than `--` — dash-prefixed or not — is a probable missing arity: the segment SHALL resolve to `ask` regardless of where the flag sits — before, between, or after the path levels — and the engine SHALL emit a one-time warning naming the flag as a probable missing arity declaration. Arity SHALL be aggregated per executable before any matching, from every entry of that executable, resolved by deterministic precedence: an explicit `flags` table declaration wins over value-matcher inference, absence is not a declaration (any single declaration wins); a value matcher on a flag that a table explicitly declares `0` is a contradiction, and an equal-rank table conflict (`0` vs `1`) is unresolved — both SHALL suspend that executable's args policy (every segment of the executable resolves to `ask`, glob allows suspended for that tool) with a warning naming the flag and the conflicting entries. Flag arity SHALL be uniform across the executable (subcommand-conditional arity is unsupported, documented limitation); value-sensitive restrictions under specific subcommands use value-conditioned path predicates and the operand matcher, which always contains flag values. An entry or matcher that fails validation SHALL be dropped from the rule set AND the affected executable SHALL resolve to `ask` (glob allows suspended for that tool) until the config is fixed — dropping a restrictive rule alone is fail-open; an entry whose tool cannot be determined SHALL trigger global degraded ask. The classification yields two ordered views: the **positional list** — pre-separator operands excluding declared flag values and inline value atoms, in segment order — used by path matchers (whose levels form an anchored, contiguous prefix, the remainder being that matcher's trailing arguments) and by `position` matchers (indices stable under flag and value placement); and the **safety operand list** — every value atom (separate-token declared values and `=`-form inline values) plus every post-separator operand, in segment order — used by the operand matcher. Tokens SHALL be argv-style and quote-aware, derived from the same AST parse the chain splitter performs, with matched quote pairs stripped and quoted whitespace kept within a token. Commands whose chain parse failed never reach matcher evaluation (they fail closed earlier). Matchers are evaluated independently — no matcher consumes tokens on behalf of another. An array `token` declares an ordered, anchored command path: its non-dash elements are positional levels that SHALL equal, in array order, the leading positional-list operands — flags and declared flag values may appear before, between, and after the levels without affecting the result, but a foreign operand before the first level or between levels SHALL break the match, a missing or extra level SHALL break the match, and elements match whole tokens exactly (no partial or prefix token matching); its dash-prefixed elements are flag predicates: a predicate without a value SHALL be a presence check on the base flag (bare, cluster-expanded, or the flag part of an `=`-form token), position-free; a predicate written in `=`-form (`"<global-flag>=<flag-value>"`) is additionally value-conditioned — the base flag SHALL appear with a value glob-matching the value part (adjacent token or `=`-form), and it implies flag arity `1` for the executable, keeping published exact-value path rules working with their original meaning. A single-string `token` matcher matches any equal flag or operand token; when it declares `pattern` its token MUST be a flag, and the matcher SHALL match only the atomic `<flag>` + `<flag-value>` pair — the structurally adjacent next token, or the same flag in `=`-form — with the value glob-matching the `pattern`; a value matcher over a repeated flag SHALL apply an action-derived quantifier: with `action: "allow"`, every occurrence's value MUST glob-match the pattern (an occurrence without a value fails the allow); with `action: "ask"` or `"deny"`, at least one matching occurrence suffices. `token` matching SHALL additionally expand clustered short flags: a target of one letter after `-` SHALL also match a clustered token of single-letter short flags; other forms are not expanded, and cluster-expanded matches never consume a value. Repeated flags are resolved deterministically by the same linear classification. A `position`+`pattern` matcher matches the N-th token of the positional list (declared flag values and inline value atoms excluded, so indices are stable under flag and value placement; flags are never positionals). `position: "all"` is the variable-arity form over the positional list, and its quantifier SHALL be derived from `action` so the matcher always fails safe: with `action: "allow"`, every candidate MUST glob-match the pattern (one mismatch or zero candidates means no match); with `action: "ask"` or `"deny"`, at least one candidate glob-matching the pattern is sufficient (zero candidates means no match). An `operand`+`pattern` matcher (`"operand": "all"`) indexes the safety operand list with the same fail-safe quantifiers, so `deny`/`ask` policies keep seeing declared flag values and post-separator operands. Matching is case-sensitive.

#### Scenario: Published value-bearing path rules keep their exact meaning

- **WHEN** tool entry is `<executable>` with `{ "token": ["<primary-command>", "<global-flag>=<flag-value>"], "action": "deny" }` and segments are `<executable> <primary-command> <global-flag>=<flag-value>`, `<executable> <primary-command> <global-flag> <flag-value>`, and `<executable> <primary-command> <global-flag> <trailing-arg>`
- **THEN** the first two match (value-conditioned predicate: base flag with a value glob-matching `<flag-value>`, adjacent or `=`-form) and the third does not (a different value fails the condition) - the published exact-value rule keeps its original meaning under v2

#### Scenario: Separator token is rejected

- **WHEN** `permissions` contains `{ "token": ["<primary-command>", "--"], "action": "deny" }` or `{ "token": "--", "action": "deny" }`
- **THEN** the matchers are invalid: classification absorbs `--` as the separator before any matching, so such a rule could never match and would be a valid-but-unreachable deny; each is dropped with a warning naming the entry and the executable resolves to `ask` until fixed

#### Scenario: Exact three-level path matches

- **WHEN** matcher is `{ "token": ["<primary-command>", "<secondary-command>", "<nested-command>"], "action": "allow" }` and segment is `<executable> <primary-command> <secondary-command> <nested-command>`
- **THEN** the path matches and the action applies

#### Scenario: Reordered path levels do not match

- **WHEN** matcher is `{ "token": ["<primary-command>", "<secondary-command>"], "action": "deny" }` and segment is `<executable> <secondary-command> <primary-command>`
- **THEN** the path does not match — levels are order-enforced

#### Scenario: Missing path level does not match

- **WHEN** matcher is `{ "token": ["<primary-command>", "<secondary-command>"], "action": "deny" }` and segment is `<executable> <primary-command>`
- **THEN** the path does not match — every configured level must be present

#### Scenario: Partial token match never matches

- **WHEN** matcher is `{ "token": ["<primary-command>", "<secondary-command>"], "action": "deny" }` and segment is `<executable> <primary-command> <secondary-command>-partial`
- **THEN** the path does not match — elements match whole tokens only

#### Scenario: Foreign positional before the path breaks the match

- **WHEN** matcher is `{ "token": ["<primary-command>", "<secondary-command>"], "action": "allow" }` and segment is `<executable> <positional> <primary-command> <secondary-command>`
- **THEN** the path is anchored at the leading positional, `<positional>` does not equal `<primary-command>`, and the matcher does not match

#### Scenario: Foreign positional between levels breaks the match

- **WHEN** matcher is `{ "token": ["<primary-command>", "<secondary-command>"], "action": "allow" }` and segment is `<executable> <primary-command> <positional> <secondary-command>`
- **THEN** the path does not match — contiguity over positional command tokens is broken, and an incomplete path never treats a positional as trailing

#### Scenario: Adjacent pair inside another command does not match

- **WHEN** matcher is `{ "token": ["<primary-command>", "<secondary-command>"], "action": "allow" }` and segment is `<executable> <nested-command> <primary-command> <secondary-command>`
- **THEN** the path is anchored at `<nested-command>`, the first level does not equal it, and the matcher does not match even though the adjacent pair appears later in `argv`

#### Scenario: Path matches regardless of argument order

- **WHEN** matcher is `{ "token": ["<primary-command>", "<secondary-command>"], "action": "allow" }`, the entry declares `"<flags>": { "<global-flag>": 0 }`, and segments are `<executable> <primary-command> <secondary-command> <global-flag>`, `<executable> <global-flag> <primary-command> <secondary-command>`, and `<executable> <primary-command> <global-flag> <secondary-command>`
- **THEN** all three segments produce the identical result — flag placement (argument order of flags) is irrelevant; the command-path levels themselves remain order-enforced

#### Scenario: Path with separate-token flag value

- **WHEN** the entry declares `"<flags>": { "<global-flag>": 1 }` and matcher is `{ "token": ["<primary-command>", "<secondary-command>"], "action": "allow" }`, and segment is `<executable> <global-flag> <flag-value> <primary-command> <secondary-command>`
- **THEN** `<flag-value>` is consumed as the flag's value, is not a positional, and the path matches

#### Scenario: Path rule covers trailing arguments

- **WHEN** matcher is `{ "token": ["<primary-command>", "<secondary-command>"], "action": "deny" }` and segment is `<executable> <primary-command> <secondary-command> <trailing-arg> <trailing-arg>`
- **THEN** the path matches and contributes `deny` — trailing arguments after the complete path never invalidate a match

#### Scenario: Consumed tokens are not rematched

- **WHEN** matcher is `{ "token": ["<primary-command>", "<primary-command>"], "action": "deny" }` and segments are `<executable> <primary-command> <primary-command>` and `<executable> <primary-command> <trailing-arg>`
- **THEN** the first matches (path elements consume distinct positional tokens) and the second does not

#### Scenario: Equal flag set in any position yields equal result

- **WHEN** matcher is `{ "token": ["<primary-command>", "<secondary-command>"], "action": "allow" }`, the entry declares `"<flags>": { "<global-flag>": 0 }`, and segments are `<executable> <primary-command> <secondary-command> <global-flag>`, `<executable> <global-flag> <primary-command> <secondary-command>`, and `<executable> <primary-command> <global-flag> <secondary-command>`
- **THEN** all three segments produce the identical result — flags are position-independent

#### Scenario: Flag without value does not shift levels

- **WHEN** the entry declares `"<flags>": { "<global-flag>": 0 }` and matcher is `{ "token": ["<primary-command>", "<secondary-command>"], "action": "allow" }`, and segment is `<executable> <primary-command> <global-flag> <secondary-command>`
- **THEN** the value-less flag is skipped by the structural classification and the path matches

#### Scenario: Declared value flag consumes its value atomically

- **WHEN** the entry declares `"<flags>": { "<global-flag>": 1 }` and matcher is `{ "token": ["<primary-command>", "<secondary-command>"], "action": "allow" }`, and segment is `<executable> <global-flag> <flag-value> <primary-command> <secondary-command>`
- **THEN** `<flag-value>` is consumed as the flag's value, is not a positional, and the path matches

#### Scenario: Declared flag consumes dash-prefixed values unconditionally

- **WHEN** the entry declares `"<flags>": { "<global-flag>": 1 }` and matcher is `{ "token": ["<primary-command>", "<secondary-command>"], "action": "allow" }`, and segment is `<executable> <primary-command> <global-flag> -1 <secondary-command>`
- **THEN** `-1` is consumed unconditionally as the declared flag's value (the explicit arity declaration is authoritative over the leading dash), is not a positional, and the path matches

#### Scenario: Flag value is not a foreign positional

- **WHEN** the entry declares `"<flags>": { "<global-flag>": 1 }` and matcher is `{ "token": ["<primary-command>", "<secondary-command>"], "action": "deny" }`, and segment is `<executable> <primary-command> <global-flag> <flag-value> <secondary-command>`
- **THEN** the declared value does not sit between the path levels and the path matches

#### Scenario: Equals-form is equivalent to separate-token form

- **WHEN** matcher is `{ "token": "<global-flag>", "pattern": "<flag-value>", "action": "deny" }` and segments are `<executable> <primary-command> <global-flag> <flag-value>` and `<executable> <primary-command> <global-flag>=<flag-value>`
- **THEN** both segments match the same value matcher — the `=`-form is normalized into the base flag plus an inline value atom; a flag predicate on `<global-flag>` matches both spellings, and the inline value atom is visible to the operand matcher identically to the separate-token value

#### Scenario: Undeclared flag is a probable missing arity — the segment asks (fail-safe)

- **WHEN** no arity is declared for `<global-flag>`, matcher is `{ "token": ["<primary-command>", "<secondary-command>"], "action": "allow" }`, and segments are `<executable> <global-flag> <flag-value> <primary-command> <secondary-command>` and `<executable> <primary-command> <global-flag> <flag-value>`
- **THEN** both segments resolve to `ask` regardless of the flag's position — an undeclared flag followed by a non-dash token is a probable missing arity, and the classification ambiguity always resolves to human review; a one-time warning identifies the flag to declare

#### Scenario: Repeated flag resolves deterministically

- **WHEN** the entry declares `"<flags>": { "<global-flag>": 1 }` and matcher is `{ "token": "<global-flag>", "pattern": "<flag-value>", "action": "deny" }`, and segment is `<executable> <primary-command> <global-flag> <flag-value> <global-flag> <trailing-arg>`
- **THEN** each occurrence consumes its own adjacent value by the same linear classification and the matcher matches deterministically

#### Scenario: Repeated value flag — allow requires every occurrence (fail-safe refinement)

- **WHEN** the entry declares `"<flags>": { "<global-flag>": 1 }` and matchers are `{ "token": "<global-flag>", "action": "deny" }` and `{ "token": "<global-flag>", "pattern": "<allowed-value>", "action": "allow" }`, and segment is `<executable> <global-flag> <allowed-value> <global-flag> <dangerous-value>`
- **THEN** the allow matcher does not match (one occurrence's value fails the pattern — allow requires every occurrence), the bare deny survives refinement, and the args-level action is `deny`; with `ask`/`deny` a single matching occurrence suffices

#### Scenario: Deny sees declared flag values

- **WHEN** the entry declares `"<flags>": { "<global-flag>": 1 }` and matchers are `{ "operand": "all", "pattern": "<sensitive-value>", "action": "deny" }` and `{ "token": "<global-flag>", "pattern": "<allowed-value>", "action": "allow" }`, and segment is `<executable> <global-flag> <sensitive-value>`
- **THEN** the declared flag value is a safety-operand candidate, the operand deny matches, and the args-level action is `deny` — a declared value can never hide from operand-based safety policies

#### Scenario: Post-separator operands remain visible to the operand deny

- **WHEN** matcher is `{ "operand": "all", "pattern": "<sensitive-value>", "action": "deny" }` and segment is `<executable> <primary-command> -- <sensitive-value>`
- **THEN** the post-separator operand is a candidate, the deny matches, and the args-level action is `deny`; operands after `--` are never command levels or flags, but they are never invisible to operand-based safety policies

#### Scenario: Conflicting table arity resolves the executable to ask

- **WHEN** two `<executable>` entries exist, one declaring `"<flags>": { "<global-flag>": 1 }` and the other `"<flags>": { "<global-flag>": 0 }`, and segment is `<executable> <primary-command> <global-flag> <flag-value>`
- **THEN** the equal-rank table conflict is unresolved by precedence, the executable's args policy is suspended, and the segment resolves to `ask` (glob allows suspended for that tool), with a warning naming the flag and both entries — the same `argv` can never classify differently per entry

#### Scenario: Value matcher contradicted by a value-less table declaration forces scoped ask

- **WHEN** one `<executable>` entry declares `"<flags>": { "<global-flag>": 0 }` and another entry declares a value matcher `{ "token": "<global-flag>", "pattern": "<allowed-value>", "action": "allow" }`, and segment is `<executable> <primary-command> <global-flag> <allowed-value>`
- **THEN** the contradiction suspends the executable's args policy and the segment resolves to `ask` (glob allows suspended for that tool), with a warning naming the flag and both entries — a table-declared value-less flag must never let a value matcher promote an ordinary operand to an allowed flag value

#### Scenario: Equals-form on a declared value-less flag asks

- **WHEN** the entry declares `"<flags>": { "<global-flag>": 0 }` and segment is `<executable> <primary-command> <global-flag>=<flag-value>`
- **THEN** a value on a declared value-less flag contradicts the declaration and the segment resolves to `ask` (an undeclared `=`-form, by contrast, is fully classified: base flag plus a visible inline value atom, deterministic and not an ask)

#### Scenario: Possible missing arity warns once

- **WHEN** no arity is declared for `<global-flag>` and the first segment containing it followed by a non-dash token is evaluated
- **THEN** the engine emits a one-time warning naming `<global-flag>` as a probable missing arity declaration (later segments do not repeat it), and the segment resolves to `ask` while the ambiguity remains

#### Scenario: Invalid restrictive entry forces the executable to ask

- **WHEN** a `<executable>` entry contains an invalid matcher that would otherwise be a `deny` rule, and native config allows that command via a glob
- **THEN** the invalid entry is dropped with a warning AND the executable resolves to `ask` (glob allows suspended for that tool) until the config is fixed — dropping a restrictive rule must not fall through to a possibly-allowing glob

#### Scenario: Tokens after the separator are trailing arguments

- **WHEN** matcher is `{ "token": ["<primary-command>", "<secondary-command>"], "action": "allow" }` and segment is `<executable> <primary-command> -- <secondary-command>`
- **THEN** `<secondary-command>` is a post-separator operand, the path is incomplete, and the matcher does not match; post-separator operands are never command levels, flags, or flag values, but remain visible to the operand matcher

#### Scenario: Quoted flag cannot bypass a deny

- **WHEN** matcher is `{ "token": ["<primary-command>", "<local-flag>"], "action": "deny" }` and segment is `<executable> <primary-command> "<local-flag>" <trailing-arg>`
- **THEN** the token is argv-style (quotes stripped) and the path matches — quoting does not bypass the deny

#### Scenario: Clustered short flags match single-letter targets

- **WHEN** matcher is `{ "token": "<local-flag>", "action": "deny" }` where `<local-flag>` is a single-letter short flag, and segment is `<executable> <positional> <clustered-flags> <trailing-arg>`
- **THEN** the clustered token expands for matching and the single-letter target matches, contributing `deny`

#### Scenario: Cluster matches do not consume — sibling flags still match

- **WHEN** an entry declares both `{ "token": "<first-short-flag>", "action": "deny" }` and `{ "token": "<second-short-flag>", "action": "ask" }`, and segment is `<executable> <positional> <clustered-both-flags>`
- **THEN** both matchers match the same clustered token independently and contribute (`deny`, `ask`); the args-level action is `deny`

#### Scenario: Token value matchers do not match via cluster expansion

- **WHEN** matcher is `{ "token": "<local-flag>", "pattern": "<flag-value>", "action": "deny" }` where `<local-flag>` is a single-letter short flag, and segment is `<executable> <positional> <clustered-flags> <flag-value>`
- **THEN** the matcher does not match — a value cannot be attributed to one letter of a cluster; token value matching requires exact token equality

#### Scenario: Key=value options are ordinary candidates

- **WHEN** matcher is `{ "position": "all", "pattern": "<positional>", "action": "deny" }` and segment is `<executable> <key=value-positional> <key=value-positional>`
- **THEN** the candidates are the full tokens, neither glob-matches, and the matcher does not match; key=value options without a leading dash are not flags and are not decomposed (documented limitation; the pattern must match the full token)

#### Scenario: Flag token matches anywhere

- **WHEN** matcher is `{ "token": "<local-flag>", "action": "ask" }` and segment is `<executable> <positional> <positional> <local-flag>`
- **THEN** the matcher matches and contributes `ask`

#### Scenario: Flag not present — no match

- **WHEN** matcher is `{ "token": "<local-flag>", "action": "ask" }` and segment is `<executable> <positional> <positional>`
- **THEN** the matcher does not match

#### Scenario: Positional pattern match

- **WHEN** matcher is `{ "position": 0, "pattern": "<positional>", "action": "allow" }` and segment is `<executable> <positional> <local-flag>`
- **THEN** the matcher matches (operand 0 is the leading operand)

#### Scenario: Positional pattern mismatch

- **WHEN** matcher is `{ "position": 0, "pattern": "<positional>", "action": "allow" }` and segment is `<executable> <trailing-arg>`
- **THEN** the matcher does not match

#### Scenario: Numeric position counts positional arguments only — flags never shift the index

- **WHEN** a `<executable>` entry declares `{ "token": "<local-flag>", "action": "ask" }` and `{ "position": 0, "pattern": "<positional>", "action": "allow" }`, and segments are `<executable> <positional> <local-flag>` and `<executable> <local-flag> <positional>`
- **THEN** both segments resolve `position: 0` to the same positional — flags never occupy a positional slot regardless of where they appear; both matchers contribute and the args-level action is `ask`

#### Scenario: Flag values without a dash count as positionals (heuristic limitation)

- **WHEN** no arity is declared for `<local-flag>` and matcher is `{ "position": 0, "pattern": "<positional>", "action": "allow" }`, and segment is `<executable> <local-flag> <flag-value>`
- **THEN** the undeclared flag is treated as value-less and `<flag-value>` counts as positional 0 (fail-safe heuristic; declaring the flag removes the value from the positional list)

#### Scenario: Inserted global flag no longer shifts positional indices — its value does

- **WHEN** the entry declares `"<flags>": { "<global-flag>": 1 }` and matcher is `{ "position": 0, "pattern": "<primary-command>", "action": "allow" }`, and segments are `<executable> <primary-command> <local-flag>` and `<executable> <global-flag> <flag-value> <primary-command> <local-flag>`
- **THEN** in both segments position 0 is `<primary-command>` and the matcher matches — a declared flag and its value never occupy positional slots (indices are stable under flag placement); the declared value remains visible to the operand matcher for safety policies

#### Scenario: All-position — all candidates match

- **WHEN** matcher is `{ "position": "all", "pattern": "<positional>", "action": "allow" }` and segment is `<executable> <positional> <positional> <positional>`
- **THEN** the matcher matches (all candidates glob-match) and contributes `allow`

#### Scenario: All-position with allow — one mismatch fails the whole matcher

- **WHEN** same matcher and one candidate does not glob-match the pattern
- **THEN** the matcher does not match and contributes nothing; the segment falls to the glob level

#### Scenario: All-position ignores flag-like tokens

- **WHEN** same matcher and segment is `<executable> <local-flag> <positional> <positional>`
- **THEN** the matcher matches (flags are not candidates)

#### Scenario: All-position — no candidates means no match

- **WHEN** same matcher and segment is `<executable> <local-flag>`
- **THEN** the matcher does not match

#### Scenario: All-position with deny — one sensitive path is enough

- **WHEN** matcher is `{ "position": "all", "pattern": "<positional>", "action": "deny" }` and one of the positional candidates glob-matches the pattern
- **THEN** the matcher matches and contributes `deny` — the mixed command cannot escape the deny

#### Scenario: All-position with deny — no matching candidate means no match

- **WHEN** same matcher and no candidate glob-matches the pattern
- **THEN** the matcher does not match and contributes nothing; the segment falls to the glob level

#### Scenario: All-position with deny — no candidates means no match

- **WHEN** same matcher and segment is `<executable> <local-flag>`
- **THEN** the matcher does not match

#### Scenario: All-position combines with other matchers

- **WHEN** an entry declares both `{ "position": "all", "pattern": "<positional>", "action": "allow" }` and `{ "token": "<local-flag>", "action": "deny" }`, and segment is `<executable> <positional> <positional> <local-flag>`
- **THEN** both matchers contribute (`allow`, `deny`) and the args-level action is `deny`

#### Scenario: Flag value pattern

- **WHEN** matcher is `{ "token": "<local-flag>", "pattern": "<flag-value>", "action": "allow" }` and segment is `<executable> <primary-command> <local-flag> <flag-value>`
- **THEN** the matcher matches the atomic flag-with-value pair; a different value does not match

#### Scenario: Nested subcommand rules

- **WHEN** tool entry is `<executable>` with `{ "token": ["<primary-command>", "<secondary-command>", "<local-flag>"], "action": "deny" }` and segment is `<executable> <primary-command> <secondary-command> <local-flag> <trailing-arg>`
- **THEN** `<local-flag>` is a flag predicate (position-free), the positional levels `<primary-command> → <secondary-command>` form the anchored contiguous prefix, and the rule contributes `deny`; a path rule is self-contained — there is no ancestor action to accumulate

#### Scenario: Flag element in a path is a position-free predicate

- **WHEN** tool entry is `<executable>` with `{ "token": ["<primary-command>", "<dangerous-flag>"], "action": "deny" }` and segments are `<executable> <primary-command> <dangerous-flag>`, `<executable> <dangerous-flag> <primary-command>`, and `<executable> <primary-command>`
- **THEN** the first two match (positional level anchored at `<primary-command>`, flag predicate present anywhere) and the third does not (the predicate is absent) — legacy path-with-flag deny rules keep matching with equivalent-or-narrower meaning

#### Scenario: Nested rules require the parent token

- **WHEN** tool entry is `<executable>` with `{ "token": ["<primary-command>", "<secondary-command>"], "action": "deny" }` and segments are `<executable> <trailing-arg>`, `<executable> <primary-command>`, and `<executable> <primary-command> <secondary-command-partial>`
- **THEN** none match: every level must be present, anchored, and whole-token

### Requirement: Most-restrictive-wins among matched args rules

When one or more matchers match a segment, matching matchers that are REFINED by another matching matcher SHALL first be discarded, and the segment's args-level action SHALL be the most restrictive among the remaining actions (`deny` > `ask` > `allow`), regardless of declaration order. Matcher A refines matcher B only when both are token matchers and either B's token path is a prefix of A's token path AND every flag predicate of B is matched by an identical flag predicate of A (same base flag and, when value-conditioned, the same value glob — a presence predicate and a value-conditioned predicate on one base flag are incomparable: fail-safe most-restrictive) AND at least one dimension is strict — strictly longer levels or a proper flag-predicate superset — or A and B declare the same single-string flag token and A declares a `pattern` where B does not (a value-constrained matcher describes a narrower command set). Structurally identical matchers never refine each other: without a strict dimension both survive and reduce most-restrictive (fail-safe for duplicates). A path rule and a value matcher are always incomparable — a value matcher carries a value constraint that path levels cannot prove subsumed — so a value-specific `deny` always survives an exact-path `allow`, and the two reduce most-restrictive. Refinement wins in whichever direction it points: a refined general rule is discarded even when it was more restrictive, and a refined specific rule overrides the general one. Position matchers never refine and are never refined; incomparable matchers — including any token matcher against a position matcher, or two different paths of equal length — SHALL reduce together most-restrictive-wins, so a global-flag `deny` or `ask` can never be silently defeated by an unrelated exact-path `allow`. If no matcher matches (and the executable is not flagged invalid), the segment SHALL have no args-level opinion and the existing `permission.bash` glob pipeline decides unchanged.

#### Scenario: Ask wins over allow

- **WHEN** segment matches both a `<local-flag> → ask` matcher and a position-0 `allow` matcher
- **THEN** the matchers are incomparable (position matchers never refine) and the args-level action is `ask`

#### Scenario: Deny wins over ask

- **WHEN** segment matches `{ "token": "<local-flag>", "action": "deny" }` and `{ "position": "all", "pattern": "<positional>", "action": "ask" }`
- **THEN** the matchers are incomparable and the args-level action is `deny`

#### Scenario: Single match decides

- **WHEN** segment matches only a position-0 `allow` matcher
- **THEN** the args-level action is `allow`

#### Scenario: No match — no opinion

- **WHEN** segment matches no matcher of the entry
- **THEN** the segment has no args-level opinion

#### Scenario: Refined prefix rule is discarded

- **WHEN** an entry declares `{ "token": ["<primary-command>"], "action": "deny" }` and `{ "token": ["<primary-command>", "<local-flag>"], "action": "ask" }`, and segment is `<executable> <primary-command> <local-flag>`
- **THEN** the `["<primary-command>"]` rule is refined by the longer path and discarded; the args-level action is `ask` — not the most-restrictive `deny`

#### Scenario: Refinement can loosen — allow exception under deny

- **WHEN** an entry declares `{ "token": ["<primary-command>"], "action": "deny" }` and `{ "token": ["<primary-command>", "<secondary-command>"], "action": "allow" }`, and segments are `<executable> <primary-command> <secondary-command>` and `<executable> <primary-command> <trailing-arg>`
- **THEN** the first resolves to `allow` (the refined rule overrides the deny), and the second to `deny` (the prefix rule still covers every unlisted path)

#### Scenario: Global flag ask survives an exact-path allow

- **WHEN** an entry declares `{ "token": ["<primary-command>", "<secondary-command>"], "action": "allow" }` and `{ "token": ["<global-flag>"], "action": "ask" }`, and segment is `<executable> <primary-command> <global-flag> <secondary-command>`
- **THEN** neither rule refines the other, so both reduce most-restrictive-wins and the args-level action is `ask`

#### Scenario: Value-constrained matcher refines its bare token

- **WHEN** an entry declares `{ "token": "<local-flag>", "action": "deny" }` and `{ "token": "<local-flag>", "pattern": "<flag-value>", "action": "allow" }`, and segments are `<executable> <primary-command> <local-flag> <flag-value>` and `<executable> <primary-command> <local-flag> <trailing-arg>`
- **THEN** the first resolves to `allow` (the value rule refines the bare flag and overrides it), and the second to `deny` (the pattern does not match, only the bare rule remains)

#### Scenario: Flag predicate scopes an exception under a general deny

- **WHEN** an entry declares `{ "token": ["<primary-command>"], "action": "deny" }` and `{ "token": ["<primary-command>", "<dangerous-flag>"], "action": "allow" }`, and segments are `<executable> <primary-command> <dangerous-flag>` and `<executable> <primary-command> <trailing-arg>`
- **THEN** the longer path refines the prefix rule (levels prefix, flag-predicate superset): the first resolves to `allow`, the second to `deny` — the exception is scoped to the flagged command

#### Scenario: Flag-scoped deny overrides a general allow

- **WHEN** an entry declares `{ "token": ["<primary-command>"], "action": "allow" }` and `{ "token": ["<primary-command>", "<dangerous-flag>"], "action": "deny" }`, and segment is `<executable> <primary-command> <dangerous-flag>`
- **THEN** the flag-scoped deny refines the general allow and the args-level action is `deny` — refinement is direction-agnostic: specificity wins, and incomparable rules stay most-restrictive

#### Scenario: Structurally identical matchers do not refine each other

- **WHEN** an entry declares two structurally identical matchers `{ "token": ["<primary-command>"], "action": "deny" }` and `{ "token": ["<primary-command>"], "action": "deny" }`, and segment is `<executable> <primary-command>`
- **THEN** neither refines the other (no strict dimension), both survive and contribute `deny`, and the args-level action is `deny` — duplicate rules can never cancel each other out

#### Scenario: Structurally identical matchers do not refine each other

- **WHEN** an entry declares two structurally identical matchers `{ "token": ["<primary-command>"], "action": "deny" }` and `{ "token": ["<primary-command>"], "action": "deny" }`, and segment is `<executable> <primary-command>`
- **THEN** neither refines the other (no strict dimension), both survive and contribute `deny`, and the args-level action is `deny` — duplicate rules can never cancel each other out
