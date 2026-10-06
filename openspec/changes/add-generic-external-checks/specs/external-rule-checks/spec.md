## Purpose

Define deterministic, per-matcher external checks that map validated checker results into existing permission aggregation without granting checkers permission authority.

## ADDED Requirements

### Requirement: Define validated inline external checks

The system SHALL support an optional inline `check` object on an individual validated structured ArgMatcher. A matcher MUST NOT declare both a fixed `action` and `check`; a checked matcher uses `check` instead of a fixed action. A check MUST declare `command` as a non-empty argv array of strings whose first element is an absolute executable path, plus explicit `onPass` and `onFail` outcomes. It MAY declare `timeoutMs` as an integer from 1 through 30000 milliseconds and `onError`; an omitted `timeoutMs` MUST default to 5000 milliseconds. `onPass` and `onFail` MUST be one of `allow`, `ask`, or `deny`; `onError` MUST be `ask` or `deny` and an omitted `onError` MUST default to `ask`. Unknown check fields, a relative or empty command, invalid argv members, an out-of-range or non-integer timeout, absent or invalid `onPass` or `onFail`, or an invalid outcome SHALL make the owning matcher invalid under the existing scoped configuration-failure behavior. The system MUST NOT provide a named checker registry, bundled command-specific checks, global hooks, persisted checkout paths, input mutation, returned permission decisions, or sandbox guarantees.

#### Scenario: Inline check accepts an absolute argv command

- **WHEN** a structured ArgMatcher declares `check.command` as `["/absolute/path/checker", "--mode", "audit"]` with explicit valid `onPass` and `onFail` outcomes
- **THEN** the matcher retains that direct argv command and its check configuration is valid

#### Scenario: Timeout bounds and default normalize

- **WHEN** a valid inline check omits `timeoutMs`, declares `timeoutMs: 1`, or declares `timeoutMs: 30000`
- **THEN** the normalized timeout is respectively 5000, 1, or 30000 milliseconds

#### Scenario: Invalid check configuration fails with its rule

- **WHEN** a structured ArgMatcher declares a relative command, an empty command array, a non-string argv member, a timeout below 1 or above 30000 milliseconds, a non-integer timeout, a missing `onPass` or `onFail`, or an unknown outcome
- **THEN** the matcher is invalid and the existing scoped configuration-failure behavior applies to its executable

#### Scenario: Only onError defaults to ask

- **WHEN** a valid inline check omits `onError` but declares `onPass` and `onFail`
- **THEN** `onError` resolves to `ask`

#### Scenario: Checked matcher cannot declare a fixed action

- **WHEN** an ArgMatcher declares both `action` and `check`
- **THEN** the matcher is invalid under the existing scoped configuration-failure behavior

### Requirement: Restrict trust, scheduling, and runtime context

The system SHALL accept inline checks only from user-global plugin configuration. A project-sourced check SHALL invalidate only its matcher with scoped `ask`, while ordinary project rules remain supported. Every checker executable or interpreter path MUST be absolute and the runner MUST use an empty environment with no inherited `PATH`. After static selection, the system MUST freshly look up the SDK session once for an invocation that has one or more selected checks; lookup failure or missing `Session.directory` SHALL contribute every selected check's `onError` without spawning. The resolved directory SHALL drive checker cwd, request context, and relative-path resolution and MUST NOT be cached. Selected checks SHALL execute sequentially in segment order then effective entry and matcher order. At most 16 checks MAY be selected per guarded invocation, and a 30000 millisecond invocation-wide wall-clock budget starts before the first spawn. Each started checker MUST be limited to the lesser of its configured timeout and the remaining invocation-wide budget; excess or unstarted checks SHALL contribute `onError` without spawning. The 250 millisecond force-kill grace MUST start at the first per-check timeout, invocation-wide deadline, or output breach. Stdout, stderr, facts, and request context MUST be discarded after classification and MUST NOT be logged, prompted, or persisted by default.

#### Scenario: Project check fails safely without disabling project rules
- **WHEN** a project-sourced matcher declares `check` and another ordinary project matcher is valid
- **THEN** only the checked matcher contributes scoped `ask`; the ordinary matcher remains supported

#### Scenario: Session lookup failure skips selected checks
- **WHEN** static selection succeeds but SDK session lookup fails or has no `Session.directory`
- **THEN** every selected check contributes `onError` without spawning

#### Scenario: Invocation check budget is exhausted
- **WHEN** more than 16 checks are selected or the 30000 millisecond invocation budget is exhausted
- **THEN** each excess or unstarted check contributes its own `onError` without spawning

### Requirement: Run checks only after static rule matching

The system SHALL complete existing static matcher evaluation before spawning an inline check. It MUST run a configured check only for a matcher that statically matched the current segment, and matchers without checks SHALL retain their existing matching and fallback behavior. A checked matcher MUST contribute only the outcome selected by its check and MUST NOT also contribute a fixed action. A check execution MUST use direct argv process creation with no shell, interpolation, command string parsing, or recursive Bash guard evaluation. The check process SHALL receive a minimal environment and bounded execution time, with stdout limited to 64 KiB and stderr limited to 8 KiB. On the configured timeout or an output-limit breach, the runner MUST stop waiting, close stdin, send termination, and after a 250 millisecond grace period send forced termination if the checker remains alive. A timeout, output-limit breach, spawn failure, nonzero exit, malformed output, unsupported protocol version, or any other checker execution failure SHALL select `onError`.

#### Scenario: Unmatched rule does not spawn a check

- **WHEN** a rule has an inline check but its static matcher does not match the segment
- **THEN** the system does not spawn the checker and the segment continues through the existing permission pipeline

#### Scenario: Direct argv execution does not interpret shell syntax

- **WHEN** a valid check argv member contains text that a shell could interpret
- **THEN** the system passes that text as one argv member without invoking a shell or interpolating it

#### Scenario: Checker failures use onError

- **WHEN** a matched check times out, exceeds an output bound, cannot spawn, exits nonzero, emits malformed output, or reports an unsupported protocol version
- **THEN** the system does not infer pass or fail and contributes the rule's `onError` outcome

#### Scenario: Timeout terminates the checker after the grace period

- **WHEN** a matched checker remains alive after its configured timeout expires
- **THEN** the runner stops waiting, initiates termination, waits no more than 250 milliseconds for exit, force-terminates a remaining process, and contributes `onError`

#### Scenario: Checker execution does not recurse through the guard

- **WHEN** the system starts an external checker for a matched segment
- **THEN** starting the checker does not trigger a nested Bash permission evaluation

### Requirement: Exchange a versioned invocation request and result

The system SHALL write one versioned JSON request to a matched checker's standard input and read one versioned JSON response from its standard output. The request MUST be a JSON object with exactly `protocolVersion: 1`, `context`, `command`, and `match`; `match` MUST contain `ruleId`. `context` MUST contain the current invocation's `cwd`, `sessionID`, and `callID`; `command` MUST contain normalized `raw`, `executable`, and `argv`, where `command.argv` contains only arguments after `command.executable`. The request rule ID MUST serialize as `tool:<effective-entry-index>/matcher:<matcher-index>`, with both zero-based indexes assigned after config precedence resolution and in effective config-array order. The response MUST be a JSON object with exactly `protocolVersion: 1`, `result`, and optional `facts`; `result` MUST be exactly `pass` or `fail`, and `facts` MUST be a JSON object whose serialized form is at most 16 KiB and whose nesting depth is at most 8. Unknown response fields, a permission action, unsupported protocol version, malformed JSON, an invalid facts value, or an oversized facts object SHALL be checker execution errors. Facts SHALL be validated then discarded and MUST NOT be logged, prompted, persisted, or used as policy input. All output and facts limits SHALL be UTF-8 byte counts, and facts root SHALL count as depth 1. The system MUST derive the matcher's only contributed action from the configured `onPass`, `onFail`, or `onError` outcome.

#### Scenario: Pass response maps through configured outcome

- **WHEN** a matched checker receives `{ "protocolVersion": 1, "context": { "cwd": "<cwd>", "sessionID": "<session-id>", "callID": "<call-id>" }, "command": { "raw": "<raw>", "executable": "<executable>", "argv": ["<first-argument>"] }, "match": { "ruleId": "tool:0/matcher:2" } }` and returns `{ "protocolVersion": 1, "result": "pass", "facts": {} }`
- **THEN** `command.argv` excludes `command.executable`, the system validates then discards facts without diagnostic retention, and contributes that matcher's `onPass` outcome, not a permission action returned by the checker

#### Scenario: Fail response maps through configured outcome

- **WHEN** a matched checker returns a supported versioned `fail` response
- **THEN** the system contributes that rule's `onFail` outcome

#### Scenario: Returned permission action is rejected

- **WHEN** a checker response includes an action or lacks the required supported pass or fail result
- **THEN** the response is invalid and the system contributes `onError`

#### Scenario: Unknown response field is rejected

- **WHEN** a checker response includes a field other than `protocolVersion`, `result`, or optional `facts`
- **THEN** the response is invalid and the system contributes `onError`

#### Scenario: Rule identifier is deterministic after precedence resolution

- **WHEN** config precedence produces an effective permission-entry array and its first entry's third matcher is checked
- **THEN** the checker request has `match.ruleId` equal to `tool:0/matcher:2`, independent of entries discarded by precedence resolution

### Requirement: Scope runtime context to each invocation

The system SHALL pass the current permission invocation cwd both as the checker process cwd and as `context.cwd` in that invocation's JSON request. It MUST derive `sessionID` and `callID` from the same current invocation. The system MUST NOT cache, persist, or reuse a cwd, checkout path, request context, checker response, or checker result across invocations.

#### Scenario: Separate worktrees use their own cwd

- **WHEN** two matching invocations run from different worktrees during the same process lifetime
- **THEN** each checker process and its request context receive the cwd of that invocation, with no cwd from the other worktree reused

#### Scenario: Per-invocation context is not cached

- **WHEN** the same rule matches two invocations with distinct call IDs
- **THEN** the system sends separate requests with their respective call IDs and does not reuse the first invocation's response

### Requirement: Aggregate check outcomes restrictively

The system SHALL evaluate configured checks per matched segment and combine each checked matcher's sole contributed outcome with outcomes from independently matching rules through existing segment and whole-chain most-restrictive aggregation, where `deny` is more restrictive than `ask`, which is more restrictive than `allow`. A pass outcome MUST NOT override an independent static or check-derived `deny` or `ask`. Matchers without checks SHALL contribute only their existing static outcome. The external check contract MUST NOT alter the existing parser validation, matcher semantics, native permission behavior, or chain aggregation for unmatched rules and matchers without checks.

#### Scenario: Check pass cannot override an independent deny

- **WHEN** a matched checked rule contributes `allow` on pass and an independent rule for the same segment contributes `deny`
- **THEN** the segment resolves to `deny`

#### Scenario: Per-segment checks feed chain aggregation

- **WHEN** one segment in a command chain has a matched check that contributes `ask` and another segment resolves to `allow`
- **THEN** the existing whole-chain aggregation resolves the chain to `ask`

#### Scenario: Rule without a check is unchanged

- **WHEN** a matching permission rule omits `check`
- **THEN** it follows the existing static matcher, permission pipeline, and chain aggregation behavior without spawning a process


#### Scenario: Facts are discarded
- **WHEN** a valid response contains facts
- **THEN** facts are validated then discarded without logging, prompting, persistence, or policy use

#### Scenario: Early output breach starts grace
- **WHEN** stdout or stderr reaches its byte limit before timeout
- **THEN** the 250 millisecond force-kill grace starts at that breach
