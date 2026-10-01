import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  pluginConfigPaths,
  readPluginConfigFiles,
  parsePluginConfig,
  loadRestructureConfig,
  DEFAULT_RESTRUCTURE_CONFIG,
} from "../plugin-config.js";
import type { PluginConfigFile } from "../plugin-config.js";

function file(p: string, content: string): PluginConfigFile {
  return { path: p, content };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("pluginConfigPaths", () => {
  it("uses XDG_CONFIG_HOME when set", () => {
    vi.stubEnv("XDG_CONFIG_HOME", "/xdg");
    const paths = pluginConfigPaths("/project");
    expect(paths[0]).toBe(path.join("/xdg", "opencode", "opencode-bash-guard.jsonc"));
    expect(paths[1]).toBe(path.join("/project", ".opencode", "opencode-bash-guard.jsonc"));
  });

  it("falls back to ~/.config/opencode", () => {
    const prev = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    try {
      const paths = pluginConfigPaths("/project");
      expect(paths[0]).toBe(path.join(os.homedir(), ".config", "opencode", "opencode-bash-guard.jsonc"));
    } finally {
      if (prev !== undefined) process.env.XDG_CONFIG_HOME = prev;
    }
  });
});

describe("readPluginConfigFiles", () => {
  it("skips missing files silently", () => {
    const existing = path.join(os.tmpdir(), `obg-test-${Date.now()}.jsonc`);
    fs.writeFileSync(existing, "{}");
    try {
      const files = readPluginConfigFiles([path.join(os.tmpdir(), "obg-does-not-exist.jsonc"), existing]);
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe(existing);
    } finally {
      fs.unlinkSync(existing);
    }
  });
});

describe("parsePluginConfig", () => {
  it("no files → defaults with restructure disabled", () => {
    const result = parsePluginConfig([]);
    expect(result).toEqual(DEFAULT_RESTRUCTURE_CONFIG);
    expect(result.enabled).toBe(false);
    expect(result.maxSegments).toBe(3);
    expect(result.maxDepth).toBe(2);
  });

  it("config without restructure section → disabled", () => {
    const result = parsePluginConfig([file("global.jsonc", '{"other": true}')]);
    expect(result.enabled).toBe(false);
  });

  it("JSONC comments and trailing commas accepted", () => {
    const content = `{
      // Reject complex one-liners
      "restructure": {
        "enabled": true, // opt in
        "max_segments": 4,
      },
    }`;
    const result = parsePluginConfig([file("global.jsonc", content)]);
    expect(result).toEqual({ enabled: true, maxSegments: 4, maxDepth: 2 });
  });

  it("project overrides global, unset project fields fall back to global", () => {
    const globalFile = file("global.jsonc", '{"restructure": { "enabled": true, "max_segments": 3 }}');
    const projectFile = file("project.jsonc", '{"restructure": { "max_segments": 5 }}');
    const result = parsePluginConfig([globalFile, projectFile]);
    expect(result).toEqual({ enabled: true, maxSegments: 5, maxDepth: 2 });
  });

  it("invalid JSONC → warning naming the file + feature disabled", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const good = file("global.jsonc", '{"restructure": { "enabled": true }}');
    const bad = file("project.jsonc", '{"restructure": { "enabled": true,,,, }}');
    const result = parsePluginConfig([good, bad]);
    expect(result.enabled).toBe(false);
    expect(result).toEqual(DEFAULT_RESTRUCTURE_CONFIG);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("project.jsonc"));
  });

  it("invalid thresholds → warning + defaults apply", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const content = '{"restructure": { "enabled": true, "max_segments": 0, "max_depth": "many" }}';
    const result = parsePluginConfig([file("global.jsonc", content)]);
    expect(result).toEqual({ enabled: true, maxSegments: 3, maxDepth: 2 });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("explicit values honored", () => {
    const content = '{"restructure": { "enabled": true, "max_segments": 5, "max_depth": 1 }}';
    const result = parsePluginConfig([file("global.jsonc", content)]);
    expect(result).toEqual({ enabled: true, maxSegments: 5, maxDepth: 1 });
  });

  it("non-boolean enabled is not enabled", () => {
    const content = '{"restructure": { "enabled": "yes" }}';
    const result = parsePluginConfig([file("global.jsonc", content)]);
    expect(result.enabled).toBe(false);
  });
});

describe("loadRestructureConfig", () => {
  it("reads global (XDG) and project files, project wins", () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "obg-xdg-"));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "obg-proj-"));
    fs.mkdirSync(path.join(xdg, "opencode"), { recursive: true });
    fs.mkdirSync(path.join(project, ".opencode"), { recursive: true });
    fs.writeFileSync(path.join(xdg, "opencode", "opencode-bash-guard.jsonc"), '{"restructure": { "enabled": true, "max_depth": 3 }}');
    fs.writeFileSync(path.join(project, ".opencode", "opencode-bash-guard.jsonc"), '{"restructure": { "max_segments": 6 }}');

    const prev = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      const result = loadRestructureConfig(project);
      expect(result).toEqual({ enabled: true, maxSegments: 6, maxDepth: 3 });
    } finally {
      if (prev !== undefined) process.env.XDG_CONFIG_HOME = prev;
      fs.rmSync(xdg, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("no files anywhere → disabled defaults", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "obg-empty-"));
    const prev = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(os.tmpdir(), `obg-nope-${Date.now()}`);
    try {
      const result = loadRestructureConfig(project);
      expect(result).toEqual(DEFAULT_RESTRUCTURE_CONFIG);
    } finally {
      if (prev !== undefined) process.env.XDG_CONFIG_HOME = prev;
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});
