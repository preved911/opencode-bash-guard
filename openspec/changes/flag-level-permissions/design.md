## Context

Segments arriving at `resolveSegment` are plain strings matched against glob patterns (`matchBashPermission`, last-match-wins). Two problems with flag-level control in this model:

1. A char-level glob like `"* -delete *"` matches `-delete` anywhere — including quoted text and flag values (`git commit -m "-delete"`). Flag intent needs token awareness, not substring globs.
2. Precedence is order-dependent on JSON object keys with last-match-wins. Expressing "allow `curl -X GET *` but ask every other `curl`" is impossible to state reliably.

There is also an enforcement asymmetry: today the plugin only intervenes on `ask`/`deny`. When it resolves `allow` it steps aside and native opencode permission applies its own full-string matching — so even a hypothetical narrow `allow` pattern would be overridden by a broader native `ask` (e.g. `"curl *": "ask"`). Flag rules that can *upgrade* a segment to allow need a mechanism to override the native decision.

## Goals / Non-Goals

**Goals:**
- Let users declare per-command arg/flag rules with an explicit action: `curl -X GET * → allow`, `find * -delete → ask`
- Deterministic precedence that does not depend on JSON object key order
- Rules work per segment inside chains (same evaluation path as glob rules)
- Flag `allow` can genuinely override a broader native `ask`
- Zero behavior change when `permission.bash_args` is absent

**Non-Goals:**
- Not parsing flags into structured form (`{ flag, value }`) — pattern strings with `*` tokens are expressive enough and match the user's mental model
- Not shell-quote-aware tokenization in v1 (documented limitation)
- Not changing how glob rules match or how external_directory works
- Not de-obfuscating argv (aliases, `eval` re-parsing already handled upstream by chain.ts)

## Decisions

1. **Config shape: ordered array under `permission.bash_args`**

   ```json
   {
     "permission": {
       "bash": { "*": "ask", "git *": "allow" },
       "bash_args": [
         { "pattern": "curl -X GET *", "action": "allow" },
         { "pattern": "curl *", "action": "ask" },
         { "pattern": "find * -delete", "action": "ask" },
         { "pattern": "find *", "action": "allow" },
         { "pattern": "git push --force *", "action": "deny" }
       ]
     }
   }
   ```

   Array (not object) because ordering is the precedence mechanism and must be explicit. Invalid entries (missing pattern/action, bad action) are dropped with a warning, same policy as existing parsers.

2. **Token matching, anchored at the command name**

   - Tokenize pattern and segment on whitespace (collapse runs of spaces/tabs).
   - Pattern tokens match segment tokens one-to-one; a literal token must be equal (case-sensitive); `*` matches zero or more segment tokens (greedy with backtracking — standard glob-sequence DP).
   - Matching is anchored: the first pattern token must equal the segment's first token (the command name).
   - `curl -X GET *` → segment must be `curl`, then `-X`, then `GET`, then anything (or nothing).
   - `find * -delete` → segment must start with `find`, contain `-delete` as a standalone token later, then anything.
   - Case-sensitive: `-X GET` and `-x get` are distinct. Documented; no normalization in v1.

3. **Precedence: args rules first (first-match-wins), then glob rules, then no match**

   Per-segment bash action resolution becomes:

   ```
   1. first matching bash_args rule (declared order) → its action
   2. else existing glob matchBashPermission (last-match-wins) → its action
   3. else null (no opinion)
   ```

   First-match-wins over most-restrictive-wins is deliberate: the feature's core use case (`curl -X GET * → allow` above `curl * → ask`) requires a narrower rule to *override* a broader one. Most-restrictive-wins would collapse every overlapping match to `ask` and make the allow rule dead config. Deny semantics are preserved by declaration order: put `git push --force * → deny` before `git push * → allow`. Docs will call this out with a "specific first, broad last, denies before allows" convention.

4. **Force-allow only for explicit args-rule matches**

   - When a segment's action comes from an args rule with `action: "allow"`, the plugin stores the decision (`callID → "allow"`) and `permission.ask` sets `output.status = "allow"`, overriding a native ask. Native allows never trigger `permission.ask`, so this only ever upgrades an ask → allow, never downgrades a deny.
   - Glob-only allows keep today's behavior: no wrap, no store, native decides.
   - Rationale: minimal behavior change — the only new override power is exactly the one the feature needs. Single-segment chains with one explicit flag-allow segment are force-allowed; multi-segment chains still aggregate to the most restrictive action first (an all-allow chain whose allows came from flag rules force-allows the ask).

5. **Aggregation unchanged**

   `resolveChain` keeps deny > ask > allow across segments. `resolveSegment` gains the args-rule check as step 1; external_directory path checks still apply afterwards and merge most-restrictive within the segment. No new aggregation rules.

6. **Where the decision comes from matters for storage**

   `StoredDecision` gains the resolved action including `allow`. `beforeExecute` stores:
   - chain action `deny`/`ask` → store + wrap (today's flow)
   - chain action `allow` **originating from at least one args-rule match** → store, no wrap
   - chain action `allow` from glob rules only → no store, no wrap (unchanged)
   - null → nothing (unchanged)

7. **Tokenization limitation accepted**

   `echo "a b"` tokenizes to `echo`, `"a`, `b"`. A pattern could therefore match inside quoted strings. Accepted because (a) the plugin's job is gating, not parsing, (b) false matches err toward asking in the deny/ask direction users care about, and (c) argv-exact tokenization via unbash AST is a future refinement.

## Risks / Trade-offs

- **[First-match-wins misordering]** Users may declare broad rules first, shadowing narrow ones. Mitigation: README convention (specific → broad), warning when an identical-prefix broader rule precedes a narrower one is out of scope for v1.
- **[Quoted-token false matches]** `-delete` inside a quoted arg counts as a token. Mitigation: documented limitation; severity is an extra prompt (ask), not a bypass.
- **[Force-allow surprise]** A stored allow overrides native asks — a user relying on native `"curl *": "ask"` to review all curls will not be asked for `-X GET` matches. Mitigation: flag rules are opt-in; README states flag rules override native matching for matched segments.
- **[Case sensitivity]** `-x get` does not match `-X GET`. Mitigation: document; users add both spellings if needed.
