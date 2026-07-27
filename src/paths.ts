import { parse } from "unbash";
import type { Script, Command } from "unbash";
import path from "path";
import os from "os";

export interface ExtractedPath {
  original: string;
  resolved: string;
}

function getWordsFromCommand(cmd: Command): string[] {
  const words: string[] = [];
  for (const word of cmd.suffix) {
    words.push(word.text);
  }
  return words;
}

function extractWordTokens(command: string): string[] {
  const result = parse(command);
  if (result.errors && result.errors.length > 0) {
    return [];
  }
  const words: string[] = [];
  function walkCommands(node: any): void {
    if (node.type === "Command") {
      words.push(...getWordsFromCommand(node as Command));
    } else if (node.type === "Pipeline") {
      for (const c of node.commands) walkCommands(c);
    } else if (node.type === "AndOr") {
      for (const c of node.commands) walkCommands(c);
    }
  }
  for (const stmt of result.commands) {
    walkCommands(stmt.command);
  }
  return words;
}

export function extractPotentialPaths(segmentCommand: string): string[] {
  const words = extractWordTokens(segmentCommand);
  return words.filter((w) => !w.startsWith("-"));
}

function isFlagByFigSpec(commandName: string, token: string): boolean {
  if (token.startsWith("-")) return true;
  return false;
}

export function extractPaths(segmentCommand: string, cwd: string): ExtractedPath[] {
  const commandName = segmentCommand.split(/\s+/)[0] || "";
  const words = extractWordTokens(segmentCommand);
  const potential: string[] = [];

  for (const w of words) {
    if (!isFlagByFigSpec(commandName, w)) {
      potential.push(w);
    }
  }

  return potential.map((p) => ({
    original: p,
    resolved: resolvePath(p, cwd),
  }));
}

function resolvePath(p: string, cwd: string): string {
  if (p.startsWith("~")) {
    return path.resolve(os.homedir(), p.slice(1));
  }
  if (path.isAbsolute(p)) {
    return path.resolve(p);
  }
  return path.resolve(cwd, p);
}
