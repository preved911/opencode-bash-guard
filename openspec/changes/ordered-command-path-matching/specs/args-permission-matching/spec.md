## MODIFIED Requirements

### Requirement: Parse permissions rules from the plugin config file

The system SHALL read an optional `permissions` array from `opencode-bash-guard.jsonc` in the project `.opencode/` directory or global opencode config directory, with the project source winning, into typed tool entries `{ tool: string, args: ArgMatcher[], flags?: Record<string, 0 | 1> }`. `tool` MUST be a non-empty string and `args` MUST be an array. Every config source contributing a non-empty effective `permissions` array SHALL also declare `matcherVersion: 2` in that same source. An absent marker SHALL make every executable named by that permissions array resolve to `ask`, with glob allows suspended and a one-time migration warning. An explicit marker other than `2` SHALL trigger global degraded ask. A marker inherited from a different config source SHALL be ignored with a warning.

Each matcher SHALL declare exactly one selector: `token: string | string[]`, `position: non-negative safe integer | "all"`, or `operand: "all"`. `position` and `operand` REQUIRE `pattern`. A single-string flag `token` MAY declare `pattern` to match its value. An array `token` MAY declare `flagValues: Record<string, string>` to add atomic path-scoped flag-value glob predicates. A **base-flag identity** starts with `-`, is neither `-` nor `--`, and contains neither whitespace nor `=`. Every `flags` key, `flagValues` key, scalar flag token, and dash-prefixed array element MUST be a base-flag identity; value-bearing spellings such as `--namespace=kube-system` are invalid in those positions. Every `flagValues` value MUST be a string glob. `flagValues` is invalid on any other matcher kind. A flag MUST NOT occur both as a presence predicate in the array and as a `flagValues` key, and duplicate presence predicates are invalid. Array elements containing `=` are invalid legacy value-bearing predicates and SHALL be dropped with scoped ask until explicitly migrated to `flagValues`. `pattern` with an array or a non-flag scalar token is invalid. The separator `--` is invalid as any matcher token or array element. Empty arrays, nested `args`, unknown entry or matcher fields, invalid actions, invalid base-flag identities, and `flags` values other than `0` or `1` are invalid.

An omitted action SHALL normalize to `ask`; valid actions are `allow`, `ask`, and `deny`. Every invalid entry or matcher SHALL be dropped with a warning and SHALL force its identifiable executable to scoped `ask` with glob allows suspended. An invalid entry without a valid `tool`, a non-array `permissions` section, or another unscopable top-level schema failure SHALL trigger global degraded ask. When neither config source has a `permissions` section, the parsed rule list SHALL be empty and behavior SHALL remain unchanged. When the selected config file fails to parse as JSONC, the plugin SHALL enter global degraded ask before matcher evaluation: every segment resolves to `ask` except parse-error segments that already deny, and no native glob allow may bypass the failure.

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
