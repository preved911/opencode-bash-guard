## Why

The guard's parsing, configuration handling, policy decisions, readability checks, and OpenCode hooks are interwoven across a small set of modules. [Issue #42](https://github.com/preved911/opencode-bash-guard/issues/42) separates those responsibilities so future changes can be made and tested without changing the package's current behavior.

## What Changes

- Reorganize the guard around distinct parsing, normalized invocation, policy evaluation, readability, and OpenCode adapter layers.
- Preserve the current matcherVersion 2 JSONC configuration behavior, including global then project precedence and degraded-mode handling.
- Preserve existing decision semantics for glob, structured argument, path, redirect, and chain evaluation.
- Preserve optional readability and restructuring behavior, including its thresholds, rejection conditions, and messages.
- Preserve `tool.execute.before` and `permission.ask` behavior, including callID decision handoff.
- Preserve permission prompt cardinality and trigger points for each tool invocation and callID, including chained and nested commands.
- Add characterization coverage before extraction and require regression parity after the refactor.

## Capabilities

### New Capabilities

None. This is a behavior-preserving refactor.

### Modified Capabilities

None. Existing requirements remain unchanged.

## Impact

The implementation will reorganize `src/chain.ts`, `src/paths.ts`, `src/config.ts`, `src/enforce.ts`, `src/plugin-config.ts`, and `src/index.ts`, with related tests under `src/__tests__/`. Public configuration, package interfaces, prompt frequency, and existing specifications remain unchanged. External executable checks or predicates are explicitly out of scope for this change and remain separate future work.
