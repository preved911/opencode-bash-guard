import type { Command, DoubleQuotedChild, Redirect, Word, WordPart } from "unbash";
import type { NormalizedInvocation, NormalizedWordValue, RedirectInfo } from "./parser-types.js";

export interface InvocationBuildResult {
  readonly invocation: NormalizedInvocation;
  readonly errors: readonly string[];
}

function assertNeverStatic(_value: never): null {
  return null;
}

function staticValueFromParts(parts: readonly (WordPart | DoubleQuotedChild)[]): string | null {
  let value = "";
  for (const part of parts) {
    switch (part.type) {
      case "Literal":
      case "SingleQuoted":
      case "AnsiCQuoted":
        value += part.value;
        break;
      case "DoubleQuoted": {
        const nestedValue = staticValueFromParts(part.parts);
        if (nestedValue === null) return null;
        value += nestedValue;
        break;
      }
      case "LocaleString":
      case "SimpleExpansion":
      case "ParameterExpansion":
      case "CommandExpansion":
      case "ArithmeticExpansion":
      case "ProcessSubstitution":
      case "ExtendedGlob":
      case "BraceExpansion":
        return null;
      default:
        return assertNeverStatic(part);
    }
  }
  return value;
}

export function staticWordValue(word: Word): string | null {
  return word.parts ? staticValueFromParts(word.parts) : word.value;
}

export function stripQuotePairs(word: string): string {
  let value = word;
  let changed = true;
  while (changed && value.length >= 2) {
    changed = false;
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      value = value.slice(1, -1);
      changed = true;
    } else if (value.includes('""')) {
      value = value.replace('""', "");
      changed = true;
    }
  }
  return value;
}

export function extractArgv(command: Command): string[] {
  const parts: string[] = [];
  if (command.name?.text) parts.push(staticWordValue(command.name) ?? stripQuotePairs(command.name.text));
  for (const word of command.suffix) parts.push(staticWordValue(word) ?? stripQuotePairs(word.text));
  return parts;
}

function getCommandText(command: Command): string {
  const parts: string[] = [];
  if (command.name) parts.push(command.name.text);
  for (const word of command.suffix) parts.push(word.text);
  for (const redirect of command.redirects) {
    const prefix = redirect.fileDescriptor !== undefined ? String(redirect.fileDescriptor) : "";
    parts.push(`${prefix}${redirect.operator}${redirect.target?.text ?? ""}`);
  }
  return parts.join(" ");
}

function normalizeRedirect(redirect: Redirect, source: string | null): RedirectInfo {
  const heredoc = redirect.operator === "<<" || redirect.operator === "<<-";
  // unbash gives heredoc delimiters a degenerate source range (pos === end), so the
  // raw spelling is recovered from the redirect header "[fd] operator whitespace word".
  const rawTarget = heredoc
    ? source === null
      ? (redirect.target?.text ?? "")
      : source.slice(redirect.pos, redirect.end).replace(/^\d*<{1,2}-?/, "").trim()
    : redirect.target
      ? (source?.slice(redirect.target.pos, redirect.target.end) ?? redirect.target.text)
      : (redirect.content ?? "");
  const targetValue = redirect.target ? (heredoc ? redirect.target.value : staticWordValue(redirect.target)) : rawTarget;
  const target = targetValue ?? rawTarget;
  const descriptorTarget = redirect.operator === "<&" || redirect.operator === ">&";
  const wellKnown =
    heredoc ||
    redirect.operator === "<<<" ||
    targetValue === "/dev/null" ||
    (descriptorTarget && targetValue !== null && (targetValue === "-" || /^\d+$/.test(targetValue)));
  return {
    operator: redirect.operator,
    target,
    fileDescriptor: redirect.fileDescriptor,
    wellKnown,
    rawTarget,
    targetValue,
    heredocBody: heredoc ? redirect.content ?? "" : null,
  };
}

function normalizeCandidate(word: Word): NormalizedWordValue {
  return { raw: word.text, value: staticWordValue(word) };
}

export function buildInvocation(command: Command, ownerRedirects: readonly Redirect[], source: string | null): InvocationBuildResult {
  const errors: string[] = [];
  const candidatePaths: string[] = [];
  const candidatePathDetails: NormalizedWordValue[] = [];
  for (const word of command.suffix) {
    if (word.text.startsWith("-")) continue;
    const candidate = normalizeCandidate(word);
    if (candidate.value === null) {
      candidatePathDetails.push(candidate);
      continue;
    }
    if (candidate.value.startsWith("-")) continue;
    candidatePathDetails.push(candidate);
    candidatePaths.push(candidate.value);
  }

  return {
    invocation: {
      command: getCommandText(command),
      commandName: command.name ? staticWordValue(command.name) ?? stripQuotePairs(command.name.text) : "",
      argv: extractArgv(command),
      redirects: [
        ...command.redirects.map((redirect) => normalizeRedirect(redirect, source)),
        ...ownerRedirects.map((redirect) => normalizeRedirect(redirect, source)),
      ],
      candidatePaths,
      candidatePathDetails,
    },
    errors,
  };
}
