# Spec Delta

## Purpose

Allows complexity classification of ask-resolving chains to be delegated to an optional TypeSafe Jev (System One) classifier backend, with the deterministic AST detector guaranteed as the silent fallback — improving borderline decisions without weakening the deterministic steering guarantee.

## ADDED Requirements

### Requirement: Detector selection via configuration
The `restructure` configuration SHALL accept `detector: "ast" | "jev"` with `"ast"` as the default. Unknown values SHALL produce a warning and fall back to `"ast"`. Selection MUST NOT change any enforcement behavior other than how complexity is classified for ask-resolving chains.

#### Scenario: Default is deterministic
- **WHEN** no `detector` field is configured
- **THEN** complexity classification uses the deterministic AST thresholds and no network call is made

#### Scenario: Unknown detector value falls back safely
- **WHEN** `detector` is set to an unrecognized value
- **THEN** a warning names the invalid value and the plugin uses `"ast"`

### Requirement: Jev classification drives rejection with the same contract
With `detector: "jev"` configured and an endpoint set, the plugin SHALL send the command text to the configured endpoint and receive a typed structured decision (`complex: boolean`, `confidence: number`). The command SHALL be rejected with the standard restructure guidance message only when the response indicates `complex` with `confidence` at or above the configured threshold AND the chain resolves to `ask`. Otherwise the command SHALL proceed to the normal permission flow without rejection.

#### Scenario: Confident complex ask-chain is rejected
- **WHEN** Jev returns `{ complex: true, confidence: 0.95 }` for an ask-resolving chain (threshold 0.8)
- **THEN** the command is rejected with the same actionable guidance as the AST path

#### Scenario: Borderline command reaches the human dialog
- **WHEN** Jev returns `{ complex: true, confidence: 0.5 }` for an ask-resolving chain (threshold 0.8)
- **THEN** the command is not rejected and the normal ask flow presents it to the user

#### Scenario: Not-complex command is not rejected
- **WHEN** Jev returns `{ complex: false }` for a multi-segment ask-resolving chain
- **THEN** the command proceeds to the normal ask flow

### Requirement: Silent fallback to AST on any classifier failure
On request error, timeout exceeding the configured limit, or a malformed/untyped response, the plugin SHALL silently fall back to the deterministic AST decision for that command. The failure MUST NOT throw to the user, deny the command, or skip permission evaluation.

#### Scenario: Timeout falls back
- **WHEN** the Jev endpoint does not respond within the configured timeout
- **THEN** the AST decision applies and the command flows exactly as with `detector: "ast"`

#### Scenario: Malformed response falls back
- **WHEN** the endpoint returns a body that does not match the typed decision schema
- **THEN** the AST decision applies with no user-visible error

### Requirement: No network traffic unless explicitly opted in
With `detector: "ast"` (default), the plugin SHALL issue zero network requests for classification, even when a Jev endpoint is configured. With `detector: "jev"`, requests SHALL go only to the configured endpoint and authenticate via the `JEV_API_KEY` environment variable or the configured key.

#### Scenario: AST path is provably offline
- **WHEN** a Jev endpoint is configured but `detector` remains `"ast"`
- **THEN** no outbound classification request occurs for any command

### Requirement: Jev without configuration degrades to AST at startup
When `detector: "jev"` is selected but no endpoint is configured, the plugin SHALL warn at startup and operate with the AST detector until an endpoint is provided. The feature SHALL remain gated on explicit setup, reflecting early-access availability (issue #22).

#### Scenario: Missing endpoint warns and degrades
- **WHEN** the config selects `"jev"` with an empty endpoint and a command is evaluated
- **THEN** a startup warning is emitted and the AST decision applies
