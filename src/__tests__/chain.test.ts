import { describe, it, expect } from "vitest";
import { parseChain } from "../chain.js";

describe("parseChain", () => {
  it("parses simple chain with &&", () => {
    const result = parseChain("cd src && npm run build");
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].commandName).toBe("cd");
    expect(result.segments[1].commandName).toBe("npm");
    expect(result.parseError).toBe(false);
  });

  it("parses pipe chain", () => {
    const result = parseChain("cat log.txt | grep error | sort");
    expect(result.segments).toHaveLength(3);
    expect(result.segments[0].commandName).toBe("cat");
    expect(result.segments[1].commandName).toBe("grep");
    expect(result.segments[2].commandName).toBe("sort");
  });

  it("respects chaining operators inside quotes", () => {
    const result = parseChain('echo "hello && world"');
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].commandName).toBe("echo");
  });

  it("extracts command name from segment", () => {
    const result = parseChain("rm -rf /tmp");
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].commandName).toBe("rm");
    expect(result.segments[0].command).toBe("rm -rf /tmp");
  });

  it("preserves command substitution as arguments", () => {
    const result = parseChain('cat $(find . -name "*.txt") | head');
    expect(result.segments.length).toBeGreaterThanOrEqual(2);
    expect(result.segments[0].commandName).toBe("cat");
    expect(result.segments[1].commandName).toBe("head");
  });

  it("extracts commands from $() substitution", () => {
    const result = parseChain('cat $(find . -name "*.txt")');
    const commandNames = result.segments.map((s) => s.commandName);
    expect(commandNames).toContain("find");
    expect(commandNames).toContain("cat");
  });

  it("handles backtick substitution", () => {
    const result = parseChain("echo `date`");
    const commandNames = result.segments.map((s) => s.commandName);
    expect(commandNames).toContain("date");
    expect(commandNames).toContain("echo");
  });

  it("handles multiple nested substitutions", () => {
    const result = parseChain("diff $(ls dir1) $(ls dir2)");
    const commandNames = result.segments.map((s) => s.commandName);
    expect(commandNames).toContain("diff");
    expect(commandNames).toContain("ls");
  });

  it("handles eval with dangerous command", () => {
    const result = parseChain('eval "rm -rf /"');
    const commandNames = result.segments.map((s) => s.commandName);
    expect(commandNames).toContain("eval");
    expect(commandNames).toContain("rm");
  });

  it("handles eval in chain", () => {
    const result = parseChain('git status && eval "sudo rm -rf /"');
    const commandNames = result.segments.map((s) => s.commandName);
    expect(commandNames).toContain("git");
    expect(commandNames).toContain("eval");
  });

  it("handles sh -c with dangerous command", () => {
    const result = parseChain('sh -c "rm -rf /"');
    const commandNames = result.segments.map((s) => s.commandName);
    expect(commandNames).toContain("rm");
  });

  it("handles bash -c with nested chain", () => {
    const result = parseChain('bash -c "cd /tmp && rm -rf ."');
    const commandNames = result.segments.map((s) => s.commandName);
    expect(commandNames).toContain("bash");
    expect(commandNames).toContain("rm");
  });

  it("returns empty for empty input", () => {
    const result = parseChain("");
    expect(result.segments).toHaveLength(0);
    expect(result.parseError).toBe(false);
  });

  it("returns empty for whitespace-only input", () => {
    const result = parseChain("   ");
    expect(result.segments).toHaveLength(0);
    expect(result.parseError).toBe(false);
  });

  it("captures fd redirect as well-known", () => {
    const result = parseChain("ls -la 2>&1");
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].redirects).toHaveLength(1);
    expect(result.segments[0].redirects[0].target).toBe("1");
    expect(result.segments[0].redirects[0].wellKnown).toBe(true);
    expect(result.segments[0].command).toContain("2>&1");
  });

  it("captures /dev/null redirect as well-known", () => {
    const result = parseChain("ls -la > /dev/null");
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].redirects).toHaveLength(1);
    expect(result.segments[0].redirects[0].target).toBe("/dev/null");
    expect(result.segments[0].redirects[0].wellKnown).toBe(true);
    expect(result.segments[0].command).toContain(">/dev/null");
  });

  it("captures file redirect as not well-known", () => {
    const result = parseChain("ls -la > /tmp/out.txt");
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].redirects).toHaveLength(1);
    expect(result.segments[0].redirects[0].target).toBe("/tmp/out.txt");
    expect(result.segments[0].redirects[0].wellKnown).toBe(false);
    expect(result.segments[0].command).toContain(">/tmp/out.txt");
  });

  it("captures heredoc as well-known", () => {
    const result = parseChain("cat << EOF");
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].redirects).toHaveLength(1);
    expect(result.segments[0].redirects[0].wellKnown).toBe(true);
  });

  it("captures redirect in chain", () => {
    const result = parseChain("echo hello > file.txt && cat file.txt");
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].redirects).toHaveLength(1);
    expect(result.segments[0].redirects[0].target).toBe("file.txt");
    expect(result.segments[0].redirects[0].wellKnown).toBe(false);
    expect(result.segments[1].redirects).toHaveLength(0);
  });

  it("includes redirect in command text", () => {
    const result = parseChain("echo test 2>/dev/null");
    expect(result.segments[0].command).toBe("echo test 2>/dev/null");
  });
});
