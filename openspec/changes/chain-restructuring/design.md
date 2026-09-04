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

   Flow in `beforeExecute`: parse → resolve chain (existing) → if action is `ask` AND `restructure.enabled` AND limits exceeded → **throw** (replaces wrap+store for that call). Otherwise existing flows verbatim.

4. **One-liner targeting: segment limit applies to single-line commands only**

   - Command contains no newline → both `max_segments` and `max_depth` checks apply.
   - Command contains a newline (multi-line script) → **exempt from the segment limit**; depth check still applies.

   Rationale: the compliant form ("multi-line, one command per line") must never violate the segment limit, otherwise the retry loop can deadlock (a 5-step task re-issued as 5 lines would still exceed `max_segments: 3` and be rejected forever). Multi-line IS the readable form the feature asks for. Deep nesting remains unreadable in any shape, so `max_depth` applies to both forms. Known edge, accepted for v1: a multi-line script with long `&&`-chains inside individual lines passes the segment check (ask still gates uncovered segments; a per-line segment check is possible future refinement).

5. **Rejection message must be actionable**

   Thrown error text (single source of truth, exported constant):

   ```
   [opencode-bash-guard] Complex one-liner rejected (4 chained commands, nesting depth 2).
   Re-issue as separate bash tool calls, or as a multi-line script with one command
   per line — each command is then permission-checked individually.
   ```

   The message contains the actual counts (so the model can self-correct) and both compliant forms. Throwing means the command never executes and no permission dialog appears — the model retries on its own.

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

   No attempt counter in v1. A compliant re-issue always exists (multi-line), so the loop terminates on compliance; the model can also give up or ask the user. Counters/escalation deferred until observed to be a problem.

## Risks / Trade-offs

- **[Retry loops burn tokens]** Mitigated structurally: a compliant multi-line form never violates `max_segments`, so the loop cannot deadlock. Depth-gated rejections may still retry; the message carries exact counts.
- **[False positives on legitimate pipelines]** `cat a | grep b | wc -l` (3 segments) passes defaults; a single-line 4-stage pipeline gets rejected. Mitigation: thresholds are user-configurable in the JSONC file; document raising `max_segments`.
- **[Throw suppresses the dialog for rejected ask-chains]** Intended: the model retries first; the human then reviews a readable form. Users who prefer to review the raw blob can disable the feature.
- **[JSONC dependency + two-location merge]** Adds `jsonc-parser`; merge precedence (project over global) must be documented to avoid confusion. Invalid files fail safe (feature off, warning).
- **[Config read once at startup]** Same limitation as the existing `config` hook; restart to apply.
- **[Multi-line scripts with per-line chains pass the segment check]** Accepted edge for v1 (see decision 4); ask still gates uncovered segments; per-line refinement possible later.
- **[Related but separate: `permission.ask` may never fire in current opencode]** Issue anomalyco/opencode#19469 suggests the deny path of this plugin may not hard-block. Out of scope here; needs its own verification and possibly a fix change.
