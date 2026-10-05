import { describe, it, expect } from "vitest";
import {
  validateToolPermissions,
  matchToolPermissions,
  matchTokenPattern,
} from "../config.js";
import { parseCommand as parseChain } from "../parser.js";
import { stripQuotePairs } from "../parser.js";
import { beforeExecute } from "../enforce.js";
import type { PluginConfig } from "../config.js";
import type { RestructureConfig } from "../plugin-config.js";

const argvOf = (command: string): string[] => {
  const chain = parseChain(command);
  return chain.invocations[0]?.argv ?? command.split(/\s+/);
};

describe("validateToolPermissions", () => {
  const warn = (messages: string[]) => (m: string) => messages.push(m);

  it("accepts valid entries (spec: valid entries parse)", () => {
    const messages: string[] = [];
    const result = validateToolPermissions(
      [
        {
          tool: "find",
          args: [{ token: "-delete", action: "ask" }, { position: 0, pattern: "<positional>", action: "allow" }],
        },
      ],
      warn(messages),
    );
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].args).toHaveLength(2);
    expect(result.forcedAskTools).toHaveLength(0);
    expect(result.globalDegraded).toBe(false);
    expect(messages).toHaveLength(0);
  });

  it("accepts array token paths, flag predicates and flagValues (spec: array token parses)", () => {
    const messages: string[] = [];
    const result = validateToolPermissions(
      [
        {
          tool: "git",
          args: [
            { token: ["push", "--force"], action: "deny" },
            { token: ["get"], flagValues: { "--namespace": "kube-system" }, action: "deny" },
          ],
          flags: { "--force": 1, "--namespace": 1 },
        },
        { tool: "find", args: [{ token: "-delete" }] },
      ],
      warn(messages),
    );
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].args[0].token).toEqual(["push", "--force"]);
    expect(result.entries[0].args[1].flagValues).toEqual({ "--namespace": "kube-system" });
    expect(result.entries[1].args[0].action).toBe("ask");
    expect(messages).toHaveLength(0);
  });

  it("duplicate dash elements in a path are invalid (spec: validation)", () => {
    const messages: string[] = [];
    const result = validateToolPermissions(
      [{ tool: "tool", args: [{ token: ["run", "--opt", "--opt"], action: "deny" }] }],
      (m) => messages.push(m),
    );
    expect(result.entries).toHaveLength(0);
    expect(result.forcedAskTools).toEqual(["tool"]);
    expect(messages).toHaveLength(1);
  });

  it("drops invalid entries with warnings, global degrade for unscopeable (spec: invalid entries dropped)", () => {
    const messages: string[] = [];
    const result = validateToolPermissions(
      [
        { args: [{ token: "-x", action: "deny" }] },
        { tool: "git", args: [{ token: "-x", position: 0, action: "deny" }] },
        { tool: "git", args: [{ position: -1, pattern: "a", action: "deny" }] },
        { tool: "git", args: [{ position: 0, action: "deny" }] },
        { tool: "git", args: [{ token: "-x", pattern: "y", args: [{ token: "z", action: "deny" }], action: "deny" }] },
        { tool: "git", args: [{ token: ["push"], pattern: "y", action: "deny" }] },
        { tool: "git", args: [{ token: [], action: "deny" }] },
        { tool: "git", args: [{ token: "--", action: "deny" }] },
        { tool: "git", args: [{ token: ["push", "--"], action: "deny" }] },
        { tool: "git", args: [{ token: "push", pattern: "y", action: "deny" }] },
        { tool: "git", args: [{ token: "--force=x", action: "deny" }] },
        { tool: "git", args: [{ token: ["get"], flagValues: { "--force=x": "v" }, action: "deny" }] },
        { tool: "git", args: [{ token: "-x", flagValues: { "--force": "v" }, action: "deny" }] },
        { tool: "git", args: [{ token: "-x", action: "deny", unknownField: 1 }] },
        { tool: "git", unknownEntryField: 1, args: [{ token: "-x", action: "deny" }] },
        { tool: "git", args: [{ token: "-x", action: "deny" }], flags: { "--force": 2 } },
        "not-an-object",
      ],
      warn(messages),
    );
    expect(result.entries).toHaveLength(0);
    expect(result.globalDegraded).toBe(true);
    expect(result.forcedAskTools).toEqual(["git"]);
    expect(messages).toHaveLength(17);
  });

  it("flags arity table must be 0 or 1 (spec: flags table values)", () => {
    const messages: string[] = [];
    const good = validateToolPermissions(
      [{ tool: "git", args: [{ token: "push", action: "allow" }], flags: { "--force": 1, "--dry-run": 0 } }],
      warn(messages),
    );
    expect(good.entries[0].flags).toEqual({ "--force": 1, "--dry-run": 0 });
    const bad = validateToolPermissions(
      [{ tool: "git", args: [{ token: "push", action: "allow" }], flags: { "--force": 2 } }],
      warn(messages),
    );
    expect(bad.entries).toHaveLength(0);
    expect(bad.forcedAskTools).toEqual(["git"]);
    expect(messages).toHaveLength(1);
  });

  it("drops only the invalid entry, keeps valid siblings, scopes ask to the tool", () => {
    const messages: string[] = [];
    const result = validateToolPermissions(
      [
        { tool: "find", args: [{ token: "-delete", action: "deny" }] },
        { tool: "find", args: [{ position: "all", action: "deny" }] },
      ],
      warn(messages),
    );
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].args).toHaveLength(1);
    expect(result.forcedAskTools).toEqual(["find"]);
  });
});

describe("argv tokenization (quote-aware, via parseChain segments)", () => {
  it("strips matched quote pairs — quoted flags cannot bypass", () => {
    expect(argvOf('git push "--force" origin main')).toEqual(["git", "push", "--force", "origin", "main"]);
    expect(argvOf('git push --force""')).toEqual(["git", "push", "--force"]);
  });

  it("quoted whitespace stays within one token", () => {
    expect(argvOf('echo "a b"')).toEqual(["echo", "a b"]);
  });

  it("redirect targets are not argv tokens", () => {
    expect(argvOf("ls > /tmp/out.txt")).toEqual(["ls"]);
  });

  it("stripQuotePairs normalizes concatenated empty quotes", () => {
    expect(stripQuotePairs('--force""')).toBe("--force");
    expect(stripQuotePairs("'--force'")).toBe("--force");
    expect(stripQuotePairs("--force")).toBe("--force");
  });
});

describe("matchTokenPattern", () => {
  it("single star stays within a path segment, globstar crosses separators", () => {
    expect(matchTokenPattern("/work/a/b", "/work/*")).toBe(false);
    expect(matchTokenPattern("/work/a.txt", "/work/*")).toBe(true);
    expect(matchTokenPattern("/work/a.txt", "/work/**")).toBe(true);
    expect(matchTokenPattern("GET", "GET")).toBe(true);
    expect(matchTokenPattern("POST", "GET")).toBe(false);
  });
});

describe("matchToolPermissions (matcher semantics)", () => {
  it("bare scalar flag matches a classified flag atom (presence, no value inspection)", () => {
    const entry = [{ tool: "find", args: [{ token: "-delete", action: "deny" as const }] }];
    expect(matchToolPermissions(argvOf("find /tmp -delete"), entry)).toBe("deny");
    expect(matchToolPermissions(argvOf("find /tmp"), entry)).toBeNull();
  });

  it("value pattern: matches the flag value only on exact token match (declared arity 1)", () => {
    const entry = [{ tool: "curl", args: [{ token: "-X", pattern: "GET", action: "allow" as const }], flags: { "-X": 1 as const } }];
    expect(matchToolPermissions(argvOf("curl -X GET"), entry)).toBe("allow");
    expect(matchToolPermissions(argvOf("curl -X POST"), entry)).toBeNull();
  });

  it("value pattern matchers do not match via cluster expansion (spec: unsafe cluster resolves to ask)", () => {
    const entry = [{ tool: "rm", args: [{ token: "-f", pattern: "/tmp/**", action: "deny" as const }] }];
    expect(matchToolPermissions(argvOf("rm -rf /tmp/x"), entry)).toBe("ask");
    expect(matchToolPermissions(argvOf("rm -f /tmp/x"), entry)).toBe("deny");
  });

  it("numeric position indexes the positional list (declared values excluded, post-separator included)", () => {
    const entry = [
      { tool: "find", args: [{ position: 0, pattern: "/tmp/**", action: "ask" as const }], flags: { "-name": 1 as const } },
    ];
    expect(matchToolPermissions(argvOf("find /tmp/logs -name x"), entry)).toBe("ask");
    expect(matchToolPermissions(argvOf("find -name x /tmp/logs"), entry)).toBe("ask");
    expect(matchToolPermissions(argvOf("find -name x -- /tmp/logs"), entry)).toBe("ask");
    expect(matchToolPermissions(argvOf("find /work/logs -name x"), entry)).toBeNull();
  });

  it("undeclared value-flag is a probable missing arity — the segment asks (fail-safe)", () => {
    const entry = [{ tool: "find", args: [{ position: 0, pattern: "/tmp/**", action: "allow" as const }] }];
    expect(matchToolPermissions(argvOf("find -name x /tmp/logs"), entry)).toBe("ask");
    expect(matchToolPermissions(argvOf("find /tmp/logs"), entry)).toBe("allow");
  });

  it("declared zero flag rejects equals-form value (spec: declared zero rejects equals value)", () => {
    const entry = [{ tool: "tool", args: [{ token: ["primary-command"], action: "allow" as const }], flags: { "--mode": 0 as const } }];
    expect(matchToolPermissions(argvOf("tool primary-command --mode=value"), entry)).toBe("ask");
    expect(matchToolPermissions(argvOf("tool primary-command --mode value"), entry)).toBe("allow");
  });

  it("all + allow: every positional candidate must match", () => {
    const entry = [{ tool: "cp", args: [{ position: "all" as const, pattern: "/work/**", action: "allow" as const }] }];
    expect(matchToolPermissions(argvOf("cp /work/a.txt /work/b.txt"), entry)).toBe("allow");
    expect(matchToolPermissions(argvOf("cp /work/a.txt /tmp/out"), entry)).toBeNull();
  });

  it("all + allow: flag-like tokens are not candidates; no candidates means no match", () => {
    const entry = [{ tool: "cp", args: [{ position: "all" as const, pattern: "/work/**", action: "allow" as const }], flags: { "-f": 0 as const } }];
    expect(matchToolPermissions(argvOf("cp -f /work/a.txt"), entry)).toBe("allow");
    expect(matchToolPermissions(argvOf("cp -f"), entry)).toBeNull();
  });

  it("operand matcher covers ordinary positionals, declared flag values and post-separator operands (spec: complete safety view)", () => {
    const entry = [
      {
        tool: "rm",
        args: [
          { operand: "all" as const, pattern: "**/etc/**", action: "deny" as const },
          { position: "all" as const, pattern: "/work/**", action: "allow" as const },
        ],
        flags: { "-f": 1 as const },
      },
    ];
    expect(matchToolPermissions(argvOf("rm /work/a.txt /etc/passwd"), entry)).toBe("deny");
    expect(matchToolPermissions(argvOf("rm -f /etc/passwd"), entry)).toBe("deny");
    expect(matchToolPermissions(argvOf("rm /work/a.txt -- /etc/passwd"), entry)).toBe("deny");
    expect(matchToolPermissions(argvOf("rm /work/a.txt"), entry)).toBe("allow");
  });

  it("key=value operands are ordinary whole-token safety candidates", () => {
    const entry = [{ tool: "dd", args: [{ operand: "all" as const, pattern: "/dev/**", action: "deny" as const }] }];
    expect(matchToolPermissions(argvOf("dd if=/dev/sda of=/dev/sdb"), entry)).toBeNull();
  });

  it("path rules require every level as a whole token, anchored and contiguous (spec: nested rules require the parent token)", () => {
    const entry = [
      {
        tool: "git",
        args: [
          { token: ["push", "--force"], action: "deny" as const },
          { token: "--force", action: "ask" as const },
        ],
        flags: { "--force": 1 as const },
      },
    ];
    expect(matchToolPermissions(argvOf("git push --force origin main"), entry)).toBe("deny");
    expect(matchToolPermissions(argvOf("git status"), entry)).toBeNull();
    expect(matchToolPermissions(argvOf("git push"), entry)).toBeNull();
    expect(matchToolPermissions(argvOf("git commit --force-ish"), entry)).toBeNull();
  });

  it("path levels are anchored: a foreign operand before the path breaks the match", () => {
    const entry = [{ tool: "git", args: [{ token: ["push", "--force"], action: "deny" as const }], flags: { "--force": 1 as const } }];
    expect(matchToolPermissions(argvOf("git stash push --force"), entry)).toBeNull();
  });

  it("flag predicates are position-free presence checks (spec: atomic path plus value predicate)", () => {
    const entry = [
      {
        tool: "kubectl",
        args: [{ token: ["get"], flagValues: { "--namespace": "kube-system" }, action: "deny" as const }],
        flags: { "--namespace": 1 as const },
      },
    ];
    expect(matchToolPermissions(argvOf("kubectl get --namespace=kube-system pods"), entry)).toBe("deny");
    expect(matchToolPermissions(argvOf("kubectl --namespace=kube-system get pods"), entry)).toBe("deny");
    expect(matchToolPermissions(argvOf("kubectl get pods"), entry)).toBeNull();
    expect(matchToolPermissions(argvOf("kubectl get --namespace=default pods"), entry)).toBeNull();
  });

  it("repeated path levels are position-free presence predicates (spec: predicates do not consume)", () => {
    const entry = [
      {
        tool: "tool",
        args: [{ token: ["run", "--opt", "--opt"], action: "deny" as const }],
        flags: { "--opt": 1 as const },
      },
    ];
    expect(matchToolPermissions(argvOf("tool run --opt --opt"), entry)).toBe("deny");
    expect(matchToolPermissions(argvOf("tool run --opt x"), entry)).toBe("deny");
  });

  it("most restrictive wins across matchers and entries", () => {
    const entry = [
      {
        tool: "find",
        args: [
          { position: "all" as const, pattern: "/work/**", action: "allow" as const },
          { token: "-delete", action: "deny" as const },
        ],
      },
    ];
    expect(matchToolPermissions(argvOf("find /work/a /work/b -delete"), entry)).toBe("deny");
    expect(matchToolPermissions(argvOf("find /work/a -type"), entry)).toBe("ask");
  });

  it("inserted declared value-taking flag shifts nothing for path levels", () => {
    const entry = [
      { tool: "git", args: [{ token: ["push"], action: "allow" as const }], flags: { "-c": 1 as const } },
    ];
    expect(matchToolPermissions(argvOf("git push"), entry)).toBe("allow");
    expect(matchToolPermissions(argvOf("git -c key=val push"), entry)).toBe("allow");
  });
});

describe("path matchers, flag predicates & refinement", () => {
  it("published value-bearing path rules keep their exact meaning under v2", () => {
    const entry = [
      {
        tool: "kubectl",
        args: [{ token: ["get"], flagValues: { "--namespace": "kube-system" }, action: "deny" as const }],
        flags: { "--namespace": 1 as const },
      },
    ];
    expect(matchToolPermissions(argvOf("kubectl get --namespace=kube-system pods"), entry)).toBe("deny");
    expect(matchToolPermissions(argvOf("kubectl --namespace=kube-system get pods"), entry)).toBe("deny");
    expect(matchToolPermissions(argvOf("kubectl get pods"), entry)).toBeNull();
    expect(matchToolPermissions(argvOf("kubectl get --namespace=default pods"), entry)).toBeNull();
  });

  it("path rule covers trailing arguments; anchors reject foreign operands", () => {
    const entry = [{ tool: "git", args: [{ token: ["push", "--force"], action: "deny" as const }], flags: { "--force": 1 as const } }];
    expect(matchToolPermissions(argvOf("git push --force origin main"), entry)).toBe("deny");
    expect(matchToolPermissions(argvOf("git stash push --force"), entry)).toBeNull();
  });

  it("refined prefix rule is discarded (spec: refinement overrides, even toward ask)", () => {
    const entry = [
      {
        tool: "git",
        args: [
          { token: ["push"], action: "deny" as const },
          { token: ["push", "--force"], action: "ask" as const },
        ],
        flags: { "--force": 1 as const },
      },
    ];
    expect(matchToolPermissions(argvOf("git push --force"), entry)).toBe("ask");
  });

  it("refinement can loosen — allow exception under deny", () => {
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

  it("scalar and array token forms stay incomparable (fail-safe deny wins)", () => {
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
    expect(matchToolPermissions(argvOf("git push origin"), entry)).toBe("deny");
  });

  it("global flag ask survives an exact-path allow (incomparable rules reduce most-restrictive)", () => {
    const entry = [
      {
        tool: "kubectl",
        args: [
          { token: ["get", "pods"], action: "allow" as const },
          { token: ["--namespace=kube-system"], action: "ask" as const },
        ],
        flags: { "--namespace": 1 as const },
      },
    ];
    expect(matchToolPermissions(argvOf("kubectl get pods --namespace=kube-system"), entry)).toBe("ask");
    expect(matchToolPermissions(argvOf("kubectl get pods"), entry)).toBe("allow");
  });

  it("value-constrained matcher refines its bare token (spec: value exception)", () => {
    const entry = [
      {
        tool: "curl",
        args: [
          { token: "-X", action: "deny" as const },
          { token: "-X", pattern: "GET", action: "allow" as const },
        ],
        flags: { "-X": 1 as const },
      },
    ];
    expect(matchToolPermissions(argvOf("curl -X GET https://api.com"), entry)).toBe("allow");
    expect(matchToolPermissions(argvOf("curl -X POST https://api.com"), entry)).toBe("deny");
  });

  it("a path rule and a value matcher are always incomparable (value deny survives exact-path allow)", () => {
    const entry = [
      {
        tool: "tool",
        args: [
          { token: "--output", pattern: "**/etc/**", action: "deny" as const },
          { token: ["generate", "--output"], action: "allow" as const },
        ],
        flags: { "--output": 1 as const },
      },
    ];
    expect(matchToolPermissions(argvOf("tool generate --output=/etc/passwd"), entry)).toBe("deny");
  });

  it("repeated value flag: allow requires every occurrence (fail-safe refinement)", () => {
    const entry = [
      {
        tool: "tool",
        args: [
          { token: "--mode", action: "deny" as const },
          { token: "--mode", pattern: "safe", action: "allow" as const },
        ],
        flags: { "--mode": 1 as const },
      },
    ];
    expect(matchToolPermissions(argvOf("tool --mode safe"), entry)).toBe("allow");
    expect(matchToolPermissions(argvOf("tool --mode safe --mode dangerous"), entry)).toBe("deny");
  });

  it("refinement pools across separate tool entries", () => {
    const entries = [
      { tool: "git", args: [{ token: ["push"], action: "deny" as const }] },
      { tool: "git", args: [{ token: ["push", "--force-with-lease"], action: "allow" as const }], flags: { "--force-with-lease": 0 as const } },
    ];
    expect(matchToolPermissions(argvOf("git push --force-with-lease"), entries)).toBe("allow");
    expect(matchToolPermissions(argvOf("git push origin"), entries)).toBe("deny");
  });

  it("omitted action normalizes to ask and restricts (fail-safe default)", () => {
    const entries = validateToolPermissions([{ tool: "find", args: [{ token: "-delete" }] }]).entries;
    expect(matchToolPermissions(argvOf("find /tmp -delete"), entries)).toBe("ask");
  });

  it("structurally identical matchers never refine each other", () => {
    const entry = [
      {
        tool: "git",
        args: [
          { token: ["push"], action: "deny" as const },
          { token: ["push"], action: "deny" as const },
        ],
      },
    ];
    expect(matchToolPermissions(argvOf("git push origin"), entry)).toBe("deny");
  });
});

describe("flag-level pipeline", () => {
  const nativeAskAll: PluginConfig = {
    bashRules: [
      { pattern: "*", action: "ask" },
      { pattern: "git *", action: "allow" },
    ],
    editRules: [],
    externalDirectoryRules: [{ pattern: "./**", action: "allow" }],
    externalDirectoryDefault: "ask",
    toolPermissions: [],
    enabled: true,
  };

  const withCurlAllow: PluginConfig = {
    ...nativeAskAll,
    toolPermissions: [{ tool: "curl", args: [{ token: "-X", pattern: "GET", action: "allow" }], flags: { "-X": 1 } }],
  };

  const withFindDeleteDeny: PluginConfig = {
    ...nativeAskAll,
    bashRules: [
      { pattern: "*", action: "ask" },
      { pattern: "find *", action: "allow" },
    ],
    toolPermissions: [{ tool: "find", args: [{ token: "-delete", action: "deny" }], flags: { "-name": 0 } }],
  };

  const restructure: RestructureConfig = { enabled: true, maxSegments: 3, maxDepth: 2 };

  it("args allow overrides a broad native ask", () => {
    const result = beforeExecute("Bash", "/project", { command: "curl -X GET https://api.com" }, withCurlAllow, restructure);
    expect(result.chainAction).toBe("allow");
    expect(result.shouldWrap).toBe(false);
    expect(result.permissionOverride).toBe("allow");
  });

  it("unmatched segment falls through to the glob level (ask, dialog)", () => {
    const result = beforeExecute("Bash", "/project", { command: "curl -X POST https://api.com" }, withCurlAllow, restructure);
    expect(result.rejectionMessage).toBeNull();
    expect(result.chainAction).toBe("ask");
    expect(result.shouldWrap).toBe(true);
    expect(result.permissionOverride).toBeNull();
  });

  it("args deny overrides a glob allow (find allowed except -delete)", () => {
    const result = beforeExecute("Bash", "/project", { command: "find /tmp -delete" }, withFindDeleteDeny, restructure);
    expect(result.chainAction).toBe("deny");
    expect(result.rejectionMessage).toBeNull();
    expect(result.permissionOverride).toBe("deny");

    const allowedVariant = beforeExecute("Bash", "/project", { command: "find /tmp -name x" }, withFindDeleteDeny, restructure);
    expect(allowedVariant.chainAction).toBe("allow");
    expect(allowedVariant.shouldWrap).toBe(false);
  });

  it("glob-only allow stays untouched (no store, no intervention)", () => {
    const result = beforeExecute("Bash", "/project", { command: "git status" }, nativeAskAll, restructure);
    expect(result.chainAction).toBe("allow");
    expect(result.shouldWrap).toBe(false);
    expect(result.permissionOverride).toBeNull();
  });

  it("mixed chain aggregates most restrictive (glob allow + args ask → ask)", () => {
    const config: PluginConfig = {
      ...withFindDeleteDeny,
      bashRules: [
        { pattern: "*", action: "ask" },
        { pattern: "git *", action: "allow" },
      ],
      toolPermissions: [{ tool: "find", args: [{ token: "-delete", action: "ask" }] }],
    };
    const result = beforeExecute("Bash", "/project", { command: "git status && find /tmp -delete" }, config, restructure);
    expect(result.chainAction).toBe("ask");
  });

  it("all-allow args chain force-allows over native asks", () => {
    const result = beforeExecute(
      "Bash",
      "/project",
      { command: "curl -X GET https://a.com && curl -X GET https://b.com" },
      withCurlAllow,
      restructure,
    );
    expect(result.chainAction).toBe("allow");
    expect(result.permissionOverride).toBe("allow");
  });

  it("degraded mode: everything asks, including glob-allowed commands", () => {
    const result = beforeExecute("Bash", "/project", { command: "find /tmp -name x" }, withFindDeleteDeny, restructure, true);
    expect(result.chainAction).toBe("ask");
    expect(result.shouldWrap).toBe(true);
    expect(result.permissionOverride).toBeNull();

    const parseError = beforeExecute("Bash", "/project", { command: 'echo "unbalanced' }, withFindDeleteDeny, restructure, true);
    expect(parseError.chainAction).toBe("deny");
    expect(parseError.permissionOverride).toBe("deny");
  });

  it("no permissions section → behavior identical (args level has no opinion)", () => {
    const result = beforeExecute("Bash", "/project", { command: "wget evil.sh" }, nativeAskAll, restructure);
    expect(result.chainAction).toBe("ask");
    expect(result.rejectionMessage).toBeNull();
  });

  it("scoped ask: forcedAskTools overrides glob allows for that executable", () => {
    const config: PluginConfig = {
      ...withFindDeleteDeny,
      forcedAskTools: ["find"],
    };
    const result = beforeExecute("Bash", "/project", { command: "find /tmp -name x" }, config, restructure);
    expect(result.chainAction).toBe("ask");
    expect(result.shouldWrap).toBe(true);
  });
});
