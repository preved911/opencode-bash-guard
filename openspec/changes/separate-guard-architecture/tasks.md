## 1. Characterization Coverage

- [ ] 1.1 Add parser characterization tests for normalized segment order, quote-aware argv, redirects, substitutions, meta-command bodies, parse errors, per-line counts, and nesting depth.
- [ ] 1.2 Add matcherVersion 2 configuration characterization tests for JSONC comments and trailing commas, global then project deep-merge precedence, structured argument matcher normalization, and invalid-file degraded mode.
- [ ] 1.3 Add policy characterization tests for argument matcher refinement, most-restrictive decisions, glob fallback, extracted paths, redirects, and chain aggregation.
- [ ] 1.4 Add end-to-end characterization tests for readability thresholds and messages, command wrapping, and callID handoff between `tool.execute.before` and `permission.ask`.

## 2. Parser And Invocation Boundary

- [ ] 2.1 Define normalized invocation and parsed-command types that carry the current parser outputs required by policy and readability evaluation.
- [ ] 2.2 Extract shell parsing and normalization from `src/chain.ts` behind the new boundary without changing parser coverage or output semantics.
- [ ] 2.3 Update parser consumers to use normalized invocations and run focused parser and characterization tests to confirm parity.

## 3. Pure Policy And Readability Evaluation

- [ ] 3.1 Define effective policy input and pure segment and chain evaluation results without OpenCode hook state.
- [ ] 3.2 Extract policy evaluation from `src/config.ts` and `src/enforce.ts`, retaining matcher precedence, path and redirect checks, and decision semantics.
- [ ] 3.3 Extract the readability constraint as an ask-only post-evaluation step, retaining thresholds, rejection messages, and allowed, denied, no-opinion, and parse-error behavior.
- [ ] 3.4 Run focused policy, readability, and characterization tests to verify parity after each extraction.

## 4. Configuration And OpenCode Adapter

- [ ] 4.1 Keep matcherVersion 2 JSONC loading and global then project precedence in `src/plugin-config.ts`, exposing normalized effective policy to the evaluator.
- [ ] 4.2 Refactor `src/index.ts` and enforcement orchestration into an OpenCode adapter that owns initialization, wrapping, rejection throws, and callID decision storage and cleanup.
- [ ] 4.3 Confirm `tool.execute.before` and `permission.ask` preserve ask, deny, argument-level allow, empty-command, and disabled-plugin behavior.

## 5. Regression Parity And Cleanup

- [ ] 5.1 Remove superseded cross-layer code only after characterization tests pass through the extracted architecture.
- [ ] 5.2 Run the complete test suite and build, then fix only refactor-introduced parity failures.
- [ ] 5.3 Review public configuration and documentation-facing outputs to confirm no configuration, command policy, or behavior change was introduced.
