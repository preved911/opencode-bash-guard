import { afterAll, describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { PluginInput } from "@opencode-ai/plugin";
import BashGuardPlugin from "../index.js";
import type { BashGuardHooks } from "../adapter.js";

/**
 * Resolver-injection contract: the plugin entry must inject a session-directory
 * resolver that reads `Session.directory` through
 * `client.session.get({ path: { id: sessionID }, throwOnError: true })` for the
 * current invocation — never plugin-initialization `input.directory`.
 *
 * The proof runs a real checked matcher from a temp project config: the checker
 * records the request it receives and its process cwd, and the resolved
 * directory must be the one the mocked SDK returned — not the initialization
 * directory the plugin was created with.
 */

interface SessionGetCall {
  id: string;
  throwOnError: boolean;
}

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeProject(withCheck: boolean): { projectDir: string; checkerOut: string } {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "obg-index-proj-"));
  roots.push(projectDir);
  const checkerOut = path.join(projectDir, "checker-out.json");
  const checkerCjs = path.join(projectDir, "checker.cjs");
  fs.writeFileSync(
    checkerCjs,
    `
const fs = require("fs");
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  fs.writeFileSync(process.argv[2], JSON.stringify({
    rawRequest: input,
    processCwd: process.cwd(),
    envKeys: Object.keys(process.env),
  }));
  process.stdout.write(JSON.stringify({ protocolVersion: 1, result: "pass" }));
});
`,
  );
  if (withCheck) {
    fs.mkdirSync(path.join(projectDir, ".opencode"), { recursive: true });
    const config = {
      matcherVersion: 2,
      permissions: [
        {
          tool: "ls",
          args: [
            {
              token: ["file.txt"],
              check: { command: [process.execPath, checkerCjs, checkerOut], onPass: "allow", onFail: "deny" },
            },
          ],
        },
      ],
    };
    fs.writeFileSync(path.join(projectDir, ".opencode", "opencode-bash-guard.jsonc"), JSON.stringify(config));
  }
  return { projectDir, checkerOut };
}

function makeInput(projectDir: string, sessionDirectory: string | undefined, options: { fail?: boolean } = {}) {
  const sessionGetCalls: SessionGetCall[] = [];
  const input = {
    client: {
      session: {
        get: async (req: { path: { id: string }; throwOnError: boolean }) => {
          sessionGetCalls.push({ id: req.path.id, throwOnError: req.throwOnError });
          if (options.fail) throw new Error("sdk unavailable");
          return { data: sessionDirectory === undefined ? {} : { directory: sessionDirectory } };
        },
      },
      postSessionIdPermissionsPermissionId: async () => ({}),
    },
    project: { id: "project" },
    directory: projectDir,
    worktree: projectDir,
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost:4096"),
    $: async () => ({ exitCode: 0 }),
  };
  return { input: input as unknown as PluginInput, sessionGetCalls };
}

async function configure(hooks: BashGuardHooks): Promise<void> {
  await hooks.config!({
    permission: {
      bash: { "*": "ask", "ls *": "allow" },
    },
  });
}

async function runBash(hooks: BashGuardHooks, sessionID: string, command: string): Promise<{ wrapped: boolean }> {
  const output = { args: { command } };
  await hooks["tool.execute.before"]!({ tool: "Bash", sessionID, callID: `call-${sessionID}` }, output);
  return { wrapped: output.args?.command !== command };
}

async function setup(withCheck: boolean, sessionDirectory: string | undefined, options: { fail?: boolean } = {}) {
  const project = makeProject(withCheck);
  const { input, sessionGetCalls } = makeInput(project.projectDir, sessionDirectory, options);
  const hooks = (await BashGuardPlugin(input)) as BashGuardHooks;
  await configure(hooks);
  return { ...project, input, sessionGetCalls, hooks };
}

describe("index resolver injection", () => {
  it("injects a wrapper that returns client.session.get(...).data.directory as the checker cwd and request context", async () => {
    const sessionWorktree = fs.mkdtempSync(path.join(os.tmpdir(), "obg-index-session-"));
    roots.push(sessionWorktree);
    const { checkerOut, hooks, sessionGetCalls } = await setup(true, sessionWorktree);

    const { wrapped } = await runBash(hooks, "session-1", "ls file.txt");

    expect(sessionGetCalls).toEqual([{ id: "session-1", throwOnError: true }]);
    const recorded = JSON.parse(fs.readFileSync(checkerOut, "utf8"));
    expect(recorded.processCwd).toBe(sessionWorktree);
    const request = JSON.parse(recorded.rawRequest);
    expect(request.context.cwd).toBe(sessionWorktree);
    expect(request.context.sessionID).toBe("session-1");
    expect(request.command).toEqual({ raw: "ls file.txt", executable: "ls", argv: ["file.txt"] });
    expect(wrapped).toBe(false);
  });

  it("never uses plugin-initialization input.directory as the checker cwd", async () => {
    const sessionWorktree = fs.mkdtempSync(path.join(os.tmpdir(), "obg-index-session-"));
    roots.push(sessionWorktree);
    const { projectDir, checkerOut, hooks } = await setup(true, sessionWorktree);

    await runBash(hooks, "session-1", "ls file.txt");

    const recorded = JSON.parse(fs.readFileSync(checkerOut, "utf8"));
    expect(recorded.processCwd).not.toBe(projectDir);
    expect(recorded.processCwd).toBe(sessionWorktree);
  });

  it("resolves freshly per invocation with no caching across calls or sessions", async () => {
    const worktreeA = fs.mkdtempSync(path.join(os.tmpdir(), "obg-index-a-"));
    const worktreeB = fs.mkdtempSync(path.join(os.tmpdir(), "obg-index-b-"));
    roots.push(worktreeA, worktreeB);
    const { checkerOut, input, sessionGetCalls, hooks } = await setup(true, worktreeA);

    await runBash(hooks, "session-1", "ls file.txt");
    const firstRecorded = JSON.parse(fs.readFileSync(checkerOut, "utf8"));
    (input.client.session as { get: (req: { path: { id: string }; throwOnError: boolean }) => Promise<{ data: { directory: string } }> }).get =
      async (req) => {
        sessionGetCalls.push({ id: req.path.id, throwOnError: req.throwOnError });
        return { data: { directory: worktreeB } };
      };
    await runBash(hooks, "session-2", "ls file.txt");

    expect(sessionGetCalls.map((call) => call.id)).toEqual(["session-1", "session-2"]);
    expect(JSON.parse(firstRecorded.rawRequest).context.cwd).toBe(worktreeA);
    const secondRecorded = JSON.parse(fs.readFileSync(checkerOut, "utf8"));
    expect(secondRecorded.processCwd).toBe(worktreeB);
    expect(JSON.parse(secondRecorded.rawRequest).context.cwd).toBe(worktreeB);
  });

  it("lookup failure fails safe: the selected check contributes onError without spawning and relative paths ask", async () => {
    const { checkerOut, sessionGetCalls, hooks } = await setup(true, undefined, { fail: true });

    const { wrapped } = await runBash(hooks, "session-1", "ls file.txt");

    expect(sessionGetCalls).toHaveLength(1);
    expect(fs.existsSync(checkerOut)).toBe(false);
    expect(wrapped).toBe(true);
  });

  it("missing Session.directory fails safe the same way", async () => {
    const { checkerOut, sessionGetCalls, hooks } = await setup(true, undefined);

    const { wrapped } = await runBash(hooks, "session-1", "ls file.txt");

    expect(sessionGetCalls).toHaveLength(1);
    expect(fs.existsSync(checkerOut)).toBe(false);
    expect(wrapped).toBe(true);
  });
});
