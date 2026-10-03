# Design

## Context

`main` already enforces a readability reject for ask-resolving multi-segment chains (`isComplexChain` / `readabilityReject` in `src/enforce.ts`, from #15), and the merged `chain-restructuring` proposal refines it into configurable thresholds (`max_segments`, `max_depth`, inline-script statement counts) behind `opencode-bash-guard.jsonc`. That config loader (`src/plugin-config.ts`) is specified but **not yet implemented** — this change extends its schema and assumes its tasks land first (or in the same apply run; task 1 handles both).

Three review-recorded Future Directions are now implemented here: usage statistics (asked for in the #17 stats thread), the Jev detector (fully scoped in #22), and plugin-injected instructions (verified possible via `experimental.chat.system.transform` in #17). Enforcement hook surfaces available for wiring: `tool.execute.before` (every bash call), `permission.ask`, `config` (startup), `experimental.chat.system.transform` (per LLM request).

## Goals / Non-Goals

**Goals:**
- Observability: every enforcement decision becomes a queryable local event; a CLI answers "what did the plugin do and did restructuring work?"
- Quality: borderline-complexity commands can be classified by a learned backend without weakening the deterministic guarantee
- Ergonomics: the "one command per line" guidance ships with the plugin — no manual AGENTS.md edit
- All three features fail safe: none can alter an enforcement outcome or break the plugin when unavailable

**Non-Goals:**
- No remote/network telemetry — stats never leave the machine; the only outbound call is the explicitly configured Jev endpoint
- No web dashboard or in-opencode UI (terminal CLI first)
- No retry counters / escalation (separately deferred in #17)
- No `permission.ask` engine-reliability work (anomalyco/opencode#19469)
- No per-language inline-script parsers (Jev may cover that gap later, not in this change)

## Decisions

1. **Stats: append-only JSONL, fire-and-forget, at the decision choke point**

   `recordDecision()` is called from the single place enforcement outcomes are produced (`beforeExecute` result paths + `handlePermissionAsk`). Events append to `$XDG_DATA_HOME/opencode-bash-guard/stats.jsonl` (default `~/.local/share/…`) via a serialized write queue; rotation at 10 MB → `stats.jsonl.1` (one generation). **A write failure is swallowed after one console.warn per session — the enforcement result is returned identically whether logging works or not.**

   *Alternatives:* SQLite (heavier, not human-inspectable), opencode storage API (no verified plugin storage surface), in-memory only (loses the acceptance-rate history that motivates the feature).

   Event schema (one JSON object per line):

   ```json
   { "ts": 1727720000000, "project": "repo-basename", "decision": "restructured", "trigger": "segments", "segments": 5, "depth": 1, "preview": "git status && …" }
   ```

   - `decision`: `allow` | `ask` | `deny` | `restructured` — `restructured` marks a rejection that steered to re-issue (the #15/#17 reject path); `ask`/`deny` include the readability-wrap path
   - `trigger`: `chain` | `segments` | `depth` | `inline-script` | `parse-error` | `redirect`
   - `segments` / `depth`: the counts that drove the decision (0 where not applicable)
   - `preview`: **omitted unless `stats.log_previews` is true**; when on, flattened to one line and truncated to 120 chars

2. **Stats on by default, previews off by default**

   `stats.enabled` defaults to **true**. Rationale: the data is local-only, counts are innocuous, the file is small and rotatable, and a security guard that cannot show its own work is harder to audit — stats double as an accountability record of what was blocked. One-line opt-out (`"stats": { "enabled": false }`). Previews (raw command text, may contain secrets) are strictly opt-in. *Alternative considered:* opt-in logging — rejected as friction: the acceptance-rate metric the reviewer asked for only materializes with passive data.

3. **Stats CLI: zero-dependency Node bin**

   `package.json` gains `"bin": { "opencode-bash-guard": "dist/cli.js" }` → `npx opencode-bash-guard stats`. Aggregation in plain Node over the JSONL: totals by decision, processed-hook count (all events), rejection timeline (per-day buckets), top triggers, top rejected shapes (`command` word-prefix of the first two segments, glob-normalized), per-project breakdown, and **restructure acceptance rate**: fraction of `restructured` events followed within a 10-event / 5-minute window by a compliant event (decision `allow`/`ask` with per-line `segments ≤ 3`). The window heuristic is documented as an approximation — hook inputs do not reliably expose a session ID to correlate exactly. Flags: `--json` (machine shape), `--since <duration|date>`, `--project <name>`. No subcommand → help. **No `--reset`; deleting the file is the reset** (documented).

4. **Jev: config-selected detector with silent AST fallback**

   `restructure.detector: "ast" | "jev"` (default `"ast"`; unknown values warn + `"ast"`). With `"jev"`, complexity classification for an ask-resolving chain is delegated to the TypeSafe endpoint (issue #22 contract: unstructured command in → typed `{ complex: boolean, confidence: number }` out):

   - `complex === true && confidence ≥ restructure.jev.confidence_threshold` (default `0.8`) → reject with the same actionable guidance message (identical contract to AST rejection)
   - otherwise (`!complex` or low confidence) → **no rejection**; the command proceeds to the normal human `ask` dialog
   - any error, timeout (`restructure.jev.timeout_ms`, default `1500` — Jev is 70–500 ms), malformed response, or unconfigured endpoint → **silent fallback to the AST decision**; never throws to the user

   Endpoint via `restructure.jev.endpoint` (no default — the feature is gated on Jev early access); API key from env `JEV_API_KEY`, falling back to `restructure.jev.api_key`. Client is Node built-in `fetch` — no SDK dependency. `detector: "ast"` issues **zero network requests** (spec-enforced).

   *Alternatives:* jev-as-second-opinion (AND/OR combine with AST) — rejected for v1: two sources of truth make rejection behavior unexplainable; a single selected detector with a deterministic fallback keeps the guarantee auditable.

5. **Instruction injection: opt-in system-prompt append via `experimental.chat.system.transform`**

   `instruction.enabled` (default **false**) registers the experimental hook appending one static guidance block (the AGENTS.md snippet content from #17 decision 7: one command per tool call; sequences as separate calls; if rejected, split and retry) to `output.system`. OpenCode rebuilds `output.system` per request (#17 research), so appending per call cannot accumulate. The hook is declared statically; if a future opencode drops it, unknown hooks are ignored and enforcement is untouched — config validation warns that injection requires the experimental hook. Injection is independent of `restructure.enabled`: it is the soft layer that reduces rejection frequency, not a precondition of it. README repositions the AGENTS.md snippet as the manual alternative when `instruction` is off.

   *Alternatives:* injecting into `tool.execute.before` error text only (already happens on rejection — but no proactive guidance), shipping a command file (requires repo-level files per project — worse ergonomics than one global flag).

6. **Config schema additions (same loader, same rules)**

   ```jsonc
   {
     "restructure": {
       "enabled": false,
       "detector": "ast",              // "ast" | "jev", unknown → warn + "ast"
       "jev": {
         "endpoint": "",               // no default — gates the feature on setup
         "timeout_ms": 1500,
         "confidence_threshold": 0.8,
         "api_key": ""                 // env JEV_API_KEY wins over this
       }
     },
     "stats": {
       "enabled": true,                // local-only; set false to opt out
       "log_previews": false           // raw command text — opt-in
     },
     "instruction": {
       "enabled": false                // experimental.chat.system.transform append
     }
   }
   ```

   Validation follows the chain-restructuring loader rules: unknown fields warn, invalid values drop to defaults, invalid JSONC disables the plugin's tuned features (never expands enforcement).

## Risks / Trade-offs

- **[Stats write on every bash call → I/O amplification in hot loops]** → serialized async queue, 10 MB rotation, fire-and-forget with swallowed errors; measured overhead is one append per tool call (bash calls are seconds apart by nature).
- **[Local stats file surprises users]** → default records counts/shapes only, previews opt-in, location documented in README next to the opt-out flag.
- **[Jev latency lands on the enforcement path]** → hard 1500 ms timeout with silent AST fallback; rejection quality degrades to exactly the pre-Jev behavior, never worse.
- **[Jev sends commands off-machine]** → strictly opt-in (`detector: "jev"` + endpoint), README privacy note is a spec scenario, AST path provably network-free.
- **[Acceptance-rate heuristic miscounts]** → documented window approximation; `--json` exposes raw events for exact analysis.
- **[`experimental.chat.system.transform` may change or vanish]** → graceful no-op + warning; the deterministic rejection path never depends on it (same posture as #17).
- **[Dependency on unimplemented plugin-config loader]** → task 1 implements the loader if absent, or extends it if chain-restructuring lands first; either way the schema above is the contract.

## Migration Plan

Additive config; no data migration. Deploy: release as 0.2.0 (minor — new features, no behavior change to existing flags). Rollback: remove the three config sections (all default to inert/off) or downgrade. Stats files can be deleted at any time without affecting enforcement.

## Open Questions

- Exact TypeSafe Jev request/response wire format (issue #22 gates on early access) — the adapter isolates this behind one client function; contract per #22 (`{ complex, confidence }`) until the stable API lands.
