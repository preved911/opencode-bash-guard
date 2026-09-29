## ADDED Requirements

### Requirement: Parse permissions rules from the plugin config file

The system SHALL read an optional `permissions` array from the plugin config file `opencode-bash-guard.jsonc` (project `.opencode/` and global opencode config dir, project wins) into typed tool entries `{ tool: string, args: ArgMatcher[] }`. Each arg matcher SHALL declare exactly one of `token: string` or `position: number` + `pattern: string`, MAY declare `valuePattern: string` (with `token`) or nested `args` (with `token`), and MUST declare `action: "allow" | "ask" | "deny"`. Entries failing validation SHALL be dropped with a warning naming them. When the file or section is absent, or the file fails to parse, the parsed rule list SHALL be empty and plugin behavior SHALL be identical to before this change.

#### Scenario: Valid entries parse

- **WHEN** `permissions` contains `{ "tool": "find", "args": [{ "token": "-delete", "action": "ask" }, { "position": 0, "pattern": "/Users/me/work/**", "action": "allow" }] }`
- **THEN** one tool entry is stored with two validated arg matchers

#### Scenario: Invalid entries dropped with warning

- **WHEN** `permissions` contains an entry without `tool`, a matcher with both `token` and `position`, a matcher without `action`, and one with `action: "block"`
- **THEN** each invalid entry is dropped and a warning names it

#### Scenario: Section absent

- **WHEN** `opencode-bash-guard.jsonc` does not exist or has no `permissions` section
- **THEN** the args rule list is empty and no behavior changes vs. the previous release

#### Scenario: Invalid config file disables the feature

- **WHEN** `opencode-bash-guard.jsonc` contains a JSONC syntax error
- **THEN** a warning names the parse error and `permissions` is treated as absent; the plugin's glob-based behavior is unaffected

### Requirement: Structured arg matcher semantics

The system SHALL match a segment's tokens (after the command name, whitespace-tokenized, case-sensitive) against arg matchers independently: a `token` matcher matches any unconsumed equal token and consumes it; with `valuePattern`, the next token must exist and glob-match it; a `position`+`pattern` matcher matches the token at that 0-based index against the glob; nested `args` SHALL be evaluated only on the remaining tokens after the parent `token` matcher matched, with tokens consumed at deeper levels invisible to shallower matchers. Every matched matcher SHALL contribute its action; no matcher short-circuits another.

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

For each segment, the bash action SHALL be resolved as: args-level action when any args matcher matched; otherwise the existing `permission.bash` glob evaluation (unchanged, including last-match-wins); otherwise no opinion and native opencode permission checks apply. The old glob-based behavior SHALL be preserved for every segment no args rule matches.

#### Scenario: Args allow overrides a broad native ask

- **WHEN** `permissions` has `curl` → `{ "token": "-X", "valuePattern": "GET", "action": "allow" }`, native `permission.bash` has `"*": "ask"`, and segment is `curl -X GET https://api.com`
- **THEN** the segment's action is `allow` from the args level, stored for the callID, and `permission.ask` sets `output.status = "allow"` — the command runs without a prompt

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
