## 1. Config Parsing (`src/config.ts`)

- [ ] 1.1 Add `ArgsPermissionRule { pattern: string; action: "ask" | "allow" | "deny" }` and extend `PluginConfig` with `bashArgsRules: ArgsPermissionRule[]` and a flag-source marker type for resolved allows
- [ ] 1.2 Parse `permission.bash_args` array in `parseConfig`: preserve order, validate pattern (non-empty string) and action, drop invalid entries with a per-entry warning
- [ ] 1.3 Implement token matcher: whitespace tokenization, `*` matches zero+ tokens (greedy with backtracking), anchored at first token, full pattern consumption, case-sensitive
- [ ] 1.4 Implement `matchArgsPermission(segment, rules)` returning `{ action } | null` — first matching rule wins
- [ ] 1.5 Write unit tests for all parsing scenarios in `specs/args-permission-matching/spec.md`

## 2. Token Matcher Tests (pattern scenarios)

- [ ] 2.1 Test exact flag sequence: `curl -X GET *` vs `curl -X GET https://api.com/data` → match
- [ ] 2.2 Test mid-pattern wildcard: `find * -delete` vs `find /tmp -name "*.log" -delete` → match
- [ ] 2.3 Test missing flag: `find * -delete` vs `find /tmp -name "*.log"` → no match
- [ ] 2.4 Test trailing wildcard zero tokens: `curl -X GET *` vs `curl -X GET` → match
- [ ] 2.5 Test command anchor: `git push --force *` vs `hg push --force` → no match
- [ ] 2.6 Test case sensitivity: `-X GET` vs `-X get` → no match
- [ ] 2.7 Test adjacent flag value: `curl -X GET *` vs `curl -X POST ...` → no match
- [ ] 2.8 Test whitespace normalization (multiple spaces) → match

## 3. Resolution Integration (`src/enforce.ts`)

- [ ] 3.1 Extend `resolveSegment`: check `matchArgsPermission` first, fall back to `matchBashPermission`, then external_directory checks (merge most-restrictive within segment)
- [ ] 3.2 Track whether the segment's allow originated from an args rule (propagate `allowFromArgsRule` through `resolveSegment` → `resolveChain` → `beforeExecute`)
- [ ] 3.3 Extend `StoredDecision` to represent `allow`; in `beforeExecute`, store `allow` only when chain action is `allow` AND at least one segment's allow came from an args rule (no wrap)
- [ ] 3.4 Verify chain aggregation unchanged: deny > ask > allow across segments including args-rule actions
- [ ] 3.5 Write unit tests for resolution-order scenarios in `specs/args-permission-matching/spec.md`

## 4. Enforcement (`src/index.ts`, `src/enforce.ts`)

- [ ] 4.1 Extend `handlePermissionAsk`: stored `allow` → `output.status = "allow"`; stored `ask`/`deny` unchanged; no stored decision → no opinion
- [ ] 4.2 Confirm `permission.ask` clears the stored decision after apply (no stale overrides)
- [ ] 4.3 Write unit tests: native ask suppressed for flag allow, glob-only allow untouched, flag ask prompts, flag deny blocks, mixed chain asks, all-allow flag chain force-allows

## 5. Documentation

- [ ] 5.1 README: new "Flag-level permissions" section — config example (`curl -X GET *` → allow, `curl *` → ask, `find * -delete` → ask, `git push --force *` → deny), ordering convention (specific first, broad last, denies before allows)
- [ ] 5.2 README: document that args rules take precedence over glob rules and flag `allow` overrides a native ask for matched segments
- [ ] 5.3 README known limitations: whitespace tokenization (quoted args split), case-sensitive flag matching

## 6. Verification

- [ ] 6.1 `npm test` — full suite green including new tests
- [ ] 6.2 `npm run build` — type-check passes
- [ ] 6.3 Manual: `curl -X GET https://api.com` with flag allow + native `"curl *": "ask"` → runs without prompt
- [ ] 6.4 Manual: `curl -X POST https://api.com` → native ask dialog appears
- [ ] 6.5 Manual: `find /tmp -name "*.log" -delete` → ask
- [ ] 6.6 Manual: `git push --force origin main` with deny rule → blocked
- [ ] 6.7 Manual: no `bash_args` section → behavior identical to previous release
