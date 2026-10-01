import { describe, it, expect } from "vitest";
import { parseChain, parseChainPerLine, detectInlineScript, countScriptStatements } from "../chain.js";
import type { ChainSegment } from "../chain.js";

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

describe("parseChain maxDepth", () => {
  it("empty command → depth 0", () => {
    expect(parseChain("").maxDepth).toBe(0);
  });

  it("flat chain → depth 1", () => {
    expect(parseChain("git status && git log").maxDepth).toBe(1);
    expect(parseChain("echo hi").maxDepth).toBe(1);
  });

  it("single-level $() → depth 2", () => {
    expect(parseChain('echo $(whoami)').maxDepth).toBe(2);
  });

  it("double $() nesting → depth 3", () => {
    expect(parseChain("echo $(echo $(whoami))").maxDepth).toBe(3);
  });

  it("nested backticks → depth 3", () => {
    expect(parseChain("echo `echo \\`echo hi\\``").maxDepth).toBe(3);
  });

  it("bash -c string arg counts as one level", () => {
    expect(parseChain('bash -c "a && b"').maxDepth).toBe(2);
  });

  it("expansion inside meta-command body adds a level", () => {
    expect(parseChain('bash -c "echo $(whoami)"').maxDepth).toBe(3);
  });

  it("eval string arg counts as one level", () => {
    expect(parseChain('eval "echo hi"').maxDepth).toBe(2);
  });

  it("depth checked across multi-line commands", () => {
    const script = "git status\necho $(echo $(whoami))";
    expect(parseChain(script).maxDepth).toBe(3);
  });
});

describe("parseChainPerLine", () => {
  it("one command per line — each line a single segment", () => {
    const result = parseChainPerLine("git status\ngit log\ngit diff\ngit show");
    expect(result.lines).toHaveLength(4);
    expect(result.lines.map((l) => l.segmentCount)).toEqual([1, 1, 1, 1]);
    expect(result.lines.map((l) => l.lineNumber)).toEqual([1, 2, 3, 4]);
    expect(result.worstLine).toEqual({ lineNumber: 1, segmentCount: 1 });
  });

  it("per-line && chains — worst line reported with correct line number", () => {
    const result = parseChainPerLine("a && b && c && d && e\nf && g && h && i && j");
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]).toEqual({ lineNumber: 1, segmentCount: 5 });
    expect(result.lines[1]).toEqual({ lineNumber: 2, segmentCount: 5 });
    expect(result.worstLine).toEqual({ lineNumber: 1, segmentCount: 5 });
  });

  it("skips blank lines when numbering", () => {
    const result = parseChainPerLine("git status\n\n   \ngit log");
    expect(result.lines.map((l) => l.lineNumber)).toEqual([1, 4]);
  });

  it("empty command → no lines, no worst", () => {
    const result = parseChainPerLine("\n\n");
    expect(result.lines).toHaveLength(0);
    expect(result.worstLine).toBeNull();
  });
});

function seg(command: string, redirects: ChainSegment["redirects"] = []): ChainSegment {
  return { command, commandName: command.split(/\s+/)[0] ?? "", argv: command.split(/\s+/), redirects };
}

describe("detectInlineScript", () => {
  it("counts ;-separated python3 -c statements", () => {
    const info = detectInlineScript(seg(`python3 -c "import os; os.system('a'); os.system('b'); os.system('c'); os.system('d')"`));
    expect(info).toEqual({ interpreter: "python -c", statementCount: 5 });
  });

  it("counts newline-separated statements", () => {
    const info = detectInlineScript(seg('node -e "const a = 1;\nconst b = 2;\nconsole.log(a + b)"'));
    expect(info).toEqual({ interpreter: "node -e", statementCount: 3 });
  });

  it("node --eval recognized", () => {
    const info = detectInlineScript(seg('node --eval "console.log(1); console.log(2)"'));
    expect(info).toEqual({ interpreter: "node -e", statementCount: 2 });
  });

  it("perl -e, ruby -e, php -r recognized", () => {
    expect(detectInlineScript(seg(`perl -e 'print 1; print 2;'`))).toEqual({ interpreter: "perl -e", statementCount: 2 });
    expect(detectInlineScript(seg(`ruby -e 'puts 1; puts 2'`))).toEqual({ interpreter: "ruby -e", statementCount: 2 });
    expect(detectInlineScript(seg(`php -r 'echo 1; echo 2;'`))).toEqual({ interpreter: "php -r", statementCount: 2 });
  });

  it("single-statement script", () => {
    expect(detectInlineScript(seg(`python3 -c "print('hi')"`))).toEqual({ interpreter: "python -c", statementCount: 1 });
  });

  it("heredoc-scripted interpreter counted from heredoc body", () => {
    const info = detectInlineScript(seg("python3 << 'EOF'", [
      { operator: "<<", target: "import os\nos.system('a')", fileDescriptor: undefined, wellKnown: true },
    ]));
    expect(info).toEqual({ interpreter: "python3 (heredoc)", statementCount: 2 });
  });

  it("script with trailing redirect still parsed", () => {
    const info = detectInlineScript(seg(`python3 -c "print(1); print(2); print(3)" > out.txt`));
    expect(info).toEqual({ interpreter: "python -c", statementCount: 3 });
  });

  it("non-interpreter command unaffected", () => {
    expect(detectInlineScript(seg("python3 script.py --verbose"))).toBeNull();
    expect(detectInlineScript(seg("python3 -m venv .venv"))).toBeNull();
    expect(detectInlineScript(seg("echo hello"))).toBeNull();
  });

  it("interpreter without heredoc body unaffected", () => {
    expect(detectInlineScript(seg("python3 - << 'EOF'", [
      { operator: "<<", target: "", fileDescriptor: undefined, wellKnown: true },
    ]))).toBeNull();
  });
});

describe("countScriptStatements", () => {
  it("splits on semicolons and newlines, drops empties", () => {
    expect(countScriptStatements("a; b;\nc;;d")).toBe(4);
    expect(countScriptStatements("")).toBe(0);
    expect(countScriptStatements("  \n ; ")).toBe(0);
  });
});
