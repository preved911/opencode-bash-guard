# path-extraction Specification

## Purpose

Extract file path arguments from each segment's `unbash` AST, distinguish flags from paths using `@withfig/autocomplete` specs (with a `-*` heuristic fallback), and resolve every path to an absolute path for `external_directory` checking.

## Requirements

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

### Requirement: Extract redirect targets

The system SHALL collect each segment's redirects — both command-level and statement-level — recording the operator, target text, and file descriptor. Redirections remain excluded from word-argument extraction. Well-known redirects SHALL be flagged and excluded from path checking: the target `/dev/null`, numeric-only targets (file-descriptor duplicates such as `2>&1`), and heredoc operators (`<<`, `<<-`, `<<<`). All other targets SHALL be captured for permission checking.

#### Scenario: File redirect captured
- **WHEN** the segment is `ls -la > /tmp/out.txt`
- **THEN** the redirect target `/tmp/out.txt` is captured and is not flagged well-known

#### Scenario: Redirect inside a chain attaches to its own segment
- **WHEN** the command is `echo hello > file.txt && cat file.txt`
- **THEN** only the `echo hello > file.txt` segment carries the redirect; the `cat file.txt` segment carries none

#### Scenario: /dev/null is well-known
- **WHEN** the redirect is `> /dev/null`
- **THEN** it is flagged well-known and excluded from path checking

#### Scenario: File-descriptor duplicate is well-known
- **WHEN** the redirect is `2>&1`
- **THEN** the numeric-only target is flagged well-known

#### Scenario: Heredoc is well-known
- **WHEN** the redirect operator is `<<`, `<<-`, or `<<<`
- **THEN** it is flagged well-known
