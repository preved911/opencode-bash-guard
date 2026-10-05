# enforcement Specification

## Purpose

Resolve each segment and the whole chain to a single action with most-restrictive-wins semantics (deny > ask > no action), and enforce decisions through `tool.execute.before` plus `permission.asked` event replies.

## Requirements

### Requirement: Resolve segment to action

For each segment, the system SHALL resolve to the most restrictive action across all checks: bash permission match and external_directory violation. Order: deny > ask > no action.

#### Scenario: Bash deny overrides everything
- **WHEN** segment is `sudo rm -rf /` matching `"sudo *": "deny"` even if paths are within scope
- **THEN** segment resolves to `deny`

#### Scenario: External_directory violation triggers its action
- **WHEN** segment is `cat /etc/passwd`, no bash permission match, but path is outside `external_directory: "ask"`
- **THEN** segment resolves to `ask`

#### Scenario: Multiple checks — most restrictive wins
- **WHEN** segment matches bash `"ask"` AND external_directory `"deny"`
- **THEN** segment resolves to `deny`

#### Scenario: No check triggers
- **WHEN** segment is `ls`, no bash patterns match, no paths extracted
- **THEN** segment has no action

### Requirement: Resolve whole chain to single action

The system SHALL aggregate all segment actions. If ALL segments resolve to `allow`, the chain action is `allow` (no interruption). If any segment resolves to `ask` or `deny`, that action becomes the chain action. Most restrictive: deny > ask > allow.

#### Scenario: All segments allowed — chain let through
- **WHEN** chain is `git status && git log` and both segments match `"git *": "allow"`
- **THEN** the chain action is `allow` — no interruption

#### Scenario: Any segment not allowed — chain takes its action
- **WHEN** chain is `git status && rm -rf /` where `rm` has no bash pattern match
- **THEN** `rm` resolves to no match → treated as not-allow → chain action is `ask`

#### Scenario: Deny in any segment denies whole chain
- **WHEN** chain is `git status && sudo rm -rf /` where sudo resolves to `deny`
- **THEN** the chain action is `deny`

#### Scenario: Single segment with no issues
- **WHEN** chain has 1 segment and it matches `"git *": "allow"`
- **THEN** the chain action is `allow`

#### Scenario: Parse error denies the command
- **WHEN** `unbash` returns a parse error for any part of the command
- **THEN** the chain action is `deny` (fail closed)

### Requirement: Enforcement via hook and permission event

`tool.execute.before` SHALL wrap chains with a non-`no action` result in `{ ... ; }`. It SHALL store only decisions that change the native permission outcome. `permission.asked` SHALL consume a stored decision by sessionID and nested `tool.callID`, then reply through the SDK with `once` for allow or `reject` for deny. Exception: when the optional restructure feature is enabled, ask-resolving commands that exceed a configured readability threshold are rejected with readability guidance instead of being wrapped for the dialog (see the readability requirement).

#### Scenario: No action — let through
- **WHEN** chain action is `no action`
- **THEN** `tool.execute.before` SHALL NOT modify the command

#### Scenario: Ask — wrap and leave the native prompt unchanged
- **WHEN** chain action is `ask`
- **THEN** `tool.execute.before` SHALL wrap command in `{ ... ; }` and SHALL NOT store an override
- **AND** `permission.asked` SHALL send no reply, leaving native `ask` unchanged

#### Scenario: Deny — wrap and block
- **WHEN** chain action is `deny`
- **THEN** `tool.execute.before` SHALL wrap command in `{ ... ; }` and SHALL store `"deny"`
- **AND** `permission.asked` SHALL reply `reject` through the SDK — blocked

#### Scenario: Wrapped chain breaks allow patterns
- **WHEN** original command is `git status && rm -rf /` and action is `ask`
- **THEN** the wrapped command `{ git status && rm -rf /; }` SHALL NOT match `"git *": "allow"`
- **AND** `"*": "ask"` SHALL catch it

### Requirement: Reject unreadable ask-resolving commands with readability guidance

When the optional restructure feature is enabled and the resolved chain action is `ask`, the system SHALL reject the command before execution instead of showing the permission dialog only when a configured readability threshold is exceeded. Segment counts are evaluated per line, while nesting depth is evaluated across the command; interpreter inline-script statement counts are also evaluated. Each configured threshold uses strict-greater comparison, so a count equal to the threshold passes. `tool.execute.before` SHALL throw an error containing rewrite guidance to re-issue separate steps or a multi-line script with one command per line. It SHALL NOT wrap or replace the command, and SHALL NOT store a permission override. The thrown error is not required to include the original command text. Commands at or below every configured threshold, allowed chains, no-opinion chains, and parse errors (which deny outright) SHALL NOT trigger the readability reject.

#### Scenario: Ask chain exceeding the segment threshold is rejected
- **WHEN** restructure is enabled with `max_segments: 1` and the command is `echo hi && echo there` under `"*": "ask"`
- **THEN** `tool.execute.before` throws a readability error containing rewrite guidance
- **AND** no permission override is stored

#### Scenario: Threshold equality does not reject
- **WHEN** restructure is enabled with `max_segments: 2` and the command is `echo hi && echo there` under `"*": "ask"`
- **THEN** `tool.execute.before` does not throw a readability error

#### Scenario: Mixed chain exceeding a configured threshold is rejected
- **WHEN** restructure is enabled with `max_segments: 1` and the command is `npm install good && wget evil.sh` where `npm` falls back to `"*": "ask"`
- **THEN** the chain resolves to `ask` and `tool.execute.before` throws a readability error without storing a permission override

#### Scenario: Ask command below configured thresholds keeps the dialog
- **WHEN** restructure is enabled and the command is `wget evil.sh` (single segment resolving to `ask`) without exceeding any configured threshold
- **THEN** no readability reject — the command is wrapped and the native dialog handles it

#### Scenario: Allowed multi-segment chain passes untouched
- **WHEN** chain is `git status && git log` with both segments allowed
- **THEN** no wrap and no readability reject

### Requirement: Handle edge cases

The handler SHALL return without modification for empty and whitespace-only commands.

#### Scenario: Empty command
- **WHEN** the command is empty
- **THEN** the handler SHALL return without modification

#### Scenario: Whitespace-only command
- **WHEN** the command is whitespace
- **THEN** the handler SHALL return without modification
