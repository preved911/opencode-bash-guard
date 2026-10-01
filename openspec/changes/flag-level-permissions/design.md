## Context

Segments arriving at `resolveSegment` are plain strings matched against opencode's `permission.bash` globs (`matchBashPermission`, last-match-wins). Two problems with flag-level control in this model:

1. A char-level glob like `"* -delete *"` matches `-delete` anywhere — including quoted text and flag values (`git commit -m "-delete"`). Flag intent needs token awareness, not substring globs.
2. Structured arg matching (per-flag actions, positional value patterns) cannot be expressed in opencode's permission block at all — that block's vocabulary is whole-string globs.

Review direction (PR #16): these rules must **not** live in opencode's config. They are bash-guard's own vocabulary and belong in the plugin's own config file. The check pipeline becomes: **bash-guard's config level → opencode's permission block level, evaluated by bash-guard → opencode's own permission checks**. Old glob-based behavior continues unchanged for segments no arg rule matches.

There is also an enforcement asymmetry: today the plugin only intervenes on `ask`/`deny`. When it resolves `allow` it steps aside and native opencode permission applies its own full-string matching — so an args-level `allow` would be overridden by a broader native `ask` (e.g. `"curl *": "ask"`). Args rules that upgrade a segment to allow need a mechanism to override the native decision.

## Goals / Non-Goals

**Goals:**
- Per-tool, per-arg permission rules with an explicit action, declared in bash-guard's own config file
- Most-restrictive-wins precedence (review: "less permission level should win") — deterministic, order-independent
- Multi-arg segments handled naturally: every matching rule contributes, the strictest wins
- Nested declarations for subcommand chains (`git push` → `--force`)
- Existing pipeline preserved: no args match → `permission.bash` glob checks → native opencode dialog for `ask`
- Zero behavior change when the `permissions` section is absent

**Non-Goals:**
- No tool-level default action in the plugin config — coarse per-command policy ("all of `rm` denied") stays expressible in opencode's `permission.bash` globs; the plugin config only refines at arg level
- No AND-group combo rules in v1 — independent matchers + most-restrictive-wins cover the stated use cases (`all: [...]` groups are a future extension)
- Not shell-quote-aware tokenization in v1 (documented limitation)
- Not changing how glob rules match or how external_directory works
- Not hot-reloading the config file — changes require an opencode restart (same as the existing config hook)

## Decisions

1. **Config location: `opencode-bash-guard.jsonc`, plugin-owned**

   Same file, discovery and merge rules as the chain-restructuring change (global `~/.config/opencode/opencode-bash-guard.jsonc`, project `<project>/.opencode/opencode-bash-guard.jsonc`, project wins, deep-merge, read once at plugin init via `input.directory`). Invalid JSONC → warning + **degraded mode**: `permissions` is treated as absent AND glob allows are suspended — every bash segment resolves to `ask` until the config is fixed. Unlike the chain-restructuring change (where fail-open was right for a convenience feature), `permissions` carries `deny` rules: silently dropping them on a typo would re-allow exactly the commands the user tried to restrict (PR #16 review). Degraded mode never silently allows and never bricks — the cost of a typo is prompts, not a bypass.

   Rationale: review feedback — flag-level permission policy is bash-guard vocabulary, not opencode's. opencode's config keeps whole-string globs; the plugin file holds structured rules and can carry comments documenting each rule's intent. Parsing uses `jsonc-parser` (new dependency, shared with the chain-restructuring change if that lands first).

2. **Schema: `permissions` array of per-tool entries**

   ```jsonc
   {
     "permissions": [
       {
         "tool": "curl",
         "args": [
           { "token": "-X", "valuePattern": "GET", "action": "allow" }
         ]
       },
       {
         "tool": "find",
         "args": [
           { "token": "-delete", "action": "ask" },
           { "position": 0, "pattern": "/Users/me/work/**", "action": "allow" }
         ]
       },
       {
         "tool": "git",
         "args": [
           {
             "token": "push",
             "action": "allow",
             "args": [
               { "token": "--force", "action": "deny" },
               { "token": "--force-with-lease", "action": "allow" }
             ]
           }
         ]
       }
     ]
   }
   ```

   Field naming (refined from the reviewer's sketch — `behavoiur` typo fixed, `{{ arg.0 }}` template replaced by explicit fields):

   | Field | Meaning |
   |---|---|
   | `tool` | command name (first token of the segment), case-sensitive |
   | `token` | exact arg token match — a flag (`-delete`) or a subcommand (`push`); case-sensitive |
   | `position` | 0-based index over all tokens after the tool name (flags and positionals both count) — or the literal string `"all"`, the single variable-arity notation: the candidate set is every remaining positional token and the match quantifier is derived from `action` (see below) |
   | `pattern` | glob the token at `position` (`*`, `**`, path globs); required with `position`; with `"all"`, applied to the whole candidate set |
   | `valuePattern` | glob the token immediately following a matched `token` (flag value) |
   | `action` | `"allow" \| "ask" \| "deny"` — named `action` for consistency with the existing `BashPermissionRule.action` and opencode permission values |
   | `args` (nested) | sub-declarations evaluated on the remaining tokens after the parent `token` matches (subcommand nesting) |

   Validation: an entry must have a non-empty `tool`; each arg matcher must declare exactly one of `token` or `position`(+`pattern`); `action` is required; nested `args` is only meaningful under a `token` matcher. Invalid entries are dropped with a warning naming them, same policy as existing parsers.

   Variable-arity rationale (PR #16 review): there is deliberately **one** keyword, `"all"` — it names the candidate set (all remaining positional tokens), not the quantifier, so it does not duplicate the `action` field. The quantifier is derived from the action so the matcher always fails safe: with `allow`, every candidate must glob-match the pattern (one unsafe path → no allow → falls to the stricter glob/ask level); with `ask`/`deny`, a single matching candidate is enough (one sensitive path → restricts, so a mixed `rm work/a /etc/passwd` cannot escape the deny). The inverted behaviors an explicit quantifier would allow (every-must-match deny that misses mixed commands, any-match allow that force-allows them) are unreachable by construction — no pairing validation needed.

3. **Matching semantics: independent matchers, consumed tokens, nesting walk**

   - The matcher engine walks the segment's token stream after the command name, left to right.
   - Evaluation order is deterministic: `token` matchers run first (in declaration order) and consume the tokens they match; `position` matchers — single-slot and `"all"` — then evaluate over the remaining unconsumed tokens.
   - `token` matcher: matches if an unconsumed token equals it (case-sensitive). The matched token is consumed; if `valuePattern` is set, the next token must exist and glob-match it (and is consumed too), otherwise the matcher does not match.
   - `position`+`pattern` matcher (number): the token at that index must glob-match `pattern`. Glob syntax follows the existing path matcher (`*` within a token, `**` across separators).
   - `position: "all"`+`pattern` matcher: applies to every remaining unconsumed token that does not start with `-` (flag heuristic, same one the plugin's path extraction already uses). The quantifier is derived from the action, always failing safe. With `action: "allow"`: matches only if **all** candidate tokens glob-match `pattern` — one mismatch means no match and no contribution; zero candidates also means no match. This is the variable-arity allow case: `cp src1 src2 dest` with every path under the work tree → allow; any path outside → the segment falls to the stricter glob level. With `action: "ask"`/`"deny"`: matches if **at least one** candidate glob-matches — `rm` with `{ "position": "all", "pattern": "/etc/**", "action": "deny" }` denies the moment a single path touches `/etc`, so the mixed `rm work/a /etc/passwd` case cannot escape. Flag values are not excluded from `"all"` candidates (documented limitation, same class as the tokenization one below).
   - Nested `args` are evaluated on the remaining (unconsumed) tokens only after the parent `token` matched. Tokens consumed at depth N are invisible to shallower matchers.
   - All matchers evaluate independently — a rule fires when its own matcher matches; multiple matches each contribute their action. There is no first-match short-circuit.

   Walkthrough, `git push --force origin main` with the config above: `push` matches → contributes `allow`, consumes `push`; nested walk on `--force origin main`: `--force` matches → contributes `deny` (`--force-with-lease` does not match). Most restrictive → **deny**.

   Walkthrough, `cp /Users/me/work/a.txt /Users/me/work/b.txt /tmp/out` with an entry `{ "position": "all", "pattern": "/Users/me/work/**", "action": "allow" }`: candidate tokens are all three paths (none starts with `-`); `/tmp/out` does not glob-match → the matcher does not match → no `allow` contribution → the segment falls through to the glob/native level (typically ask). With all three paths under `/Users/me/work/**` the matcher matches → allow (overriding a native ask via decision 5).

4. **Precedence: most-restrictive-wins at the args level, then the existing glob level**

   Per-segment bash action resolution becomes:

   ```
   1. any args rule matched → most restrictive of all contributed actions (deny > ask > allow)
   2. else existing glob matchBashPermission (last-match-wins, unchanged) → its action
   3. else null (no opinion) → native opencode checks apply
   ```

   Most-restrictive-wins (review: "less permission level should win") replaces the originally proposed first-match-wins: no ordering dependence, no dead-config shadowing, and the safe reading of overlapping intent. Consequence, accepted by design: an `allow` matcher cannot carve an allow out of an overlapping `ask` matcher **at the args level** — `find` with both `-delete → ask` and work-path `allow` asks for `find work/path -delete`. Narrowing happens *down* a level: the args level refines opencode's glob level, and an unmatched segment gets the glob answer.

   The `curl` use case survives because the two levels are different mechanisms: opencode keeps `"*": "ask"`; the args level matches `-X GET` → allow, which overrides the native ask (decision 5). `curl -X POST` matches nothing at the args level and falls through to the native `"*": "ask"`.

5. **Args-level allow overrides a native ask (force-allow, mechanism unchanged)**

   - When a segment's action comes from a matched args rule with `action: "allow"`, the plugin stores the decision (`callID → "allow"`) and `permission.ask` sets `output.status = "allow"`, overriding a native ask. Native allows never trigger `permission.ask`, so this only ever upgrades an ask → allow, never downgrades a deny.
   - `ask`/`deny` from args rules wrap and store exactly as today; the user sees the native dialog for asks.
   - Segments resolved purely by glob rules keep today's behavior: no store, no intervention.
   - `StoredDecision` gains the resolved action including `allow`; `beforeExecute` stores `allow` only when the chain action is `allow` AND at least one segment's allow originated from an args-rule match.

6. **Aggregation unchanged**

   `resolveChain` keeps deny > ask > allow across segments. `resolveSegment` gains the args-rule check as step 1; external_directory path checks still apply afterwards and merge most-restrictive within the segment. No new aggregation rules.

7. **Tokenization limitation accepted**

   `echo "a b"` tokenizes to `echo`, `"a`, `b"`. A matcher could therefore match inside quoted strings. Accepted because (a) the plugin's job is gating, not parsing, (b) false matches err toward asking, and (c) argv-exact tokenization via the unbash AST is a future refinement.

## Risks / Trade-offs

- **[No allow-carve-out inside args level]** Overlapping matchers collapse to the strictest action, so a broad `ask` matcher hides a narrow `allow` at the same level. Mitigation: accepted per review direction (safety-first); document that narrowing is done by leaving the broad behavior to the glob level.
- **[New config surface]** A plugin-owned file is a second place to look for permission policy. Mitigation: README documents the two-level model explicitly ("opencode.json — coarse; opencode-bash-guard.jsonc — flag-level refinement"); absence of the file disables the feature entirely.
- **[Broken config → degraded mode]** A broken `opencode-bash-guard.jsonc` suspends glob allows and asks for every bash command (warning names the parse error). Deliberate fail-safe (PR #16 review): silently dropping `deny` rules on a typo would re-allow the commands the user meant to restrict; the cost of a typo is prompts, not a bypass. Mitigation for availability: the warning names the file and the fix is a restart after editing.
- **[Entry-level drops remain fail-open]** An entry that fails *validation* (missing field, both `token` and `position`) is dropped with a warning while valid entries keep working — a typoed `deny` entry vanishes. Accepted: per-entry errors are named at startup; whole-file corruption (the dangerous case) degrades to ask-everything.
- **[Quoted-token false matches]** `-delete` inside a quoted arg counts as a token. Mitigation: documented limitation; severity is an extra prompt (ask), not a bypass.
- **[`"all"` candidate heuristic]** `position: "all"` skips tokens starting with `-` but cannot tell flag values from positionals (`find -name x.txt` leaves `x.txt` as a candidate). Mitigation: documented; for value-sensitive commands prefer `token`+`valuePattern` matchers, which consume flag values explicitly.
- **[Force-allow surprise]** A stored allow overrides native asks — a user relying on native `"curl *": "ask"` to review all curls will not be asked for `-X GET` matches. Mitigation: args rules are opt-in; README states args rules override native matching for matched segments.
- **[Case sensitivity]** `-x get` does not match `-X GET`. Mitigation: document; users add both spellings if needed.
