## Why

[Issue #43](https://github.com/preved911/opencode-bash-guard/issues/43) needs policy authors to run small, local checks for a matched permission rule without adding command-specific logic to the guard. The checks need a narrow, deterministic execution contract so a checker failure cannot silently widen access.

## What Changes

- Add optional inline external checks to permission rules. Checks are trusted local policy code accepted only from user-global plugin config; project-sourced check objects fail safe while ordinary project rules remain supported. Static rule matching completes before any checker is spawned, and rules without checks retain their current behavior.
- Define a versioned JSON stdin/stdout pass or fail protocol, executed as direct argv with absolute interpreter and executable paths, an empty environment, and the current invocation's runtime cwd.
- Let checks use explicit `onPass`, `onFail`, and `onError` outcomes, with `onError` restricted to `ask` or `deny` and defaulting to `ask`; apply bounded per-invocation scheduling, timeout, resource, and reported-failure limits, then combine results with the existing restrictive chain behavior.
- Resolve relative paths against the authoritative per-invocation session directory instead of initialization-time cwd.
- Add configuration validation, security guidance, documentation, and coverage for protocol, runtime, compatibility, and fail-safe behavior.
- Keep command-specific checks, a named checker registry, returned permission actions, checker input mutation, global hooks, and persisted worktree paths out of scope.

## Capabilities

### New Capabilities

- `external-rule-checks`: Define trusted inline checker configuration, direct execution, versioned JSON protocol, per-invocation runtime context, bounded scheduling and failures, and restrictive outcome aggregation.

### Modified Capabilities

- `args-permission-matching`: Allow validated optional inline checks on permission rules while preserving matching and fallback behavior for rules that omit them.
- `path-extraction`: Resolve relative paths from the per-invocation session directory rather than initialization-time cwd.

## Impact

- User-global `opencode-bash-guard.jsonc` is the only source for trusted check objects; project-sourced check objects fail safe without disabling ordinary project rules.
- Permission evaluation and chain decisions, per-invocation relative-path resolution, checker process execution, user-facing documentation, security guidance, and automated tests.
