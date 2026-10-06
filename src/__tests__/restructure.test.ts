import { describe, it, expect } from "vitest";
import { beforeExecute } from "../enforce.js";
import type { PluginConfig } from "../config.js";
import type { RestructureConfig } from "../plugin-config.js";
import { parseCommand as parseChain } from "../parser.js";

const baseConfig: PluginConfig = {
  bashRules: [
    { pattern: "*", action: "ask" },
    { pattern: "git *", action: "allow" },
    { pattern: "npm *", action: "allow" },
  ],
  editRules: [],
  externalDirectoryRules: [{ pattern: "./**", action: "allow" }],
  externalDirectoryDefault: "ask",
  toolPermissions: [],
  enabled: true,
};

const enabled: RestructureConfig = { enabled: true, maxSegments: 3, maxDepth: 2 };
const disabled: RestructureConfig = { enabled: false, maxSegments: 3, maxDepth: 2 };

describe("restructure integration", () => {
  it("4.1 multi-line re-issue: 4-line script parses into 4 segments, each checked independently", () => {
    const cmd = "git status\ngit log\ngit diff\nrm -rf /tmp/x";
    const chain = parseChain(cmd);
    expect(chain.invocations.map((s) => s.commandName)).toEqual(["git", "git", "git", "rm"]);

    const result = beforeExecute("Bash", "/project", { command: cmd }, baseConfig, enabled);
    expect(result.rejectionMessage).toBeNull();
    expect(result.chainAction).toBe("ask");
    expect(result.shouldWrap).toBe(true);

    const allowedVariant = "git status\ngit log\ngit diff\ngit show";
    const allowedResult = beforeExecute("Bash", "/project", { command: allowedVariant }, baseConfig, enabled);
    expect(allowedResult.chainAction).toBe("allow");
    expect(allowedResult.shouldWrap).toBe(false);
  });

  it("4.2 separate-calls re-issue: single-segment commands evaluate normally", () => {
    const allowed = beforeExecute("Bash", "/project", { command: "git status" }, baseConfig, enabled);
    expect(allowed.chainAction).toBe("allow");
    expect(allowed.rejectionMessage).toBeNull();

    const asking = beforeExecute("Bash", "/project", { command: "wget evil.sh" }, baseConfig, enabled);
    expect(asking.chainAction).toBe("ask");
    expect(asking.rejectionMessage).toBeNull();
    expect(asking.shouldWrap).toBe(true);
  });

  it("4.3 disabled → zero rejections across all commands", () => {
    const commands = [
      "a && b && c && d && e",
      "git status && rm -rf /tmp/x && echo ok && ls",
      "echo $(echo $(whoami))",
      `python3 -c "import os; os.system('a'); os.system('b'); os.system('c'); os.system('d')"`,
    ];
    for (const cmd of commands) {
      const result = beforeExecute("Bash", "/project", { command: cmd }, baseConfig, disabled);
      expect(result.rejectionMessage).toBeNull();
    }
  });

  it("4.3 enabled with defaults: 3-segment chain passes, 4-segment ask chain rejected", () => {
    const atLimit = beforeExecute("Bash", "/project", { command: "git a && git b && rm -rf /tmp/x" }, baseConfig, enabled);
    expect(atLimit.rejectionMessage).toBeNull();
    expect(atLimit.chainAction).toBe("ask");

    const overLimit = beforeExecute("Bash", "/project", { command: "git a && git b && git c && rm -rf /tmp/x" }, baseConfig, enabled);
    expect(overLimit.rejectionMessage).not.toBeNull();
  });

  it("4.3 custom thresholds honored", () => {
    const custom: RestructureConfig = { enabled: true, maxSegments: 2, maxDepth: 1 };
    const result = beforeExecute("Bash", "/project", { command: "git a && git b && rm -rf /tmp/x" }, baseConfig, custom);
    expect(result.rejectionMessage).not.toBeNull();
    expect(result.rejectionMessage).toContain("3 chained commands");
  });

  it("4.3 depth-only rejection reports nesting depth without absent segment fields", () => {
    const result = beforeExecute("Bash", "/project", { command: "echo $(echo $(whoami))" }, baseConfig, enabled);
    expect(result.rejectionMessage).toBe(
      "[opencode-bash-guard] Complex one-liner rejected (nesting depth 3).\n" +
        "Re-issue as separate bash tool calls, or as a multi-line script with one command per line — each command is then permission-checked individually.",
    );
  });

  it("4.4 2-line script of long && chains on ask-resolving chain rejected with line-scoped message", () => {
    const cmd = "git a && git b && git c && git d && rm -rf /tmp/x\ngit e && git f && git g && git h && rm -rf /tmp/y";
    const result = beforeExecute("Bash", "/project", { command: cmd }, baseConfig, enabled);
    expect(result.rejectionMessage).not.toBeNull();
    expect(result.rejectionMessage).toContain("Complex command rejected (line 1: 5 chained commands");

    expect(result.permissionOverride).toBeNull();
  });
});
