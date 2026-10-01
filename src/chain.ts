import { parse } from "unbash";
import type { Script, Statement, Node, CommandExpansionPart, Command, AndOr, Pipeline, Redirect } from "unbash";

export interface RedirectInfo {
  operator: string;
  target: string;
  fileDescriptor: number | undefined;
  wellKnown: boolean;
}

export interface ChainSegment {
  command: string;
  commandName: string;
  redirects: RedirectInfo[];
}

export interface ChainResult {
  segments: ChainSegment[];
  topLevelSegments: ChainSegment[];
  parseError: boolean;
  errors: string[];
  /**
   * Maximum command-context nesting depth: the top-level command body is depth 1;
   * each `$()` / backtick substitution or meta-command (`eval`, `sh -c`, ...) string
   * argument adds one level. 0 when nothing was parsed.
   */
  maxDepth: number;
}

export interface LineSegmentInfo {
  lineNumber: number; // 1-based, matches the "line K" in rejection messages
  segmentCount: number;
}

export interface PerLineResult {
  lines: LineSegmentInfo[];
  /** Most segments; first line wins on ties. Null when the command is empty. */
  worstLine: LineSegmentInfo | null;
}

export interface InlineScriptInfo {
  /** e.g. "python3 -c", "node -e", "python (heredoc)" — printed in rejection messages. */
  interpreter: string;
  statementCount: number;
}

function isWellKnownRedirect(redir: Redirect): boolean {
  const target = redir.target?.text ?? redir.content ?? "";
  if (target === "/dev/null") return true;
  if (/^\d+$/.test(target)) return true;
  if (redir.operator === "<<" || redir.operator === "<<-" || redir.operator === "<<<") return true;
  return false;
}

function redirectToInfo(redir: Redirect): RedirectInfo {
  return {
    operator: redir.operator,
    target: redir.target?.text ?? redir.content ?? "",
    fileDescriptor: redir.fileDescriptor,
    wellKnown: isWellKnownRedirect(redir),
  };
}

function getCommandText(cmd: Command): string {
  const parts: string[] = [];
  if (cmd.name) {
    parts.push(cmd.name.text);
  }
  for (const word of cmd.suffix) {
    parts.push(word.text);
  }
  for (const redir of cmd.redirects) {
    const prefix = redir.fileDescriptor !== undefined ? String(redir.fileDescriptor) : "";
    const op = redir.operator;
    const target = redir.target?.text ?? "";
    parts.push(`${prefix}${op}${target}`);
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

function buildSegment(cmd: Command, stmtRedirects: Redirect[]): ChainSegment {
  const cmdRedirects = (cmd.redirects ?? []).map(redirectToInfo);
  const statementRedirects = (stmtRedirects ?? []).map(redirectToInfo);
  return {
    command: getCommandText(cmd),
    commandName: getCommandName(cmd),
    redirects: [...cmdRedirects, ...statementRedirects],
  };
}

function extractCommandsFromScript(script: Script): ChainSegment[] {
  const segments: ChainSegment[] = [];
  for (const stmt of script.commands) {
    const cmds = extractCommandsFromNode(stmt.command);
    for (const cmd of cmds) {
      if (cmd.type === "Command") {
        segments.push(buildSegment(cmd, stmt.redirects));
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

function computeScriptMaxDepth(script: Script, depth: number): number {
  let max = depth;
  for (const stmt of script.commands) {
    max = Math.max(max, computeNodeMaxDepth(stmt.command, depth));
  }
  return max;
}

function computeNodeMaxDepth(node: Node, depth: number): number {
  let max = depth;
  if (node.type === "Command") {
    const cmd = node as Command;
    for (const word of cmd.suffix) {
      if (!word.parts) continue;
      for (const part of word.parts) {
        if (part.type === "CommandExpansion") {
          const ce = part as CommandExpansionPart;
          if (ce.script) {
            max = Math.max(max, computeScriptMaxDepth(ce.script, depth + 1));
          }
        }
      }
    }
    const metaArgs = parseMetaCommandArgs(getCommandText(cmd));
    if (metaArgs) {
      max = Math.max(max, computeScriptMaxDepth(parse(metaArgs), depth + 1));
    }
  } else if (node.type === "Pipeline" || node.type === "AndOr") {
    const group = node as Pipeline | AndOr;
    for (const cmd of group.commands) {
      max = Math.max(max, computeNodeMaxDepth(cmd, depth));
    }
  } else if (node.type === "BraceGroup" || node.type === "Subshell") {
    const body = (node as { body?: { commands?: Statement[] } }).body;
    if (body?.commands) {
      for (const stmt of body.commands) {
        max = Math.max(max, computeNodeMaxDepth(stmt.command, depth));
      }
    }
  }
  return max;
}

export function parseChainPerLine(command: string): PerLineResult {
  const rawLines = command.split("\n");
  const lines: LineSegmentInfo[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (line.trim().length === 0) continue;
    lines.push({ lineNumber: i + 1, segmentCount: parseChain(line).segments.length });
  }
  let worstLine: LineSegmentInfo | null = null;
  for (const info of lines) {
    if (!worstLine || info.segmentCount > worstLine.segmentCount) {
      worstLine = info;
    }
  }
  return { lines, worstLine };
}

const INLINE_SCRIPT_PATTERNS: { pattern: RegExp; interpreter: string }[] = [
  { pattern: /^(?:python3?|python)\s+-c\s+/, interpreter: "python -c" },
  { pattern: /^perl\s+-e\s+/, interpreter: "perl -e" },
  { pattern: /^node\s+(?:-e|--eval)\s+/, interpreter: "node -e" },
  { pattern: /^ruby\s+-e\s+/, interpreter: "ruby -e" },
  { pattern: /^php\s+-r\s+/, interpreter: "php -r" },
];

function stripQuotedScript(rest: string): string | null {
  const double = rest.match(/^"((?:[^"\\]|\\.)*)"/);
  if (double) return double[1];
  const single = rest.match(/^'([^']*)'/);
  if (single) return single[1];
  return null;
}

export function countScriptStatements(script: string): number {
  return script
    .split(/[;\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0).length;
}

const HEREDOC_INTERPRETERS = new Set(["python", "python3", "perl", "ruby", "php", "node", "sh", "bash", "zsh", "ksh"]);

export function detectInlineScript(segment: ChainSegment): InlineScriptInfo | null {
  for (const { pattern, interpreter } of INLINE_SCRIPT_PATTERNS) {
    const match = segment.command.match(pattern);
    if (match) {
      const rest = segment.command.slice(match[0].length);
      const script = stripQuotedScript(rest) ?? rest.trim();
      if (script.length === 0) return null;
      return { interpreter, statementCount: countScriptStatements(script) };
    }
  }

  if (HEREDOC_INTERPRETERS.has(segment.commandName)) {
    const heredoc = segment.redirects.find((r) => r.operator === "<<" || r.operator === "<<-");
    if (heredoc && heredoc.target.trim().length > 0) {
      return {
        interpreter: `${segment.commandName} (heredoc)`,
        statementCount: countScriptStatements(heredoc.target),
      };
    }
  }

  return null;
}

export function parseChain(command: string): ChainResult {
  if (!command || command.trim().length === 0) {
    return { segments: [], topLevelSegments: [], parseError: false, errors: [], maxDepth: 0 };
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

  const topLevelSegments = extractCommandsFromScript(result);
  const segments = [...topLevelSegments];

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

  const maxDepth = computeScriptMaxDepth(result, 1);

  return { segments, topLevelSegments, parseError, errors, maxDepth };
}
