# Proposal

## Why

The `chain-restructuring` proposal (PR #17, merged) recorded three Future Directions explicitly kept out of v1: plugin-injected instructions, a learned Jev detector, and — added in the final review round — a plugin statistics page ("displays rejections and processed hooks"). Each is now actionable: the reviewer asked for stats visibility, Jev is fully scoped in issue #22, and OpenCode's plugin API exposes `experimental.chat.system.transform` for instruction injection. This change implements all three as one enhancement batch on top of the merged v1 behavior.

## What Changes

- **Usage statistics (opt-out, local-only)**: every enforcement decision is appended as one JSONL event (`decision`, `trigger`, `segments`, `depth`, optional redacted preview) to `~/.local/share/opencode-bash-guard/stats.jsonl`; a new `bin` entry provides `npx opencode-bash-guard stats` rendering a terminal table (`--json`, `--since`, `--project`) with totals, rejection timeline, top trigger reasons, top rejected command shapes, per-project breakdown, and the **restructure acceptance rate** (did a compliant re-issue follow a rejection?). Command text previews are off by default.
- **Optional Jev detector backend (opt-in, off by default)**: `"restructure": { "detector": "jev" }` routes complexity classification through the TypeSafe System One API (typed `{ complex, confidence }` structured output). The deterministic `"ast"` path remains the source of truth and the silent fallback on error/timeout. Gated on Jev early-access availability (tracked in #22); strictly opt-in because commands leave the machine.
- **Plugin-injected instructions (opt-in, replaces the manual AGENTS.md step)**: behind `"instruction": { "enabled": true }` in `opencode-bash-guard.jsonc`, the plugin appends the "one command per line" guidance to the system prompt via the `experimental.chat.system.transform` hook, so users no longer need the manual AGENTS.md snippet. Degrades gracefully (no-op with a warning) when the experimental hook is absent.
- **README**: new sections for all three features; the AGENTS.md snippet becomes "alternative when `instruction` is disabled".

## Capabilities

### New Capabilities
- `usage-statistics`: local JSONL decision-event logging and the `stats` CLI (aggregations, filters, restructure acceptance rate, privacy defaults)
- `jev-detector`: optional `detector: "ast" | "jev"` backend with typed classifier responses, timeout handling, and guaranteed fallback to the deterministic path
- `plugin-injected-instructions`: opt-in system-prompt guidance injection via `experimental.chat.system.transform`, replacing the manual AGENTS.md snippet

### Modified Capabilities
<!-- None: the existing chain-guard/restructure flows keep their requirement-level
     behavior. Stats logging is additive (enforcement outcomes are unchanged by
     definition — a stats failure must never alter a decision), Jev only swaps
     the detector behind the same reject-with-guidance contract, and instruction
     injection adds a new opt-in surface without changing any existing one. -->

## Impact

- **Code**: `src/enforce.ts` (emit decision events), `src/index.ts` (wire `experimental.chat.system.transform` + `permission.ask` events), new `src/stats.ts` (event writer), new `src/jev.ts` (classifier adapter), new `src/instruction.ts` (guidance injection), new `src/cli.ts` + `bin` entry in `package.json`
- **Config**: `opencode-bash-guard.jsonc` gains three sections: `stats`, `restructure.detector`, `instruction` — same discovery/deep-merge/validation rules as the existing `restructure` section
- **Dependencies**: `jsonc-parser` (already planned in #17 follow-ups) plus the Jev HTTP client (implemented with Node built-in `fetch`; no SDK dependency)
- **Privacy/systems**: stats are local-only by default; the only network surface is the explicitly opt-in Jev call. The `experimental.chat.system.transform` hook is experimental — the feature must tolerate its removal
- **Out of scope**: web dashboard, remote telemetry, retry counters/escalation (separately tracked), `permission.ask` engine reliability (anomalyco/opencode#19469)
