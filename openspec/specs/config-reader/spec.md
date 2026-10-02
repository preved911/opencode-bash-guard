# config-reader Specification

## Purpose

Read `permission.bash` and `external_directory` from the fully merged opencode config (via the `config` hook), support flat and object forms, detect unsupported permissive configs, and match segments and resolved paths against those patterns.

## Requirements

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

### Requirement: Read permission.edit from merged config

The system SHALL extract `permission.edit` from the merged Config object for redirect-target checking. Both flat string form (`"edit": "ask"`) and object form SHALL be supported; the flat form SHALL be treated as a single `"*"` pattern. Invalid action values SHALL fall back to `"ask"`.

#### Scenario: Object form
- **WHEN** the config has `"edit": { "docs/**": "allow", "*": "ask" }`
- **THEN** the patterns are parsed with their actions

#### Scenario: Flat string form
- **WHEN** the config has `"edit": "deny"`
- **THEN** it is treated as a single `{ "*": "deny" }` pattern

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

For each extracted file path from a segment, the system SHALL resolve it to an absolute path and check it against `external_directory` patterns. If a path falls outside allowed directories, the system SHALL apply `external_directory`'s action.

#### Scenario: Path inside allowed directory
- **WHEN** `external_directory` is `{ "./**": "allow", "*": "ask" }` and the path resolves within `./**`
- **THEN** no violation

#### Scenario: Path outside allowed directory
- **WHEN** `external_directory` is `{ "./**": "allow", "*": "ask" }` and the path is `/etc/passwd`
- **THEN** a violation is detected with action `"ask"`

### Requirement: Check redirect targets against edit rules and external_directory

For each segment redirect that is not well-known, the system SHALL resolve the target to an absolute path against the cwd and match it against the parsed `permission.edit` patterns (same glob matcher and last-match-wins as bash patterns); the matched action SHALL contribute to the segment's resolution. When the resolved target falls outside the cwd, the target SHALL additionally be checked against `external_directory` patterns and a violation's action SHALL contribute. Contributions combine with the segment's other checks most-restrictive-wins (`deny` > `ask` > `allow`); no matching rule at all SHALL leave the segment's action unchanged.

#### Scenario: Redirect target inside cwd checks only edit rules
- **WHEN** `permission.edit` is `{ "/project/**": "allow" }`, `external_directory` is `{ "*": "deny" }`, and the redirect target `output.txt` resolves inside `/project`
- **THEN** only the edit rule applies and the segment resolves to `allow`

#### Scenario: Redirect target outside cwd checked against both levels
- **WHEN** `permission.edit` is `{ "/etc/**": "deny" }`, `external_directory` is `{ "./**": "allow", "*": "ask" }`, cwd is `/project`, and the target is `/etc/passwd`
- **THEN** the edit rule contributes `deny` and the segment resolves to `deny`

#### Scenario: Redirect target outside cwd with no edit match
- **WHEN** no edit rule matches, the `external_directory` default is `"deny"`, and the target is `/tmp/foo` outside cwd
- **THEN** the external_directory violation contributes `deny`

#### Scenario: Edit ask rule triggers ask
- **WHEN** `permission.edit` is `{ "*": "ask" }` and the target is `out.txt` inside cwd
- **THEN** the segment resolves to `ask`

#### Scenario: Well-known redirect skips all checks
- **WHEN** the redirect is `2>&1` or `> /dev/null`
- **THEN** no edit or external_directory check runs for it

#### Scenario: Bash deny still wins alongside redirect checks
- **WHEN** bash pattern is `"*": "deny"`, `permission.edit` is `{ "*": "allow" }`, and the segment has a redirect target matching the allow
- **THEN** the segment still resolves to `deny`

### Requirement: Fall back to opencode built-in defaults for absent permission keys

opencode applies its built-in permission defaults only at permission-evaluation time — plugin `config` hooks receive the raw merged user config with absent keys missing. The plugin SHALL therefore hardcode opencode's built-in defaults as named constants, with a clarification comment referencing the upstream source (`packages/opencode/src/agent/agent.ts` defaults ruleset, repo `anomalyco/opencode`) and the docs page (`https://opencode.ai/docs/permissions/`), and SHALL resolve effective actions as follows when keys are absent from the merged config:

- `permission.bash` absent → `"allow"` → the plugin SHALL disable itself (native opencode would allow all bash; guarding is moot)
- `permission.edit` absent → `"allow"` → redirect targets SHALL get no edit-rule contribution
- `external_directory` absent → `{ "*": "ask" }` → targets outside the cwd SHALL be treated as external-directory asks. The whitelisted directories from opencode's default (tmp glob, skill/reference dirs) SHALL deliberately not be replicated (the plugin cannot resolve opencode's internal paths reliably); the plugin errs on the stricter side and this SHALL be documented.

User-specified values SHALL always override the defaults. The `"*": "allow"` self-disable check SHALL run against the *effective* bash action (user value or default).

#### Scenario: No permission config at all — plugin disabled per native default

- **WHEN** the merged config has no `permission` key
- **THEN** the effective bash action is the hardcoded default `"allow"` and the plugin disables itself with a warning

#### Scenario: bash configured, external_directory absent — native-aligned external asks

- **WHEN** the config sets `"permission": { "bash": { "cat *": "allow", "*": "ask" } }` with no `external_directory`, and a segment is `cat /etc/passwd`
- **THEN** the plugin resolves the segment to `ask` via the hardcoded external_directory default `"*": "ask"` — matching native opencode — instead of passing silently

#### Scenario: bash configured, edit absent — no edit contribution

- **WHEN** `permission.edit` is absent and a redirect target is checked
- **THEN** the target gets no edit-rule contribution (default `"allow"` matches native)

#### Scenario: Explicit user values override defaults

- **WHEN** the config explicitly sets `"external_directory": { "./**": "allow", "*": "ask" }`
- **THEN** the user rules are used as-is; the hardcoded default is not merged in

#### Scenario: Defaults constants carry upstream references

- **WHEN** the hardcoded defaults are read in `src/config.ts`
- **THEN** a comment names the opencode source file and docs URL they mirror, so future opencode default changes can be re-verified against it
