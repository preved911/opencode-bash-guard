export interface BashPermissionRule {
  pattern: string;
  action: "ask" | "allow" | "deny";
}

export type ExternalDirectoryAction = "ask" | "allow" | "deny";

export interface ExternalDirectoryRule {
  pattern: string;
  action: ExternalDirectoryAction;
}

export type PermissionAction = "allow" | "ask" | "deny";

export interface ArgMatcher {
  token?: string;
  position?: number | "all";
  pattern?: string;
  action: PermissionAction;
  args?: ArgMatcher[];
}

export interface ToolPermissionEntry {
  tool: string;
  args: ArgMatcher[];
}

export interface PluginConfig {
  bashRules: BashPermissionRule[];
  editRules: BashPermissionRule[];
  externalDirectoryRules: ExternalDirectoryRule[];
  externalDirectoryDefault: ExternalDirectoryAction | null;
  toolPermissions: ToolPermissionEntry[];
  enabled: boolean;
}

// Hardcoded opencode built-in permission defaults. opencode applies these only at
// permission-evaluation time — plugin `config` hooks receive the raw merged user
// config with absent keys missing — so the plugin mirrors them here.
// Upstream: packages/opencode/src/agent/agent.ts defaults ruleset (repo anomalyco/opencode)
// Docs: https://opencode.ai/docs/permissions/
const OPENCODE_DEFAULT_BASH_ACTION: ExternalDirectoryAction = "allow";
const OPENCODE_DEFAULT_EDIT_ACTION: ExternalDirectoryAction = "allow";
const OPENCODE_DEFAULT_EXTERNAL_DIRECTORY_ACTION: ExternalDirectoryAction = "ask";

function isPermissionAction(value: string): value is "ask" | "allow" | "deny" {
  return value === "ask" || value === "allow" || value === "deny";
}

function parsePermissionRules(rules: unknown): BashPermissionRule[] {
  if (typeof rules === "string" && isPermissionAction(rules)) {
    return [{ pattern: "*", action: rules }];
  }
  if (rules && typeof rules === "object") {
    return Object.entries(rules).map(([pattern, action]) => ({
      pattern,
      action: (isPermissionAction(String(action)) ? String(action) : "ask") as "ask" | "allow" | "deny",
    }));
  }
  return [];
}

export function parseConfig(config: Record<string, unknown>): PluginConfig {
  const permission = config.permission as Record<string, unknown> | undefined;

  const bashRules = parsePermissionRules(permission?.bash);
  const editRules = parsePermissionRules(permission?.edit);

  const wildAction = bashRules.find((r) => r.pattern === "*")?.action ?? OPENCODE_DEFAULT_BASH_ACTION;
  const enabled = wildAction !== "allow";

  const externalDirectoryRules: ExternalDirectoryRule[] = [];
  let externalDirectoryDefault: ExternalDirectoryAction | null = null;
  const ed = permission?.external_directory;
  if (ed === undefined) {
    externalDirectoryDefault = OPENCODE_DEFAULT_EXTERNAL_DIRECTORY_ACTION;
  } else if (typeof ed === "string" && isPermissionAction(ed)) {
    externalDirectoryDefault = ed;
  } else if (ed && typeof ed === "object") {
    for (const [pattern, action] of Object.entries(ed)) {
      if (isPermissionAction(String(action))) {
        externalDirectoryRules.push({ pattern, action: String(action) as ExternalDirectoryAction });
      }
    }
  }

  return { bashRules, editRules, externalDirectoryRules, externalDirectoryDefault, toolPermissions: [], enabled };
}

export function matchBashPermission(segment: string, rules: BashPermissionRule[]): "ask" | "allow" | "deny" | null {
  let matched: BashPermissionRule | null = null;
  for (const rule of rules) {
    if (globMatch(segment, rule.pattern)) {
      matched = rule;
    }
  }
  if (matched) {
    return matched.action;
  }
  return null;
}

export function matchExternalDirectory(
  resolvedPath: string,
  rules: ExternalDirectoryRule[],
  defaultAction: ExternalDirectoryAction | null,
  cwd?: string,
): { violated: boolean; action: ExternalDirectoryAction | null } {
  for (const rule of rules) {
    if (matchPathAgainstPattern(resolvedPath, rule.pattern, cwd)) {
      if (rule.action === "allow") {
        return { violated: false, action: null };
      }
      return { violated: true, action: rule.action };
    }
  }
  if (defaultAction) {
    return { violated: true, action: defaultAction };
  }
  return { violated: false, action: null };
}

function matchPathAgainstPattern(filePath: string, pattern: string, cwd?: string): boolean {
  if (pattern === "*") return true;

  if (pattern.startsWith("./") && cwd) {
    const relative = filePath.startsWith(cwd) ? filePath.slice(cwd.length).replace(/^\//, "") : filePath;
    const normalized = pattern.slice(2);
    const regexStr = normalized
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, ".*")
      .replace(/\*/g, "[^/]*");
    const re = new RegExp(`^${regexStr}$`, "s");
    return re.test(relative) || re.test(`${relative}/`);
  }

  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  const re = new RegExp(`^${regexStr}$`, "s");
  return re.test(filePath) || re.test(`${filePath}/`);
}

function globMatch(str: string, pattern: string): boolean {
  let regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (regexStr.endsWith(" .*")) regexStr = regexStr.slice(0, -3) + "( .*)?";
  // "s" = dotAll, so * crosses newlines — mirrors opencode's native matcher (core/util/wildcard.ts), see issue #28
  return new RegExp(`^${regexStr}$`, "s").test(str);
}

function gitignoreMatch(filePath: string, pattern: string): boolean {
  if (pattern === "*") return true;
  let normalized = pattern;
  if (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  const regexStr = normalized
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "___GLOBSTAR___")
    .replace(/\*/g, "[^/]*")
    .replace(/___GLOBSTAR___/g, ".*");
  return new RegExp(`^${regexStr}$`).test(filePath) || new RegExp(`^${regexStr}/`).test(filePath);
}

// --- Flag-level (arg matcher) permission engine ---

/** Glob a single argv token; same wildcard semantics as the path matcher (`*` within a token, `**` across separators). */
export function matchTokenPattern(token: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${regexStr}$`).test(token);
}

function tokenMatchesTarget(token: string, target: string): boolean {
  if (token === target) return true;
  if (!/^-[a-z]$/.test(target)) return false;
  return /^-[a-z]{2,}$/.test(token) && token.includes(target[1]);
}

interface MatcherEvalState {
  consumed: boolean[];
}

function isFlagLike(token: string): boolean {
  return token.startsWith("-");
}

function evalMatcher(
  matcher: ArgMatcher,
  argv: string[],
  state: MatcherEvalState,
  actions: PermissionAction[],
): void {
  if (matcher.token !== undefined) {
    if (matcher.args && !matcher.pattern) {
      // Bare subcommand token with nested rules.
      for (let i = 0; i < argv.length; i++) {
        if (state.consumed[i] || !tokenMatchesTarget(argv[i], matcher.token)) continue;
        actions.push(matcher.action);
        const nestedState: MatcherEvalState = { consumed: [...state.consumed] };
        nestedState.consumed[i] = true;
        for (const nested of matcher.args) {
          evalMatcher(nested, argv, nestedState, actions);
        }
        return;
      }
      return;
    }

    for (let i = 0; i < argv.length; i++) {
      if (state.consumed[i] || !tokenMatchesTarget(argv[i], matcher.token)) continue;
      if (matcher.pattern !== undefined) {
        // Value match: expansion never applies, so the token must equal the target exactly.
        if (argv[i] !== matcher.token) continue;
        const value = argv[i + 1];
        if (value === undefined || state.consumed[i + 1] || !matchTokenPattern(value, matcher.pattern)) continue;
        actions.push(matcher.action);
        state.consumed[i] = true;
        state.consumed[i + 1] = true;
        return;
      }
      actions.push(matcher.action);
      state.consumed[i] = true;
      return;
    }
    return;
  }

  if (matcher.position !== undefined) {
    if (matcher.position === "all") {
      const candidates: string[] = [];
      for (let i = 1; i < argv.length; i++) {
        if (!state.consumed[i] && !isFlagLike(argv[i])) candidates.push(argv[i]);
      }
      if (candidates.length === 0) return;
      const matched = candidates.filter((token) => matchTokenPattern(token, matcher.pattern!));
      if (matcher.action === "allow") {
        if (matched.length === candidates.length) actions.push(matcher.action);
      } else if (matched.length > 0) {
        actions.push(matcher.action);
      }
      return;
    }

    const positionals = argv.slice(1).filter((token) => !isFlagLike(token));
    const token = positionals[matcher.position];
    if (token !== undefined && matchTokenPattern(token, matcher.pattern!)) {
      actions.push(matcher.action);
    }
  }
}

/**
 * Evaluate one tool entry's matchers against argv tokens (after the command name).
 * Returns every contributed action — most-restrictive-wins is applied by the caller.
 */
export function evalToolEntry(argv: string[], entry: ToolPermissionEntry): PermissionAction[] {
  const actions: PermissionAction[] = [];
  const state: MatcherEvalState = { consumed: argv.map(() => false) };
  for (const matcher of entry.args) {
    evalMatcher(matcher, argv, state, actions);
  }
  return actions;
}

export function matchToolActions(argv: string[], entries: ToolPermissionEntry[]): PermissionAction[] {
  const actions: PermissionAction[] = [];
  for (const entry of entries) {
    if (entry.tool !== argv[0]) continue;
    actions.push(...evalToolEntry(argv, entry));
  }
  return actions;
}

export function mostRestrictive(actions: PermissionAction[]): PermissionAction | null {
  if (actions.includes("deny")) return "deny";
  if (actions.includes("ask")) return "ask";
  if (actions.includes("allow")) return "allow";
  return null;
}

/**
 * Match a segment's argv tokens against tool permission entries.
 * Returns the args-level action (most restrictive of all contributed actions), or null when nothing matched.
 */
export function matchToolPermissions(argv: string[], entries: ToolPermissionEntry[]): PermissionAction | null {
  return mostRestrictive(matchToolActions(argv, entries));
}

export function validateToolPermissions(raw: unknown, warn: (message: string) => void = (m) => console.warn(m)): ToolPermissionEntry[] {
  const entries: ToolPermissionEntry[] = [];
  if (!Array.isArray(raw)) return entries;

  const isValidAction = (value: unknown): value is PermissionAction => value === "allow" || value === "ask" || value === "deny";

  const isValidMatcher = (matcher: ArgMatcher): boolean => {
    const hasToken = typeof matcher.token === "string" && matcher.token.length > 0;
    const hasPosition = matcher.position === "all" || (typeof matcher.position === "number" && Number.isInteger(matcher.position) && matcher.position >= 0);
    if (hasToken === hasPosition) return false;
    if (!isValidAction(matcher.action)) return false;
    if (hasPosition && typeof matcher.pattern !== "string") return false;
    if (typeof matcher.pattern !== "undefined" && typeof matcher.pattern !== "string") return false;
    if (hasToken && typeof matcher.pattern === "string" && matcher.args) return false;
    if (matcher.args) {
      if (!Array.isArray(matcher.args)) return false;
      return matcher.args.every(isValidMatcher);
    }
    return true;
  };

  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      warn(`[opencode-bash-guard] Dropping invalid permissions entry (not an object): ${JSON.stringify(item)}`);
      continue;
    }
    const entry = item as { tool?: unknown; args?: unknown };
    const describe = JSON.stringify(item) ?? String(item);
    if (typeof entry.tool !== "string" || entry.tool.length === 0 || !Array.isArray(entry.args)) {
      warn(`[opencode-bash-guard] Dropping invalid permissions entry (missing tool or args): ${describe}`);
      continue;
    }
    const matchers: ArgMatcher[] = [];
    let valid = true;
    for (const matcher of entry.args as ArgMatcher[]) {
      if (!matcher || typeof matcher !== "object" || !isValidMatcher(matcher)) {
        warn(`[opencode-bash-guard] Dropping invalid arg matcher for tool "${entry.tool}": ${JSON.stringify(matcher)}`);
        valid = false;
        continue;
      }
      matchers.push(matcher);
    }
    if (!valid) continue;
    entries.push({ tool: entry.tool, args: matchers });
  }
  return entries;
}
