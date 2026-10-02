## 1. Regression Tests

- [ ] 1.1 Preserve flat-matcher regression coverage in `src/__tests__/tool-permissions.test.ts`: quote-aware tokenization, short-flag cluster expansion, atomic flag-value pairs, positional matching, `position: "all"` quantifiers, multiple tool entries, args force-allow, glob fallback, and degraded mode.
- [ ] 1.2 Add `plugin-config.test.ts` cases: the `flags` arity table parses (`0`/`1` only); `pattern` with a non-flag single-string `token` is dropped with a warning; `pattern` with an array `token` stays invalid.

## 2. Token Classification

- [ ] 2.1 Implement the linear structural classification pass in `src/config.ts`: after `<executable>` classify tokens into command-path candidates, flags (boolean, value-taking by declaration, `=`-form inline value), flag values, positionals, and trailing arguments after the first `--`.
- [ ] 2.2 Resolve flag arity from the entry: value matcher declarations and the `flags` table; undeclared flags are value-less (fail-safe); a declared value consumes the next token unconditionally (including `-`-prefixed tokens) when it exists and is not `--` — the explicit declaration is authoritative.

## 3. Matching

- [ ] 3.1 Redefine array-token matching in `src/config.ts` as an ordered, anchored, contiguous path over the structural positional command tokens; foreign positionals break the match; trailing arguments after the complete path are allowed; elements match whole tokens exactly and consume distinct positions.
- [ ] 3.2 Ground value matchers in the classification: the `pattern` binds to the structurally adjacent value token or the `=`-form of the same flag; reject non-flag `token` + `pattern` matchers at validation (warn-and-drop).
- [ ] 3.3 Re-point `position` and `position: "all"` to the structural positional list (declared flag values and `--`-trailing tokens excluded) and keep the fail-safe `allow`/`ask`/`deny` quantifiers.
- [ ] 3.4 Keep `refines()` unchanged (path-prefix extension; value pattern over the same bare flag token) and keep most-restrictive reduction of survivors; keep `resolveSegment` fallback behavior (glob, external-directory, redirect, degraded mode) unchanged.

## 4. Documentation

- [ ] 4.1 Rewrite the `permissions` section of `README.md` around the token model: anchored ordered paths, flag arity declaration (`flags` table, value matchers), fail-safe undeclared-flag behavior, `=`-form equivalence, `--` handling.
- [ ] 4.2 Add migration notes: array-token rules are now anchored/ordered; non-flag `token` + `pattern` matchers must become path matchers or flag matchers; `position` indices change where declared flag values were previously counted as positionals.

## 5. Verification

- [ ] 5.1 Run the focused `src/__tests__/plugin-config.test.ts` and `src/__tests__/tool-permissions.test.ts` test files and confirm the new and preserved matcher scenarios pass.
- [ ] 5.2 Run the full `npm test` suite and `npm run build` TypeScript build successfully.
- [ ] 5.3 Run `openspec validate ordered-command-path-matching --strict` and confirm the change artifacts validate.
