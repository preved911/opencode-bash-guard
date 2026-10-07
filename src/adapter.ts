import type { Config, Hooks } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";
import { parseConfig } from "./config.js";
import type { PluginConfig } from "./config.js";
import { beforeExecute } from "./enforce.js";
import type { EnforcementContext } from "./enforce.js";
import { runExternalCheck } from "./external-check.js";
import { loadPluginConfig } from "./plugin-config.js";

/**
 * OpenCode adapter: the only module that knows about OpenCode types and hook
 * lifecycle. Loads configuration at initialization, builds the effective
 * policy, delegates parsing/evaluation to the parser and policy modules, and
 * translates outcomes into hook effects: command wrapping, readability
 * rejection throws, and single-use callID decision handoff between
 * `tool.execute.before` and `permission.asked`.
 *
 * Observable invariant: permission prompt count and trigger points per
 * invocation and callID are identical to the pre-refactor implementation.
 *
 * Decision cleanup, enforced at every lifecycle point the SDK exposes:
 * `permission.asked` consumes the decision (single-use), `tool.execute.after`
 * garbage-collects any decision the permission event never consumed, and every
 * `tool.execute.before` first invalidates any decision left by a previous use
 * of the same callID — including reuse on non-storing paths (non-bash, empty,
 * allow, no-opinion), where nothing would otherwise remove the stale entry.
 * The store is size-bounded, so decisions for calls cancelled before the
 * permission gate — for which the SDK exposes no callID-bearing cleanup hook —
 * are evicted rather than accumulating. Immediate cleanup on pre-execution
 * cancellation is not guaranteed by the SDK.
 */

export interface AdapterState {
  nativeConfig: PluginConfig | null;
}

export interface PermissionAskedEvent {
  readonly id: string;
  readonly type: "permission.asked";
  readonly properties: {
    readonly id: string;
    readonly sessionID: string;
    readonly permission: string;
    readonly patterns: readonly string[];
    readonly metadata: Readonly<Record<string, unknown>>;
    readonly always: readonly string[];
    readonly tool?: {
      readonly messageID: string;
      readonly callID: string;
    };
  };
}

export interface PermissionReplyInput {
  readonly sessionID: string;
  readonly requestID: string;
  readonly reply: "once" | "reject";
}

export type BashGuardHooks = Omit<Hooks, "dispose" | "event"> & {
  readonly dispose: () => Promise<void>;
  readonly event: (input: { readonly event: Event | PermissionAskedEvent }) => Promise<void>;
};

export type ReplyPermission = (input: PermissionReplyInput) => Promise<void>;

/**
 * Resolve the current session's runtime working directory (its worktree) at
 * invocation time, or null when the lookup fails or exposes no directory.
 * Implementations must fetch freshly per call; the result is never cached.
 */
export type ResolveSessionDirectory = (sessionID: string) => Promise<string | null>;

interface ReplyDecision {
  readonly action: "allow" | "deny";
}

const MAX_STORED_DECISIONS = 256;
const STORE_SATURATED_MESSAGE =
  "[opencode-bash-guard] Decision store saturated — unable to record the deny decision, so the command is blocked (fail closed).";

export function createBashGuardHooks(
  input: { readonly directory: string },
  replyPermission: ReplyPermission,
  resolveSessionDirectory: ResolveSessionDirectory,
): BashGuardHooks {
  const fileConfig = loadPluginConfig(input.directory);
  const state: AdapterState = { nativeConfig: null };
  const decisions = new Map<string, ReplyDecision>();
  const inFlightDecisions = new Map<string, ReplyDecision>();
  let disposed = false;
  let warnedStoreSaturated = false;

  const decisionKey = (sessionID: string, callID: string): string => `${sessionID}\u0000${callID}`;
  const clearDecision = (sessionID: string, callID: string): void => {
    const key = decisionKey(sessionID, callID);
    decisions.delete(key);
    inFlightDecisions.delete(key);
  };
  const clearSession = (sessionID: string): void => {
    const prefix = `${sessionID}\u0000`;
    for (const key of decisions.keys()) {
      if (key.startsWith(prefix)) decisions.delete(key);
    }
    for (const key of inFlightDecisions.keys()) {
      if (key.startsWith(prefix)) inFlightDecisions.delete(key);
    }
  };
  const storeDecision = (sessionID: string, callID: string, decision: ReplyDecision): boolean => {
    const key = decisionKey(sessionID, callID);
    decisions.delete(key);
    decisions.set(key, decision);
    if (decisions.size + inFlightDecisions.size <= MAX_STORED_DECISIONS) return true;

    for (const candidate of decisions.keys()) {
      if (candidate === key || decisions.get(candidate)?.action === "deny") continue;
      decisions.delete(candidate);
      return true;
    }

    decisions.delete(key);
    return false;
  };

  const hooks: BashGuardHooks = {
    config: async (config: Config) => {
      if (disposed) return;
      state.nativeConfig = {
        ...parseConfig(config as unknown as Record<string, unknown>),
        toolPermissions: fileConfig.toolPermissions,
        forcedAskTools: fileConfig.forcedAskTools,
      };

      if (!state.nativeConfig.enabled) {
        console.warn("[opencode-bash-guard] Disabled: bash is set to 'allow' or no bash permission config found. Set \"*\": \"ask\" to enable.");
        return;
      }
    },

    "tool.execute.before": async (toolInput, toolOutput) => {
      if (disposed) return;
      clearDecision(toolInput.sessionID, toolInput.callID);
      if (!state.nativeConfig?.enabled) return;

      const topLevelCommand = toolOutput.args?.command;
      const nestedCommand = toolOutput.args?.args?.command;
      const command =
        typeof topLevelCommand === "string"
          ? topLevelCommand
          : typeof nestedCommand === "string"
            ? nestedCommand
            : undefined;
      const enforcementContext: EnforcementContext = {
        sessionID: toolInput.sessionID,
        callID: toolInput.callID,
        resolveCwd: async () => {
          try {
            return await resolveSessionDirectory(toolInput.sessionID);
          } catch {
            return null;
          }
        },
        runCheck: runExternalCheck,
      };
      const result = await beforeExecute(
        toolInput.tool,
        command === undefined ? toolOutput.args : { command },
        state.nativeConfig,
        enforcementContext,
        fileConfig.restructure,
        fileConfig.degraded,
      );

      if (
        result.permissionOverride !== null &&
        !storeDecision(toolInput.sessionID, toolInput.callID, { action: result.permissionOverride })
      ) {
        if (result.permissionOverride === "deny") throw new Error(STORE_SATURATED_MESSAGE);
        if (!warnedStoreSaturated) {
          warnedStoreSaturated = true;
          console.warn(
            "[opencode-bash-guard] Decision store saturated — an args-level allow handoff was dropped; the native ask applies (fail closed).",
          );
        }
      }

      if (result.rejectionMessage) {
        throw new Error(result.rejectionMessage);
      }

      if (result.shouldWrap && result.chainAction) {
        if (typeof topLevelCommand === "string" && topLevelCommand.length > 0) {
          toolOutput.args = {
            ...toolOutput.args,
            command: `{ ${topLevelCommand}; }`,
          };
        } else if (typeof nestedCommand === "string" && nestedCommand.length > 0) {
          toolOutput.args = {
            ...toolOutput.args,
            args: {
              ...toolOutput.args.args,
              command: `{ ${nestedCommand}; }`,
            },
          };
        }
      }
    },

    "tool.execute.after": async (toolInput) => {
      if (disposed) return;
      clearDecision(toolInput.sessionID, toolInput.callID);
    },

    event: async ({ event }) => {
      if (disposed) return;
      if (event.type === "permission.asked") {
        if (event.properties.permission !== "bash" || !event.properties.id || !event.properties.sessionID) return;
        const callID = event.properties.tool?.callID;
        if (!callID) return;

        const key = decisionKey(event.properties.sessionID, callID);
        const decision = decisions.get(key);
        if (!decision) return;
        decisions.delete(key);
        inFlightDecisions.set(key, decision);

        try {
          await replyPermission({
            sessionID: event.properties.sessionID,
            requestID: event.properties.id,
            reply: decision.action === "allow" ? "once" : "reject",
          });
          if (inFlightDecisions.get(key) === decision) inFlightDecisions.delete(key);
        } catch (error) {
          if (inFlightDecisions.get(key) === decision) {
            inFlightDecisions.delete(key);
            if (!disposed && !decisions.has(key) && !storeDecision(event.properties.sessionID, callID, decision)) {
              throw new Error(STORE_SATURATED_MESSAGE);
            }
          }
          throw error;
        }
        return;
      }

      if (event.type === "session.idle") {
        clearSession(event.properties.sessionID);
      } else if (event.type === "session.deleted") {
        clearSession(event.properties.info.id);
      }
    },

    dispose: async () => {
      disposed = true;
      decisions.clear();
      inFlightDecisions.clear();
      state.nativeConfig = null;
      warnedStoreSaturated = false;
    },
  };

  return hooks;
}
