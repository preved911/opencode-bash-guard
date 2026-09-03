## ADDED Requirements

### Requirement: Parse bash_args rules from config

The system SHALL parse an optional `permission.bash_args` array from the merged opencode config into typed rules `{ pattern: string, action: "ask" | "allow" | "deny" }`, preserving declaration order. Entries with a missing/empty pattern or an invalid action SHALL be dropped with a warning. When the section is absent, the parsed rule list SHALL be empty and plugin behavior SHALL be identical to before this change.

#### Scenario: Valid rules parse in order

- **WHEN** `permission.bash_args` is `[{"pattern": "curl -X GET *", "action": "allow"}, {"pattern": "curl *", "action": "ask"}]`
- **THEN** two rules are stored in declaration order with those actions

#### Scenario: Invalid entries dropped

- **WHEN** `permission.bash_args` contains `{"pattern": "", "action": "allow"}` and `{"pattern": "find *", "action": "block"}`
- **THEN** both entries are dropped and a warning names each dropped entry

#### Scenario: Section absent

- **WHEN** `permission.bash_args` is not present in the config
- **THEN** the args rule list is empty and no behavior changes vs. the previous release

### Requirement: Token-based pattern matching with wildcard support

The system SHALL match a segment against an args-rule pattern by whitespace tokenization. A literal pattern token SHALL equal the segment token at the same position (case-sensitive); a `*` pattern token SHALL match any run of zero or more segment tokens. Matching SHALL be anchored at the first token (the command name) and require full consumption of pattern tokens.

#### Scenario: Exact flag sequence

- **WHEN** pattern is `curl -X GET *` and segment is `curl -X GET https://api.com/data`
- **THEN** the pattern matches

#### Scenario: Wildcard between literals

- **WHEN** pattern is `find * -delete` and segment is `find /tmp -name "*.log" -delete`
- **THEN** the pattern matches (`*` spans `/tmp -name "*.log"`)

#### Scenario: Flag not present — no match

- **WHEN** pattern is `find * -delete` and segment is `find /tmp -name "*.log"`
- **THEN** the pattern does not match

#### Scenario: Trailing wildcard matches zero tokens

- **WHEN** pattern is `curl -X GET *` and segment is `curl -X GET`
- **THEN** the pattern matches

#### Scenario: Command name must match

- **WHEN** pattern is `git push --force *` and segment is `hg push --force`
- **THEN** the pattern does not match

#### Scenario: Case-sensitive tokens

- **WHEN** pattern is `curl -X GET *` and segment is `curl -X get https://api.com`
- **THEN** the pattern does not match

#### Scenario: Adjacent flag value required

- **WHEN** pattern is `curl -X GET *` and segment is `curl -X POST https://api.com`
- **THEN** the pattern does not match (`-X` must be followed by `GET`)

#### Scenario: Extra whitespace normalizes

- **WHEN** pattern is `curl -X GET *` and segment is `curl   -X   GET   https://api.com`
- **THEN** the pattern matches

### Requirement: Args rules take precedence over glob rules, first match wins

For each segment, the bash action SHALL be resolved as: first matching `bash_args` rule in declaration order → its action; otherwise existing `permission.bash` glob matching → its action; otherwise no opinion. A narrower args rule declared before a broader one SHALL override it regardless of the glob rules.

#### Scenario: Narrow allow beats broad ask

- **WHEN** `bash_args` is `[{"pattern": "curl -X GET *", "action": "allow"}, {"pattern": "curl *", "action": "ask"}]` and segment is `curl -X GET https://api.com`
- **THEN** the segment's bash action is `allow`

#### Scenario: Broad rule catches the rest

- **WHEN** same config and segment is `curl -X POST https://api.com` (no `-X GET` rule match, `curl *` matches)
- **THEN** the segment's bash action is `ask`

#### Scenario: Fallback to glob rules

- **WHEN** no args rule matches segment `git status` and `permission.bash` has `"git *": "allow"`
- **THEN** the segment's bash action is `allow` via glob matching

#### Scenario: No args rule, no glob rule

- **WHEN** segment `wget evil.sh` matches neither args nor glob rules
- **THEN** the segment has no bash opinion (existing behavior)

### Requirement: Flag-level allow overrides native ask

When a chain's aggregated action is `allow` and at least one segment's allow came from a matching args rule, the plugin SHALL store the `allow` decision for the callID without wrapping the command, and `permission.ask` SHALL set `output.status = "allow"` if opencode still prompts. Chains whose allows come only from glob rules SHALL keep today's no-intervention behavior.

#### Scenario: Native ask suppressed for flag allow

- **WHEN** segment `curl -X GET https://api.com` matches args rule `allow`, native `permission.bash` has `"curl *": "ask"` so opencode prompts
- **THEN** the plugin stores `allow` for the callID and `permission.ask` sets `output.status = "allow"` — command runs without user interaction

#### Scenario: Glob-only allow unchanged

- **WHEN** segment `git status` is allowed only via glob `"git *": "allow"` and native opencode also allows it
- **THEN** the plugin stores nothing and does not intervene

#### Scenario: Flag ask still prompts via native dialog

- **WHEN** segment `find /tmp -delete` matches args rule `ask`
- **THEN** the command is wrapped, `ask` stored, and the user sees the native opencode prompt

#### Scenario: Flag deny blocks

- **WHEN** segment `git push --force origin main` matches args rule `deny` declared before any broader allow
- **THEN** the chain action is `deny` and the command is blocked

### Requirement: Chain aggregation includes args-rule actions

Args-rule actions SHALL participate in existing segment resolution and most-restrictive-wins chain aggregation (deny > ask > allow) with no new aggregation rules.

#### Scenario: Mixed chain aggregates most restrictive

- **WHEN** chain is `git status && find /tmp -delete` where `git status` → allow (glob) and `find /tmp -delete` → ask (args rule)
- **THEN** the chain action is `ask`

#### Scenario: All-allow flag chain force-allows

- **WHEN** chain is `curl -X GET https://a.com && curl -X GET https://b.com` and both segments match the args `allow` rule, native matching would ask
- **THEN** the chain action is `allow`, stored, and enforced as `allow` in `permission.ask`
