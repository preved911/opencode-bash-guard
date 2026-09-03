## ADDED Requirements

### Requirement: Parse bash_restructure config

The system SHALL parse an optional `permission.bash_restructure` object from the merged opencode config. Presence of the object (not `false`) SHALL enable complexity rejection. Missing fields SHALL fall back to defaults (`max_segments: 3`, `max_depth: 2`). Non-positive or non-numeric field values SHALL be dropped with a warning. When the section is absent or `false`, plugin behavior SHALL be identical to before this change.

#### Scenario: Section absent — no change

- **WHEN** `permission.bash_restructure` is not present in the config
- **THEN** complexity rejection is disabled and no behavior changes vs. the previous release

#### Scenario: Section present — defaults applied

- **WHEN** `permission.bash_restructure` is `{}` (empty object)
- **THEN** rejection is enabled with `max_segments: 3` and `max_depth: 2`

#### Scenario: Explicit thresholds honored

- **WHEN** `permission.bash_restructure` is `{ "max_segments": 5, "max_depth": 1 }`
- **THEN** the thresholds are `5` segments and depth `1`

#### Scenario: Invalid values dropped

- **WHEN** `permission.bash_restructure` is `{ "max_segments": 0, "max_depth": "many" }`
- **THEN** both invalid values are dropped with warnings and defaults apply

### Requirement: Detect command complexity

The system SHALL compute, per command, the segment count (existing `parseChain` output, including meta-command bodies) and the maximum substitution nesting depth reached while walking `$()`, backticks, and meta-command string arguments. Complexity limits are exceeded when either metric is strictly greater than its threshold.

#### Scenario: Segment count over threshold

- **WHEN** command is `a && b && c && d` (4 segments), `max_segments: 3`
- **THEN** limits are exceeded

#### Scenario: Segment count at threshold — not exceeded

- **WHEN** command is `a && b && c` (3 segments), `max_segments: 3`
- **THEN** limits are not exceeded

#### Scenario: Nesting depth over threshold

- **WHEN** command is `echo $(echo $(whoami))` (depth 3), `max_depth: 2`, single segment
- **THEN** limits are exceeded

#### Scenario: Meta-command body counts

- **WHEN** command is `bash -c "a && b && c && d"` (4 segments after recursive parse), `max_segments: 3`
- **THEN** limits are exceeded

#### Scenario: Simple command passes

- **WHEN** command is `git status`, `max_segments: 3`, `max_depth: 2`
- **THEN** limits are not exceeded

### Requirement: Reject with actionable guidance via thrown error

When complexity limits are exceeded AND the chain action resolves to `null` or `allow`, the plugin SHALL reject the command by throwing in `tool.execute.before` — nothing SHALL execute and no permission dialog SHALL appear. The error message SHALL include the actual segment count and nesting depth and SHALL instruct the model to re-issue the command as separate bash tool calls or as a multi-line script with one command per line. Commands resolving to `deny` or `ask`, and parse-error fail-closed denies, SHALL follow existing flows unchanged.

#### Scenario: Fully-allowed complex chain rejected

- **WHEN** command `git status && git log && git diff && git show` exceeds `max_segments: 3`, all segments match `"git *": "allow"`
- **THEN** the plugin throws; the command does not execute; the error text contains "4" and the re-issue instruction

#### Scenario: Uncovered complex chain rejected

- **WHEN** command `a && b && c && d` exceeds limits and no bash rule matches any segment (chain action `null`)
- **THEN** the plugin throws with the guidance message

#### Scenario: Deny flow unchanged

- **WHEN** command `git push --force && git status && git log && git show` exceeds limits but `git push` resolves to `deny`
- **THEN** the existing deny flow applies (wrap + stored deny) — no restructuring message

#### Scenario: Ask flow unchanged

- **WHEN** command `git status && rm -rf /tmp/x && echo ok && ls` exceeds limits and `rm` resolves to `ask`
- **THEN** the existing ask flow applies (wrap, native dialog) — no restructuring message

#### Scenario: Parse error unchanged

- **WHEN** command is `echo "unbalanced` (parse error) regardless of complexity
- **THEN** the fail-closed deny applies — no restructuring message

#### Scenario: Repeated violation — same rejection

- **WHEN** the model re-issues a complex command after a rejection
- **THEN** the same rejection fires again with updated counts (no counter, no escalation)

### Requirement: Restructured commands remain fully verified

Commands re-issued in a compliant form SHALL go through the normal permission evaluation with no bypass: separate tool calls arrive as single-segment commands; a multi-line script is parsed into per-line segments (newlines are segment separators).

#### Scenario: Multi-line re-issue checked per line

- **WHEN** the rejected `a && b && c && d` (all allowed) is re-issued as a 4-line script
- **THEN** `parseChain` yields 4 segments, each evaluated independently against permission rules

#### Scenario: Separate calls checked individually

- **WHEN** the model re-issues as four single-command tool calls
- **THEN** each call is a single segment, evaluated independently; allowed ones run

### Requirement: Documentation reflects actual chain behavior

The README SHALL describe the implemented semantics: fully-allowed chains pass through without interruption; the "multi-segment chains trigger ask (defense-in-depth)" claim SHALL be removed or corrected. The README SHALL document `permission.bash_restructure` and include a recommended AGENTS.md snippet as a complementary soft layer.

#### Scenario: README example table corrected

- **WHEN** the README documents `git status && git log` with both segments allowed
- **THEN** it states the chain passes through (not "ask")

#### Scenario: AGENTS.md snippet present

- **WHEN** the README "Readable commands" section is read
- **THEN** it contains the `bash_restructure` config example and an AGENTS.md instruction snippet
