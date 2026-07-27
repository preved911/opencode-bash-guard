## ADDED Requirements

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

### Requirement: Enforcement via dual-hook

`tool.execute.before` SHALL wrap chains with non-`no action` result in `{ ... ; }` and store the decision. `permission.ask` SHALL apply stored decisions.

#### Scenario: No action — let through
- **WHEN** chain action is `no action`
- **THEN** `tool.execute.before` SHALL NOT modify the command

#### Scenario: Ask — wrap and let permission.ask handle
- **WHEN** chain action is `ask`
- **THEN** `tool.execute.before` wraps command in `{ ... ; }` and stores `"ask"`
- **AND** `permission.ask` does nothing — user sees native opencode dialog

#### Scenario: Deny — wrap and block
- **WHEN** chain action is `deny`
- **THEN** `tool.execute.before` wraps command in `{ ... ; }` and stores `"deny"`
- **AND** `permission.ask` sets `output.status = "deny"` — blocked

#### Scenario: Wrapped chain breaks allow patterns
- **WHEN** original command is `git status && rm -rf /` and action is `ask`
- **THEN** the wrapped command `{ git status && rm -rf /; }` SHALL NOT match `"git *": "allow"`
- **AND** `"*": "ask"` SHALL catch it

### Requirement: Handle edge cases

#### Scenario: Empty command
- **WHEN** the command is empty
- **THEN** the handler SHALL return without modification

#### Scenario: Whitespace-only command
- **WHEN** the command is whitespace
- **THEN** the handler SHALL return without modification
