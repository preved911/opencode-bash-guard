import { describe, it, expect, beforeEach } from "vitest";
import {
  validateToolPermissions,
  matchToolPermissions,
  matchTokenPattern,
} from "../config.js";
import { parseChain, stripQuotePairs } from "../chain.js";
import { beforeExecute, handlePermissionAsk, clearStoredDecision } from "../enforce.js";
import type { PluginConfig } from "../config.js";
import type { RestructureConfig } from "../plugin-config.js";

const argvOf = (command: string): string[] => {
  const chain = parseChain(command);
  return chain.segments[0]?.argv ?? command.split(/\s+/);
};

describe("validateToolPermissions", () => {
  const warn = (messages: string[]) => (m: string) => messages.push(m);

  it("accepts valid entries (spec: valid entries parse)", () => {
    const messages: string[] = [];
    const entries = validateToolPermissions(
      [
        {
          tool: "find",
          args: [{ token: "-delete", action: "ask" }, { position: 0, pattern: "/Users/me/work/**", action: "allow" }],
        },
      ],
      warn(messages),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].args).toHaveLength(2);
    expect(messages).toHaveLength(0);
  });

  it("accepts array token paths and normalizes omitted actions to ask (spec: array token parses, omitted action defaults to ask)", () => {
    const messages: string[] = [];
    const entries = validateToolPermissions(
      [
        { tool: "git", args: [{ token: ["push", "--force"], action: "deny" }] },
        { tool: "find", args: [{ token: "-delete" }] },
      ],
      warn(messages),
    );
    expect(entries).toHaveLength(2);
    expect(entries[0].args[0].token).toEqual(["push", "--force"]);
    expect(entries[1].args[0].action).toBe("ask");
    expect(messages).toHaveLength(0);
  });

  it("drops invalid entries with warnings (spec: invalid entries dropped)", () => {
    const messages: string[] = [];
    const entries = validateToolPermissions(
      [
        { args: [{ token: "-x", action: "deny" }] },
        { tool: "git", args: [{ token: "-x", position: 0, action: "deny" }] },
        { tool: "git", args: [{ position: -1, pattern: "a", action: "deny" }] },
        { tool: "git", args: [{ position: 0, action: "deny" }] },
        { tool: "git", args: [{ token: "-x", pattern: "y", args: [{ token: "z", action: "deny" }], action: "deny" }] },
        { tool: "git", args: [{ token: "-x", action: "block" }] },
        { tool: "git", args: [{ token: ["push"], pattern: "y", action: "deny" }] },
        { tool: "git", args: [{ token: [], action: "deny" }] },
        "not-an-object",
      ],
      warn(messages),
    );
    expect(entries).toHaveLength(0);
    expect(messages).toHaveLength(9);
  });

  it("drops only the invalid entry, keeps valid siblings", () => {
    const messages: string[] = [];
    const entries = validateToolPermissions(
      [
        { tool: "find", args: [{ token: "-delete", action: "deny" }] },
        { tool: "find", args: [{ position: "all", action: "deny" }] },
      ],
      warn(messages),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].args).toHaveLength(1);
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
  const denyDelete = [{ tool: "find", args: [{ token: "-delete", action: "deny" as const }] }];

  it("flag token matches anywhere and is absent otherwise", () => {
    expect(matchToolPermissions(argvOf('find /tmp -name "*.log" -delete'), denyDelete)).toBe("deny");
    expect(matchToolPermissions(argvOf('find /tmp -name "*.log"'), denyDelete)).toBeNull();
  });

  it("quoted flag is visible to the matcher (no bypass via quotes)", () => {
    const entry = [{ tool: "git", args: [{ token: ["push", "--force"], action: "deny" as const }] }];
    expect(matchToolPermissions(argvOf('git push "--force" origin main'), entry)).toBe("deny");
  });

  it("clustered short flags match single-letter targets, siblings still match", () => {
    const entry = [
      {
        tool: "rm",
        args: [
          { token: "-r", action: "deny" as const },
          { token: "-f", action: "ask" as const },
        ],
      },
    ];
    expect(matchToolPermissions(argvOf("rm -rf /tmp/x"), entry)).toBe("deny");
  });

  it("value pattern: matches the flag value only on exact token match", () => {
    const entry = [{ tool: "curl", args: [{ token: "-X", pattern: "GET", action: "allow" as const }] }];
    expect(matchToolPermissions(argvOf("curl -X GET https://api.com"), entry)).toBe("allow");
    expect(matchToolPermissions(argvOf("curl -X POST https://api.com"), entry)).toBeNull();
  });

  it("value pattern matchers do not match via cluster expansion", () => {
    const entry = [{ tool: "rm", args: [{ token: "-f", pattern: "/tmp/**", action: "deny" as const }] }];
    expect(matchToolPermissions(argvOf("rm -rf /tmp/x"), entry)).toBeNull();
    expect(matchToolPermissions(argvOf("rm -f /tmp/x"), entry)).toBe("deny");
  });

  it("numeric position counts positional args only, flags never occupy a slot", () => {
    const entry = [{ tool: "find", args: [{ position: 0, pattern: "/tmp/**", action: "ask" as const }] }];
    expect(matchToolPermissions(argvOf("find /tmp/logs -name x"), entry)).toBe("ask");
    expect(matchToolPermissions(argvOf("find -delete /tmp/logs"), entry)).toBe("ask");
    expect(matchToolPermissions(argvOf("find /work/logs -name x"), entry)).toBeNull();
  });

  it("dash-less flag values occupy positional slots (documented heuristic)", () => {
    const entry = [{ tool: "find", args: [{ position: 0, pattern: "/tmp/**", action: "ask" as const }] }];
    expect(matchToolPermissions(argvOf("find -name x /tmp/logs"), entry)).toBeNull();
  });

  it("all + allow: every candidate must match", () => {
    const entry = [{ tool: "cp", args: [{ position: "all" as const, pattern: "/Users/me/work/**", action: "allow" as const }] }];
    expect(matchToolPermissions(argvOf("cp /Users/me/work/a.txt /Users/me/work/b.txt"), entry)).toBe("allow");
    expect(matchToolPermissions(argvOf("cp /Users/me/work/a.txt /tmp/out"), entry)).toBeNull();
  });

  it("all + allow: flag-like tokens are not candidates; no candidates means no match", () => {
    const entry = [{ tool: "cp", args: [{ position: "all" as const, pattern: "/Users/me/work/**", action: "allow" as const }] }];
    expect(matchToolPermissions(argvOf("cp -R /Users/me/work/a.txt"), entry)).toBe("allow");
    expect(matchToolPermissions(argvOf("cp -R"), entry)).toBeNull();
  });

  it("all + deny: one sensitive path is enough (mixed commands cannot escape)", () => {
    const entry = [{ tool: "rm", args: [{ position: "all" as const, pattern: "/etc/**", action: "deny" as const }] }];
    expect(matchToolPermissions(argvOf("rm /Users/me/work/a.txt /etc/passwd"), entry)).toBe("deny");
    expect(matchToolPermissions(argvOf("rm /Users/me/work/a.txt"), entry)).toBeNull();
  });

  it("key=value options are ordinary full-token candidates", () => {
    const entry = [{ tool: "dd", args: [{ position: "all" as const, pattern: "/dev/**", action: "deny" as const }] }];
    expect(matchToolPermissions(argvOf("dd if=/dev/sda of=/dev/sdb"), entry)).toBeNull();
    expect(matchToolPermissions(argvOf("dd if=/**"), entry)).toBeNull();
  });

  it("path rules require every element as a whole token (spec: nested rules require the parent token)", () => {
    const entry = [
      {
        tool: "git",
        args: [
          { token: ["push", "--force"], action: "deny" as const },
          { token: "--force", action: "ask" as const },
        ],
      },
    ];
    expect(matchToolPermissions(argvOf("git push --force origin main"), entry)).toBe("deny");
    expect(matchToolPermissions(argvOf("git status"), entry)).toBeNull();
    expect(matchToolPermissions(argvOf("git push"), entry)).toBeNull();
    expect(matchToolPermissions(argvOf("git commit --force-ish"), entry)).toBeNull();
  });

  it("most restrictive wins across matchers and entries", () => {
    const entry = [
      { tool: "find", args: [{ position: "all" as const, pattern: "/Users/me/work/**", action: "allow" as const }, { token: "-delete", action: "deny" as const }] },
    ];
    expect(matchToolPermissions(argvOf("find /Users/me/work/a /Users/me/work/b -delete"), entry)).toBe("deny");
    expect(matchToolPermissions(argvOf("find /Users/me/work/a -type"), entry)).toBe("allow");
  });

  it("inserted global flag shifts nothing for tokens; dash-less values do occupy positional slots", () => {
    const pushEntry = [{ tool: "git", args: [{ position: 0, pattern: "push", action: "allow" as const }] }];
    expect(matchToolPermissions(argvOf("git push --force"), pushEntry)).toBe("allow");
    expect(matchToolPermissions(argvOf("git -c key=val push --force"), pushEntry)).toBeNull();
  });
});

describe("path matchers & refinement (exact command paths)", () => {
  it("path matches regardless of argument order (global flags)", () => {
    const entry = [{ tool: "kubectl", args: [{ token: ["get", "--namespace=kube-system"], action: "deny" as const }] }];
    expect(matchToolPermissions(argvOf("kubectl get --namespace=kube-system pods"), entry)).toBe("deny");
    expect(matchToolPermissions(argvOf("kubectl --namespace=kube-system get pods"), entry)).toBe("deny");
    expect(matchToolPermissions(argvOf("kubectl get pods"), entry)).toBeNull();
  });

  it("path rule covers trailing arguments", () => {
    const entry = [{ tool: "git", args: [{ token: ["push", "--force"], action: "deny" as const }] }];
    expect(matchToolPermissions(argvOf("git push --force origin main"), entry)).toBe("deny");
  });

  it("path with separate-token flag value", () => {
    const entry = [{ tool: "kubectl", args: [{ token: ["get", "--namespace", "kube-system"], action: "deny" as const }] }];
    expect(matchToolPermissions(argvOf("kubectl get --namespace kube-system pods"), entry)).toBe("deny");
    expect(matchToolPermissions(argvOf("kubectl get --namespace default pods"), entry)).toBeNull();
  });

  it("path elements consume distinct tokens (spec: consumed tokens are not rematched)", () => {
    const entry = [{ tool: "git", args: [{ token: ["push", "--force", "--force"], action: "deny" as const }] }];
    expect(matchToolPermissions(argvOf("git push --force --force"), entry)).toBe("deny");
    expect(matchToolPermissions(argvOf("git push --force origin"), entry)).toBeNull();
  });

  it("refined prefix rule is discarded (spec: refinement overrides, even toward ask)", () => {
    const entry = [
      {
        tool: "git",
        args: [
          { token: ["push"], action: "deny" as const },
          { token: ["push", "--force"], action: "ask" as const },
        ],
      },
    ];
    expect(matchToolPermissions(argvOf("git push --force"), entry)).toBe("ask");
  });

  it("refinement can loosen — allow exception under deny (spec: refinement can loosen)", () => {
    const entry = [
      {
        tool: "git",
        args: [
          { token: ["push"], action: "deny" as const },
          { token: ["push", "--force-with-lease"], action: "allow" as const },
        ],
      },
    ];
    expect(matchToolPermissions(argvOf("git push --force-with-lease origin"), entry)).toBe("allow");
    expect(matchToolPermissions(argvOf("git push origin"), entry)).toBe("deny");
  });

  it("string and array token forms refine each other", () => {
    const entry = [
      {
        tool: "git",
        args: [
          { token: "push", action: "deny" as const },
          { token: ["push", "--force-with-lease"], action: "allow" as const },
        ],
      },
    ];
    expect(matchToolPermissions(argvOf("git push --force-with-lease"), entry)).toBe("allow");
    expect(matchToolPermissions(argvOf("git push origin"), entry)).toBe("deny");
  });

  it("global flag ask survives an exact-path allow (spec: incomparable rules reduce most-restrictive)", () => {
    const entry = [
      {
        tool: "kubectl",
        args: [
          { token: ["get", "pods"], action: "allow" as const },
          { token: ["--namespace=kube-system"], action: "ask" as const },
        ],
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
      },
    ];
    expect(matchToolPermissions(argvOf("curl -X GET https://api.com"), entry)).toBe("allow");
    expect(matchToolPermissions(argvOf("curl -X POST https://api.com"), entry)).toBe("deny");
  });

  it("refinement pools across separate tool entries", () => {
    const entries = [
      { tool: "git", args: [{ token: ["push"], action: "deny" as const }] },
      { tool: "git", args: [{ token: ["push", "--force-with-lease"], action: "allow" as const }] },
    ];
    expect(matchToolPermissions(argvOf("git push --force-with-lease"), entries)).toBe("allow");
    expect(matchToolPermissions(argvOf("git push origin"), entries)).toBe("deny");
  });

  it("omitted action normalizes to ask and restricts (fail-safe default)", () => {
    const entries = validateToolPermissions([{ tool: "find", args: [{ token: "-delete" }] }]);
    expect(matchToolPermissions(argvOf("find /tmp -delete"), entries)).toBe("ask");
  });
});

describe("flag-level pipeline (beforeExecute + handlePermissionAsk)", () => {
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
    toolPermissions: [{ tool: "curl", args: [{ token: "-X", pattern: "GET", action: "allow" }] }],
  };

  const withFindDeleteDeny: PluginConfig = {
    ...nativeAskAll,
    bashRules: [
      { pattern: "*", action: "ask" },
      { pattern: "find *", action: "allow" },
    ],
    toolPermissions: [{ tool: "find", args: [{ token: "-delete", action: "deny" }] }],
  };

  const restructure: RestructureConfig = { enabled: true, maxSegments: 3, maxDepth: 2 };

  beforeEach(() => clearStoredDecision("flag-level"));

  it("args allow overrides a broad native ask (stored + enforced as allow)", () => {
    const result = beforeExecute("Bash", "flag-level", "/project", { command: "curl -X GET https://api.com" }, withCurlAllow, restructure);
    expect(result.chainAction).toBe("allow");
    expect(result.shouldWrap).toBe(false);
    const output = { status: "ask" as const };
    handlePermissionAsk({ callID: "flag-level" }, output);
    expect(output.status).toBe("allow");
  });

  it("unmatched segment falls through to the glob level (ask, dialog)", () => {
    const result = beforeExecute("Bash", "flag-level", "/project", { command: "curl -X POST https://api.com" }, withCurlAllow, restructure);
    expect(result.rejectionMessage).toBeNull();
    expect(result.chainAction).toBe("ask");
    expect(result.shouldWrap).toBe(true);
    const output = { status: "ask" as const };
    handlePermissionAsk({ callID: "flag-level" }, output);
    expect(output.status).toBe("ask");
  });

  it("args deny overrides a glob allow (find allowed except -delete)", () => {
    const result = beforeExecute("Bash", "flag-level", "/project", { command: "find /tmp -delete" }, withFindDeleteDeny, restructure);
    expect(result.chainAction).toBe("deny");
    expect(result.rejectionMessage).toBeNull();

    const allowedVariant = beforeExecute("Bash", "flag-level", "/project", { command: "find /tmp -name x" }, withFindDeleteDeny, restructure);
    expect(allowedVariant.chainAction).toBe("allow");
    expect(allowedVariant.shouldWrap).toBe(false);
  });

  it("glob-only allow stays untouched (no store, no intervention)", () => {
    const result = beforeExecute("Bash", "flag-level", "/project", { command: "git status" }, nativeAskAll, restructure);
    expect(result.chainAction).toBe("allow");
    expect(result.shouldWrap).toBe(false);
    const output = { status: "ask" as const };
    handlePermissionAsk({ callID: "flag-level" }, output);
    expect(output.status).toBe("ask");
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
    const result = beforeExecute("Bash", "flag-level", "/project", { command: "git status && find /tmp -delete" }, config, restructure);
    expect(result.chainAction).toBe("ask");
  });

  it("all-allow args chain force-allows over native asks", () => {
    const result = beforeExecute(
      "Bash",
      "flag-level",
      "/project",
      { command: "curl -X GET https://a.com && curl -X GET https://b.com" },
      withCurlAllow,
      restructure,
    );
    expect(result.chainAction).toBe("allow");
    const output = { status: "ask" as const };
    handlePermissionAsk({ callID: "flag-level" }, output);
    expect(output.status).toBe("allow");
  });

  it("degraded mode: everything asks, including glob-allowed commands", () => {
    const result = beforeExecute("Bash", "flag-level", "/project", { command: "find /tmp -name x" }, withFindDeleteDeny, restructure, true);
    expect(result.chainAction).toBe("ask");
    expect(result.shouldWrap).toBe(true);
    const output = { status: "ask" as const };
    handlePermissionAsk({ callID: "flag-level" }, output);
    expect(output.status).toBe("ask");

    const parseError = beforeExecute("Bash", "flag-level", "/project", { command: 'echo "unbalanced' }, withFindDeleteDeny, restructure, true);
    expect(parseError.chainAction).toBe("deny");
  });

  it("no permissions section → behavior identical (args level has no opinion)", () => {
    const result = beforeExecute("Bash", "flag-level", "/project", { command: "wget evil.sh" }, nativeAskAll, restructure);
    expect(result.chainAction).toBe("ask");
    expect(result.rejectionMessage).toBeNull();
  });
});
