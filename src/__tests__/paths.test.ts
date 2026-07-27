import { describe, it, expect } from "vitest";
import { extractPaths, extractPotentialPaths } from "../paths.js";

describe("extractPaths", () => {
  it("extracts path arguments and resolves relative paths", () => {
    const paths = extractPaths("grep -r pattern ./src", "/project");
    expect(paths.length).toBeGreaterThan(0);
    const srcPath = paths.find((p) => p.original === "./src");
    expect(srcPath).toBeDefined();
    expect(srcPath!.resolved).toBe("/project/src");
  });

  it("returns no paths for command with no arguments", () => {
    const paths = extractPaths("ls", "/");
    expect(paths).toHaveLength(0);
  });

  it("skips flag arguments", () => {
    const paths = extractPaths("ls -la -r", "/");
    expect(paths).toHaveLength(0);
  });

  it("resolves tilde to home directory", () => {
    const paths = extractPaths("cat ~/.ssh/config", "/");
    const tildePath = paths.find((p) => p.original === "~/.ssh/config");
    expect(tildePath).toBeDefined();
    expect(tildePath!.resolved).toContain("/.ssh/config");
  });

  it("resolves absolute paths", () => {
    const paths = extractPaths("cat /etc/hosts", "/");
    const etcPath = paths.find((p) => p.original === "/etc/hosts");
    expect(etcPath).toBeDefined();
    expect(etcPath!.resolved).toBe("/etc/hosts");
  });
});

describe("extractPotentialPaths", () => {
  it("filters out flag tokens", () => {
    const paths = extractPotentialPaths("ls -la -r");
    expect(paths).toHaveLength(0);
  });

  it("keeps non-flag tokens", () => {
    const paths = extractPotentialPaths("cat /etc/passwd");
    expect(paths).toContain("/etc/passwd");
  });
});
