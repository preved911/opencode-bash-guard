import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import fs from "fs";
import os from "os";
import path from "path";

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

const CONFIG_FILE_NAME = "opencode-bash-guard.jsonc";

/** A config file read from disk, in increasing precedence order. */
export interface PluginConfigFile {
  path: string;
  content: string;
}

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
 * Read every config file that exists. Missing (or otherwise unreadable) files
 * are skipped silently per spec; invalid JSONC is handled at parse time.
 */
export function readPluginConfigFiles(paths: string[]): PluginConfigFile[] {
  const files: PluginConfigFile[] = [];
  for (const filePath of paths) {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      files.push({ path: filePath, content });
    } catch {
      // Missing file at a location is not an error — skip silently.
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
 * Parse the collected config files (in increasing precedence order) into the
 * effective RestructureConfig. JSONC syntax (comments, trailing commas) is
 * allowed. Any file with invalid JSONC disables the `restructure` feature
 * entirely (fail-safe: a partially-valid config must not enable enforcement)
 * and emits a warning naming the file; the plugin's core chain-guard behavior
 * is unaffected by plugin-config failures.
 */
export function parsePluginConfig(files: PluginConfigFile[]): RestructureConfig {
  if (files.length === 0) {
    return { ...DEFAULT_RESTRUCTURE_CONFIG };
  }

  let merged: Record<string, unknown> = {};
  let allValid = true;

  for (const file of files) {
    const errors: ParseError[] = [];
    const parsed = parseJsonc(file.content, errors, { allowTrailingComma: true });
    if (errors.length > 0 || parsed === undefined || parsed === null || typeof parsed !== "object") {
      console.warn(
        `[opencode-bash-guard] Invalid JSONC in ${file.path} — ignoring plugin config, restructure treated as disabled.`,
      );
      allValid = false;
      continue;
    }
    merged = deepMerge(merged, parsed as Record<string, unknown>);
  }

  if (!allValid) {
    return { ...DEFAULT_RESTRUCTURE_CONFIG };
  }

  const raw = isPlainObject(merged.restructure) ? merged.restructure : {};

  return {
    enabled: raw.enabled === true,
    maxSegments: resolveThreshold(raw.max_segments, DEFAULT_RESTRUCTURE_CONFIG.maxSegments, "max_segments"),
    maxDepth: resolveThreshold(raw.max_depth, DEFAULT_RESTRUCTURE_CONFIG.maxDepth, "max_depth"),
  };
}

/**
 * Load the effective RestructureConfig once at plugin init: discover both
 * locations, read what exists, parse and merge (project wins over global).
 * Changes to the file require an opencode restart.
 */
export function loadRestructureConfig(projectDir: string): RestructureConfig {
  return parsePluginConfig(readPluginConfigFiles(pluginConfigPaths(projectDir)));
}
