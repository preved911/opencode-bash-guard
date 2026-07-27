## ADDED Requirements

### Requirement: Parse bash command into AST segments

The system SHALL use `unbash` to parse the full command string into an AST. The top-level command nodes separated by `&&`, `||`, `;`, `|`, and newlines SHALL be extracted as individual segments. Quoted strings, escaped characters, and command substitutions SHALL be handled correctly by the parser.

#### Scenario: Simple chain
- **WHEN** the command is `cd src && npm run build`
- **THEN** the AST SHALL contain two top-level commands: `cd src` and `npm run build`

#### Scenario: Pipe chain
- **WHEN** the command is `cat log.txt | grep error | sort`
- **THEN** the AST SHALL contain three commands: `cat log.txt`, `grep error`, `sort`

#### Scenario: Chaining operators inside quotes
- **WHEN** the command is `echo "hello && world"`
- **THEN** the AST SHALL contain a single command (quotes respected)

#### Scenario: Extract command name from each segment AST
- **WHEN** the segment AST represents `rm -rf /tmp`
- **THEN** the command name extracted is `rm`

#### Scenario: Command substitution is preserved
- **WHEN** the command is `cat $(find . -name "*.txt") | head`
- **THEN** the AST SHALL preserve `$(...)` as part of the first command's arguments

### Requirement: Extract commands from command substitutions and backticks

The system SHALL recursively walk the AST to find ALL commands, including those nested inside `$(...)` command substitutions and backtick `` `...` `` expressions. Each nested command SHALL be checked against bash permission patterns independently.

#### Scenario: Command in $() is extracted
- **WHEN** the command is `cat $(find . -name "*.txt")`
- **THEN** the extracted commands SHALL include both `cat` and `find`

#### Scenario: Nested $() in pipeline
- **WHEN** the command is `cat $(find . -name "*.txt") | head`
- **THEN** the extracted commands SHALL include `cat`, `find`, and `head`

#### Scenario: Backtick substitution
- **WHEN** the command is `echo \`date\``
- **THEN** the extracted commands SHALL include both `echo` and `date`

#### Scenario: Multiple nested substitutions
- **WHEN** the command is `diff $(ls dir1) $(ls dir2)`
- **THEN** the extracted commands SHALL include `diff`, `ls` (twice — each substitution is checked)

#### Scenario: Deeply nested substitution
- **WHEN** the command is `echo $(cat $(find . -name "*.txt"))`
- **THEN** the extracted commands SHALL include `echo`, `cat`, and `find`

### Requirement: Recursively parse eval and shell -c arguments

The system SHALL recognize meta-commands that execute string arguments as shell commands:
- `eval <string>` — the first non-flag argument is a command string
- `sh -c <string>`, `bash -c <string>`, `zsh -c <string>`, `ksh -c <string>` — the value after `-c` is a command string

The string argument SHALL be parsed as a separate command using `unbash`, and all extracted commands from it SHALL be added to the segment's command list for permission checking.

#### Scenario: eval with dangerous command
- **WHEN** the command is `eval "rm -rf /"`
- **THEN** the system SHALL parse the string argument `"rm -rf /"` as a command
- **AND** the extracted commands SHALL include `eval` and `rm`

#### Scenario: eval in chain
- **WHEN** the command is `git status && eval "sudo rm -rf /"`
- **THEN** the extracted commands SHALL include `git`, `eval`, `sudo`, and `rm`
- **AND** `sudo` matching a `deny` pattern SHALL deny the whole chain

#### Scenario: sh -c with dangerous command
- **WHEN** the command is `sh -c "rm -rf /"`
- **THEN** the system SHALL parse the `-c` value `"rm -rf /"` as a command
- **AND** the extracted commands SHALL include `sh` and `rm`

#### Scenario: bash -c with nested chain
- **WHEN** the command is `bash -c "cd /tmp && rm -rf ."`
- **THEN** the system SHALL parse `-c` value as a command string
- **AND** the extracted commands SHALL include `bash`, `cd`, and `rm`

### Requirement: Parse errors trigger deny (fail closed)

The parser SHALL NOT throw on malformed input. However, any parse error SHALL cause the entire command to resolve to `deny` — fail closed. Partial parses are not trusted because the unparsed portion may contain a dangerous command that bash would still execute.

#### Scenario: Parse error in chain
- **WHEN** the command is `valid_command && some_malformed_stuff_that_hides_rm_-rf_/`
- **THEN** `unbash` returns partial AST with a parse error
- **AND** the plugin SHALL resolve the entire command to `deny`
- **AND** the command SHALL be blocked

#### Scenario: Unbalanced quotes
- **WHEN** the command has unbalanced quotes
- **THEN** `unbash` returns partial AST with a parse error
- **AND** the plugin SHALL resolve to `deny`

#### Scenario: Completely unparseable input
- **WHEN** the command is garbage that `unbash` cannot parse at all
- **THEN** the plugin SHALL resolve to `deny`
