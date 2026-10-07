import type { PluginConfig, PermissionAction } from "./config.js";
import { parseCommand } from "./parser.js";
import type { RestructureConfig } from "./plugin-config.js";
import { planSegment, finalizeSegment } from "./policy.js";
import type { ChainAction, SegmentCheckWork, SegmentStaticPlan } from "./policy.js";
import { checkComplexity, buildRejectionMessage } from "./readability.js";

/**
 * Stateless enforcement orchestration between pure command evaluation and the
 * OpenCode adapter. Lifecycle state belongs exclusively to the adapter.
 *
 * Enforcement is asynchronous: the full chain is statically planned before the
 * first checker process spawns, selected checks execute sequentially under a
 * per-invocation budget, then every segment reduces with complete outcomes.
 */

export type { ChainAction, SegmentCheckWork } from "./policy.js";

/** At most 16 selected checks run per guarded invocation; excess contributes onError without spawning. */
export const MAX_SELECTED_CHECKS = 16;
/** Wall-clock budget for all checks of one invocation, starting before the first spawn. */
export const INVOCATION_CHECK_BUDGET_MS = 30000;

export interface BeforeExecuteResult {
  readonly shouldWrap: boolean;
  readonly chainAction: ChainAction;
  readonly permissionOverride: "allow" | "deny" | null;
  /** Set when the restructure feature rejects the command; the adapter throws this message. */
  readonly rejectionMessage: string | null;
}

export interface CommandArguments {
  readonly command?: unknown;
}

/** Runtime context of the guarded invocation, supplied by the adapter. */
export interface CheckRunContext {
  readonly cwd: string;
  readonly sessionID: string;
  readonly callID: string;
}

/** Result of one checker process execution, already classified by the runner. */
export type CheckRunResult = "pass" | "fail" | "error";

/** The sole process boundary, injected so enforcement stays testable. */
export type CheckRunner = (
  work: SegmentCheckWork,
  context: CheckRunContext,
  effectiveTimeoutMs: number,
) => Promise<CheckRunResult>;

export interface EnforcementContext {
  readonly sessionID: string;
  readonly callID: string;
  /**
   * Resolve the invocation's runtime working directory, or null on lookup
   * failure. Invoked at most once per call, only when selected checks or
   * relative-path policy need it; never cached across calls.
   */
  readonly resolveCwd: () => Promise<string | null>;
  readonly runCheck: CheckRunner;
  /** Test seam for scheduling determinism; production uses the 30000 ms default. */
  readonly budgetMs?: number;
  /** Test seam for the wall-clock source; production uses Date.now. */
  readonly now?: () => number;
}

const DEFAULT_RESTRUCTURE: RestructureConfig = { enabled: false, maxSegments: 3, maxDepth: 2 };

const NO_ACTION: BeforeExecuteResult = {
  shouldWrap: false,
  chainAction: null,
  permissionOverride: null,
  rejectionMessage: null,
};

/**
 * Execute the selected checks of an already-planned chain: deterministic
 * segment, effective-entry, then matcher order; the 16-check selection cap;
 * the invocation-wide budget clamping each started check to the lesser of its
 * configured timeout and the remaining budget. Excess and unstarted checks
 * contribute their own onError without spawning.
 */
async function executeCheckOutcomes(
  plans: SegmentStaticPlan[],
  context: EnforcementContext,
  cwd: string | null,
): Promise<Map<SegmentCheckWork, PermissionAction>> {
  const outcomes = new Map<SegmentCheckWork, PermissionAction>();
  const allChecks = plans.flatMap((plan) => plan.checks);
  if (allChecks.length === 0) return outcomes;

  const now = context.now ?? Date.now;
  const budgetStart = now();
  const deadline = budgetStart + (context.budgetMs ?? INVOCATION_CHECK_BUDGET_MS);
  const spawnable = allChecks.slice(0, MAX_SELECTED_CHECKS);
  for (const work of spawnable) {
    if (cwd === null) {
      outcomes.set(work, work.check.onError);
      continue;
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      outcomes.set(work, work.check.onError);
      continue;
    }
    const result = await context.runCheck(
      work,
      { cwd, sessionID: context.sessionID, callID: context.callID },
      Math.min(work.check.timeoutMs, remaining),
    );
    outcomes.set(
      work,
      result === "pass" ? work.check.onPass : result === "fail" ? work.check.onFail : work.check.onError,
    );
  }
  for (const work of allChecks.slice(MAX_SELECTED_CHECKS)) {
    outcomes.set(work, work.check.onError);
  }
  return outcomes;
}

export async function beforeExecute(
  tool: string,
  args: CommandArguments | undefined,
  config: PluginConfig,
  context: EnforcementContext,
  restructure: RestructureConfig = DEFAULT_RESTRUCTURE,
  degraded = false,
): Promise<BeforeExecuteResult> {
  if (tool.toLowerCase() !== "bash") {
    return NO_ACTION;
  }

  const command = typeof args?.command === "string" ? args.command : undefined;
  if (!command || command.trim().length === 0) {
    return NO_ACTION;
  }

  const chain = parseCommand(command);
  if (chain.parseError || chain.invocations.length === 0) {
    return { shouldWrap: true, chainAction: "deny", permissionOverride: "deny", rejectionMessage: null };
  }

  // Degraded mode (broken plugin config): args rules are gone and glob allows are suspended —
  // everything asks, so a config typo can never silently re-allow a restricted command.
  if (degraded) {
    return { shouldWrap: true, chainAction: "ask", permissionOverride: null, rejectionMessage: null };
  }

  // Static planning completes for every segment before the first spawn, so an
  // unmatched rule can never start a checker and no checker can influence matching.
  const plans = chain.invocations.map((invocation) => planSegment(invocation, config));
  const needsCwd = plans.some((plan) => plan.needsRuntimeCwd);
  const cwd = needsCwd ? await context.resolveCwd() : null;

  const outcomes = await executeCheckOutcomes(plans, context, cwd);

  const segmentActions: ChainAction[] = [];
  let allowFromArgsRule = false;
  for (const [index, plan] of plans.entries()) {
    const checkOutcomes = plan.checks.map((work) => outcomes.get(work) ?? work.check.onError);
    const resolution = finalizeSegment(chain.invocations[index], cwd, config, plan, checkOutcomes);
    segmentActions.push(resolution.action);
    if (resolution.action === "allow" && resolution.allowFromArgsRule) {
      allowFromArgsRule = true;
    }
  }

  let action: ChainAction;
  if (segmentActions.includes("deny")) action = "deny";
  else if (segmentActions.includes("ask")) action = "ask";
  else if (segmentActions.every((a) => a === "allow") && segmentActions.length > 0) action = "allow";
  else action = null;

  if (action === null || action === "allow") {
    return {
      shouldWrap: false,
      chainAction: action,
      permissionOverride: action === "allow" && allowFromArgsRule ? "allow" : null,
      rejectionMessage: null,
    };
  }

  if (action === "ask" && restructure.enabled) {
    const violation = checkComplexity(command, chain, restructure);
    if (violation) {
      return {
        shouldWrap: false,
        chainAction: "ask",
        permissionOverride: null,
        rejectionMessage: buildRejectionMessage(violation, chain, command),
      };
    }
  }

  if (action === "deny" || action === "ask") {
    return {
      shouldWrap: true,
      chainAction: action,
      permissionOverride: action === "deny" ? "deny" : null,
      rejectionMessage: null,
    };
  }

  return NO_ACTION;
}
