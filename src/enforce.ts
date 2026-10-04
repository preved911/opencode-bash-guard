import type { PluginConfig } from "./config.js";
import { parseCommand } from "./parser.js";
import type { ParsedCommand } from "./parser.js";
import type { RestructureConfig } from "./plugin-config.js";
import { resolveChain } from "./policy.js";
import type { ChainAction } from "./policy.js";
import { checkComplexity, buildRejectionMessage } from "./readability.js";

/**
 * Enforcement orchestration: the stateful seam between pure evaluation and the
 * OpenCode adapter. Owns the single-use callID decision store; the adapter
 * (task 4) owns hook wiring and command wrapping.
 */

export type { ChainAction } from "./policy.js";

export interface StoredDecision {
  action: ChainAction;
}

const decisionStore = new Map<string, StoredDecision>();

/**
 * Bound on unconsumed decisions. Decisions for calls cancelled before the
 * permission gate have no callID-bearing cleanup hook in the SDK; the cap
 * bounds their residual memory instead of letting the store grow unbounded.
 */
const MAX_STORED_DECISIONS = 256;

function storeDecision(callID: string, decision: StoredDecision): void {
  decisionStore.delete(callID);
  decisionStore.set(callID, decision);
  while (decisionStore.size > MAX_STORED_DECISIONS) {
    const oldest = decisionStore.keys().next().value;
    if (oldest === undefined) break;
    decisionStore.delete(oldest);
  }
}

export function getStoredDecision(callID: string): StoredDecision | undefined {
  return decisionStore.get(callID);
}

export function clearStoredDecision(callID: string): void {
  decisionStore.delete(callID);
}

export interface BeforeExecuteResult {
  shouldWrap: boolean;
  chainAction: ChainAction;
  /** Set when the restructure feature rejects the command; the adapter throws this message. */
  rejectionMessage: string | null;
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
    storeDecision(callID, { action: "deny" });
    return { shouldWrap: true, chainAction: "deny", rejectionMessage: null };
  }

  // Degraded mode (broken plugin config): args rules are gone and glob allows are suspended —
  // everything asks, so a config typo can never silently re-allow a restricted command.
  if (degraded) {
    storeDecision(callID, { action: "ask" });
    return { shouldWrap: true, chainAction: "ask", rejectionMessage: null };
  }

  const { action, allowFromArgsRule } = resolveChain(chain.invocations, cwd, config);

  if (action === null || action === "allow") {
    if (action === "allow" && allowFromArgsRule) {
      storeDecision(callID, { action: "allow" });
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
    storeDecision(callID, { action });
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
