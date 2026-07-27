import json, os, sys, urllib.request

GEMINI_API_KEY = os.environ['GEMINI_API_KEY']
PR_NUM = os.environ['PR_NUM']
GH_TOKEN = os.environ['GH_TOKEN']
GITHUB_API = os.environ.get('GITHUB_API_URL', 'https://api.github.com')
REPO = os.environ['GITHUB_REPOSITORY']

def gh_api(method, path, data=None):
    url = f'{GITHUB_API}/repos/{REPO}{path}'
    headers = {
        'Authorization': f'Bearer {GH_TOKEN}',
        'Accept': 'application/vnd.github+json',
    }
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        print(f'GitHub API error {e.code}: {e.read().decode()}', file=sys.stderr)
        sys.exit(1)


pr = gh_api('GET', f'/pulls/{PR_NUM}')
diff_req = urllib.request.Request(pr['diff_url'], headers={'Authorization': f'Bearer {GH_TOKEN}'})
with urllib.request.urlopen(diff_req) as r:
    diff = r.read().decode()

MAX_DIFF = 60000
if len(diff) > MAX_DIFF:
    diff = diff[:MAX_DIFF] + '\n\n[Diff truncated to {} bytes]'.format(MAX_DIFF)

prompt_text = f"""You are a senior TypeScript code reviewer. Review this pull request and provide concise, actionable feedback. Focus on:
- Logic errors or bugs
- Security issues
- Performance problems
- Code quality / maintainability
- Missing error handling
- Deviations from project conventions

Be specific: cite file paths and line numbers. Be constructive. If the code looks fine, say so briefly.

---
PR Title: {pr['title']}
PR Description: {pr['body'] or ''}

```diff
{diff}
```"""

payload = json.dumps({
    'contents': [{'parts': [{'text': prompt_text}]}]
}).encode()

gemini_url = f'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={GEMINI_API_KEY}'
gemini_req = urllib.request.Request(gemini_url, data=payload, headers={'Content-Type': 'application/json'})
try:
    with urllib.request.urlopen(gemini_req) as r:
        resp = json.loads(r.read())
    review_text = resp['candidates'][0]['content']['parts'][0]['text']
except Exception as e:
    review_text = f'Review failed: {e}'

comment = gh_api('POST', f'/issues/{PR_NUM}/comments', {'body': review_text})
print(f'Review posted as comment #{comment["id"]}')
