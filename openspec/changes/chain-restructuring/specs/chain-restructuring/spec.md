## ADDED Requirements

### Requirement: Load plugin config from opencode-bash-guard.jsonc

The system SHALL load its own configuration from `opencode-bash-guard.jsonc` files located in the opencode config dirs — global (`~/.config/opencode/` or `$XDG_CONFIG_HOME/opencode/`) and project (`<project>/.opencode/`) — parsed as JSONC (comments and trailing commas allowed). Objects SHALL deep-merge with project precedence over global. A missing file SHALL not be an error. Invalid JSONC SHALL produce a warning and disable the `restructure` feature while leaving the plugin's core chain-guard behavior unchanged. Config SHALL be read once at plugin init; changes require a restart.

#### Scenario: No config file anywhere — feature off

- **WHEN** neither the global nor the project `opencode-bash-guard.jsonc` exists
- **THEN** `restructure` is disabled and plugin behavior is identical to before this change

#### Scenario: Project overrides global

- **WHEN** global config has `"restructure": { "enabled": true, "max_segments": 3 }` and project config has `"restructure": { "max_segments": 5 }`
- **THEN** the effective config is `restructure` enabled with `max_segments: 5` and `max_depth` from the global/defaults

#### Scenario: JSONC syntax accepted

- **WHEN** a config file contains `//` comments, a trailing comma, and valid JSON structure
- **THEN** it parses successfully

#### Scenario: Invalid JSONC fails safe

- **WHEN** a config file contains malformed JSONC
- **THEN** a warning is emitted naming the file, `restructure` is treated as disabled, and the core chain-guard plugin behavior is unchanged

### Requirement: Restructure schema and defaults

The `restructure` section SHALL have nested fields: `enabled` (boolean, default `false`), `max_segments` (positive integer, default `3`), `max_depth` (positive integer, default `2`). When `enabled` is `false` or the section is absent, plugin behavior SHALL be identical to before this change. Invalid `max_segments`/`max_depth` values (non-numeric or < 1) SHALL be dropped with a warning and the default SHALL apply.

#### Scenario: Disabled by default

- **WHEN** the config file exists but has no `restructure` section, or `restructure.enabled` is `false`
- **THEN** no complexity rejection occurs for any command

#### Scenario: Enabled with defaults

- **WHEN** the config contains `"restructure": { "enabled": true }`
- **THEN** thresholds are `max_segments: 3` and `max_depth: 2`

#### Scenario: Explicit thresholds honored

- **WHEN** the config contains `"restructure": { "enabled": true, "max_segments": 5, "max_depth": 1 }`
- **THEN** the thresholds are `5` segments and depth `1`

#### Scenario: Invalid threshold values dropped

- **WHEN** the config contains `"restructure": { "enabled": true, "max_segments": 0, "max_depth": "many" }`
- **THEN** both invalid values are dropped with warnings and defaults (`3`, `2`) apply

### Requirement: Detect command complexity

The system SHALL compute, per command, the segment count (existing `parseChain` output, including meta-command bodies) and the maximum substitution nesting depth reached while walking `$()`, backticks, and meta-command string arguments. Limits are exceeded when a metric is strictly greater than its threshold. The segment-count limit SHALL apply to single-line commands only; a command containing a newline SHALL be exempt from the segment-count limit but still subject to the depth limit.

#### Scenario: Single-line chain over segment threshold

- **WHEN** command is `a && b && c && d` (4 segments, no newline), `max_segments: 3`
- **THEN** limits are exceeded

#### Scenario: Single-line chain at threshold — not exceeded

- **WHEN** command is `a && b && c` (3 segments, no newline), `max_segments: 3`
- **THEN** limits are not exceeded

#### Scenario: Multi-line script exempt from segment limit

- **WHEN** command is a 5-line script with one command per line, `max_segments: 3`
- **THEN** the segment limit is not exceeded (multi-line is the compliant form)

#### Scenario: Nesting depth over threshold in any form

- **WHEN** command is `echo $(echo $(whoami))` (depth 3) or a multi-line script containing a depth-3 substitution, `max_depth: 2`
- **THEN** limits are exceeded in both cases

#### Scenario: Meta-command body counts

- **WHEN** command is `bash -c "a && b && c && d"` (4 segments after recursive parse), `max_segments: 3`
- **THEN** limits are exceeded

#### Scenario: Simple command passes

- **WHEN** command is `git status`, `max_segments: 3`, `max_depth: 2`
- **THEN** limits are not exceeded

### Requirement: Reject ask-resolving complex one-liners with actionable guidance

When `restructure` is enabled AND limits are exceeded AND the chain resolves to `ask`, the plugin SHALL reject the command by throwing in `tool.execute.before` — nothing SHALL execute and no permission dialog SHALL appear for that call. The error message SHALL include the actual segment count and nesting depth and SHALL instruct the model to re-issue the command as separate bash tool calls or as a multi-line script with one command per line. Chains resolving to `allow`, `deny`, or `null`, and parse-error fail-closed denies, SHALL follow existing flows unchanged.

#### Scenario: Allowed complex chain passes through — allowed stays allowed

- **WHEN** command `git status && git log && git diff && git show` exceeds `max_segments: 3` and all segments match `"git *": "allow"`
- **THEN** the chain resolves to `allow` and runs without rejection — no restructuring message

#### Scenario: Complex ask chain rejected

- **WHEN** command `git status && rm -rf /tmp/x && echo ok && ls` exceeds `max_segments: 3` and `rm` resolves to `ask`
- **THEN** the plugin throws; the command does not execute; no permission dialog appears for this call; the error text contains "4" and the re-issue instruction

#### Scenario: Deny flow unchanged

- **WHEN** command `git push --force && git status && git log && git show` exceeds limits but `git push` resolves to `deny`
- **THEN** the existing deny flow applies (wrap + stored deny) — no restructuring message

#### Scenario: No-opinion chain unchanged

- **WHEN** command `a && b && c && d` exceeds limits and no bash rule matches any segment (chain action `null`)
- **THEN** the plugin does not throw — the command proceeds to native opencode handling

#### Scenario: Parse error unchanged

- **WHEN** command is `echo "unbalanced` (parse error) regardless of complexity
- **THEN** the fail-closed deny applies — no restructuring message

#### Scenario: Repeated violation — same rejection

- **WHEN** the model re-issues a complex single-line chain after a rejection
- **THEN** the same rejection fires again with updated counts (no counter, no escalation)

#### Scenario: Feature disabled — ask flow unchanged

- **WHEN** `restructure.enabled` is `false` and a complex ask-resolving chain arrives
- **THEN** the existing ask flow applies (wrap, native dialog) — no rejection

### Requirement: Restructured commands remain fully verified

Commands re-issued in a compliant form SHALL go through the normal permission evaluation with no bypass: separate tool calls arrive as single-segment commands; a multi-line script is parsed into per-line segments (newlines are segment separators).

#### Scenario: Multi-line re-issue checked per line

- **WHEN** the rejected `a && b && c && d` is re-issued as a 4-line script
- **THEN** `parseChain` yields 4 segments, each evaluated independently against permission rules; allowed lines pass, uncovered lines ask

#### Scenario: Separate calls checked individually

- **WHEN** the model re-issues as four single-command tool calls
- **THEN** each call is a single segment, evaluated independently; allowed ones run

### Requirement: Documentation reflects actual chain behavior and JSONC config

The README SHALL describe the implemented semantics: fully-allowed chains pass through without interruption; the "multi-segment chains trigger ask (defense-in-depth)" claim SHALL be removed or corrected. The README SHALL document the `opencode-bash-guard.jsonc` file (locations, `restructure` schema, defaults) and include a recommended AGENTS.md snippet as a complementary soft layer.

#### Scenario: README example table corrected

- **WHEN** the README documents `git status && git log` with both segments allowed
- **THEN** it states the chain passes through (not "ask")

#### Scenario: Config file documented

- **WHEN** the README "Readable commands" section is read
- **THEN** it shows the `opencode-bash-guard.jsonc` example with `restructure` nested fields, both config locations, and an AGENTS.md instruction snippet
