import { describe, it, expect } from "vitest";
import { parseConfig, matchBashPermission, matchExternalDirectory, matchToolPermissions, mostRestrictive } from "../config.js";
import { parseChain } from "../chain.js";
import { resolveSegment, resolveChain } from "../enforce.js";
import type { PluginConfig } from "../config.js";
import type { NormalizedInvocation } from "../parser.js";

/**
 * Characterization tests (task 1.3): lock native configuration parsing and pure
 * policy semantics — flat/object permission.bash, absent-key defaults, self-disable,
 * external_directory default ask, args matcher refinement/incomparability, ordered
 * anchoring, `--`/`=` forms, arity conflicts, most-restrictive decisions, glob
 * fallback, candidate paths, redirects, and chain aggregation.
 */

const argvOf = (command: string): string[] => parseChain(command).invocations[0]?.argv ?? command.split(/\s+/);

function seg(command: string, redirects: NormalizedInvocation["redirects"] = []): NormalizedInvocation {
  const parsed = parseChain(command).invocations[0];
  if (!parsed) throw new Error(`unparseable fixture: ${command}`);
  return redirects.length > 0 ? { ...parsed, redirects } : parsed;
}

const inv = seg;

describe("characterization: native permission.bash parsing", () => {
  it("object form parses patterns in declaration order", () => {
    const result = parseConfig({ permission: { bash: { "*": "ask", "git *": "allow" } } });
    expect(result.bashRules).toEqual([
      { pattern: "*", action: "ask" },
      { pattern: "git *", action: "allow" },
    ]);
    expect(result.enabled).toBe(true);
  });

  it("flat string form becomes a single catch-all rule", () => {
    const result = parseConfig({ permission: { bash: "ask" } });
    expect(result.bashRules).toEqual([{ pattern: "*", action: "ask" }]);
    expect(result.enabled).toBe(true);
  });

  it("absent bash key → no rules, plugin disabled (native default allow)", () => {
    const result = parseConfig({});
    expect(result.bashRules).toHaveLength(0);
    expect(result.enabled).toBe(false);
  });

  it("bash:allow disables the plugin", () => {
    expect(parseConfig({ permission: { bash: "allow" } }).enabled).toBe(false);
  });

  it("wildcard allow disables the plugin", () => {
    expect(parseConfig({ permission: { bash: { "*": "allow" } } }).enabled).toBe(false);
  });

  it("invalid action values in object form degrade to ask", () => {
    const result = parseConfig({ permission: { bash: { "git *": "banana" } } });
    expect(result.bashRules).toEqual([{ pattern: "git *", action: "ask" }]);
  });

  it("edit rules parse like bash rules; absent edit → no edit rules", () => {
    expect(parseConfig({ permission: { edit: "deny" } }).editRules).toEqual([{ pattern: "*", action: "deny" }]);
    expect(parseConfig({ permission: { bash: { "*": "ask" } } }).editRules).toHaveLength(0);
  });
});

describe("characterization: external_directory defaults and overrides", () => {
  it("absent external_directory → hardcoded default ask", () => {
    const result = parseConfig({ permission: { bash: { "*": "ask" } } });
    expect(result.externalDirectoryDefault).toBe("ask");
    expect(result.externalDirectoryRules).toHaveLength(0);
  });

  it("flat string sets the default; object form sets rules with null default", () => {
    expect(parseConfig({ permission: { external_directory: "ask" } }).externalDirectoryDefault).toBe("ask");
    const obj = parseConfig({ permission: { external_directory: { "./**": "allow", "*": "ask" } } });
    expect(obj.externalDirectoryDefault).toBeNull();
    expect(obj.externalDirectoryRules).toHaveLength(2);
  });

  it("invalid actions inside object form are skipped", () => {
    const result = parseConfig({ permission: { external_directory: { "/x/**": "nope", "/y/**": "deny" } } });
    expect(result.externalDirectoryRules).toEqual([{ pattern: "/y/**", action: "deny" }]);
  });
});

describe("characterization: glob evaluation", () => {
  const rules = [
    { pattern: "*", action: "ask" as const },
    { pattern: "git *", action: "allow" as const },
    { pattern: "sudo *", action: "deny" as const },
  ];

  it("last matching rule wins", () => {
    expect(matchBashPermission("git status", rules)).toBe("allow");
  });

  it("trailing space-star is optional: git * matches bare git", () => {
    expect(matchBashPermission("git", [{ pattern: "git *", action: "allow" as const }])).toBe("allow");
  });

  it("dotAll: * crosses newlines (issue #28 parity)", () => {
    const segment = 'python3 -c "import os\nos.system(\'a\')"';
    expect(matchBashPermission(segment, [{ pattern: "*", action: "ask" as const }])).toBe("ask");
    expect(matchBashPermission(segment, [{ pattern: "*", action: "ask" as const }, { pattern: "python3 *", action: "allow" as const }])).toBe("allow");
  });

  it("no match → null", () => {
    expect(matchBashPermission("unknown", [])).toBeNull();
  });
});

describe("characterization: external directory matching", () => {
  const rules = [
    { pattern: "./**", action: "allow" as const },
    { pattern: "/home/**", action: "allow" as const },
  ];

  it("path inside allowed directory → no violation", () => {
    expect(matchExternalDirectory("/project/src", rules, null, "/project")).toEqual({ violated: false, action: null });
  });

  it("path outside → violation with default action", () => {
    expect(matchExternalDirectory("/etc/passwd", rules, "ask", "/project")).toEqual({ violated: true, action: "ask" });
  });

  it("./ pattern resolves relative to cwd", () => {
    expect(matchExternalDirectory("/project/src/a.txt", [{ pattern: "./src/**", action: "allow" as const }], "ask", "/project")).toEqual({
      violated: false,
      action: null,
    });
    expect(matchExternalDirectory("/project/other/a.txt", [{ pattern: "./src/**", action: "allow" as const }], "ask", "/project")).toEqual({
      violated: true,
      action: "ask",
    });
  });

  it("no match and no default → no violation", () => {
    expect(matchExternalDirectory("/etc/passwd", rules, null, "/project")).toEqual({ violated: false, action: null });
  });
});

describe("characterization: args matcher semantics", () => {
  it("ordered anchoring: foreign operand before the path breaks the match", () => {
    const entry = [{ tool: "git", args: [{ token: ["push", "--force"], action: "deny" as const }], flags: { "--force": 1 as const } }];
    expect(matchToolPermissions(argvOf("git stash push --force"), entry)).toBeNull();
    expect(matchToolPermissions(argvOf("git push --force origin main"), entry)).toBe("deny");
  });

  it("-- separator: post-separator operands are positional but never complete a path", () => {
    const entry = [{ tool: "find", args: [{ position: 0, pattern: "/tmp/**", action: "ask" as const }] }];
    expect(matchToolPermissions(argvOf("find -- /tmp/logs"), entry)).toBe("ask");
    const pathEntry = [{ tool: "git", args: [{ token: ["push"], action: "deny" as const }] }];
    expect(matchToolPermissions(argvOf("git -- push"), entry)).toBeNull();
  });

  it("= form: inline value counts as a flag value atom", () => {
    const entry = [
      { tool: "kubectl", args: [{ token: ["get"], flagValues: { "--namespace": "kube-system" }, action: "deny" as const }], flags: { "--namespace": 1 as const } },
    ];
    expect(matchToolPermissions(argvOf("kubectl get --namespace=kube-system pods"), entry)).toBe("deny");
    expect(matchToolPermissions(argvOf("kubectl get --namespace kube-system pods"), entry)).toBe("deny");
  });

  it("flag arity conflict resolves to value-less reading with warning", () => {
    const entries = [
      { tool: "git", args: [{ token: ["push"], action: "allow" as const }], flags: { "--force": 1 as const } },
      { tool: "git", args: [{ token: ["pull"], action: "allow" as const }], flags: { "--force": 0 as const } },
    ];
    expect(matchToolPermissions(argvOf("git push --force x"), entries)).toBe("allow");
  });

  it("refinement: specific path rule overrides general one in either direction", () => {
    const entry = [
      {
        tool: "git",
        args: [
          { token: ["push"], action: "deny" as const },
          { token: ["push", "--force-with-lease"], action: "allow" as const },
        ],
        flags: { "--force-with-lease": 0 as const },
      },
    ];
    expect(matchToolPermissions(argvOf("git push --force-with-lease origin"), entry)).toBe("allow");
    expect(matchToolPermissions(argvOf("git push origin"), entry)).toBe("deny");
  });

  it("incomparable rules reduce most-restrictive (deny survives exact-path allow)", () => {
    const entry = [
      {
        tool: "git",
        args: [
          { token: "push", action: "deny" as const },
          { token: ["push", "--force-with-lease"], action: "allow" as const },
        ],
      },
    ];
    expect(matchToolPermissions(argvOf("git push --force-with-lease"), entry)).toBe("deny");
  });

  it("mostRestrictive ordering: deny > ask > allow > null", () => {
    expect(mostRestrictive(["allow", "ask", "deny"])).toBe("deny");
    expect(mostRestrictive(["allow", "ask"])).toBe("ask");
    expect(mostRestrictive(["allow"])).toBe("allow");
    expect(mostRestrictive([])).toBeNull();
  });
});

describe("characterization: segment resolution (glob fallback + paths + redirects)", () => {
  const defaultConfig: PluginConfig = {
    bashRules: [
      { pattern: "*", action: "ask" },
      { pattern: "git *", action: "allow" },
      { pattern: "sudo *", action: "deny" },
    ],
    editRules: [],
    externalDirectoryRules: [{ pattern: "./**", action: "allow" }],
    externalDirectoryDefault: "ask",
    toolPermissions: [],
    enabled: true,
  };

  it("glob allow + external-directory ask → ask", () => {
    const config: PluginConfig = {
      ...defaultConfig,
      bashRules: [{ pattern: "*", action: "ask" }, { pattern: "cat *", action: "allow" }],
    };
    const { action } = resolveSegment(inv("cat /etc/passwd"), "/project", config);
    expect(action).toBe("ask");
  });

  it("candidate path outside cwd with default ask → ask", () => {
    const config: PluginConfig = {
      bashRules: [{ pattern: "*", action: "allow" }],
      editRules: [],
      externalDirectoryRules: [],
      externalDirectoryDefault: "ask",
      toolPermissions: [],
      enabled: true,
    };
    const { action } = resolveSegment(inv("cat /etc/passwd"), "/project", config);
    expect(action).toBe("ask");
  });

  it("well-known redirect contributes nothing", () => {
    const config: PluginConfig = {
      bashRules: [{ pattern: "*", action: "allow" }],
      editRules: [{ pattern: "*", action: "deny" }],
      externalDirectoryRules: [],
      externalDirectoryDefault: null,
      toolPermissions: [],
      enabled: true,
    };
    const { action } = resolveSegment(inv("ls", [
      { operator: ">&", target: "1", fileDescriptor: 2, wellKnown: true },
    ]), "/project", config);
    expect(action).toBe("allow");
  });

  it("file redirect inside cwd checks only edit rules", () => {
    const config: PluginConfig = {
      bashRules: [{ pattern: "*", action: "allow" }],
      editRules: [{ pattern: "/project/**", action: "allow" }],
      externalDirectoryRules: [{ pattern: "*", action: "deny" }],
      externalDirectoryDefault: null,
      toolPermissions: [],
      enabled: true,
    };
    const { action } = resolveSegment(inv("ls", [
      { operator: ">", target: "output.txt", fileDescriptor: undefined, wellKnown: false },
    ]), "/project", config);
    expect(action).toBe("allow");
  });

  it("file redirect outside cwd checks edit + external_directory", () => {
    const config: PluginConfig = {
      bashRules: [{ pattern: "*", action: "allow" }],
      editRules: [{ pattern: "/etc/**", action: "deny" }],
      externalDirectoryRules: [{ pattern: "./**", action: "allow" }],
      externalDirectoryDefault: "ask",
      toolPermissions: [],
      enabled: true,
    };
    const { action } = resolveSegment(inv("ls", [
      { operator: ">", target: "/etc/passwd", fileDescriptor: undefined, wellKnown: false },
    ]), "/project", config);
    expect(action).toBe("deny");
  });

  it("forcedAskTools overrides everything for that executable", () => {
    const config: PluginConfig = { ...defaultConfig, forcedAskTools: ["git"] };
    const { action } = resolveSegment(inv("git status"), "/project", config);
    expect(action).toBe("ask");
  });

  it("args rule decides before glob evaluation", () => {
    const config: PluginConfig = {
      ...defaultConfig,
      bashRules: [{ pattern: "*", action: "ask" }],
      toolPermissions: [{ tool: "curl", args: [{ token: "-X", pattern: "GET", action: "allow" }], flags: { "-X": 1 } }],
    };
    const { action, allowFromArgsRule } = resolveSegment(inv("curl -X GET https://api.com"), "/project", config);
    expect(action).toBe("allow");
    expect(allowFromArgsRule).toBe(true);
  });
});

describe("characterization: chain aggregation", () => {
  const defaultConfig: PluginConfig = {
    bashRules: [
      { pattern: "*", action: "ask" },
      { pattern: "git *", action: "allow" },
      { pattern: "sudo *", action: "deny" },
    ],
    editRules: [],
    externalDirectoryRules: [{ pattern: "./**", action: "allow" }],
    externalDirectoryDefault: "ask",
    toolPermissions: [],
    enabled: true,
  };

  it("deny over ask over allow; all segments required for chain allow", () => {
    expect(resolveChain([seg("git status"), seg("sudo rm -rf /")], "/project", defaultConfig).action).toBe("deny");
    expect(resolveChain([seg("git status"), seg("unknown-cmd")], "/project", defaultConfig).action).toBe("ask");
    expect(resolveChain([seg("git status"), seg("git log")], "/project", defaultConfig).action).toBe("allow");
  });

  it("no-opinion segment breaks chain allow (null)", () => {
    const config: PluginConfig = {
      bashRules: [{ pattern: "git *", action: "allow" }],
      editRules: [],
      externalDirectoryRules: [],
      externalDirectoryDefault: null,
      toolPermissions: [],
      enabled: true,
    };
    expect(resolveChain([seg("git status"), seg("ls")], "/project", config).action).toBeNull();
  });

  it("allowFromArgsRule propagates only when an args-allowed segment exists", () => {
    const config: PluginConfig = {
      bashRules: [{ pattern: "*", action: "ask" }],
      editRules: [],
      externalDirectoryRules: [],
      externalDirectoryDefault: null,
      toolPermissions: [{ tool: "curl", args: [{ token: "-X", pattern: "GET", action: "allow" }], flags: { "-X": 1 } }],
      enabled: true,
    };
    const argsChain = resolveChain([seg("curl -X GET https://a.com")], "/project", config);
    expect(argsChain.action).toBe("allow");
    expect(argsChain.allowFromArgsRule).toBe(true);

    const globChain = resolveChain([seg("git status")], "/project", {
      ...config,
      bashRules: [{ pattern: "git *", action: "allow" }],
    });
    expect(globChain.action).toBe("allow");
    expect(globChain.allowFromArgsRule).toBe(false);
  });
});
