import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import fs from "fs";
import os from "os";
import path from "path";
import { validateToolPermissions, type ToolPermissionEntry } from "./config.js";

/** Plugin behavior tuning, read from opencode-bash-guard.jsonc. */
export interface RestructureConfig {
  enabled: boolean;
  maxSegments: number;
  maxDepth: number;
}

export const DEFAULT_RESTRUCTURE_CONFIG: RestructureConfig = {
  enabled: false,
  maxSegments: 3,
  maxDepth: 2,
};

/** Everything the plugin loads from its own config file. `degraded` drives ask-everything enforcement. */
export interface PluginFileConfig {
  restructure: RestructureConfig;
  toolPermissions: ToolPermissionEntry[];
  /** Executables whose args policy is suspended into scoped ask (invalid/unmigrated config). */
  forcedAskTools: string[];
  degraded: boolean;
}

export const DEFAULT_PLUGIN_FILE_CONFIG: PluginFileConfig = {
  restructure: DEFAULT_RESTRUCTURE_CONFIG,
  toolPermissions: [],
  forcedAskTools: [],
  degraded: false,
};

const CONFIG_FILE_NAME = "opencode-bash-guard.jsonc";

/** A config file read from disk, in increasing precedence order. */
export type PluginConfigFile =
  | { path: string; content: string }
  | { path: string; readError: string };

/**
 * Discover the opencode-bash-guard.jsonc locations in increasing precedence:
 * global (`$XDG_CONFIG_HOME/opencode/` or `~/.config/opencode/`) then project
 * (`<project>/.opencode/`). Files may not exist; absence is not an error.
 */
export function pluginConfigPaths(projectDir: string): string[] {
  const globalConfigDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return [
    path.join(globalConfigDir, "opencode", CONFIG_FILE_NAME),
    path.join(projectDir, ".opencode", CONFIG_FILE_NAME),
  ];
}

/**
 * Read every config file that exists. Missing files are skipped silently;
 * other read failures are retained so parsing can fail closed.
 */
export function readPluginConfigFiles(paths: string[]): PluginConfigFile[] {
  const files: PluginConfigFile[] = [];
  for (const filePath of paths) {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      files.push({ path: filePath, content });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      files.push({ path: filePath, readError: error instanceof Error ? error.message : String(error) });
    }
  }
  return files;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Objects deep-merge; scalars and arrays override. `override` wins. */
function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = deepMerge(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function resolveThreshold(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    console.warn(
      `[opencode-bash-guard] Invalid restructure.${name} value (${JSON.stringify(value) ?? "undefined"}) — dropped, default ${fallback} applies.`,
    );
    return fallback;
  }
  return value;
}

/**
 * Parse the collected config files (in increasing precedence order).
 * JSONC syntax (comments, trailing commas) is allowed; objects deep-merge, project wins.
 * Any file with invalid JSONC enters degraded mode: `permissions` treated as absent AND
 * glob allows are suspended downstream (ask-everything), so a broken config can never
 * silently re-allow a restricted command. Individual invalid `permissions` entries are
 * dropped with a warning while the rest keep working.
 */
/**
 * Parse the collected config files (in increasing precedence order).
 * JSONC syntax (comments, trailing commas) is allowed; objects deep-merge, project wins.
 * Any file with invalid JSONC enters degraded mode: `permissions` treated as absent AND
 * glob allows are suspended downstream (ask-everything), so a broken config can never
 * silently re-allow a restricted command. Individual invalid `permissions` entries are
 * dropped with a warning while the rest keep working.
 *
 * `matcherVersion` gates the ordered command path semantics. It is honored only in the
 * config source that provides the effective `permissions` array — a marker from a
 * different source cannot opt in a project-local legacy permissions block. A config
 * source with a non-empty `permissions` array and no `"matcherVersion": 2` is unmigrated:
 * every executable it names resolves to `ask` (scoped) with a one-time migration warning.
 * Any non-2 marker value triggers global degraded ask.
 */
export function parsePluginConfig(files: PluginConfigFile[]): PluginFileConfig {
  if (files.length === 0) {
    return { restructure: { ...DEFAULT_RESTRUCTURE_CONFIG }, toolPermissions: [], forcedAskTools: [], degraded: false };
  }

  let merged: Record<string, unknown> = {};
  let allValid = true;
  let permissionsSource = -1;
  let markerSource = -1;

  for (const [index, file] of files.entries()) {
    if ("readError" in file) {
      console.warn(
        `[opencode-bash-guard] Cannot read ${file.path}: ${file.readError} — degraded mode: every bash command will ask until the file is readable.`,
      );
      allValid = false;
      continue;
    }
    const errors: ParseError[] = [];
    const parsed = parseJsonc(file.content, errors, { allowTrailingComma: true });
    if (errors.length > 0 || !isPlainObject(parsed)) {
      console.warn(
        `[opencode-bash-guard] Invalid JSONC in ${file.path} — degraded mode: every bash command will ask until the file is fixed.`,
      );
      allValid = false;
      continue;
    }
    const parsedObject = parsed;
    if (parsedObject.permissions !== undefined) permissionsSource = index;
    if (parsedObject.matcherVersion !== undefined) markerSource = index;
    merged = deepMerge(merged, parsedObject);
  }

  if (!allValid) {
    return { restructure: { ...DEFAULT_RESTRUCTURE_CONFIG }, toolPermissions: [], forcedAskTools: [], degraded: true };
  }

  const raw = isPlainObject(merged.restructure) ? merged.restructure : {};

  const restructure: RestructureConfig = {
    enabled: raw.enabled === true,
    maxSegments: resolveThreshold(raw.max_segments, DEFAULT_RESTRUCTURE_CONFIG.maxSegments, "max_segments"),
    maxDepth: resolveThreshold(raw.max_depth, DEFAULT_RESTRUCTURE_CONFIG.maxDepth, "max_depth"),
  };

  const validated = validateToolPermissions(merged.permissions);
  const forcedAskTools = new Set<string>(validated.forcedAskTools);

  // The matcherVersion marker is honored only from the source that contributes the
  // effective `permissions` array; a marker from a different source is ignored.
  if (markerSource !== -1 && markerSource !== permissionsSource) {
    console.warn(
      `[opencode-bash-guard] Ignoring matcherVersion in ${files[markerSource].path} — it does not provide the effective \`permissions\` array.`,
    );
  }
  const markerHonored = markerSource === permissionsSource ? merged.matcherVersion : undefined;

  if (merged.permissions !== undefined && validated.globalDegraded) {
    return { restructure, toolPermissions: [], forcedAskTools: [], degraded: true };
  }

  const rawPermissions = Array.isArray(merged.permissions) ? (merged.permissions as unknown[]) : [];
  if (rawPermissions.length > 0) {
    if (markerHonored === undefined) {
      for (const item of rawPermissions) {
        const tool = item && typeof item === "object" && typeof (item as { tool?: unknown }).tool === "string" ? (item as { tool: string }).tool : null;
        if (tool) forcedAskTools.add(tool);
      }
      console.warn(
        `[opencode-bash-guard] Unmigrated permissions (no \`"matcherVersion": 2\` next to \`permissions\`) — affected executables resolve to \`ask\` until the config is audited for anchored path semantics.`,
      );
    } else if (markerHonored !== 2) {
      console.warn(
        `[opencode-bash-guard] Invalid matcherVersion (${JSON.stringify(markerHonored)}) — degraded mode: every bash command will ask until it is set to 2.`,
      );
      return { restructure, toolPermissions: validated.entries, forcedAskTools: [...forcedAskTools], degraded: true };
    }
  }

  return {
    restructure,
    toolPermissions: validated.entries,
    forcedAskTools: [...forcedAskTools],
    degraded: false,
  };
}

/**
 * Load the effective plugin config once at plugin init: discover both
 * locations, read what exists, parse and merge (project wins over global).
 * Changes to the file require an opencode restart.
 */
export function loadPluginConfig(projectDir: string): PluginFileConfig {
  return parsePluginConfig(readPluginConfigFiles(pluginConfigPaths(projectDir)));
}
