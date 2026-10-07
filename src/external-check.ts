import { spawn } from "child_process";
import type { SegmentCheckWork } from "./policy.js";
import type { CheckRunContext, CheckRunResult } from "./enforce.js";

/**
 * The only module that creates checker processes.
 *
 * Executes one normalized check as direct argv (no shell, no interpolation)
 * with an empty environment and the guarded invocation's runtime directory as
 * the child cwd. Exchanges the version-1 JSON request/response, applies UTF-8
 * byte limits, terminates at the first terminal condition, and classifies
 * every failure as "error". Request context, output, and facts are validated
 * then discarded: never logged, prompted, persisted, or used as policy input.
 */

export const STDOUT_LIMIT_BYTES = 64 * 1024;
export const STDERR_LIMIT_BYTES = 8 * 1024;
export const FACTS_LIMIT_BYTES = 16 * 1024;
export const FACTS_MAX_DEPTH = 8;
export const KILL_GRACE_MS = 250;

function factsDepth(value: unknown): number {
  if (value === null || typeof value !== "object") return 0;
  let max = 0;
  for (const child of Object.values(value)) {
    const d = factsDepth(child);
    if (d > max) max = d;
  }
  return 1 + max;
}

/**
 * Strict version-1 response contract: a JSON object with exactly
 * `protocolVersion` (1), `result` ("pass" | "fail"), and optional `facts`
 * (object, ≤ 16 KiB UTF-8 serialized, nesting depth ≤ 8 with the root as
 * depth 1). Unknown fields, returned permission actions, unsupported
 * versions, and malformed JSON are errors — the response never carries a
 * permission decision.
 */
export function parseCheckResponse(body: string): CheckRunResult {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return "error";
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "error";
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const hasFacts = keys.includes("facts");
  if (keys.length !== (hasFacts ? 3 : 2)) return "error";
  if (!keys.includes("protocolVersion") || !keys.includes("result")) return "error";
  if (record.protocolVersion !== 1) return "error";
  const result = record.result;
  if (result !== "pass" && result !== "fail") return "error";
  if (hasFacts) {
    const facts = record.facts;
    if (facts === null || typeof facts !== "object" || Array.isArray(facts)) return "error";
    let serialized: string;
    try {
      serialized = JSON.stringify(facts);
    } catch {
      return "error";
    }
    if (serialized === undefined) return "error";
    if (Buffer.byteLength(serialized, "utf8") > FACTS_LIMIT_BYTES) return "error";
    if (factsDepth(facts) > FACTS_MAX_DEPTH) return "error";
  }
  return result;
}

/**
 * Run one selected check and return only the classified discriminator. The
 * first terminal condition — child exit, per-check timeout, stdout/stderr
 * byte breach, or stdin write failure — stops the wait; timeout and breach
 * terminate the child (SIGTERM, then SIGKILL after the grace period if it
 * remains alive). Every failure mode maps to "error".
 */
export async function runExternalCheck(work: SegmentCheckWork, context: CheckRunContext, effectiveTimeoutMs: number): Promise<CheckRunResult> {
  const request = {
    protocolVersion: 1,
    context: { cwd: context.cwd, sessionID: context.sessionID, callID: context.callID },
    command: { raw: work.command.raw, executable: work.command.executable, argv: [...work.command.argv] },
    match: { ruleId: work.ruleId },
  };
  const stdinPayload = JSON.stringify(request) + "\n";

  let child;
  try {
    child = spawn(work.check.command[0], work.check.command.slice(1), {
      shell: false,
      cwd: context.cwd,
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return "error";
  }

  return new Promise<CheckRunResult>((resolve) => {
    const stdin = child.stdin;
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdin || !stdout || !stderr) {
      child.removeAllListeners();
      resolve("error");
      return;
    }
    let settled = false;
    let terminated = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];

    const finish = (result: CheckRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(graceTimer);
      resolve(result);
    };

    let timeout: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const terminate = () => {
      if (terminated) return;
      terminated = true;
      try {
        stdin.destroy();
      } catch {
        // stdin may already be closed; the terminal outcome is unaffected
      }
      try {
        child.kill("SIGTERM");
      } catch {
        // an already-exited child cannot be signaled; exit classification stands
      }
      graceTimer = setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        } catch {
          // the child exited between the check and the signal; nothing to force
        }
      }, KILL_GRACE_MS);
    };

    timeout = setTimeout(() => terminate(), Math.max(1, effectiveTimeoutMs));

    stdout.on("data", (chunk: Buffer) => {
      if (terminated || settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes >= STDOUT_LIMIT_BYTES) {
        terminate();
        return;
      }
      stdoutChunks.push(chunk);
    });

    stderr.on("data", (chunk: Buffer) => {
      if (terminated || settled) return;
      stderrBytes += chunk.length;
      if (stderrBytes >= STDERR_LIMIT_BYTES) terminate();
    });

    stdin.on("error", () => terminate());
    stdin.end(stdinPayload);

    child.on("error", () => {
      terminate();
      finish("error");
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      if (terminated) {
        finish("error");
        return;
      }
      if (signal !== null || code !== 0) {
        finish("error");
        return;
      }
      finish(parseCheckResponse(Buffer.concat(stdoutChunks).toString("utf8")));
    });
  });
}
