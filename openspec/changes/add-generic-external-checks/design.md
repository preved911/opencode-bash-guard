## Context

See `proposal.md` for motivation. The post-#45 implementation keeps configuration normalization and static argument matching in `src/config.ts`, segment and chain policy reduction in `src/policy.ts`, invocation orchestration in `src/enforce.ts`, and OpenCode hook data in `src/adapter.ts`. The official `tool.execute.before` hook input contains only `tool`, `sessionID`, and `callID`; it does not carry a working directory. `input.directory` is plugin-initialization state and is not a viable per-invocation cwd source.

Inline checks add asynchronous, trusted user-global policy-code execution to that flow. Project configuration may retain ordinary rules but may not introduce checks. The design must keep static matcher semantics and native permission evaluation unchanged for unchecked rules, while giving a checker only enough invocation data to select its configured outcome. It must also preserve the existing restrictive order, `deny` over `ask` over `allow`, at both segment and chain levels.

## Goals / Non-Goals

**Goals:**

- Add a normalized checked-matcher representation that is invalidated by the same scoped fail-safe path as other invalid matchers.
- Separate pure static matching from asynchronous checker execution, then feed each checked result into the current policy reductions.
- Define a bounded, versioned JSON request and response contract whose untrusted data is classified then discarded.
- Resolve each selected check's current-session directory at the adapter/index boundary, then pass that ephemeral `cwd`, `sessionID`, and `callID` through enforcement without caching them.

**Non-Goals:**

- This design does not change parser normalization, native Bash or external-directory matching, command wrapping, or the adapter's permission-decision lifecycle.
- It does not create a checker registry, bundled checks, lifecycle hooks, persistent results, worktree tracking, input mutation, checker-provided permission actions, sandboxing, logging or prompting of checker data, or atomic command-to-check guarantees.
- It does not add a runtime package. Node's built-in process APIs are sufficient.

## Decisions

### Normalize checks as an action alternative with stable matcher identity

`src/config.ts` will extend the normalized `ArgMatcher` union so a matcher contains either `action` or `check`, never both. A normalized check contains its absolute argv, explicit `onPass` and `onFail`, normalized `onError: "ask"` when omitted, and a bounded positive `timeoutMs`. Validation accepts no unknown check fields, requires a non-empty string argv whose executable path is absolute, requires any explicitly configured interpreter path to be absolute, validates `onPass` and `onFail` as `allow`, `ask`, or `deny`, and validates `onError` only as `ask` or `deny`. Any violation invalidates the owning matcher through the current identifiable-tool scoped-ask behavior.

`plugin-config.ts` preserves the source of every effective matcher through precedence resolution. It accepts a `check` only from the user-global plugin source. A project-sourced `check` invalidates only that matcher and forces scoped `ask` for its identifiable tool; ordinary project matchers remain valid and continue to participate in policy.

During `validateToolPermissions`, each normalized matcher receives the exact deterministic `ruleId` `tool:<effective-entry-index>/matcher:<matcher-index>`. Both zero-based indexes are assigned after config precedence resolution and in effective config-array order, so a checker observes a stable identity for a given effective configuration without requiring a persistent registry or state.

Rationale: a checked matcher cannot have an unconditional contribution. Normalizing the check alongside the matcher keeps its outcomes constrained by configuration validation, while a derived identity lets reports correlate a response to the exact static rule.

Alternative considered: retain `action` and add an optional check that can override it. That creates ambiguous fallback behavior and lets an overlooked static action contribute independently. A random identifier or a stored registry would not remain stable across reloads and would introduce state that this feature does not need.

### Return static candidates before any asynchronous work

`src/config.ts` will keep classification, matcher evaluation, refinement, and candidate selection pure. Its permission matching API will expose selected static matcher contributions rather than immediately collapsing every one to an action. An unchecked selected matcher contributes its current fixed action. A selected checked matcher contributes a check work item containing its normalized check, `ruleId`, and the normalized segment command. A matcher that does not statically match produces neither action nor work item.

The existing action-dependent `"all"` quantifier cannot be inferred from a checked matcher because it has no fixed action. Checked repeated `flagValues`, checked `position: "all"`, checked `operand: "all"`, and checked repeated scalar value selectors therefore use an action-free universal predicate: every candidate must satisfy the static pattern, and an empty candidate list does not match. Every checked matcher is incomparable with every action-bearing matcher and every other checked matcher during refinement. Structurally identical checked duplicates therefore remain selected and execute independently. Their independently selected outcomes are reduced only after execution.

`src/policy.ts` will retain segment fallback and restrictive reduction. `src/enforce.ts` will first resolve all parsed segments to their static candidates, then execute only the selected check work items, replace each checked work item with its configured outcome, and invoke the existing segment and chain reductions. It will make the enforcement path asynchronous, which `src/adapter.ts` can await inside its existing async hook. The static stage completes for the full chain before the first checker process is spawned.

Rationale: static matching remains deterministic, testable, and free of process effects. Finishing it before execution prevents unmatched rules from spawning work and makes it impossible for a checker to affect which rule matched.

Alternative considered: infer the checked selector's quantifier from `onPass` or let another matching action discard it. Outcomes are runtime results, not a static action, and either choice makes a rule's execution depend on a result that does not yet exist. Spawning a checker from `evalMatcher` or reducing while each matcher is inspected has the same flaw, and also makes a currently pure matcher asynchronous.

### Give process execution a narrow runner boundary

Add `src/external-check.ts` as the only module that creates checker processes. It receives one normalized check plus one current invocation request and returns only a validated `pass` or `fail` discriminator, or a classified execution error. It validates bounded `facts` inside the runner and discards them before returning, so facts never cross the runner boundary. It uses Node's built-in `child_process.spawn` with `shell: false`, the configured absolute executable as the command, and remaining configured argv members as arguments. It sets the process `cwd` to the invocation `cwd` and uses `env: {}` with no inherited `PATH`. Check commands and any configured interpreter must therefore be absolute; `/usr/bin/env` shebang lookup is unsupported.

Selected checks run sequentially in deterministic segment, effective-entry, then matcher order. A guarded invocation selects at most 16 checks and starts one 30,000 millisecond wall-clock budget before the first spawn. Each started checker is limited to the lesser of its configured timeout and the remaining invocation-wide budget. Each excess check and each check not yet started when that budget expires contributes its own `onError` without spawning. `timeoutMs` validates only from 1 through 30,000 milliseconds and defaults to 5,000 milliseconds.

The runner writes exactly one JSON request followed by a newline to stdin, closes stdin, and collects stdout and stderr with separate hard UTF-8 byte limits. The implementation fixes stdout at 64 KiB, stderr at 8 KiB, serialized `facts` at 16 KiB, and facts nesting at 8 levels counting the facts root as depth 1. On the first terminal condition, either the per-check timeout, the invocation-wide deadline, or an output-limit breach, it records that monotonic timestamp, stops waiting, closes stdin, and sends `SIGTERM`. It sends `SIGKILL` only if the child remains alive at that first-terminal-condition timestamp plus exactly 250 milliseconds. Spawn errors, signal exits, nonzero exits, write errors, timeout, output limits, and any response parsing failure are runner errors.

Rationale: direct argv execution has no shell parsing or interpolation surface, empty environment prevents inherited ambient authority, and deterministic bounded scheduling prevents a checker set from indefinitely consuming hook time. A dedicated module keeps process behavior out of policy code and requires no new dependency.

Alternative considered: `execFile` with buffered output, a shell command string, parallel execution, or an inherited `PATH`. `execFile` obscures separate streaming limits and termination handling, a shell string violates the command contract, parallel execution makes budget behavior nondeterministic, and inherited environment exposes ambient configuration and credentials.

### Fix protocol version 1 and checker authority

The runner sends this JSON value, using values from the normalized parsed segment and the current adapter invocation:

```json
{
  "protocolVersion": 1,
  "context": { "cwd": "/current/directory", "sessionID": "...", "callID": "..." },
  "command": { "raw": "...", "executable": "...", "argv": ["first-argument", "..."] },
  "match": { "ruleId": "tool:0/matcher:2" }
}
```

`command.argv` contains only arguments after `command.executable`; the executable is never repeated in `argv`. The only successful response shapes are JSON objects with exactly `protocolVersion: 1`, `result`, and optional `facts`; `result` is exactly `"pass"` or `"fail"`. `facts` must be a JSON object, fit the 16 KiB UTF-8 byte limit, and have finite JSON depth at most 8 with its root counted as depth 1. Unknown response fields are rejected. Unsupported version, missing or extra fields, a permission-action field, invalid facts, or malformed JSON is an execution error. Request context is validated, stdout and stderr are classified against their byte limits, and facts are validated; all are discarded immediately afterward and are never logged, prompted, persisted, or used as policy input.

`pass` maps only to `onPass`, `fail` maps only to `onFail`, and every runner error maps only to `onError`. The response has no permission-action field. A response that tries to include one is malformed and therefore selects `onError`.

Rationale: versioning allows a later protocol change to fail safely, and the configuration, not an external executable, remains the authority that selects a permission outcome. Tight response validation gives reporting data a bounded shape without letting it become a policy input.

Alternative considered: let a checker return `allow`, `ask`, or `deny` directly. That would move permission authority outside reviewed configuration. Accepting arbitrary JSON facts or silently ignoring an action field would make the protocol ambiguous and weaken auditability.

### Resolve runtime directory per selected invocation

`src/index.ts` will inject an async runtime-directory resolver into `src/adapter.ts` when it creates the hooks. The resolver reads `(await input.client.session.get({ path: { id: sessionID }, throwOnError: true })).data.directory`, or the equivalent generated-client result exposed by the pinned SDK. The adapter invokes it freshly whenever selected checks or relative-path policy require runtime cwd, and never caches the directory or session response. The same resolved directory drives relative-path resolution, checker cwd, and request context; the adapter passes it with the same hook `sessionID` and `callID` to `src/enforce.ts` and `src/external-check.ts`.

If lookup fails or `Session.directory` is absent, relative-path policy resolves at least to `ask`, and every selected check for that invocation maps to its own `onError` without spawning; unrelated unchecked rules continue through the existing pipeline unchanged. The official hook limitation makes this lookup necessary: the hook has identifiers but no cwd, while plugin-initialization `input.directory` can belong to a different worktree or an earlier lifecycle context. No module stores the resolved directory, response, context, checker response, or checked outcome after the hook resolves.

Checker processes are invoked through `child_process`, not through OpenCode tools or the Bash guard hook. They therefore cannot recurse through guard evaluation. The adapter's existing decision handoff remains responsible only for the final chain action.

Rationale: adapter/index already own the SDK client and OpenCode lifecycle boundary. Fetching the session at the selected invocation is the only available authoritative source for the current worktree directory. Keeping context ephemeral prevents one project's directory or one call's result from bleeding into another.

Alternative considered: use plugin-initialization `input.directory`, reuse a prior session response, or route checks through a Bash invocation. Initialization data is not hook cwd, cached context violates isolation, and a Bash route could recurse into the guard and reintroduce shell interpretation.

### Preserve restrictive reductions and existing fallback behavior

For each segment, checked outcomes replace only their own checked matcher contribution before refinement survivors and independent matches are reduced. They participate in the existing order, `deny` then `ask` then `allow`. The segment result then proceeds through the existing permission-block and native checks. Chain aggregation reduces all segment results in the same order. Therefore a checked `onPass: "allow"` cannot override an independently matching `ask` or `deny`, whether static or check-derived.

Rules without checks keep the existing static result, including matcher refinement, forced scoped ask, glob fallback when no args-level opinion exists, and native checks. A check is never evaluated for an unmatched rule, and checker failure cannot fall through to a glob allow because it produces the configured `onError` contribution.

Rationale: checks refine one rule's outcome, not the authorization model. Reusing the established reductions preserves the fail-safe behavior that callers already rely on.

Alternative considered: let a successful checker short-circuit a segment or chain. That would let one external result weaken independent restrictions and would change unchecked-rule behavior.

### Document the trust boundary and time-of-check limitation

README and configuration documentation will state that a checker is a locally trusted executable configured by absolute path. It receives the full normalized command and invocation directory, runs with that directory as its process cwd, and is not sandboxed. Operators must protect the checker path and its dependencies from untrusted modification, avoid placing secrets in command arguments, and choose timeouts that match their checker.

Documentation will also state that the check decision is not atomic with later command execution. Files, repository state, executable targets, and other inputs can change after a checker returns. A check should be treated as advisory policy evaluation over the invocation snapshot, not as a sandbox or a guarantee against TOCTOU changes.

Rationale: process bounds reduce plugin risk but cannot confer authority or isolation that the operating system and OpenCode lifecycle do not provide.

Alternative considered: claim that the runner sandboxes checks or locks the checked state until execution. The plugin has neither a sandbox nor an atomic filesystem-and-command transaction, so such claims would be false.

## Risks / Trade-offs

- [A checker can be slow, noisy, malformed, or fail to start] -> Sequential count, invocation budget, per-check timeout, UTF-8 byte limits, and first-terminal-condition termination classify the event as an error and use the configured, validated `onError`, which defaults to `ask`.
- [The hook has no current cwd and session lookup can fail] -> Resolve fresh `Session.directory` whenever selected checks or relative-path policy require it. On lookup failure or an absent directory, paths are at least `ask` and each selected check maps through `onError` without spawning.
- [One live hook instance can receive calls from different worktrees] -> Resolve the session directory for every selected invocation and verify one resolver returns two distinct worktree directories without cross-call reuse.
- [A configured executable or checker dependency can be replaced after config review] -> Documentation defines the local trust boundary and requires operators to control checker paths and dependencies. No sandbox claim is made.
- [State can change between check and command execution] -> Documentation explicitly calls out the TOCTOU limitation. The feature makes no atomicity guarantee.
- [A large selected set could create nondeterministic or unbounded work] -> Run checks in segment, entry, matcher order, cap selection at 16, and map excess or budget-unstarted checks to their own `onError` without spawning.
- [Checker response data could disclose command or repository information] -> Classify request context, stdout, stderr, and facts within UTF-8 byte bounds, then discard them without logging, prompting, persistence, or policy use.
- [A protocol change could be mistaken for a valid result] -> Version 1 is exact. Unsupported versions and unrecognized result shapes select `onError`.
- [Changing matcher APIs can regress existing permission behavior] -> Keep classification, refinement, fallback, native checks, and reductions in their current modules, and add characterization tests for unchecked rules beside check-specific tests.

## Migration Plan

1. Extend types and normalization in `src/config.ts` and source tracking in `plugin-config.ts`. Accept checks only from user-global config, scope project-sourced checks to ask, restrict `onError` to `ask` or `deny`, and assign deterministic `ruleId` values. Existing configurations without `check` normalize to their current action-bearing matcher shape.
2. Refactor the static matching return shape without changing classification or reductions for unchecked matchers. Make all checked matchers mutually incomparable with checked and action-bearing matchers, including duplicates, and add tests proving independent duplicate execution and unchanged args, glob, native, segment, and chain outcomes.
3. Add the built-in-only runner in `src/external-check.ts` with `env: {}`, absolute executable and interpreter validation, protocol fixtures, and boundary tests for argv excluding the executable, exact response fields, UTF-8 byte accounting, facts root depth 1, discard-only handling, 1 through 30,000 ms timeout validation, stream limits, first-terminal-condition plus 250 ms termination, sequential order, the 16-check cap, and the 30,000 ms invocation budget.
4. Split static planning from checked execution in `beforeExecute`; inject the session-directory resolver from `src/index.ts` to `src/adapter.ts`. Freshly fetch `(await input.client.session.get({ path: { id: sessionID }, throwOnError: true })).data.directory` whenever checks or relative-path policy need runtime cwd. Use one directory for paths, request, and child cwd; on failure, make paths at least ask and map selected checks through `onError`. Verify one live hook instance resolves two worktree directories on separate calls and that checker execution bypasses OpenCode tool hooks.
5. Document the user-global trust boundary, empty-environment contract, scheduling limits, data-discard rule, and TOCTOU limitation. Release as an additive opt-in feature because no existing matcher executes a check unless its user-global configuration explicitly adds one.
6. Roll back by removing `check` objects from configuration or by reverting the feature release. A removed or invalid check follows existing scoped fail-safe handling rather than silently becoming an allow.
