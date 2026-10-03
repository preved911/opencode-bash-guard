## 1. Characterization Coverage

- [ ] 1.1 Add parser characterization tests for normalized segment order, quote-aware argv, candidate path operands, redirects, substitutions, meta-command bodies, parse errors, per-line counts, and nesting depth; cover relative, absolute, home-relative, flag-like, external-directory, redirect, and multiline path cases.
- [ ] 1.2 Add matcherVersion 2 configuration characterization tests for JSONC comments and trailing commas, global then project deep-merge precedence, missing marker in the effective permissions source, invalid marker, invalid JSONC, invalid individual entries, warning paths, scoped forced-ask behavior, and global degraded ask-everything behavior.
- [ ] 1.3 Add native configuration and policy characterization tests for flat and object `permission.bash`, absent permission keys and hardcoded defaults, self-disable behavior, explicit overrides, `external_directory` default ask, argument matcher refinement and incomparability, ordered anchoring, `--`, `=` forms, flag arity conflicts, most-restrictive decisions, glob fallback, candidate paths, redirects, and chain aggregation.
- [ ] 1.4 Add end-to-end characterization tests for readability thresholds and messages, command wrapping, single-use callID handoff and cleanup between `tool.execute.before` and `permission.ask`, and unchanged prompt count and trigger points across allow, ask, deny, chained, nested, empty, disabled, error, and cancellation paths.

## 2. Parser And Invocation Boundary

- [ ] 2.1 Define normalized invocation and parsed-command types that carry the current parser outputs, candidate path operands, and redirect targets required by policy and readability evaluation.
- [ ] 2.2 Extract shell parsing, candidate-path extraction, and normalization from `src/chain.ts` and `src/paths.ts` behind the new boundary without changing parser coverage, flag exclusion, or path semantics.
- [ ] 2.3 Update parser consumers to use normalized invocations and run focused parser and characterization tests to confirm parity.

## 3. Pure Policy And Readability Evaluation

- [ ] 3.1 Define effective policy input and pure segment and chain evaluation results without OpenCode hook state.
- [ ] 3.2 Extract policy evaluation from `src/config.ts` and `src/enforce.ts`, retaining matcher precedence, candidate path resolution, redirect checks, external-directory defaults, and decision semantics without reparsing shell text.
- [ ] 3.3 Extract the readability constraint as an ask-only post-evaluation step, retaining thresholds, rejection messages, and allowed, denied, no-opinion, and parse-error behavior.
- [ ] 3.4 Run focused policy, readability, and characterization tests to verify parity after each extraction.

## 4. Configuration And OpenCode Adapter

- [ ] 4.1 Keep matcherVersion 2 JSONC loading and global then project precedence in `src/plugin-config.ts`, exposing normalized effective policy to the evaluator.
- [ ] 4.2 Refactor `src/index.ts` and enforcement orchestration into an OpenCode adapter that owns initialization, wrapping, rejection throws, and callID decision storage and cleanup.
- [ ] 4.3 Confirm `tool.execute.before` and `permission.ask` preserve ask, deny, argument-level allow, empty-command, and disabled-plugin behavior.
- [ ] 4.4 Run characterization and existing tests after adapter extraction, asserting single-use callID cleanup and unchanged permission prompt count and trigger points.

## 5. Regression Parity And Cleanup

- [ ] 5.1 Remove superseded cross-layer code only after characterization tests pass through the extracted architecture.
- [ ] 5.2 Run the complete test suite and build, then fix only refactor-introduced parity failures.
- [ ] 5.3 Review public configuration and documentation-facing outputs to confirm no configuration, command policy, prompt-frequency, or behavior change was introduced.
