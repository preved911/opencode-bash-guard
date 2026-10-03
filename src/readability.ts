import { parseCommandPerLine, detectInlineScript } from "./parser.js";
import type { ParsedCommand } from "./parser.js";
import type { RestructureConfig } from "./plugin-config.js";

/**
 * Readability constraint: an optional, ask-only post-evaluation step.
 *
 * Applied after parsing and policy evaluation identify an ask result. Consumes
 * normalized invocation data plus command-wide depth and per-line information.
 * Never grants permissions and never touches allow, deny, no-opinion, or
 * parse-error flows.
 */

export type ComplexityViolationKind = "segments" | "depth" | "inline-script";

export interface ComplexityViolation {
  kind: ComplexityViolationKind;
  segmentCount?: number;
  worstLine?: number;
  interpreter?: string;
  statementCount?: number;
}

/**
 * Strictly-greater threshold semantics: a metric equal to its limit passes.
 * Segment limit applies per line (single-line = one line); depth applies to the
 * whole command in every shape; inline-script statement count applies per script.
 */
export function checkComplexity(command: string, chain: ParsedCommand, restructure: RestructureConfig): ComplexityViolation | null {
  if (!restructure.enabled) return null;

  let worstInline: { interpreter: string; statementCount: number } | null = null;
  for (const seg of chain.invocations) {
    const info = detectInlineScript(seg);
    if (info && info.statementCount > restructure.maxSegments) {
      if (!worstInline || info.statementCount > worstInline.statementCount) {
        worstInline = info;
      }
    }
  }
  if (worstInline) {
    return { kind: "inline-script", interpreter: worstInline.interpreter, statementCount: worstInline.statementCount };
  }

  const multiLine = command.includes("\n");
  if (multiLine) {
    const perLine = parseCommandPerLine(command);
    if (perLine.worstLine && perLine.worstLine.segmentCount > restructure.maxSegments) {
      return {
        kind: "segments",
        segmentCount: perLine.worstLine.segmentCount,
        worstLine: perLine.worstLine.lineNumber,
      };
    }
  } else if (chain.invocations.length > restructure.maxSegments) {
    return { kind: "segments", segmentCount: chain.invocations.length };
  }

  if (chain.maxDepth > restructure.maxDepth) {
    return { kind: "depth" };
  }

  return null;
}

export function buildRejectionMessage(violation: ComplexityViolation, chain: ParsedCommand, command: string): string {
  if (violation.kind === "inline-script") {
    return (
      `[opencode-bash-guard] Complex inline script rejected (${violation.interpreter}: ${violation.statementCount} statements).\n` +
      "Re-issue with one statement per line inside the quoted script, as separate bash tool calls, or move the script to a file — each statement/command is then readable and permission-checked individually."
    );
  }

  const depth = chain.maxDepth;
  if (command.includes("\n")) {
    return (
      `[opencode-bash-guard] Complex command rejected (line ${violation.worstLine}: ${violation.segmentCount} chained commands, nesting depth ${depth}).\n` +
      "Re-issue as separate bash tool calls, or as a multi-line script with one command per line — each command is then permission-checked individually."
    );
  }

  return (
    `[opencode-bash-guard] Complex one-liner rejected (${violation.segmentCount} chained commands, nesting depth ${depth}).\n` +
    "Re-issue as separate bash tool calls, or as a multi-line script with one command per line — each command is then permission-checked individually."
  );
}
