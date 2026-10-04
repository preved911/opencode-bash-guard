import path from "path";
import os from "os";
import type { NormalizedInvocation } from "./parser.js";

export interface ExtractedPath {
  original: string;
  resolved: string;
}

/**
 * Resolve candidate path operands from a normalized invocation against the
 * working directory. Candidate extraction is syntactic (done by the parser
 * boundary); this module only resolves them — no shell reparsing.
 */
export function resolveCandidatePaths(invocation: NormalizedInvocation, cwd: string): ExtractedPath[] {
  return invocation.candidatePaths.map((p) => ({
    original: p,
    resolved: resolvePath(p, cwd),
  }));
}

export function resolvePath(p: string, cwd: string): string {
  if (p.startsWith("~")) {
    return path.resolve(os.homedir(), p.slice(1));
  }
  if (path.isAbsolute(p)) {
    return path.resolve(p);
  }
  return path.resolve(cwd, p);
}
