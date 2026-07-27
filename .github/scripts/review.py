import json, os, sys, time, re, urllib.request

PR_NUM = os.environ['PR_NUM']
GH_TOKEN = os.environ['GH_TOKEN']
GH_MODELS_TOKEN = os.environ.get('GH_MODELS_TOKEN', '')
GITHUB_API = os.environ.get('GITHUB_API_URL', 'https://api.github.com')
REPO = os.environ['GITHUB_REPOSITORY']


def gh_api(method, path, data=None, raw=False):
    url = f'{GITHUB_API}/repos/{REPO}{path}'
    headers = {
        'Authorization': f'Bearer {GH_TOKEN}',
        'Accept': 'application/vnd.github+json',
    }
    if data is not None:
        headers['Content-Type'] = 'application/json'
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as r:
            if raw:
                return r.read().decode()
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        error_body = e.read().decode()
        print(f'GitHub API error {e.code}: {error_body}', file=sys.stderr)
        if raw:
            return None
        return None


pr = gh_api('GET', f'/pulls/{PR_NUM}')
files = gh_api('GET', f'/pulls/{PR_NUM}/files')

diff_req = urllib.request.Request(pr['diff_url'], headers={'Authorization': f'Bearer {GH_TOKEN}'})
with urllib.request.urlopen(diff_req) as r:
    diff = r.read().decode()

MAX_DIFF = 12000
if len(diff) > MAX_DIFF:
    diff = diff[:MAX_DIFF] + '\n\n[Diff truncated to {} bytes]'.format(MAX_DIFF)

changed_files = '\n'.join(f"- `{f['filename']}` ({f['status']}, +{f['additions']}/-{f['deletions']})" for f in files[:20])

prompt = f"""You are a thoughtful senior engineer doing a code review on a colleague's PR. Be human.

Review the PR below and respond in JSON format with two parts:
1. "summary": a friendly, conversational overview of the PR (2-4 paragraphs)
2. "comments": an array of inline comments on specific lines. Each comment has:
   - "path": file path
   - "line": line number in the file
   - "side": "RIGHT" (for new/changed lines)
   - "body": your comment (friendly tone, specific, actionable)

Guidelines:
- Start with what's done well, then suggest improvements
- Be curious, not commanding — "What do you think about…?" instead of "Fix this"
- Only add inline comments for genuinely interesting observations
- Don't inline-comment trivial things (typos, formatting are fine)
- 0-5 inline comments is ideal — quality over quantity

PR title: {pr['title']}
PR description: {pr.get('body', '(none)') or '(none)'}

Files changed:
{changed_files}

Diff:
```diff
{diff}
```"""

payload = json.dumps({
    'model': 'gpt-4o-mini',
    'messages': [
        {'role': 'system', 'content': 'You are a friendly senior engineer. Always respond in valid JSON: {{"summary": "...", "comments": [{{"path": "...", "line": 0, "side": "RIGHT", "body": "..."}}]}}'},
        {'role': 'user', 'content': prompt},
    ],
    'response_format': {'type': 'json_object'},
}).encode()

review_data = None
for attempt in range(3):
    try:
        req = urllib.request.Request(
            'https://models.inference.ai.azure.com/chat/completions',
            data=payload,
            headers={
                'Authorization': f'Bearer {GH_MODELS_TOKEN}',
                'Content-Type': 'application/json',
            },
        )
        with urllib.request.urlopen(req) as r:
            resp = json.loads(r.read())
        review_data = json.loads(resp['choices'][0]['message']['content'])
        break
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        if e.code == 429 and attempt < 2:
            time.sleep(5)
            continue
        review_data = {'summary': f'Had trouble generating the review (attempt {attempt + 1}/3): HTTP {e.code}.', 'comments': []}
    except Exception as e:
        review_data = {'summary': f'Something went wrong: {e}', 'comments': []}
        break

if review_data is None:
    review_data = {'summary': 'Review could not be generated.', 'comments': []}

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
    extra = '\n\n*Couldn't place inline comments for:*\n' + '\n'.join(
        f"- `{c.get('path','?')}:{c.get('line','?')}` — {c.get('body','')[:80]}"
        for c in invalid_comments
    )
else:
    extra = ''

summary = review_data.get('summary', '')
body = f"## 👀 AI Code Review\n\n{summary}{extra}\n\n---\n*Powered by GPT-4o via GitHub Models*"

if valid_comments:
    review = gh_api('POST', f'/pulls/{PR_NUM}/reviews', {
        'body': body,
        'event': 'COMMENT',
        'comments': valid_comments,
    })
    if review:
        print(f'Review submitted with {len(valid_comments)} inline comments')
    else:
        print('Inline review failed, posting as single comment', file=sys.stderr)
        comment = gh_api('POST', f'/issues/{PR_NUM}/comments', {'body': body})
        print(f'Review posted as comment #{comment["id"]}')
else:
    comment = gh_api('POST', f'/issues/{PR_NUM}/comments', {'body': body})
    print(f'Review posted as comment #{comment["id"]}')
