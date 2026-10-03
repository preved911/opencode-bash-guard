import type { PluginConfig } from "./config.js";
import { matchBashPermission, matchExternalDirectory, matchToolPermissions } from "./config.js";
import { parseCommand, parseCommandPerLine, detectInlineScript } from "./parser.js";
import type { NormalizedInvocation, ParsedCommand, RedirectInfo } from "./parser.js";
import type { RestructureConfig } from "./plugin-config.js";
import { resolveCandidatePaths } from "./paths.js";
import path from "path";

export type ChainAction = "allow" | "ask" | "deny" | null;

export interface StoredDecision {
  action: ChainAction;
}

const decisionStore = new Map<string, StoredDecision>();

export function getStoredDecision(callID: string): StoredDecision | undefined {
  return decisionStore.get(callID);
}

export function clearStoredDecision(callID: string): void {
  decisionStore.delete(callID);
}

function resolveRedirectTargets(redirects: RedirectInfo[], cwd: string, config: PluginConfig): ChainAction {
  const actions: ChainAction[] = [];

  for (const redir of redirects) {
    if (redir.wellKnown) continue;

    const resolvedPath = path.resolve(cwd, redir.target);
    const underCwd = resolvedPath.startsWith(cwd + path.sep) || resolvedPath === cwd;

    const editAction = matchBashPermission(resolvedPath, config.editRules);
    if (editAction) actions.push(editAction);

    if (!underCwd) {
      const edResult = matchExternalDirectory(resolvedPath, config.externalDirectoryRules, config.externalDirectoryDefault, cwd);
      if (edResult.violated && edResult.action) {
        actions.push(edResult.action);
      }
    }
  }

  if (actions.length === 0) return null;
  if (actions.includes("deny")) return "deny";
  if (actions.includes("ask")) return "ask";
  if (actions.includes("allow")) return "allow";
  return null;
}

function combineActions(a: ChainAction, b: ChainAction): ChainAction {
  const actions = [a, b].filter((x): x is NonNullable<ChainAction> => x !== null);
  if (actions.length === 0) return null;
  if (actions.includes("deny")) return "deny";
  if (actions.includes("ask")) return "ask";
  if (actions.includes("allow")) return "allow";
  return null;
}

export interface SegmentResolution {
  action: ChainAction;
  /** True when the action came from a matched args rule (used to enforce args-level force-allow). */
  allowFromArgsRule: boolean;
}

export function resolveSegment(invocation: NormalizedInvocation, cwd: string, config: PluginConfig): SegmentResolution {
  const tokens = invocation.argv;

  // Scoped ask (invalid/unmigrated args config for this executable) overrides everything.
  if (config.forcedAskTools?.includes(tokens[0])) {
    return { action: "ask", allowFromArgsRule: false };
  }

  // Pipeline order (spec): args rules decide the segment when any matcher matched; otherwise the legacy glob evaluation.
  const argsAction = matchToolPermissions(tokens, config.toolPermissions);
  if (argsAction !== null) {
    return { action: argsAction, allowFromArgsRule: argsAction === "allow" };
  }

  const bashAction = matchBashPermission(invocation.command, config.bashRules);

  const paths = resolveCandidatePaths(invocation, cwd);
  let edAction: "ask" | "allow" | "deny" | null = null;

  for (const p of paths) {
    const result = matchExternalDirectory(p.resolved, config.externalDirectoryRules, config.externalDirectoryDefault, cwd);
    if (result.violated && result.action) {
      if (result.action === "deny" || edAction !== "deny") {
        edAction = result.action;
      }
    }
  }

  let combined = combineActions(bashAction, edAction);

  if (invocation.redirects.length > 0) {
    const redirectAction = resolveRedirectTargets(invocation.redirects, cwd, config);
    combined = combineActions(combined, redirectAction);
  }

  return { action: combined, allowFromArgsRule: false };
}

export interface ChainResolution {
  action: ChainAction;
  /** At least one segment's allow originated from an args rule (not a glob rule). */
  allowFromArgsRule: boolean;
}

export function resolveChain(invocations: NormalizedInvocation[], cwd: string, config: PluginConfig): ChainResolution {
  const segmentActions: ChainAction[] = [];
  let allowFromArgsRule = false;

  for (const inv of invocations) {
    const resolution = resolveSegment(inv, cwd, config);
    segmentActions.push(resolution.action);
    if (resolution.action === "allow" && resolution.allowFromArgsRule) {
      allowFromArgsRule = true;
    }
  }

  if (segmentActions.includes("deny")) return { action: "deny", allowFromArgsRule };
  if (segmentActions.includes("ask")) return { action: "ask", allowFromArgsRule };

  const allAllow = segmentActions.every((a) => a === "allow");
  if (allAllow) return { action: "allow", allowFromArgsRule };

  return { action: null, allowFromArgsRule: false };
}

export interface BeforeExecuteResult {
  shouldWrap: boolean;
  chainAction: ChainAction;
  /** Set when the restructure feature rejects the command; index.ts throws this message. */
  rejectionMessage: string | null;
}

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

export function beforeExecute(
  tool: string,
  callID: string,
  cwd: string,
  args: any,
  config: PluginConfig,
  restructure: RestructureConfig = { enabled: false, maxSegments: 3, maxDepth: 2 },
  degraded = false,
): BeforeExecuteResult {
  const noAction: BeforeExecuteResult = { shouldWrap: false, chainAction: null, rejectionMessage: null };

  if (tool.toLowerCase() !== "bash") {
    return noAction;
  }

  const command: string | undefined = args?.command;
  if (!command || command.trim().length === 0) {
    return noAction;
  }

  const chain = parseCommand(command);
  if (chain.parseError || chain.invocations.length === 0) {
    decisionStore.set(callID, { action: "deny" });
    return { shouldWrap: true, chainAction: "deny", rejectionMessage: null };
  }

  // Degraded mode (broken plugin config): args rules are gone and glob allows are suspended —
  // everything asks, so a config typo can never silently re-allow a restricted command.
  if (degraded) {
    decisionStore.set(callID, { action: "ask" });
    return { shouldWrap: true, chainAction: "ask", rejectionMessage: null };
  }

  const { action, allowFromArgsRule } = resolveChain(chain.invocations, cwd, config);

  if (action === null || action === "allow") {
    if (action === "allow" && allowFromArgsRule) {
      decisionStore.set(callID, { action: "allow" });
    }
    return { shouldWrap: false, chainAction: action, rejectionMessage: null };
  }

  if (action === "ask" && restructure.enabled) {
    const violation = checkComplexity(command, chain, restructure);
    if (violation) {
      return {
        shouldWrap: false,
        chainAction: "ask",
        rejectionMessage: buildRejectionMessage(violation, chain, command),
      };
    }
  }

  if (action === "deny" || action === "ask") {
    decisionStore.set(callID, { action });
    return { shouldWrap: true, chainAction: action, rejectionMessage: null };
  }

  return noAction;
}

export function handlePermissionAsk(input: { callID?: string }, output: { status: "ask" | "deny" | "allow" }): void {
  if (!input.callID) return;

  const decision = decisionStore.get(input.callID);
  if (!decision) return;

  if (decision.action === "deny") {
    output.status = "deny";
  } else if (decision.action === "allow") {
    output.status = "allow";
  }

  clearStoredDecision(input.callID);
}
