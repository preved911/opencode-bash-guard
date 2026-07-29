import { describe, it, expect, beforeEach } from "vitest";
import { resolveSegment, resolveChain, beforeExecute, handlePermissionAsk, clearStoredDecision, isComplexChain, buildReadabilityMessage } from "../enforce.js";
import type { PluginConfig } from "../config.js";

const defaultConfig: PluginConfig = {
  bashRules: [
    { pattern: "*", action: "ask" },
    { pattern: "git *", action: "allow" },
    { pattern: "sudo *", action: "deny" },
  ],
  externalDirectoryRules: [
    { pattern: "./**", action: "allow" },
  ],
  externalDirectoryDefault: "ask",
  enabled: true,
};

describe("resolveSegment", () => {
  it("bash deny overrides everything", () => {
    const action = resolveSegment("sudo rm -rf /", "sudo rm -rf /", "/project", defaultConfig);
    expect(action).toBe("deny");
  });

  it("external_directory violation triggers its action", () => {
    const action = resolveSegment("cat /etc/passwd", "cat /etc/passwd", "/project", defaultConfig);
    const configNoMatch: PluginConfig = {
      ...defaultConfig,
      bashRules: [{ pattern: "*", action: "ask" }],
    };
    const act = resolveSegment("cat /etc/passwd", "cat", "/project", configNoMatch);
    expect(act).not.toBeNull();
  });

  it("most restrictive wins across checks", () => {
    const config: PluginConfig = {
      bashRules: [{ pattern: "*", action: "ask" }],
      externalDirectoryRules: [{ pattern: "*", action: "deny" }],
      externalDirectoryDefault: null,
      enabled: true,
    };
    const action = resolveSegment("cat /etc/passwd", "cat", "/project", config);
    expect(action).toBe("deny");
  });

  it("no check triggers returns null", () => {
    const config: PluginConfig = {
      bashRules: [],
      externalDirectoryRules: [],
      externalDirectoryDefault: null,
      enabled: true,
    };
    const action = resolveSegment("ls", "ls", "/", config);
    expect(action).toBeNull();
  });
});

describe("resolveChain", () => {
  it("all segments allowed — chain let through", () => {
    const chain = resolveChain(
      [
        { command: "git status", commandName: "git" },
        { command: "git log", commandName: "git" },
      ],
      "/project",
      defaultConfig,
    );
    expect(chain).toBe("allow");
  });

  it("any segment not allowed — chain takes its action", () => {
    const config: PluginConfig = {
      bashRules: [{ pattern: "git *", action: "allow" }],
      externalDirectoryRules: [],
      externalDirectoryDefault: null,
      enabled: true,
    };
    const chain = resolveChain(
      [
        { command: "git status", commandName: "git" },
        { command: "rm -rf /", commandName: "rm" },
      ],
      "/project",
      config,
    );
    expect(chain).toBeNull();
  });

  it("deny in any segment denies whole chain", () => {
    const chain = resolveChain(
      [
        { command: "git status", commandName: "git" },
        { command: "sudo rm -rf /", commandName: "sudo" },
      ],
      "/project",
      defaultConfig,
    );
    expect(chain).toBe("deny");
  });

  it("single segment with no issues", () => {
    const chain = resolveChain(
      [{ command: "git status", commandName: "git" }],
      "/project",
      defaultConfig,
    );
    expect(chain).toBe("allow");
  });
});

describe("beforeExecute", () => {
  beforeEach(() => {
    clearStoredDecision("test-call-1");
  });

  it("ignores non-Bash tools", () => {
    const result = beforeExecute("Edit", "test-call-1", "/", {}, defaultConfig);
    expect(result.shouldWrap).toBe(false);
  });

  it("handles lowercase bash tool name", () => {
    const result = beforeExecute("bash", "test-call-1", "/", { command: "git status && sudo rm" }, defaultConfig);
    expect(result.chainAction).toBe("deny");
  });

  it("handles capitalized Bash tool name", () => {
    const result = beforeExecute("Bash", "test-call-1", "/", { command: "git status && sudo rm" }, defaultConfig);
    expect(result.chainAction).toBe("deny");
  });

  it("wraps and stores deny for parse errors", () => {
    const result = beforeExecute("Bash", "test-call-1", "/", { command: "echo \"hello" }, defaultConfig);
    expect(result.chainAction).toBe("deny");
  });

  it("returns no action for empty command", () => {
    const result = beforeExecute("Bash", "test-call-1", "/", { command: "" }, defaultConfig);
    expect(result.shouldWrap).toBe(false);
    expect(result.chainAction).toBeNull();
  });

  it("wraps and stores deny for denied chains", () => {
    const result = beforeExecute("Bash", "test-call-1", "/", { command: "sudo rm -rf /" }, defaultConfig);
    expect(result.shouldWrap).toBe(true);
    expect(result.chainAction).toBe("deny");
  });
});

describe("handlePermissionAsk", () => {
  it("sets status to deny for stored deny decisions", () => {
    beforeExecute("Bash", "deny-call", "/", { command: "sudo rm -rf /" }, defaultConfig);
    const output = { status: "ask" as const };
    handlePermissionAsk({ callID: "deny-call" }, output);
    expect(output.status).toBe("deny");
  });

  it("does nothing for stored ask decisions", () => {
    const config: PluginConfig = {
      bashRules: [{ pattern: "*", action: "ask" }],
      externalDirectoryRules: [],
      externalDirectoryDefault: null,
      enabled: true,
    };
    beforeExecute("Bash", "ask-call", "/", { command: "some-unknown-cmd" }, config);
    const output = { status: "ask" as const };
    handlePermissionAsk({ callID: "ask-call" }, output);
    expect(output.status).toBe("ask");
  });

  it("does nothing when no decision stored", () => {
    const output = { status: "ask" as const };
    handlePermissionAsk({ callID: "nonexistent" }, output);
    expect(output.status).toBe("ask");
  });
});

describe("isComplexChain", () => {
  it("returns true for pipe chain", () => {
    expect(isComplexChain("cat log.txt | grep error | sort")).toBe(true);
  });

  it("returns true for && chain", () => {
    expect(isComplexChain("cd src && npm run build && npm test")).toBe(true);
  });

  it("returns false for single command", () => {
    expect(isComplexChain("git status")).toBe(false);
  });

  it("returns false for single command with arguments", () => {
    expect(isComplexChain("npm run build -- --watch")).toBe(false);
  });

  it("returns true for semicolon chain", () => {
    expect(isComplexChain("echo hello; echo world")).toBe(true);
  });

  it("returns true for mixed operators", () => {
    expect(isComplexChain("cd src && cat package.json | grep name")).toBe(true);
  });

  it("returns false for command with nested substitution only", () => {
    expect(isComplexChain('cat $(find . -name "*.txt")')).toBe(false);
  });
});

describe("readabilityRejection", () => {
  const askConfig: PluginConfig = {
    bashRules: [
      { pattern: "*", action: "ask" },
    ],
    externalDirectoryRules: [{ pattern: "./**", action: "allow" }],
    externalDirectoryDefault: null,
    enabled: true,
  };

  const gitConfig: PluginConfig = {
    bashRules: [
      { pattern: "*", action: "ask" },
      { pattern: "git *", action: "allow" },
      { pattern: "npm *", action: "allow" },
    ],
    externalDirectoryRules: [{ pattern: "./**", action: "allow" }],
    externalDirectoryDefault: null,
    enabled: true,
  };

  beforeEach(() => {
    clearStoredDecision("test-readability");
  });

  it("rejects complex chain with readabilityReject=true when action would be ask", () => {
    const result = beforeExecute("Bash", "test-readability", "/project", { command: "echo hi && echo there" }, askConfig);
    expect(result.readabilityReject).toBe(true);
    expect(result.chainAction).toBe("deny");
    expect(result.shouldWrap).toBe(true);
  });

  it("rejects mixed chain with readabilityReject=true when one segment triggers ask", () => {
    const result = beforeExecute("Bash", "test-readability", "/project", { command: "npm install good && wget evil.sh" }, gitConfig);
    expect(result.readabilityReject).toBe(true);
    expect(result.chainAction).toBe("deny");
  });

  it("stores deny decision for readability-rejected command", () => {
    beforeExecute("Bash", "test-readability", "/project", { command: "echo hi && echo there" }, askConfig);
    const output = { status: "ask" as const };
    handlePermissionAsk({ callID: "test-readability" }, output);
    expect(output.status).toBe("deny");
  });

  it("does not reject single command that needs ask", () => {
    const result = beforeExecute("Bash", "test-readability", "/project", { command: "wget evil.sh" }, gitConfig);
    expect(result.readabilityReject).toBe(false);
    expect(result.chainAction).toBe("ask");
  });

  it("does not reject complex chain when all segments are denied anyway", () => {
    const denyConfig: PluginConfig = {
      bashRules: [{ pattern: "*", action: "deny" }],
      externalDirectoryRules: [],
      externalDirectoryDefault: null,
      enabled: true,
    };
    const result = beforeExecute("Bash", "test-readability", "/project", { command: "echo hi && echo there" }, denyConfig);
    expect(result.readabilityReject).toBe(false);
    expect(result.chainAction).toBe("deny");
  });

  it("does not reject when command is parse error", () => {
    const result = beforeExecute("Bash", "test-readability", "/project", { command: "echo \"hello" }, askConfig);
    expect(result.readabilityReject).toBe(false);
    expect(result.chainAction).toBe("deny");
  });
});

describe("buildReadabilityMessage", () => {
  it("includes the original command in the message", () => {
    const msg = buildReadabilityMessage("echo hi && echo there");
    expect(msg).toContain("echo hi && echo there");
  });

  it("starts with a heredoc", () => {
    const msg = buildReadabilityMessage("echo hi && echo there");
    expect(msg).toContain("OPENGUARD");
  });

  it("ends with exit 1", () => {
    const msg = buildReadabilityMessage("echo hi && echo there");
    expect(msg).toContain("exit 1");
  });
});
