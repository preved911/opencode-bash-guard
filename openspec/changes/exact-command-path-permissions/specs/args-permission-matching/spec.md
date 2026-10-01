## MODIFIED Requirements

### Requirement: Parse permissions rules from the plugin config file

The system SHALL read an optional `permissions` array from the plugin config file `opencode-bash-guard.jsonc` (project `.opencode/` and global opencode config dir, project wins) into typed tool entries `{ tool: string, args: ArgMatcher[] }`. Each arg matcher SHALL declare exactly one of `token: string` or `position: number | "all"`; `pattern: string` is REQUIRED with `position` (globs that positional slot) and OPTIONAL with `token` (when present it globs the value token immediately following the matched flag; when absent the matcher is a bare flag match). A `token` matcher MAY declare nested `args`. A matcher MAY omit `action`; an omitted action SHALL normalize to `"ask"`. When present, `action` MUST be `"allow" | "ask" | "deny"`. Entries failing validation SHALL be dropped with a warning naming them. When the file or section is absent, the parsed rule list SHALL be empty and plugin behavior SHALL be identical to before this change. When the file fails to parse as JSONC, the plugin SHALL enter degraded mode: `permissions` is treated as absent AND glob allows are suspended for that run, every bash segment SHALL resolve to `ask` (parse-error segments still deny), with a warning naming the file, so a broken config can never silently disable `deny` rules that were meant to be active.

#### Scenario: Valid entries parse

- **WHEN** `permissions` contains `{ "tool": "find", "args": [{ "token": "-delete", "action": "ask" }, { "position": 0, "pattern": "/Users/me/work/**", "action": "allow" }] }`
- **THEN** one tool entry is stored with two validated arg matchers

#### Scenario: Omitted action defaults to ask

- **WHEN** `permissions` contains `{ "tool": "find", "args": [{ "token": "-delete" }] }`
- **THEN** the matcher is stored with its action normalized to `ask`

#### Scenario: Invalid entries dropped with warning

- **WHEN** `permissions` contains an entry without `tool`, a matcher with both `token` and `position`, a matcher with neither `token` nor `position`, and one with `action: "block"`
- **THEN** each invalid entry is dropped and a warning names it

#### Scenario: Section absent

- **WHEN** `opencode-bash-guard.jsonc` does not exist or has no `permissions` section
- **THEN** the args rule list is empty and no behavior changes vs. the previous release

#### Scenario: Broken config file degrades to ask-everything

- **WHEN** `opencode-bash-guard.jsonc` contains a JSONC syntax error and native config has `"find *": "allow"`, `"*": "ask"`
- **THEN** a warning names the parse error and every bash segment resolves to `ask`; `find /tmp -delete` is **not** silently allowed by the glob allow; the prompt persists until the config is fixed

### Requirement: Structured arg matcher semantics

The system SHALL match a segment's tokens against arg matchers independently. Tokens SHALL be argv-style and quote-aware, derived from the same AST parse the chain splitter performs, with matched quote pairs stripped (`"--force"` matches as `--force`, `--force""` as `--force`) and quoted whitespace kept within a token (`echo "a b"` yields one arg), so quoting cannot hide a flag from a matcher. Commands whose chain parse failed never reach matcher evaluation (they fail closed earlier). `token` matching SHALL additionally expand clustered short flags: a `token` target of one letter after `-` (e.g. `-f`) SHALL also match a clustered token of single-letter short flags (e.g. `-rf`); other forms are not expanded. A `token` matcher declaring `pattern` (value match) SHALL match only via exact token equality; cluster-expanded matches never apply, and a cluster match never consumes the following token as a value. A cluster-expanded match SHALL NOT consume the token: every single-letter target tests cluster membership independently, so separate matchers can all match the same cluster and their actions aggregate most-restrictive-wins. A `token` matcher matches any unconsumed equal token and consumes it; when it declares `pattern`, the next token must exist and glob-match it (the flag's value) and is consumed too. A `position`+`pattern` matcher matches the N-th **positional** token: tokens after the tool name that do not start with `-`, counted in command order on the original token list (independent of consumption by `token` matchers; consumption affects only nested `args` evaluation). Flags never occupy a positional slot. Heuristic limitation (documented, same class as the `"all"` candidate set): a flag value that does not start with `-` (`find -name x.txt` → `x.txt`) counts as a positional. `position: "all"` is the single variable-arity notation: the candidate set is every remaining unconsumed token that does not start with `-`, and the match quantifier SHALL be derived from `action` so the matcher always fails safe: with `action: "allow"`, every candidate MUST glob-match the pattern (one mismatch or zero candidates means no match); with `action: "ask"` or `"deny"`, at least one candidate glob-matching the pattern is sufficient (zero candidates means no match). Nested `args` SHALL be evaluated only on the remaining tokens after the parent `token` matcher matched, with tokens consumed at deeper levels invisible to shallower matchers. `token` matchers SHALL consume before `position` matchers evaluate. Every matched matcher at the selected evaluation level SHALL contribute its action; no matcher at that level short-circuits another. Nested `token` matchers form command paths of arbitrary depth: an action at a configured leaf applies only when the complete configured hierarchy of parent and descendant tokens matches. Matching a deeper descendant SHALL select that descendant evaluation level and SHALL NOT accumulate actions from its matched ancestors. A path match SHALL NOT authorize or restrict its ancestors, incomplete prefixes, or a sibling path. Tokens following an exact configured hierarchy that are ordinary command arguments, rather than tokens that extend a configured nested hierarchy, SHALL continue to be evaluated by the existing token, value, position, and `"all"` matcher semantics at the selected level.

#### Scenario: Quoted flag cannot bypass a deny

- **WHEN** tool entry is `git` with nested `push` → `{ "token": "--force", "action": "deny" }` and segment is `git push "--force" origin main`
- **THEN** the token is argv-style `--force` (quotes stripped) and the matcher matches; quoting does not bypass the deny

#### Scenario: Clustered short flags match single-letter targets

- **WHEN** matcher is `{ "tool": "rm", "args": [{ "token": "-f", "action": "deny" }] }` and segment is `rm -rf /tmp/x`
- **THEN** the clustered token `-rf` expands for matching and `-f` matches, contributing `deny`

#### Scenario: Cluster matches do not consume, sibling flags still match

- **WHEN** an `rm` entry declares both `{ "token": "-r", "action": "deny" }` and `{ "token": "-f", "action": "ask" }`, and segment is `rm -rf /tmp/x`
- **THEN** both matchers match the same clustered token (`-rf`) and contribute (`deny`, `ask`); the args-level action is `deny`

#### Scenario: Token value matchers do not match via cluster expansion

- **WHEN** matcher is `{ "token": "-f", "pattern": "/tmp/**", "action": "deny" }` and segment is `rm -rf /tmp/x`
- **THEN** the matcher does not match; a value cannot be attributed to one letter of a cluster; token value matching requires exact token equality (`rm -f /tmp/x` would match)

#### Scenario: Key=value options are ordinary candidates

- **WHEN** matcher is `{ "position": "all", "pattern": "/dev/**", "action": "deny" }` and segment is `dd if=/dev/sda of=/dev/sdb`
- **THEN** the candidates are the full tokens `if=/dev/sda` and `of=/dev/sdb`, neither glob-matches `/dev/**`, and the matcher does not match; key=value options are not decomposed (documented limitation; the pattern must match the full token, e.g. `if=/dev/**`)

#### Scenario: Flag token matches anywhere

- **WHEN** matcher is `{ "token": "-delete", "action": "ask" }` and segment is `find /tmp -name "*.log" -delete`
- **THEN** the matcher matches and contributes `ask`

#### Scenario: Flag not present, no match

- **WHEN** matcher is `{ "token": "-delete", "action": "ask" }` and segment is `find /tmp -name "*.log"`
- **THEN** the matcher does not match

#### Scenario: Positional pattern match

- **WHEN** matcher is `{ "position": 0, "pattern": "/Users/me/work/**", "action": "allow" }` and segment is `find /Users/me/work/logs -type f`
- **THEN** the matcher matches (token at position 0 is `/Users/me/work/logs`)

#### Scenario: Positional pattern mismatch

- **WHEN** matcher is `{ "position": 0, "pattern": "/Users/me/work/**", "action": "allow" }` and segment is `find /tmp -type f`
- **THEN** the matcher does not match

#### Scenario: Numeric position counts positional arguments only, flags never shift the index

- **WHEN** a `find` entry declares `{ "token": "-delete", "action": "ask" }` and `{ "position": 0, "pattern": "/tmp/**", "action": "allow" }`, and segments are `find /tmp -delete` and `find -delete /tmp`
- **THEN** both segments resolve `position: 0` to the first positional `/tmp`; flags (`-delete`) never occupy a positional slot regardless of where they appear; `-delete` also matches its token matcher (`ask`), so both contribute (`ask`, `allow`) and the args-level action is `ask`

#### Scenario: Flag values without a dash count as positionals (heuristic limitation)

- **WHEN** matcher is `{ "position": 0, "pattern": "/Users/me/work/**", "action": "allow" }` and segment is `find -name x.txt`
- **THEN** `x.txt` (the `-name` value) counts as positional 0 and does not glob-match; the matcher does not match; only dash-prefixed tokens are recognized as flags

#### Scenario: Inserted global flag no longer shifts positional indices, its value does

- **WHEN** matcher is `{ "position": 0, "pattern": "push", "action": "allow" }` on tool `git`, and segments are `git push --force` and `git -c key=val push --force`
- **THEN** in `git push --force` position 0 is `push` (matches); in `git -c key=val push --force` the flag `-c` is skipped but its value `key=val` occupies position 0; the matcher does not match and the segment falls to the glob level (documented heuristic limitation)

#### Scenario: All-position, all candidates match

- **WHEN** matcher is `{ "position": "all", "pattern": "/Users/me/work/**", "action": "allow" }` and segment is `cp /Users/me/work/a.txt /Users/me/work/b.txt /Users/me/work/dest/`
- **THEN** the matcher matches (all three paths glob-match) and contributes `allow`

#### Scenario: All-position with allow, one mismatch fails the whole matcher

- **WHEN** same matcher and segment is `cp /Users/me/work/a.txt /tmp/out`
- **THEN** the matcher does not match and contributes nothing; the segment falls to the glob level

#### Scenario: All-position ignores flag-like tokens

- **WHEN** same matcher and segment is `cp -R /Users/me/work/a.txt /Users/me/work/b.txt`
- **THEN** the matcher matches (`-R` is not a candidate; both paths glob-match)

#### Scenario: All-position, no candidates means no match

- **WHEN** same matcher and segment is `cp` (no positional tokens)
- **THEN** the matcher does not match

#### Scenario: All-position with deny, one sensitive path is enough

- **WHEN** matcher is `{ "position": "all", "pattern": "/etc/**", "action": "deny" }` and segment is `rm /Users/me/work/a.txt /etc/passwd`
- **THEN** the matcher matches (`/etc/passwd` glob-matches) and contributes `deny`; the mixed command cannot escape the deny

#### Scenario: All-position with deny, no matching candidate means no match

- **WHEN** same matcher and segment is `rm /Users/me/work/a.txt /Users/me/work/b.txt`
- **THEN** the matcher does not match and contributes nothing; the segment falls to the glob level

#### Scenario: All-position with deny, no candidates means no match

- **WHEN** same matcher and segment is `rm -rf` (only flag-like tokens)
- **THEN** the matcher does not match

#### Scenario: All-position combines with other matchers

- **WHEN** a `find` entry declares both `{ "position": "all", "pattern": "/Users/me/work/**", "action": "allow" }` and `{ "token": "-delete", "action": "deny" }`, and segment is `find /Users/me/work/a /Users/me/work/b -delete`
- **THEN** both matchers contribute (`allow`, `deny`) and the args-level action is `deny`; the command is allowed except with `-delete`

#### Scenario: Flag value pattern

- **WHEN** matcher is `{ "token": "-X", "pattern": "GET", "action": "allow" }` and segment is `curl -X GET https://api.com`
- **THEN** the matcher matches (`-X` matched and its value `GET` glob-matches); for `curl -X POST https://api.com` it does not

#### Scenario: Exact arbitrary-depth nested command path

- **WHEN** tool entry is `a` with nested token rules `b` → `c` → `{ "token": "d", "action": "allow" }` and segment is `a b c d`
- **THEN** the complete configured path matches and its leaf action is `allow`

#### Scenario: Nested path does not match ancestors or siblings

- **WHEN** tool entry is `a` with nested token rules `b` → `c` → `{ "token": "d", "action": "allow" }` and segments are `a`, `a b`, `a b c`, and `a b c e`
- **THEN** none of the segments receives `allow` from the `a b c d` path

#### Scenario: Nested rules require the parent token

- **WHEN** tool entry is `git` with `{ "token": "push", "action": "allow", "args": [{ "token": "--force", "action": "deny" }] }` and segment is `git status` or `git commit --force-ish`
- **THEN** no nested matcher is evaluated; `push` and `--force` do not match

#### Scenario: Ancestor actions are not accumulated with a deeper descendant

- **WHEN** tool entry is `git` with `{ "token": "push", "action": "allow", "args": [{ "token": "--force", "action": "deny" }] }` and segment is `git push --force origin main`
- **THEN** the deeper `--force` level is selected and contributes only `deny`; the ancestor `push` action does not contribute

#### Scenario: Ordinary trailing arguments retain matcher semantics

- **WHEN** tool entry is `git` has nested token rules `push` → `{ "token": "--force", "action": "deny" }` and a sibling matcher at the `push` level `{ "position": "all", "pattern": "origin", "action": "ask" }`, and segment is `git push origin main`
- **THEN** `origin` and `main` are ordinary trailing arguments at the matched `push` level; the `position: "all"` matcher evaluates them and contributes `ask`, while the unrelated configured descendant `--force` does not match

#### Scenario: Consumed tokens are not rematched

- **WHEN** segment is `git push --force` and entry declares both an outer `{ "token": "--force", "action": "ask" }` and the nested `push` → `{ "token": "--force", "action": "deny" }` tree
- **THEN** `--force` is matched once (nested, `deny`); the outer matcher does not match it again

### Requirement: Most-restrictive-wins among matched args rules

When one or more arg matchers match at the same evaluation level, the segment's args-level action SHALL be the most restrictive among actions contributed at that level (`deny` > `ask` > `allow`), regardless of declaration order. Deny-wins applies only among simultaneously matching sibling rules at the same evaluation level. A deeper matched descendant selects its evaluation level; actions from its matched ancestors SHALL NOT be accumulated with that descendant action. If no matcher matches, the segment SHALL have no args-level opinion.

#### Scenario: Ask wins over allow

- **WHEN** segment `find /Users/me/work/logs -delete` matches both `-delete → ask` and position-0 `allow` matchers
- **THEN** the args-level action is `ask`

#### Scenario: Deny wins over ask at the same level

- **WHEN** segment `git push --force-with-lease` matches sibling nested `--force-with-lease → allow` and `--force* → deny` matchers at the `push` level
- **THEN** the args-level action is `deny`

#### Scenario: Single match decides

- **WHEN** segment `find /Users/me/work/logs -type f` matches only the position-0 `allow` matcher
- **THEN** the args-level action is `allow`

#### Scenario: No match, no opinion

- **WHEN** segment `find /tmp -type f` matches no matcher of the `find` entry
- **THEN** the segment has no args-level opinion
