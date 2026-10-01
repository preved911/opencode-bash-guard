## ADDED Requirements

### Requirement: Read permission.bash from merged opencode config

The system SHALL register a `config` hook that receives the fully merged Config object (all layers: remote, global, project, managed). It SHALL extract `permission.bash` patterns from the merged config. Both flat form (`"bash": "ask"`) and object form (`"bash": { "git *": "allow", "*": "ask" }`) SHALL be supported.

#### Scenario: Object form with patterns
- **WHEN** the config has `"bash": { "*": "ask", "git *": "allow" }`
- **THEN** the plugin SHALL parse patterns as `{ "*": "ask", "git *": "allow" }`

#### Scenario: Flat string form
- **WHEN** the config has `"bash": "ask"`
- **THEN** the plugin SHALL treat this as `{ "*": "ask" }`

#### Scenario: No bash config at top level
- **WHEN** only `"*": "ask"` is set at top level with no `"bash"` key
- **THEN** the plugin SHALL use `{ "*": "ask" }` for bash

### Requirement: Read external_directory from merged config

The system SHALL extract `external_directory` from the merged Config object. Both object form with path patterns and flat string form SHALL be supported.

#### Scenario: external_directory with object patterns
- **WHEN** the config has `"external_directory": { "~/projects/**": "allow", "*": "ask" }`
- **THEN** the plugin SHALL parse the path patterns and their actions

#### Scenario: Flat string
- **WHEN** the config has `"external_directory": "ask"`
- **THEN** the plugin SHALL treat all external paths with action `"ask"`

### Requirement: Detect unsupported config

The plugin SHALL check that `"*": "ask"` is in effect for bash. If `"bash": "allow"` or `"*": "allow"`, the plugin SHALL log a warning and disable itself.

#### Scenario: bash:allow detected
- **WHEN** the config has `"bash": "allow"`
- **THEN** the plugin SHALL log a warning and disable all hooks

### Requirement: Match segment against bash permission patterns

For each segment's command name, the system SHALL check against the parsed `permission.bash` patterns using glob matching (last matching rule wins).

#### Scenario: Segment matches allow pattern
- **WHEN** segment is `git status` and pattern is `"git *": "allow"`
- **THEN** the segment resolves to action `"allow"`

#### Scenario: Segment matches deny pattern
- **WHEN** segment is `sudo rm -rf /` and pattern is `"sudo *": "deny"`
- **THEN** the segment resolves to action `"deny"`

#### Scenario: No pattern matches
- **WHEN** segment is `some-unknown-command` and no pattern matches
- **THEN** the segment has no resolved action

### Requirement: Match resolved paths against external_directory patterns

For each extracted file path from a segment, resolve to absolute path and check against `external_directory` patterns. If a path falls outside allowed directories, apply `external_directory`'s action.

#### Scenario: Path inside allowed directory
- **WHEN** `external_directory` is `{ "./**": "allow", "*": "ask" }` and the path resolves within `./**`
- **THEN** no violation

#### Scenario: Path outside allowed directory
- **WHEN** `external_directory` is `{ "./**": "allow", "*": "ask" }` and the path is `/etc/passwd`
- **THEN** a violation is detected with action `"ask"`
