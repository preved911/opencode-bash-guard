import { describe, it, expect } from "vitest";
import { beforeExecute } from "../enforce.js";
import type { SegmentCheckWork } from "../enforce.js";
import { resolveSegment, resolveChain } from "../policy.js";
import { checkComplexity, buildRejectionMessage } from "../readability.js";
import { validateToolPermissions } from "../config.js";
import type { PluginConfig } from "../config.js";
import type { RestructureConfig } from "../plugin-config.js";

/**
 * Adapter for the async enforcement signature: keeps the historical
 * (tool, cwd, args, config, restructure, degraded) call shape in tests and
 * supplies a resolver returning the historical cwd plus a fail-safe runner.
 */
const runBefore = (
  tool: string,
  cwd: string,
  args: Parameters<typeof beforeExecute>[1],
  config: Parameters<typeof beforeExecute>[2],
  restructure?: Parameters<typeof beforeExecute>[4],
  degraded?: boolean,
) =>
  beforeExecute(tool, args, config, {
    sessionID: "session-test",
    callID: "call-test",
    resolveCwd: async () => cwd,
    runCheck: async () => "error",
  }, restructure, degraded);

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
  it("bash deny overrides everything", async () => {
    const { action } = resolveSegment(inv("sudo rm -rf /"), "/project", defaultConfig);
    expect(action).toBe("deny");
  });

  it("external_directory violation triggers its action", async () => {
    const { action } = resolveSegment(inv("cat /etc/passwd"), "/project", defaultConfig);
    const configNoMatch: PluginConfig = {
      ...defaultConfig,
      bashRules: [{ pattern: "*", action: "ask" }],
      editRules: [],
    };
    const { action: act } = resolveSegment(inv("cat /etc/passwd"), "/project", configNoMatch);
    expect(act).not.toBeNull();
  });

  it("most restrictive wins across checks", async () => {
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

  it("no check triggers returns null", async () => {
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
  it("all segments allowed — chain let through", async () => {
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

  it("any segment not allowed — chain takes its action", async () => {
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

  it("deny in any segment denies whole chain", async () => {
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

  it("single segment with no issues", async () => {
    const { action: chain } = resolveChain(
      [inv("git status")],
      "/project",
      defaultConfig,
    );
    expect(chain).toBe("allow");
  });
});

describe("beforeExecute", () => {
  it("ignores non-Bash tools", async () => {
    const result = await runBefore("Edit", "/", {}, defaultConfig);
    expect(result.shouldWrap).toBe(false);
    expect(result.permissionOverride).toBeNull();
  });

  it("handles lowercase bash tool name", async () => {
    const result = await runBefore("bash", "/", { command: "git status && sudo rm" }, defaultConfig);
    expect(result.chainAction).toBe("deny");
    expect(result.permissionOverride).toBe("deny");
  });

  it("handles capitalized Bash tool name", async () => {
    const result = await runBefore("Bash", "/", { command: "git status && sudo rm" }, defaultConfig);
    expect(result.chainAction).toBe("deny");
    expect(result.permissionOverride).toBe("deny");
  });

  it("wraps and returns deny override for parse errors", async () => {
    const result = await runBefore("Bash", "/", { command: "echo \"hello" }, defaultConfig);
    expect(result.chainAction).toBe("deny");
    expect(result.permissionOverride).toBe("deny");
  });

  it("returns no action for empty command", async () => {
    const result = await runBefore("Bash", "/", { command: "" }, defaultConfig);
    expect(result.shouldWrap).toBe(false);
    expect(result.chainAction).toBeNull();
    expect(result.permissionOverride).toBeNull();
  });

  it("wraps and returns deny override for denied chains", async () => {
    const result = await runBefore("Bash", "/", { command: "sudo rm -rf /" }, defaultConfig);
    expect(result.shouldWrap).toBe(true);
    expect(result.chainAction).toBe("deny");
    expect(result.permissionOverride).toBe("deny");
  });
});

describe("permissionOverride", () => {
  it("returns deny for denied decisions", async () => {
    const result = await runBefore("Bash", "/", { command: "sudo rm -rf /" }, defaultConfig);
    expect(result.permissionOverride).toBe("deny");
  });

  it("returns null for native ask decisions", async () => {
    const config: PluginConfig = {
      bashRules: [{ pattern: "*", action: "ask" }],
      editRules: [],
      externalDirectoryRules: [],
      externalDirectoryDefault: null,
            toolPermissions: [],
      enabled: true,
    };
    const result = await runBefore("Bash", "/", { command: "some-unknown-cmd" }, config);
    expect(result.permissionOverride).toBeNull();
  });

  it("returns null for glob-only allow decisions", async () => {
    const result = await runBefore("Bash", "/", { command: "git status" }, defaultConfig);
    expect(result.permissionOverride).toBeNull();
  });
});

describe("checkComplexity", () => {
  const enabled: RestructureConfig = { enabled: true, maxSegments: 3, maxDepth: 2 };

  it("disabled config → never violated", async () => {
    const chain = parseChain("a && b && c && d");
    expect(checkComplexity("a && b && c && d", chain, { enabled: false, maxSegments: 3, maxDepth: 2 })).toBeNull();
  });

  it("boundary: N == max passes, N+1 throws", async () => {
    expect(checkComplexity("a && b && c", parseChain("a && b && c"), enabled)).toBeNull();
    expect(checkComplexity("a && b && c && d", parseChain("a && b && c && d"), enabled)).toEqual({
      kind: "segments",
      segmentCount: 4,
    });
  });

  it("boundary: depth N == max passes, N+1 throws", async () => {
    expect(checkComplexity("echo $(whoami)", parseChain("echo $(whoami)"), enabled)).toBeNull();
    expect(checkComplexity("echo $(echo $(whoami))", parseChain("echo $(echo $(whoami))"), enabled)).toEqual({
      kind: "depth",
    });
  });

  it("multi-line: per-line segment limit, one command per line passes", async () => {
    const script = "git status\ngit log\ngit diff\ngit show\necho done";
    expect(checkComplexity(script, parseChain(script), enabled)).toBeNull();
  });

  it("multi-line: names worst offending line", async () => {
    const script = "a && b && c && d && e\nf && g && h";
    expect(checkComplexity(script, parseChain(script), enabled)).toEqual({
      kind: "segments",
      segmentCount: 5,
      worstLine: 1,
    });
  });

  it("inline-script statement count over threshold is violated", async () => {
    const cmd = `python3 -c "import os; os.system('a'); os.system('b'); os.system('c'); os.system('d')"`;
    expect(checkComplexity(cmd, parseChain(cmd), enabled)).toEqual({
      kind: "inline-script",
      interpreter: "python -c",
      statementCount: 5,
    });
  });

  it("meta-command body counts toward segments", async () => {
    const cmd = 'bash -c "a && b && c && d"';
    const violation = checkComplexity(cmd, parseChain(cmd), enabled);
    expect(violation).not.toBeNull();
    expect(violation!.kind).toBe("segments");
  });

  it("simple command passes", async () => {
    expect(checkComplexity("git status", parseChain("git status"), enabled)).toBeNull();
  });
});

describe("buildRejectionMessage", () => {
  const enabled: RestructureConfig = { enabled: true, maxSegments: 3, maxDepth: 2 };

  it("single-line message contains counts and instruction", async () => {
    const cmd = "git status && rm -rf /tmp/x && echo ok && ls";
    const chain = parseChain(cmd);
    const violation = checkComplexity(cmd, chain, enabled)!;
    const msg = buildRejectionMessage(violation, chain, cmd);
    expect(msg).toContain("[opencode-bash-guard]");
    expect(msg).toContain("4 chained commands");
    expect(msg).toContain("nesting depth 1");
    expect(msg).toContain("Re-issue as separate bash tool calls");
  });

  it("multi-line message names the offending line", async () => {
    const cmd = "a && b && c && d && e\nf && g";
    const chain = parseChain(cmd);
    const violation = checkComplexity(cmd, chain, enabled)!;
    const msg = buildRejectionMessage(violation, chain, cmd);
    expect(msg).toContain("Complex command rejected (line 1: 5 chained commands");
  });

  it("inline-script message names interpreter and statements", async () => {
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

  it("allowed complex chain passes — allowed stays allowed", async () => {
    const cmd = "git status && git log && git diff && git show";
    const result = await runBefore("Bash", "/project", { command: cmd }, gitAllowConfig, enabled);
    expect(result.chainAction).toBe("allow");
    expect(result.rejectionMessage).toBeNull();
    expect(result.shouldWrap).toBe(false);
  });

  it("complex ask chain rejected with counts and instruction", async () => {
    const cmd = "git status && rm -rf /tmp/x && echo ok && ls";
    const result = await runBefore("Bash", "/project", { command: cmd }, gitAllowConfig, enabled);
    expect(result.rejectionMessage).not.toBeNull();
    expect(result.rejectionMessage).toContain("4");
    expect(result.rejectionMessage).toContain("Re-issue as separate bash tool calls");
    expect(result.shouldWrap).toBe(false);
  });

  it("rejected ask chain returns no permission override", async () => {
    const cmd = "git status && rm -rf /tmp/x && echo ok && ls";
    const result = await runBefore("Bash", "/project", { command: cmd }, gitAllowConfig, enabled);
    expect(result.permissionOverride).toBeNull();
  });

  it("multi-line one-command-per-line re-issue passes the complexity gate", async () => {
    const cmd = "git status\nrm -rf /tmp/x\necho ok\nls";
    const result = await runBefore("Bash", "/project", { command: cmd }, askConfig, enabled);
    expect(result.rejectionMessage).toBeNull();
    expect(result.chainAction).toBe("ask");
    expect(result.shouldWrap).toBe(true);
  });

  it("2-line script of 5-segment chains rejected naming the line", async () => {
    const cmd = "git a1 && git a2 && git a3 && git a4 && rm -rf /tmp/x\ngit b1 && git b2 && git b3 && git b4 && rm -rf /tmp/y";
    const result = await runBefore("Bash", "/project", { command: cmd }, askConfig, enabled);
    expect(result.rejectionMessage).not.toBeNull();
    expect(result.rejectionMessage).toContain("line 1: 5 chained commands");
  });

  it("inline python3 -c with 5 statements throws", async () => {
    const cmd = `git status && python3 -c "import os; os.system('a'); os.system('b'); os.system('c'); os.system('d')"`;
    const result = await runBefore("Bash", "/project", { command: cmd }, gitAllowConfig, enabled);
    expect(result.rejectionMessage).not.toBeNull();
    expect(result.rejectionMessage).toContain("Complex inline script rejected");
  });

  it("pretty inline script passes the gate and follows the plain ask flow", async () => {
    const cmd = 'git status && python3 -c "import os\nos.system(\'a\')\nos.system(\'b\')"';
    const result = await runBefore("Bash", "/project", { command: cmd }, gitAllowConfig, enabled);
    expect(result.rejectionMessage).toBeNull();
    expect(result.chainAction).toBe("ask");
    expect(result.shouldWrap).toBe(true);
  });

  it("feature disabled — complex ask chain follows the plain ask flow", async () => {
    const cmd = "git status && rm -rf /tmp/x && echo ok && ls";
    const result = await runBefore("Bash", "/project", { command: cmd }, gitAllowConfig, disabled);
    expect(result.rejectionMessage).toBeNull();
    expect(result.chainAction).toBe("ask");
    expect(result.shouldWrap).toBe(true);
  });

  it("deny flow unchanged even when limits exceeded", async () => {
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
    const result = await runBefore("Bash", "/project", { command: cmd }, denyPushConfig, enabled);
    expect(result.rejectionMessage).toBeNull();
    expect(result.chainAction).toBe("deny");
    expect(result.shouldWrap).toBe(true);
  });

  it("no-opinion chain unchanged even when limits exceeded", async () => {
    const noRules: PluginConfig = {
      bashRules: [],
      editRules: [],
      externalDirectoryRules: [],
      externalDirectoryDefault: null,
            toolPermissions: [],
      enabled: true,
    };
    const cmd = "a && b && c && d";
    const result = await runBefore("Bash", "/project", { command: cmd }, noRules, enabled);
    expect(result.rejectionMessage).toBeNull();
    expect(result.chainAction).toBeNull();
    expect(result.shouldWrap).toBe(false);
  });

  it("parse error unchanged — fail-closed deny", async () => {
    const cmd = 'echo "unbalanced';
    const result = await runBefore("Bash", "/project", { command: cmd }, askConfig, enabled);
    expect(result.rejectionMessage).toBeNull();
    expect(result.chainAction).toBe("deny");
  });

  it("repeated violation re-throws with the same message (no counter)", async () => {
    const cmd = "git status && rm -rf /tmp/x && echo ok && ls";
    const first = await runBefore("Bash", "/project", { command: cmd }, gitAllowConfig, enabled);
    const second = await runBefore("Bash", "/project", { command: cmd }, gitAllowConfig, enabled);
    expect(second.rejectionMessage).toBe(first.rejectionMessage);
    expect(second.rejectionMessage).not.toBeNull();
  });
});

describe("redirect enforcement", () => {
  const cwd = "/project";

  it("well-known fd redirect does not trigger edit check", async () => {
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

  it("/dev/null redirect does not trigger edit check", async () => {
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

  it("file redirect inside cwd checks only edit rules", async () => {
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

  it("file redirect outside cwd checks both edit and external_directory", async () => {
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

  it("file redirect outside cwd with denied external_directory", async () => {
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

  it("redirect with ask edit rule produces ask", async () => {
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

  it("redirect check combined with bash deny still denies", async () => {
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

describe("external check enforcement", () => {
  const withChecks = (args: unknown[], bashRules: PluginConfig["bashRules"] = [{ pattern: "*", action: "ask" }]): PluginConfig => {
    const validated = validateToolPermissions([{ tool: "tool", args }], () => {}, { allowChecks: true });
    return {
      bashRules,
      editRules: [],
      externalDirectoryRules: [],
      externalDirectoryDefault: null,
      toolPermissions: validated.entries,
      forcedAskTools: validated.forcedAskTools,
      enabled: true,
    };
  };
  const check = (overrides: Record<string, unknown> = {}) => ({
    command: ["/bin/checker"],
    onPass: "allow",
    onFail: "deny",
    onError: "ask",
    timeoutMs: 5000,
    ...overrides,
  });

  interface Call {
    ruleId: string;
    context: { cwd: string; sessionID: string; callID: string };
    effectiveTimeoutMs: number;
  }

  const recordingContext = (
    results: Array<"pass" | "fail" | "error"> | ((call: Call, index: number) => "pass" | "fail" | "error"),
    opts: { cwd?: string | null; budgetMs?: number; now?: () => number; sleepMs?: number } = {},
  ) => {
    const calls: Call[] = [];
    const resolveCalls: string[] = [];
    const context = {
      sessionID: "session-1",
      callID: "call-1",
      resolveCwd: async () => {
        resolveCalls.push("resolve");
        return opts.cwd === undefined ? "/project" : opts.cwd;
      },
      runCheck: async (work: SegmentCheckWork, runContext: { cwd: string; sessionID: string; callID: string }, effectiveTimeoutMs: number) => {
        const call: Call = { ruleId: work.ruleId, context: runContext, effectiveTimeoutMs };
        const index = calls.length;
        calls.push(call);
        if (opts.sleepMs) await new Promise((resolve) => setTimeout(resolve, opts.sleepMs));
        return typeof results === "function" ? results(call, index) : results[index] ?? "error";
      },
      ...(opts.budgetMs !== undefined ? { budgetMs: opts.budgetMs } : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    };
    return { context, calls, resolveCalls };
  };

  const run = async (command: string, config: PluginConfig, ctx: object) =>
    beforeExecute("Bash", { command }, config, ctx as Parameters<typeof beforeExecute>[3]);

  it("plans the whole chain before the first spawn: checks run in segment, entry, then matcher order", async () => {
    const config = withChecks([
      { token: ["one"], check: check() },
      { token: ["one"], check: check({ onPass: "ask" }) },
      { token: ["two"], check: check({ onPass: "deny" }) },
    ]);
    const { context, calls } = recordingContext(["pass", "pass", "pass"]);
    const result = await run("tool one && tool two", config, context);
    expect(calls.map((c) => c.ruleId)).toEqual(["tool:0/matcher:0", "tool:0/matcher:1", "tool:0/matcher:2"]);
    expect(calls.every((c) => c.context.cwd === "/project")).toBe(true);
    expect(result.chainAction).toBe("deny");
  });

  it("unmatched rules never spawn a check", async () => {
    const config = withChecks([
      { token: ["deploy"], check: check() },
      { token: ["destroy"], check: check({ onPass: "deny" }) },
    ]);
    const { context, calls } = recordingContext(["pass"]);
    const result = await run("tool deploy", config, context);
    expect(calls).toHaveLength(1);
    expect(calls[0].ruleId).toBe("tool:0/matcher:0");
    expect(result.chainAction).toBe("allow");
    expect(result.permissionOverride).toBe("allow");
  });

  it("excess checks beyond 16 contribute their own onError without spawning", async () => {
    const args = Array.from({ length: 17 }, (_, i) => ({ token: ["one"], check: check({ onPass: "allow", onError: "deny" }) }));
    const config = withChecks(args);
    const { context, calls } = recordingContext(Array.from({ length: 16 }, () => "pass" as const));
    const result = await run("tool one", config, context);
    expect(calls).toHaveLength(16);
    expect(result.chainAction).toBe("deny");
  });

  it("clamps each started check to the lesser of its timeout and the remaining budget", async () => {
    let fakeNow = 0;
    const config = withChecks([
      { token: ["one"], check: check({ timeoutMs: 5000 }) },
      { token: ["one"], check: check({ timeoutMs: 5000 }) },
    ]);
    const calls: Array<{ ruleId: string; effectiveTimeoutMs: number }> = [];
    const context = {
      sessionID: "session-1",
      callID: "call-1",
      resolveCwd: async () => "/project",
      runCheck: async (work: SegmentCheckWork, _runContext: { cwd: string }, effectiveTimeoutMs: number) => {
        calls.push({ ruleId: work.ruleId, effectiveTimeoutMs });
        fakeNow += 400;
        return "pass" as const;
      },
      budgetMs: 1000,
      now: () => fakeNow,
    };
    await run("tool one", config, context);
    expect(calls).toHaveLength(2);
    expect(calls[0].effectiveTimeoutMs).toBe(1000);
    expect(calls[1].effectiveTimeoutMs).toBe(600);
  });

  it("budget-unstarted checks contribute their own onError without spawning", async () => {
    let fakeNow = 0;
    const config = withChecks([
      { token: ["one"], check: check({ timeoutMs: 900 }) },
      { token: ["one"], check: check({ onPass: "allow", onError: "deny" }) },
    ]);
    const calls: string[] = [];
    const context = {
      sessionID: "session-1",
      callID: "call-1",
      resolveCwd: async () => "/project",
      runCheck: async (_work: SegmentCheckWork, _runContext: { cwd: string }, _effectiveTimeoutMs: number) => {
        calls.push("spawn");
        fakeNow += 1500;
        return "pass" as const;
      },
      budgetMs: 1000,
      now: () => fakeNow,
    };
    const result = await run("tool one", config, context);
    expect(calls).toHaveLength(1);
    expect(result.chainAction).toBe("deny");
  });

  it("aggregates pass, fail, runner error, and unstarted outcomes restrictively", async () => {
    const passAllow = withChecks([{ token: ["one"], check: check({ onPass: "allow" }) }]);
    const passResult = await run("tool one", passAllow, recordingContext(["pass"]).context);
    expect(passResult.chainAction).toBe("allow");
    expect(passResult.permissionOverride).toBe("allow");

    const failDeny = withChecks([{ token: ["one"], check: check({ onFail: "deny" }) }]);
    const failResult = await run("tool one", failDeny, recordingContext(["fail"]).context);
    expect(failResult.chainAction).toBe("deny");

    const errorAsk = withChecks([{ token: ["one"], check: check({ onError: "ask" }) }]);
    const errorResult = await run("tool one", errorAsk, recordingContext(["error"]).context);
    expect(errorResult.chainAction).toBe("ask");
    expect(errorResult.permissionOverride).toBeNull();
  });

  it("a checked pass cannot override an independent ask or deny", async () => {
    const withAsk = withChecks([
      { token: ["one"], action: "ask" },
      { token: ["one"], check: check({ onPass: "allow" }) },
    ]);
    const askResult = await run("tool one", withAsk, recordingContext(["pass"]).context);
    expect(askResult.chainAction).toBe("ask");

    const withDeny = withChecks([
      { token: ["one"], action: "deny" },
      { token: ["one"], check: check({ onPass: "allow" }) },
    ]);
    const denyResult = await run("tool one", withDeny, recordingContext(["pass"]).context);
    expect(denyResult.chainAction).toBe("deny");
    expect(denyResult.permissionOverride).toBe("deny");
  });

  it("a checked pass retains the args-level override over a native ask", async () => {
    const config = withChecks([{ token: ["one"], check: check({ onPass: "allow" }) }]);
    const result = await run("tool one", config, recordingContext(["pass"]).context);
    expect(result.chainAction).toBe("allow");
    expect(result.permissionOverride).toBe("allow");
    expect(result.shouldWrap).toBe(false);
  });

  it("a checked error prevents glob fallback", async () => {
    const config = withChecks([{ token: ["one"], check: check({ onError: "ask" }) }], [
      { pattern: "*", action: "ask" },
      { pattern: "tool *", action: "allow" },
    ]);
    const result = await run("tool one", config, recordingContext(["error"]).context);
    expect(result.chainAction).toBe("ask");
    expect(result.shouldWrap).toBe(true);
  });

  it("per-segment checks feed chain aggregation", async () => {
    const config = withChecks([
      { token: ["one"], check: check({ onPass: "allow" }) },
      { token: ["two"], check: check({ onPass: "ask", onFail: "deny" }) },
    ]);
    const result = await run("tool one && tool two", config, recordingContext(["pass", "pass"]).context);
    expect(result.chainAction).toBe("ask");
    expect(result.permissionOverride).toBeNull();
  });

  it("session lookup failure maps every selected check to its own onError without spawning", async () => {
    const config = withChecks([
      { token: ["one"], check: check({ onError: "deny" }) },
      { token: ["one"], check: check({ onPass: "allow", onError: "deny" }) },
    ]);
    const { context, calls } = recordingContext([], { cwd: null });
    const result = await run("tool one", config, context);
    expect(calls).toHaveLength(0);
    expect(result.chainAction).toBe("deny");
  });

  it("invocations without checks or path policy perform no cwd lookup", async () => {
    const config = withChecks([{ token: "--flag", action: "allow" }]);
    const { context, resolveCalls } = recordingContext([]);
    const result = await run("tool --flag", config, context);
    expect(resolveCalls).toHaveLength(0);
    expect(result.chainAction).toBe("allow");
  });
});
