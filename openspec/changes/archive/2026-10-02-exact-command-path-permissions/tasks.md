## 1. Regression Tests

- [x] 1.1 Preserve the flat-matcher regression suite in `src/__tests__/tool-permissions.test.ts`: quoted tokens, short-flag clusters, flag values, positional matching, `position: "all"`, multiple tool entries, args force-allow, glob fallback, and degraded mode. Flat tools (`find`, `grep`) must behave exactly as released.
- [x] 1.2 Add `src/__tests__/plugin-config.test.ts` cases: array `token` parses into a path matcher; omitted `action` normalizes to `ask`; legacy nested `args`, and `pattern` combined with an array `token`, are dropped with a warning naming the entry.

## 2. Configuration Types and Validation

- [x] 2.1 Update raw and normalized matcher types in `src/config.ts`: `token: string | string[]` (non-empty array of strings), `action?: PermissionAction`, no nested `args`; `pattern` stays bound to `position` or a single-string `token`.
- [x] 2.2 Update `validateToolPermissions` in `src/config.ts` to normalize omitted actions to `ask` and drop legacy/invalid entries with a warning naming them.

## 3. Evaluation

- [x] 3.1 Implement independent per-matcher evaluation in `src/config.ts`: string tokens keep released mechanics (exact match, cluster expansion, value consumption); an array token matches order-free — each element consumes a distinct unconsumed token in array order, anywhere in the segment — and trailing tokens never invalidate a match.
- [x] 3.2 Implement overlap resolution in `src/config.ts`: discard matchers refined by another matching matcher (path-prefix extension, or a value-constrained matcher over the same bare token; position matchers never refine), then reduce survivors most-restrictive (`deny` > `ask` > `allow`).
- [x] 3.3 Keep `resolveSegment` and its pipeline in `src/config.ts` unchanged for no-match paths so glob, external-directory, redirect, and degraded-mode behavior remain intact.

## 4. Documentation

- [x] 4.1 Rewrite the `permissions` section of `README.md`: path rules, order-free matching, refinement-then-most-restrictive resolution, omitted `action` defaulting to `ask`, with `git`/`kubectl` examples covering subtree denies, flag exceptions, and global-flag rules.
- [x] 4.2 Add a migration note to `README.md`: flatten nested `args` trees into path arrays; deny rules keep covering unlisted nested paths; allow leaves previously dead under deny-accumulation now act as exceptions.

## 5. Verification

- [x] 5.1 Run the focused `src/__tests__/plugin-config.test.ts` and `src/__tests__/tool-permissions.test.ts` test files and confirm the new and preserved matcher scenarios pass.
- [x] 5.2 Run the full `npm test` suite and `npm run build` TypeScript build successfully.
- [x] 5.3 Run `openspec validate exact-command-path-permissions --strict` and confirm the completed change artifacts validate.
