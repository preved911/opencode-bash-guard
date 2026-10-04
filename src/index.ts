import type { Plugin, Config, Hooks } from "@opencode-ai/plugin";
import { parseConfig } from "./config.js";
import { beforeExecute, handlePermissionAsk } from "./enforce.js";
import { loadPluginConfig } from "./plugin-config.js";

let pluginConfig: ReturnType<typeof parseConfig> | null = null;

interface PermissionAskedEvent {
  readonly type: "permission.asked";
  readonly properties: {
    readonly id: string;
    readonly sessionID: string;
    readonly tool?: {
      readonly callID?: string;
    };
  };
}

type HookEventInput = Parameters<NonNullable<Hooks["event"]>>[0];
type BashGuardHooks = Omit<Hooks, "event"> & {
  readonly event: (input: HookEventInput | { readonly event: PermissionAskedEvent }) => Promise<void>;
};

const BashGuardPlugin: Plugin = async (input) => {
  const fileConfig = loadPluginConfig(input.directory);

  const hooks: BashGuardHooks = {
    config: async (config: Config) => {
      pluginConfig = {
        ...parseConfig(config as unknown as Record<string, unknown>),
        toolPermissions: fileConfig.toolPermissions,
        forcedAskTools: fileConfig.forcedAskTools,
      };

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

    event: async ({ event }) => {
      if (!pluginConfig?.enabled) return;
      switch (event.type) {
        case "permission.asked": {
          const callID = event.properties.tool?.callID;
          if (callID === undefined) return;

          const permission: { status: "ask" | "deny" | "allow" } = { status: "ask" };
          handlePermissionAsk({ callID }, permission);
          if (permission.status === "ask") return;

          await input.client.postSessionIdPermissionsPermissionId({
            path: { id: event.properties.sessionID, permissionID: event.properties.id },
            body: { response: permission.status === "allow" ? "once" : "reject" },
          });
          return;
        }
        default:
          return;
      }
    },
  };

  return hooks;
};

export default BashGuardPlugin;
