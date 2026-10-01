## ADDED Requirements

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
