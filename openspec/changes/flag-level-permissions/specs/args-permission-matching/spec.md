## ADDED Requirements

### Requirement: Parse permissions rules from the plugin config file

The system SHALL read an optional `permissions` array from the plugin config file `opencode-bash-guard.jsonc` (project `.opencode/` and global opencode config dir, project wins) into typed tool entries `{ tool: string, args: ArgMatcher[] }`. Each arg matcher SHALL declare exactly one of `token: string` or `position: number | "all"` + `pattern: string`, MAY declare `valuePattern: string` (with `token`) or nested `args` (with `token`), and MUST declare `action: "allow" | "ask" | "deny"`. Entries failing validation SHALL be dropped with a warning naming them. When the file or section is absent, the parsed rule list SHALL be empty and plugin behavior SHALL be identical to before this change. When the file fails to parse as JSONC, the plugin SHALL enter degraded mode: `permissions` is treated as absent AND glob allows are suspended for that run — every bash segment SHALL resolve to `ask` (parse-error segments still deny) — with a warning naming the file, so a broken config can never silently disable `deny` rules that were meant to be active.

#### Scenario: Valid entries parse

- **WHEN** `permissions` contains `{ "tool": "find", "args": [{ "token": "-delete", "action": "ask" }, { "position": 0, "pattern": "/Users/me/work/**", "action": "allow" }] }`
- **THEN** one tool entry is stored with two validated arg matchers

#### Scenario: Invalid entries dropped with warning

- **WHEN** `permissions` contains an entry without `tool`, a matcher with both `token` and `position`, a matcher without `action`, and one with `action: "block"`
- **THEN** each invalid entry is dropped and a warning names it

#### Scenario: Section absent

- **WHEN** `opencode-bash-guard.jsonc` does not exist or has no `permissions` section
- **THEN** the args rule list is empty and no behavior changes vs. the previous release

#### Scenario: Broken config file degrades to ask-everything

- **WHEN** `opencode-bash-guard.jsonc` contains a JSONC syntax error and native config has `"find *": "allow"`, `"*": "ask"`
- **THEN** a warning names the parse error and every bash segment resolves to `ask` — `find /tmp -delete` is **not** silently allowed by the glob allow; the prompt persists until the config is fixed

### Requirement: Structured arg matcher semantics

The system SHALL match a segment's tokens against arg matchers independently. Tokens SHALL be argv-style and quote-aware — derived from the same AST parse the chain splitter performs, with matched quote pairs stripped (`"--force"` matches as `--force`, `--force""` as `--force`) and quoted whitespace kept within a token (`echo "a b"` yields one arg) — so quoting cannot hide a flag from a matcher. Commands whose chain parse failed never reach matcher evaluation (they fail closed earlier). `token` matching SHALL additionally expand clustered short flags: a `token` target of one letter after `-` (e.g. `-f`) SHALL also match a clustered token of single-letter short flags (e.g. `-rf`); other forms are not expanded. A matcher that declares `valuePattern` SHALL match only via exact token equality — cluster-expanded matches never apply, and a cluster match never consumes the following token as a value. A cluster-expanded match SHALL NOT consume the token: every single-letter target tests cluster membership independently, so separate matchers can all match the same cluster and their actions aggregate most-restrictive-wins. A `token` matcher matches any unconsumed equal token and consumes it; with `valuePattern`, the next token must exist and glob-match it. A `position`+`pattern` matcher matches the token at that 0-based index of the **original** post-tool token list (flags and positionals both count) — numeric indexes are independent of consumption by `token` matchers; consumption affects only the `"all"` candidate set and nested `args` evaluation. `position: "all"` is the single variable-arity notation: the candidate set is every remaining unconsumed token that does not start with `-`, and the match quantifier SHALL be derived from `action` so the matcher always fails safe — with `action: "allow"`, every candidate MUST glob-match the pattern (one mismatch or zero candidates means no match); with `action: "ask"` or `"deny"`, at least one candidate glob-matching the pattern is sufficient (zero candidates means no match). Nested `args` SHALL be evaluated only on the remaining tokens after the parent `token` matcher matched, with tokens consumed at deeper levels invisible to shallower matchers. `token` matchers SHALL consume before `position` matchers evaluate. Every matched matcher SHALL contribute its action; no matcher short-circuits another.

#### Scenario: Quoted flag cannot bypass a deny

- **WHEN** tool entry is `git` with nested `push` → `{ "token": "--force", "action": "deny" }` and segment is `git push "--force" origin main`
- **THEN** the token is argv-style `--force` (quotes stripped) and the matcher matches — quoting does not bypass the deny

#### Scenario: Clustered short flags match single-letter targets

- **WHEN** matcher is `{ "tool": "rm", "args": [{ "token": "-f", "action": "deny" }] }` and segment is `rm -rf /tmp/x`
- **THEN** the clustered token `-rf` expands for matching and `-f` matches, contributing `deny`

#### Scenario: Cluster matches do not consume — sibling flags still match

- **WHEN** an `rm` entry declares both `{ "token": "-r", "action": "deny" }` and `{ "token": "-f", "action": "ask" }`, and segment is `rm -rf /tmp/x`
- **THEN** both matchers match the same clustered token (`-rf`) and contribute (`deny`, `ask`); the args-level action is `deny`

#### Scenario: valuePattern matchers do not match via cluster expansion

- **WHEN** matcher is `{ "token": "-f", "valuePattern": "/tmp/**", "action": "deny" }` and segment is `rm -rf /tmp/x`
- **THEN** the matcher does not match — a value cannot be attributed to one letter of a cluster; `valuePattern` requires exact token equality (`rm -f /tmp/x` would match)

#### Scenario: Key=value options are ordinary candidates

- **WHEN** matcher is `{ "position": "all", "pattern": "/dev/**", "action": "deny" }` and segment is `dd if=/dev/sda of=/dev/sdb`
- **THEN** the candidates are the full tokens `if=/dev/sda` and `of=/dev/sdb`, neither glob-matches `/dev/**`, and the matcher does not match — key=value options are not decomposed (documented limitation; the pattern must match the full token, e.g. `if=/dev/**`)

#### Scenario: Flag token matches anywhere

- **WHEN** matcher is `{ "token": "-delete", "action": "ask" }` and segment is `find /tmp -name "*.log" -delete`
- **THEN** the matcher matches and contributes `ask`

#### Scenario: Flag not present — no match

- **WHEN** matcher is `{ "token": "-delete", "action": "ask" }` and segment is `find /tmp -name "*.log"`
- **THEN** the matcher does not match

#### Scenario: Positional pattern match

- **WHEN** matcher is `{ "position": 0, "pattern": "/Users/me/work/**", "action": "allow" }` and segment is `find /Users/me/work/logs -type f`
- **THEN** the matcher matches (token at position 0 is `/Users/me/work/logs`)

#### Scenario: Positional pattern mismatch

- **WHEN** matcher is `{ "position": 0, "pattern": "/Users/me/work/**", "action": "allow" }` and segment is `find /tmp -type f`
- **THEN** the matcher does not match

#### Scenario: Numeric position uses the original token index even after a token matcher consumed

- **WHEN** a `find` entry declares `{ "token": "-delete", "action": "ask" }` and `{ "position": 1, "pattern": "/tmp/**", "action": "allow" }`, and segment is `find -delete /tmp`
- **THEN** `-delete` matches and consumes at original index 0, and `position: 1` still resolves to the original token `/tmp` → both matchers contribute (`ask`, `allow`) and the args-level action is `ask`

#### Scenario: All-position — all candidates match

- **WHEN** matcher is `{ "position": "all", "pattern": "/Users/me/work/**", "action": "allow" }` and segment is `cp /Users/me/work/a.txt /Users/me/work/b.txt /Users/me/work/dest/`
- **THEN** the matcher matches (all three paths glob-match) and contributes `allow`

#### Scenario: All-position with allow — one mismatch fails the whole matcher

- **WHEN** same matcher and segment is `cp /Users/me/work/a.txt /tmp/out`
- **THEN** the matcher does not match and contributes nothing; the segment falls to the glob level

#### Scenario: All-position ignores flag-like tokens

- **WHEN** same matcher and segment is `cp -R /Users/me/work/a.txt /Users/me/work/b.txt`
- **THEN** the matcher matches (`-R` is not a candidate; both paths glob-match)

#### Scenario: All-position — no candidates means no match

- **WHEN** same matcher and segment is `cp` (no positional tokens)
- **THEN** the matcher does not match

#### Scenario: All-position with deny — one sensitive path is enough

- **WHEN** matcher is `{ "position": "all", "pattern": "/etc/**", "action": "deny" }` and segment is `rm /Users/me/work/a.txt /etc/passwd`
- **THEN** the matcher matches (`/etc/passwd` glob-matches) and contributes `deny` — the mixed command cannot escape the deny

#### Scenario: All-position with deny — no matching candidate means no match

- **WHEN** same matcher and segment is `rm /Users/me/work/a.txt /Users/me/work/b.txt`
- **THEN** the matcher does not match and contributes nothing; the segment falls to the glob level

#### Scenario: All-position with deny — no candidates means no match

- **WHEN** same matcher and segment is `rm -rf` (only flag-like tokens)
- **THEN** the matcher does not match

#### Scenario: All-position combines with other matchers

- **WHEN** a `find` entry declares both `{ "position": "all", "pattern": "/Users/me/work/**", "action": "allow" }` and `{ "token": "-delete", "action": "deny" }`, and segment is `find /Users/me/work/a /Users/me/work/b -delete`
- **THEN** both matchers contribute (`allow`, `deny`) and the args-level action is `deny` — the command is allowed except with `-delete`

#### Scenario: Flag value pattern

- **WHEN** matcher is `{ "token": "-X", "valuePattern": "GET", "action": "allow" }` and segment is `curl -X GET https://api.com`
- **THEN** the matcher matches; for `curl -X POST https://api.com` it does not

#### Scenario: Nested subcommand rules

- **WHEN** tool entry is `git` with `{ "token": "push", "action": "allow", "args": [{ "token": "--force", "action": "deny" }] }` and segment is `git push --force origin main`
- **THEN** `push` matches and contributes `allow`, the nested `--force` matches and contributes `deny`

#### Scenario: Nested rules require the parent token

- **WHEN** same config and segment is `git status` or `git commit --force-ish`
- **THEN** no nested matcher is evaluated; `push` and `--force` do not match

#### Scenario: Consumed tokens are not rematched

- **WHEN** segment is `git push --force` and entry declares both an outer `{ "token": "--force", "action": "ask" }` and the nested `push` → `{ "token": "--force", "action": "deny" }` tree
- **THEN** `--force` is matched once (nested, `deny`); the outer matcher does not match it again

### Requirement: Most-restrictive-wins among matched args rules

When one or more arg matchers match a segment, the segment's args-level action SHALL be the most restrictive among all contributed actions (`deny` > `ask` > `allow`), regardless of declaration order. If no matcher matches, the segment SHALL have no args-level opinion.

#### Scenario: Ask wins over allow

- **WHEN** segment `find /Users/me/work/logs -delete` matches both `-delete → ask` and position-0 `allow` matchers
- **THEN** the args-level action is `ask`

#### Scenario: Deny wins over ask

- **WHEN** segment `git push --force-with-lease` matches a nested `--force-with-lease → allow` and a sibling `--force* → deny` matcher
- **THEN** the args-level action is `deny`

#### Scenario: Single match decides

- **WHEN** segment `find /Users/me/work/logs -type f` matches only the position-0 `allow` matcher
- **THEN** the args-level action is `allow`

#### Scenario: No match — no opinion

- **WHEN** segment `find /tmp -type f` matches no matcher of the `find` entry
- **THEN** the segment has no args-level opinion

### Requirement: Check pipeline — args level, then permission block level, then native checks

For each segment, the bash action SHALL be resolved as: args-level action when any args matcher matched; otherwise the existing `permission.bash` glob evaluation (unchanged, including last-match-wins); otherwise no opinion and native opencode permission checks apply. The old glob-based behavior SHALL be preserved for every segment no args rule matches. In degraded mode (broken config file) this pipeline is bypassed: every segment SHALL resolve to `ask` regardless of glob rules, so losing the args rules can never silently re-allow a restricted command.

#### Scenario: Args allow overrides a broad native ask

- **WHEN** `permissions` has `curl` → `{ "token": "-X", "valuePattern": "GET", "action": "allow" }`, native `permission.bash` has `"*": "ask"`, and segment is `curl -X GET https://api.com`
- **THEN** the segment's action is `allow` from the args level, stored for the callID, and `permission.ask` sets `output.status = "allow"` — the command runs without a prompt

#### Scenario: Args deny overrides a glob allow

- **WHEN** native `permission.bash` has `"find *": "allow"`, `permissions` has `find` → `{ "token": "-delete", "action": "deny" }`, and segment is `find /tmp -delete`
- **THEN** the segment's action is `deny` from the args level — args decisions precede the glob level whenever any matcher matched, so `find` stays allowed everywhere except with `-delete`

#### Scenario: Unmatched segment falls through to glob level

- **WHEN** same config and segment is `curl -X POST https://api.com` (no args match)
- **THEN** the segment's action comes from the native glob evaluation — `ask`, dialog shown

#### Scenario: Segment matching no rule at either level

- **WHEN** segment `wget evil.sh` matches neither args rules nor any glob pattern except `"*": "ask"`
- **THEN** the segment's action is `ask` via the glob level (existing behavior)

#### Scenario: Glob-only allow unchanged

- **WHEN** segment `git status` is allowed via glob `"git *": "allow"` and matches no args rule
- **THEN** the plugin stores nothing and does not intervene

#### Scenario: Args ask prompts, args deny blocks

- **WHEN** segment `find /tmp -name "*.log" -delete` resolves to args `ask`, and segment `git push --force origin main` resolves to args `deny`
- **THEN** the first wraps and shows the native dialog; the second is blocked

### Requirement: Chain aggregation includes args-rule actions

Args-level actions SHALL participate in existing segment resolution and most-restrictive-wins chain aggregation (deny > ask > allow) with no new aggregation rules. A chain whose aggregated action is `allow` and where at least one segment's allow came from an args rule SHALL store the `allow` decision and enforce it in `permission.ask`; chains whose allows come only from glob rules SHALL keep today's no-intervention behavior.

#### Scenario: Mixed chain aggregates most restrictive

- **WHEN** chain is `git status && find /tmp -delete` where `git status` → allow (glob) and `find /tmp -delete` → ask (args rule)
- **THEN** the chain action is `ask`

#### Scenario: All-allow args chain force-allows

- **WHEN** chain is `curl -X GET https://a.com && curl -X GET https://b.com` and both segments match the args `allow` matcher while native matching would ask
- **THEN** the chain action is `allow`, stored, and enforced as `allow` in `permission.ask`

#### Scenario: One ask segment asks the chain

- **WHEN** chain is `curl -X GET https://a.com && curl -X POST https://b.com` (second segment falls through to native `"*": "ask"`)
- **THEN** the chain action is `ask`
