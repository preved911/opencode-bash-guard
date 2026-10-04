import type { Config, Hooks } from "@opencode-ai/plugin";
import { parseConfig } from "./config.js";
import type { PluginConfig } from "./config.js";
import { beforeExecute } from "./enforce.js";
import type { PermissionOverride } from "./enforce.js";
import { loadPluginConfig } from "./plugin-config.js";
import type { PluginFileConfig } from "./plugin-config.js";

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
 * Decision handoffs are owned by each factory instance in an unbounded store
 * keyed by sessionID and callID. Cleanup is enforced at every lifecycle point
 * the SDK exposes:
 * `permission.asked` consumes the decision (single-use), `tool.execute.after`
 * garbage-collects any decision the permission event never consumed, and every
 * `tool.execute.before` first invalidates any decision left by a previous use
 * of the same callID — including reuse on non-storing paths (non-bash, empty,
 * allow, no-opinion), where nothing would otherwise remove the stale entry.
 * Disposal clears the instance store and makes stale callbacks inert.
 */

export interface AdapterState {
  nativeConfig: PluginConfig | null;
  fileConfig: PluginFileConfig;
}

export interface PermissionAskedEvent {
  readonly type: "permission.asked";
  readonly properties: {
    readonly id: string;
    readonly sessionID: string;
    readonly tool?: {
      readonly messageID: string;
      readonly callID?: string;
    };
  };
}

export interface PermissionReplyInput {
  readonly sessionID: string;
  readonly requestID: string;
  readonly response: "once" | "reject";
}

interface SessionIdleEvent {
  readonly type: "session.idle";
  readonly properties: { readonly sessionID: string };
}

interface SessionDeletedEvent {
  readonly type: "session.deleted";
  readonly properties: { readonly info: { readonly id: string } };
}

type BashGuardRuntimeEvent = PermissionAskedEvent | SessionIdleEvent | SessionDeletedEvent;
type ReplyPermission = (input: PermissionReplyInput) => Promise<unknown>;
type HookEventInput = Parameters<NonNullable<Hooks["event"]>>[0];

export type BashGuardHooks = Omit<Hooks, "event"> & {
  readonly event: (input: HookEventInput | { readonly event: BashGuardRuntimeEvent }) => Promise<void>;
};

export function createBashGuardHooks(input: { readonly directory: string; readonly replyPermission: ReplyPermission }): BashGuardHooks {
  const fileConfig = loadPluginConfig(input.directory);
  const state: AdapterState = { nativeConfig: null, fileConfig };
  const permissionOverrides = new Map<string, Map<string, PermissionOverride>>();
  let active = true;

  const setPermissionOverride = (sessionID: string, callID: string, permissionOverride: PermissionOverride): void => {
    let sessionOverrides = permissionOverrides.get(sessionID);
    if (sessionOverrides === undefined) {
      sessionOverrides = new Map<string, PermissionOverride>();
      permissionOverrides.set(sessionID, sessionOverrides);
    }
    sessionOverrides.set(callID, permissionOverride);
  };

  const consumePermissionOverride = (sessionID: string, callID: string): PermissionOverride | null => {
    const sessionOverrides = permissionOverrides.get(sessionID);
    if (sessionOverrides === undefined) return null;

    const permissionOverride = sessionOverrides.get(callID);
    if (permissionOverride === undefined) return null;

    sessionOverrides.delete(callID);
    if (sessionOverrides.size === 0) permissionOverrides.delete(sessionID);
    return permissionOverride;
  };

  const clearPermissionOverride = (sessionID: string, callID: string): void => {
    const sessionOverrides = permissionOverrides.get(sessionID);
    if (sessionOverrides === undefined) return;

    sessionOverrides.delete(callID);
    if (sessionOverrides.size === 0) permissionOverrides.delete(sessionID);
  };

  const clearSessionPermissionOverrides = (sessionID: string): void => {
    permissionOverrides.delete(sessionID);
  };

  const hooks: BashGuardHooks = {
    config: async (config: Config) => {
      if (!active) return;
      const configRecord: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(config)) configRecord[key] = value;
      state.nativeConfig = {
        ...parseConfig(configRecord),
        toolPermissions: fileConfig.toolPermissions,
        forcedAskTools: fileConfig.forcedAskTools,
      };

      if (!state.nativeConfig.enabled) {
        console.warn("[opencode-bash-guard] Disabled: bash is set to 'allow' or no bash permission config found. Set \"*\": \"ask\" to enable.");
        return;
      }
    },

    "tool.execute.before": async (toolInput, toolOutput) => {
      if (!active) return;
      clearPermissionOverride(toolInput.sessionID, toolInput.callID);
      if (!state.nativeConfig?.enabled) return;

      const result = beforeExecute(
        toolInput.tool,
        input.directory,
        toolOutput.args,
        state.nativeConfig,
        fileConfig.restructure,
        fileConfig.degraded,
      );

      if (result.rejectionMessage) {
        throw new Error(result.rejectionMessage);
      }

      if (result.shouldWrap && result.chainAction) {
        const originalCommand = toolOutput.args?.command;
        if (originalCommand && typeof originalCommand === "string") {
          toolOutput.args = {
            ...toolOutput.args,
            command: `{ ${originalCommand}; }`,
          };
        }
      }

      if (result.permissionOverride !== null) {
        setPermissionOverride(toolInput.sessionID, toolInput.callID, result.permissionOverride);
      }
    },

    "tool.execute.after": async (toolInput) => {
      if (!active) return;
      clearPermissionOverride(toolInput.sessionID, toolInput.callID);
    },

    event: async ({ event }) => {
      if (!active) return;
      if (event.type === "permission.asked") {
        if (!state.nativeConfig?.enabled) return;
        const callID = event.properties.tool?.callID;
        if (callID === undefined) return;

        const permissionOverride = consumePermissionOverride(event.properties.sessionID, callID);
        if (permissionOverride === null) return;
        await input.replyPermission({
          sessionID: event.properties.sessionID,
          requestID: event.properties.id,
          response: permissionOverride === "allow" ? "once" : "reject",
        });
      } else if (event.type === "session.idle") {
        clearSessionPermissionOverrides(event.properties.sessionID);
      } else if (event.type === "session.deleted") {
        clearSessionPermissionOverrides(event.properties.info.id);
      }
    },

    dispose: async () => {
      active = false;
      permissionOverrides.clear();
    },
  };

  return hooks;
}
