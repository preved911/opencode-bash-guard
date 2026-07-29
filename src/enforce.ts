import type { PluginConfig } from "./config.js";
import { matchBashPermission, matchExternalDirectory } from "./config.js";
import { parseChain } from "./chain.js";
import type { ChainSegment, RedirectInfo } from "./chain.js";
import { extractPaths } from "./paths.js";
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

export function resolveSegment(segment: string, segmentName: string, cwd: string, config: PluginConfig, redirects?: RedirectInfo[]): ChainAction {
  const bashAction = matchBashPermission(segment, config.bashRules);

  const paths = extractPaths(segment, cwd);
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

  if (redirects && redirects.length > 0) {
    const redirectAction = resolveRedirectTargets(redirects, cwd, config);
    combined = combineActions(combined, redirectAction);
  }

  return combined;
}

export function resolveChain(segments: ChainSegment[], cwd: string, config: PluginConfig): ChainAction {
  const segmentActions: ChainAction[] = [];

  for (const seg of segments) {
    const action = resolveSegment(seg.command, seg.commandName, cwd, config, seg.redirects);
    segmentActions.push(action);
  }

  if (segmentActions.includes("deny")) return "deny";
  if (segmentActions.includes("ask")) return "ask";

  const allAllow = segmentActions.every((a) => a === "allow");
  if (allAllow) return "allow";

  return null;
}

export interface BeforeExecuteResult {
  shouldWrap: boolean;
  chainAction: ChainAction;
  readabilityReject: boolean;
}

/**
 * Check whether a command has multiple top-level chain segments (pipes, &&, ||, ;)
 * that would benefit from formatting with newlines and comments, but exclude
 * single-command invocations that merely contain nested substitutions.
 */
export function isComplexChain(command: string): boolean {
  const chain = parseChain(command);
  return chain.topLevelSegments.length > 1;
}

/** Build a replacement command that prints a readability-formatting error. */
export function buildReadabilityMessage(command: string): string {
  return `cat <<'OPENGUARD'
\u2716 Command rejected: contains multiple chained operations.

The agent must rewrite this command using line breaks and comments for readability:

  # Step 1: describe what this does
  first-command
  # Step 2: describe what this does
  second-command

Original command was:

  ${command}
OPENGUARD
exit 1`;
}

export function beforeExecute(
  tool: string,
  callID: string,
  cwd: string,
  args: any,
  config: PluginConfig,
): BeforeExecuteResult {
  if (tool.toLowerCase() !== "bash") {
    return { shouldWrap: false, chainAction: null, readabilityReject: false };
  }

  const command: string | undefined = args?.command;
  if (!command || command.trim().length === 0) {
    return { shouldWrap: false, chainAction: null, readabilityReject: false };
  }

  const chain = parseChain(command);
  if (chain.parseError || chain.segments.length === 0) {
    decisionStore.set(callID, { action: "deny" });
    return { shouldWrap: true, chainAction: "deny", readabilityReject: false };
  }

  const action = resolveChain(chain.segments, cwd, config);

  if (action === null || action === "allow") {
    return { shouldWrap: false, chainAction: action, readabilityReject: false };
  }

  // Complex chain requiring approval → reject with readability instruction
  if (action === "ask" && chain.topLevelSegments.length > 1) {
    decisionStore.set(callID, { action: "deny" });
    return { shouldWrap: true, chainAction: "deny", readabilityReject: true };
  }

  if (action === "deny" || action === "ask") {
    decisionStore.set(callID, { action });
    return { shouldWrap: true, chainAction: action, readabilityReject: false };
  }

  return { shouldWrap: false, chainAction: null, readabilityReject: false };
}

export function handlePermissionAsk(input: { callID?: string }, output: { status: "ask" | "deny" | "allow" }): void {
  if (!input.callID) return;

  const decision = decisionStore.get(input.callID);
  if (!decision) return;

  if (decision.action === "deny") {
    output.status = "deny";
  }

  clearStoredDecision(input.callID);
}
