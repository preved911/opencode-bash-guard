import { describe, it, expect } from "vitest";
import os from "os";
import path from "path";
import { resolveCandidatePaths, resolvePath } from "../paths.js";
import { parseCommand as parseChain } from "../parser.js";
import type { NormalizedInvocation } from "../parser.js";

function invocationOf(command: string): NormalizedInvocation {
  const parsed = parseChain(command).invocations[0];
  if (!parsed) throw new Error(`unparseable fixture: ${command}`);
  return parsed;
}

describe("resolveCandidatePaths", () => {
  it("extracts path arguments and resolves relative paths", () => {
    const paths = resolveCandidatePaths(invocationOf("grep -r pattern ./src"), "/project");
    expect(paths.length).toBeGreaterThan(0);
    const srcPath = paths.find((p) => p.original === "./src");
    expect(srcPath).toBeDefined();
    expect(srcPath!.resolved).toBe("/project/src");
  });

  it("returns no paths for command with no arguments", () => {
    const paths = resolveCandidatePaths(invocationOf("ls"), "/");
    expect(paths).toHaveLength(0);
  });

  it("skips flag arguments", () => {
    const paths = resolveCandidatePaths(invocationOf("ls -la -r"), "/");
    expect(paths).toHaveLength(0);
  });

  it("resolves tilde to home directory", () => {
    const paths = resolveCandidatePaths(invocationOf("cat ~/.ssh/config"), "/");
    const tildePath = paths.find((p) => p.original === "~/.ssh/config");
    expect(tildePath).toBeDefined();
    expect(tildePath!.resolved).toContain("/.ssh/config");
    expect(tildePath!.requiresConfirmation).toBe(false);
  });

  it("marks named-user tilde paths as unresolved", () => {
    const paths = resolveCandidatePaths(invocationOf("cat ~other/.ssh/config"), "/project");
    expect(paths).toContainEqual({
      original: "~other/.ssh/config",
      resolved: "~other/.ssh/config",
      requiresConfirmation: true,
    });
  });

  it("resolves absolute paths", () => {
    const paths = resolveCandidatePaths(invocationOf("cat /etc/hosts"), "/");
    const etcPath = paths.find((p) => p.original === "/etc/hosts");
    expect(etcPath).toBeDefined();
    expect(etcPath!.resolved).toBe("/etc/hosts");
  });
});

describe("resolvePath", () => {
  it("bare tilde resolves to homedir", () => {
    expect(resolvePath("~", "/project")).toBe(os.homedir());
  });

  it("tilde resolves against homedir", () => {
    expect(resolvePath("~/.ssh/config", "/")).toBe(path.join(os.homedir(), ".ssh", "config"));
  });

  it("named-user tilde remains unresolved", () => {
    expect(resolvePath("~other/.ssh/config", "/project")).toBe("~other/.ssh/config");
  });

  it("absolute resolves to itself", () => {
    expect(resolvePath("/etc/hosts", "/project")).toBe("/etc/hosts");
  });

  it("relative resolves against cwd", () => {
    expect(resolvePath("src/a.txt", "/project")).toBe("/project/src/a.txt");
  });
});
