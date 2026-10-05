# args-permission-matching Specification

## Purpose

Match command segments against structured per-tool arg matchers declared in the plugin's own `opencode-bash-guard.jsonc` (`permissions` entries: token matchers with optional value globs and nested subcommand rules, positional slot matchers, and the variable-arity `position: "all"` form whose quantifier derives from the action). Matched rules resolve most-restrictive-wins ahead of the glob level; args-level allows override native asks; tokens are quote-aware argv-style; a broken config degrades to ask-everything so deny rules can never silently vanish. Stored args-level allow and deny decisions are delivered through `permission.asked` for the nested `tool.callID`.

## Requirements

### Requirement: Parse permissions rules from the plugin config file

The system SHALL read an optional `permissions` array from `opencode-bash-guard.jsonc` in the project `.opencode/` directory or global opencode config directory, with the project source winning, into typed tool entries `{ tool: string, args: ArgMatcher[], flags?: Record<string, 0 | 1> }`. `tool` MUST be a non-empty string and `args` MUST be an array. Every config source contributing a non-empty effective `permissions` array SHALL also declare `matcherVersion: 2` in that same source. An absent marker SHALL make every executable named by that permissions array resolve to `ask`, with glob allows suspended and a one-time migration warning. An explicit marker other than `2` SHALL trigger global degraded ask. A marker inherited from a different config source SHALL be ignored with a warning.

Each matcher SHALL declare exactly one selector: `token: string | string[]`, `position: non-negative safe integer | "all"`, or `operand: "all"`. `position` and `operand` REQUIRE `pattern`. A single-string flag `token` MAY declare `pattern` to match its value. An array `token` MAY declare `flagValues: Record<string, string>` to add atomic path-scoped flag-value glob predicates. A **base-flag identity** starts with `-`, is neither `-` nor `--`, and contains neither whitespace nor `=`. Every `flags` key, `flagValues` key, scalar flag token, and dash-prefixed array element MUST be a base-flag identity; value-bearing spellings such as `--namespace=kube-system` are invalid in those positions. Every `flagValues` value MUST be a string glob. `flagValues` is invalid on any other matcher kind. A flag MUST NOT occur both as a presence predicate in the array and as a `flagValues` key, and duplicate presence predicates are invalid. Array elements containing `=` are invalid legacy value-bearing predicates and SHALL be dropped with scoped ask until explicitly migrated to `flagValues`. `pattern` with an array or a non-flag scalar token is invalid. The separator `--` is invalid as any matcher token or array element. Empty arrays, nested `args`, unknown entry or matcher fields, invalid actions, invalid base-flag identities, and `flags` values other than `0` or `1` are invalid.

An omitted action SHALL normalize to `ask`; valid actions are `allow`, `ask`, and `deny`. Every invalid entry or matcher SHALL be dropped with a warning and SHALL force its identifiable executable to scoped `ask` with glob allows suspended. An invalid entry without a valid `tool`, a non-array `permissions` section, or another unscopable top-level schema failure SHALL trigger global degraded ask. When neither config source has a `permissions` section, the parsed rule list SHALL be empty and behavior SHALL remain unchanged. A missing config file (`ENOENT`) SHALL be treated as absent. When a selected config file fails to parse as JSONC or cannot be read for any other reason, the plugin SHALL warn with the file path and enter global degraded ask before matcher evaluation: every segment resolves to `ask` except parse-error segments that already deny, and no native glob allow may bypass the failure.

#### Scenario: Valid entries parse

- **WHEN** `permissions` contains `{ "tool": "<executable>", "args": [{ "token": "<local-flag>", "action": "ask" }, { "position": 0, "pattern": "<positional>", "action": "allow" }] }`
- **THEN** one tool entry is stored with two validated arg matchers

#### Scenario: Array token parses as a path

- **WHEN** `permissions` contains `{ "tool": "<executable>", "args": [{ "token": ["<primary-command>", "<secondary-command>"], "action": "deny" }] }`
- **THEN** one matcher is stored with a two-level ordered command path and action `deny`

#### Scenario: Omitted action defaults to ask

- **WHEN** `permissions` contains `{ "tool": "<executable>", "args": [{ "token": "<local-flag>" }] }`
- **THEN** the matcher is stored with its action normalized to `ask`

#### Scenario: Invalid entries dropped with warning

- **WHEN** `permissions` contains an entry without `tool`, a matcher with both `token` and `position`, a matcher with neither `token` nor `position`, one with `action: "block"`, a legacy matcher declaring nested `args`, a matcher combining `pattern` with an array `token`, a matcher combining `pattern` with a non-flag single-string `token`, a matcher whose `token` is `--`, an array `token` containing a `--` element, an array `token` containing a `=`-bearing element, an entry with a `flags` value other than `0` or `1`, and an entry with an empty array `token`
- **THEN** each invalid entry is dropped from the rule set, a warning names it, and the affected executable resolves to `ask` (glob allows suspended for that tool) until the config is fixed

#### Scenario: Section absent

- **WHEN** `opencode-bash-guard.jsonc` does not exist or has no `permissions` section
- **THEN** the args rule list is empty and no behavior changes vs. the previous release

#### Scenario: Broken config file degrades to ask-everything

- **WHEN** `opencode-bash-guard.jsonc` contains a JSONC syntax error and native config has `"*": "ask"` as the fallback
- **THEN** a warning names the parse error and every bash segment resolves to `ask`; the prompt persists until the config is fixed

#### Scenario: Unreadable config file degrades to ask-everything

- **WHEN** `opencode-bash-guard.jsonc` exists but reading it fails with an error other than `ENOENT`
- **THEN** a warning names the file and every bash segment resolves to `ask`; only a genuinely missing file is ignored

#### Scenario: Non-empty permissions require a same-source version marker

- **WHEN** a project config supplies a non-empty `permissions` array without `matcherVersion: 2`, while the global config contains `matcherVersion: 2`
- **THEN** the global marker does not opt in the project rules; every executable named by the project permissions resolves to `ask` with a migration warning

#### Scenario: Unsupported version degrades globally

- **WHEN** the config source providing permissions declares `matcherVersion: 1`
- **THEN** every segment resolves to `ask` because the explicit unknown version cannot be scoped safely

#### Scenario: Invalid restrictive matcher cannot fall through

- **WHEN** an invalid matcher would otherwise deny a command allowed by the native glob policy
- **THEN** the matcher is dropped with a warning and its executable resolves to `ask`, never to the allowing glob

#### Scenario: Unscopeable invalid entry degrades globally

- **WHEN** an invalid permission entry has no valid `tool`
- **THEN** every executable resolves to `ask` until the entry is fixed

#### Scenario: Invalid top-level permissions shape degrades globally

- **WHEN** `permissions` is not an array or another top-level schema error cannot be attributed to one executable
- **THEN** every executable resolves to `ask` until the config is fixed

#### Scenario: Legacy value-bearing array requires explicit migration

- **WHEN** an array contains `"<flag>=<value>"`
- **THEN** the matcher is invalid and its executable resolves to `ask`; it is not silently reinterpreted as a value glob or as matching separate-token spelling

#### Scenario: Section absent preserves existing behavior

- **WHEN** neither selected config source supplies a `permissions` section
- **THEN** the args rule list is empty and the existing native permission pipeline behaves unchanged

#### Scenario: Broken JSONC degrades globally

- **WHEN** the selected plugin config contains a JSONC syntax error while a native glob would allow the command
- **THEN** every segment resolves to `ask`, the allowing glob is suspended, and a warning names the broken file

### Requirement: Structured arg matcher semantics

The system SHALL classify argv-style, quote-aware tokens once after the executable, using the same AST parse as chain splitting; matched quote pairs are stripped and quoted whitespace remains within one token. Commands whose chain parse failed SHALL fail closed before matcher evaluation. The first `--` switches to the post-separator region; every later token is a post-separator operand and a later `--` is an ordinary operand. A lone `-` is an ordinary operand. A `<base-flag>=<value>` token SHALL normalize to a base-flag atom and an inline-value atom. Otherwise, a valid base-flag token is classified by its executable-wide arity. A consistently declared arity-1 flag SHALL consume exactly one following token, including a dash-prefixed token, unless it is `--`; a consistently declared arity-0 flag SHALL consume none. An `=` occurrence for a declared arity-0 flag SHALL resolve the segment to `ask`. An undeclared flag followed by any token other than `--` SHALL resolve the segment to `ask`; an undeclared terminal flag or one followed immediately by `--` is value-less. An undeclared `=`-form is deterministic because its spelling carries the value boundary; this is the explicit exception to separate-form missing-arity handling. Any other dash-prefixed spelling that cannot be classified as a base flag, normalized equals form, or safe short cluster SHALL resolve to `ask`.

Arity declarations SHALL be aggregated per executable from entry `flags` tables, scalar value matchers, and array `flagValues`. Absence is not a declaration. Any disagreement between arity `0` and arity `1` SHALL suspend that executable's args policy into scoped `ask`; neither interpretation wins. Subcommand-conditional arity is unsupported and conflicting subcommand declarations SHALL ask rather than guessing one grammar.

A short-option cluster SHALL expand only when the complete raw token has no exact arity declaration and every one-letter member is explicitly declared arity `0`. An exact declaration classifies the raw token as one base flag. Otherwise, if the token may contain an undeclared or arity-1 short flag, including attached forms such as `-ofile` or `-XPOST`, classification SHALL resolve to `ask`. Cluster expansion SHALL never infer a value boundary.

Classification SHALL derive two views:

- the **positional list**: ordinary pre-separator operands only, excluding every flag value and every post-separator operand;
- the **safety operand list**: every non-flag data token, including ordinary pre-separator operands, separate and inline flag values, and post-separator operands.

#### Scenario: Conflicting table declarations ask

- **WHEN** one entry declares `<flag>: 0` and another declares `<flag>: 1`
- **THEN** the executable resolves to `ask`; the engine does not choose either classification

#### Scenario: Table zero contradicts every value declaration

- **WHEN** a table declares `<flag>: 0` and either a scalar value matcher or array `flagValues` declares the same flag value-taking
- **THEN** the executable resolves to `ask` with a warning naming every conflicting entry

#### Scenario: Undeclared separate-token flag asks for any successor

- **WHEN** an undeclared flag is followed by either a non-dash token or a dash-prefixed token other than `--`
- **THEN** the segment resolves to `ask` regardless of the flag's position

#### Scenario: Declared zero rejects equals value

- **WHEN** `<flag>` is declared arity `0` and argv contains `<flag>=<value>`
- **THEN** the segment resolves to `ask`

#### Scenario: Declared value forms classify identically

- **WHEN** `<flag>` is consistently declared arity `1`
- **THEN** `<flag> <value>` and `<flag>=<value>` expose the same base flag and value atom to every matcher

#### Scenario: Ambiguous attached short value asks

- **WHEN** argv contains an attached short-option form that may contain an undeclared or value-taking short flag
- **THEN** the segment resolves to `ask`; the token is not treated as a value-less boolean cluster

#### Scenario: Bare scalar flag matches a classified flag atom

- **WHEN** matcher is `{ "token": "-f", "action": "deny" }` and `-f` occurs directly or as a member of a safely expanded all-boolean cluster
- **THEN** the matcher contributes `deny`; it does not consume or inspect any following operand

#### Scenario: Value-bearing flag identities are invalid

- **WHEN** a scalar flag token, dash-prefixed array element, `flags` key, or `flagValues` key contains `=`
- **THEN** the containing matcher or entry is invalid and its identifiable executable resolves to scoped `ask`

#### Scenario: Non-dash key-value spelling remains an operand

- **WHEN** argv contains `if=/dev/sda` or another non-dash token containing `=`
- **THEN** the complete token is one ordinary operand; it is not decomposed as a flag and value

#### Scenario: Complete safety view contains every operand class

- **WHEN** argv contains an ordinary positional, a separate flag value, an inline value, and a post-separator operand
- **THEN** all four are candidates of `operand: "all"`, while only the ordinary pre-separator positional is in the positional list

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
- **THEN** the matcher matches (operand 0 is the leading positional)

#### Scenario: Positional pattern mismatch

- **WHEN** matcher is `{ "position": 0, "pattern": "<positional>", "action": "allow" }` and segment is `<executable> <trailing-arg>`
- **THEN** the matcher does not match

#### Scenario: Numeric position counts positional arguments only — flags never shift the index

- **WHEN** a `<executable>` entry declares `{ "token": "<local-flag>", "action": "ask" }` and `{ "position": 0, "pattern": "<positional>", "action": "allow" }`, and segments are `<executable> <positional> <local-flag>` and `<executable> <local-flag> <positional>`
- **THEN** both segments resolve `position: 0` to the same positional — flags never occupy a positional slot regardless of where they appear; both matchers contribute and the args-level action is `ask`

#### Scenario: Flag values without a dash count as positionals (heuristic limitation)

- **WHEN** no arity is declared for `<local-flag>` and matcher is `{ "position": 0, "pattern": "<positional>", "action": "allow" }`, and segment is `<executable> <local-flag> <flag-value>`
- **THEN** the undeclared flag followed by a non-dash token is a probable missing arity and the segment resolves to `ask` — an undeclared value never silently occupies a positional slot (declaring the flag removes the ambiguity)

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
- **THEN** `<local-flag>` is a flag predicate (position-free), the positional levels form the anchored contiguous prefix, and the rule contributes `deny`; a path rule is self-contained — there is no ancestor action to accumulate

#### Scenario: Nested rules require the parent token

- **WHEN** tool entry is `<executable>` with `{ "token": ["<primary-command>", "<secondary-command>"], "action": "deny" }` and segments are `<executable> <trailing-arg>`, `<executable> <primary-command>`, and `<executable> <primary-command> <secondary-command-partial>`
- **THEN** none match: every level must be present, anchored, and whole-token

#### Scenario: Consumed tokens are not rematched

- **WHEN** matcher is `{ "token": ["<primary-command>", "<primary-command>"], "action": "deny" }` and segments are `<executable> <primary-command> <primary-command>` and `<executable> <primary-command> <trailing-arg>`
- **THEN** the first matches (path elements consume distinct positional tokens) and the second does not

#### Scenario: Path matches regardless of argument order

- **WHEN** matcher is `{ "token": ["<primary-command>", "<secondary-command>"], "action": "allow" }`, the entry declares `"<flags>": { "<global-flag>": 0 }`, and segments are `<executable> <primary-command> <secondary-command> <global-flag>`, `<executable> <global-flag> <primary-command> <secondary-command>`, and `<executable> <primary-command> <global-flag> <secondary-command>`
- **THEN** all three segments produce the identical result — flag placement (argument order of flags) is irrelevant; the command-path levels themselves remain order-enforced

#### Scenario: Path rule covers trailing arguments

- **WHEN** matcher is `{ "token": ["<primary-command>", "<secondary-command>"], "action": "deny" }` and segment is `<executable> <primary-command> <secondary-command> <trailing-arg> <trailing-arg>`
- **THEN** the path matches and contributes `deny` — trailing arguments after the complete path never invalidate a match

#### Scenario: Path with separate-token flag value

- **WHEN** the entry declares `"<flags>": { "<global-flag>": 1 }` and matcher is `{ "token": ["<primary-command>"], "flagValues": { "<global-flag>": "<flag-value>" }, "action": "allow" }`, and segment is `<executable> <global-flag> <flag-value> <primary-command>`
- **THEN** `<flag-value>` is consumed as the flag's value, is not a positional, and the path matches

**Matching rules.**

Every matcher SHALL evaluate independently against the immutable classified segment; one matcher never consumes or hides atoms from another. A scalar base-flag `token` without `pattern` SHALL match an equal base-flag atom anywhere in the segment, including a member exposed by safe short-cluster expansion, and one occurrence is sufficient for every action. A scalar non-flag `token` SHALL match an equal safety-operand atom anywhere in the segment. Exact whole-atom equality is required.

An array `token` SHALL match an ordered, anchored path. Non-dash elements are positional levels and SHALL equal the leading positional-list operands in order; a foreign operand before or between levels, a missing level, reordered levels, or partial token equality SHALL fail the matcher. Extra positional operands after the complete path are trailing arguments and SHALL NOT invalidate it. Dash-prefixed elements are position-independent presence predicates on base flags. A path matcher's `flagValues` entries are position-independent value predicates: each base flag SHALL have a structurally adjacent separate or inline value glob-matching the configured pattern. For repeated flags, an `allow` path predicate requires every occurrence to match; `ask` and `deny` require at least one. Presence and value predicates for the same flag SHALL not be combined in one matcher.

Scalar flag value matchers SHALL bind only to the classified adjacent value. For repeated flags, `allow` SHALL require every occurrence to have a matching value; `ask` and `deny` SHALL require at least one matching occurrence.

`position: N` and `position: "all"` SHALL operate only on the positional list. `operand: "all"` SHALL operate on the complete safety operand list. For `allow`, an `"all"` matcher requires one or more candidates and every candidate to match. For `ask` and `deny`, one matching candidate is sufficient; zero candidates means no match.

#### Scenario: Anchored ordered path

- **WHEN** matcher path is `["primary", "secondary"]`
- **THEN** `tool primary secondary trailing` matches, while reordered, partial, missing, prefixed-by-foreign-operand, and interrupted paths do not

#### Scenario: Atomic path plus value predicate

- **WHEN** matcher is `{ "token": ["get"], "flagValues": { "--namespace": "kube-system" }, "action": "deny" }`
- **THEN** both `tool get --namespace kube-system` and `tool get --namespace=kube-system` match, while another path or another namespace value does not

#### Scenario: Independent matchers are not a conjunction

- **WHEN** a path matcher and an operand matcher are declared as separate entries
- **THEN** each contributes independently; documentation SHALL NOT present the pair as an atomic path-plus-value replacement

#### Scenario: Position is stable under declared flags

- **WHEN** an arity-1 flag and its value move before, between, or after ordinary positionals
- **THEN** numeric position indices identify the same ordinary operands

#### Scenario: Operand matcher covers ordinary and special operands

- **WHEN** a deny `operand: "all"` pattern matches an ordinary positional, a flag value, or a post-separator operand
- **THEN** the deny matches in every case

### Requirement: Most-restrictive-wins among matched args rules

Matched rules SHALL first discard only rules proven to be refined, then reduce survivors most-restrictive (`deny` > `ask` > `allow`). One array path refines another only when the general positional levels are a prefix, every general presence predicate and `flagValues` pair is structurally identical in the specific matcher, and at least one dimension is strict. Presence and value predicates on the same base flag are incomparable. Structurally identical matchers do not refine each other.

Array paths, scalar non-flag token matchers, scalar flag matcher families, position matchers, and operand matchers SHALL be mutually incomparable across matcher kinds. Within one scalar flag family, matchers for different base flags or different value patterns are incomparable. A patterned `allow` MAY refine the same bare flag only when every repeated occurrence satisfies the pattern. A patterned `ask` and a bare `deny` SHALL remain incomparable. All incomparable matches reduce most-restrictive. If no matcher matches and the executable is not suspended or invalid, the existing native glob pipeline decides unchanged.

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

#### Scenario: Value deny survives exact path allow

- **WHEN** an exact path allow and an independent value-specific deny both match
- **THEN** they are incomparable and the result is `deny`

#### Scenario: Scalar deny survives path allow

- **WHEN** a position-free scalar non-flag deny and an anchored path allow both match
- **THEN** they are incomparable and the result is `deny`

#### Scenario: Patterned ask cannot downgrade repeated bare deny

- **WHEN** a bare repeated-flag deny matches and a patterned ask matches only one benign occurrence
- **THEN** the rules are incomparable and the result is `deny`

#### Scenario: Structurally identical rules survive together

- **WHEN** two structurally identical rules match
- **THEN** neither refines the other and their actions reduce most-restrictive

### Requirement: Check pipeline — args level, then permission block level, then native checks

For each segment, the bash action SHALL be resolved as: args-level action when any args matcher matched; otherwise the existing `permission.bash` glob evaluation (unchanged, including last-match-wins); otherwise no opinion and native opencode permission checks apply. The old glob-based behavior SHALL be preserved for every segment no args rule matches. In degraded mode (broken config file) this pipeline is bypassed: every segment SHALL resolve to `ask` regardless of glob rules, so losing the args rules can never silently re-allow a restricted command.

#### Scenario: Args allow overrides a broad native ask

- **WHEN** `permissions` has `curl` → `{ "token": "-X", "pattern": "GET", "action": "allow" }`, native `permission.bash` has `"*": "ask"`, and segment is `curl -X GET https://api.com`
- **THEN** the segment's action is `allow` from the args level, stored for the callID, and `permission.asked` replies `once` through the SDK — the command runs without a prompt

#### Scenario: Args deny overrides a glob allow

- **WHEN** native `permission.bash` has `"find *": "allow"`, `permissions` has `find` → `{ "token": "-delete", "action": "deny" }`, and segment is `find /tmp -delete`
- **THEN** the segment's action is `deny` from the args level — args decisions precede the glob level whenever any matcher matched, so `find` stays allowed everywhere except with `-delete`

#### Scenario: Unmatched segment falls through to glob level

- **WHEN** same config and segment is `curl -X POST https://api.com` (no args match)
- **THEN** the segment's action comes from the native glob evaluation — `ask`, dialog shown

#### Scenario: Segment matching no rule at either level

- **WHEN** segment `wget evil.sh` matches neither args rules nor any glob pattern except `"*": "ask"`
- **THEN** the segment's action is `ask` via the glob level (existing behavior)

#### Scenario: Glob-only allow unchanged

- **WHEN** segment `git status` is allowed via glob `"git *": "allow"` and matches no args rule
- **THEN** the plugin stores nothing and does not intervene

#### Scenario: Args ask prompts, args deny blocks

- **WHEN** segment `find /tmp -name "*.log" -delete` resolves to args `ask`, and segment `git push --force origin main` resolves to args `deny`
- **THEN** the first wraps and shows the native dialog; the second is blocked

### Requirement: Chain aggregation includes args-rule actions

Args-level actions SHALL participate in existing segment resolution and most-restrictive-wins chain aggregation (deny > ask > allow) with no new aggregation rules. A chain whose aggregated action is `allow` and where at least one segment's allow came from an args rule SHALL store the `allow` decision and reply `once` to `permission.asked`; chains whose allows come only from glob rules SHALL keep today's no-intervention behavior.

#### Scenario: Mixed chain aggregates most restrictive

- **WHEN** chain is `git status && find /tmp -delete` where `git status` → allow (glob) and `find /tmp -delete` → ask (args rule)
- **THEN** the chain action is `ask`

#### Scenario: All-allow args chain force-allows

- **WHEN** chain is `curl -X GET https://a.com && curl -X GET https://b.com` and both segments match the args `allow` matcher while native matching would ask
- **THEN** the chain action is `allow`, stored, and enforced through a `once` reply to `permission.asked`

#### Scenario: One ask segment asks the chain

- **WHEN** chain is `curl -X GET https://a.com && curl -X POST https://b.com` (second segment falls through to native `"*": "ask"`)
- **THEN** the chain action is `ask`
