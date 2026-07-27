import json, os, sys, time, urllib.request

PR_NUM = os.environ['PR_NUM']
GH_TOKEN = os.environ['GH_TOKEN']
GEMINI_KEY = os.environ.get('GEMINI_API_KEY', '')
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

prompt = f"You are a senior TypeScript code reviewer. Review this PR. Cite file paths and line numbers. Be concise.\n\nPR: {pr['title']}\n\n```diff\n{diff}\n```"

payload = json.dumps({
    'contents': [{'parts': [{'text': prompt}]}]
}).encode()

url = f'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={GEMINI_KEY}'

for attempt in range(3):
    try:
        req = urllib.request.Request(url, data=payload, headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req) as r:
            resp = json.loads(r.read())
        review_text = resp['candidates'][0]['content']['parts'][0]['text']
        break
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        if e.code == 429 and attempt < 2:
            time.sleep(5)
            continue
        review_text = f'Review failed (attempt {attempt + 1}/3): HTTP {e.code}'
    except Exception as e:
        review_text = f'Review failed: {e}'
        break

comment = gh_api('POST', f'/issues/{PR_NUM}/comments', {'body': review_text})
print(f'Review posted as comment #{comment["id"]}')
