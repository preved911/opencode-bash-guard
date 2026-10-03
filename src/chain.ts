/**
 * Compatibility shim over the parser boundary (`src/parser.ts`).
 *
 * The parser boundary produces normalized invocations; this module re-exports
 * the legacy segment-shaped API so existing call sites keep working during the
 * staged extraction. Superseded re-exports are removed in the cleanup stage
 * (task 5.1) once all consumers use the new boundary.
 */

export type { RedirectInfo, NormalizedInvocation, ParsedCommand, LineSegmentInfo, PerLineResult, InlineScriptInfo } from "./parser.js";
export { stripQuotePairs, extractArgv, countScriptStatements, detectInlineScript } from "./parser.js";

import { parseCommand, parseCommandPerLine } from "./parser.js";
import type { NormalizedInvocation, ParsedCommand, PerLineResult } from "./parser.js";

/** Legacy alias: a normalized invocation. */
export type ChainSegment = NormalizedInvocation;

/** Legacy alias: a parsed command. */
export type ChainResult = ParsedCommand;

export function parseChain(command: string): ChainResult {
  return parseCommand(command);
}

export function parseChainPerLine(command: string): PerLineResult {
  return parseCommandPerLine(command);
}
