## 1. Plugin Config Loader (`src/plugin-config.ts`, new)

- [ ] 1.1 Add `jsonc-parser` dependency
- [ ] 1.2 Implement file discovery: global (`~/.config/opencode/opencode-bash-guard.jsonc`, honoring `XDG_CONFIG_HOME`) and project (`<project>/.opencode/opencode-bash-guard.jsonc`, root from plugin init `input.directory`)
- [ ] 1.3 Parse JSONC (comments, trailing commas); missing file → skip silently; invalid JSONC → warning naming the file, feature treated as disabled
- [ ] 1.4 Deep-merge global + project (project wins); implement `parsePluginConfig(files): PluginConfig`
- [ ] 1.5 Define `RestructureConfig { enabled: boolean; maxSegments: number; maxDepth: number }` — defaults `enabled: false`, `maxSegments: 3`, `maxDepth: 2`; non-numeric or `< 1` threshold values dropped with warning, default applies
- [ ] 1.6 Wire loader into plugin init in `src/index.ts`
- [ ] 1.7 Unit tests: no files → disabled; project-over-global merge; JSONC comments/trailing commas; invalid file → warning + disabled; invalid thresholds → defaults; explicit values honored

## 2. Chain Metrics (`src/chain.ts`)

- [ ] 2.1 Extend `parseChain` to report max substitution nesting depth: track depth while recursively walking `$()`, backticks, and meta-command string args
- [ ] 2.2 Return shape: `{ segments, maxDepth, parseError }` (or parallel accessor) — keep existing call sites compiling
- [ ] 2.3 Unit tests: flat chain depth 0/1, single-level `$()`, triple nesting, `bash -c "..."` depth accounting
- [ ] 2.4 Per-line segmentation helper: split command into lines, parse each line into segments (returns per-line counts + worst offending line)
- [ ] 2.5 Interpreter inline-script detection: `python`/`python3 -c`, `perl -e`, `node -e`/`--eval`, `ruby -e`, `php -r`, heredoc-scripted interpreters — extract script string, count statements (`;`/newline split); unit tests: short script passes, `;`-split count, newline-split count, non-interpreter command unaffected

## 3. Enforcement (`src/enforce.ts`)

- [ ] 3.1 Export rejection-message builder with actual counts: single-line → `[opencode-bash-guard] Complex one-liner rejected (N chained commands, nesting depth D). Re-issue as separate bash tool calls, or as a multi-line script with one command per line — each command is then permission-checked individually.`; multi-line → worst offending line (`line K: N chained commands`); interpreter inline script → interpreter name + statement count with one-statement-per-line / move-to-file guidance
- [ ] 3.2 Implement complexity check: every line of the command → line segments > maxSegments (single-line = one line); whole command → maxDepth > maxDepthLimit; inline-script statement count > maxSegments counts as exceeded
- [ ] 3.3 In `beforeExecute`: after `resolveChain`, throw the guidance Error ONLY when action is `ask` AND `restructure.enabled` AND limits exceeded; `allow`/`deny`/`null`/parse-error flows verbatim
- [ ] 3.4 Unit tests: allowed complex chain passes (no throw); complex ask chain throws (message contains counts + instruction); multi-line one-command-per-line passes; 2-line script of 5-segment `&&` chains throws naming the line; inline `python3 -c` with 5 statements throws; pretty inline script passes; deny/ask-disabled/null/parse-error unchanged; repeated violation re-throws; boundaries (N == max passes, N+1 throws)

## 4. Integration Tests

- [ ] 4.1 Multi-line re-issue: 4-line script parses into 4 segments, each checked independently
- [ ] 4.2 Separate-calls re-issue: single-segment commands evaluate normally
- [ ] 4.3 Config matrix: disabled → zero throws across all commands; enabled with defaults; enabled with custom thresholds
- [ ] 4.4 Multi-line per-line chains: 2-line script of long `&&` chains on an ask-resolving chain → rejected with line-scoped message

## 5. Documentation

- [ ] 5.1 Fix README stale claims: `git status && git log` row → "passes through"; remove/correct "multi-segment chains trigger ask (defense-in-depth)"
- [ ] 5.2 README new section "Readable commands": `opencode-bash-guard.jsonc` example (both locations, `restructure` nested fields with defaults), strict-greater threshold semantics, what a rejection looks like (tool error, nothing executes, no dialog), AGENTS.md snippet:

  ```markdown
  ## Bash command style
  - Issue one command per tool call. For sequences, use separate bash calls.
  - Never write chained one-liners (`a && b && c`). If rejected, split and retry.
  ```

- [ ] 5.3 README known limitations: config read once at startup (restart to apply); heuristic inline-script statement counting (strings containing `;` can miscount; errs toward rejection); no retry counter; note on `permission.ask` reliability (issue anomalyco/opencode#19469) pending separate verification

## 6. Verification

- [ ] 6.1 `npm test` — full suite green including new tests
- [ ] 6.2 `npm run build` — type-check passes
- [ ] 6.3 Manual: complex not-allowed one-liner with `restructure.enabled: true` → tool error with counts, model retries as multi-line → readable ask dialog
- [ ] 6.4 Manual: complex fully-allowed one-liner with feature enabled → runs (allowed stays allowed)
- [ ] 6.5 Manual: no config file → behavior identical to previous release
- [ ] 6.6 Manual: deny/ask commands with feature disabled → unchanged
