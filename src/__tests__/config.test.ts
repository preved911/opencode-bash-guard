import { describe, it, expect } from "vitest";
import { parseConfig, matchBashPermission, matchExternalDirectory } from "../config.js";

describe("parseConfig", () => {
  it("parses object form with patterns", () => {
    const config = { permission: { bash: { "*": "ask", "git *": "allow" } } };
    const result = parseConfig(config);
    expect(result.bashRules).toHaveLength(2);
    expect(result.bashRules[0]).toEqual({ pattern: "*", action: "ask" });
    expect(result.bashRules[1]).toEqual({ pattern: "git *", action: "allow" });
    expect(result.enabled).toBe(true);
  });

  it("parses flat string form", () => {
    const config = { permission: { bash: "ask" } };
    const result = parseConfig(config);
    expect(result.bashRules).toHaveLength(1);
    expect(result.bashRules[0]).toEqual({ pattern: "*", action: "ask" });
    expect(result.enabled).toBe(true);
  });

  it("handles no bash config at top level", () => {
    const config = { permission: {} };
    const result = parseConfig(config);
    expect(result.bashRules).toHaveLength(0);
    expect(result.enabled).toBe(false);
  });

  it("parses external_directory with object patterns", () => {
    const config = { permission: { external_directory: { "~/projects/**": "allow", "*": "ask" } } };
    const result = parseConfig(config);
    expect(result.externalDirectoryRules).toHaveLength(2);
    expect(result.externalDirectoryRules[0]).toEqual({ pattern: "~/projects/**", action: "allow" });
    expect(result.externalDirectoryRules[1]).toEqual({ pattern: "*", action: "ask" });
    expect(result.externalDirectoryDefault).toBeNull();
  });

  it("parses external_directory flat string", () => {
    const config = { permission: { external_directory: "ask" } };
    const result = parseConfig(config);
    expect(result.externalDirectoryDefault).toBe("ask");
    expect(result.externalDirectoryRules).toHaveLength(0);
  });

  it("detects bash:allow and disables", () => {
    const config = { permission: { bash: "allow" } };
    const result = parseConfig(config);
    expect(result.enabled).toBe(false);
  });

  it("detects wildcard allow and disables", () => {
    const config = { permission: { bash: { "*": "allow", "git *": "allow" } } };
    const result = parseConfig(config);
    expect(result.enabled).toBe(false);
  });
});

describe("matchBashPermission", () => {
  const rules = [
    { pattern: "*", action: "ask" as const },
    { pattern: "git *", action: "allow" as const },
    { pattern: "sudo *", action: "deny" as const },
  ];

  it("matches allow pattern", () => {
    expect(matchBashPermission("git status", rules)).toBe("allow");
  });

  it("matches deny pattern", () => {
    expect(matchBashPermission("sudo rm -rf /", rules)).toBe("deny");
  });

  it("falls through to catch-all", () => {
    expect(matchBashPermission("unknown-cmd", rules)).toBe("ask");
  });

  it("returns null when no pattern matches", () => {
    expect(matchBashPermission("some-command", [])).toBeNull();
  });

  it("last matching rule wins", () => {
    const orderedRules = [
      { pattern: "git *", action: "ask" as const },
      { pattern: "git status", action: "allow" as const },
    ];
    expect(matchBashPermission("git status", orderedRules)).toBe("allow");
  });
});

describe("matchExternalDirectory", () => {
  const rules = [
    { pattern: "./**", action: "allow" as const },
    { pattern: "/home/**", action: "allow" as const },
  ];

  it("path inside allowed directory returns no violation", () => {
    const result = matchExternalDirectory("/project/src", rules, null);
    expect(result.violated).toBe(false);
  });

  it("path outside allowed directory returns violation with default", () => {
    const result = matchExternalDirectory("/etc/passwd", rules, "ask");
    expect(result.violated).toBe(true);
    expect(result.action).toBe("ask");
  });

  it("no match and no default returns no violation", () => {
    const result = matchExternalDirectory("/etc/passwd", rules, null);
    expect(result.violated).toBe(false);
    expect(result.action).toBeNull();
  });
});
