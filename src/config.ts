export interface BashPermissionRule {
  pattern: string;
  action: "ask" | "allow" | "deny";
}

export type ExternalDirectoryAction = "ask" | "allow" | "deny";

export interface ExternalDirectoryRule {
  pattern: string;
  action: ExternalDirectoryAction;
}

export interface PluginConfig {
  bashRules: BashPermissionRule[];
  externalDirectoryRules: ExternalDirectoryRule[];
  externalDirectoryDefault: ExternalDirectoryAction | null;
  enabled: boolean;
}

function isPermissionAction(value: string): value is "ask" | "allow" | "deny" {
  return value === "ask" || value === "allow" || value === "deny";
}

export function parseConfig(config: Record<string, unknown>): PluginConfig {
  const permission = config.permission as Record<string, unknown> | undefined;

  let bashRules: BashPermissionRule[] = [];
  let externalDirectoryRules: ExternalDirectoryRule[] = [];
  let externalDirectoryDefault: ExternalDirectoryAction | null = null;
  let enabled = true;

  if (permission) {
    const bash = permission.bash;
    if (typeof bash === "string" && isPermissionAction(bash)) {
      bashRules = [{ pattern: "*", action: bash }];
    } else if (bash && typeof bash === "object") {
      bashRules = Object.entries(bash)
        .filter((entry): entry is [string, unknown] => true)
        .map(([pattern, action]) => ({
          pattern,
          action: (isPermissionAction(String(action)) ? String(action) : "ask") as "ask" | "allow" | "deny",
        }));
    }

    const wildAction = bashRules.find((r) => r.pattern === "*")?.action;
    if (wildAction === "allow") {
      enabled = false;
    }

    const ed = permission.external_directory;
    if (typeof ed === "string" && isPermissionAction(ed)) {
      externalDirectoryDefault = ed;
    } else if (ed && typeof ed === "object") {
      for (const [pattern, action] of Object.entries(ed)) {
        if (isPermissionAction(String(action))) {
          externalDirectoryRules.push({ pattern, action: String(action) as ExternalDirectoryAction });
        }
      }
    }
  }

  if (!permission || !permission.bash) {
    enabled = false;
  }

  return { bashRules, externalDirectoryRules, externalDirectoryDefault, enabled };
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
    const re = new RegExp(`^${regexStr}$`);
    return re.test(relative) || re.test(`${relative}/`);
  }

  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  const re = new RegExp(`^${regexStr}$`);
  return re.test(filePath) || re.test(`${filePath}/`);
}

function globMatch(str: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${regexStr}$`).test(str);
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
