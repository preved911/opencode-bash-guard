import type { PluginConfig, NormalizedCheck, PermissionAction } from "./config.js";
import { matchBashPermission, matchExternalDirectory, matchToolContributions, mostRestrictive } from "./config.js";
import type { NormalizedInvocation } from "./parser.js";
import { classifyPath, resolveCandidatePaths, type ExtractedPath } from "./paths.js";
import path from "path";

/**
 * Pure policy evaluation over normalized invocations.
 *
 * Receives parsed invocations plus the already-normalized effective policy and
 * returns decision data. No file reads, no hook output mutation, no callID
 * state — those belong to the OpenCode adapter. Static planning selects check
 * work items without process effects; enforcement executes them and finalizes
 * the reduction with per-check outcomes.
 */

export type ChainAction = "allow" | "ask" | "deny" | null;

function isUnderCwd(resolvedPath: string, cwd: string): boolean {
  return resolvedPath === cwd || resolvedPath.startsWith(cwd + path.sep);
}

function resolveRedirectTargets(targets: ExtractedPath[], cwd: string, config: PluginConfig): ChainAction {
  const actions: ChainAction[] = [];

  for (const target of targets) {
    const resolvedPath = target.resolved;
    const underCwd = isUnderCwd(resolvedPath, cwd);

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

/** One selected check for a segment: everything the runner needs, no runtime context yet. */
export interface SegmentCheckWork {
  ruleId: string;
  check: NormalizedCheck;
  /** Normalized segment command for the versioned request. */
  command: { raw: string; executable: string; argv: string[] };
}

export interface SegmentStaticPlan {
  forcedAsk: boolean;
  /** Any args matcher (action- or check-bearing) statically matched. */
  argsContributed: boolean;
  /** Fixed actions from matched unchecked matchers, in match order. */
  argsActions: PermissionAction[];
  /** Selected checks in effective-entry then matcher order. */
  checks: SegmentCheckWork[];
  /** True when selected checks or path policy need the runtime cwd. */
  needsRuntimeCwd: boolean;
}

/**
 * Static selection for one segment: split matcher contributions into fixed
 * actions and check work items, and decide whether the runtime cwd is needed.
 * Pure — never spawns a process. A forced-ask segment selects no checks: its
 * outcome is already ask regardless of any check result.
 */
export function planSegment(invocation: NormalizedInvocation, config: PluginConfig): SegmentStaticPlan {
  const forcedAsk = config.forcedAskTools?.includes(invocation.argv[0]) ?? false;
  const contributions = forcedAsk ? { actions: [], checks: [] } : matchToolContributions(invocation.argv, config.toolPermissions);
  const hasCandidatePaths = (invocation.candidatePathDetails?.length ?? invocation.candidatePaths.length) > 0;
  const hasRedirectTargets = invocation.redirects.some((redirect) => !redirect.wellKnown);
  return {
    forcedAsk,
    argsContributed: contributions.actions.length > 0 || contributions.checks.length > 0,
    argsActions: contributions.actions,
    checks: contributions.checks.map((selected) => ({
      ruleId: selected.ruleId,
      check: selected.check,
      command: { raw: invocation.command, executable: invocation.argv[0], argv: invocation.argv.slice(1) },
    })),
    needsRuntimeCwd: contributions.checks.length > 0 || hasCandidatePaths || hasRedirectTargets,
  };
}

/**
 * Reduce one segment with its check outcomes. `cwd === null` means the runtime
 * directory could not be resolved: every path-bearing input fails safe to ask
 * and rule matching continues unchanged.
 */
export function finalizeSegment(
  invocation: NormalizedInvocation,
  cwd: string | null,
  config: PluginConfig,
  plan: SegmentStaticPlan,
  checkOutcomes: PermissionAction[],
): SegmentResolution {
  if (plan.forcedAsk) {
    return { action: "ask", allowFromArgsRule: false };
  }

  let edAction: "ask" | "allow" | "deny" | null = null;
  let redirectAction: ChainAction = null;

  if (cwd === null) {
    // Lookup failure: relative paths cannot resolve and under-cwd / `./` policy
    // cannot evaluate, so any path-bearing input requires human confirmation.
    const hasPaths = (invocation.candidatePathDetails?.length ?? invocation.candidatePaths.length) > 0;
    const hasRedirectTargets = invocation.redirects.some((redirect) => !redirect.wellKnown);
    if (hasPaths || hasRedirectTargets) edAction = "ask";
  } else {
    const paths = resolveCandidatePaths(invocation, cwd);
    const redirectTargets = invocation.redirects
      .filter((redirect) => !redirect.wellKnown)
      .map((redirect) =>
        "targetValue" in redirect && redirect.targetValue === null
          ? { original: redirect.rawTarget ?? redirect.target, resolved: redirect.rawTarget ?? redirect.target, requiresConfirmation: true }
          : classifyPath(redirect.targetValue ?? redirect.target, cwd),
      );
    const requiresPathConfirmation = [...paths, ...redirectTargets].some((candidate) => candidate.requiresConfirmation);
    redirectAction = resolveRedirectTargets(redirectTargets, cwd, config);

    edAction = requiresPathConfirmation ? "ask" : null;

    // external_directory governs paths outside the working tree (same rule as redirects).
    for (const p of paths) {
      if (p.requiresConfirmation || isUnderCwd(p.resolved, cwd)) continue;
      const result = matchExternalDirectory(p.resolved, config.externalDirectoryRules, config.externalDirectoryDefault, cwd);
      if (result.violated && result.action) {
        if (result.action === "deny" || edAction !== "deny") {
          edAction = result.action;
        }
      }
    }
  }

  // Pipeline order (spec): args rules decide the segment after path and redirect safety checks; otherwise the legacy glob evaluation.
  if (plan.argsContributed) {
    const argsAction = mostRestrictive([...plan.argsActions, ...checkOutcomes]);
    const action = combineActions(combineActions(argsAction, edAction), redirectAction);
    return { action, allowFromArgsRule: action === "allow" && argsAction === "allow" };
  }

  const bashAction = matchBashPermission(invocation.command, config.bashRules);

  let combined = combineActions(bashAction, edAction);

  combined = combineActions(combined, redirectAction);

  return { action: combined, allowFromArgsRule: false };
}

/** Compatibility wrapper: plan + finalize with fail-safe onError outcomes for any selected checks. */
export function resolveSegment(invocation: NormalizedInvocation, cwd: string, config: PluginConfig): SegmentResolution {
  const plan = planSegment(invocation, config);
  const outcomes = plan.checks.map((work) => work.check.onError);
  return finalizeSegment(invocation, cwd, config, plan, outcomes);
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
