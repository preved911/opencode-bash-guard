## MODIFIED Requirements

### Requirement: Parse permissions rules from the plugin config file

The system SHALL read an optional `permissions` array from the plugin config file `opencode-bash-guard.jsonc` (project `.opencode/` and global opencode config dir, project wins) into typed tool entries `{ tool: string, args: ArgMatcher[], flags?: Record<string, 0 | 1> }`. Each arg matcher SHALL declare exactly one of `token: string | string[]` or `position: number | "all"`. An array `token` declares an ordered, anchored command path (see the matching requirement). `pattern: string` is REQUIRED with `position` and OPTIONAL with a single-string `token` that MUST start with `-`; `pattern` combined with an array `token` or with a non-flag single-string `token` is invalid. A matcher MAY omit `action`; an omitted action SHALL normalize to `"ask"`. When present, `action` MUST be `"allow" | "ask" | "deny"`. The optional per-entry `flags` table declares flag arity: keys are whole flag tokens, values are `0` (value-less) or `1` (takes one value); any other key or value shape invalidates the entry. Nested `args` trees are not part of the schema: a matcher declaring `args` is invalid. Entries failing validation SHALL be dropped with a warning naming them. When the file or section is absent, the parsed rule list SHALL be empty and plugin behavior SHALL be identical to before this change. When the file fails to parse as JSONC, the plugin SHALL enter degraded mode: `permissions` is treated as absent AND glob allows are suspended for that run, every bash segment SHALL resolve to `ask` (parse-error segments still deny), with a warning naming the file, so a broken config can never silently disable `deny` rules that were meant to be active.

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

- **WHEN** `permissions` contains an entry without `tool`, a matcher with both `token` and `position`, a matcher with neither `token` nor `position`, one with `action: "block"`, a legacy matcher declaring nested `args`, a matcher combining `pattern` with an array `token`, a matcher combining `pattern` with a non-flag single-string `token`, an entry with a `flags` value other than `0` or `1`, and an entry with an empty array `token`
- **THEN** each invalid entry is dropped and a warning names it

#### Scenario: Section absent

- **WHEN** `opencode-bash-guard.jsonc` does not exist or has no `permissions` section
- **THEN** the args rule list is empty and no behavior changes vs. the previous release

#### Scenario: Broken config file degrades to ask-everything

- **WHEN** `opencode-bash-guard.jsonc` contains a JSONC syntax error and native config has `"*": "ask"` as the fallback
- **THEN** a warning names the parse error and every bash segment resolves to `ask`; the prompt persists until the config is fixed

### Requirement: Structured arg matcher semantics

The system SHALL parse every segment once, after `<executable>`, into a classified token sequence — command-path levels, flags, flag values, ordinary positionals, and trailing arguments — and every matcher SHALL evaluate against that classification. A token equal to `--` ends classification: all later tokens are trailing arguments and are never command levels, flags, or flag values. A token starting with `-` is a flag: a `<flag>=<flag-value>` token is a self-contained flag with inline value; otherwise the flag's arity is resolved from the entry configuration (a value matcher on that flag, or the `flags` arity table), and a declared value-taking flag SHALL consume the next token unconditionally as its `flag-value` — including tokens that start with `-` (negative numbers, options-as-values): an explicit arity declaration is authoritative and is never second-guessed — provided that next token exists and is not `--`; an undeclared flag SHALL be treated as value-less, so its would-be value remains a positional and fail-closed anchoring applies. All remaining tokens are positionals: those before the command path completes are command-level candidates, those after are trailing arguments. Tokens SHALL be argv-style and quote-aware, derived from the same AST parse the chain splitter performs, with matched quote pairs stripped and quoted whitespace kept within a token. Commands whose chain parse failed never reach matcher evaluation (they fail closed earlier). Matchers are evaluated independently — no matcher consumes tokens on behalf of another. An array `token` declares an ordered, anchored command path: its levels SHALL equal, in array order, the leading positional command tokens — flags and declared flag values may appear before, between, and after the levels without affecting the result, but a foreign positional before the first level or between levels SHALL break the match, a missing or extra level SHALL break the match, elements match whole tokens exactly (no partial or prefix token matching), and trailing arguments after the complete path do not invalidate the match. A single-string `token` matcher matches any equal flag or positional token; when it declares `pattern` its token MUST be a flag, and the matcher SHALL match only the atomic `<flag>` + `<flag-value>` pair — the structurally adjacent next token, or the same flag in `=`-form — with the value glob-matching the `pattern`; the pair consumed this way is a flag value, never a positional. `token` matching SHALL additionally expand clustered short flags: a target of one letter after `-` SHALL also match a clustered token of single-letter short flags; other forms are not expanded, and cluster-expanded matches never consume a value. Repeated flags are resolved deterministically by the same linear classification. A `position`+`pattern` matcher matches the N-th positional of the structural positional list (declared flag values excluded; tokens after `--` excluded). `position: "all"` is the variable-arity form over that list, and its quantifier SHALL be derived from `action` so the matcher always fails safe: with `action: "allow"`, every candidate MUST glob-match the pattern (one mismatch or zero candidates means no match); with `action: "ask"` or `"deny"`, at least one candidate glob-matching the pattern is sufficient (zero candidates means no match). Matching is case-sensitive.

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
- **THEN** both segments match the same value matcher — the `=`-form is recognized as the atomic flag-with-inline-value form

#### Scenario: Undeclared flag is treated as value-less (fail-safe)

- **WHEN** no arity is declared for `<global-flag>`, matcher is `{ "token": ["<primary-command>", "<secondary-command>"], "action": "allow" }`, and segment is `<executable> <global-flag> <flag-value> <primary-command> <secondary-command>`
- **THEN** `<flag-value>` is classified as a positional, the anchored path does not match, and the segment falls through to the glob pipeline — an undeclared arity never widens permissions

#### Scenario: Repeated flag resolves deterministically

- **WHEN** the entry declares `"<flags>": { "<global-flag>": 1 }` and matcher is `{ "token": "<global-flag>", "pattern": "<flag-value>", "action": "deny" }`, and segment is `<executable> <primary-command> <global-flag> <flag-value> <global-flag> <trailing-arg>`
- **THEN** each occurrence consumes its own adjacent value by the same linear classification and the matcher matches deterministically

#### Scenario: Tokens after the separator are trailing arguments

- **WHEN** matcher is `{ "token": ["<primary-command>", "<secondary-command>"], "action": "allow" }` and segment is `<executable> <primary-command> -- <secondary-command>`
- **THEN** `<secondary-command>` is a trailing argument after `--`, the path is incomplete, and the matcher does not match; tokens after `--` are never command levels, flags, or flag values

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
- **THEN** the matcher matches (structural positional 0 is the leading positional)

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
- **THEN** in both segments position 0 is `<primary-command>` — a declared flag value is consumed structurally and never occupies a positional slot (for an undeclared flag the value would occupy position 0 — documented fail-safe limitation)

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
- **THEN** the path matches and contributes only `deny`; a path rule is self-contained — there is no ancestor action to accumulate

#### Scenario: Nested rules require the parent token

- **WHEN** tool entry is `<executable>` with `{ "token": ["<primary-command>", "<secondary-command>"], "action": "deny" }` and segments are `<executable> <trailing-arg>`, `<executable> <primary-command>`, and `<executable> <primary-command> <secondary-command-partial>`
- **THEN** none match: every level must be present, anchored, and whole-token

### Requirement: Most-restrictive-wins among matched args rules

When one or more matchers match a segment, matching matchers that are REFINED by another matching matcher SHALL first be discarded, and the segment's args-level action SHALL be the most restrictive among the remaining actions (`deny` > `ask` > `allow`), regardless of declaration order. Matcher A refines matcher B only when both are token matchers and either B's token path is a proper element-prefix of A's token path (a longer anchored path describes a narrower command), or A and B declare the same single-string flag token and A declares a `pattern` where B does not (a value-constrained matcher describes a narrower command set). Refinement wins in whichever direction it points: a refined general rule is discarded even when it was more restrictive, and a refined specific rule overrides the general one. Position matchers never refine and are never refined; incomparable matchers — including any token matcher against a position matcher, or two different paths of equal length — SHALL reduce together most-restrictive-wins, so a global-flag `deny` or `ask` can never be silently defeated by an unrelated exact-path `allow`. If no matcher matches, the segment SHALL have no args-level opinion and the existing `permission.bash` glob pipeline decides unchanged.

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
