## 1. Checked Matcher Configuration

- [ ] 1.1 Add precedence-source tests in `src/__tests__/plugin-config.test.ts` for user-global checks accepted into the effective rules, project-sourced checks rejected to scoped ask, and ordinary project matchers remaining valid alongside a rejected project check.
- [ ] 1.2 Add normalization tests in `src/__tests__/tool-permissions.test.ts` for an absolute checker command and explicit absolute interpreter path, required `onPass` and `onFail`, `onError` defaulting to `ask`, `timeoutMs` defaulting to 5000, and accepted integer endpoints 1 and 30000.
- [ ] 1.3 Add invalid-configuration tests in `src/__tests__/tool-permissions.test.ts` for action/check exclusivity, unknown check fields, relative executable or interpreter paths, non-string argv members, missing or invalid outcomes, `onError: "allow"`, non-integer and out-of-range timeout values, and identifiable scoped-ask fallback that suspends glob allows.
- [ ] 1.4 Extend `src/config.ts` and `src/plugin-config.ts` so check provenance survives precedence resolution, only user-global checks normalize, each matcher contains exactly an action or normalized check, `onError` is limited to ask or deny, and invalid project checks force scoped ask without dropping ordinary project rules.
- [ ] 1.5 Add static-selection tests in `src/__tests__/tool-permissions.test.ts` for checked repeated scalar values, repeated `flagValues`, `position: "all"`, and `operand: "all"`, asserting universal non-empty semantics, one failing occurrence prevents selection, and empty candidates produce no work item.
- [ ] 1.6 Add refinement tests in `src/__tests__/tool-permissions.test.ts` proving every checked matcher is incomparable with action-bearing and checked matchers, including identical checked duplicates that both remain selected and execute independently.
- [ ] 1.7 Refactor static matching in `src/config.ts` to return fixed-action contributions and selected check work items without process effects, apply checked universal semantics and mutual incomparability, assign exact `tool:<effective-entry-index>/matcher:<matcher-index>` rule IDs after precedence resolution, and retain unchanged unchecked classification, refinement, forced-ask, and glob fallback.

## 2. External Check Protocol Runner

- [ ] 2.1 Create fixture helpers and protocol success tests in new `src/__tests__/external-check.test.ts` for one newline-terminated request object with exactly `protocolVersion: 1`, `context`, `command`, and `match`; `command.argv` excluding `command.executable`; and deterministic zero-based `match.ruleId`.
- [ ] 2.2 Add response-contract tests in `src/__tests__/external-check.test.ts` for exact response `protocolVersion: 1`, exactly `result` plus optional `facts`, pass and fail mapping, rejection of unknown, missing, or extra fields and returned permission actions, malformed JSON, facts root counted as depth 1 with maximum depth 8, and a 16 KiB UTF-8 byte limit.
- [ ] 2.3 Add process-boundary tests in `src/__tests__/external-check.test.ts` for direct argv without shell interpretation, an empty `env: {}` with no inherited PATH, absolute executable and interpreter invocation, cwd propagation, stdin closure, UTF-8 byte counting for 64 KiB stdout and 8 KiB stderr, spawn and write errors, signal and nonzero exits, and no recursive Bash guard evaluation.
- [ ] 2.4 Add timing tests in `src/__tests__/external-check.test.ts` for default 5000 ms and configured 1 through 30000 ms timeouts, stop-waiting at the first terminal condition, and SIGKILL only when the child remains alive exactly 250 ms after the triggering timeout or early output-breach timestamp.
- [ ] 2.5 Add data-lifetime tests in `src/__tests__/external-check.test.ts` proving request context, stdout, stderr, and valid facts are validated or classified then discarded without logging, prompting, persistence, or policy input.
- [ ] 2.6 Implement `src/external-check.ts` as the sole process boundary using `child_process.spawn` with `shell: false`, empty environment, strict version-1 parsing, UTF-8 byte and facts-depth limits, classified errors, first-terminal-condition termination, and discard-only diagnostic handling.

## 3. Async Policy And Enforcement

- [ ] 3.1 Add enforcement tests in `src/__tests__/enforce.test.ts` proving complete static selection for every chain segment precedes the first spawn, unmatched rules never run, and selected checks execute sequentially in segment, effective-entry, then matcher order.
- [ ] 3.2 Add scheduling tests in `src/__tests__/enforce.test.ts` for at most 16 selected checks, each excess check contributing its own `onError` without spawning, a 30000 ms invocation-wide budget beginning before the first spawn, each started check being clamped to the lesser of its configured timeout and the remaining invocation budget, and each budget-unstarted check contributing its own `onError` without spawning.
- [ ] 3.3 Add aggregation tests in `src/__tests__/enforce.test.ts` for pass, fail, runner error, and unstarted-check outcomes joining existing restrictive segment and chain reduction; checked allow losing to independent ask or deny; checked allow retaining the args-level override; and a checked error preventing glob fallback.
- [ ] 3.4 Refactor `src/policy.ts` to carry static check work independently from action contributions and reduce every selected or unstarted check outcome with existing deny, ask, allow ordering while preserving unchanged unchecked args, glob, path, redirect, and chain behavior.
- [ ] 3.5 Make `beforeExecute` in `src/enforce.ts` asynchronous, plan the full chain before spawning, execute selected checks deterministically under the invocation-wide budget, and preserve parse-error, degraded-config, wrapping, readability, and permission-override semantics.

## 4. Runtime Directory Resolution

- [ ] 4.1 Add resolver-injection tests in new `src/__tests__/index.test.ts` proving `src/index.ts` injects a wrapper that returns `(await input.client.session.get({ path: { id: sessionID }, throwOnError: true })).data.directory`, not plugin-initialization `input.directory`.
- [ ] 4.2 Add hook tests in `src/__tests__/hooks-characterization.test.ts` for one live hook instance handling two selected-check calls from distinct sessions and worktrees, asserting a fresh SDK lookup per call and one identical resolved cwd for relative-path evaluation, checker request context, and checker process cwd.
- [ ] 4.3 Add hook tests in `src/__tests__/hooks-characterization.test.ts` proving a fresh SDK lookup happens whenever selected checks or relative-path policy need runtime cwd, including a path-only invocation with no selected checks, while an invocation with neither selected checks nor relative-path policy need performs no lookup.
- [ ] 4.4 Add hook tests in `src/__tests__/hooks-characterization.test.ts` for failed lookup and missing `.data.directory`, asserting relative paths resolve at least to ask, every selected check maps to its own `onError` without spawning, and unrelated unchecked rules preserve their existing pipeline.
- [ ] 4.5 Update `src/index.ts` to inject the `.data.directory` resolver and `src/adapter.ts` to invoke it freshly only when selected checks or relative path policy require cwd, pass the same ephemeral directory to paths, enforcement, requests, and children, map lookup failure safely, and retain only final allow or deny lifecycle decisions.

## 5. Unchecked-Rule Compatibility

- [ ] 5.1 Extend `src/__tests__/policy-characterization.test.ts`, `src/__tests__/enforce.test.ts`, and `src/__tests__/hooks-characterization.test.ts` with regressions proving action-only rules preserve classification, refinement, forced scoped ask, glob fallback, native checks, segment and chain reductions, and lifecycle handoff; calls with neither selected checks nor relative-path policy need make no SDK lookup or process spawn.
- [ ] 5.2 Run and fix affected existing tests so every matcher without `check` retains its pre-feature behavior after the asynchronous planning and resolver changes.

## 6. Documentation

- [ ] 6.1 Update `README.md` with user-global-only inline-check configuration, project scoped-ask rejection, action/check exclusivity, restrictive `onError`, timeout and scheduling limits, and the exact version-1 request and response contract.
- [ ] 6.2 Document in `README.md` that checkers and interpreter paths are trusted absolute paths, execute without a shell in an empty environment, receive the current session worktree directory, are not sandboxed, and require protected paths and dependencies.
- [ ] 6.3 Document in `README.md` that checker request context, stdout, stderr, and facts are validated then discarded without logging, prompting, persistence, or policy use, and that checks remain advisory and subject to TOCTOU limits.

## 7. Final Verification

- [ ] 7.1 Run `npm test` and confirm the full Vitest suite, including `src/__tests__/external-check.test.ts` and `src/__tests__/index.test.ts`, passes.
- [ ] 7.2 Run `npm run build` and confirm TypeScript compilation passes without adding runtime dependencies.
- [ ] 7.3 Run `openspec validate add-generic-external-checks --strict` and confirm the completed change artifacts validate.
