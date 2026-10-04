import { describe, it, expect, beforeEach } from "vitest";
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
  const result = beforeExecute(tool, callID, "/project", { command }, config, restructure, degraded);

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
    handlePermissionAsk({ callID }, output);
    prompts.push(output.status);
  }

  return { result, prompts, thrown: null };
}

describe("characterization: prompt cardinality per path", () => {
  beforeEach(() => {
    clearStoredDecision("card");
  });

  it("allow → 0 prompts, no stored decision, no wrap", () => {
    const { result, prompts } = runHooks("Bash", "card", "git status", nativeAskAll, enabled);
    expect(result.chainAction).toBe("allow");
    expect(result.shouldWrap).toBe(false);
    expect(prompts).toHaveLength(0);
    expect(getStoredDecision("card")).toBeUndefined();
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
    handlePermissionAsk({ callID: "card" }, output);
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
    expect(getStoredDecision("card")).toBeUndefined();
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
    expect(getStoredDecision("card")?.action).toBe("allow");
    const output = { status: "ask" as const };
    handlePermissionAsk({ callID: "card" }, output);
    expect(output.status).toBe("allow");
    expect(prompts).toHaveLength(0);
  });

  it("decision stored in before is garbage-collected by tool.execute.after when permission.ask never fires", async () => {
    const hooks = createBashGuardHooks({ directory: "/project" });
    await hooks.config!({ permission: { bash: { "*": "ask" } } } as any);
    await hooks["tool.execute.before"]!({ tool: "Bash", callID: "lifecycle-1", sessionID: "s" }, { args: { command: "wget evil.sh" } });
    expect(getStoredDecision("lifecycle-1")).toBeDefined();

    await hooks["tool.execute.after"]!({ tool: "Bash", callID: "lifecycle-1", sessionID: "s", args: {} }, { title: "", output: "", metadata: {} });
    expect(getStoredDecision("lifecycle-1")).toBeUndefined();
  });

  it("full sequence: before → permission.ask consumes → after is a safe no-op", async () => {
    const hooks = createBashGuardHooks({ directory: "/project" });
    await hooks.config!({ permission: { bash: { "*": "ask" } } } as any);
    await hooks["tool.execute.before"]!({ tool: "Bash", callID: "lifecycle-2", sessionID: "s" }, { args: { command: "wget evil.sh" } });

    const permOutput = { status: "ask" as const };
    await hooks["permission.ask"]!({ callID: "lifecycle-2" } as any, permOutput);
    expect(permOutput.status).toBe("ask");
    expect(getStoredDecision("lifecycle-2")).toBeUndefined();

    await hooks["tool.execute.after"]!({ tool: "Bash", callID: "lifecycle-2", sessionID: "s", args: {} }, { title: "", output: "", metadata: {} });
    expect(getStoredDecision("lifecycle-2")).toBeUndefined();
  });

  it("deny decision: ask consumes it; after never sees residue", async () => {
    const hooks = createBashGuardHooks({ directory: "/project" });
    await hooks.config!({ permission: { bash: { "*": "ask", "sudo *": "deny" } } } as any);
    await hooks["tool.execute.before"]!({ tool: "Bash", callID: "lifecycle-3", sessionID: "s" }, { args: { command: "sudo rm -rf /" } });

    const permOutput = { status: "ask" as const };
    await hooks["permission.ask"]!({ callID: "lifecycle-3" } as any, permOutput);
    expect(permOutput.status).toBe("deny");
    expect(getStoredDecision("lifecycle-3")).toBeUndefined();
  });

  it("non-bash tools store nothing; after is a no-op", async () => {
    const hooks = createBashGuardHooks({ directory: "/project" });
    await hooks.config!({ permission: { bash: { "*": "ask" } } } as any);
    await hooks["tool.execute.before"]!({ tool: "Edit", callID: "lifecycle-4", sessionID: "s" }, { args: {} });
    expect(getStoredDecision("lifecycle-4")).toBeUndefined();
    await hooks["tool.execute.after"]!({ tool: "Edit", callID: "lifecycle-4", sessionID: "s", args: {} }, { title: "", output: "", metadata: {} });
    expect(getStoredDecision("lifecycle-4")).toBeUndefined();
  });

  it("disabled plugin: before and after are no-ops", async () => {
    const hooks = createBashGuardHooks({ directory: "/project" });
    await hooks.config!({ permission: { bash: "allow" } } as any);
    await hooks["tool.execute.before"]!({ tool: "Bash", callID: "lifecycle-5", sessionID: "s" }, { args: { command: "wget evil.sh" } });
    expect(getStoredDecision("lifecycle-5")).toBeUndefined();
    await hooks["tool.execute.after"]!({ tool: "Bash", callID: "lifecycle-5", sessionID: "s", args: {} }, { title: "", output: "", metadata: {} });
    expect(getStoredDecision("lifecycle-5")).toBeUndefined();
  });

  it("reused callID: the fresh decision overwrites any stale residue", async () => {
    const hooks = createBashGuardHooks({ directory: "/project" });
    await hooks.config!({ permission: { bash: { "*": "ask", "sudo *": "deny" } } } as any);
    await hooks["tool.execute.before"]!({ tool: "Bash", callID: "lifecycle-6", sessionID: "s" }, { args: { command: "wget evil.sh" } });
    expect(getStoredDecision("lifecycle-6")?.action).toBe("ask");

    await hooks["tool.execute.before"]!({ tool: "Bash", callID: "lifecycle-6", sessionID: "s" }, { args: { command: "sudo rm -rf /" } });
    expect(getStoredDecision("lifecycle-6")?.action).toBe("deny");
  });

  it("stale decision does not survive a reused callID on a non-storing path", async () => {
    const hooks = createBashGuardHooks({ directory: "/project" });
    await hooks.config!({ permission: { bash: { "*": "ask", "sudo *": "deny" } } } as any);

    await hooks["tool.execute.before"]!({ tool: "Bash", callID: "reuse-stale", sessionID: "s" }, { args: { command: "sudo rm -rf /" } });
    expect(getStoredDecision("reuse-stale")?.action).toBe("deny");

    await hooks["tool.execute.before"]!({ tool: "Bash", callID: "reuse-stale", sessionID: "s" }, { args: { command: "" } });
    expect(getStoredDecision("reuse-stale")).toBeUndefined();

    await hooks["tool.execute.before"]!({ tool: "Edit", callID: "reuse-stale", sessionID: "s" }, { args: {} });
    expect(getStoredDecision("reuse-stale")).toBeUndefined();

    const output = { status: "ask" as const };
    await hooks["permission.ask"]!({ callID: "reuse-stale" } as any, output);
    expect(output.status).toBe("ask");
  });
});

describe("characterization: command wrapping", () => {
  beforeEach(() => clearStoredDecision("wrap"));

  it("ask and deny results request wrapping", () => {
    expect(beforeExecute("Bash", "wrap", "/project", { command: "wget evil.sh" }, nativeAskAll, enabled).shouldWrap).toBe(true);
    expect(beforeExecute("Bash", "wrap", "/project", { command: "sudo rm -rf /" }, nativeAskAll, enabled).shouldWrap).toBe(true);
  });

  it("allow, no-opinion, empty, and readability-rejected results never wrap", () => {
    expect(beforeExecute("Bash", "wrap", "/project", { command: "git status" }, nativeAskAll, enabled).shouldWrap).toBe(false);
    expect(
      beforeExecute("Bash", "wrap", "/project", { command: "ls" }, { bashRules: [], editRules: [], externalDirectoryRules: [], externalDirectoryDefault: null, toolPermissions: [], enabled: true }, enabled)
        .shouldWrap,
    ).toBe(false);
    expect(beforeExecute("Bash", "wrap", "/project", { command: "" }, nativeAskAll, enabled).shouldWrap).toBe(false);
    const complex = "git status && rm -rf /tmp/x && echo ok && ls";
    expect(beforeExecute("Bash", "wrap", "/project", { command: complex }, nativeAskAll, enabled).shouldWrap).toBe(false);
  });

  it("tool name matching is case-insensitive; non-bash tools ignored", () => {
    expect(beforeExecute("bash", "wrap", "/project", { command: "sudo rm -rf /" }, nativeAskAll, enabled).chainAction).toBe("deny");
    expect(beforeExecute("Bash", "wrap", "/project", { command: "sudo rm -rf /" }, nativeAskAll, enabled).chainAction).toBe("deny");
    expect(beforeExecute("Read", "wrap", "/project", { command: "sudo rm -rf /" }, nativeAskAll, enabled).chainAction).toBeNull();
  });
});

describe("characterization: readability thresholds and messages", () => {
  beforeEach(() => clearStoredDecision("read"));

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
    const denyResult = beforeExecute("Bash", "read", "/project", { command: denyCmd }, denyConfig, enabled);
    expect(denyResult.rejectionMessage).toBeNull();
    expect(denyResult.chainAction).toBe("deny");

    const allowCmd = "git status && git log && git diff && git show";
    const allowResult = beforeExecute("Bash", "read", "/project", { command: allowCmd }, nativeAskAll, enabled);
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
    const result = beforeExecute("Bash", "read", "/project", { command: "a && b && c && d" }, config, enabled);
    expect(result.rejectionMessage).toBeNull();
    expect(result.chainAction).toBeNull();
  });

  it("parse errors fail closed before readability runs", () => {
    const result = beforeExecute("Bash", "read", "/project", { command: 'echo "unbalanced' }, nativeAskAll, enabled);
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
    expect(getStoredDecision("read")).toBeUndefined();
  });
});

describe("characterization: single-use callID handoff", () => {
  beforeEach(() => clearStoredDecision("handoff"));

  it("deny decision forces permission.ask output to deny exactly once", () => {
    beforeExecute("Bash", "handoff", "/project", { command: "sudo rm -rf /" }, nativeAskAll, enabled);
    const first = { status: "ask" as const };
    handlePermissionAsk({ callID: "handoff" }, first);
    expect(first.status).toBe("deny");
    const second = { status: "ask" as const };
    handlePermissionAsk({ callID: "handoff" }, second);
    expect(second.status).toBe("ask");
  });

  it("ask decision leaves permission.ask output untouched exactly once", () => {
    beforeExecute("Bash", "handoff", "/project", { command: "wget evil.sh" }, nativeAskAll, enabled);
    const first = { status: "ask" as const };
    handlePermissionAsk({ callID: "handoff" }, first);
    expect(first.status).toBe("ask");
    const second = { status: "ask" as const };
    handlePermissionAsk({ callID: "handoff" }, second);
    expect(second.status).toBe("ask");
  });

  it("missing callID is a no-op", () => {
    const output = { status: "ask" as const };
    handlePermissionAsk({}, output);
    expect(output.status).toBe("ask");
  });

  it("unknown callID is a no-op", () => {
    const output = { status: "ask" as const };
    handlePermissionAsk({ callID: "never-stored" }, output);
    expect(output.status).toBe("ask");
  });
});
