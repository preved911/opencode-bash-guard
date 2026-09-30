## Context

The current implementation lets fully-allowed chains pass without interruption (`resolveChain` returns `allow` when every segment matches an allow rule; enforced by test "all segments allowed — chain let through"). Not-allowed multi-step commands surface to the human as an unreadable one-liner in the permission dialog. The README and the base design's Goals bullet still claim "multi-segment chains trigger ask (defense-in-depth)" — stale relative to implementation; to be corrected in docs.

Prompt-level fixes (AGENTS.md instructions like "one command per tool call") are soft: probabilistic adherence, no verification, degradation in long sessions. They reduce frequency but cannot guarantee reviewability.

**Review decision (recorded):** restructuring applies only to commands that are *not allowed* — the aim is human readability of commands a person must review. Allowed chains pass untouched.

API facts verified against `@opencode-ai/plugin@1.18.6` types and the opencode monorepo source:

- `permission.ask` output is `{ status: "ask" | "deny" | "allow" }` only — no reason/message field exists, so "deny with explanation" is impossible through that hook.
- Per repo search and issue anomalyco/opencode#19469, the `permission.ask` hook is not actually triggered by the permission engine in current opencode source — a separate reliability concern for this plugin's deny path, out of scope here but recorded.
- **`tool.execute.before` can block with a message by throwing** — thrown errors become tool results with `resultType: "error"`, and the error text reaches the model (`packages/core/src/session/runner/to-llm-message.ts:55-67`; official docs example: `throw new Error("Do not read .env files")`).

## Goals / Non-Goals

**Goals:**
- Deterministically reject unreadable one-liners that would otherwise go to human review as blobs, with an error message that teaches the model the compliant form
- Keep allowed commands untouched — zero friction on the allow path
- Keep the plugin's verification guarantee intact after restructuring: multi-line re-issues are parsed per line (newlines are already segment separators) and each line is checked individually
- Plugin tuning in a dedicated JSONC file, disabled by default
- Fix the stale README claim about defense-in-depth asks

**Non-Goals:**
- Not enforcing AGENTS.md instructions — the plugin cannot and should not verify prompt compliance
- Not restructuring `allow` or `deny` flows (allowed = allowed; deny = forbidden regardless of format)
- Not adding length-based or token-based metrics — segment count and nesting depth cover the unreadable-mess cases
- Not adding retry counters or rate limits for repeated violations
- Not hot-reloading the config file — changes require an opencode restart (same as the existing config hook)
- **No learned/external classifier (Jev) in v1** — detection stays deterministic; the TypeSafe Jev backend is deferred and tracked in #22

## Decisions

1. **Separate config file: `opencode-bash-guard.jsonc` in the opencode config dirs**

   Locations, in increasing precedence:
   - Global: `~/.config/opencode/opencode-bash-guard.jsonc` (or `$XDG_CONFIG_HOME/opencode/…`)
   - Project: `<project>/.opencode/opencode-bash-guard.jsonc`

   Files are JSONC (comments, trailing commas) parsed with `jsonc-parser`. Objects deep-merge, project wins over global; scalars override. Missing file at a location is not an error. **Invalid JSONC → warning + `restructure` treated as disabled; the plugin's core chain-guard behavior is unaffected** (config failure must not brick or expand enforcement).

   Rationale: this revises the original "no custom config files" stance for *plugin-internal tuning* only. The split is principled: **what** is allowed/asked/denied stays in `opencode.json` `permission`; **how the plugin behaves** (thresholds, feature switches) lives in the plugin's own file, where comments can document the trade-offs. File reads happen once at plugin init (`input.directory` gives the project root); changes require a restart.

2. **Schema: `restructure` with nested fields, disabled by default**

   ```jsonc
   {
     // Reject complex one-liners and ask the agent to restructure them
     "restructure": {
       "enabled": false,     // default false — zero behavior change
       "max_segments": 3,    // max commands in a single-line chain
       "max_depth": 2        // max $()/backtick/meta-command nesting
     }
   }
   ```

   - `enabled: false` (default) or missing `restructure` section → feature off, no behavior change.
   - `max_segments` / `max_depth` must be positive integers; invalid values are dropped with a warning and the default applies. Missing fields fall back to defaults.

3. **Scope: ask-resolving chains only**

   Rejection fires when the chain resolves to `ask` AND limits are exceeded. Rationale (review decision): allowed actions should be allowed; the aim is readable human review of not-allowed multi-step commands. Consequences:
   - `allow` → untouched, always.
   - `deny` → existing deny flow (wrap + stored deny). Restructuring a forbidden action is meaningless — the format is not the problem.
   - Parse errors → existing fail-closed deny, unaffected.
   - `null` (no plugin opinion) → untouched. Under the documented prerequisite (`"*": "ask"`), every uncovered segment matches the catch-all, so any chain that would reach a human resolves to `ask` — "not allowed" ⇔ `ask` in practice. Without the catch-all the plugin has no opinion and does not intervene.
   - **Default permission settings are verified and accounted for by the existing self-disable logic** (`parseConfig` in `src/config.ts`). OpenCode's documented defaults are permissive: when no permission settings exist, **`bash` defaults to `"allow"`** — commands run without any prompt (only `external_directory` and `doom_loop` default to `"ask"`; [Permissions → Defaults](https://opencode.ai/docs/permissions/#defaults)). In that default state the plugin disables itself entirely (`enabled = false` when `permission.bash` is absent, a flat `"allow"`, or object `"*": "allow"`) — so out of the box the native behavior is allow-all and neither the chain guard nor `restructure` runs: the plugin never inserts prompts into the permissive default experience. `restructure` can therefore only fire when the user explicitly configured bash permission rules, and the `"*": "ask"` catch-all (documented prerequisite) is exactly the configuration where "not allowed ⇔ ask" holds.

   Flow in `beforeExecute`: parse → resolve chain (existing) → if action is `ask` AND `restructure.enabled` AND limits exceeded → **throw** (replaces wrap+store for that call). Otherwise existing flows verbatim.

4. **Segment limit applies per line, to every command shape**

   - Command contains no newline → the whole command is one line: both `max_segments` and `max_depth` checks apply.
   - Command contains a newline (multi-line script) → **each line is checked against `max_segments` individually**; `max_depth` still applies to the whole command.

   Review decision (recorded): multi-line is NOT a blanket exemption. A "multi-line" script whose lines are long `&&`/`||` chains is exactly as unreadable as a one-liner, and chains re-wrapped across a few lines are a frequent real shape — the segment limit must see them. Checking per line keeps the retry loop deadlock-free: the compliant form (one command per line) has every line at 1 segment, so a compliant re-issue always exists, while a 2-line script of 10-segment chains is rejected with the same guidance. For multi-line commands the rejection message names the worst offending line (line number + its segment count) so the model can fix that line.

5. **Rejection message must be actionable**

   Thrown error text (single source of truth, exported message builder):

   ```
   [opencode-bash-guard] Complex one-liner rejected (4 chained commands, nesting depth 2).
   Re-issue as separate bash tool calls, or as a multi-line script with one command
   per line — each command is then permission-checked individually.
   ```

   For a multi-line command the message names the worst offending line instead of the total:

   ```
   [opencode-bash-guard] Complex command rejected (line 2: 5 chained commands, nesting depth 2).
   Re-issue as separate bash tool calls, or as a multi-line script with one command
   per line — each command is then permission-checked individually.
   ```

   For an over-threshold interpreter inline script the guidance is interpreter-specific:

   ```
   [opencode-bash-guard] Complex inline script rejected (node -e: 9 statements).
   Re-issue with one statement per line inside the quoted script, as separate bash
   tool calls, or move the script to a file — each statement/command is then
   readable and permission-checked individually.
   ```

   The message contains the actual counts (so the model can self-correct) and the compliant forms. Throwing means the command never executes and no permission dialog appears — the model retries on its own.

6. **Restructured output is still fully verified**

   A multi-line re-issue is parsed by the existing `parseChain` into per-line segments; a separate-calls re-issue produces single-segment commands. Both paths run through the normal permission evaluation. The steering loop therefore cannot create a bypass — it only changes formatting.

7. **README correction + AGENTS.md snippet**

   - Remove/correct the "multi-segment chains trigger ask (defense-in-depth)" claims in README (and the example table row `git status && git log → ask`) to match implemented behavior: fully-allowed chains pass through.
   - New "Readable commands" section: `opencode-bash-guard.jsonc` example, threshold semantics, and a recommended AGENTS.md snippet (soft layer that reduces rejection frequency):

     ```markdown
     ## Bash command style
     - Issue one command per tool call. For sequences, use separate bash calls.
     - Never write chained one-liners (`a && b && c`). If rejected, split and retry.
     ```

8. **Repeated violations: same rejection every time**

   No attempt counter in v1. A compliant re-issue always exists (multi-line, one command per line), so the loop terminates on compliance; the model can also give up or ask the user. Counters/escalation deferred until observed to be a problem.

9. **Interpreter inline scripts are complexity-checked too**

   `python`/`python3 -c`, `perl -e`, `node -e`/`--eval`, `ruby -e`, `php -r`, and heredoc-scripted interpreters carry whole programs inside a single shell segment — a 40-statement `node -e` one-liner looks like one benign segment to shell-level metrics, so the segment/depth checks never see it. When `restructure` is enabled, the plugin adds an inline-script metric: **statement count inside the script string** (split on `;` and newlines — a deliberate crude heuristic; no per-language parsers in v1), compared against the same `max_segments` threshold. An over-threshold inline script on an ask-resolving chain is rejected with interpreter-specific guidance (see decision 5): re-issue with one statement per line inside the quoted script — `python -c`, `node -e`, and `perl -e` all accept multi-line script strings — or move the script to a file. This keeps the check deterministic and dependency-free; per-language AST parsing is out of scope for v1.

## Future Directions (discussed in review, not in v1 scope)

- **Plugin-injected instructions (no manual AGENTS.md step) — possible today, kept out of v1.** OpenCode's plugin API exposes the experimental hook `"experimental.chat.system.transform"`: `(input: { sessionID?: string; model: Model }, output: { system: string[] }) => Promise<void>` ([source](https://github.com/anomalyco/opencode/blob/7945de208964a49300d7f770d1a71d078db9a4c4/packages/plugin/src/index.ts#L291-L296)). OpenCode calls it on every LLM request after assembling the base system prompt ([source](https://github.com/anomalyco/opencode/blob/7945de208964a49300d7f770d1a71d078db9a4c4/packages/opencode/src/session/llm/request.ts#L70-L76)), so a plugin can append guidance by mutating `output.system`. This would let `opencode-bash-guard` ship its "one command per line" guidance itself, with no user AGENTS.md step. It is experimental and only reduces rejection frequency; the deterministic rejection path does not depend on it. Real-world precedent: `@qforge/opencode-agents-explorer` is a plugin that auto-injects folder-level `AGENTS.md` files via hooks. For v1 we keep the manual `AGENTS.md` snippet; auto-injection can be added later behind an opt-in plugin flag.
- **Learned complexity/risk classification (TypeSafe "Jev") — decided: NOT in v1.** The AST-threshold approach (`max_segments`, `max_depth`, statement counts) is deterministic but brittle at the margins — "is this command readable?" is a fuzzy judgment that hand-written thresholds approximate. A System One-style structured-output classifier (typesafe.ai Jev: typed decisions with calibrated probabilities, fast and cheap, schema outputs that cannot hallucinate types) could score commands where thresholds disagree with intuition. Explicitly deferred: v1 ships the deterministic detector only, with no external dependency, no privacy surface, and no availability coupling on a security path. When pursued, it is an optional, off-by-default detector backend (`"detector": "ast" | "jev"`): the deterministic path stays the source of truth and the fallback when the service is unavailable; the privacy implication of commands leaving the machine must be documented; adoption gated on early-access availability. Full design + tasks tracked in **#22**.

## Risks / Trade-offs

- **[Retry loops burn tokens]** Mitigated structurally: a compliant one-command-per-line form has 1 segment per line and cannot violate `max_segments`, so the loop cannot deadlock. Depth- and inline-script-gated rejections may still retry; the message carries exact counts.
- **[False positives on legitimate pipelines]** `cat a | grep b | wc -l` (3 segments) passes defaults; a single-line 4-stage pipeline gets rejected. Mitigation: thresholds are user-configurable in the JSONC file; document raising `max_segments`.
- **[Throw suppresses the dialog for rejected ask-chains]** Intended: the model retries first; the human then reviews a readable form. Users who prefer to review the raw blob can disable the feature.
- **[JSONC dependency + two-location merge]** Adds `jsonc-parser`; merge precedence (project over global) must be documented to avoid confusion. Invalid files fail safe (feature off, warning).
- **[Config read once at startup]** Same limitation as the existing `config` hook; restart to apply.
- **[Inline-script statement counting is heuristic]** Splitting on `;`/newlines can miscount strings containing semicolons or multi-statement lines; the metric errs toward rejection of unreadable blobs, the guidance offers the compliant form, and per-language parsing is a possible refinement.
- **[Related but separate: `permission.ask` may never fire in current opencode]** Issue anomalyco/opencode#19469 suggests the deny path of this plugin may not hard-block. Out of scope here; needs its own verification and possibly a fix change.
