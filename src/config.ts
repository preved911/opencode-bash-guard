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
  token?: string | string[];
  position?: number | "all";
  pattern?: string;
  action: PermissionAction;
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

function isFlagLike(token: string): boolean {
  return token.startsWith("-");
}

/** Token path of a matcher: an array token as-is, a string token as a one-element path. */
function tokenPath(matcher: ArgMatcher): string[] {
  return Array.isArray(matcher.token) ? matcher.token : [matcher.token as string];
}

/**
 * A refines B when A describes a strictly narrower command set:
 * - B's token path is a proper element-prefix of A's path (both plain paths), or
 * - same single-string token and A adds a `pattern` where B has none.
 * Position matchers never refine and are never refined.
 */
function refines(a: ArgMatcher, b: ArgMatcher): boolean {
  if (a.token === undefined || b.token === undefined) return false;
  const aPath = tokenPath(a);
  const bPath = tokenPath(b);
  if (b.pattern === undefined && bPath.length < aPath.length && bPath.every((element, i) => element === aPath[i])) {
    return true;
  }
  if (!Array.isArray(a.token) && !Array.isArray(b.token) && a.token === b.token) {
    return a.pattern !== undefined && b.pattern === undefined;
  }
  return false;
}

/** Evaluate one matcher independently against the full argv. Matched tokens consume within this evaluation only. */
function evalMatcher(matcher: ArgMatcher, argv: string[]): boolean {
  if (matcher.token !== undefined) {
    if (Array.isArray(matcher.token)) {
      // Command path: elements consume distinct unconsumed tokens in array order,
      // each anywhere among the remaining tokens — command order is irrelevant.
      const consumed = new Set<number>();
      for (const element of matcher.token) {
        let found = -1;
        for (let i = 0; i < argv.length; i++) {
          if (!consumed.has(i) && argv[i] === element) {
            found = i;
            break;
          }
        }
        if (found === -1) return false;
        consumed.add(found);
      }
      return true;
    }

    for (let i = 0; i < argv.length; i++) {
      if (!tokenMatchesTarget(argv[i], matcher.token)) continue;
      if (matcher.pattern !== undefined) {
        // Value match: expansion never applies, so the token must equal the target exactly.
        if (argv[i] !== matcher.token) continue;
        const value = argv[i + 1];
        if (value === undefined || !matchTokenPattern(value, matcher.pattern)) continue;
        return true;
      }
      return true;
    }
    return false;
  }

  if (matcher.position !== undefined) {
    if (matcher.position === "all") {
      const candidates = argv.slice(1).filter((token) => !isFlagLike(token));
      if (candidates.length === 0) return false;
      const matched = candidates.filter((token) => matchTokenPattern(token, matcher.pattern!));
      if (matcher.action === "allow") {
        return matched.length === candidates.length;
      }
      return matched.length > 0;
    }

    const positionals = argv.slice(1).filter((token) => !isFlagLike(token));
    const token = positionals[matcher.position];
    return token !== undefined && matchTokenPattern(token, matcher.pattern!);
  }

  return false;
}

/**
 * Match a segment's argv tokens against tool permission entries.
 * Matching matchers refined by another matching matcher are discarded (refinement
 * picks the most precise description); the survivors reduce most-restrictive-wins
 * downstream. Refinement pools across every entry matching the tool.
 */
export function matchToolActions(argv: string[], entries: ToolPermissionEntry[]): PermissionAction[] {
  const matching: ArgMatcher[] = [];
  for (const entry of entries) {
    if (entry.tool !== argv[0]) continue;
    for (const matcher of entry.args) {
      if (evalMatcher(matcher, argv)) matching.push(matcher);
    }
  }
  return matching.filter((matcher) => !matching.some((other) => other !== matcher && refines(other, matcher))).map((matcher) => matcher.action);
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

  const isValidToken = (value: unknown): value is string | string[] => {
    if (typeof value === "string") return value.length > 0;
    return Array.isArray(value) && value.length > 0 && value.every((element) => typeof element === "string" && element.length > 0);
  };

  // Accepts the raw config shape (`action` optional) and returns the normalized matcher.
  const normalizeMatcher = (input: unknown): ArgMatcher | null => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const matcher = input as { token?: unknown; position?: unknown; pattern?: unknown; action?: unknown; args?: unknown };
    const hasToken = isValidToken(matcher.token);
    const hasPosition = matcher.position === "all" || (typeof matcher.position === "number" && Number.isInteger(matcher.position) && matcher.position >= 0);
    if (hasToken === hasPosition) return null;
    if (matcher.args !== undefined) return null; // legacy nested trees — removed, flatten to path arrays
    const tokenIsArray = Array.isArray(matcher.token);
    if (hasPosition && typeof matcher.pattern !== "string") return null;
    if (typeof matcher.pattern !== "undefined" && (typeof matcher.pattern !== "string" || tokenIsArray)) return null;
    if (matcher.action === undefined) {
      return { token: matcher.token as string | string[] | undefined, position: matcher.position as number | "all" | undefined, pattern: matcher.pattern as string | undefined, action: "ask" };
    }
    if (!isValidAction(matcher.action)) return null;
    return matcher as ArgMatcher;
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
    for (const matcher of entry.args as unknown[]) {
      const normalized = normalizeMatcher(matcher);
      if (normalized === null) {
        warn(`[opencode-bash-guard] Dropping invalid arg matcher for tool "${entry.tool}": ${JSON.stringify(matcher)}`);
        valid = false;
        continue;
      }
      matchers.push(normalized);
    }
    if (!valid) continue;
    entries.push({ tool: entry.tool, args: matchers });
  }
  return entries;
}
