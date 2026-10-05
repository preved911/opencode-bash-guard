import { describe, it, expect } from "vitest";
import { parseCommand as parseChain, parseCommandPerLine as parseChainPerLine } from "../parser.js";
import { detectInlineScript, countScriptStatements, stripQuotePairs, extractArgv } from "../parser.js";
import { resolveCandidatePaths } from "../paths.js";
import type { NormalizedInvocation } from "../parser.js";

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
    expect(extractArgv).toBeTypeOf("function");
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
    expect(srcPath?.resolved).toBe("/project/src");
  });

  it("absolute path resolves to itself", () => {
    const paths = candidatesOf("cat /etc/hosts", "/");
    const etcPath = paths.find((p) => p.original === "/etc/hosts");
    expect(etcPath).toBeDefined();
    expect(etcPath?.resolved).toBe("/etc/hosts");
  });

  it("home-relative path resolves against homedir", () => {
    const paths = candidatesOf("cat ~/.ssh/config", "/");
    const tildePath = paths.find((p) => p.original === "~/.ssh/config");
    expect(tildePath).toBeDefined();
    expect(tildePath?.resolved).toContain("/.ssh/config");
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

  it("keeps raw spelling while statically decoding quoted candidate paths", () => {
    const result = parseChain('cat "dir with spaces/file.txt"');
    expect(result.invocations[0].candidatePaths).toEqual(["dir with spaces/file.txt"]);
    expect(result.invocations[0].candidatePathDetails).toEqual([
      { raw: '"dir with spaces/file.txt"', value: "dir with spaces/file.txt" },
    ]);
    expect(result.parseError).toBe(false);
  });

  it("does not turn a wholly dynamic candidate path into a cwd-relative string", () => {
    const result = parseChain('cat "$TARGET"');
    expect(result.invocations[0].candidatePaths).toEqual([]);
    expect(result.invocations[0].candidatePathDetails).toEqual([{ raw: '"$TARGET"', value: null }]);
    expect(result.parseError).toBe(false);
  });

  it("statically decodes concatenated quoting in executable argv", () => {
    const result = parseChain('ec"ho" ok');
    expect(result.invocations[0].commandName).toBe("echo");
    expect(result.invocations[0].argv).toEqual(["echo", "ok"]);
  });
});

describe("characterization: redirects", () => {
  it("fd redirect is well-known", () => {
    const result = parseChain("ls -la 2>&1");
    expect(result.invocations[0].redirects).toEqual([
      {
        operator: ">&",
        target: "1",
        fileDescriptor: 2,
        wellKnown: true,
        rawTarget: "1",
        targetValue: "1",
        heredocBody: null,
      },
    ]);
  });

  it("/dev/null redirect is well-known", () => {
    const result = parseChain("ls -la > /dev/null");
    expect(result.invocations[0].redirects[0].wellKnown).toBe(true);
  });

  it("numeric file target is not confused with descriptor duplication", () => {
    const result = parseChain("ls 2> 1");
    expect(result.invocations[0].redirects[0].wellKnown).toBe(false);
  });

  it("keeps a heredoc delimiter separate from its executable body", () => {
    const result = parseChain("python3 <<'EOF'\nprint('one')\nprint('two')\nEOF");
    const redirect = result.invocations[0]?.redirects[0];
    expect(redirect).toMatchObject({
      operator: "<<",
      target: "EOF",
      rawTarget: "'EOF'",
      targetValue: "EOF",
      wellKnown: true,
    });
    expect(redirect?.heredocBody).toContain("print('one')");
    expect(detectInlineScript(result.invocations[0])).toEqual({
      interpreter: "python3 (heredoc)",
      statementCount: 2,
    });
  });

  it("file redirect is not well-known", () => {
    const result = parseChain("ls -la > /tmp/out.txt");
    expect(result.invocations[0].redirects[0]).toEqual({
      operator: ">",
      target: "/tmp/out.txt",
      fileDescriptor: undefined,
      wellKnown: false,
      rawTarget: "/tmp/out.txt",
      targetValue: "/tmp/out.txt",
      heredocBody: null,
    });
  });

  it("retains raw redirect spelling and exposes its decoded static target", () => {
    const result = parseChain('echo ok > "file name.txt"');
    expect(result.invocations[0].redirects[0]).toMatchObject({
      target: "file name.txt",
      rawTarget: '"file name.txt"',
      targetValue: "file name.txt",
      wellKnown: false,
    });
    expect(result.parseError).toBe(false);
  });

  it("fails closed for a wholly dynamic redirect target", () => {
    const result = parseChain('echo ok > "$OUTPUT"');
    expect(result.invocations[0].redirects[0]).toMatchObject({
      rawTarget: '"$OUTPUT"',
      targetValue: null,
      wellKnown: false,
    });
    expect(result.parseError).toBe(false);
  });

  it("treats descriptor close as well-known only for descriptor redirects", () => {
    expect(parseChain("echo ok 2>&-").invocations[0].redirects[0].wellKnown).toBe(true);
    expect(parseChain("echo ok 2>-").invocations[0].redirects[0].wellKnown).toBe(false);
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

  it("keeps stable preorder and preserves separate identical source occurrences", () => {
    const result = parseChain('echo "$(touch /tmp/same)"; echo "$(touch /tmp/same)"');
    expect(result.invocations.map((segment) => segment.commandName)).toEqual(["echo", "touch", "echo", "touch"]);
    expect(result.topLevelInvocations.map((segment) => segment.commandName)).toEqual(["echo", "echo"]);
    expect(result.invocations.filter((segment) => segment.command === "touch /tmp/same")).toHaveLength(2);
  });

  it("recursively extracts substitutions nested inside quoted substitutions", () => {
    const result = parseChain('VALUE="$(VALUE="$(touch /tmp/obg-bypass)" git status)" git status');
    expect(result.invocations.map((segment) => segment.commandName)).toEqual(["git", "git", "touch"]);
    expect(result.parseError).toBe(false);
  });

  it("recursively extracts substitutions inside a meta-command body", () => {
    const result = parseChain(`bash -c 'VALUE="$(touch /tmp/obg-bypass)" git status'`);
    expect(result.invocations.map((segment) => segment.commandName)).toEqual(["bash", "git", "touch"]);
    expect(result.parseError).toBe(false);
  });

  it("visits a static meta-command body exactly once", () => {
    const result = parseChain(`bash -c 'VALUE="$(touch /tmp/meta-once)" echo'`);
    expect(result.invocations.map((segment) => segment.commandName)).toEqual(["bash", "echo", "touch"]);
    expect(result.invocations.filter((segment) => segment.command === "touch /tmp/meta-once")).toHaveLength(1);
    expect(result.parseError).toBe(false);
  });

  it("recursively extracts mixed dollar and backtick substitutions", () => {
    const result = parseChain('VALUE="$(INNER=`touch /tmp/obg-bypass` echo)" echo');
    expect(result.invocations.map((segment) => segment.commandName)).toEqual(["echo", "echo", "touch"]);
    expect(result.parseError).toBe(false);
  });

  it("recursively extracts nested eval bodies", () => {
    const result = parseChain(`eval 'eval "touch /tmp/obg-bypass"'`);
    expect(result.invocations.map((segment) => segment.commandName)).toEqual(["eval", "eval", "touch"]);
    expect(result.parseError).toBe(false);
  });

  it("recursively extracts nested shell -c bodies", () => {
    const result = parseChain(`bash -c 'sh -c "touch /tmp/obg-bypass"'`);
    expect(result.invocations.map((segment) => segment.commandName)).toEqual(["bash", "sh", "touch"]);
    expect(result.parseError).toBe(false);
  });

  it("accepts exactly 64 command-context levels", () => {
    let command = "touch /tmp/depth-boundary";
    for (let depth = 1; depth < 64; depth++) command = `VALUE=$(${command}) echo`;

    const result = parseChain(command);
    expect(result.parseError).toBe(false);
    expect(result.maxDepth).toBe(64);
    expect(result.invocations).toHaveLength(64);
  });

  it("fails closed at exactly 65 command-context levels", () => {
    let command = "touch /tmp/depth-boundary";
    for (let depth = 1; depth < 65; depth++) command = `VALUE=$(${command}) echo`;

    const result = parseChain(command);
    expect(result.parseError).toBe(true);
    expect(result.maxDepth).toBe(65);
    expect(result.errors).toContain("Shell command traversal exceeds the supported depth or invocation limit");
  });

  it("accepts exactly 1024 invocations", () => {
    const result = parseChain(Array.from({ length: 1024 }, (_, index) => `echo ${index}`).join("; "));
    expect(result.parseError).toBe(false);
    expect(result.invocations).toHaveLength(1024);
    expect(result.invocations[0].command).toBe("echo 0");
    expect(result.invocations[1023].command).toBe("echo 1023");
  });

  it("fails closed before emitting invocation 1025", () => {
    const result = parseChain(Array.from({ length: 1025 }, (_, index) => `echo ${index}`).join("; "));
    expect(result.parseError).toBe(true);
    expect(result.invocations).toHaveLength(1024);
    expect(result.errors).toContain("Shell command traversal exceeds the supported depth or invocation limit");
  });

  it("accepts exactly the structural-depth budget", () => {
    const groups = "(".repeat(508);
    const closings = ")".repeat(508);
    const result = parseChain(`(( ${groups}1${closings} ))`);
    expect(result.parseError).toBe(false);
  });

  it("fails closed one level beyond the structural-depth budget", () => {
    const groups = "(".repeat(509);
    const closings = ")".repeat(509);
    const result = parseChain(`(( ${groups}1${closings} ))`);
    expect(result.parseError).toBe(true);
    expect(result.errors).toContain("Shell AST traversal exceeds the supported structural depth limit");
  });

  it("accepts exactly the visited-value budget", () => {
    const argumentsText = Array.from({ length: 8186 }, (_, index) => `path-${index}`).join(" ");
    const result = parseChain(`echo ${argumentsText} > out`);
    expect(result.parseError).toBe(false);
    expect(result.invocations).toHaveLength(1);
  });

  it("fails closed at the first value beyond the visited-value budget", () => {
    const argumentsText = Array.from({ length: 8187 }, (_, index) => `path-${index}`).join(" ");
    const result = parseChain(`echo ${argumentsText} > out`);
    expect(result.parseError).toBe(true);
    expect(result.errors).toContain("Shell AST traversal exceeds the supported visited value limit");
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

  it("extracts direct static eval and supported shell -c bodies", () => {
    const staticEval = parseChain("eval touch /tmp/static-eval");
    expect(staticEval.invocations.map((segment) => segment.commandName)).toEqual(["eval", "touch"]);
    expect(staticEval.parseError).toBe(false);

    for (const shell of [
      { command: "sh -c", name: "sh" },
      { command: "bash -lc", name: "bash" },
      { command: "zsh -c", name: "zsh" },
      { command: "ksh -c", name: "ksh" },
    ]) {
      const result = parseChain(`${shell.command} 'touch /tmp/static-shell'`);
      expect(result.invocations.map((segment) => segment.commandName)).toEqual([shell.name, "touch"]);
      expect(result.parseError).toBe(false);
    }
  });

  it("treats a leading eval -- as an option terminator, not body text", () => {
    const result = parseChain("eval -- 'touch /tmp/eval-terminator'");
    expect(result.invocations.map((segment) => segment.commandName)).toEqual(["eval", "touch"]);
    expect(result.parseError).toBe(false);
  });

  it("recognizes shell basenames and dash", () => {
    for (const shell of ["/bin/sh", "/usr/bin/dash"]) {
      const result = parseChain(`${shell} -c 'touch /tmp/shell-basename'`);
      expect(result.invocations.map((segment) => segment.commandName)).toEqual([shell, "touch"]);
      expect(result.parseError).toBe(false);
    }
  });

  it("skips shell options with operands before locating -c", () => {
    const result = parseChain("bash -o posix --rcfile /tmp/bashrc -c 'touch /tmp/option-scan'");
    expect(result.invocations.map((segment) => segment.commandName)).toEqual(["bash", "touch"]);
    expect(result.parseError).toBe(false);
  });

  it("stops shell option scanning at -- or the first script operand", () => {
    const terminated = parseChain("sh -- -c 'touch /tmp/not-a-command-body'");
    expect(terminated.invocations.map((segment) => segment.commandName)).toEqual(["sh"]);
    expect(terminated.parseError).toBe(false);

    const scriptOperand = parseChain("/bin/sh script.sh -c 'touch /tmp/not-a-command-body'");
    expect(scriptOperand.invocations.map((segment) => segment.commandName)).toEqual(["/bin/sh"]);
    expect(scriptOperand.parseError).toBe(false);
  });

  it("fails closed for dynamic eval and shell executable bodies", () => {
    const dynamicEval = parseChain(`eval "$(printf 'touch /tmp/from-eval')"`);
    expect(dynamicEval.invocations.map((segment) => segment.commandName)).toEqual(["eval", "printf"]);
    expect(dynamicEval.parseError).toBe(true);
    expect(dynamicEval.errors).toContain("Dynamic eval body is not supported");

    for (const command of ['sh -c "$BODY"', 'bash "$SCRIPT"', 'zsh "$FLAGS" "touch /tmp/ambiguous"', 'ksh -c']) {
      const result = parseChain(command);
      expect(result.parseError).toBe(true);
    }
  });

  it("chaining operators inside quotes do not split", () => {
    const result = parseChain('echo "hello && world"');
    expect(result.invocations).toHaveLength(1);
    expect(result.invocations[0].commandName).toBe("echo");
  });
});

describe("characterization: exhaustive executable AST fields", () => {
  const executableFieldFixtures: readonly {
    readonly field: string;
    readonly command: string;
    readonly expectedNames: readonly string[];
    readonly parseError?: boolean;
  }[] = [
    {
      field: "test unary, binary, logical, not, and group operands",
      command:
        'git status && [[ ! ( "$(touch /tmp/test-left)" == "$(touch /tmp/test-right)" && -n "$(touch /tmp/test-unary)" ) ]]',
      expectedNames: ["git", "touch", "touch", "touch"],
    },
    {
      field: "arithmetic command binary, unary, ternary, and group expressions",
      command:
        "(( ( $(touch /tmp/arithmetic-left) + -$(touch /tmp/arithmetic-unary) ) ? $(touch /tmp/arithmetic-yes) : $(touch /tmp/arithmetic-no) ))",
      expectedNames: ["touch", "touch", "touch", "touch"],
    },
    {
      field: "arithmetic for initialize, test, and update expressions",
      command:
        "for ((i=$(touch /tmp/for-initialize); $(touch /tmp/for-test); i+=$(touch /tmp/for-update))); do echo ok; done",
      expectedNames: ["touch", "touch", "touch", "echo"],
    },
    {
      field: "while clause and body",
      command: "while touch /tmp/while-clause; do echo body; done",
      expectedNames: ["touch", "echo"],
    },
    {
      field: "if clause, then branch, and else branch",
      command: "if touch /tmp/if-clause; then touch /tmp/if-then; else touch /tmp/if-else; fi",
      expectedNames: ["touch", "touch", "touch"],
    },
    {
      field: "for wordlist and body",
      command: 'for item in "$(touch /tmp/for-wordlist)"; do echo "$item"; done',
      expectedNames: ["touch", "echo"],
    },
    {
      field: "select wordlist and body",
      command: 'select item in "$(touch /tmp/select-wordlist)"; do echo "$item"; done',
      expectedNames: ["touch", "echo"],
    },
    {
      field: "case subject, pattern, and body",
      command: 'case "$(touch /tmp/case-word)" in "$(touch /tmp/case-pattern)") echo body ;; esac',
      expectedNames: ["touch", "touch", "echo"],
    },
    {
      field: "command redirect target",
      command: 'echo body > "$(touch /tmp/command-redirect)"',
      expectedNames: ["echo", "touch"],
      parseError: true,
    },
    {
      field: "statement owner redirect target",
      command: '{ echo body; } > "$(touch /tmp/statement-redirect)"',
      expectedNames: ["echo", "touch"],
      parseError: true,
    },
    {
      field: "subshell body",
      command: "(touch /tmp/subshell-body)",
      expectedNames: ["touch"],
    },
    {
      field: "function owner redirect target",
      command: 'worker() { echo body; } > "$(touch /tmp/function-redirect)"',
      expectedNames: ["echo", "touch"],
      parseError: true,
    },
    {
      field: "coproc owner redirect target",
      command: 'coproc worker { echo body; } > "$(touch /tmp/coproc-redirect)"',
      expectedNames: ["echo", "touch"],
      parseError: true,
    },
    {
      field: "heredoc redirect body",
      command: "cat <<EOF\n$(touch /tmp/heredoc-body)\nEOF",
      expectedNames: ["cat", "touch"],
    },
    {
      field: "assignment value",
      command: 'VALUE="$(touch /tmp/assignment-value)" echo body',
      expectedNames: ["echo", "touch"],
    },
    {
      field: "assignment array element",
      command: 'VALUES=("$(touch /tmp/assignment-array)") echo body',
      expectedNames: ["echo", "touch"],
    },
    {
      field: "process substitution",
      command: "cat <(touch /tmp/process-substitution)",
      expectedNames: ["cat", "touch"],
      parseError: true,
    },
    {
      field: "arithmetic expansion",
      command: 'echo "$((1 + $(touch /tmp/arithmetic-expansion)))"',
      expectedNames: ["echo", "touch"],
      parseError: true,
    },
    {
      field: "locale string child",
      command: 'echo $"$(touch /tmp/locale-string)"',
      expectedNames: ["echo", "touch"],
      parseError: true,
    },
    {
      field: "parameter operand",
      command: 'echo "${value:-$(touch /tmp/parameter-operand)}"',
      expectedNames: ["echo", "touch"],
      parseError: true,
    },
    {
      field: "parameter slice offset",
      command: 'echo "${value:$(touch /tmp/parameter-offset):1}"',
      expectedNames: ["echo", "touch"],
      parseError: true,
    },
    {
      field: "parameter slice length",
      command: 'echo "${value:0:$(touch /tmp/parameter-length)}"',
      expectedNames: ["echo", "touch"],
      parseError: true,
    },
    {
      field: "parameter replacement pattern",
      command: 'echo "${value/$(touch)/replacement}"',
      expectedNames: ["echo", "touch"],
      parseError: true,
    },
    {
      field: "parameter replacement value",
      command: 'echo "${value/pattern/$(touch)}"',
      expectedNames: ["echo", "touch"],
      parseError: true,
    },
  ];

  for (const fixture of executableFieldFixtures) {
    it(`visits ${fixture.field}`, () => {
      const result = parseChain(fixture.command);
      expect(result.invocations.map((segment) => segment.commandName)).toEqual(fixture.expectedNames);
      expect(result.parseError).toBe(fixture.parseError ?? false);
    });
  }

  it("visits expansions in a command-name word", () => {
    const result = parseChain('"$(touch /tmp/command-name)" argument');
    expect(result.invocations.at(-1)?.commandName).toBe("touch");
    expect(result.parseError).toBe(false);
  });

  it("fails closed for non-empty assignment index strings", () => {
    const result = parseChain("VALUES[$(touch /tmp/assignment-index)]=value echo body");
    expect(result.parseError).toBe(true);
    expect(result.errors).toContain("Unsupported assignment index");
  });

  it("fails closed for opaque parameter and arithmetic indices", () => {
    const parameterIndex = parseChain('echo "${VALUES[$(touch /tmp/parameter-index)]}"');
    expect(parameterIndex.parseError).toBe(true);
    expect(parameterIndex.errors).toContain("Unsupported parameter expansion index");

    const arithmeticIndex = parseChain("(( VALUES[$(touch /tmp/arithmetic-index)] ))");
    expect(arithmeticIndex.parseError).toBe(true);
    expect(arithmeticIndex.errors).toContain("Unsupported opaque arithmetic word");
  });

  it("fails closed when unbash only partially parses arithmetic text", () => {
    const command = parseChain("(( 1 $(touch /tmp/hidden-command) ))");
    expect(command.parseError).toBe(true);
    expect(command.errors).toContain("Unsupported partially parsed arithmetic command body");

    const expansion = parseChain('echo "$((1 $(touch /tmp/hidden-expansion)))"');
    expect(expansion.parseError).toBe(true);
    expect(expansion.errors).toContain("Unsupported partially parsed arithmetic expansion");
  });

  it("fails closed when any arithmetic-for field is only partially parsed", () => {
    const fixtures = [
      {
        command: "for ((i=0 $(touch /tmp/hidden-initialize); i<1; i++)); do echo body; done",
        error: "Unsupported partially parsed arithmetic for initialize field",
      },
      {
        command: "for ((i=0; i<1 $(touch /tmp/hidden-test); i++)); do echo body; done",
        error: "Unsupported partially parsed arithmetic for test field",
      },
      {
        command: "for ((i=0; i<1; i++ $(touch /tmp/hidden-update))); do echo body; done",
        error: "Unsupported partially parsed arithmetic for update field",
      },
    ];

    for (const fixture of fixtures) {
      const result = parseChain(fixture.command);
      expect(result.parseError).toBe(true);
      expect(result.errors).toContain(fixture.error);
    }
  });

  it("fails closed when arithmetic-for source spans cannot be proven", () => {
    const escapedBacktick = "\\`";
    const command = `echo \`for ((i=0; i<1; i++)); do echo ${escapedBacktick}date${escapedBacktick}; done\``;
    const result = parseChain(command);
    expect(result.parseError).toBe(true);
    expect(result.errors).toContain("Unsupported ambiguous arithmetic for fields");
  });

  it("rejects an opaque arithmetic word containing command-substitution syntax", () => {
    const result = parseChain("(( $((1 + $(touch /tmp/opaque-arithmetic))) ))");
    expect(result.parseError).toBe(true);
    expect(result.errors).toContain("Unsupported opaque arithmetic word");
  });

  it("fails closed for opaque extended-glob and brace-expansion strings", () => {
    const extendedGlob = parseChain("echo @(safe|unsafe)");
    expect(extendedGlob.parseError).toBe(true);
    expect(extendedGlob.errors).toContain("Unsupported opaque extended glob pattern");

    const braceExpansion = parseChain("echo {safe,unsafe}");
    expect(braceExpansion.parseError).toBe(true);
    expect(braceExpansion.errors).toContain("Unsupported opaque brace expansion");
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
    expect(parseChain("bash -c 'echo $(whoami)'").maxDepth).toBe(3);
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
