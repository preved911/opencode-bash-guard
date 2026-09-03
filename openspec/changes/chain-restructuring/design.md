## Context

The current implementation lets fully-allowed chains pass without interruption (`resolveChain` returns `allow` when every segment matches an allow rule; enforced by test "all segments allowed — chain let through"). The README and the base design's Goals bullet still claim "multi-segment chains trigger ask (defense-in-depth)" — that was dropped during implementation as too noisy (every `cd x && y` would prompt). Result: a fully-allowed messy one-liner runs with zero human visibility.

Prompt-level fixes (AGENTS.md instructions like "one command per tool call") are soft: probabilistic adherence, no verification, degradation in long sessions. They reduce frequency but cannot guarantee reviewability.

API facts verified against `@opencode-ai/plugin@1.18.6` types and the opencode monorepo source:

- `permission.ask` output is `{ status: "ask" | "deny" | "allow" }` only — no reason/message field exists, so "deny with explanation" is impossible through that hook.
- Per repo search and issue anomalyco/opencode#19469, the `permission.ask` hook is not actually triggered by the permission engine in current opencode source — a separate reliability concern for this plugin's deny path, out of scope here but recorded.
- **`tool.execute.before` can block with a message by throwing** — thrown errors become tool results with `resultType: "error"`, and the error text reaches the model (`packages/core/src/session/runner/to-llm-message.ts:55-67`; official docs example: `throw new Error("Do not read .env files")`).

## Goals / Non-Goals

**Goals:**
- Deterministically reject unreadable one-liners with an error message that teaches the model the compliant form
- Keep the plugin's verification guarantee intact after restructuring: multi-line re-issues are parsed per line (newlines are already segment separators) and each line is checked individually
- Opt-in config with zero behavior change when absent
- Fix the stale README claim about defense-in-depth asks

**Non-Goals:**
- Not enforcing AGENTS.md instructions — the plugin cannot and should not verify prompt compliance
- Not restructuring `ask`/`deny` flows in v1 (deny = "don't do this at all"; ask already shows the command to a human)
- Not adding length-based or token-based metrics — segment count and nesting depth cover the unreadable-mess cases
- Not adding retry counters or rate limits for repeated violations

## Decisions

1. **Config shape: `permission.bash_restructure`**

   ```json
   {
     "permission": {
       "bash_restructure": {
         "max_segments": 3,
         "max_depth": 2
       }
     }
   }
   ```

   Presence enables the feature; absence (or explicit `false`) keeps current behavior. Missing fields fall back to defaults (`max_segments: 3`, `max_depth: 2`). Non-positive or non-numeric values are dropped with a warning, matching the existing parser policy. Rejection fires when a metric **exceeds** its threshold (`git status && git log` = 2 segments passes a default config; 4+ segments is rejected).

2. **Metrics: segment count + max substitution nesting depth**

   Segment count already exists (`parseChain`). Nesting depth must be newly exposed: `chain.ts` already walks the AST recursively into `$()`/backticks and meta-command string args — extend it to report the maximum depth reached. Meta-commands (`eval`, `sh -c`, `bash -c`, `zsh -c`) already count their parsed bodies as segments. Depth catches single-command obfuscation (`echo $(echo $(...))`) that segment count misses.

3. **Enforcement point: after chain resolution, only for silent-pass outcomes**

   `beforeExecute` flow becomes: parse → resolve chain (existing) → **if action is `null` or `allow` and complexity exceeds limits → throw**. Rationale:
   - `deny`: the message "you may not run this" is correct — restructuring won't help, and wrapping/deny semantics stay intact.
   - `ask`: the human already sees the command and decides; injecting a rejection adds a retry loop without a safety gain (v1 scope note: extending restructuring to `ask` is a possible future option).
   - `null`/`allow`: the command would run without any human review — exactly where an unreadable one-liner is most dangerous and where restructuring adds the most value.
   - Parse errors: existing fail-closed deny happens before resolution and is unaffected.

4. **Rejection message must be actionable**

   Thrown error text (single source of truth, exported constant):

   ```
   [opencode-bash-guard] Complex one-liner rejected (4 chained commands, nesting depth 2).
   Re-issue as separate bash tool calls, or as a multi-line script with one command
   per line — each command is then permission-checked individually.
   ```

   The message contains the actual counts (so the model can self-correct) and both compliant forms. Throwing means the command never executes and no permission dialog appears — the model retries on its own.

5. **Restructured output is still fully verified**

   A multi-line re-issue is parsed by the existing `parseChain` into per-line segments; a separate-calls re-issue produces single-segment commands. Both paths run through the normal permission evaluation. The steering loop therefore cannot create a bypass — it only changes formatting.

6. **README correction + AGENTS.md snippet**

   - Remove/correct the "multi-segment chains trigger ask (defense-in-depth)" claims in README (and the example table row `git status && git log → ask`) to match implemented behavior: fully-allowed chains pass through.
   - Add a "Readable commands" section documenting `bash_restructure` and a recommended AGENTS.md snippet (soft layer that reduces rejection frequency):

     ```markdown
     ## Bash command style
     - Issue one command per tool call. For sequences, use separate bash calls.
     - Never write chained one-liners (`a && b && c`). If rejected, split and retry.
     ```

7. **Repeated violations: same rejection every time**

   No attempt counter in v1. A model that keeps exceeding thresholds gets the same error; it either complies, gives up, or asks the user. Counter/escalation logic is future work if observed to be a problem.

## Risks / Trade-offs

- **[Retry loops burn tokens]** A stubborn model may retry complex commands repeatedly. Mitigation: actionable message with exact counts; thresholds generous by default; counters deferred until observed.
- **[False positives on legitimate pipelines]** `cat a | grep b | wc -l` (3 segments) passes defaults; 4-stage pipelines get rejected. Mitigation: thresholds are user-configurable; document raising `max_segments` for pipeline-heavy workflows.
- **[Throw bypasses permission dialogs for rejected commands]** Intended: nothing executes, so nothing needs permission. But a user expecting a dialog sees only a tool error — documented in README.
- **[Depth exposure requires chain.ts changes]** Recursive walk already exists; the change is additive (return max depth). Low risk, covered by tests.
- **[Related but separate: `permission.ask` may never fire in current opencode]** Issue anomalyco/opencode#19469 suggests the deny path of this plugin may not hard-block. Out of scope here; needs its own verification and possibly a fix change.
