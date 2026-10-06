# Spec Delta

## Purpose

Ships the plugin's "one command per line" guidance as an opt-in system-prompt injection via OpenCode's `experimental.chat.system.transform` hook, removing the manual AGENTS.md editing step while leaving the deterministic rejection path as the enforcement guarantee.

## ADDED Requirements

### Requirement: Opt-in guidance injection into the system prompt
When `instruction.enabled` is true, the plugin SHALL append its static guidance block to the system prompt on every LLM request via the `experimental.chat.system.transform` hook. When the flag is absent or false (default), the system prompt SHALL NOT be modified.

#### Scenario: Enabled injects on each request
- **WHEN** `instruction.enabled` is true and an LLM request is assembled
- **THEN** the guidance block appears exactly once in the system prompt for that request

#### Scenario: Disabled leaves the prompt untouched
- **WHEN** the `instruction` section is absent or `enabled` is false
- **THEN** no plugin guidance appears in the system prompt

### Requirement: Guidance content is static and non-accumulating
The injected text SHALL be a fixed block instructing: one command per tool call, sequences as separate calls, and — if a command is rejected as complex — splitting and retrying in compliant form. Because the host rebuilds the system prompt per request, repeated requests MUST NOT accumulate duplicate blocks.

#### Scenario: Repeated requests do not stack guidance
- **WHEN** ten consecutive LLM requests occur in one session with injection enabled
- **THEN** each request's system prompt contains exactly one guidance block

### Requirement: Graceful degradation when the experimental hook is unavailable
If the hook is absent from the host (API change), the plugin SHALL continue all enforcement unchanged, emit at most one warning that instruction injection is unavailable, and require no configuration change. The guidance outcome in that case regresses to the documented manual AGENTS.md alternative.

#### Scenario: Hook removal does not break enforcement
- **WHEN** the host no longer supports the experimental hook
- **THEN** chain/restructure enforcement behaves identically and a single warning names the manual AGENTS.md alternative

### Requirement: Injection is independent of restructure enforcement
The `instruction` feature SHALL function regardless of `restructure.enabled`, and enabling it MUST NOT relax, strengthen, or otherwise alter any rejection threshold or enforcement decision.

#### Scenario: Injection without restructure
- **WHEN** `instruction.enabled` is true and `restructure.enabled` is false
- **THEN** guidance is injected while chain enforcement behaves exactly as with injection off

#### Scenario: Thresholds unchanged by injection
- **WHEN** injection is enabled and a complex ask-resolving chain is evaluated
- **THEN** the rejection decision and message are identical to the decision with injection disabled
