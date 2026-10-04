import type { PluginConfig } from "./config.js";
import { parseCommand } from "./parser.js";
import type { ParsedCommand } from "./parser.js";
import type { RestructureConfig } from "./plugin-config.js";
import { resolveChain } from "./policy.js";
import type { ChainAction } from "./policy.js";
import { checkComplexity, buildRejectionMessage } from "./readability.js";

/**
 * Enforcement orchestration: the stateful seam between pure evaluation and the
 * OpenCode adapter. Owns the single-use decision handoff store, keyed by
 * (sessionID, callID) so concurrent sessions cannot overwrite, consume, or
 * clear each other's decisions; the adapter drives every lifecycle point.
 */

export type { ChainAction } from "./policy.js";

export interface StoredDecision {
  action: ChainAction;
}

const decisionStore = new Map<string, StoredDecision>();

function decisionKey(sessionID: string, callID: string): string {
  return `${sessionID}\u0000${callID}`;
}

/**
 * Bound on unconsumed decisions. Calls cancelled before the permission gate
 * have no callID-bearing cleanup hook in the SDK; session cleanup events evict
 * their orphans, and this cap is the backstop.
 */
const MAX_STORED_DECISIONS = 256;

/**
 * Store a deny or args-allow handoff. Ask decisions are never stored: they are
 * inert (handlePermissionAsk leaves the native ask untouched), so storing them
 * only adds eviction pressure. Never evicts an unresolved deny — losing one
 * would let the native ask approve a mandatory denial. When no non-deny entry
 * can be evicted, the new entry is rejected and the caller must fail closed.
 */
function storeDecision(sessionID: string, callID: string, action: "allow" | "deny"): boolean {
  const key = decisionKey(sessionID, callID);
  decisionStore.delete(key);
  decisionStore.set(key, { action });
  if (decisionStore.size <= MAX_STORED_DECISIONS) return true;
  for (const k of decisionStore.keys()) {
    if (k === key) continue;
    if (decisionStore.get(k)!.action !== "deny") {
      decisionStore.delete(k);
      return true;
    }
  }
  decisionStore.delete(key);
  return false;
}

export function getStoredDecision(sessionID: string, callID: string): StoredDecision | undefined {
  return decisionStore.get(decisionKey(sessionID, callID));
}

export function clearStoredDecision(sessionID: string, callID: string): void {
  decisionStore.delete(decisionKey(sessionID, callID));
}

/** Drop every decision for one session — orphaned by cancellation or session end. */
export function clearSessionDecisions(sessionID: string): void {
  const prefix = `${sessionID}\u0000`;
  for (const key of [...decisionStore.keys()]) {
    if (key.startsWith(prefix)) decisionStore.delete(key);
  }
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
  sessionID: string,
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
    if (!storeDecision(sessionID, callID, "deny")) {
      return { shouldWrap: false, chainAction: "deny", rejectionMessage: STORE_SATURATED_MESSAGE };
    }
    return { shouldWrap: true, chainAction: "deny", rejectionMessage: null };
  }

  // Degraded mode (broken plugin config): args rules are gone and glob allows are suspended —
  // everything asks, so a config typo can never silently re-allow a restricted command.
  if (degraded) {
    return { shouldWrap: true, chainAction: "ask", rejectionMessage: null };
  }

  const { action, allowFromArgsRule } = resolveChain(chain.invocations, cwd, config);

  if (action === null || action === "allow") {
    if (action === "allow" && allowFromArgsRule && !storeDecision(sessionID, callID, "allow")) {
      warnStoreSaturated();
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
    if (action === "deny" && !storeDecision(sessionID, callID, "deny")) {
      return { shouldWrap: false, chainAction: "deny", rejectionMessage: STORE_SATURATED_MESSAGE };
    }
    return { shouldWrap: true, chainAction: action, rejectionMessage: null };
  }

  return noAction;
}

const STORE_SATURATED_MESSAGE =
  "[opencode-bash-guard] Decision store saturated — unable to record the deny decision, so the command is blocked (fail closed).";

let warnedStoreSaturated = false;

function warnStoreSaturated(): void {
  if (warnedStoreSaturated) return;
  warnedStoreSaturated = true;
  console.warn(
    "[opencode-bash-guard] Decision store saturated — an args-level allow handoff was dropped; the native ask applies (fail closed).",
  );
}

export function handlePermissionAsk(input: { sessionID?: string; callID?: string }, output: { status: "ask" | "deny" | "allow" }): void {
  if (!input.callID || !input.sessionID) return;

  const decision = decisionStore.get(decisionKey(input.sessionID, input.callID));
  if (!decision) return;

  if (decision.action === "deny") {
    output.status = "deny";
  } else if (decision.action === "allow") {
    output.status = "allow";
  }

  clearStoredDecision(input.sessionID, input.callID);
}
