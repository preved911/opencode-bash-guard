import { describe, it, expect } from "vitest";
import { beforeExecute } from "../enforce.js";
import { resolveSegment, resolveChain } from "../policy.js";
import { checkComplexity, buildRejectionMessage } from "../readability.js";
import type { PluginConfig } from "../config.js";
import type { RestructureConfig } from "../plugin-config.js";
import { parseCommand as parseChain } from "../parser.js";
import type { NormalizedInvocation, RedirectInfo } from "../parser.js";

/** Build a normalized invocation fixture through the parser boundary. */
function inv(command: string, redirects: RedirectInfo[] = []): NormalizedInvocation {
  const parsed = parseChain(command).invocations[0];
  if (!parsed) throw new Error(`unparseable fixture: ${command}`);
  return redirects.length > 0 ? { ...parsed, redirects } : parsed;
}

const defaultConfig: PluginConfig = {
  bashRules: [
    { pattern: "*", action: "ask" },
    { pattern: "git *", action: "allow" },
    { pattern: "sudo *", action: "deny" },
  ],
  editRules: [],
  externalDirectoryRules: [
    { pattern: "./**", action: "allow" },
  ],
  externalDirectoryDefault: "ask",
    toolPermissions: [],
  enabled: true,
};

describe("resolveSegment", () => {
  it("bash deny overrides everything", () => {
    const { action } = resolveSegment(inv("sudo rm -rf /"), "/project", defaultConfig);
    expect(action).toBe("deny");
  });

  it("external_directory violation triggers its action", () => {
    const { action } = resolveSegment(inv("cat /etc/passwd"), "/project", defaultConfig);
    const configNoMatch: PluginConfig = {
      ...defaultConfig,
      bashRules: [{ pattern: "*", action: "ask" }],
      editRules: [],
    };
    const { action: act } = resolveSegment(inv("cat /etc/passwd"), "/project", configNoMatch);
    expect(act).not.toBeNull();
  });

  it("most restrictive wins across checks", () => {
    const config: PluginConfig = {
      bashRules: [{ pattern: "*", action: "ask" }],
      editRules: [],
      externalDirectoryRules: [{ pattern: "*", action: "deny" }],
      externalDirectoryDefault: null,
            toolPermissions: [],
      enabled: true,
    };
    const { action } = resolveSegment(inv("cat /etc/passwd"), "/project", config);
    expect(action).toBe("deny");
  });

  it("no check triggers returns null", () => {
    const config: PluginConfig = {
      bashRules: [],
      editRules: [],
      externalDirectoryRules: [],
      externalDirectoryDefault: null,
            toolPermissions: [],
      enabled: true,
    };
    const { action } = resolveSegment(inv("ls"), "/", config);
    expect(action).toBeNull();
  });
});

describe("resolveChain", () => {
  it("all segments allowed — chain let through", () => {
    const { action: chain } = resolveChain(
      [
        inv("git status"),
        inv("git log"),
      ],
      "/project",
      defaultConfig,
    );
    expect(chain).toBe("allow");
  });

  it("any segment not allowed — chain takes its action", () => {
    const config: PluginConfig = {
      bashRules: [{ pattern: "git *", action: "allow" }],
      editRules: [],
      externalDirectoryRules: [],
      externalDirectoryDefault: null,
            toolPermissions: [],
      enabled: true,
    };
    const { action: chain } = resolveChain(
      [
        inv("git status"),
        inv("rm -rf /"),
      ],
      "/project",
      config,
    );
    expect(chain).toBeNull();
  });

  it("deny in any segment denies whole chain", () => {
    const { action: chain } = resolveChain(
      [
        inv("git status"),
        inv("sudo rm -rf /"),
      ],
      "/project",
      defaultConfig,
    );
    expect(chain).toBe("deny");
  });

  it("single segment with no issues", () => {
    const { action: chain } = resolveChain(
      [inv("git status")],
      "/project",
      defaultConfig,
    );
    expect(chain).toBe("allow");
  });
});

describe("beforeExecute", () => {
  it("ignores non-Bash tools", () => {
    const result = beforeExecute("Edit", "/", {}, defaultConfig);
    expect(result.shouldWrap).toBe(false);
    expect(result.permissionOverride).toBeNull();
  });

  it("handles lowercase bash tool name", () => {
    const result = beforeExecute("bash", "/", { command: "git status && sudo rm" }, defaultConfig);
    expect(result.chainAction).toBe("deny");
    expect(result.permissionOverride).toBe("deny");
  });

  it("handles capitalized Bash tool name", () => {
    const result = beforeExecute("Bash", "/", { command: "git status && sudo rm" }, defaultConfig);
    expect(result.chainAction).toBe("deny");
    expect(result.permissionOverride).toBe("deny");
  });

  it("wraps and returns deny override for parse errors", () => {
    const result = beforeExecute("Bash", "/", { command: "echo \"hello" }, defaultConfig);
    expect(result.chainAction).toBe("deny");
    expect(result.permissionOverride).toBe("deny");
  });

  it("returns no action for empty command", () => {
    const result = beforeExecute("Bash", "/", { command: "" }, defaultConfig);
    expect(result.shouldWrap).toBe(false);
    expect(result.chainAction).toBeNull();
    expect(result.permissionOverride).toBeNull();
  });

  it("wraps and returns deny override for denied chains", () => {
    const result = beforeExecute("Bash", "/", { command: "sudo rm -rf /" }, defaultConfig);
    expect(result.shouldWrap).toBe(true);
    expect(result.chainAction).toBe("deny");
    expect(result.permissionOverride).toBe("deny");
  });
});

describe("permissionOverride", () => {
  it("returns deny for denied decisions", () => {
    const result = beforeExecute("Bash", "/", { command: "sudo rm -rf /" }, defaultConfig);
    expect(result.permissionOverride).toBe("deny");
  });

  it("returns null for native ask decisions", () => {
    const config: PluginConfig = {
      bashRules: [{ pattern: "*", action: "ask" }],
      editRules: [],
      externalDirectoryRules: [],
      externalDirectoryDefault: null,
            toolPermissions: [],
      enabled: true,
    };
    const result = beforeExecute("Bash", "/", { command: "some-unknown-cmd" }, config);
    expect(result.permissionOverride).toBeNull();
  });

  it("returns null for glob-only allow decisions", () => {
    const result = beforeExecute("Bash", "/", { command: "git status" }, defaultConfig);
    expect(result.permissionOverride).toBeNull();
  });
});

describe("checkComplexity", () => {
  const enabled: RestructureConfig = { enabled: true, maxSegments: 3, maxDepth: 2 };

  it("disabled config → never violated", () => {
    const chain = parseChain("a && b && c && d");
    expect(checkComplexity("a && b && c && d", chain, { enabled: false, maxSegments: 3, maxDepth: 2 })).toBeNull();
  });

  it("boundary: N == max passes, N+1 throws", () => {
    expect(checkComplexity("a && b && c", parseChain("a && b && c"), enabled)).toBeNull();
    expect(checkComplexity("a && b && c && d", parseChain("a && b && c && d"), enabled)).toEqual({
      kind: "segments",
      segmentCount: 4,
    });
  });

  it("boundary: depth N == max passes, N+1 throws", () => {
    expect(checkComplexity("echo $(whoami)", parseChain("echo $(whoami)"), enabled)).toBeNull();
    expect(checkComplexity("echo $(echo $(whoami))", parseChain("echo $(echo $(whoami))"), enabled)).toEqual({
      kind: "depth",
    });
  });

  it("multi-line: per-line segment limit, one command per line passes", () => {
    const script = "git status\ngit log\ngit diff\ngit show\necho done";
    expect(checkComplexity(script, parseChain(script), enabled)).toBeNull();
  });

  it("multi-line: names worst offending line", () => {
    const script = "a && b && c && d && e\nf && g && h";
    expect(checkComplexity(script, parseChain(script), enabled)).toEqual({
      kind: "segments",
      segmentCount: 5,
      worstLine: 1,
    });
  });

  it("inline-script statement count over threshold is violated", () => {
    const cmd = `python3 -c "import os; os.system('a'); os.system('b'); os.system('c'); os.system('d')"`;
    expect(checkComplexity(cmd, parseChain(cmd), enabled)).toEqual({
      kind: "inline-script",
      interpreter: "python -c",
      statementCount: 5,
    });
  });

  it("meta-command body counts toward segments", () => {
    const cmd = 'bash -c "a && b && c && d"';
    const violation = checkComplexity(cmd, parseChain(cmd), enabled);
    expect(violation).not.toBeNull();
    expect(violation!.kind).toBe("segments");
  });

  it("simple command passes", () => {
    expect(checkComplexity("git status", parseChain("git status"), enabled)).toBeNull();
  });
});

describe("buildRejectionMessage", () => {
  const enabled: RestructureConfig = { enabled: true, maxSegments: 3, maxDepth: 2 };

  it("single-line message contains counts and instruction", () => {
    const cmd = "git status && rm -rf /tmp/x && echo ok && ls";
    const chain = parseChain(cmd);
    const violation = checkComplexity(cmd, chain, enabled)!;
    const msg = buildRejectionMessage(violation, chain, cmd);
    expect(msg).toContain("[opencode-bash-guard]");
    expect(msg).toContain("4 chained commands");
    expect(msg).toContain("nesting depth 1");
    expect(msg).toContain("Re-issue as separate bash tool calls");
  });

  it("multi-line message names the offending line", () => {
    const cmd = "a && b && c && d && e\nf && g";
    const chain = parseChain(cmd);
    const violation = checkComplexity(cmd, chain, enabled)!;
    const msg = buildRejectionMessage(violation, chain, cmd);
    expect(msg).toContain("Complex command rejected (line 1: 5 chained commands");
  });

  it("inline-script message names interpreter and statements", () => {
    const cmd = `python3 -c "import os; os.system('a'); os.system('b'); os.system('c'); os.system('d')"`;
    const chain = parseChain(cmd);
    const violation = checkComplexity(cmd, chain, enabled)!;
    const msg = buildRejectionMessage(violation, chain, cmd);
    expect(msg).toContain("Complex inline script rejected (python -c: 5 statements)");
    expect(msg).toContain("one statement per line");
    expect(msg).toContain("move the script to a file");
  });
});

describe("restructure enforcement in beforeExecute", () => {
  const askConfig: PluginConfig = {
    bashRules: [{ pattern: "*", action: "ask" }],
    editRules: [],
    externalDirectoryRules: [{ pattern: "./**", action: "allow" }],
    externalDirectoryDefault: "ask",
        toolPermissions: [],
    enabled: true,
  };

  const gitAllowConfig: PluginConfig = {
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

  it("allowed complex chain passes — allowed stays allowed", () => {
    const cmd = "git status && git log && git diff && git show";
    const result = beforeExecute("Bash", "/project", { command: cmd }, gitAllowConfig, enabled);
    expect(result.chainAction).toBe("allow");
    expect(result.rejectionMessage).toBeNull();
    expect(result.shouldWrap).toBe(false);
  });

  it("complex ask chain rejected with counts and instruction", () => {
    const cmd = "git status && rm -rf /tmp/x && echo ok && ls";
    const result = beforeExecute("Bash", "/project", { command: cmd }, gitAllowConfig, enabled);
    expect(result.rejectionMessage).not.toBeNull();
    expect(result.rejectionMessage).toContain("4");
    expect(result.rejectionMessage).toContain("Re-issue as separate bash tool calls");
    expect(result.shouldWrap).toBe(false);
  });

  it("rejected ask chain returns no permission override", () => {
    const cmd = "git status && rm -rf /tmp/x && echo ok && ls";
    const result = beforeExecute("Bash", "/project", { command: cmd }, gitAllowConfig, enabled);
    expect(result.permissionOverride).toBeNull();
  });

  it("multi-line one-command-per-line re-issue passes the complexity gate", () => {
    const cmd = "git status\nrm -rf /tmp/x\necho ok\nls";
    const result = beforeExecute("Bash", "/project", { command: cmd }, askConfig, enabled);
    expect(result.rejectionMessage).toBeNull();
    expect(result.chainAction).toBe("ask");
    expect(result.shouldWrap).toBe(true);
  });

  it("2-line script of 5-segment chains rejected naming the line", () => {
    const cmd = "git a1 && git a2 && git a3 && git a4 && rm -rf /tmp/x\ngit b1 && git b2 && git b3 && git b4 && rm -rf /tmp/y";
    const result = beforeExecute("Bash", "/project", { command: cmd }, askConfig, enabled);
    expect(result.rejectionMessage).not.toBeNull();
    expect(result.rejectionMessage).toContain("line 1: 5 chained commands");
  });

  it("inline python3 -c with 5 statements throws", () => {
    const cmd = `git status && python3 -c "import os; os.system('a'); os.system('b'); os.system('c'); os.system('d')"`;
    const result = beforeExecute("Bash", "/project", { command: cmd }, gitAllowConfig, enabled);
    expect(result.rejectionMessage).not.toBeNull();
    expect(result.rejectionMessage).toContain("Complex inline script rejected");
  });

  it("pretty inline script passes the gate and follows the plain ask flow", () => {
    const cmd = 'git status && python3 -c "import os\nos.system(\'a\')\nos.system(\'b\')"';
    const result = beforeExecute("Bash", "/project", { command: cmd }, gitAllowConfig, enabled);
    expect(result.rejectionMessage).toBeNull();
    expect(result.chainAction).toBe("ask");
    expect(result.shouldWrap).toBe(true);
  });

  it("feature disabled — complex ask chain follows the plain ask flow", () => {
    const cmd = "git status && rm -rf /tmp/x && echo ok && ls";
    const result = beforeExecute("Bash", "/project", { command: cmd }, gitAllowConfig, disabled);
    expect(result.rejectionMessage).toBeNull();
    expect(result.chainAction).toBe("ask");
    expect(result.shouldWrap).toBe(true);
  });

  it("deny flow unchanged even when limits exceeded", () => {
    const denyPushConfig: PluginConfig = {
      bashRules: [
        { pattern: "*", action: "ask" },
        { pattern: "git *", action: "allow" },
        { pattern: "git push *", action: "deny" },
      ],
      editRules: [],
      externalDirectoryRules: [{ pattern: "./**", action: "allow" }],
      externalDirectoryDefault: "ask",
            toolPermissions: [],
      enabled: true,
    };
    const cmd = "git push --force && git status && git log && git show";
    const result = beforeExecute("Bash", "/project", { command: cmd }, denyPushConfig, enabled);
    expect(result.rejectionMessage).toBeNull();
    expect(result.chainAction).toBe("deny");
    expect(result.shouldWrap).toBe(true);
  });

  it("no-opinion chain unchanged even when limits exceeded", () => {
    const noRules: PluginConfig = {
      bashRules: [],
      editRules: [],
      externalDirectoryRules: [],
      externalDirectoryDefault: null,
            toolPermissions: [],
      enabled: true,
    };
    const cmd = "a && b && c && d";
    const result = beforeExecute("Bash", "/project", { command: cmd }, noRules, enabled);
    expect(result.rejectionMessage).toBeNull();
    expect(result.chainAction).toBeNull();
    expect(result.shouldWrap).toBe(false);
  });

  it("parse error unchanged — fail-closed deny", () => {
    const cmd = 'echo "unbalanced';
    const result = beforeExecute("Bash", "/project", { command: cmd }, askConfig, enabled);
    expect(result.rejectionMessage).toBeNull();
    expect(result.chainAction).toBe("deny");
  });

  it("repeated violation re-throws with the same message (no counter)", () => {
    const cmd = "git status && rm -rf /tmp/x && echo ok && ls";
    const first = beforeExecute("Bash", "/project", { command: cmd }, gitAllowConfig, enabled);
    const second = beforeExecute("Bash", "/project", { command: cmd }, gitAllowConfig, enabled);
    expect(second.rejectionMessage).toBe(first.rejectionMessage);
    expect(second.rejectionMessage).not.toBeNull();
  });
});

describe("redirect enforcement", () => {
  const cwd = "/project";

  it("well-known fd redirect does not trigger edit check", () => {
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
    ]), cwd, config);
    expect(action).toBe("allow");
  });

  it("/dev/null redirect does not trigger edit check", () => {
    const config: PluginConfig = {
      bashRules: [{ pattern: "*", action: "allow" }],
      editRules: [{ pattern: "*", action: "deny" }],
      externalDirectoryRules: [],
      externalDirectoryDefault: null,
            toolPermissions: [],
      enabled: true,
    };
    const { action } = resolveSegment(inv("ls", [
      { operator: ">", target: "/dev/null", fileDescriptor: undefined, wellKnown: true },
    ]), cwd, config);
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
    ]), cwd, config);
    expect(action).toBe("allow");
  });

  it("file redirect outside cwd checks both edit and external_directory", () => {
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
    ]), cwd, config);
    expect(action).toBe("deny");
  });

  it("file redirect outside cwd with denied external_directory", () => {
    const config: PluginConfig = {
      bashRules: [{ pattern: "*", action: "allow" }],
      editRules: [],
      externalDirectoryRules: [],
      externalDirectoryDefault: "deny",
            toolPermissions: [],
      enabled: true,
    };
    const { action } = resolveSegment(inv("ls", [
      { operator: ">", target: "/tmp/foo", fileDescriptor: undefined, wellKnown: false },
    ]), cwd, config);
    expect(action).toBe("deny");
  });

  it("redirect with ask edit rule produces ask", () => {
    const config: PluginConfig = {
      bashRules: [{ pattern: "*", action: "allow" }],
      editRules: [{ pattern: "*", action: "ask" }],
      externalDirectoryRules: [],
      externalDirectoryDefault: null,
            toolPermissions: [],
      enabled: true,
    };
    const { action } = resolveSegment(inv("ls", [
      { operator: ">", target: "out.txt", fileDescriptor: undefined, wellKnown: false },
    ]), cwd, config);
    expect(action).toBe("ask");
  });

  it("redirect check combined with bash deny still denies", () => {
    const config: PluginConfig = {
      bashRules: [{ pattern: "*", action: "deny" }],
      editRules: [{ pattern: "*", action: "allow" }],
      externalDirectoryRules: [],
      externalDirectoryDefault: null,
            toolPermissions: [],
      enabled: true,
    };
    const { action } = resolveSegment(inv("sudo rm -rf /", [
      { operator: ">", target: "out.txt", fileDescriptor: undefined, wellKnown: false },
    ]), cwd, config);
    expect(action).toBe("deny");
  });
});
