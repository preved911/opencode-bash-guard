# Spec Delta

## Purpose

Records every bash-guard enforcement decision as a local, queryable event and exposes a `stats` CLI so users can audit what the plugin allowed, asked, denied, or rejected — and measure whether restructured rejections lead to compliant re-issues.

## ADDED Requirements

### Requirement: Decision events are recorded for every enforcement outcome
The plugin SHALL append exactly one JSON event per bash enforcement decision (decision `allow`, `ask`, `deny`, or `restructured`) to a local JSONL log, including the trigger (`chain`, `segments`, `depth`, `inline-script`, `parse-error`, `redirect`) and the segment/depth counts that drove the decision. Event writing MUST NOT alter the enforcement outcome under any circumstance.

#### Scenario: Restructured rejection is logged with counts
- **WHEN** an ask-resolving chain exceeds the segment limit and is rejected with restructure guidance
- **THEN** an event with `decision: "restructured"`, `trigger: "segments"`, and the actual segment/depth counts is appended

#### Scenario: Parse error is logged as fail-closed deny
- **WHEN** a command fails AST parsing and is denied
- **THEN** an event with `decision: "deny"` and `trigger: "parse-error"` is appended

#### Scenario: Logging failure never changes enforcement
- **WHEN** the stats log is unwritable (disk full, permissions) and a command is evaluated
- **THEN** the command's enforcement outcome is identical to the outcome with working logging, and at most one warning is emitted per session

### Requirement: Stats storage is local-only with rotation
Events SHALL be stored in a single JSONL file under the user's XDG data directory (`~/.local/share/opencode-bash-guard/stats.jsonl` by default). The plugin SHALL make no network request for statistics. When the file exceeds 10 MB it SHALL be rotated to one backup generation.

#### Scenario: Default location
- **WHEN** statistics are enabled and the first command is evaluated
- **THEN** the log file exists at the XDG data path and contains valid JSON lines

#### Scenario: Rotation preserves history
- **WHEN** the log file exceeds the size limit
- **THEN** it is renamed to a single backup generation and new events continue in a fresh file

### Requirement: Command previews are opt-in
The event log SHALL omit command text by default. Only when `stats.log_previews` is explicitly enabled SHALL events include a command preview, and that preview MUST be flattened to a single line and truncated to at most 120 characters.

#### Scenario: Preview absent by default
- **WHEN** statistics are recorded with default configuration
- **THEN** no event contains the command text

#### Scenario: Opt-in preview is bounded
- **WHEN** `log_previews` is enabled and a multi-line 500-character command is rejected
- **THEN** the event preview is a single line of at most 120 characters

### Requirement: Stats CLI aggregates the event log
The package SHALL provide an executable (`npx opencode-bash-guard stats`) rendering a terminal table with: totals by decision, total processed events, a per-day rejection timeline, top triggers, top rejected command shapes, per-project breakdown, and the restructure acceptance rate. It SHALL support `--json` (machine-readable), `--since` (time filter), and `--project` (filter). The CLI SHALL NOT require the plugin to be running.

#### Scenario: Table shows totals and acceptance rate
- **WHEN** the log contains allow, ask, deny, and restructured events with a compliant re-issue following a rejection
- **THEN** the table reports per-decision totals and a restructure acceptance rate greater than zero

#### Scenario: JSON output shape
- **WHEN** `stats --json` is run
- **THEN** output is valid JSON exposing the same aggregates and the raw filtered event count

#### Scenario: Empty log
- **WHEN** the log file does not exist or has no events
- **THEN** the CLI prints an empty-report message (and zero rate), not an error

### Requirement: Restructure acceptance rate is computed by a documented heuristic
The acceptance rate SHALL be the fraction of `restructured` events followed, within a 10-event / 5-minute window, by a compliant event (decision `allow` or `ask` whose per-line segment count is within the configured limit). The heuristic and its approximation limits SHALL be documented in the CLI help/README.

#### Scenario: Compliant retry raises the rate
- **WHEN** a rejection is followed within the window by a one-command-per-line re-issue
- **THEN** that rejection counts as accepted

#### Scenario: No rejections yields undefined rate
- **WHEN** the log has zero `restructured` events
- **THEN** the rate is reported as not applicable rather than 0%

### Requirement: Statistics can be disabled
When `stats.enabled` is false, the plugin SHALL NOT create, write, or rotate the stats log, and the CLI SHALL report an empty log. Enforcement behavior SHALL be unaffected by this setting.

#### Scenario: Disabled stats write nothing
- **WHEN** `stats.enabled` is false and commands are evaluated
- **THEN** no stats file is created or modified
