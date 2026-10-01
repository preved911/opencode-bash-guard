import json, os, sys, time, urllib.request, urllib.error

PR_NUM = os.environ['PR_NUM']
GH_TOKEN = os.environ['GH_TOKEN']
GITHUB_API = os.environ.get('GITHUB_API_URL', 'https://api.github.com')
REPO = os.environ['GITHUB_REPOSITORY']

# GitHub Models (GH_MODELS_TOKEN) was retired 2026-07-30 — do not restore it.
# Free Gemini models 503 under load; AI_MODELS is tried in order until one answers.
# Provider swap: AI_BASE_URL=https://api.groq.com/openai/v1 AI_MODELS=openai/gpt-oss-120b
AI_BASE_URL = os.environ.get(
    'AI_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta/openai').rstrip('/')
AI_MODELS = [m.strip() for m in os.environ.get(
    'AI_MODELS', 'gemini-3.7-flash,gemini-2.5-flash,gemini-2.5-flash-lite').split(',') if m.strip()]
AI_API_KEY = os.environ.get('AI_API_KEY', '')

TRANSIENT = {429, 500, 502, 503, 504}


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


if not AI_API_KEY:
    print('AI_API_KEY is not set — cannot call the inference API.', file=sys.stderr)
    sys.exit(1)

pr = gh_api(f'/pulls/{PR_NUM}')
files = gh_api(f'/pulls/{PR_NUM}/files')
if pr is None or files is None:
    print('Could not fetch PR metadata — aborting so the failure is visible.', file=sys.stderr)
    sys.exit(1)

# Fetch the unified diff via the API (no cross-host redirect). If it fails,
# fall back to per-file patches from the files endpoint.
diff = gh_api(f'/pulls/{PR_NUM}', accept='application/vnd.github.diff', raw=True)
if not diff:
    print('Diff endpoint failed, falling back to per-file patches', file=sys.stderr)
    diff = '\n\n'.join(f.get('patch', '') for f in files if f.get('patch'))

MAX_DIFF = 12000
if len(diff) > MAX_DIFF:
    diff = diff[:MAX_DIFF] + '\n\n[Diff truncated to {} bytes]'.format(MAX_DIFF)

changed_files = '\n'.join(f"- `{f['filename']}` ({f['status']}, +{f['additions']}/-{f['deletions']})" for f in files[:20])

prompt = f"""You are a senior engineer reviewing a PR. Be direct and concise.

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

PR title: {pr['title']}
PR description: {pr.get('body', '(none)') or '(none)'}

Files changed:
{changed_files}

Diff:
```diff
{diff}
```"""

request_body = {
    'messages': [
        {'role': 'system', 'content': 'You are a senior engineer doing code review. Be concise and direct. Respond in valid JSON: {{"summary": "...", "comments": [{{"path": "...", "line": 0, "side": "RIGHT", "body": "..."}}]}}'},
        {'role': 'user', 'content': prompt},
    ],
    'response_format': {'type': 'json_object'},
}

# Try each model in order; 503 under load is common on free tiers.
# Fatal on final failure: a silent fallback comment here is how every run
# "succeeded" for days while the review itself never worked.
review_data = None
used_model = None
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
            review_data = json.loads(resp['choices'][0]['message']['content'])
            used_model = model
            break
        except (KeyError, IndexError, ValueError) as e:
            print(f'{model} returned a malformed response: {e}', file=sys.stderr)
    else:
        print(f'{model} -> HTTP {status}', file=sys.stderr)
    last_status = status
    if status in (401, 403):
        print('API key rejected — remaining models would fail identically.', file=sys.stderr)
        break

if review_data is None:
    print(f'All models failed (last HTTP {last_status}) — aborting.', file=sys.stderr)
    sys.exit(1)

valid_comments = []
invalid_comments = []
changed_paths = {f['filename']: f for f in files}

for c in review_data.get('comments', []):
    path = c.get('path', '')
    line = c.get('line', 0)
    side = c.get('side', 'RIGHT')
    body = c.get('body', '')
    if not path or not line or not body:
        invalid_comments.append(c)
        continue
    if path not in changed_paths:
        invalid_comments.append(c)
        continue
    valid_comments.append({'path': path, 'line': line, 'side': side, 'body': body})

if invalid_comments:
    extra = "\n\n*Couldn't place inline comments for:*\n" + '\n'.join(
        f"- `{c.get('path','?')}:{c.get('line','?')}` — {c.get('body','')[:80]}"
        for c in invalid_comments
    )
else:
    extra = ''

summary = review_data.get('summary', '')
body = f"## 👀 AI Code Review\n\n{summary}{extra}\n\n---\n*Powered by {used_model}*"

if valid_comments:
    review = gh_api(f'/pulls/{PR_NUM}/reviews', data={
        'body': body,
        'event': 'COMMENT',
        'comments': valid_comments,
    })
    if review:
        print(f'Review submitted with {len(valid_comments)} inline comments')
    else:
        print('Inline review failed, posting as single comment', file=sys.stderr)
        comment = gh_api(f'/issues/{PR_NUM}/comments', data={'body': body})
        print(f'Review posted as comment #{comment["id"] if comment else "?"}')
else:
    comment = gh_api(f'/issues/{PR_NUM}/comments', data={'body': body})
    print(f'Review posted as comment #{comment["id"] if comment else "?"}')
