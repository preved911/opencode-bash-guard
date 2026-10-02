## 1. Regression Tests

- [ ] 1.1 Add `src/__tests__/plugin-config.test.ts` cases that accept omitted matcher actions at every nesting level, normalize them to `ask`, and still drop entries with explicit invalid actions while warning.
- [ ] 1.2 Add `src/__tests__/tool-permissions.test.ts` cases for exact arbitrary-depth token paths that return the complete leaf action and do not decide on a matched ancestor prefix or unmatched descendant.
- [ ] 1.3 Add `src/__tests__/tool-permissions.test.ts` cases that let an unmatched nested branch fall through to a matching sibling and then to existing bash glob, external-directory, and redirect evaluation when no leaf path matches.
- [ ] 1.4 Add `src/__tests__/tool-permissions.test.ts` cases that prove a branch action does not combine with its selected leaf, while overlapping matching leaves at the same recursion level reduce with local deny-wins precedence.
- [ ] 1.5 Preserve and run regression coverage in `src/__tests__/tool-permissions.test.ts` for quoted tokens, short-flag clusters, flag values, positional matching, `position: "all"`, token consumption, multiple tool entries, args force-allow, glob fallback, and degraded mode.

## 2. Configuration Normalization

- [ ] 2.1 Update raw and normalized matcher types in `src/config.ts` so config input may omit `action` but evaluated matchers always have a valid `PermissionAction`.
- [ ] 2.2 Refactor `validateToolPermissions` in `src/config.ts` to recursively normalize accepted matcher trees, default each omitted action to `ask`, and retain warning-and-drop handling for invalid entries.

## 3. Exact Path Evaluation

- [ ] 3.1 Refactor recursive matcher evaluation in `src/config.ts` to return one local leaf-path result or no result instead of appending ancestor and descendant actions to a shared accumulator.
- [ ] 3.2 Make branch matchers in `src/config.ts` consume their selector in a copied matcher state, recurse into children, and return only a selected child result, leaving unmatched branches without a decision.
- [ ] 3.3 Reduce only matching sibling results at each recursion level in `src/config.ts` with existing deny, ask, allow precedence, then preserve top-level tool-entry aggregation behavior.
- [ ] 3.4 Keep `resolveSegment` and its existing permission pipeline in `src/config.ts` unchanged for no-result paths so glob, external-directory, redirect, and degraded-mode behavior remain intact.

## 4. Documentation

- [ ] 4.1 Update the `permissions` configuration examples in `README.md` to show explicit nested leaf actions, arbitrary-depth exact paths, and omitted actions defaulting to `ask`.
- [ ] 4.2 Document in `README.md` that nested branch actions do not inherit to prefixes or descendants, same-level alternatives use deny-wins precedence, and users must expand prior ancestor policies into explicit leaves.

## 5. Verification

- [ ] 5.1 Run the focused `src/__tests__/plugin-config.test.ts` and `src/__tests__/tool-permissions.test.ts` test files and confirm the new and preserved matcher scenarios pass.
- [ ] 5.2 Run the full `npm test` suite and `npm run build` TypeScript build successfully.
- [ ] 5.3 Run `openspec validate exact-command-path-permissions --strict` and confirm the completed change artifacts validate.
