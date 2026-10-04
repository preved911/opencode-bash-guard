import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { beforeExecute, handlePermissionAsk, clearStoredDecision, getStoredDecision } from "../enforce.js";
import { createBashGuardHooks } from "../adapter.js";
import type { PluginConfig } from "../config.js";
import type { RestructureConfig } from "../plugin-config.js";

/**
 * Characterization tests (task 1.4): lock end-to-end hook behavior — readability
 * thresholds and messages, command wrapping, single-use callID handoff and cleanup
 * between `tool.execute.before` and `permission.ask`, and unchanged prompt count
 * and trigger points across allow, ask, deny, chained, nested, empty, disabled,
 * error, and cancellation paths.
 *
 * Prompt-cardinality model (observable invariant):
 * - allow / no-opinion / empty / disabled / readability-rejected → 0 prompts
 * - ask → exactly 1 prompt (permission.ask fires; stored decision is single-use)
 * - deny → exactly 1 prompt trigger (permission.ask fires and is forced to deny)
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

/** Simulate the full hook sequence for one tool invocation and count prompts. */
function runHooks(tool: string, callID: string, command: string, config: PluginConfig, restructure: RestructureConfig, degraded = false) {
  const prompts: Array<"ask" | "deny" | "allow"> = [];
  const result = beforeExecute(tool, callID, "s1", "/project", { command }, config, restructure, degraded);

  if (result.rejectionMessage) {
    // index.ts throws — nothing executes, no dialog, no stored decision.
    return { result, prompts, thrown: result.rejectionMessage };
  }

  if (result.shouldWrap && result.chainAction) {
    // adapter wraps: `{ cmd; }` — one prompt trigger follows via permission.ask
  }

  // permission.ask fires for ask/deny (opencode asks the human); allow/no-opinion never triggers it.
  if (result.chainAction === "ask" || result.chainAction === "deny") {
    const output = { status: "ask" as const };
    handlePermissionAsk({ sessionID: "s1", callID }, output);
    prompts.push(output.status);
  }

  return { result, prompts, thrown: null };
}

describe("characterization: prompt cardinality per path", () => {
  beforeEach(() => {
    clearStoredDecision("s1", "card");
  });

  it("allow → 0 prompts, no stored decision, no wrap", () => {
    const { result, prompts } = runHooks("Bash", "card", "git status", nativeAskAll, enabled);
    expect(result.chainAction).toBe("allow");
    expect(result.shouldWrap).toBe(false);
    expect(prompts).toHaveLength(0);
    expect(getStoredDecision("s1", "card")).toBeUndefined();
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
    const { result, prompts } = runHooks("Bash", "card", "ls -la", config, enabled);
    expect(result.chainAction).toBeNull();
    expect(result.shouldWrap).toBe(false);
    expect(prompts).toHaveLength(0);
  });

  it("ask → exactly 1 prompt, wrapped, decision consumed single-use", () => {
    const { result, prompts } = runHooks("Bash", "card", "wget evil.sh", nativeAskAll, enabled);
    expect(result.chainAction).toBe("ask");
    expect(result.shouldWrap).toBe(true);
    expect(prompts).toEqual(["ask"]);
    // single-use: second permission.ask for the same callID sees nothing
    const output = { status: "ask" as const };
    handlePermissionAsk({ sessionID: "s1", callID: "card" }, output);
    expect(output.status).toBe("ask");
  });

  it("deny → exactly 1 prompt trigger forced to deny, wrapped", () => {
    const { result, prompts } = runHooks("Bash", "card", "sudo rm -rf /", nativeAskAll, enabled);
    expect(result.chainAction).toBe("deny");
    expect(result.shouldWrap).toBe(true);
    expect(prompts).toEqual(["deny"]);
  });

  it("chained ask → exactly 1 prompt for the whole chain", () => {
    const { result, prompts } = runHooks("Bash", "card", "git status && wget evil.sh", nativeAskAll, enabled);
    expect(result.chainAction).toBe("ask");
    expect(prompts).toEqual(["ask"]);
  });

  it("nested ($()) ask → exactly 1 prompt", () => {
    const { result, prompts } = runHooks("Bash", "card", "echo $(wget evil.sh)", nativeAskAll, enabled);
    expect(result.chainAction).toBe("ask");
    expect(prompts).toEqual(["ask"]);
  });

  it("empty command → 0 prompts, no wrap, no stored decision", () => {
    const { result, prompts } = runHooks("Bash", "card", "", nativeAskAll, enabled);
    expect(result.chainAction).toBeNull();
    expect(result.shouldWrap).toBe(false);
    expect(prompts).toHaveLength(0);
    expect(getStoredDecision("s1", "card")).toBeUndefined();
  });

  it("disabled plugin path (non-bash tool) → 0 prompts", () => {
    const { result, prompts } = runHooks("Edit", "card", "anything", nativeAskAll, enabled);
    expect(result.chainAction).toBeNull();
    expect(result.shouldWrap).toBe(false);
    expect(prompts).toHaveLength(0);
  });

  it("parse error → 1 deny prompt, wrapped, fail-closed", () => {
    const { result, prompts } = runHooks("Bash", "card", 'echo "unbalanced', nativeAskAll, enabled);
    expect(result.chainAction).toBe("deny");
    expect(result.shouldWrap).toBe(true);
    expect(prompts).toEqual(["deny"]);
  });

  it("degraded mode → 1 ask prompt even for glob-allowed commands", () => {
    const { result, prompts } = runHooks("Bash", "card", "git status", nativeAskAll, enabled, true);
    expect(result.chainAction).toBe("ask");
    expect(result.shouldWrap).toBe(true);
    expect(prompts).toEqual(["ask"]);
  });

  it("args-level allow → 0 native prompts (forced allow via stored decision)", () => {
    const config: PluginConfig = {
      ...nativeAskAll,
      toolPermissions: [{ tool: "curl", args: [{ token: "-X", pattern: "GET", action: "allow" }], flags: { "-X": 1 } }],
    };
    const { result, prompts } = runHooks("Bash", "card", "curl -X GET https://api.com", config, enabled);
    expect(result.chainAction).toBe("allow");
    expect(result.shouldWrap).toBe(false);
    // The stored allow decision is what forces permission.ask → allow if it fires.
    expect(getStoredDecision("s1", "card")?.action).toBe("allow");
    const output = { status: "ask" as const };
    handlePermissionAsk({ sessionID: "s1", callID: "card" }, output);
    expect(output.status).toBe("allow");
    expect(prompts).toHaveLength(0);
  });

  it("decision stored in before is garbage-collected by tool.execute.after when permission.ask never fires", async () => {
    const hooks = createBashGuardHooks({ directory: "/project" });
    await hooks.config!({ permission: { bash: { "*": "ask", "sudo *": "deny" } } } as any);
    await hooks["tool.execute.before"]!({ tool: "Bash", callID: "lifecycle-1", sessionID: "s" }, { args: { command: "sudo rm -rf /" } });
    expect(getStoredDecision("s", "lifecycle-1")).toBeDefined();

    await hooks["tool.execute.after"]!({ tool: "Bash", callID: "lifecycle-1", sessionID: "s", args: {} }, { title: "", output: "", metadata: {} });
    expect(getStoredDecision("s", "lifecycle-1")).toBeUndefined();
  });

  it("full sequence: before → permission.ask consumes → after is a safe no-op", async () => {
    const hooks = createBashGuardHooks({ directory: "/project" });
    await hooks.config!({ permission: { bash: { "*": "ask" } } } as any);
    await hooks["tool.execute.before"]!({ tool: "Bash", callID: "lifecycle-2", sessionID: "s" }, { args: { command: "wget evil.sh" } });

    const permOutput = { status: "ask" as const };
    await hooks["permission.ask"]!({ sessionID: "s", callID: "lifecycle-2" } as any, permOutput);
    expect(permOutput.status).toBe("ask");
    expect(getStoredDecision("s", "lifecycle-2")).toBeUndefined();

    await hooks["tool.execute.after"]!({ tool: "Bash", callID: "lifecycle-2", sessionID: "s", args: {} }, { title: "", output: "", metadata: {} });
    expect(getStoredDecision("s", "lifecycle-2")).toBeUndefined();
  });

  it("deny decision: ask consumes it; after never sees residue", async () => {
    const hooks = createBashGuardHooks({ directory: "/project" });
    await hooks.config!({ permission: { bash: { "*": "ask", "sudo *": "deny" } } } as any);
    await hooks["tool.execute.before"]!({ tool: "Bash", callID: "lifecycle-3", sessionID: "s" }, { args: { command: "sudo rm -rf /" } });

    const permOutput = { status: "ask" as const };
    await hooks["permission.ask"]!({ sessionID: "s", callID: "lifecycle-3" } as any, permOutput);
    expect(permOutput.status).toBe("deny");
    expect(getStoredDecision("s", "lifecycle-3")).toBeUndefined();
  });

  it("non-bash tools store nothing; after is a no-op", async () => {
    const hooks = createBashGuardHooks({ directory: "/project" });
    await hooks.config!({ permission: { bash: { "*": "ask" } } } as any);
    await hooks["tool.execute.before"]!({ tool: "Edit", callID: "lifecycle-4", sessionID: "s" }, { args: {} });
    expect(getStoredDecision("s", "lifecycle-4")).toBeUndefined();
    await hooks["tool.execute.after"]!({ tool: "Edit", callID: "lifecycle-4", sessionID: "s", args: {} }, { title: "", output: "", metadata: {} });
    expect(getStoredDecision("s", "lifecycle-4")).toBeUndefined();
  });

  it("disabled plugin: before and after are no-ops", async () => {
    const hooks = createBashGuardHooks({ directory: "/project" });
    await hooks.config!({ permission: { bash: "allow" } } as any);
    await hooks["tool.execute.before"]!({ tool: "Bash", callID: "lifecycle-5", sessionID: "s" }, { args: { command: "wget evil.sh" } });
    expect(getStoredDecision("s", "lifecycle-5")).toBeUndefined();
    await hooks["tool.execute.after"]!({ tool: "Bash", callID: "lifecycle-5", sessionID: "s", args: {} }, { title: "", output: "", metadata: {} });
    expect(getStoredDecision("s", "lifecycle-5")).toBeUndefined();
  });

  it("reused callID: the fresh decision overwrites any stale residue", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "obg-lifecycle-"));
    fs.mkdirSync(path.join(project, ".opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(project, ".opencode", "opencode-bash-guard.jsonc"),
      JSON.stringify({
        matcherVersion: 2,
        permissions: [{ tool: "curl", args: [{ token: "-X", pattern: "GET", action: "allow" }], flags: { "-X": 1 } }],
      }),
    );
    const prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(os.tmpdir(), `obg-noxdg-${Date.now()}`);
    try {
      const hooks = createBashGuardHooks({ directory: project });
      await hooks.config!({ permission: { bash: { "*": "ask", "sudo *": "deny" } } } as any);
      await hooks["tool.execute.before"]!({ tool: "Bash", callID: "lifecycle-6", sessionID: "s" }, { args: { command: "sudo rm -rf /" } });
      expect(getStoredDecision("s", "lifecycle-6")?.action).toBe("deny");

      await hooks["tool.execute.before"]!({ tool: "Bash", callID: "lifecycle-6", sessionID: "s" }, { args: { command: "curl -X GET https://x.com" } });
      expect(getStoredDecision("s", "lifecycle-6")?.action).toBe("allow");
    } finally {
      if (prevXdg !== undefined) process.env.XDG_CONFIG_HOME = prevXdg;
      else delete process.env.XDG_CONFIG_HOME;
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("stale decision does not survive a reused callID on a non-storing path", async () => {
    const hooks = createBashGuardHooks({ directory: "/project" });
    await hooks.config!({ permission: { bash: { "*": "ask", "sudo *": "deny" } } } as any);

    await hooks["tool.execute.before"]!({ tool: "Bash", callID: "reuse-stale", sessionID: "s" }, { args: { command: "sudo rm -rf /" } });
    expect(getStoredDecision("s", "reuse-stale")?.action).toBe("deny");

    await hooks["tool.execute.before"]!({ tool: "Bash", callID: "reuse-stale", sessionID: "s" }, { args: { command: "" } });
    expect(getStoredDecision("s", "reuse-stale")).toBeUndefined();

    await hooks["tool.execute.before"]!({ tool: "Edit", callID: "reuse-stale", sessionID: "s" }, { args: {} });
    expect(getStoredDecision("s", "reuse-stale")).toBeUndefined();

    const output = { status: "ask" as const };
    await hooks["permission.ask"]!({ sessionID: "s", callID: "reuse-stale" } as any, output);
    expect(output.status).toBe("ask");
  });

  it("same callID in different sessions holds independent decisions", async () => {
    const hooks = createBashGuardHooks({ directory: "/project" });
    await hooks.config!({ permission: { bash: { "*": "ask", "sudo *": "deny" } } } as any);

    await hooks["tool.execute.before"]!({ tool: "Bash", callID: "shared-id", sessionID: "sessA" }, { args: { command: "sudo rm -rf /" } });
    await hooks["tool.execute.before"]!({ tool: "Bash", callID: "shared-id", sessionID: "sessB" }, { args: { command: "wget evil.sh" } });

    expect(getStoredDecision("sessA", "shared-id")?.action).toBe("deny");
    expect(getStoredDecision("sessB", "shared-id")).toBeUndefined();

    const outA = { status: "ask" as const };
    await hooks["permission.ask"]!({ sessionID: "sessA", callID: "shared-id" } as any, outA);
    expect(outA.status).toBe("deny");

    const outB = { status: "ask" as const };
    await hooks["permission.ask"]!({ sessionID: "sessB", callID: "shared-id" } as any, outB);
    expect(outB.status).toBe("ask");
  });

  it("session.idle clears only that session's orphaned decisions", async () => {
    const hooks = createBashGuardHooks({ directory: "/project" });
    await hooks.config!({ permission: { bash: { "*": "ask", "sudo *": "deny" } } } as any);

    await hooks["tool.execute.before"]!({ tool: "Bash", callID: "idle-1", sessionID: "sessA" }, { args: { command: "sudo rm -rf /" } });
    await hooks["tool.execute.before"]!({ tool: "Bash", callID: "idle-1", sessionID: "sessB" }, { args: { command: "sudo rm -rf /" } });
    expect(getStoredDecision("sessA", "idle-1")).toBeDefined();
    expect(getStoredDecision("sessB", "idle-1")).toBeDefined();

    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "sessA" } } } as any);
    expect(getStoredDecision("sessA", "idle-1")).toBeUndefined();
    expect(getStoredDecision("sessB", "idle-1")).toBeDefined();
  });
});

describe("characterization: command wrapping", () => {
  beforeEach(() => clearStoredDecision("s1", "wrap"));

  it("ask and deny results request wrapping", () => {
    expect(beforeExecute("Bash", "wrap", "s1", "/project", { command: "wget evil.sh" }, nativeAskAll, enabled).shouldWrap).toBe(true);
    expect(beforeExecute("Bash", "wrap", "s1", "/project", { command: "sudo rm -rf /" }, nativeAskAll, enabled).shouldWrap).toBe(true);
  });

  it("allow, no-opinion, empty, and readability-rejected results never wrap", () => {
    expect(beforeExecute("Bash", "wrap", "s1", "/project", { command: "git status" }, nativeAskAll, enabled).shouldWrap).toBe(false);
    expect(
      beforeExecute("Bash", "wrap", "s1", "/project", { command: "ls" }, { bashRules: [], editRules: [], externalDirectoryRules: [], externalDirectoryDefault: null, toolPermissions: [], enabled: true }, enabled)
        .shouldWrap,
    ).toBe(false);
    expect(beforeExecute("Bash", "wrap", "s1", "/project", { command: "" }, nativeAskAll, enabled).shouldWrap).toBe(false);
    const complex = "git status && rm -rf /tmp/x && echo ok && ls";
    expect(beforeExecute("Bash", "wrap", "s1", "/project", { command: complex }, nativeAskAll, enabled).shouldWrap).toBe(false);
  });

  it("tool name matching is case-insensitive; non-bash tools ignored", () => {
    expect(beforeExecute("bash", "wrap", "s1", "/project", { command: "sudo rm -rf /" }, nativeAskAll, enabled).chainAction).toBe("deny");
    expect(beforeExecute("Bash", "wrap", "s1", "/project", { command: "sudo rm -rf /" }, nativeAskAll, enabled).chainAction).toBe("deny");
    expect(beforeExecute("Read", "wrap", "s1", "/project", { command: "sudo rm -rf /" }, nativeAskAll, enabled).chainAction).toBeNull();
  });
});

describe("characterization: readability thresholds and messages", () => {
  beforeEach(() => clearStoredDecision("s1", "read"));

  it("strictly-greater thresholds: N == max passes, N+1 rejected", () => {
    expect(runHooks("Bash", "read", "git a && git b && rm -rf /tmp/x", nativeAskAll, enabled).thrown).toBeNull();
    const over = runHooks("Bash", "read", "git a && git b && git c && rm -rf /tmp/x", nativeAskAll, enabled);
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
    const denyResult = beforeExecute("Bash", "read", "s1", "/project", { command: denyCmd }, denyConfig, enabled);
    expect(denyResult.rejectionMessage).toBeNull();
    expect(denyResult.chainAction).toBe("deny");

    const allowCmd = "git status && git log && git diff && git show";
    const allowResult = beforeExecute("Bash", "read", "s1", "/project", { command: allowCmd }, nativeAskAll, enabled);
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
    const result = beforeExecute("Bash", "read", "s1", "/project", { command: "a && b && c && d" }, config, enabled);
    expect(result.rejectionMessage).toBeNull();
    expect(result.chainAction).toBeNull();
  });

  it("parse errors fail closed before readability runs", () => {
    const result = beforeExecute("Bash", "read", "s1", "/project", { command: 'echo "unbalanced' }, nativeAskAll, enabled);
    expect(result.chainAction).toBe("deny");
    expect(result.rejectionMessage).toBeNull();
  });

  it("multi-line: per-line limit names the worst line", () => {
    const cmd = "git a && git b && git c && git d && rm -rf /tmp/x\ngit e && git f";
    const { result } = runHooks("Bash", "read", cmd, nativeAskAll, enabled);
    expect(result.rejectionMessage).toContain("Complex command rejected (line 1: 5 chained commands");
  });

  it("multi-line one-command-per-line re-issue passes the gate", () => {
    const cmd = "git status\nrm -rf /tmp/x\necho ok\nls";
    const { result, thrown } = runHooks("Bash", "read", cmd, nativeAskAll, enabled);
    expect(thrown).toBeNull();
    expect(result.chainAction).toBe("ask");
    expect(result.shouldWrap).toBe(true);
  });

  it("depth threshold: single $() passes, double $() rejected", () => {
    expect(runHooks("Bash", "read", "echo $(whoami)", nativeAskAll, enabled).thrown).toBeNull();
    const over = runHooks("Bash", "read", "echo $(echo $(whoami))", nativeAskAll, enabled);
    expect(over.thrown).toContain("nesting depth 3");
  });

  it("inline-script statement count over threshold rejected with interpreter name", () => {
    const cmd = `git status && python3 -c "import os; os.system('a'); os.system('b'); os.system('c'); os.system('d')"`;
    const { result, thrown } = runHooks("Bash", "read", cmd, nativeAskAll, enabled);
    expect(thrown).toContain("Complex inline script rejected (python -c: 5 statements)");
    expect(result.shouldWrap).toBe(false);
  });

  it("feature disabled — complex ask chain follows the plain ask flow", () => {
    const cmd = "git status && rm -rf /tmp/x && echo ok && ls";
    const { result, thrown } = runHooks("Bash", "read", cmd, nativeAskAll, disabled);
    expect(thrown).toBeNull();
    expect(result.chainAction).toBe("ask");
    expect(result.shouldWrap).toBe(true);
  });

  it("repeated violation re-throws with the same message (no retry counter)", () => {
    const cmd = "git status && rm -rf /tmp/x && echo ok && ls";
    const first = runHooks("Bash", "read", cmd, nativeAskAll, enabled);
    const second = runHooks("Bash", "read", cmd, nativeAskAll, enabled);
    expect(second.thrown).toBe(first.thrown);
  });

  it("rejected ask chain stores no decision (no dialog follows the throw)", () => {
    const cmd = "git status && rm -rf /tmp/x && echo ok && ls";
    runHooks("Bash", "read", cmd, nativeAskAll, enabled);
    expect(getStoredDecision("s1", "read")).toBeUndefined();
  });
});

describe("characterization: single-use callID handoff", () => {
  beforeEach(() => clearStoredDecision("s1", "handoff"));

  it("deny decision forces permission.ask output to deny exactly once", () => {
    beforeExecute("Bash", "handoff", "s1", "/project", { command: "sudo rm -rf /" }, nativeAskAll, enabled);
    const first = { status: "ask" as const };
    handlePermissionAsk({ sessionID: "s1", callID: "handoff" }, first);
    expect(first.status).toBe("deny");
    const second = { status: "ask" as const };
    handlePermissionAsk({ sessionID: "s1", callID: "handoff" }, second);
    expect(second.status).toBe("ask");
  });

  it("ask decision leaves permission.ask output untouched exactly once", () => {
    beforeExecute("Bash", "handoff", "s1", "/project", { command: "wget evil.sh" }, nativeAskAll, enabled);
    const first = { status: "ask" as const };
    handlePermissionAsk({ sessionID: "s1", callID: "handoff" }, first);
    expect(first.status).toBe("ask");
    const second = { status: "ask" as const };
    handlePermissionAsk({ sessionID: "s1", callID: "handoff" }, second);
    expect(second.status).toBe("ask");
  });

  it("missing callID is a no-op", () => {
    const output = { status: "ask" as const };
    handlePermissionAsk({ sessionID: "s1" }, output);
    expect(output.status).toBe("ask");
  });

  it("unknown callID is a no-op", () => {
    const output = { status: "ask" as const };
    handlePermissionAsk({ sessionID: "s1", callID: "never-stored" }, output);
    expect(output.status).toBe("ask");
  });
});
