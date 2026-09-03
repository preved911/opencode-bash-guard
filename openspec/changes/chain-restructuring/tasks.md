## 1. Chain Metrics (`src/chain.ts`)

- [ ] 1.1 Extend `parseChain` to report max substitution nesting depth: track depth while recursively walking `$()`, backticks, and meta-command string args
- [ ] 1.2 Return shape: `{ segments, maxDepth, parseError }` (or parallel accessor) — keep existing call sites compiling
- [ ] 1.3 Unit tests: flat chain depth 0/1, single-level `$()`, triple nesting, `bash -c "..."` depth accounting

## 2. Config (`src/config.ts`)

- [ ] 2.1 Add `RestructureConfig { enabled: boolean; maxSegments: number; maxDepth: number }` to `PluginConfig`
- [ ] 2.2 Parse `permission.bash_restructure`: absent or `false` → disabled; object → enabled, defaults `maxSegments: 3`, `maxDepth: 2`; non-positive/non-numeric values dropped with warning
- [ ] 2.3 Unit tests for all config scenarios in `specs/chain-restructuring/spec.md`

## 3. Enforcement (`src/enforce.ts`)

- [ ] 3.1 Export rejection-message builder with actual counts: `[opencode-bash-guard] Complex one-liner rejected (N chained commands, nesting depth D). Re-issue as separate bash tool calls, or as a multi-line script with one command per line — each command is then permission-checked individually.`
- [ ] 3.2 In `beforeExecute`: after `resolveChain`, if action is `null`/`allow` AND (segments > maxSegments || maxDepth > maxDepth limit) → throw Error with the message
- [ ] 3.3 Preserve flows: parse-error deny before resolution; `deny` → wrap+store; `ask` → wrap+store; disabled config → no throw anywhere
- [ ] 3.4 Unit tests: rejected allow-chain (nothing executes, message has counts), rejected null-chain, deny/ask unchanged, parse error unchanged, repeated violation re-throws, threshold boundary (N == max passes, N+1 throws)

## 4. Integration Tests

- [ ] 4.1 Multi-line re-issue: 4-line script parses into 4 segments, each checked independently
- [ ] 4.2 Separate-calls re-issue: single-segment commands evaluate normally
- [ ] 4.3 Config matrix: disabled → zero throws across all commands; default thresholds; custom thresholds

## 5. Documentation

- [ ] 5.1 Fix README stale claims: `git status && git log` row → "passes through"; remove/correct "multi-segment chains trigger ask (defense-in-depth)" in How-it-works and design references
- [ ] 5.2 README new section "Readable commands": `bash_restructure` config example, threshold semantics (strictly greater), what a rejection looks like (tool error, nothing executes), AGENTS.md snippet:

  ```markdown
  ## Bash command style
  - Issue one command per tool call. For sequences, use separate bash calls.
  - Never write chained one-liners (`a && b && c`). If rejected, split and retry.
  ```

- [ ] 5.3 README known limitations: pipeline-heavy workflows may need higher `max_segments`; no retry counter in v1; note on `permission.ask` reliability (issue anomalyco/opencode#19469) pending separate verification

## 6. Verification

- [ ] 6.1 `npm test` — full suite green including new tests
- [ ] 6.2 `npm run build` — type-check passes
- [ ] 6.3 Manual: complex allowed one-liner with `bash_restructure` present → tool error with counts, model retries split
- [ ] 6.4 Manual: same command without the section → runs as before
- [ ] 6.5 Manual: deny/ask commands unchanged with feature enabled
