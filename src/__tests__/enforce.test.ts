import { describe, it, expect, beforeEach } from "vitest";
import { resolveSegment, resolveChain, beforeExecute, handlePermissionAsk, clearStoredDecision } from "../enforce.js";
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
