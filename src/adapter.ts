import type { Config, Hooks } from "@opencode-ai/plugin";
import type { Permission } from "@opencode-ai/sdk";
import { parseConfig } from "./config.js";
import type { PluginConfig } from "./config.js";
import { beforeExecute, handlePermissionAsk, clearStoredDecision } from "./enforce.js";
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
 * Decision cleanup: `permission.ask` consumes the stored decision (single-use).
 * `tool.execute.after` garbage-collects any decision that was never consumed —
 * covering terminal paths where the ask hook does not fire. Decisions for tool
 * calls that never reach execution (cancelled before the permission gate) have
 * no callID-bearing cleanup hook in the SDK; a reused callID overwrites the
 * stale entry, so staleness cannot leak into a later decision.
 */

export interface AdapterState {
  nativeConfig: PluginConfig | null;
  fileConfig: PluginFileConfig;
}

export function createBashGuardHooks(input: { directory: string }): Hooks {
  const fileConfig = loadPluginConfig(input.directory);
  const state: AdapterState = { nativeConfig: null, fileConfig };

  const hooks: Hooks = {
    config: async (config: Config) => {
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
      if (!state.nativeConfig?.enabled) return;

      const result = beforeExecute(
        toolInput.tool,
        toolInput.callID,
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
        const originalCommand = toolOutput.args?.command || toolOutput.args?.args?.command;
        if (originalCommand && typeof originalCommand === "string") {
          toolOutput.args = {
            ...toolOutput.args,
            command: `{ ${originalCommand}; }`,
          };
        }
      }
    },

    "permission.ask": async (permInput: Permission, permOutput) => {
      if (!state.nativeConfig?.enabled) return;
      handlePermissionAsk(permInput, permOutput);
    },

    "tool.execute.after": async (toolInput) => {
      if (!state.nativeConfig?.enabled) return;
      clearStoredDecision(toolInput.callID);
    },
  };

  return hooks;
}
