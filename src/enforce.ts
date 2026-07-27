import type { PluginConfig } from "./config.js";
import { matchBashPermission, matchExternalDirectory } from "./config.js";
import { parseChain } from "./chain.js";
import { extractPaths } from "./paths.js";

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

export function resolveSegment(segment: string, segmentName: string, cwd: string, config: PluginConfig): ChainAction {
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

  const actions: ChainAction[] = [];
  if (bashAction) actions.push(bashAction);
  if (edAction) actions.push(edAction);

  if (actions.length === 0) return null;

  if (actions.includes("deny")) return "deny";
  if (actions.includes("ask")) return "ask";
  if (actions.includes("allow")) return "allow" as ChainAction;
  return null;
}

export function resolveChain(segments: Array<{ command: string; commandName: string }>, cwd: string, config: PluginConfig): ChainAction {
  const segmentActions: ChainAction[] = [];

  for (const seg of segments) {
    const action = resolveSegment(seg.command, seg.commandName, cwd, config);
    segmentActions.push(action);
  }

  if (segmentActions.includes("deny")) return "deny";
  if (segmentActions.includes("ask")) return "ask";

  const allAllow = segmentActions.every((a) => a === "allow");
  if (allAllow) return "allow";

  return null;
}

export function beforeExecute(
  tool: string,
  callID: string,
  cwd: string,
  args: any,
  config: PluginConfig,
): { shouldWrap: boolean; chainAction: ChainAction } {
  if (tool !== "Bash") {
    return { shouldWrap: false, chainAction: null };
  }

  const command: string | undefined = args?.command;
  if (!command || command.trim().length === 0) {
    return { shouldWrap: false, chainAction: null };
  }

  const chain = parseChain(command);
  if (chain.parseError || chain.segments.length === 0) {
    decisionStore.set(callID, { action: "deny" });
    return { shouldWrap: true, chainAction: "deny" };
  }

  const action = resolveChain(chain.segments, cwd, config);

  if (action === null || action === "allow") {
    return { shouldWrap: false, chainAction: action };
  }

  if (action === "deny" || action === "ask") {
    decisionStore.set(callID, { action });
    return { shouldWrap: true, chainAction: action };
  }

  return { shouldWrap: false, chainAction: null };
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
