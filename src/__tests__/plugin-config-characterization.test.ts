import { describe, it, expect, vi, afterEach } from "vitest";
import { parsePluginConfig, DEFAULT_PLUGIN_FILE_CONFIG } from "../plugin-config.js";
import type { PluginConfigFile } from "../plugin-config.js";
import { validateToolPermissions, matchToolPermissions } from "../config.js";
import { parseCommand as parseChain } from "../parser.js";

/**
 * Characterization tests (task 1.2): lock matcherVersion 2 JSONC configuration
 * behavior — comments/trailing commas, global→project deep-merge precedence,
 * marker-source rules, invalid markers, invalid JSONC, invalid entries, warning
 * paths, scoped forced-ask, and global degraded ask-everything.
 */

function file(p: string, content: string): PluginConfigFile {
  return { path: p, content };
}

const argvOf = (command: string): string[] => parseChain(command).invocations[0]?.argv ?? command.split(/\s+/);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("characterization: JSONC syntax tolerance", () => {
  it("comments and trailing commas are accepted", () => {
    const content = `{
      // line comment
      "restructure": {
        "enabled": true, // opt in
        "max_segments": 4,
      },
    }`;
    const result = parsePluginConfig([file("global.jsonc", content)]);
    expect(result.restructure).toEqual({ enabled: true, maxSegments: 4, maxDepth: 2 });
    expect(result.degraded).toBe(false);
  });
});

describe("characterization: global then project deep-merge precedence", () => {
  it("project overrides global scalars; unset project fields fall back to global", () => {
    const globalFile = file("global.jsonc", '{"restructure": { "enabled": true, "max_segments": 3 }}');
    const projectFile = file("project.jsonc", '{"restructure": { "max_segments": 5 }}');
    const result = parsePluginConfig([globalFile, projectFile]);
    expect(result.restructure).toEqual({ enabled: true, maxSegments: 5, maxDepth: 2 });
  });

  it("objects deep-merge; arrays override wholesale", () => {
    const globalFile = file("global.jsonc", '{"restructure": { "enabled": true }, "permissions": [{ "tool": "a", "args": [] }]}');
    const projectFile = file("project.jsonc", '{"permissions": [{ "tool": "b", "args": [] }]}');
    const result = parsePluginConfig([globalFile, projectFile]);
    expect(result.toolPermissions.map((e) => e.tool)).toEqual(["b"]);
  });
});

describe("characterization: matcherVersion marker rules", () => {
  it("permissions with matcherVersion 2 in the same source → honored", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const content = '{"matcherVersion": 2, "permissions": [{ "tool": "git", "args": [{ "token": ["push"], "action": "allow" }] }]}';
    const result = parsePluginConfig([file("global.jsonc", content)]);
    expect(result.degraded).toBe(false);
    expect(result.forcedAskTools).toEqual([]);
    expect(result.toolPermissions).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("permissions without marker in the effective source → unmigrated: scoped ask + warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const content = '{"permissions": [{ "tool": "git", "args": [{ "token": ["push"], "action": "allow" }] }]}';
    const result = parsePluginConfig([file("global.jsonc", content)]);
    expect(result.degraded).toBe(false);
    expect(result.forcedAskTools).toEqual(["git"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Unmigrated permissions"));
  });

  it("marker in a different source than permissions → ignored with warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const globalFile = file("global.jsonc", '{"matcherVersion": 2}');
    const projectFile = file("project.jsonc", '{"permissions": [{ "tool": "git", "args": [{ "token": ["push"], "action": "allow" }] }]}');
    const result = parsePluginConfig([globalFile, projectFile]);
    expect(result.forcedAskTools).toEqual(["git"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Ignoring matcherVersion"));
  });

  it("non-2 marker value → global degraded ask-everything", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const content = '{"matcherVersion": 3, "permissions": [{ "tool": "git", "args": [{ "token": ["push"], "action": "allow" }] }]}';
    const result = parsePluginConfig([file("global.jsonc", content)]);
    expect(result.degraded).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Invalid matcherVersion"));
  });

  it("marker without permissions at all → no effect, but source-mismatch warning fires", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = parsePluginConfig([file("global.jsonc", '{"matcherVersion": 2}')]);
    expect(result.degraded).toBe(false);
    expect(result.toolPermissions).toEqual([]);
    expect(result.forcedAskTools).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Ignoring matcherVersion"));
  });
});

describe("characterization: invalid JSONC → global degraded ask-everything", () => {
  it("broken file degrades globally and disables restructure", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const good = file("global.jsonc", '{"restructure": { "enabled": true }}');
    const bad = file("project.jsonc", '{"restructure": { "enabled": true,,,, }}');
    const result = parsePluginConfig([good, bad]);
    expect(result.degraded).toBe(true);
    expect(result.restructure.enabled).toBe(false);
    expect(result.toolPermissions).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("project.jsonc"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("degraded mode"));
  });

  it("degraded mode suspends glob allows downstream (ask-everything parity)", () => {
    // The degraded flag is consumed by the adapter/enforcement layer; here we lock
    // that parsePluginConfig reports it and clears toolPermissions.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = parsePluginConfig([file("bad.jsonc", "not json at all")]);
    expect(result.degraded).toBe(true);
    expect(result.toolPermissions).toEqual([]);
  });
});

describe("characterization: invalid individual entries → scoped forced-ask", () => {
  it("invalid entry drops the rule and scopes ask to its tool; valid siblings keep working", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const content = `{
      "matcherVersion": 2,
      "permissions": [
        { "tool": "git", "args": [{ "token": ["push"], "action": "allow" }] },
        { "tool": "find", "args": [{ "token": "-delete", "position": 0, "action": "deny" }] }
      ]
    }`;
    const result = parsePluginConfig([file("global.jsonc", content)]);
    expect(result.degraded).toBe(false);
    expect(result.toolPermissions.map((e) => e.tool)).toEqual(["git"]);
    expect(result.forcedAskTools).toEqual(["find"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("find"));
  });

  it("invalid entry with no determinable tool → global degraded ask", () => {
    const messages: string[] = [];
    const result = validateToolPermissions([{ args: [{ token: "-x", action: "deny" }] }], (m) => messages.push(m));
    expect(result.globalDegraded).toBe(true);
    expect(result.entries).toHaveLength(0);
    expect(messages).toHaveLength(1);
  });

  it("non-array permissions → global degraded ask", () => {
    const result = validateToolPermissions("nope");
    expect(result.globalDegraded).toBe(true);
    expect(result.entries).toHaveLength(0);
  });
});

describe("characterization: warning paths fire once per key", () => {
  it("arity conflict warning is one-time per tool+flag", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const entries = [
      { tool: "git", args: [{ token: ["push"], action: "allow" as const }], flags: { "--force": 1 as const } },
      { tool: "git", args: [{ token: ["pull"], action: "allow" as const }], flags: { "--force": 0 as const } },
    ];
    matchToolPermissions(argvOf("git push --force x"), entries);
    matchToolPermissions(argvOf("git push --force x"), entries);
    const calls = warn.mock.calls.filter((c) => String(c[0]).includes("Conflicting flags declarations"));
    expect(calls).toHaveLength(1);
  });

  it("value matcher on a 0-declared flag suspends the tool into scoped ask", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const entries = [
      { tool: "tool", args: [{ token: "--mode", pattern: "safe", action: "allow" as const }], flags: { "--mode": 0 as const } },
    ];
    expect(matchToolPermissions(argvOf("tool --mode safe"), entries)).toBe("ask");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("suspending args policy"));
  });
});

describe("characterization: absent file/section = zero behavior change", () => {
  it("no files → exact defaults", () => {
    expect(parsePluginConfig([])).toEqual(DEFAULT_PLUGIN_FILE_CONFIG);
  });

  it("file without permissions/restructure sections → defaults, not degraded", () => {
    const result = parsePluginConfig([file("global.jsonc", '{"other": true}')]);
    expect(result).toEqual(DEFAULT_PLUGIN_FILE_CONFIG);
  });
});
