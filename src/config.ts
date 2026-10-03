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
  operand?: "all";
  pattern?: string;
  /** Path-scoped value predicates (array-token matchers only): base flag → value glob. */
  flagValues?: Record<string, string>;
  action: PermissionAction;
}

export interface ToolPermissionEntry {
  tool: string;
  args: ArgMatcher[];
  /** Declarative flag arity for this tool entry: `0` value-less, `1` takes one value. */
  flags?: Record<string, 0 | 1>;
}

export interface PluginConfig {
  bashRules: BashPermissionRule[];
  editRules: BashPermissionRule[];
  externalDirectoryRules: ExternalDirectoryRule[];
  externalDirectoryDefault: ExternalDirectoryAction | null;
  toolPermissions: ToolPermissionEntry[];
  /** Executables whose args policy is suspended into scoped ask (invalid/unmigrated config). */
  forcedAskTools?: string[];
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

  return { bashRules, editRules, externalDirectoryRules, externalDirectoryDefault, toolPermissions: [], forcedAskTools: [], enabled };
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

/**
 * Glob a single argv token: `*` within a token, `**` across separators.
 * `**` is swapped to a placeholder first so the single-`*` replacement
 * cannot corrupt the already-inserted `.*` segments.
 */
export function matchTokenPattern(token: string, pattern: string): boolean {
  const GLOBSTAR = "\u0000";
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, GLOBSTAR)
    .replace(/\*/g, "[^/]*")
    .split(GLOBSTAR)
    .join(".*");
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

/** Base-flag identity: starts with `-`, is neither `-` nor `--`, and contains neither whitespace nor `=`. */
function isBaseFlagIdentity(token: string): boolean {
  return token.startsWith("-") && token !== "-" && token !== "--" && !/[\s=]/.test(token);
}

const warnedKeys = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn(message);
}

interface FlagOccurrence {
  /** Base flag identity: the token without any `=value` part. */
  base: string;
  /** Present for declared value-taking flags (adjacent value) and `=`-form flags (inline value). */
  value?: string;
}

interface SegmentViews {
  /** Pre-separator operands minus declared flag values — anchored prefix view for path matchers. */
  commandSequence: string[];
  /** Command sequence plus post-separator operands — indexed by `position` matchers. */
  positionalList: string[];
  /** Every non-flag data token: command operands, declared flag values, inline value atoms, post-separator operands. */
  safetyOperandList: string[];
  flagOccurrences: FlagOccurrence[];
  /** True when classification is ambiguous or contradicts declarations — the segment resolves to `ask`. */
  segmentAsk: boolean;
}

/**
 * Structural classification of a segment (shared by all matchers of the tool).
 * Never decides trailing arguments — those are the per-matcher remainder of the
 * positional list after the matched path levels.
 */
export function classifySegment(argv: string[], arity: Record<string, 0 | 1>): SegmentViews {
  const commandSequence: string[] = [];
  const postSeparator: string[] = [];
  const positionalList: string[] = [];
  const safetyOperandList: string[] = [];
  const flagOccurrences: FlagOccurrence[] = [];
  let segmentAsk = false;
  let separator = false;

  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (!separator && token === "--") {
      separator = true;
      continue;
    }
    if (!separator && isFlagLike(token)) {
      if (token === "-") {
        // Lone dash: ordinary operand.
        safetyOperandList.push(token);
        positionalList.push(token);
        continue;
      }
      const eq = token.indexOf("=", 1);
      if (eq > 1) {
        // Normalized equals form: base-flag atom + inline value atom.
        const base = token.slice(0, eq);
        const value = token.slice(eq + 1);
        flagOccurrences.push({ base, value });
        safetyOperandList.push(value);
        if (arity[base] === 0) segmentAsk = true;
        continue;
      }
      const declared = arity[token];
      if (declared === 1) {
        // Explicit arity declaration is authoritative: consume unconditionally,
        // even when the value starts with `-` (negative numbers, options-as-values).
        const next = argv[i + 1];
        if (next !== undefined && next !== "--") {
          flagOccurrences.push({ base: token, value: next });
          safetyOperandList.push(next);
          i++;
          continue;
        }
        flagOccurrences.push({ base: token });
        continue;
      }
      if (declared === 0) {
        flagOccurrences.push({ base: token });
        continue;
      }
      // Undeclared flag: any successor other than `--` is a probable missing arity —
      // the classification ambiguity resolves to human review. A clustered short bundle
      // whose every one-letter member is declared value-less is safely expanded instead;
      // a bundle that may contain an undeclared or value-taking member also asks.
      if (/^-[a-z]{2,}$/.test(token)) {
        const members = token
          .slice(1)
          .split("")
          .map((ch) => `-${ch}`);
        if (members.every((m) => arity[m] === 0)) {
          for (const m of members) flagOccurrences.push({ base: m });
          continue;
        }
        segmentAsk = true;
        flagOccurrences.push({ base: token });
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && next !== "--") segmentAsk = true;
      flagOccurrences.push({ base: token });
      continue;
    }
    safetyOperandList.push(token);
    if (separator) postSeparator.push(token);
    else commandSequence.push(token);
    positionalList.push(token);
  }

  return {
    commandSequence,
    positionalList,
    safetyOperandList,
    flagOccurrences,
    segmentAsk,
  };
}

interface FlagPredicate {
  base: string;
  valueGlob?: string;
}

function parsePathElements(elements: string[]): { levels: string[]; predicates: FlagPredicate[] } {
  const levels: string[] = [];
  const predicates: FlagPredicate[] = [];
  for (const element of elements) {
    if (isFlagLike(element)) {
      // `=`-form dash elements are value-conditioned predicates (base flag + value glob).
      const eq = element.indexOf("=", 1);
      if (eq > 1) predicates.push({ base: element.slice(0, eq), valueGlob: element.slice(eq + 1) });
      else predicates.push({ base: element });
    } else {
      levels.push(element);
    }
  }
  return { levels, predicates };
}

function evalMatcher(matcher: ArgMatcher, views: SegmentViews): boolean {
  if (matcher.token !== undefined) {
    if (Array.isArray(matcher.token)) {
      const { levels, predicates } = parsePathElements(matcher.token);
      console.log('[DBG path]', JSON.stringify(matcher.token), 'levels:', JSON.stringify(levels), 'preds:', JSON.stringify(predicates), 'cmdSeq:', JSON.stringify(views.commandSequence), 'flags:', JSON.stringify(views.flagOccurrences));
      // Path levels are an anchored, contiguous prefix of the command sequence
      // (pre-separator operands minus declared flag values); post-separator
      // operands can never complete a path.
      if (levels.length > views.commandSequence.length) return false;
      for (let i = 0; i < levels.length; i++) {
        if (views.commandSequence[i] !== levels[i]) return false;
      }
      // Flag predicates are position-free presence checks on base flags
      // (bare, cluster-expanded, or the flag part of an `=`-form token);
      // one matcher never consumes or hides atoms from another.
      for (const p of predicates) {
        if (!views.flagOccurrences.some((occ) => tokenMatchesTarget(occ.base, p.base))) return false;
      }
      // Path-scoped value predicates (`flagValues`): position-independent value checks —
      // each base flag must occur with a value glob-matching the configured glob
      // (`allow` requires every occurrence; `ask`/`deny` require at least one).
      for (const [base, glob] of Object.entries(matcher.flagValues ?? {})) {
        const occurrences = views.flagOccurrences.filter((occ) => occ.base === base);
        const withMatchingValue = occurrences.filter((occ) => occ.value !== undefined && matchTokenPattern(occ.value, glob));
        if (matcher.action === "allow") {
          if (occurrences.length === 0 || withMatchingValue.length !== occurrences.length) return false;
        } else if (withMatchingValue.length === 0) {
          return false;
        }
      }
      return true;
    }

    const token = matcher.token;
    console.log('[DEBUG value]', JSON.stringify({ token, pattern: matcher.pattern, occurrences: views.flagOccurrences }), 'safety:', JSON.stringify(views.safetyOperandList));
    if (matcher.pattern !== undefined) {
      // Value matcher over a repeated flag: `allow` requires every occurrence's value
      // to glob-match (an occurrence without a value fails the allow); `ask`/`deny`
      // need at least one matching occurrence.
      const occurrences = views.flagOccurrences.filter((occ) => occ.base === token);
      const withMatchingValue = occurrences.filter((occ) => occ.value !== undefined && matchTokenPattern(occ.value, matcher.pattern!));
      if (matcher.action === "allow") {
        return occurrences.length > 0 && withMatchingValue.length === occurrences.length;
      }
      return withMatchingValue.length > 0;
    }
    if (isFlagLike(token)) {
      return views.flagOccurrences.some((occ) => tokenMatchesTarget(occ.base, token));
    }
    return views.safetyOperandList.includes(token);
  }

  if (matcher.position !== undefined) {
    if (matcher.position === "all") {
      if (views.positionalList.length === 0) return false;
      const matched = views.positionalList.filter((token) => matchTokenPattern(token, matcher.pattern!));
      if (matcher.action === "allow") {
        return matched.length === views.positionalList.length;
      }
      return matched.length > 0;
    }
    const token = views.positionalList[matcher.position];
    return token !== undefined && matchTokenPattern(token, matcher.pattern!);
  }

  if (matcher.operand === "all") {
    if (views.safetyOperandList.length === 0) return false;
    const matched = views.safetyOperandList.filter((token) => matchTokenPattern(token, matcher.pattern!));
    if (matcher.action === "allow") {
      return matched.length === views.safetyOperandList.length;
    }
    return matched.length > 0;
  }

  return false;
}

/**
 * Refinement requires a provably strict subset: B's positional levels are a prefix of
 * A's levels, every flag predicate of B is matched by an identical predicate of A
 * (same base flag and value glob — presence and value predicates on one base flag are
 * incomparable), and at least one dimension is strict. A path rule and a value matcher
 * are always incomparable: a value constraint cannot be proven subsumed by path levels,
 * so a value-specific deny always survives an exact-path allow. Structurally identical
 * matchers never refine each other.
 */
function refines(a: ArgMatcher, b: ArgMatcher): boolean {
  // Refinement applies only between two array path matchers — matcher kinds
  // (array paths, scalar non-flag tokens, scalar flag families, position,
  // operand) are mutually incomparable, so incomparable matches always
  // reduce most-restrictive (fail-safe).
  if (!Array.isArray(a.token) || !Array.isArray(b.token)) return false;
  const aElements: string[] = a.token;
  const bElements: string[] = b.token;
  const aLevels = aElements.filter((el) => !isFlagLike(el));
  const bLevels = bElements.filter((el) => !isFlagLike(el));
  const levelsPrefix = bLevels.length <= aLevels.length && bLevels.every((el, i) => el === aLevels[i]);
  const aFlagValues = a.flagValues ?? {};
  const bFlagValues = b.flagValues ?? {};
  const predicatesSuperset =
    bElements.filter((el) => isFlagLike(el)).every((element) => aElements.includes(element)) &&
    Object.keys(bFlagValues).every((key) => aFlagValues[key] === bFlagValues[key]);
  const aPredicateCount = aElements.filter((el) => isFlagLike(el)).length + Object.keys(aFlagValues).length;
  const bPredicateCount = bElements.filter((el) => isFlagLike(el)).length + Object.keys(bFlagValues).length;
  const strict = aLevels.length > bLevels.length || aPredicateCount > bPredicateCount;
  if (levelsPrefix && predicatesSuperset && strict) return true;
  return false;
}

/**
 * Within one scalar flag family: a patterned `allow` refines the same bare flag
 * (runtime-proven narrower — the value matcher returns true only when every
 * occurrence satisfies the pattern); a patterned `ask` and a bare `deny` stay
 * incomparable (the ask cannot downgrade the deny).
 */
function refinesScalarFamily(a: ArgMatcher, b: ArgMatcher): boolean {
  return (
    typeof a.token === "string" &&
    typeof b.token === "string" &&
    a.token === b.token &&
    a.pattern !== undefined &&
    b.pattern === undefined &&
    a.action === "allow"
  );
}

/**
 * Match a segment's argv tokens against tool permission entries.
 * Matching matchers refined by another matching matcher are discarded (refinement
 * picks the most precise description); the survivors — plus fail-safe `ask`
 * contributions from classification ambiguity — reduce most-restrictive-wins.
 */
export function matchToolActions(argv: string[], entries: ToolPermissionEntry[]): PermissionAction[] {
  const toolEntries = entries.filter((entry) => entry.tool === argv[0]);
  if (toolEntries.length === 0) return [];

  // Aggregate flag arity per executable: explicit `flags` tables first (equal-rank
  // conflicts resolve to the value-less reading), then inference from scalar value
  // matchers and `flagValues` keys. A value matcher on a flag that a table declares
  // value-less is a contradiction: the matcher could promote an ordinary operand to
  // an allowed flag value, so the executable's args policy suspends into ask. Arity
  // is uniform across the executable.
  const arity: Record<string, 0 | 1> = {};
  for (const entry of toolEntries) {
    for (const [flag, declared] of Object.entries(entry.flags ?? {})) {
      if (arity[flag] !== undefined && arity[flag] !== declared) {
        arity[flag] = 0;
        warnOnce(`arity-conflict:${argv[0]}:${flag}`, `[opencode-bash-guard] Conflicting flags declarations for "${flag}" on tool "${argv[0]}" — resolving to value-less; declare it consistently.`);
      } else {
        arity[flag] = declared;
      }
    }
  }

  const inference: string[] = [];
  for (const entry of toolEntries) {
    for (const matcher of entry.args) {
      if (typeof matcher.token === "string" && matcher.pattern !== undefined && !inference.includes(matcher.token)) {
        inference.push(matcher.token);
      }
      if (Array.isArray(matcher.token) && matcher.flagValues !== undefined) {
        for (const flag of Object.keys(matcher.flagValues)) {
          if (!inference.includes(flag)) inference.push(flag);
        }
      }
    }
  }
  for (const flag of inference) {
    if (arity[flag] === 0) {
      warnOnce(`arity-contradiction:${argv[0]}:${flag}`, `[opencode-bash-guard] Flag "${flag}" on tool "${argv[0]}" is declared value-less but has a value matcher — suspending args policy for this tool to ask.`);
      return ["ask"];
    }
    arity[flag] = 1;
  }

  const views = classifySegment(argv, arity);

  const matching: ArgMatcher[] = [];
  for (const entry of toolEntries) {
    for (const matcher of entry.args) {
      if (evalMatcher(matcher, views)) matching.push(matcher);
    }
  }
  const actions = matching
    .filter(
      (matcher) =>
        !matching.some((other) => other !== matcher && (refines(other, matcher) || refinesScalarFamily(other, matcher))),
    )
    .map((matcher) => matcher.action);

  // Classification ambiguity (probable missing arity, `=`-form on a declared
  // value-less flag) always resolves to human review.
  if (views.segmentAsk) actions.push("ask");

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

export interface ValidatedPermissions {
  entries: ToolPermissionEntry[];
  /** Executables whose args policy is suspended into scoped ask (invalid entries). */
  forcedAskTools: string[];
  /** True when an invalid entry had no determinable tool — global degraded ask. */
  globalDegraded: boolean;
}

export function validateToolPermissions(raw: unknown, warn: (message: string) => void = (m) => console.warn(m)): ValidatedPermissions {
  const entries: ToolPermissionEntry[] = [];
  const forcedAskTools = new Set<string>();
  let globalDegraded = false;
  if (!Array.isArray(raw)) return { entries, forcedAskTools: [], globalDegraded: true };

  const isValidAction = (value: unknown): value is PermissionAction => value === "allow" || value === "ask" || value === "deny";

  const isValidBaseFlagIdentity = (value: unknown): value is string =>
    typeof value === "string" && value.startsWith("-") && value !== "-" && value !== "--" && !/[\s=]/.test(value);

  const isValidTokenString = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value !== "--" && !(value.startsWith("-") && value.includes("="));

  const isValidToken = (value: unknown): value is string | string[] => {
    if (typeof value === "string") return isValidTokenString(value);
    return Array.isArray(value) && value.length > 0 && value.every((element) => isValidTokenString(element));
  };

  const tokenIsNonFlag = (token: unknown): boolean => typeof token === "string" && !isFlagLike(token);

  // Accepts the raw config shape (`action` optional) and returns the normalized matcher.
  const normalizeMatcher = (input: unknown): ArgMatcher | null => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const matcher = input as { token?: unknown; position?: unknown; operand?: unknown; pattern?: unknown; action?: unknown; args?: unknown; flagValues?: unknown };
    const knownMatcherFields = ["token", "position", "operand", "pattern", "flagValues", "action"];
    if (!Object.keys(matcher).every((key) => knownMatcherFields.includes(key))) return null;
    if (matcher.args !== undefined) return null; // legacy nested trees — removed, flatten to path arrays
    const hasToken = isValidToken(matcher.token);
    const hasPosition = matcher.position === "all" || (typeof matcher.position === "number" && Number.isInteger(matcher.position) && matcher.position >= 0);
    const hasOperand = matcher.operand === "all";
    const declared = [hasToken, hasPosition, hasOperand].filter(Boolean).length;
    if (declared !== 1) return null;
    const tokenIsArray = Array.isArray(matcher.token);
    if ((hasPosition || hasOperand) && typeof matcher.pattern !== "string") return null;
    if (typeof matcher.pattern !== "undefined" && (typeof matcher.pattern !== "string" || tokenIsArray || tokenIsNonFlag(matcher.token))) return null;
    if (tokenIsArray) {
      const dashElements = (matcher.token as string[]).filter((el) => isFlagLike(el));
      if (new Set(dashElements).size !== dashElements.length) return null; // duplicate presence predicates are invalid
    }
    if (matcher.flagValues !== undefined) {
      if (!tokenIsArray) return null;
      const table = matcher.flagValues;
      if (!table || typeof table !== "object" || Array.isArray(table)) return null;
      const ok = Object.entries(table).every(([key, glob]) => isValidBaseFlagIdentity(key) && typeof glob === "string");
      if (!ok) return null;
    }
    if (matcher.action === undefined) {
      return {
        token: matcher.token as string | string[] | undefined,
        position: matcher.position as number | "all" | undefined,
        operand: matcher.operand as "all" | undefined,
        pattern: matcher.pattern as string | undefined,
        action: "ask",
      };
    }
    if (!isValidAction(matcher.action)) return null;
    return matcher as ArgMatcher;
  };

  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      warn(`[opencode-bash-guard] Dropping invalid permissions entry (not an object): ${JSON.stringify(item)}`);
      globalDegraded = true;
      continue;
    }
    const entry = item as { tool?: unknown; args?: unknown; flags?: unknown };
    const describe = JSON.stringify(item) ?? String(item);
    const knownEntryFields = ["tool", "args", "flags"];
    if (typeof entry.tool !== "string" || entry.tool.length === 0 || !Array.isArray(entry.args) || !Object.keys(entry).every((key) => knownEntryFields.includes(key))) {
      warn(`[opencode-bash-guard] Dropping invalid permissions entry (missing tool or args): ${describe}`);
      globalDegraded = true;
      continue;
    }
    const entryFlags = (entry as { flags?: unknown }).flags;
    if (entryFlags !== undefined && (entryFlags === null || typeof entryFlags !== "object" || Array.isArray(entryFlags) || !Object.values(entryFlags).every((v) => v === 0 || v === 1))) {
      warn(`[opencode-bash-guard] Dropping invalid flags table for tool "${entry.tool}": ${JSON.stringify(entryFlags)}`);
      forcedAskTools.add(entry.tool);
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
    if (!valid) {
      forcedAskTools.add(entry.tool);
      continue;
    }
    entries.push({ tool: entry.tool, args: matchers, flags: entryFlags as Record<string, 0 | 1> | undefined });
  }
  return { entries, forcedAskTools: [...forcedAskTools], globalDegraded };
}
