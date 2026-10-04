import type { Config, Hooks } from "@opencode-ai/plugin";
import type { Permission } from "@opencode-ai/sdk";
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
 * `tool.execute.before` and `permission.ask`.
 *
 * Observable invariant: permission prompt count and trigger points per
 * invocation and callID are identical to the pre-refactor implementation.
 *
 * Decision handoffs are owned by each factory instance in an unbounded store
 * keyed by sessionID and callID. Cleanup is enforced at every lifecycle point
 * the SDK exposes:
 * `permission.ask` consumes the decision (single-use), `tool.execute.after`
 * garbage-collects any decision the ask hook never consumed, and every
 * `tool.execute.before` first invalidates any decision left by a previous use
 * of the same callID — including reuse on non-storing paths (non-bash, empty,
 * allow, no-opinion), where nothing would otherwise remove the stale entry.
 * Disposal clears the instance store and makes stale callbacks inert.
 */

export interface AdapterState {
  nativeConfig: PluginConfig | null;
  fileConfig: PluginFileConfig;
}

export function createBashGuardHooks(input: { directory: string }): Hooks {
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

  const hooks: Hooks = {
    config: async (config: Config) => {
      if (!active) return;
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

    "permission.ask": async (permInput: Permission, permOutput) => {
      if (!active || !state.nativeConfig?.enabled) return;
      if (permInput.callID === undefined) return;

      const permissionOverride = consumePermissionOverride(permInput.sessionID, permInput.callID);
      if (permissionOverride !== null) permOutput.status = permissionOverride;
    },

    "tool.execute.after": async (toolInput) => {
      if (!active) return;
      clearPermissionOverride(toolInput.sessionID, toolInput.callID);
    },

    event: async ({ event }) => {
      if (!active) return;
      if (event.type === "session.idle") {
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
