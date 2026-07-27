import json, os, sys, time, re, urllib.request

PR_NUM = os.environ['PR_NUM']
GH_TOKEN = os.environ['GH_TOKEN']
GH_MODELS_TOKEN = os.environ.get('GH_MODELS_TOKEN', '')
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
files = gh_api('GET', f'/pulls/{PR_NUM}/files')

diff_req = urllib.request.Request(pr['diff_url'], headers={'Authorization': f'Bearer {GH_TOKEN}'})
with urllib.request.urlopen(diff_req) as r:
    diff = r.read().decode()

MAX_DIFF = 12000
if len(diff) > MAX_DIFF:
    diff = diff[:MAX_DIFF] + '\n\n[Diff truncated to {} bytes]'.format(MAX_DIFF)

changed_files = '\n'.join(f"- `{f['filename']}` ({f['status']}, +{f['additions']}/-{f['deletions']})" for f in files[:20])

prompt = f"""You are a thoughtful senior engineer doing a code review on a colleague's PR. Be human — not like a robot dumping a checklist.

Your tone should be:
- Friendly and respectful — this is a conversation with another dev
- Curious, not commanding — ask "What do you think about…?" instead of "Fix this"
- Specific — reference file paths and line numbers
- Constructive — point out what's done well too, not just issues
- Concise — a few paragraphs, not a novel

Structure your review naturally, like how you'd talk to a teammate:
1. A warm opening — acknowledge the work ("Nice PR! This cleans things up nicely.")
2. A quick summary of what the PR does
3. A few specific observations — both what works well and suggestions
4. Optional: any questions or things you're unsure about
5. A closing note — encouraging, open for discussion

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
        {'role': 'user', 'content': prompt},
    ],
}).encode()

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
        review_text = resp['choices'][0]['message']['content']
        break
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        if e.code == 429 and attempt < 2:
            time.sleep(5)
            continue
        review_text = f'Had trouble generating the review (attempt {attempt + 1}/3): HTTP {e.code} — will retry.'
    except Exception as e:
        review_text = f'Something went wrong during review: {e}'
        break

body = f"## 👀 AI Code Review\n\n{review_text}\n\n---\n*Powered by GPT-4o via GitHub Models*"

comment = gh_api('POST', f'/issues/{PR_NUM}/comments', {'body': body})
print(f'Review posted as comment #{comment["id"]}')
