import { parse } from "unbash";
import { traverseScript } from "./parser-traversal.js";
import type {
  InlineScriptInfo,
  LineSegmentInfo,
  NormalizedInvocation,
  ParsedCommand,
  PerLineResult,
} from "./parser-types.js";

export { extractArgv, stripQuotePairs } from "./parser-normalize.js";
export type {
  InlineScriptInfo,
  LineSegmentInfo,
  NormalizedInvocation,
  NormalizedWordValue,
  ParsedCommand,
  PerLineResult,
  RedirectInfo,
} from "./parser-types.js";

export function parseCommandPerLine(command: string): PerLineResult {
  const rawLines = command.split("\n");
  const lines: LineSegmentInfo[] = [];
  for (const [index, line] of rawLines.entries()) {
    if (line.trim().length === 0) continue;
    lines.push({ lineNumber: index + 1, segmentCount: parseCommand(line).invocations.length });
  }
  let worstLine: LineSegmentInfo | null = null;
  for (const info of lines) {
    if (!worstLine || info.segmentCount > worstLine.segmentCount) worstLine = info;
  }
  return { lines, worstLine };
}

const INLINE_SCRIPT_PATTERNS: readonly { readonly pattern: RegExp; readonly interpreter: string }[] = [
  { pattern: /^(?:python3?|python)\s+-c\s+/, interpreter: "python -c" },
  { pattern: /^perl\s+-e\s+/, interpreter: "perl -e" },
  { pattern: /^node\s+(?:-e|--eval)\s+/, interpreter: "node -e" },
  { pattern: /^ruby\s+-e\s+/, interpreter: "ruby -e" },
  { pattern: /^php\s+-r\s+/, interpreter: "php -r" },
];

function stripQuotedScript(rest: string): string | null {
  const double = rest.match(/^"((?:[^"\\]|\\.)*)"/);
  if (double) return double[1] ?? null;
  const single = rest.match(/^'([^']*)'/);
  if (single) return single[1] ?? null;
  return null;
}

export function countScriptStatements(script: string): number {
  return script
    .split(/[;\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0).length;
}

const HEREDOC_INTERPRETERS = new Set(["python", "python3", "perl", "ruby", "php", "node", "sh", "bash", "zsh", "ksh"]);

export function detectInlineScript(invocation: NormalizedInvocation): InlineScriptInfo | null {
  for (const { pattern, interpreter } of INLINE_SCRIPT_PATTERNS) {
    const match = invocation.command.match(pattern);
    if (match) {
      const rest = invocation.command.slice(match[0].length);
      const script = stripQuotedScript(rest) ?? rest.trim();
      if (script.length === 0) return null;
      return { interpreter, statementCount: countScriptStatements(script) };
    }
  }

  if (HEREDOC_INTERPRETERS.has(invocation.commandName)) {
    const heredoc = invocation.redirects.find((redirect) => redirect.operator === "<<" || redirect.operator === "<<-");
    const body = heredoc?.heredocBody ?? heredoc?.target;
    if (body && body.trim().length > 0) {
      return {
        interpreter: `${invocation.commandName} (heredoc)`,
        statementCount: countScriptStatements(body),
      };
    }
  }

  return null;
}

export function parseCommand(command: string): ParsedCommand {
  if (!command || command.trim().length === 0) {
    return { invocations: [], topLevelInvocations: [], parseError: false, errors: [], maxDepth: 0 };
  }

  const traversal = traverseScript(parse(command), command);
  return {
    invocations: traversal.invocations,
    topLevelInvocations: traversal.topLevelInvocations,
    parseError: traversal.errors.length > 0,
    errors: traversal.errors,
    maxDepth: traversal.maxDepth,
  };
}
