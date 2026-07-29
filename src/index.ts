import type { Plugin, Config, Hooks } from "@opencode-ai/plugin";
import type { Permission } from "@opencode-ai/sdk";
import { parseConfig } from "./config.js";
import { beforeExecute, buildReadabilityMessage, handlePermissionAsk } from "./enforce.js";

let pluginConfig: ReturnType<typeof parseConfig> | null = null;

const BashGuardPlugin: Plugin = async (input) => {
  const hooks: Hooks = {
    config: async (config: Config) => {
      pluginConfig = parseConfig(config as unknown as Record<string, unknown>);

      if (!pluginConfig.enabled) {
        console.warn("[opencode-bash-guard] Disabled: bash is set to 'allow' or no bash permission config found. Set \"*\": \"ask\" to enable.");
        return;
      }
    },

    "tool.execute.before": async (toolInput, toolOutput) => {
      if (!pluginConfig?.enabled) return;

      const result = beforeExecute(
        toolInput.tool,
        toolInput.callID,
        input.directory,
        toolOutput.args,
        pluginConfig,
      );

      if (result.shouldWrap && result.chainAction) {
        const originalCommand = toolOutput.args?.command || toolOutput.args?.args?.command;
        if (originalCommand && typeof originalCommand === "string") {
          if (result.readabilityReject) {
            toolOutput.args = {
              ...toolOutput.args,
              command: buildReadabilityMessage(originalCommand),
            };
          } else {
            toolOutput.args = {
              ...toolOutput.args,
              command: `{ ${originalCommand}; }`,
            };
          }
        }
      }
    },

    "permission.ask": async (permInput: Permission, permOutput) => {
      if (!pluginConfig?.enabled) return;
      handlePermissionAsk(permInput, permOutput);
    },
  };

  return hooks;
};

export default BashGuardPlugin;
