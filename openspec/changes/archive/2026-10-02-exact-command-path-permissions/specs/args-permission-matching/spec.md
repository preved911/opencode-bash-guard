## MODIFIED Requirements

### Requirement: Parse permissions rules from the plugin config file

The system SHALL read an optional `permissions` array from the plugin config file `opencode-bash-guard.jsonc` (project `.opencode/` and global opencode config dir, project wins) into typed tool entries `{ tool: string, args: ArgMatcher[] }`. Each arg matcher SHALL declare exactly one of `token: string | string[]` or `position: number | "all"`. An array `token` declares a command path: an ordered list of tokens that must all appear in the segment (matched anywhere; see the matching requirement). `pattern: string` is REQUIRED with `position` (globs that positional slot) and OPTIONAL with a single-string `token` only (when present it globs the value token immediately following the matched flag); `pattern` combined with an array `token` is invalid. Nested `args` trees are no longer part of the schema: a matcher declaring `args` is invalid. A matcher MAY omit `action`; an omitted action SHALL normalize to `"ask"`. When present, `action` MUST be `"allow" | "ask" | "deny"`. Entries failing validation SHALL be dropped with a warning naming them. When the file or section is absent, the parsed rule list SHALL be empty and plugin behavior SHALL be identical to before this change. When the file fails to parse as JSONC, the plugin SHALL enter degraded mode: `permissions` is treated as absent AND glob allows are suspended for that run, every bash segment SHALL resolve to `ask` (parse-error segments still deny), with a warning naming the file, so a broken config can never silently disable `deny` rules that were meant to be active.

#### Scenario: Valid entries parse

- **WHEN** `permissions` contains `{ "tool": "find", "args": [{ "token": "-delete", "action": "ask" }, { "position": 0, "pattern": "/Users/me/work/**", "action": "allow" }] }`
- **THEN** one tool entry is stored with two validated arg matchers

#### Scenario: Array token parses as a path

- **WHEN** `permissions` contains `{ "tool": "git", "args": [{ "token": ["push", "--force"], "action": "deny" }] }`
- **THEN** one matcher is stored with a two-element command path and action `deny`

#### Scenario: Omitted action defaults to ask

- **WHEN** `permissions` contains `{ "tool": "find", "args": [{ "token": "-delete" }] }`
- **THEN** the matcher is stored with its action normalized to `ask`

#### Scenario: Invalid entries dropped with warning

- **WHEN** `permissions` contains an entry without `tool`, a matcher with both `token` and `position`, a matcher with neither `token` nor `position`, one with `action: "block"`, a legacy matcher declaring nested `args`, and a matcher combining `pattern` with an array `token`
- **THEN** each invalid entry is dropped and a warning names it

#### Scenario: Section absent

- **WHEN** `opencode-bash-guard.jsonc` does not exist or has no `permissions` section
- **THEN** the args rule list is empty and no behavior changes vs. the previous release

#### Scenario: Broken config file degrades to ask-everything

- **WHEN** `opencode-bash-guard.jsonc` contains a JSONC syntax error and native config has `"find *": "allow"`, `"*": "ask"`
- **THEN** a warning names the parse error and every bash segment resolves to `ask`; `find /tmp -delete` is **not** silently allowed by the glob allow; the prompt persists until the config is fixed

### Requirement: Structured arg matcher semantics

The system SHALL match a segment's tokens against arg matchers independently — each matcher is evaluated against the full segment token list on its own, and no matcher consumes tokens on behalf of another. Tokens SHALL be argv-style and quote-aware, derived from the same AST parse the chain splitter performs, with matched quote pairs stripped (`"--force"` matches as `--force`) and quoted whitespace kept within a token (`echo "a b"` yields one arg), so quoting cannot hide a flag from a matcher. Commands whose chain parse failed never reach matcher evaluation (they fail closed earlier). A string `token` matcher matches any equal token and consumes it within its own evaluation; when it declares `pattern`, it SHALL match only via exact token equality and additionally consumes the next token as its value only when that token exists and glob-matches the pattern. `token` matching SHALL additionally expand clustered short flags: a target of one letter after `-` (e.g. `-f`) SHALL also match a clustered token of single-letter short flags (e.g. `-rf`); other forms are not expanded, and cluster-expanded matches never consume a following value. An array `token` declares a command path: its elements SHALL match in array order, each against any distinct unconsumed token of the segment, so the command's own token order is irrelevant and global flags match wherever they appear (`["get", "--namespace=kube-system"]` matches `kubectl get --namespace=kube-system pods` and `kubectl --namespace=kube-system get pods`). Elements match by exact whole-token equality; a path element never prefix-matches a longer token (`["push", "--force"]` does not match `--force-with-lease`). All elements MUST match for the path to match, and leftover trailing tokens do not invalidate a match (`["push", "--force"]` matches `git push --force origin main`). A `position`+`pattern` matcher matches the N-th **positional** token: tokens after the tool name that do not start with `-`, counted on the original token list independent of every other matcher. Flags never occupy a positional slot; a flag value without a dash counts as a positional (documented heuristic limitation). `position: "all"` is the single variable-arity notation: its candidates are the tokens that do not start with `-`, and its quantifier SHALL be derived from `action` so the matcher always fails safe: with `action: "allow"`, every candidate MUST glob-match the pattern (one mismatch or zero candidates means no match); with `action: "ask"` or `"deny"`, at least one candidate glob-matching the pattern is sufficient (zero candidates means no match). Matching is case-sensitive. Commands whose chain parse failed never reach matcher evaluation (they fail closed earlier).

#### Scenario: Quoted flag cannot bypass a deny

- **WHEN** tool entry is `git` with `{ "token": ["push", "--force"], "action": "deny" }` and segment is `git push "--force" origin main`
- **THEN** the token is argv-style `--force` (quotes stripped) and the path matches — quoting does not bypass the deny

#### Scenario: Clustered short flags match single-letter targets

- **WHEN** matcher is `{ "tool": "rm", "args": [{ "token": "-f", "action": "deny" }] }` and segment is `rm -rf /tmp/x`
- **THEN** the clustered token `-rf` expands for matching and `-f` matches, contributing `deny`

#### Scenario: Cluster matches do not consume — sibling flags still match

- **WHEN** an `rm` entry declares both `{ "token": "-r", "action": "deny" }` and `{ "token": "-f", "action": "ask" }`, and segment is `rm -rf /tmp/x`
- **THEN** both matchers match the same clustered token independently (matchers never consume on behalf of one another) and contribute (`deny`, `ask`); the args-level action is `deny`

#### Scenario: Token value matchers do not match via cluster expansion

- **WHEN** matcher is `{ "token": "-f", "pattern": "/tmp/**", "action": "deny" }` and segment is `rm -rf /tmp/x`
- **THEN** the matcher does not match; a value cannot be attributed to one letter of a cluster; token value matching requires exact token equality (`rm -f /tmp/x` would match)

#### Scenario: Key=value options are ordinary candidates

- **WHEN** matcher is `{ "position": "all", "pattern": "/dev/**", "action": "deny" }` and segment is `dd if=/dev/sda of=/dev/sdb`
- **THEN** the candidates are the full tokens `if=/dev/sda` and `of=/dev/sdb`, neither glob-matches `/dev/**`, and the matcher does not match; key=value options are not decomposed (documented limitation; the pattern must match the full token, e.g. `if=/dev/**`)

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

#### Scenario: Numeric position counts positional arguments only — flags never shift the index

- **WHEN** a `find` entry declares `{ "token": "-delete", "action": "ask" }` and `{ "position": 0, "pattern": "/tmp/**", "action": "allow" }`, and segments are `find /tmp -delete` and `find -delete /tmp`
- **THEN** both segments resolve `position: 0` to the first positional `/tmp` — flags (`-delete`) never occupy a positional slot regardless of where they appear; `-delete` also matches its token matcher (`ask`), so both contribute (`ask`, `allow`) and the args-level action is `ask`

#### Scenario: Flag values without a dash count as positionals (heuristic limitation)

- **WHEN** matcher is `{ "position": 0, "pattern": "/Users/me/work/**", "action": "allow" }` and segment is `find -name x.txt`
- **THEN** `x.txt` (the `-name` value) counts as positional 0 and does not glob-match; the matcher does not match; only dash-prefixed tokens are recognized as flags

#### Scenario: Inserted global flag no longer shifts positional indices — its value does

- **WHEN** matcher is `{ "position": 0, "pattern": "push", "action": "allow" }` on tool `git`, and segments are `git push --force` and `git -c key=val push --force`
- **THEN** in `git push --force` position 0 is `push` (matches); in `git -c key=val push --force` the flag `-c` is skipped but its value `key=val` occupies position 0; the matcher does not match and the segment falls to the glob level (documented heuristic limitation)

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
- **THEN** the matcher matches (`/etc/passwd` glob-matches) and contributes `deny`; the mixed command cannot escape the deny

#### Scenario: All-position with deny — no matching candidate means no match

- **WHEN** same matcher and segment is `rm /Users/me/work/a.txt /Users/me/work/b.txt`
- **THEN** the matcher does not match and contributes nothing; the segment falls to the glob level

#### Scenario: All-position with deny — no candidates means no match

- **WHEN** same matcher and segment is `rm -rf` (only flag-like tokens)
- **THEN** the matcher does not match

#### Scenario: All-position combines with other matchers

- **WHEN** a `find` entry declares both `{ "position": "all", "pattern": "/Users/me/work/**", "action": "allow" }` and `{ "token": "-delete", "action": "deny" }`, and segment is `find /Users/me/work/a /Users/me/work/b -delete`
- **THEN** both matchers contribute (`allow`, `deny`) and the args-level action is `deny`; the command is allowed except with `-delete`

#### Scenario: Flag value pattern

- **WHEN** matcher is `{ "token": "-X", "pattern": "GET", "action": "allow" }` and segment is `curl -X GET https://api.com`
- **THEN** the matcher matches (`-X` matched and its value `GET` glob-matches); for `curl -X POST https://api.com` it does not

#### Scenario: Nested subcommand rules

- **WHEN** tool entry is `git` with `{ "token": ["push", "--force"], "action": "deny" }` and segment is `git push --force origin main`
- **THEN** the path matches and contributes only `deny`; a path rule is self-contained — there is no ancestor action to accumulate

#### Scenario: Nested rules require the parent token

- **WHEN** tool entry is `git` with `{ "token": ["push", "--force"], "action": "deny" }` and segments are `git status`, `git push`, and `git commit --force-ish`
- **THEN** none match: every path element must be present (`git push` lacks `--force`), and elements match whole tokens exactly (`--force-ish` is not `--force`)

#### Scenario: Consumed tokens are not rematched

- **WHEN** matcher is `{ "token": ["push", "--force", "--force"], "action": "deny" }` and segments are `git push --force origin` and `git push --force --force`
- **THEN** the first does not match (path elements consume distinct tokens — two `--force` elements require two `--force` tokens); the second matches

#### Scenario: Path matches regardless of argument order

- **WHEN** matcher is `{ "token": ["get", "--namespace=kube-system"], "action": "deny" }` on tool `kubectl`, and segments are `kubectl get --namespace=kube-system pods` and `kubectl --namespace=kube-system get pods`
- **THEN** both match: path elements consume distinct unconsumed tokens in array order, anywhere in the segment

#### Scenario: Path rule covers trailing arguments

- **WHEN** matcher is `{ "token": ["push", "--force"], "action": "deny" }` and segment is `git push --force origin main`
- **THEN** the path matches and contributes `deny` — leftover ordinary arguments never invalidate a match

#### Scenario: Path with separate-token flag value

- **WHEN** matcher is `{ "token": ["get", "--namespace", "kube-system"], "action": "deny" }` and segments are `kubectl get --namespace kube-system pods` and `kubectl get --namespace default pods`
- **THEN** the first matches (elements `get`, `--namespace`, `kube-system` all present) and the second does not (`kube-system` absent)

### Requirement: Most-restrictive-wins among matched args rules

When one or more matchers match a segment, matching matchers that are REFINED by another matching matcher SHALL first be discarded, and the segment's args-level action SHALL be the most restrictive among the remaining actions (`deny` > `ask` > `allow`), regardless of declaration order. Matcher A refines matcher B only when both are token matchers and either B's token path is a proper element-prefix of A's token path (a longer path describes a narrower command), or A and B declare the same single-string token and A declares a `pattern` where B does not (a value-constrained matcher describes a narrower command set). Refinement wins in whichever direction it points: a refined general rule is discarded even when it was more restrictive, and a refined specific rule overrides the general one. Position matchers never refine and are never refined; incomparable matchers — including any token matcher against a position matcher, or two different paths of equal length — SHALL reduce together most-restrictive-wins, so a global-flag `deny` or `ask` can never be silently defeated by an unrelated exact-path `allow`. If no matcher matches, the segment SHALL have no args-level opinion.

#### Scenario: Ask wins over allow

- **WHEN** segment `find /Users/me/work/logs -delete` matches both `-delete → ask` and position-0 `allow` matchers
- **THEN** the matchers are incomparable (position matchers never refine) and the args-level action is `ask`

#### Scenario: Deny wins over ask

- **WHEN** segment `find /etc/cron -delete` matches `{ "token": "-delete", "action": "deny" }` and `{ "position": "all", "pattern": "/etc/**", "action": "ask" }`
- **THEN** the matchers are incomparable and the args-level action is `deny`

#### Scenario: Single match decides

- **WHEN** segment `find /Users/me/work/logs -type f` matches only the position-0 `allow` matcher
- **THEN** the args-level action is `allow`

#### Scenario: No match — no opinion

- **WHEN** segment `find /tmp -type f` matches no matcher of the `find` entry
- **THEN** the segment has no args-level opinion

#### Scenario: Refined prefix rule is discarded

- **WHEN** a `git` entry declares `{ "token": ["push"], "action": "deny" }` and `{ "token": ["push", "--force"], "action": "ask" }`, and segment is `git push --force`
- **THEN** the `["push"]` rule is refined by the `["push", "--force"]` rule and discarded; the args-level action is `ask` — not the most-restrictive `deny`

#### Scenario: Refinement can loosen — allow exception under deny

- **WHEN** a `git` entry declares `{ "token": ["push"], "action": "deny" }` and `{ "token": ["push", "--force-with-lease"], "action": "allow" }`, and segments are `git push --force-with-lease origin` and `git push origin`
- **THEN** the first segment resolves to `allow` (the refined rule overrides the deny), and the second to `deny` (the prefix rule still covers every unlisted path)

#### Scenario: Global flag ask survives an exact-path allow

- **WHEN** a `kubectl` entry declares `{ "token": ["get", "pods"], "action": "allow" }` and `{ "token": ["--namespace=kube-system"], "action": "ask" }`, and segment is `kubectl get pods --namespace=kube-system`
- **THEN** neither rule refines the other (the bare-flag path is not a prefix of the exact path), so both reduce most-restrictive-wins and the args-level action is `ask`

#### Scenario: Value-constrained matcher refines its bare token

- **WHEN** a `curl` entry declares `{ "token": "-X", "action": "deny" }` and `{ "token": "-X", "pattern": "GET", "action": "allow" }`, and segments are `curl -X GET https://api.com` and `curl -X POST https://api.com`
- **THEN** the first resolves to `allow` (the pattern rule refines the bare token and overrides it), and the second to `deny` (the pattern does not match, only the bare rule remains)
