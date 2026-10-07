import { afterAll, afterEach, describe, it, expect, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runExternalCheck, parseCheckResponse, STDOUT_LIMIT_BYTES, STDERR_LIMIT_BYTES, FACTS_LIMIT_BYTES, FACTS_MAX_DEPTH } from "../external-check.js";
import type { SegmentCheckWork } from "../policy.js";
import type { CheckRunContext } from "../enforce.js";

const work = (command: string[], ruleId = "tool:0/matcher:0"): SegmentCheckWork => ({
  ruleId,
  check: { command, onPass: "allow", onFail: "ask", onError: "ask", timeoutMs: 5000 },
  command: { raw: "tool --arg", executable: "tool", argv: ["--arg"] },
});

const context: CheckRunContext = { cwd: os.tmpdir(), sessionID: "session-1", callID: "call-1" };

const nodeWork = (checker: string, ...args: string[]): SegmentCheckWork => work([process.execPath, checker, ...args]);

const checkerDirs: string[] = [];
const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
afterAll(() => {
  for (const dir of checkerDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeChecker(script: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obg-check-"));
  checkerDirs.push(dir);
  const filePath = path.join(dir, "checker.cjs");
  fs.writeFileSync(filePath, script);
  return filePath;
}

/** Checker that records the raw stdin request plus its own argv, cwd and env to a file, then answers. */
const recordingChecker = writeChecker(`
const fs = require("fs");
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  fs.writeFileSync(process.argv[2], JSON.stringify({
    rawStdin: input,
    argv: process.argv.slice(3),
    cwd: process.cwd(),
    envKeys: Object.keys(process.env),
    stdinEnded: true,
  }));
  process.stdout.write(JSON.stringify({ protocolVersion: 1, result: "pass" }));
});
`);

/** Checker that writes a fixed stdout body and exits with a fixed code. */
const scriptedChecker = writeChecker(`
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const body = process.argv[2] === "@REQUEST" ? input : process.argv[2];
  if (body !== "") process.stdout.write(body);
  process.exit(Number(process.argv[3] ?? 0));
});
`);

describe("external check protocol: request", () => {
  it("sends one newline-terminated request with exactly the version-1 shape", async () => {
    const out = path.join(path.dirname(recordingChecker), "req.json");
    const result = await runExternalCheck(nodeWork(recordingChecker, out, "extra-arg"), context, 5000);
    expect(result).toBe("pass");

    const recorded = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(recorded.rawStdin.endsWith("\n")).toBe(true);
    expect(recorded.rawStdin.endsWith("\n\n")).toBe(false);
    const request = JSON.parse(recorded.rawStdin);
    expect(Object.keys(request).sort()).toEqual(["command", "context", "match", "protocolVersion"]);
    expect(request.protocolVersion).toBe(1);
    expect(request.context).toEqual({ cwd: context.cwd, sessionID: "session-1", callID: "call-1" });
    expect(request.command).toEqual({ raw: "tool --arg", executable: "tool", argv: ["--arg"] });
    expect(request.match).toEqual({ ruleId: "tool:0/matcher:0" });
  });

  it("command.argv excludes command.executable", async () => {
    const out = path.join(path.dirname(recordingChecker), "req-argv.json");
    await runExternalCheck(nodeWork(recordingChecker, out, "a", "b"), context, 5000);
    const recorded = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(recorded.argv).toEqual(["a", "b"]);
    const request = JSON.parse(recorded.rawStdin);
    expect(request.command.executable).toBe("tool");
    expect(request.command.argv).toEqual(["--arg"]);
    expect(request.command.argv).not.toContain("tool");
  });

  it("ruleId is the deterministic zero-based identity assigned after precedence resolution", async () => {
    const out = path.join(path.dirname(recordingChecker), "req-rule.json");
    await runExternalCheck(work([process.execPath, recordingChecker, out], "tool:0/matcher:2"), context, 5000);
    expect(JSON.parse(fs.readFileSync(out, "utf8")).rawStdin).toContain('"tool:0/matcher:2"');
  });
});

describe("external check protocol: response", () => {
  const run = (body: string, exitCode = 0) =>
    runExternalCheck(nodeWork(scriptedChecker, body, String(exitCode)), context, 5000);

  it("maps pass to onPass selection and fail to onFail selection", async () => {
    await expect(run('{"protocolVersion":1,"result":"pass"}')).resolves.toBe("pass");
    await expect(run('{"protocolVersion":1,"result":"fail"}')).resolves.toBe("fail");
  });

  it("accepts optional facts and exact version", async () => {
    await expect(run('{"protocolVersion":1,"result":"pass","facts":{}}')).resolves.toBe("pass");
    await expect(run('{"protocolVersion":1,"result":"fail","facts":{"branch":"main"}}')).resolves.toBe("fail");
  });

  it("rejects unknown, missing, or extra fields and returned permission actions", async () => {
    await expect(run('{"protocolVersion":1,"result":"pass","action":"allow"}')).resolves.toBe("error");
    await expect(run('{"protocolVersion":1,"result":"pass","extra":1}')).resolves.toBe("error");
    await expect(run('{"result":"pass"}')).resolves.toBe("error");
    await expect(run('{"protocolVersion":1}')).resolves.toBe("error");
    await expect(run('{"protocolVersion":2,"result":"pass"}')).resolves.toBe("error");
    await expect(run('{"protocolVersion":1,"result":"allow"}')).resolves.toBe("error");
    await expect(run('{"protocolVersion":1,"result":"PASS"}')).resolves.toBe("error");
    await expect(run("not json")).resolves.toBe("error");
    await expect(run('["protocolVersion"]')).resolves.toBe("error");
    await expect(run("")).resolves.toBe("error");
  });

  it("rejects invalid facts shapes", async () => {
    await expect(run('{"protocolVersion":1,"result":"pass","facts":[]}')).resolves.toBe("error");
    await expect(run('{"protocolVersion":1,"result":"pass","facts":"x"}')).resolves.toBe("error");
    await expect(run('{"protocolVersion":1,"result":"pass","facts":null}')).resolves.toBe("error");
  });

  it("counts the facts root as depth 1 with maximum depth 8", async () => {
    const nested = (levels: number): string => {
      let inner = "1";
      for (let i = 0; i < levels; i++) inner = `{"l":${inner}}`;
      return `{"protocolVersion":1,"result":"pass","facts":${inner}}`;
    };
    await expect(run(nested(0))).resolves.toBe("error");
    await expect(run(nested(1))).resolves.toBe("pass");
    await expect(run(nested(FACTS_MAX_DEPTH))).resolves.toBe("pass");
    await expect(run(nested(FACTS_MAX_DEPTH + 1))).resolves.toBe("error");
  });

  it("enforces the 16 KiB UTF-8 serialized facts limit", async () => {
    const sized = (bytes: number): string => {
      const padding = "x".repeat(bytes);
      const facts = `{"p":"${padding}"}`;
      const over = Buffer.byteLength(facts, "utf8") - bytes;
      return `{"protocolVersion":1,"result":"pass","facts":{"p":"${"x".repeat(bytes - over)}"}}`;
    };
    const atLimit = sized(FACTS_LIMIT_BYTES - 20);
    expect(Buffer.byteLength(JSON.parse(atLimit).facts.p.length.toString())).toBeGreaterThan(0);
    await expect(run(atLimit)).resolves.toBe("pass");
    await expect(run(sized(FACTS_LIMIT_BYTES + 500))).resolves.toBe("error");
  });

  it("classifies response bodies at the parsing boundary identically (unit)", () => {
    expect(parseCheckResponse('{"protocolVersion":1,"result":"pass"}')).toBe("pass");
    expect(parseCheckResponse('{"protocolVersion":1,"result":"pass"}\n')).toBe("pass");
    expect(parseCheckResponse('{"protocolVersion":1,"result":"pass"} trailing')).toBe("error");
    expect(parseCheckResponse('{"protocolVersion":1,"result":"fail","facts":{"nested":{"deep":1}}}')).toBe("fail");
  });
});

describe("external check process boundary", () => {
  it("passes argv verbatim without shell interpretation", async () => {
    const out = path.join(path.dirname(recordingChecker), "argv.json");
    const metacharacters = ["a;rm -rf /", "$(whoami)", "`id`", "a && b", 'quote " inside', "$((1+1))"];
    const result = await runExternalCheck(nodeWork(recordingChecker, out, ...metacharacters), context, 5000);
    expect(result).toBe("pass");
    const recorded = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(recorded.argv).toEqual(metacharacters);
  });

  it("runs with an empty environment and no inherited PATH", async () => {
    const out = path.join(path.dirname(recordingChecker), "env.json");
    await runExternalCheck(nodeWork(recordingChecker, out), context, 5000);
    const recorded = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(recorded.envKeys).toEqual([]);
  });

  it("invokes an absolute executable with an absolute interpreter", async () => {
    const result = await runExternalCheck(
      work([process.execPath, "-e", 'process.stdout.write(JSON.stringify({protocolVersion:1,result:"pass"}))']),
      context,
      5000,
    );
    expect(result).toBe("pass");
  });

  it("propagates the invocation cwd as the child process cwd", async () => {
    const out = path.join(path.dirname(recordingChecker), "cwd.json");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "obg-cwd-"));
    tempDirs.push(cwd);
    await runExternalCheck(nodeWork(recordingChecker, out), { ...context, cwd }, 5000);
    expect(JSON.parse(fs.readFileSync(out, "utf8")).cwd).toBe(cwd);
  });

  it("reads to stdin closure before responding", async () => {
    const out = path.join(path.dirname(recordingChecker), "closed.json");
    await runExternalCheck(nodeWork(recordingChecker, out), context, 5000);
    expect(JSON.parse(fs.readFileSync(out, "utf8")).stdinEnded).toBe(true);
  });

  it("breaches the 64 KiB stdout limit and selects onError", async () => {
    const big = "x".repeat(STDOUT_LIMIT_BYTES + 1);
    await expect(runExternalCheck(nodeWork(scriptedChecker, big, "0"), context, 5000)).resolves.toBe("error");
  });

  it("breaches the 8 KiB stderr limit and selects onError", async () => {
    const noisy = writeChecker(`
process.stderr.write("e".repeat(${STDERR_LIMIT_BYTES + 1}));
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => process.stdout.write(JSON.stringify({protocolVersion:1,result:"pass"})));
`);
    await expect(runExternalCheck(nodeWork(noisy), context, 5000)).resolves.toBe("error");
  });

  it("counts stdout bytes as UTF-8, not characters", async () => {
    const multibyte = writeChecker(`
process.stdout.write("\\u00e9".repeat(${STDOUT_LIMIT_BYTES}));
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => process.stdout.write(JSON.stringify({protocolVersion:1,result:"pass"})));
`);
    await expect(runExternalCheck(nodeWork(multibyte), context, 5000)).resolves.toBe("error");
  });

  it("classifies spawn failure of a missing absolute executable as error", async () => {
    await expect(runExternalCheck(work(["/nonexistent/checker-binary"], "tool:0/matcher:1"), context, 5000)).resolves.toBe("error");
  });

  it("classifies nonzero and signal exits as error", async () => {
    await expect(runExternalCheck(nodeWork(scriptedChecker, '{"protocolVersion":1,"result":"pass"}', "3"), context, 5000)).resolves.toBe("error");
    const suicide = writeChecker(`process.kill(process.pid, "SIGKILL");`);
    await expect(runExternalCheck(nodeWork(suicide), context, 5000)).resolves.toBe("error");
  });

  it("never recurses through the Bash guard: the checker may spawn commands freely", async () => {
    const spawner = writeChecker(`
const { execFileSync } = require("child_process");
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  execFileSync("/bin/echo", ["ignored"], { stdio: "ignore" });
  process.stdout.write(JSON.stringify({protocolVersion:1,result:"pass"}));
});
`);
    await expect(runExternalCheck(nodeWork(spawner), context, 5000)).resolves.toBe("pass");
  });
});

describe("external check timing", () => {
  it("terminates a hanging checker at the configured timeout and selects onError", async () => {
    const hanging = writeChecker(`setInterval(() => {}, 50);`);
    const started = Date.now();
    await expect(runExternalCheck(nodeWork(hanging), context, 300)).resolves.toBe("error");
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(2000);
  });

  it("sends SIGKILL only after the 250 ms grace when SIGTERM is ignored", async () => {
    const trapsTerm = writeChecker(`process.on("SIGTERM", () => {}); setInterval(() => {}, 50);`);
    const timeoutMs = 200;
    const started = Date.now();
    await expect(runExternalCheck(nodeWork(trapsTerm), context, timeoutMs)).resolves.toBe("error");
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs + 250);
    expect(elapsed).toBeLessThan(timeoutMs + 250 + 2000);
  });

  it("does not wait the grace period when the child exits on SIGTERM", async () => {
    const diesOnTerm = writeChecker(`setInterval(() => {}, 50);`);
    const timeoutMs = 200;
    const started = Date.now();
    await expect(runExternalCheck(nodeWork(diesOnTerm), context, timeoutMs)).resolves.toBe("error");
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(timeoutMs + 250);
  });

  it("accepts a 30000 ms timeout for a fast checker", async () => {
    const fast = writeChecker(`
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => process.stdout.write(JSON.stringify({protocolVersion:1,result:"pass"})));
`);
    await expect(runExternalCheck(nodeWork(fast), context, 30000)).resolves.toBe("pass");
  });

  it("stops waiting at the first terminal condition: an output breach before a valid response is an error", async () => {
    const breachThenValid = writeChecker(`
process.stdout.write("x".repeat(${STDOUT_LIMIT_BYTES + 10}));
setTimeout(() => {
  process.stdout.write(JSON.stringify({protocolVersion:1,result:"pass"}));
  process.exit(0);
}, 400);
`);
    const started = Date.now();
    await expect(runExternalCheck(nodeWork(breachThenValid), context, 5000)).resolves.toBe("error");
    expect(Date.now() - started).toBeLessThan(400);
  });
});

describe("external check data lifetime", () => {
  it("validates then discards request context, output, and facts without logging or retention", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const chatty = writeChecker(`
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  process.stderr.write("checker-diagnostic " + input);
  process.stdout.write(JSON.stringify({
    protocolVersion: 1,
    result: "pass",
    facts: { secretFacts: "top-secret-branch-name", requestEcho: JSON.parse(input) },
  }));
});
`);
    const secretCwd = fs.mkdtempSync(path.join(os.tmpdir(), "obg-secret-"));
    tempDirs.push(secretCwd);
    const result = await runExternalCheck(nodeWork(chatty), { ...context, cwd: secretCwd }, 5000);

    expect(result).toBe("pass");
    for (const spy of [logSpy, warnSpy, errorSpy]) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(result).not.toHaveProperty("stdout");
    expect(result).not.toHaveProperty("stderr");
    expect(result).not.toHaveProperty("facts");
  });

  it("returns only the classified discriminator on failure paths", async () => {
    const failing = writeChecker(`
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  process.stderr.write("boom");
  process.exit(7);
});
`);
    const result = await runExternalCheck(nodeWork(failing), context, 5000);
    expect(result).toBe("error");
    expect(typeof result).toBe("string");
  });
});
