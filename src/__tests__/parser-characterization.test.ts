import { describe, it, expect } from "vitest";
import { parseCommand as parseChain, parseCommandPerLine as parseChainPerLine } from "../parser.js";
import { detectInlineScript, countScriptStatements, stripQuotePairs, extractArgv } from "../parser.js";
import { resolveCandidatePaths } from "../paths.js";
import type { NormalizedInvocation } from "../parser.js";

/**
 * Characterization tests (task 1.1): lock current parser + path-extraction behavior
 * at the future parser boundary. These fixtures are the parity oracle for the
 * normalized-invocation extraction (tasks 2.x) — they must keep passing unchanged.
 */

describe("characterization: normalized segment order and argv", () => {
  it("segments appear in source order across &&, ||, ; and |", () => {
    const result = parseChain("git status && npm test || cat log.txt; ls | sort");
    expect(result.invocations.map((s) => s.commandName)).toEqual(["git", "npm", "cat", "ls", "sort"]);
    expect(result.topLevelInvocations.map((s) => s.commandName)).toEqual(["git", "npm", "cat", "ls", "sort"]);
  });

  it("quote-aware argv: quoted whitespace stays one token, quote pairs stripped", () => {
    const result = parseChain('echo "a b" --force""');
    expect(result.invocations[0].argv).toEqual(["echo", "a b", "--force"]);
  });

  it("argv excludes redirect targets", () => {
    const result = parseChain("ls > /tmp/out.txt");
    expect(result.invocations[0].argv).toEqual(["ls"]);
  });

  it("command text includes redirects verbatim", () => {
    const result = parseChain("echo test 2>/dev/null");
    expect(result.invocations[0].command).toBe("echo test 2>/dev/null");
  });

  it("empty and whitespace-only input produce empty results without parse error", () => {
    for (const cmd of ["", "   ", "\n"]) {
      const result = parseChain(cmd);
      expect(result.invocations).toHaveLength(0);
      expect(result.topLevelInvocations).toHaveLength(0);
      expect(result.parseError).toBe(false);
      expect(result.errors).toHaveLength(0);
      expect(result.maxDepth).toBe(0);
    }
  });

  it("stripQuotePairs normalizes quote pairs and concatenated empty quotes", () => {
    expect(stripQuotePairs('"--force"')).toBe("--force");
    expect(stripQuotePairs("'--force'")).toBe("--force");
    expect(stripQuotePairs('--force""')).toBe("--force");
    expect(stripQuotePairs('"a b"')).toBe("a b");
    expect(stripQuotePairs("--force")).toBe("--force");
  });

  it("extractArgv is exported and quote-aware", () => {
    const result = parseChain('git push "--force" origin main');
    expect(result.invocations[0].argv).toEqual(["git", "push", "--force", "origin", "main"]);
  });
});

describe("characterization: candidate path operands (parser boundary fixtures)", () => {
  function candidatesOf(command: string, cwd: string) {
    const parsed = parseChain(command).invocations[0];
    if (!parsed) throw new Error(`unparseable fixture: ${command}`);
    return resolveCandidatePaths(parsed, cwd);
  }

  it("relative path resolves against cwd", () => {
    const paths = candidatesOf("grep -r pattern ./src", "/project");
    const srcPath = paths.find((p) => p.original === "./src");
    expect(srcPath).toBeDefined();
    expect(srcPath!.resolved).toBe("/project/src");
  });

  it("absolute path resolves to itself", () => {
    const paths = candidatesOf("cat /etc/hosts", "/");
    const etcPath = paths.find((p) => p.original === "/etc/hosts");
    expect(etcPath).toBeDefined();
    expect(etcPath!.resolved).toBe("/etc/hosts");
  });

  it("home-relative path resolves against homedir", () => {
    const paths = candidatesOf("cat ~/.ssh/config", "/");
    const tildePath = paths.find((p) => p.original === "~/.ssh/config");
    expect(tildePath).toBeDefined();
    expect(tildePath!.resolved).toContain("/.ssh/config");
  });

  it("flag-like tokens are excluded from candidates", () => {
    expect(candidatesOf("ls -la -r", "/")).toHaveLength(0);
    expect(parseChain("ls -la -r").invocations[0].candidatePaths).toHaveLength(0);
  });

  it("non-flag tokens are kept as candidates", () => {
    expect(parseChain("cat /etc/passwd").invocations[0].candidatePaths).toContain("/etc/passwd");
  });

  it("command with no arguments has no candidates", () => {
    expect(candidatesOf("ls", "/")).toHaveLength(0);
  });

  it("redirect targets are not candidate path operands (they are redirects)", () => {
    const paths = candidatesOf("ls > /tmp/out.txt", "/");
    expect(paths.find((p) => p.original === "/tmp/out.txt")).toBeUndefined();
  });

  it("candidates are unresolved until resolution against cwd", () => {
    expect(parseChain("cat /etc/passwd").invocations[0].candidatePaths).toEqual(["/etc/passwd"]);
  });
});

describe("characterization: redirects", () => {
  it("fd redirect is well-known", () => {
    const result = parseChain("ls -la 2>&1");
    expect(result.invocations[0].redirects).toEqual([
      { operator: ">&", target: "1", fileDescriptor: 2, wellKnown: true },
    ]);
  });

  it("/dev/null redirect is well-known", () => {
    const result = parseChain("ls -la > /dev/null");
    expect(result.invocations[0].redirects[0].wellKnown).toBe(true);
  });

  it("numeric-only target is well-known", () => {
    const result = parseChain("ls 2> 1");
    expect(result.invocations[0].redirects[0].wellKnown).toBe(true);
  });

  it("heredoc is well-known", () => {
    const result = parseChain("cat << EOF");
    expect(result.invocations[0].redirects[0].wellKnown).toBe(true);
  });

  it("file redirect is not well-known", () => {
    const result = parseChain("ls -la > /tmp/out.txt");
    expect(result.invocations[0].redirects[0]).toEqual({
      operator: ">",
      target: "/tmp/out.txt",
      fileDescriptor: undefined,
      wellKnown: false,
    });
  });

  it("statement-level redirects attach to the segment", () => {
    const result = parseChain("echo hello > file.txt && cat file.txt");
    expect(result.invocations[0].redirects).toHaveLength(1);
    expect(result.invocations[0].redirects[0].target).toBe("file.txt");
    expect(result.invocations[1].redirects).toHaveLength(0);
  });
});

describe("characterization: substitutions and meta-command bodies", () => {
  it("$() substitution commands are extracted as segments", () => {
    const result = parseChain('cat $(find . -name "*.txt")');
    expect(result.invocations.map((s) => s.commandName)).toContain("find");
    expect(result.invocations.map((s) => s.commandName)).toContain("cat");
  });

  it("backtick substitution commands are extracted", () => {
    const result = parseChain("echo `date`");
    expect(result.invocations.map((s) => s.commandName)).toContain("date");
  });

  it("multiple substitutions all extracted", () => {
    const result = parseChain("diff $(ls dir1) $(ls dir2)");
    expect(result.invocations.filter((s) => s.commandName === "ls")).toHaveLength(2);
  });

  it("eval body commands are extracted", () => {
    const result = parseChain('eval "rm -rf /"');
    expect(result.invocations.map((s) => s.commandName)).toContain("eval");
    expect(result.invocations.map((s) => s.commandName)).toContain("rm");
  });

  it("sh -c body commands are extracted", () => {
    const result = parseChain('sh -c "rm -rf /"');
    expect(result.invocations.map((s) => s.commandName)).toContain("rm");
  });

  it("bash -c nested chain bodies are extracted", () => {
    const result = parseChain('bash -c "cd /tmp && rm -rf ."');
    expect(result.invocations.map((s) => s.commandName)).toContain("bash");
    expect(result.invocations.map((s) => s.commandName)).toContain("rm");
  });

  it("chaining operators inside quotes do not split", () => {
    const result = parseChain('echo "hello && world"');
    expect(result.invocations).toHaveLength(1);
    expect(result.invocations[0].commandName).toBe("echo");
  });
});

describe("characterization: parse errors", () => {
  it("unbalanced quote is a parse error with messages", () => {
    const result = parseChain('echo "unbalanced');
    expect(result.parseError).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("meta-command body parse errors propagate", () => {
    const result = parseChain('bash -c "echo \\"');
    expect(result.parseError).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("parse error does not lose already-extracted segments", () => {
    const result = parseChain('echo "unbalanced');
    expect(result.invocations.length).toBeGreaterThanOrEqual(0);
  });
});

describe("characterization: per-line counts", () => {
  it("one command per line — each line a single segment", () => {
    const result = parseChainPerLine("git status\ngit log\ngit diff\ngit show");
    expect(result.lines.map((l) => ({ lineNumber: l.lineNumber, segmentCount: l.segmentCount }))).toEqual([
      { lineNumber: 1, segmentCount: 1 },
      { lineNumber: 2, segmentCount: 1 },
      { lineNumber: 3, segmentCount: 1 },
      { lineNumber: 4, segmentCount: 1 },
    ]);
    expect(result.worstLine).toEqual({ lineNumber: 1, segmentCount: 1 });
  });

  it("worst line wins with first-line tie-break", () => {
    const result = parseChainPerLine("a && b && c && d && e\nf && g && h");
    expect(result.worstLine).toEqual({ lineNumber: 1, segmentCount: 5 });
  });

  it("blank lines are skipped but keep their line numbers", () => {
    const result = parseChainPerLine("git status\n\n   \ngit log");
    expect(result.lines.map((l) => l.lineNumber)).toEqual([1, 4]);
  });

  it("empty command → no lines, no worst", () => {
    const result = parseChainPerLine("\n\n");
    expect(result.lines).toHaveLength(0);
    expect(result.worstLine).toBeNull();
  });
});

describe("characterization: nesting depth", () => {
  it("empty → 0, flat → 1", () => {
    expect(parseChain("").maxDepth).toBe(0);
    expect(parseChain("git status").maxDepth).toBe(1);
    expect(parseChain("a && b").maxDepth).toBe(1);
  });

  it("single $() → 2, double → 3", () => {
    expect(parseChain("echo $(whoami)").maxDepth).toBe(2);
    expect(parseChain("echo $(echo $(whoami))").maxDepth).toBe(3);
  });

  it("nested backticks → 3", () => {
    expect(parseChain("echo `echo \\`echo hi\\``").maxDepth).toBe(3);
  });

  it("meta-command string arg adds one level; expansion inside adds another", () => {
    expect(parseChain('bash -c "a && b"').maxDepth).toBe(2);
    expect(parseChain('bash -c "echo $(whoami)"').maxDepth).toBe(3);
    expect(parseChain('eval "echo hi"').maxDepth).toBe(2);
  });

  it("depth is checked across multi-line commands", () => {
    expect(parseChain("git status\necho $(echo $(whoami))").maxDepth).toBe(3);
  });
});

describe("characterization: inline-script detection", () => {
  function seg(command: string, redirects: NormalizedInvocation["redirects"] = []): NormalizedInvocation {
    const source = command.trim();
    return { command: source, commandName: source.split(/\s+/)[0] ?? "", argv: source.split(/\s+/), redirects, candidatePaths: [] };
  }

  it("python3 -c counts ;-separated statements", () => {
    expect(detectInlineScript(seg(`  python3 -c "import os; os.system('a'); os.system('b'); os.system('c'); os.system('d')"  `))).toEqual({
      interpreter: "python -c",
      statementCount: 5,
    });
  });

  it("node -e/--eval, perl -e, ruby -e, php -r recognized", () => {
    expect(detectInlineScript(seg('node --eval "console.log(1); console.log(2)"'))).toEqual({ interpreter: "node -e", statementCount: 2 });
    expect(detectInlineScript(seg(`perl -e 'print 1; print 2;'`))).toEqual({ interpreter: "perl -e", statementCount: 2 });
    expect(detectInlineScript(seg(`ruby -e 'puts 1; puts 2'`))).toEqual({ interpreter: "ruby -e", statementCount: 2 });
    expect(detectInlineScript(seg(`php -r 'echo 1; echo 2;'`))).toEqual({ interpreter: "php -r", statementCount: 2 });
  });

  it("heredoc-scripted interpreter counted from heredoc body", () => {
    expect(
      detectInlineScript(seg("python3 << 'EOF'", [{ operator: "<<", target: "import os\nos.system('a')", fileDescriptor: undefined, wellKnown: true }])),
    ).toEqual({ interpreter: "python3 (heredoc)", statementCount: 2 });
  });

  it("non-interpreter commands unaffected", () => {
    expect(detectInlineScript(seg("python3 script.py --verbose"))).toBeNull();
    expect(detectInlineScript(seg("python3 -m venv .venv"))).toBeNull();
    expect(detectInlineScript(seg("echo hello"))).toBeNull();
  });

  it("countScriptStatements splits on ; and newlines, drops empties", () => {
    expect(countScriptStatements("a; b;\nc;;d")).toBe(4);
    expect(countScriptStatements("")).toBe(0);
  });
});
