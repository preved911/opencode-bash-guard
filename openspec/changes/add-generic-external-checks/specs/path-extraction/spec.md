## MODIFIED Requirements

### Requirement: Resolve paths

Each wholly static path token SHALL be quote-decoded and resolved to an absolute path. Relative paths SHALL be resolved against the current invocation's freshly fetched `Session.directory`. Bare `~` and `~/...` SHALL be expanded to the current user's home directory. Named-user forms such as `~other/...`, and operands whose value depends on shell expansion, SHALL remain unresolved and force an `ask` decision rather than being interpreted relative to the current user or project.

#### Scenario: Relative path
- **WHEN** the path is `./src` and cwd is `/project`
- **THEN** the resolved path is `/project/src`

#### Scenario: Tilde expansion
- **WHEN** the path is `~/.ssh/config`
- **THEN** the resolved path includes the user's home directory

#### Scenario: Named-user tilde requires confirmation
- **WHEN** the path is `~other/.ssh/config`
- **THEN** it remains unresolved and the segment action is at least `ask`

#### Scenario: Absolute path
- **WHEN** the path is `/etc/hosts`
- **THEN** the resolved path is `/etc/hosts`


Runtime cwd authority: The system SHALL freshly resolve `Session.directory` per invocation whenever selected checks or relative-path policy require runtime cwd, without caching. Lookup failure SHALL make paths at least `ask` and each selected check contribute `onError`.

#### Scenario: Path-only invocation uses fresh lookup
- **WHEN** relative-path policy needs cwd without any selected check
- **THEN** the system freshly resolves Session.directory

#### Scenario: Session lookup failure fails safely
- **WHEN** Session.directory lookup fails
- **THEN** relative paths are at least ask and selected checks contribute onError
