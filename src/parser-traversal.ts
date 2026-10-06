// allow: SIZE_OK — one contiguous unbash 4.0.3 union visitor keeps exhaustive cases, identity deduplication, and all security budgets on the same path.
import { parse } from "unbash";
import type {
  ArithmeticExpression,
  AssignmentPrefix,
  CaseItem,
  Command,
  DoubleQuotedChild,
  Node,
  Redirect,
  Script,
  TestExpression,
  Word,
  WordPart,
} from "unbash";
import { validateArithmeticCommand, validateArithmeticExpansion, validateArithmeticFor } from "./parser-arithmetic.js";
import { buildInvocation, staticWordValue } from "./parser-normalize.js";
import type { NormalizedInvocation } from "./parser-types.js";

const MAX_COMMAND_CONTEXT_DEPTH = 64;
const MAX_INVOCATIONS = 1024;
const MAX_STRUCTURAL_DEPTH = 512;
const MAX_VISITED_VALUES = 8192;
const COMMAND_LIMIT_ERROR = "Shell command traversal exceeds the supported depth or invocation limit";
const STRUCTURAL_LIMIT_ERROR = "Shell AST traversal exceeds the supported structural depth limit";
const VISITED_LIMIT_ERROR = "Shell AST traversal exceeds the supported visited value limit";
const SUPPORTED_PARAMETER_OPERATORS = new Set([
  ":-",
  ":=",
  ":+",
  ":?",
  "-",
  "=",
  "+",
  "?",
  "#",
  "##",
  "%",
  "%%",
  "/",
  "//",
  "/#",
  "/%",
  "^",
  "^^",
  ",",
  ",,",
  "@",
]);
const SHELL_NAMES = new Set(["sh", "bash", "zsh", "ksh", "dash"]);
const SHELL_OPTIONS_WITH_VALUES = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);

type TraversableScript = Script & {
  readonly errors?: readonly { readonly message: string }[];
};

interface TraversalState {
  readonly topLevelInvocations: NormalizedInvocation[];
  readonly nestedInvocations: NormalizedInvocation[];
  readonly errors: string[];
  readonly seen: WeakSet<object>;
  visitedValues: number;
  maxDepth: number;
  stopped: boolean;
}

interface TraversalFrame {
  readonly commandDepth: number;
  readonly structuralDepth: number;
  readonly ownerRedirects: readonly Redirect[];
  readonly source: string | null;
}

export interface TraversalResult {
  readonly invocations: NormalizedInvocation[];
  readonly topLevelInvocations: NormalizedInvocation[];
  readonly errors: string[];
  readonly maxDepth: number;
}

function childFrame(frame: TraversalFrame): TraversalFrame {
  return { ...frame, structuralDepth: frame.structuralDepth + 1 };
}

function nestedScriptFrame(frame: TraversalFrame, source: string | null): TraversalFrame {
  return {
    commandDepth: frame.commandDepth + 1,
    structuralDepth: frame.structuralDepth + 1,
    ownerRedirects: [],
    source,
  };
}

function failBudget(state: TraversalState, message: string): void {
  if (!state.stopped) state.errors.push(message);
  state.stopped = true;
}

function failUnsupported(state: TraversalState, message: string): void {
  state.errors.push(message);
}

function assertNever(_value: never, state: TraversalState, kind: string): void {
  failUnsupported(state, `Unsupported unbash ${kind} variant`);
}

function enter(value: object, frame: TraversalFrame, state: TraversalState): boolean {
  if (state.stopped || state.seen.has(value)) return false;
  if (frame.structuralDepth > MAX_STRUCTURAL_DEPTH) {
    failBudget(state, STRUCTURAL_LIMIT_ERROR);
    return false;
  }
  if (state.visitedValues >= MAX_VISITED_VALUES) {
    failBudget(state, VISITED_LIMIT_ERROR);
    return false;
  }
  state.seen.add(value);
  state.visitedValues++;
  return true;
}

function visitScript(script: TraversableScript, frame: TraversalFrame, state: TraversalState): void {
  if (!enter(script, frame, state)) return;
  state.maxDepth = Math.max(state.maxDepth, frame.commandDepth);
  if (frame.commandDepth > MAX_COMMAND_CONTEXT_DEPTH) {
    failBudget(state, COMMAND_LIMIT_ERROR);
    return;
  }
  for (const error of script.errors ?? []) state.errors.push(error.message);
  for (const statement of script.commands) visitNode(statement, childFrame(frame), state);
}

function visitArithmetic(expression: ArithmeticExpression | undefined, frame: TraversalFrame, state: TraversalState): void {
  if (!expression || !enter(expression, frame, state)) return;
  const child = childFrame(frame);
  switch (expression.type) {
    case "ArithmeticCommandExpansion": {
      if (!expression.script) {
        failUnsupported(state, "Unsupported unresolved arithmetic command expansion");
        break;
      }
      const source = expression.script.pos === 0 ? expression.text.slice(2, -1) : frame.source;
      visitScript(expression.script, nestedScriptFrame(frame, source), state);
      break;
    }
    case "ArithmeticBinary":
      visitArithmetic(expression.left, child, state);
      visitArithmetic(expression.right, child, state);
      break;
    case "ArithmeticUnary":
      visitArithmetic(expression.operand, child, state);
      break;
    case "ArithmeticTernary":
      visitArithmetic(expression.test, child, state);
      visitArithmetic(expression.consequent, child, state);
      visitArithmetic(expression.alternate, child, state);
      break;
    case "ArithmeticGroup":
      visitArithmetic(expression.expression, child, state);
      break;
    case "ArithmeticWord":
      if (
        expression.value.includes("`") ||
        expression.value.includes("[") ||
        expression.value.includes("${") ||
        expression.value.includes("$(")
      ) {
        failUnsupported(state, "Unsupported opaque arithmetic word");
      }
      break;
    default:
      assertNever(expression, state, "arithmetic expression");
  }
}

function expansionSource(part: WordPart | DoubleQuotedChild, frame: TraversalFrame): string | null {
  return part.type === "CommandExpansion" && part.text.startsWith("`") && part.text.includes("\\") ? null : frame.source;
}

function visitWordPart(part: WordPart | DoubleQuotedChild, frame: TraversalFrame, state: TraversalState): void {
  if (!enter(part, frame, state)) return;
  const child = childFrame(frame);
  switch (part.type) {
    case "CommandExpansion":
    case "ProcessSubstitution":
      if (part.script) visitScript(part.script, nestedScriptFrame(frame, expansionSource(part, frame)), state);
      else failUnsupported(state, "Unsupported unresolved command expansion");
      break;
    case "DoubleQuoted":
    case "LocaleString":
      for (const nestedPart of part.parts) visitWordPart(nestedPart, child, state);
      break;
    case "ParameterExpansion":
      if (part.index !== undefined && part.index.length > 0) {
        failUnsupported(state, "Unsupported parameter expansion index");
      }
      if (part.operator !== undefined && !SUPPORTED_PARAMETER_OPERATORS.has(part.operator)) {
        failUnsupported(state, "Unsupported parameter expansion operator");
      }
      if (part.operand) visitWord(part.operand, child, state);
      if (part.slice) {
        visitWord(part.slice.offset, child, state);
        if (part.slice.length) visitWord(part.slice.length, child, state);
      }
      if (part.replace) {
        visitWord(part.replace.pattern, child, state);
        visitWord(part.replace.replacement, child, state);
      }
      break;
    case "ArithmeticExpansion": {
      const error = validateArithmeticExpansion(part.text, part.expression);
      if (error) failUnsupported(state, error);
      visitArithmetic(part.expression, child, state);
      break;
    }
    case "ExtendedGlob":
      failUnsupported(state, "Unsupported opaque extended glob pattern");
      break;
    case "BraceExpansion":
      failUnsupported(state, "Unsupported opaque brace expansion");
      break;
    case "Literal":
    case "SingleQuoted":
    case "AnsiCQuoted":
    case "SimpleExpansion":
      break;
    default:
      assertNever(part, state, "word part");
  }
}

function visitWord(word: Word, frame: TraversalFrame, state: TraversalState): void {
  if (!enter(word, frame, state)) return;
  const child = childFrame(frame);
  for (const part of word.parts ?? []) visitWordPart(part, child, state);
}

function visitRedirect(redirect: Redirect, frame: TraversalFrame, state: TraversalState): void {
  if (!enter(redirect, frame, state)) return;
  const child = childFrame(frame);
  if (redirect.target) {
    visitWord(redirect.target, child, state);
  }
  if (redirect.body) visitWord(redirect.body, child, state);
}

function visitAssignment(assignment: AssignmentPrefix, frame: TraversalFrame, state: TraversalState): void {
  if (!enter(assignment, frame, state)) return;
  if (assignment.index !== undefined && assignment.index.length > 0) {
    failUnsupported(state, "Unsupported assignment index");
  }
  const child = childFrame(frame);
  if (assignment.value) visitWord(assignment.value, child, state);
  for (const word of assignment.array ?? []) visitWord(word, child, state);
}

function visitTestExpression(expression: TestExpression, frame: TraversalFrame, state: TraversalState): void {
  if (!enter(expression, frame, state)) return;
  const child = childFrame(frame);
  switch (expression.type) {
    case "TestUnary":
      visitWord(expression.operand, child, state);
      break;
    case "TestBinary":
      visitWord(expression.left, child, state);
      visitWord(expression.right, child, state);
      break;
    case "TestLogical":
      visitTestExpression(expression.left, child, state);
      visitTestExpression(expression.right, child, state);
      break;
    case "TestNot":
      visitTestExpression(expression.operand, child, state);
      break;
    case "TestGroup":
      visitTestExpression(expression.expression, child, state);
      break;
    default:
      assertNever(expression, state, "test expression");
  }
}

function visitCaseItem(item: CaseItem, frame: TraversalFrame, state: TraversalState): void {
  if (!enter(item, frame, state)) return;
  const child = childFrame(frame);
  for (const pattern of item.pattern) visitWord(pattern, child, state);
  visitNode(item.body, child, state);
}

function appendInvocation(command: Command, frame: TraversalFrame, state: TraversalState): void {
  if (state.topLevelInvocations.length + state.nestedInvocations.length >= MAX_INVOCATIONS) {
    failBudget(state, COMMAND_LIMIT_ERROR);
    return;
  }
  const built = buildInvocation(command, frame.ownerRedirects, frame.source);
  if (frame.commandDepth === 1) state.topLevelInvocations.push(built.invocation);
  else state.nestedInvocations.push(built.invocation);
  state.errors.push(...built.errors);
}

function shellBasename(commandName: string): string {
  const separator = commandName.lastIndexOf("/");
  return separator < 0 ? commandName : commandName.slice(separator + 1);
}

function visitEvalBody(command: Command, frame: TraversalFrame, state: TraversalState): void {
  let start = 0;
  if (command.suffix[0] && staticWordValue(command.suffix[0]) === "--") start = 1;
  if (start >= command.suffix.length) return;

  const bodyWords: string[] = [];
  for (const word of command.suffix.slice(start)) {
    const value = staticWordValue(word);
    if (value === null) {
      failUnsupported(state, "Dynamic eval body is not supported");
      return;
    }
    bodyWords.push(value);
  }
  const body = bodyWords.join(" ");
  visitScript(parse(body), nestedScriptFrame(frame, body), state);
}

function visitShellBody(command: Command, frame: TraversalFrame, state: TraversalState): void {
  for (let index = 0; index < command.suffix.length; index++) {
    const word = command.suffix[index];
    if (!word) return;
    const value = staticWordValue(word);
    if (value === null) {
      failUnsupported(state, "Dynamic shell executable body is not supported");
      return;
    }
    if (value === "--" || value === "-" || (!value.startsWith("-") && !value.startsWith("+"))) return;
    if (/^-[^-]*c/.test(value)) {
      const bodyWord = command.suffix[index + 1];
      if (!bodyWord) {
        failUnsupported(state, "Missing static shell -c body");
        return;
      }
      const body = staticWordValue(bodyWord);
      if (body === null) {
        failUnsupported(state, "Dynamic shell executable body is not supported");
        return;
      }
      visitScript(parse(body), nestedScriptFrame(frame, body), state);
      return;
    }
    if (SHELL_OPTIONS_WITH_VALUES.has(value)) index++;
  }
}

function visitMetaCommand(command: Command, frame: TraversalFrame, state: TraversalState): void {
  if (state.stopped || !command.name) return;
  const commandName = staticWordValue(command.name);
  if (commandName === "eval") {
    visitEvalBody(command, frame, state);
    return;
  }
  if (commandName !== null && SHELL_NAMES.has(shellBasename(commandName))) visitShellBody(command, frame, state);
}

function visitNode(node: Node, frame: TraversalFrame, state: TraversalState): void {
  if (!enter(node, frame, state)) return;
  const child = childFrame(frame);
  switch (node.type) {
    case "Command":
      appendInvocation(node, frame, state);
      if (node.name) visitWord(node.name, child, state);
      for (const assignment of node.prefix) visitAssignment(assignment, child, state);
      for (const word of node.suffix) visitWord(word, child, state);
      for (const redirect of node.redirects) visitRedirect(redirect, child, state);
      visitMetaCommand(node, frame, state);
      break;
    case "Pipeline":
    case "AndOr":
      for (const command of node.commands) visitNode(command, child, state);
      break;
    case "If":
      visitNode(node.clause, child, state);
      visitNode(node.then, child, state);
      if (node.else) visitNode(node.else, child, state);
      break;
    case "For":
      visitWord(node.name, child, state);
      for (const word of node.wordlist) visitWord(word, child, state);
      visitNode(node.body, child, state);
      break;
    case "ArithmeticFor":
      state.errors.push(...validateArithmeticFor(node, frame.source));
      visitArithmetic(node.initialize, child, state);
      visitArithmetic(node.test, child, state);
      visitArithmetic(node.update, child, state);
      visitNode(node.body, child, state);
      break;
    case "Select":
      visitWord(node.name, child, state);
      for (const word of node.wordlist) visitWord(word, child, state);
      visitNode(node.body, child, state);
      break;
    case "While":
      visitNode(node.clause, child, state);
      visitNode(node.body, child, state);
      break;
    case "Function": {
      visitWord(node.name, child, state);
      const bodyFrame: TraversalFrame = {
        ...child,
        ownerRedirects: [...frame.ownerRedirects, ...node.redirects],
      };
      visitNode(node.body, bodyFrame, state);
      for (const redirect of node.redirects) visitRedirect(redirect, child, state);
      break;
    }
    case "Subshell":
    case "BraceGroup":
      visitNode(node.body, child, state);
      break;
    case "CompoundList":
      for (const statement of node.commands) visitNode(statement, child, state);
      break;
    case "Case":
      visitWord(node.word, child, state);
      for (const item of node.items) visitCaseItem(item, child, state);
      break;
    case "Coproc": {
      if (node.name) visitWord(node.name, child, state);
      const bodyFrame: TraversalFrame = {
        ...child,
        ownerRedirects: [...frame.ownerRedirects, ...node.redirects],
      };
      visitNode(node.body, bodyFrame, state);
      for (const redirect of node.redirects) visitRedirect(redirect, child, state);
      break;
    }
    case "TestCommand":
      visitTestExpression(node.expression, child, state);
      break;
    case "ArithmeticCommand": {
      const error = validateArithmeticCommand(node.body, node.pos, node.expression);
      if (error) failUnsupported(state, error);
      visitArithmetic(node.expression, child, state);
      break;
    }
    case "Statement": {
      const commandFrame: TraversalFrame = {
        ...child,
        ownerRedirects: [...frame.ownerRedirects, ...node.redirects],
      };
      visitNode(node.command, commandFrame, state);
      for (const redirect of node.redirects) visitRedirect(redirect, child, state);
      break;
    }
    default:
      assertNever(node, state, "node");
  }
}

export function traverseScript(script: TraversableScript, source: string): TraversalResult {
  const state: TraversalState = {
    topLevelInvocations: [],
    nestedInvocations: [],
    errors: [],
    seen: new WeakSet<object>(),
    visitedValues: 0,
    maxDepth: 0,
    stopped: false,
  };
  const frame: TraversalFrame = {
    commandDepth: 1,
    structuralDepth: 1,
    ownerRedirects: [],
    source,
  };
  visitScript(script, frame, state);
  return {
    invocations: [...state.topLevelInvocations, ...state.nestedInvocations],
    topLevelInvocations: state.topLevelInvocations,
    errors: state.errors,
    maxDepth: state.maxDepth,
  };
}
