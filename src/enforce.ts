import type { PluginConfig } from "./config.js";
import { parseCommand } from "./parser.js";
import type { RestructureConfig } from "./plugin-config.js";
import { resolveChain } from "./policy.js";
import type { ChainAction } from "./policy.js";
import { checkComplexity, buildRejectionMessage } from "./readability.js";

export type { ChainAction } from "./policy.js";

export type PermissionOverride = "allow" | "deny";

export interface BeforeExecuteResult {
  readonly shouldWrap: boolean;
  readonly chainAction: ChainAction;
  /** Set when the restructure feature rejects the command; the adapter throws this message. */
  readonly rejectionMessage: string | null;
  readonly permissionOverride: PermissionOverride | null;
}

export function beforeExecute(
  tool: string,
  cwd: string,
  args: { readonly command?: string },
  config: PluginConfig,
  restructure: RestructureConfig = { enabled: false, maxSegments: 3, maxDepth: 2 },
  degraded = false,
): BeforeExecuteResult {
  const noAction: BeforeExecuteResult = {
    shouldWrap: false,
    chainAction: null,
    rejectionMessage: null,
    permissionOverride: null,
  };

  if (tool.toLowerCase() !== "bash") {
    return noAction;
  }

  const command = args.command;
  if (!command || command.trim().length === 0) {
    return noAction;
  }

  const chain = parseCommand(command);
  if (chain.parseError || chain.invocations.length === 0) {
    return { shouldWrap: true, chainAction: "deny", rejectionMessage: null, permissionOverride: "deny" };
  }

  // Degraded mode (broken plugin config): args rules are gone and glob allows are suspended —
  // everything asks, so a config typo can never silently re-allow a restricted command.
  if (degraded) {
    return { shouldWrap: true, chainAction: "ask", rejectionMessage: null, permissionOverride: null };
  }

  const { action, allowFromArgsRule } = resolveChain(chain.invocations, cwd, config);

  if (action === null || action === "allow") {
    return {
      shouldWrap: false,
      chainAction: action,
      rejectionMessage: null,
      permissionOverride: action === "allow" && allowFromArgsRule ? "allow" : null,
    };
  }

  if (action === "ask" && restructure.enabled) {
    const violation = checkComplexity(command, chain, restructure);
    if (violation) {
      return {
        shouldWrap: false,
        chainAction: "ask",
        rejectionMessage: buildRejectionMessage(violation, chain, command),
        permissionOverride: null,
      };
    }
  }

  if (action === "deny" || action === "ask") {
    return {
      shouldWrap: true,
      chainAction: action,
      rejectionMessage: null,
      permissionOverride: action === "deny" ? "deny" : null,
    };
  }

  const exhaustiveAction: never = action;
  return exhaustiveAction;
}
