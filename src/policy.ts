import type { PluginConfig } from "./config.js";
import { matchBashPermission, matchExternalDirectory, matchToolPermissions } from "./config.js";
import type { NormalizedInvocation, RedirectInfo } from "./parser.js";
import { resolveCandidatePaths } from "./paths.js";
import path from "path";

/**
 * Pure policy evaluation over normalized invocations.
 *
 * Receives parsed invocations plus the already-normalized effective policy and
 * returns decision data. No file reads, no hook output mutation, no callID
 * state — those belong to the OpenCode adapter.
 */

export type ChainAction = "allow" | "ask" | "deny" | null;

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

  const paths = resolveCandidatePaths(invocation, cwd);
  const requiresPathConfirmation = paths.some((candidate) => candidate.requiresConfirmation);

  // Pipeline order (spec): args rules decide the segment when any matcher matched; otherwise the legacy glob evaluation.
  const argsAction = matchToolPermissions(tokens, config.toolPermissions);
  if (argsAction !== null) {
    if (requiresPathConfirmation && argsAction !== "deny") {
      return { action: "ask", allowFromArgsRule: false };
    }
    return { action: argsAction, allowFromArgsRule: argsAction === "allow" };
  }

  const bashAction = matchBashPermission(invocation.command, config.bashRules);

  let edAction: "ask" | "allow" | "deny" | null = requiresPathConfirmation ? "ask" : null;

  for (const p of paths) {
    if (p.requiresConfirmation) continue;
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
