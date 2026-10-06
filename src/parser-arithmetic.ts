import type { ArithmeticExpression, ArithmeticFor } from "unbash";

interface SourceSpan {
  readonly start: number;
  readonly end: number;
}

interface ArithmeticForSpans {
  readonly initialize: SourceSpan;
  readonly test: SourceSpan;
  readonly update: SourceSpan;
}

interface ArithmeticFieldValidation {
  readonly name: string;
  readonly expression: ArithmeticExpression | undefined;
  readonly span: SourceSpan;
  readonly source: string;
}

function quoteEnd(source: string, start: number, limit: number): number | null {
  const quote = source[start];
  if (quote === undefined) return null;
  for (let index = start + 1; index < limit; index++) {
    if (quote !== "'" && source[index] === "\\") {
      index++;
      continue;
    }
    if (source[index] === quote) return index;
  }
  return null;
}

function locateArithmeticForSpans(node: ArithmeticFor, source: string): ArithmeticForSpans | null {
  const opening = source.indexOf("((", node.pos);
  if (opening < node.pos || opening >= node.end) return null;

  let firstSeparator: number | undefined;
  let secondSeparator: number | undefined;
  let closing: number | undefined;
  let parentheses = 0;
  let braces = 0;
  const limit = Math.min(node.end, source.length);
  for (let index = opening + 2; index < limit; index++) {
    const character = source[index];
    if (character === undefined) return null;
    if (character === "\\") {
      index++;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      const end = quoteEnd(source, index, limit);
      if (end === null) return null;
      index = end;
      continue;
    }
    if (character === "{") {
      braces++;
      continue;
    }
    if (character === "}" && braces > 0) {
      braces--;
      continue;
    }
    if (braces > 0) continue;
    if (character === "(") {
      parentheses++;
      continue;
    }
    if (character === ")") {
      if (parentheses > 0) {
        parentheses--;
        continue;
      }
      if (source[index + 1] === ")") {
        closing = index;
        break;
      }
      return null;
    }
    if (character === ";" && parentheses === 0) {
      if (firstSeparator === undefined) firstSeparator = index;
      else if (secondSeparator === undefined) secondSeparator = index;
      else return null;
    }
  }

  if (firstSeparator === undefined || secondSeparator === undefined || closing === undefined) return null;
  return {
    initialize: { start: opening + 2, end: firstSeparator },
    test: { start: firstSeparator + 1, end: secondSeparator },
    update: { start: secondSeparator + 1, end: closing },
  };
}

function trimSpan(source: string, span: SourceSpan): SourceSpan {
  let start = span.start;
  let end = span.end;
  while (start < end && /\s/.test(source[start] ?? "")) start++;
  while (end > start && /\s/.test(source[end - 1] ?? "")) end--;
  return { start, end };
}

function validateField({ name, expression, span, source }: ArithmeticFieldValidation): string | null {
  const expected = trimSpan(source, span);
  if (!expression) {
    return expected.start === expected.end ? null : `Unsupported partially parsed arithmetic for ${name} field`;
  }
  return expression.pos === expected.start && expression.end === expected.end
    ? null
    : `Unsupported partially parsed arithmetic for ${name} field`;
}

export function validateArithmeticFor(node: ArithmeticFor, source: string | null): readonly string[] {
  if (source === null) return ["Unsupported ambiguous arithmetic for fields"];
  const spans = locateArithmeticForSpans(node, source);
  if (spans === null) return ["Unsupported ambiguous arithmetic for fields"];
  const errors = [
    validateField({ name: "initialize", expression: node.initialize, span: spans.initialize, source }),
    validateField({ name: "test", expression: node.test, span: spans.test, source }),
    validateField({ name: "update", expression: node.update, span: spans.update, source }),
  ];
  return errors.filter((error): error is string => error !== null);
}

export function validateArithmeticCommand(
  body: string,
  nodePosition: number,
  expression: ArithmeticExpression | undefined,
): string | null {
  if (!expression) return body.trim().length === 0 ? null : "Unsupported arithmetic command body";
  const expressionStart = expression.pos - nodePosition - 2;
  const expressionEnd = expression.end - nodePosition - 2;
  return expressionStart >= 0 &&
    expressionEnd >= expressionStart &&
    expressionEnd <= body.length &&
    body.slice(0, expressionStart).trim().length === 0 &&
    body.slice(expressionEnd).trim().length === 0
    ? null
    : "Unsupported partially parsed arithmetic command body";
}

export function validateArithmeticExpansion(text: string, expression: ArithmeticExpression | undefined): string | null {
  if (!expression) return "Unsupported unresolved arithmetic expansion";
  const body = text.slice(3, -2).trim();
  return expression.end - expression.pos === body.length ? null : "Unsupported partially parsed arithmetic expansion";
}
