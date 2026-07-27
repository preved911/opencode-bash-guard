## 1. Project Setup

- [ ] 1.1 Initialize npm package: `package.json` with name `opencode-bash-guard`, `"type": "module"`, entry point `src/index.ts`
- [ ] 1.2 Add `@opencode-ai/plugin` as dev dependency, `unbash` and `@withfig/autocomplete` as dependencies
- [ ] 1.3 Configure `tsconfig.json` for ES module build targeting Node 18+
- [ ] 1.4 Set up build script outputting to `dist/`
- [ ] 1.5 Add `files` field to `package.json` for `dist/`, `README.md`, `LICENSE`
- [ ] 1.6 Register `tool.execute.before` and `permission.ask` hooks in entry point

## 2. Config Reader

- [ ] 2.1 Register `config` hook to receive the merged Config object at startup
- [ ] 2.2 Parse `permission.bash` — support both flat string and object pattern form
- [ ] 2.3 Parse `external_directory` — support both flat string and object pattern form
- [ ] 2.4 Validate prerequisite: warn and disable if `"bash": "allow"` or `"*": "allow"`
- [ ] 2.5 Implement glob matching for segment vs bash permission patterns (last matching rule wins)
- [ ] 2.6 Implement path pattern matching for external_directory (`.gitignore`-style)
- [ ] 2.7 Write unit tests for all scenarios in `specs/config-reader/spec.md`

## 3. Chain Detection

- [ ] 3.1 Integrate `unbash` to parse full command string into AST
- [ ] 3.2 Extract top-level commands from AST as chain segments (split on `&&`, `||`, `;`, `|`)
- [ ] 3.3 Recursively walk AST to extract commands from `$()` and backtick substitutions
- [ ] 3.4 Recognize `eval`, `sh -c`, `bash -c`, `zsh -c` meta-commands; recursively parse their string arguments as command strings
- [ ] 3.5 Handle parse errors gracefully (collect errors, return partial result)
- [ ] 3.6 Write unit tests for all scenarios in `specs/chain-detection/spec.md`

## 4. Path Extraction

- [ ] 4.1 Walk `unbash` AST to extract word-type arguments from each segment
- [ ] 4.2 Load `@withfig/autocomplete` spec for the command name
- [ ] 4.3 Use Fig spec to distinguish flags from path arguments; fallback to heuristic (skip `-*`)
- [ ] 4.4 Resolve paths to absolute: relative against cwd, `~` via homedir
- [ ] 4.5 Write unit tests for all scenarios in `specs/path-extraction/spec.md`

## 5. Enforcement

- [ ] 5.1 Implement segment resolution: bash permission check → external_directory check → chain check
- [ ] 5.2 Implement most-restrictive-wins aggregation: deny > ask > no action
- [ ] 5.3 In `tool.execute.before`: wrap ask/deny chains in `{ ... ; }`, store per `callID`
- [ ] 5.4 In `permission.ask`: lookup `callID`, set `output.status = "deny"` for deny, do nothing for ask
- [ ] 5.5 Handle edge cases: empty command, whitespace-only, parse errors
- [ ] 5.6 Write unit tests for all scenarios in `specs/enforcement/spec.md`

## 6. Documentation

- [ ] 6.1 Write `README.md`: install, prerequisite (`"*": "ask"`), how it works
- [ ] 6.2 Document how the plugin reads existing opencode config (no custom rules)
- [ ] 6.3 Document known limitations

## 7. Publishing

- [ ] 7.1 Publish to npm
- [ ] 7.2 Verify plugin loads in opencode
- [ ] 7.3 Submit to opencode.cafe

## 8. Verification

- [ ] 8.1 Run full test suite
- [ ] 8.2 Manual test: `git status` (single, allow → should run)
- [ ] 8.3 Manual test: `git status && git log` (all allowed → should run without prompt)
- [ ] 8.4 Manual test: `sudo rm -rf /` (deny → should block)
- [ ] 8.5 Manual test: `cat /etc/passwd` (external_directory violation → should ask)
- [ ] 8.6 Manual test: `git status && sudo rm -rf /` (deny in chain → whole chain denied)
