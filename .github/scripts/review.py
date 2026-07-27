import json, os, sys, urllib.request

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

system_prompt = 'You are a senior TypeScript code reviewer. Be concise and specific. Cite file paths and line numbers.'
user_prompt = f'Review this PR:\nTitle: {pr["title"]}\n\n```diff\n{diff}\n```'

payload = json.dumps({
    'model': 'gpt-4o-mini',
    'messages': [
        {'role': 'system', 'content': system_prompt},
        {'role': 'user', 'content': user_prompt},
    ],
}).encode()

req = urllib.request.Request(
    'https://models.inference.ai.azure.com/chat/completions',
    data=payload,
    headers={
        'Authorization': f'Bearer {GH_TOKEN}',
        'Content-Type': 'application/json',
    },
)
try:
    with urllib.request.urlopen(req) as r:
        resp = json.loads(r.read())
    review_text = resp['choices'][0]['message']['content']
except Exception as e:
    review_text = f'Review failed: {e}'

comment = gh_api('POST', f'/issues/{PR_NUM}/comments', {'body': review_text})
print(f'Review posted as comment #{comment["id"]}')
