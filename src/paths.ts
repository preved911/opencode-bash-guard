import path from "path";
import os from "os";
import type { NormalizedInvocation } from "./parser.js";

export interface ExtractedPath {
  original: string;
  resolved: string;
  requiresConfirmation: boolean;
}

/**
 * Resolve candidate path operands from a normalized invocation against the
 * working directory. Candidate extraction is syntactic (done by the parser
 * boundary); this module only resolves them — no shell reparsing.
 */
export function resolveCandidatePaths(invocation: NormalizedInvocation, cwd: string): ExtractedPath[] {
  if (invocation.candidatePathDetails) {
    return invocation.candidatePathDetails.map((candidate) =>
      candidate.value === null
        ? { original: candidate.raw, resolved: candidate.raw, requiresConfirmation: true }
        : classifyPath(candidate.value, cwd),
    );
  }
  return invocation.candidatePaths.map((candidate) => classifyPath(candidate, cwd));
}

export function classifyPath(candidate: string, cwd: string): ExtractedPath {
  return {
    original: candidate,
    resolved: resolvePath(candidate, cwd),
    requiresConfirmation: /^~[^/]/.test(candidate),
  };
}

export function resolvePath(p: string, cwd: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.resolve(os.homedir(), p.slice(2));
  if (/^~[^/]/.test(p)) return p;
  if (path.isAbsolute(p)) {
    return path.resolve(p);
  }
  return path.resolve(cwd, p);
}
