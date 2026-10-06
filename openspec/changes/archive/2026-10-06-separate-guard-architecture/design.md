## Context

See [proposal.md](proposal.md) for motivation. The current implementation spans shell parsing in `src/chain.ts`, path extraction in `src/paths.ts`, native and plugin configuration in `src/config.ts` and `src/plugin-config.ts`, enforcement in `src/enforce.ts`, and hook wiring in `src/index.ts`. These layers currently exchange shell text, parsed segments, configuration, decisions, readability results, and callID state directly. Path extraction currently reparses segment text, so its ownership must move to the normalized invocation boundary rather than remain a second shell parser.

The refactor must retain the published matcherVersion 2 JSONC format, including comments and trailing commas, global then project deep-merge precedence, invalid-file degraded mode, and current structured argument matcher normalization. It must also retain current parser coverage, policy precedence, redirect and path handling, optional readability behavior, and event-based decision delivery.

## Goals / Non-Goals

**Goals:**

- Define a parser boundary that converts shell input into normalized invocations while preserving segment ordering, argv, redirects, nesting data, parse errors, and source text needed by existing behavior.
- Make normalized invocations carry syntactically extracted candidate path operands and redirect targets so policy evaluation does not reparse shell text.
- Define a pure policy evaluator that receives normalized invocations plus effective policy and returns decisions without reading files, mutating hook output, or owning callID state.
- Keep readability as a constraint applied to the evaluated result, preserving the current opt-in strict-greater thresholds and ask-only thrown-guidance-error path.
- Keep OpenCode integration in an adapter that loads configuration, calls the parser and evaluator, wraps commands when required, and delivers stored decisions through `permission.asked` for the nested `tool.callID`.
- Preserve the number and trigger points of permission prompts per invocation and callID across allow, ask, deny, chained, nested, empty, and disabled paths.
- Establish characterization tests before moving code, then require full behavioral parity after each extraction stage.

**Non-Goals:**

- Change public configuration, matcher syntax, default values, supported shell forms, decision outcomes, messages, or hook contracts.
- Add command-specific bundled policies.
- Add external executable checks or predicates. That work belongs to issue #43.
- Change existing OpenSpec requirements. This change has no specification delta.

## Decisions

### Separate parsing from normalized invocations

Introduce a parser-facing model that turns a bash command into normalized invocations. Each invocation carries the command text and name, quote-aware argv, redirects, candidate path operands, and any parser-derived context needed for chain and readability evaluation. The parser remains responsible for shell syntax, command substitutions, meta-command bodies, depth, parse failures, and syntactic candidate-path extraction. Path policy remains responsible for resolving those candidates against the working directory and applying edit and external-directory rules.

This keeps AST details at the parsing boundary and prevents `src/paths.ts` or policy code from reparsing shell strings. Keeping policy evaluation text-driven was considered, but it would preserve the current coupling and risk inconsistent argv, path, or redirect treatment.

### Make policy evaluation pure

Move segment and chain decisions into pure functions over normalized invocations, working directory, and already-normalized effective policy. Preserve the current ordering: structured argument matches decide a matching invocation before glob evaluation, refinement and most-restrictive semantics remain unchanged, and candidate path, redirect, and external-directory results combine with the existing precedence. Chain aggregation must keep deny over ask over allow, with all invocations required for a chain allow.

The evaluator returns decision data rather than mutating a decision store or hook output. A stateful evaluator was considered, but it would make characterization and parity checks depend on OpenCode lifecycle details.

### Keep readability as a post-evaluation constraint

Apply the optional readability constraint only after parsing and policy evaluation identify an ask result. When enabled, it consumes normalized invocation data plus command-wide depth and per-line information, preserving strict-greater thresholds, inline-script counting, allowed and denied paths, no-opinion paths, parse-error handling, and thrown guidance errors. The error need not include the original command text.

Embedding readability into parser or policy evaluation was considered. That would mix a presentation-oriented constraint with syntax or decision semantics and make the ask-only condition harder to verify.

### Isolate OpenCode adapter responsibilities

Keep configuration discovery and parsing at initialization, then let the adapter build effective policy, invoke the parser, evaluator, and readability constraint, and translate the result into hook effects. The adapter alone owns command wrapping, throwing readability rejections, and instance-local single-use decision state keyed by `(sessionID, callID)`.

The adapter must preserve prompt cardinality as an observable invariant: a refactored invocation must request permission at exactly the same trigger points and no more or fewer times than the current implementation. `tool.execute.before` stores only injected replies for a nested `tool.callID`: allow is injected once, deny is injected once as a rejection, and ask leaves the SDK reply unchanged. `permission.asked` consumes the stored reply once. `tool.execute.after`, `session.idle`, `session.deleted`, and adapter disposal remove unconsumed state. State is instance-local and keyed by `(sessionID, callID)`, so concurrent sessions and adapter instances cannot overwrite or consume each other's decisions.

Moving hook state into the evaluator was rejected because callIDs and hook output are OpenCode-specific. Keeping all behavior in the current enforcement module was rejected because it leaves the architectural boundary unclear.

### Preserve configuration loading and precedence

Keep native permission parsing separate from plugin-file loading, but expose a single effective policy input to the evaluator. matcherVersion 2 JSONC parsing must continue to accept comments and trailing commas, deep-merge global then project settings, normalize structured argument matchers, and enter ask-everything degraded mode when any loaded file is invalid.

Replacing the loader or flattening project and global data earlier was considered, but either could alter precedence or degraded-mode behavior.

## Risks / Trade-offs

- [Boundary changes alter a decision edge case] -> Add characterization fixtures for parser output, matcherVersion 2 JSONC merging, segment and chain decisions, readability outcomes, and hook handoff before extraction. Compare the extracted path against those fixtures.
- [Normalized invocation loses parser detail] -> Include argv, redirects, command text, command name, per-line counts, parse status, and nesting data in the model, then cover substitutions, meta-commands, quoted arguments, redirects, and multiline input.
- [Path extraction changes while removing the second parse] -> Characterize relative, absolute, home-relative, flag-like, external-directory, and redirect paths before moving candidate extraction into normalized invocations.
- [Adapter extraction breaks callID cleanup or injected replies] -> Test the full `tool.execute.before` to `permission.asked` sequence for ask, deny rejection, argument-level allow, parse errors, and readability rejection.
- [Adapter extraction changes prompt frequency] -> Assert prompt count and trigger points for simple, chained, nested, empty, disabled, allow, ask, deny, error, and cancellation paths.
- [Incremental moves create temporary duplicate logic] -> Move one responsibility at a time and remove the old path only after parity tests pass.

## Migration Plan

1. Add characterization tests that capture the existing behavior at each planned boundary.
2. Extract normalized invocation parsing behind the existing call sites and run the focused and full test suites.
3. Extract pure policy evaluation, then readability evaluation, retaining the same adapter-visible result shape.
4. Move OpenCode-specific orchestration into the adapter, remove superseded coupling, and confirm regression parity.
