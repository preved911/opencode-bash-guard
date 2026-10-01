## 1. Config File Reader & Schema (`src/config.ts`)

- [ ] 1.1 Add `opencode-bash-guard.jsonc` reader: discover project `.opencode/opencode-bash-guard.jsonc` and global `~/.config/opencode/opencode-bash-guard.jsonc` (`input.directory` gives project root), parse with `jsonc-parser`, deep-merge (project wins, scalars override); invalid JSONC → warning + degraded mode (args absent, glob allows suspended, every segment asks)
- [ ] 1.2 Add types: `ArgMatcher` (`token?`, `position?: number | "all"`, `pattern?`, `valuePattern?`, `action`, `args?`), `ToolPermissionEntry { tool: string; args: ArgMatcher[] }`, extend `PluginConfig` with `toolPermissions: ToolPermissionEntry[]`
- [ ] 1.3 Validate entries: non-empty `tool`; exactly one of `token` or `position`+`pattern` per matcher (`position` is a non-negative number or the literal `"all"`); required `action` ∈ {allow, ask, deny}; `valuePattern`/nested `args` only with `token`; drop invalid entries with a per-entry warning
- [ ] 1.4 Write unit tests for all parsing scenarios in `specs/args-permission-matching/spec.md` (valid parse, invalid dropped, section absent, broken file)

## 2. Arg Matcher Engine (`src/config.ts`)

- [ ] 2.1 Implement quote-aware argv tokenization: derive tokens from the unbash AST words (matched quote pairs stripped, quoted whitespace kept within a token); whitespace-split fallback only for commands that already failed the chain parse (fail closed); walk tokens after the command name; `token` = exact case-sensitive match on an unconsumed token (consumes it), with clustered short flags expanded (`-f` matches `-rf`); `valuePattern` = glob the following token (consumes it on match); `valuePattern` matchers match only via exact token equality — no cluster expansion, no value consumption from a cluster match
- [ ] 2.2 Implement `position`+`pattern` matcher: index over the **positional** tokens after the tool name (non-`-` tokens in command order; flags never occupy a slot, dash-less flag values do — heuristic), glob semantics as in `matchPathAgainstPattern` (`*`, `**`); plus `position: "all"` — candidate set is every remaining unconsumed non-`-` token, quantifier derived from action (allow: all must glob-match, one mismatch or zero candidates → no match; ask/deny: one glob-match is enough, zero candidates → no match); token matchers consume before position matchers evaluate
- [ ] 2.3 Implement nested matching: evaluate nested `args` on remaining unconsumed tokens after the parent `token` matched; consumed tokens invisible to shallower levels
- [ ] 2.4 Implement `matchToolPermissions(segment, entries)` returning `{ action } | null` — collect all matched matchers across entries for the tool, return most restrictive (deny > ask > allow), null when none matched
- [ ] 2.5 Write unit tests for matcher scenarios: flag anywhere, flag absent, positional match/mismatch, all-position allow all-match/one-mismatch/no-candidates/flag-skip/combines-with-token-matcher, all-position deny/ask one-match/no-matching-candidate/no-candidates, valuePattern match/mismatch, nested match, nested requires parent, consumed-token no-rematch, quoted-flag bypass (`git push "--force"`), clustered `-rf` matches `-f`, valuePattern skips cluster expansion, key=value tokens are ordinary candidates, ask>allow, deny>ask, single match, no match

## 3. Resolution Integration (`src/enforce.ts`)

- [ ] 3.1 Extend `resolveSegment`: check `matchToolPermissions` first; fall back to `matchBashPermission` (unchanged); then external_directory checks (merge most-restrictive within segment)
- [ ] 3.2 Track whether the segment's allow originated from an args rule (propagate `allowFromArgsRule` through `resolveSegment` → `resolveChain` → `beforeExecute`)
- [ ] 3.3 Extend `StoredDecision` to represent `allow`; in `beforeExecute`, store `allow` only when chain action is `allow` AND at least one segment's allow came from an args rule (no wrap); glob-only allows keep no-store/no-wrap
- [ ] 3.4 Verify chain aggregation unchanged: deny > ask > allow across segments including args-level actions
- [ ] 3.5 Write unit tests for pipeline scenarios: args allow overrides native ask, unmatched falls to glob, glob-only allow untouched, args ask wraps, args deny blocks, mixed chain asks, all-allow args chain force-allows, one-ask-segment asks the chain

## 4. Enforcement (`src/index.ts`)

- [ ] 4.1 Extend `handlePermissionAsk`: stored `allow` → `output.status = "allow"`; stored `ask`/`deny` unchanged; no stored decision → no opinion
- [ ] 4.2 Confirm `permission.ask` clears the stored decision after apply (no stale overrides)
- [ ] 4.3 Write unit tests: stored allow suppresses native prompt; no decision leaves native flow untouched; stale-decision clearing

## 5. Documentation

- [ ] 5.1 README: new "Flag-level permissions" section — two-level model (opencode.json = coarse globs; `opencode-bash-guard.jsonc` = args refinement), full config example (curl `-X GET` allow, find `-delete` ask + work-path allow, cp all-paths allow via `position: "all"`, git `push --force` deny via nesting)
- [ ] 5.2 README: document matcher fields (`tool`, `token`, `position`+`pattern` including `"all"` and its action-derived quantifier, `valuePattern`, `action`, nested `args`), most-restrictive-wins, and the check pipeline (args level → permission block level → native checks)
- [ ] 5.3 README known limitations: tokens starting with `-` are never `"all"` candidates (negative numbers, files named `-myfile`); flag values of unconsumed flags stay in the `"all"` candidate set (errs toward restriction; fig-spec-driven value awareness is future work); case-sensitive matching; overlapping args matchers collapse to the strictest action; broken config degrades to ask-everything

## 6. Verification

- [ ] 6.1 `npm test` — full suite green including new tests
- [ ] 6.2 `npm run build` — type-check passes
- [ ] 6.3 Manual: `curl -X GET https://api.com` with args allow + native `"*": "ask"` → runs without prompt
- [ ] 6.4 Manual: `curl -X POST https://api.com` → native ask dialog appears (glob level)
- [ ] 6.5 Manual: `find /Users/me/work/logs -type f` → allowed; `find /Users/me/work/logs -delete` → ask; `find /tmp -delete` → ask
- [ ] 6.6 Manual: `git push --force origin main` with nested deny → blocked; `git push origin main` → allowed via glob `"git *": "allow"`
- [ ] 6.7 Manual: `cp /Users/me/work/a /Users/me/work/b` with `position: "all"` allow → runs without prompt; `cp /Users/me/work/a /tmp/b` → ask (glob level)
- [ ] 6.8 Manual: no `opencode-bash-guard.jsonc` → behavior identical to previous release
- [ ] 6.9 Manual: `opencode-bash-guard.jsonc` with syntax error → warning + degraded mode (every bash command asks, including glob-allowed ones) until the file is fixed
