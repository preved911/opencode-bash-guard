import json, os, re, sys, time, urllib.request, urllib.error

# GitHub Models (GH_MODELS_TOKEN) was retired 2026-07-30 — do not restore it.
# Free Gemini models 503 under load; AI_MODELS is tried in order until one answers.
# Provider swap: AI_BASE_URL=https://api.groq.com/openai/v1 AI_MODELS=openai/gpt-oss-120b
AI_BASE_URL = os.environ.get(
    'AI_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta/openai').rstrip('/')
AI_MODELS = [m.strip() for m in os.environ.get(
    'AI_MODELS', 'gemini-3.7-flash,gemini-3.5-flash,gemini-3.5-flash-lite').split(',') if m.strip()]
AI_API_KEY = os.environ.get('AI_API_KEY', '')

# Per-request diff budget. The PR diff is split at file boundaries into chunks
# that each fit this budget, so large PRs are reviewed fully instead of being
# cut mid-word — a truncated diff made the model invent "incomplete sentence"
# issues at the cut point (see PR #33).
MAX_CHUNK = 40000

TRANSIENT = {429, 500, 502, 503, 504}

HUNK_RE = re.compile(r'^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@')


def http_request(url, headers, data=None, method='GET', retries=3):
    """Perform an HTTP request with retry on transient failures."""
    body = json.dumps(data).encode() if data is not None else None
    for attempt in range(retries):
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.status, r.read().decode()
        except urllib.error.HTTPError as e:
            error_body = e.read().decode()
            print(f'HTTP {e.code} from {url}: {error_body[:500]}', file=sys.stderr)
            if e.code in TRANSIENT and attempt < retries - 1:
                time.sleep(5 * (attempt + 1))
                continue
            return e.code, error_body
        except Exception as e:
            print(f'Request to {url} failed: {type(e).__name__}: {e}', file=sys.stderr)
            if attempt < retries - 1:
                time.sleep(5 * (attempt + 1))
                continue
            raise
    raise RuntimeError(f'unreachable: retries exhausted for {url}')


def gh_api(path, data=None, accept='application/vnd.github+json', raw=False):
    """Call the GitHub REST API. Returns parsed JSON (or raw text with raw=True), None on failure."""
    url = f'{GITHUB_API}/repos/{REPO}{path}'
    headers = {
        'Authorization': f'Bearer {GH_TOKEN}',
        'Accept': accept,
    }
    method = 'POST' if data is not None else 'GET'
    status, text = http_request(url, headers=headers, data=data, method=method)
    if status not in (200, 201):
        print(f'GitHub API error {status} for {method} {path}', file=sys.stderr)
        return None
    if raw:
        return text
    return json.loads(text)


# --- pure diff helpers (no I/O; separated so they can be unit-tested) ---

def split_file_sections(diff_text):
    """Split a unified diff into one section per file ('diff --git' boundaries)."""
    sections = []
    current = None
    for line in diff_text.splitlines(keepends=True):
        if line.startswith('diff --git '):
            if current:
                sections.append(''.join(current))
            current = [line]
        elif current is not None:
            current.append(line)
    if current:
        sections.append(''.join(current))
    return sections


def section_path(section):
    """New-side file path of a diff section (matches the files API filename)."""
    for line in section.splitlines():
        if line.startswith('+++ b/'):
            return line[len('+++ b/'):].split('\t')[0]
    first = section.splitlines()[0] if section else ''
    m = re.match(r'diff --git a/(.*) b/(.*)$', first)
    if m:
        return m.group(2)
    return ''


def new_side_ranges(section):
    """Inclusive (start, end) ranges of new-side line numbers covered by hunks."""
    ranges = []
    for line in section.splitlines():
        m = HUNK_RE.match(line)
        if m:
            start = int(m.group(1))
            count = int(m.group(2)) if m.group(2) is not None else 1
            if count > 0:
                ranges.append((start, start + count - 1))
    return ranges


def truncate_at_line(text, limit):
    """Hard-cap a section at `limit` bytes without cutting mid-line."""
    if len(text) <= limit:
        return text
    cut = text[:limit]
    nl = cut.rfind('\n')
    if nl > 0:
        cut = cut[:nl + 1]
    return cut + '\n[File diff truncated to stay within the review budget]\n'


def chunk_diff(diff_text, max_chunk=MAX_CHUNK):
    """Pack per-file sections into chunks that each stay within max_chunk bytes."""
    chunks = []
    current = []
    size = 0
    for section in split_file_sections(diff_text):
        if len(section) > max_chunk:
            if current:
                chunks.append(''.join(current))
                current, size = [], 0
            chunks.append(truncate_at_line(section, max_chunk))
            continue
        if current and size + len(section) > max_chunk:
            chunks.append(''.join(current))
            current, size = [], 0
        current.append(section)
        size += len(section)
    if current:
        chunks.append(''.join(current))
    return chunks


# --- main ---

PR_NUM = os.environ['PR_NUM']
GH_TOKEN = os.environ['GH_TOKEN']
GITHUB_API = os.environ.get('GITHUB_API_URL', 'https://api.github.com')
REPO = os.environ['GITHUB_REPOSITORY']

if not AI_API_KEY:
    print('AI_API_KEY is not set — cannot call the inference API.', file=sys.stderr)
    sys.exit(1)

pr = gh_api(f'/pulls/{PR_NUM}')
files = []
page = 1
while True:
    batch = gh_api(f'/pulls/{PR_NUM}/files?per_page=100&page={page}')
    if not batch:
        break
    files.extend(batch)
    if len(batch) < 100:
        break
    page += 1
if pr is None or not files:
    print('Could not fetch PR metadata — aborting so the failure is visible.', file=sys.stderr)
    sys.exit(1)

# Fetch the unified diff via the API (no cross-host redirect). If it fails,
# fall back to per-file patches from the files endpoint, with `diff --git`
# headers restored so chunking can still split per file.
diff = gh_api(f'/pulls/{PR_NUM}', accept='application/vnd.github.diff', raw=True)
if not diff:
    print('Diff endpoint failed, falling back to per-file patches', file=sys.stderr)
    diff = '\n'.join(
        f"diff --git a/{f['filename']} b/{f['filename']}\n{f.get('patch', '')}"
        for f in files if f.get('patch')
    )

chunks = chunk_diff(diff)
if not chunks:
    comment = gh_api(f'/issues/{PR_NUM}/comments', data={'body': '## 👀 AI Code Review\n\nLGTM\n'})
    print(f'Review posted as comment #{comment["id"] if comment else "?"}')
    sys.exit(0)


def request_review(prompt):
    """Try each model in order; 503 under load is common on free tiers.

    Returns (review_data, used_model) or raises. Fatal on final failure: a
    silent fallback comment here is how every run "succeeded" for days while
    the review itself never worked.
    """
    request_body = {
        'messages': [
            {'role': 'system', 'content': 'You are a senior engineer doing code review. Be concise and direct. Respond in valid JSON: {"summary": "...", "comments": [{"path": "...", "line": 0, "side": "RIGHT", "body": "..."}]}'},
            {'role': 'user', 'content': prompt},
        ],
        'response_format': {'type': 'json_object'},
    }
    last_status = None
    for model in AI_MODELS:
        request_body['model'] = model
        status, text = http_request(f'{AI_BASE_URL}/chat/completions', headers={
            'Authorization': f'Bearer {AI_API_KEY}',
            'Content-Type': 'application/json',
        }, data=request_body, method='POST')
        if status == 200:
            try:
                resp = json.loads(text)
                return json.loads(resp['choices'][0]['message']['content']), model
            except (KeyError, IndexError, ValueError) as e:
                print(f'{model} returned a malformed response: {e}', file=sys.stderr)
        else:
            print(f'{model} -> HTTP {status}', file=sys.stderr)
        last_status = status
        if status in (401, 403):
            print('API key rejected — remaining models would fail identically.', file=sys.stderr)
            break
    raise RuntimeError(f'all models failed (last HTTP {last_status})')


def build_prompt(chunk, index, total, files_listing):
    part = f'part {index} of {total}' if total > 1 else 'the complete diff'
    return f"""You are a senior engineer reviewing a PR. Be direct and concise.

Review the PR and respond in JSON with two parts:
1. "summary": 1-3 sentence overview — only call out what matters
2. "comments": inline comments on specific lines (optional). Each has:
   - "path": file path
   - "line": line number
   - "side": "RIGHT"
   - "body": your comment (short, specific, actionable)

Guidelines:
- Skip fluff and praise — only actual observations
- If everything looks fine, summary can be "LGTM"
- 0-3 inline comments — only for real issues or questions
- Be direct: "Use Set instead of Array for dedup" not "What do you think about..."
- The diff below is {part} of the PR diff. Only comment on files that appear in it, and only on line numbers that appear in its hunks.
- "[File diff truncated ...]" markers are intentional budget cuts; never comment on truncation itself.

PR title: {pr['title']}
PR description: {pr.get('body', '(none)') or '(none)'}

Files changed in this part:
{files_listing}

Diff:
```diff
{chunk}
```"""


summaries = []
valid_comments = []
invalid_comments = []
models_used = []
failed_chunks = []

for index, chunk in enumerate(chunks, 1):
    sections = split_file_sections(chunk)
    paths = []
    ranges_by_path = {}
    for section in sections:
        path = section_path(section)
        if path:
            paths.append(path)
            ranges_by_path[path] = new_side_ranges(section)
    files_listing = '\n'.join(f'- `{p}`' for p in paths) or '(none)'

    try:
        review_data, used_model = request_review(build_prompt(chunk, index, len(chunks), files_listing))
    except RuntimeError as e:
        print(f'diff part {index}/{len(chunks)} failed: {e}', file=sys.stderr)
        failed_chunks.append(index)
        continue

    models_used.append(used_model)
    summary = review_data.get('summary', '')
    if summary:
        summaries.append(summary)

    for c in review_data.get('comments', []):
        body = c.get('body', '')
        path = c.get('path', '')
        try:
            line = int(c.get('line', 0))
        except (TypeError, ValueError):
            invalid_comments.append(c)
            continue
        ranges = ranges_by_path.get(path)
        if not body or not path or not line or ranges is None or not any(a <= line <= b for a, b in ranges):
            invalid_comments.append(c)
            continue
        valid_comments.append({'path': path, 'line': line, 'side': c.get('side', 'RIGHT'), 'body': body})

# Fatal only when nothing was reviewed at all — a partial failure still posts
# the parts that succeeded, with a note naming the uncovered parts.
if failed_chunks and len(failed_chunks) == len(chunks):
    print('All diff parts failed to review — aborting so the failure is visible.', file=sys.stderr)
    sys.exit(1)

meaningful = [s for s in summaries if s and s.strip().upper() != 'LGTM']
summary = '\n\n'.join(meaningful) if meaningful else 'LGTM'
extra = ''
if failed_chunks:
    extra += f"\n\n*Partial coverage: diff part(s) {', '.join(map(str, failed_chunks))} of {len(chunks)} could not be reviewed.*"
if invalid_comments:
    extra += "\n\n*Couldn't place inline comments for:*\n" + '\n'.join(
        f"- `{c.get('path','?')}:{c.get('line','?')}` — {c.get('body','')[:80]}"
        for c in invalid_comments
    )

model_note = ', '.join(sorted(set(models_used))) if models_used else 'none'
body = f"## 👀 AI Code Review\n\n{summary}{extra}\n\n---\n*Powered by {model_note}*"

if valid_comments:
    review = gh_api(f'/pulls/{PR_NUM}/reviews', data={
        'body': body,
        'event': 'COMMENT',
        'comments': valid_comments,
    })
    if review:
        print(f'Review submitted with {len(valid_comments)} inline comments across {len(chunks)} diff part(s)')
    else:
        print('Inline review failed, posting as single comment', file=sys.stderr)
        comment = gh_api(f'/issues/{PR_NUM}/comments', data={'body': body})
        print(f'Review posted as comment #{comment["id"] if comment else "?"}')
else:
    comment = gh_api(f'/issues/{PR_NUM}/comments', data={'body': body})
    print(f'Review posted as comment #{comment["id"] if comment else "?"}')
