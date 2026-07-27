## ADDED Requirements

### Requirement: Extract word arguments from segment AST

The system SHALL walk the `unbash` AST of each segment to extract all word-type arguments (tokens that are not operators, redirections, or control structures). Each word token's text value SHALL be captured for path analysis.

#### Scenario: Simple arguments
- **WHEN** the segment AST represents `grep -r "pattern" ./src`
- **THEN** the extracted word tokens are `["-r", "pattern", "./src"]`

#### Scenario: No arguments
- **WHEN** the segment is `ls`
- **THEN** no word tokens are extracted (command name only)

### Requirement: Distinguish flags from file paths

The system SHALL use `@withfig/autocomplete` specs for the command name to determine which arguments are flags/options and which are file paths. Tokents that are flags (starting with `-`) SHALL be skipped. Tokens that are Fig-identified path arguments SHALL be kept. Fallback: skip `-*` tokens, keep the rest as potential paths.

#### Scenario: Fig identifies path argument
- **WHEN** the command is `rm` and Fig spec says the first positional argument is a file path
- **THEN** the token `./node_modules` SHALL be identified as a file path

#### Scenario: No Fig spec available
- **WHEN** the command has no Fig spec and the token does not start with `-`
- **THEN** the token SHALL be treated as a potential path

#### Scenario: Flag skipped
- **WHEN** the token is `-rf`
- **THEN** it SHALL be skipped (flag, not a path)

### Requirement: Resolve paths

Each extracted path token SHALL be resolved to an absolute path. Relative paths SHALL be resolved against the current working directory (`input.cwd` from `tool.execute.before`). Tilde (`~`) SHALL be expanded to the user's home directory.

#### Scenario: Relative path
- **WHEN** the path is `./src` and cwd is `/project`
- **THEN** the resolved path is `/project/src`

#### Scenario: Tilde expansion
- **WHEN** the path is `~/.ssh/config`
- **THEN** the resolved path includes the user's home directory

#### Scenario: Absolute path
- **WHEN** the path is `/etc/hosts`
- **THEN** the resolved path is `/etc/hosts`
