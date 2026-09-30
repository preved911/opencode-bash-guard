# Tasks

## 1. Config Schema Extension (`src/plugin-config.ts`)

- [ ] 1.1 If `src/plugin-config.ts` (chain-restructuring task 1) is absent, implement the loader first: discovery (global + project JSONC), deep-merge, validation rules — verify with `npx tsc --noEmit` and the loader unit tests from that task list
- [ ] 1.2 Extend `PluginConfig` with `stats { enabled: true, log_previews: false }`, `restructure.detector: "ast" | "jev"` (default `"ast"`), `restructure.jev { endpoint: "", timeout_ms: 1500, confidence_threshold: 0.8, api_key: "" }`, and `instruction { enabled: false }` — non-conforming values warn and drop to defaults
- [ ] 1.3 Startup validation: `detector: "jev"` with empty endpoint → one warning naming the degradation to `"ast"`; unknown `detector` value → warning naming the value
- [ ] 1.4 Unit tests: defaults when sections absent; explicit `stats.enabled: false` honored; unknown detector warns + `"ast"`; jev-without-endpoint warning emitted exactly once; deep-merge project-over-global for nested sections

## 2. Stats Event Writer (`src/stats.ts`, new)

- [ ] 2.1 Implement `recordDecision(event)` — serialized append queue writing one JSON line per event to `$XDG_DATA_HOME/opencode-bash-guard/stats.jsonl` (default `~/.local/share/…`); fire-and-forget with at most one warning per session on failure; verify enforcement result identical with logging broken (fault-injected unit test)
- [ ] 2.2 Implement 10 MB rotation to a single `stats.jsonl.1` generation; unit test: oversized file rotates, history preserved, new file continues
- [ ] 2.3 Enforce preview policy: no `preview` field unless `log_previews`; when on, flatten newlines and truncate to 120 chars; unit tests for both branches
- [ ] 2.4 Wire `recordDecision` into `src/enforce.ts` result paths (`allow`/`ask`/`deny`/`restructured` with `trigger` + counts) and `src/index.ts` `permission.ask`; unit test: each decision path emits exactly one event with correct `trigger` (`chain`, `segments`, `depth`, `inline-script`, `parse-error`, `redirect`)
- [ ] 2.5 Respect `stats.enabled: false`: no file creation, no writes; integration-style test running `beforeExecute` with stats disabled asserts the log path is never touched

## 3. Stats CLI (`src/cli.ts`, new + `package.json` bin)

- [ ] 3.1 Add `"bin": { "opencode-bash-guard": "dist/cli.js" }`; `npx opencode-bash-guard stats` prints the table; no subcommand prints help; verify with `npm run build && node dist/cli.js`
- [ ] 3.2 Aggregations over the JSONL: totals by decision, total processed events, per-day rejection timeline, top triggers, top rejected shapes (glob-normalized two-segment prefix), per-project breakdown; golden-file unit test over a fixture log
- [ ] 3.3 Restructure acceptance rate: `restructured` events followed within 10-event / 5-minute window by a compliant (`allow`/`ask`, per-line segments within limit) event; unit tests: compliant retry counts, unanswered rejection doesn't, zero rejections → rate reported as n/a
- [ ] 3.4 Flags: `--json` (valid JSON with same aggregates + raw filtered count), `--since <duration|date>`, `--project <name>`; unit tests per flag; empty/missing log prints empty-report message, exit 0

## 4. Jev Detector (`src/jev.ts`, new)

- [ ] 4.1 Implement client with Node built-in `fetch`: POST command text to `restructure.jev.endpoint` with `Authorization` from `JEV_API_KEY` (env wins over config key); timeout via `timeout_ms`; parse typed `{ complex: boolean, confidence: number }` — anything else is a failure
- [ ] 4.2 Integrate at the ask-resolving complexity check: `detector: "jev"` → reject with the standard guidance message only when `complex && confidence ≥ confidence_threshold` and chain resolves to `ask`; otherwise proceed to normal ask flow — unit tests (mocked fetch): reject at 0.95, borderline 0.5 passes to ask, `complex: false` passes
- [ ] 4.3 Silent fallback: fetch error, timeout, malformed body → AST decision for that command, never throws; unit tests cover all three failure shapes
- [ ] 4.4 Offline guarantee: with `detector: "ast"` and an endpoint configured, assert zero fetch calls across a full enforcement test matrix

## 5. Instruction Injection (`src/instruction.ts`, new)

- [ ] 5.1 Define the static guidance block (one command per tool call; sequences as separate calls; if rejected, split and retry — content per chain-restructuring decision 7)
- [ ] 5.2 Register `experimental.chat.system.transform` when `instruction.enabled`: append the block to `output.system`; unit tests: injected exactly once per request, repeated invocations do not accumulate, disabled/absent flag leaves output untouched
- [ ] 5.3 Independence tests: injection on + restructure off → guidance present and enforcement identical to injection-off baseline (same rejections, same messages)
- [ ] 5.4 Degrade path: hook unavailable → enforcement unchanged, single warning naming the manual AGENTS.md alternative

## 6. Documentation

- [ ] 6.1 README "Usage statistics" section: what is logged (no command text by default), file location, rotation, opt-out one-liner, `stats` CLI usage examples
- [ ] 6.2 README "Detector" section: `detector: "ast" | "jev"` example, fallback guarantee, privacy note (commands leave the machine — opt-in only), env `JEV_API_KEY`
- [ ] 6.3 README "Command style guidance" section: `instruction.enabled` example, note the AGENTS.md snippet as the manual alternative when disabled; mark version 0.2.0 in changelog/release notes

## 7. Verification

- [ ] 7.1 `npm test` — all existing tests pass unchanged (zero behavior change with the three sections absent) plus new suites green
- [ ] 7.2 `npm run build` type-checks clean; `npx opencode-bash-guard stats` runs against a fixture log end-to-end
- [ ] 7.3 Manual smoke in a scratch opencode project: enable all three sections, run a complex ask one-liner (expect rejection + `restructured` event), re-issue compliant (expect acceptance-rate > 0), confirm system prompt contains the guidance block and no stats request leaves the machine
