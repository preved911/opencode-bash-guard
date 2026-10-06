import type { PluginConfig } from "./config.js";
import { parseCommand } from "./parser.js";
import type { RestructureConfig } from "./plugin-config.js";
import { resolveChain } from "./policy.js";
import type { ChainAction } from "./policy.js";
import { checkComplexity, buildRejectionMessage } from "./readability.js";

/**
 * Stateless enforcement orchestration between pure command evaluation and the
 * OpenCode adapter. Lifecycle state belongs exclusively to the adapter.
 */

export type { ChainAction } from "./policy.js";

export interface BeforeExecuteResult {
  readonly shouldWrap: boolean;
  readonly chainAction: ChainAction;
  readonly permissionOverride: "allow" | "deny" | null;
  /** Set when the restructure feature rejects the command; the adapter throws this message. */
  readonly rejectionMessage: string | null;
}

export interface CommandArguments {
  readonly command?: unknown;
}

export function beforeExecute(
  tool: string,
  cwd: string,
  args: CommandArguments | undefined,
  config: PluginConfig,
  restructure: RestructureConfig = { enabled: false, maxSegments: 3, maxDepth: 2 },
  degraded = false,
): BeforeExecuteResult {
  const noAction: BeforeExecuteResult = {
    shouldWrap: false,
    chainAction: null,
    permissionOverride: null,
    rejectionMessage: null,
  };

  if (tool.toLowerCase() !== "bash") {
    return noAction;
  }

  const command = typeof args?.command === "string" ? args.command : undefined;
  if (!command || command.trim().length === 0) {
    return noAction;
  }

  const chain = parseCommand(command);
  if (chain.parseError || chain.invocations.length === 0) {
    return { shouldWrap: true, chainAction: "deny", permissionOverride: "deny", rejectionMessage: null };
  }

  // Degraded mode (broken plugin config): args rules are gone and glob allows are suspended —
  // everything asks, so a config typo can never silently re-allow a restricted command.
  if (degraded) {
    return { shouldWrap: true, chainAction: "ask", permissionOverride: null, rejectionMessage: null };
  }

  const { action, allowFromArgsRule } = resolveChain(chain.invocations, cwd, config);

  if (action === null || action === "allow") {
    return {
      shouldWrap: false,
      chainAction: action,
      permissionOverride: action === "allow" && allowFromArgsRule ? "allow" : null,
      rejectionMessage: null,
    };
  }

  if (action === "ask" && restructure.enabled) {
    const violation = checkComplexity(command, chain, restructure);
    if (violation) {
      return {
        shouldWrap: false,
        chainAction: "ask",
        permissionOverride: null,
        rejectionMessage: buildRejectionMessage(violation, chain, command),
      };
    }
  }

  if (action === "deny" || action === "ask") {
    return {
      shouldWrap: true,
      chainAction: action,
      permissionOverride: action === "deny" ? "deny" : null,
      rejectionMessage: null,
    };
  }

  return noAction;
}
