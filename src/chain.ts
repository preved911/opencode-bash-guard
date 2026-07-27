import { parse } from "unbash";
import type { Script, Statement, Node, CommandExpansionPart, Command, AndOr, Pipeline } from "unbash";

export interface ChainSegment {
  command: string;
  commandName: string;
}

export interface ChainResult {
  segments: ChainSegment[];
  parseError: boolean;
  errors: string[];
}

function getCommandText(cmd: Command): string {
  const parts: string[] = [];
  if (cmd.name) {
    parts.push(cmd.name.text);
  }
  for (const word of cmd.suffix) {
    parts.push(word.text);
  }
  return parts.join(" ");
}

function getCommandName(cmd: Command): string {
  return cmd.name?.text ?? "";
}

function extractCommandsFromNode(node: Node): Command[] {
  const result: Command[] = [];
  if (node.type === "Command") {
    result.push(node);
  } else if (node.type === "Pipeline") {
    for (const cmd of (node as Pipeline).commands) {
      result.push(...extractCommandsFromNode(cmd));
    }
  } else if (node.type === "AndOr") {
    for (const cmd of (node as AndOr).commands) {
      result.push(...extractCommandsFromNode(cmd));
    }
  } else if (node.type === "BraceGroup" || node.type === "Subshell") {
    const body = (node as any).body;
    if (body && body.commands) {
      for (const stmt of body.commands as Statement[]) {
        result.push(...extractCommandsFromNode(stmt.command));
      }
    }
  }
  return result;
}

function extractCommandsFromScript(script: Script): ChainSegment[] {
  const segments: ChainSegment[] = [];
  for (const stmt of script.commands) {
    const cmds = extractCommandsFromNode(stmt.command);
    for (const cmd of cmds) {
      if (cmd.type === "Command") {
        segments.push({
          command: getCommandText(cmd),
          commandName: getCommandName(cmd),
        });
      }
    }
  }
  return segments;
}

function extractNestedCommands(script: Script): ChainSegment[] {
  const nested: ChainSegment[] = [];
  function walkNode(node: Node): void {
    if (node.type === "Command") {
      for (const word of (node as Command).suffix) {
        if (word.parts) {
          for (const part of word.parts) {
            if (part.type === "CommandExpansion") {
              const ce = part as CommandExpansionPart;
              if (ce.script) {
                const segs = extractCommandsFromScript(ce.script);
                for (const seg of segs) {
                  nested.push(seg);
                }
              }
            }
          }
        }
      }
    } else if (node.type === "Pipeline") {
      for (const cmd of (node as Pipeline).commands) {
        walkNode(cmd);
      }
    } else if (node.type === "AndOr") {
      for (const cmd of (node as AndOr).commands) {
        walkNode(cmd);
      }
    }
  }
  for (const stmt of script.commands) {
    walkNode(stmt.command);
  }
  return nested;
}

function stripOuterQuotes(s: string): string {
  s = s.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseMetaCommandArgs(command: string): string | null {
  const trimmed = command.trim();
  const evalMatch = trimmed.match(/^eval\s+(.+)$/);
  if (evalMatch) return stripOuterQuotes(evalMatch[1]);

  const shellCMatch = trimmed.match(/^(sh|bash|zsh|ksh)\s+-c\s+(["'])((?:(?!\2).)*)\2/);
  if (shellCMatch) return shellCMatch[3];

  return null;
}

export function parseChain(command: string): ChainResult {
  if (!command || command.trim().length === 0) {
    return { segments: [], parseError: false, errors: [] };
  }

  const result = parse(command);
  const errors: string[] = [];
  let parseError = false;

  if (result.errors && result.errors.length > 0) {
    parseError = true;
    for (const err of result.errors) {
      errors.push(err.message);
    }
  }

  const segments = extractCommandsFromScript(result);

  const nestedCmds = extractNestedCommands(result);
  segments.push(...nestedCmds);

  for (const seg of segments) {
    const metaArgs = parseMetaCommandArgs(seg.command);
    if (metaArgs) {
      const metaResult = parse(metaArgs);
      if (metaResult.errors && metaResult.errors.length > 0) {
        parseError = true;
        for (const err of metaResult.errors) {
          errors.push(err.message);
        }
      }
      const metaSegments = extractCommandsFromScript(metaResult);
      for (const ms of metaSegments) {
        segments.push(ms);
      }
    }
  }

  return { segments, parseError, errors };
}
