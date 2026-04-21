#!/usr/bin/env bash
# weekly-review-prefetch.sh — collect deterministic data for /weekly-review synth.
# Runs inside NanoClaw task-spawn container (node:22-slim base).
# Output contract: last non-empty stdout line is JSON {"wakeAgent":true,"data":{...}}.
# All JSON + sqlite done via python3 stdlib; no jq, no sqlite3 CLI (both absent in base image).
set -euo pipefail

python3 - <<'PY'
import json, os, re, sqlite3, subprocess
from datetime import datetime, timezone, timedelta

STATE_FILE = '/workspace/group/last-review.json'
VAULT_ROOT = '/workspace/extra/vault'
STORE_DB   = '/workspace/project/store/messages.db'

# ── Window ────────────────────────────────────────────────────────────────────
now_utc   = datetime.now(timezone.utc)
now_ts    = now_utc.strftime('%Y-%m-%dT%H:%M:%SZ')

if os.path.exists(STATE_FILE):
    state        = json.loads(open(STATE_FILE).read())
    last_ts      = state['last_review_ts']
    review_count = int(state.get('review_count', 0))
    first_run    = False
else:
    last_ts      = (now_utc - timedelta(days=7)).strftime('%Y-%m-%dT%H:%M:%SZ')
    review_count = 0
    first_run    = True

try:
    window_dt = datetime.fromisoformat(last_ts.replace('Z', '+00:00'))
except Exception:
    window_dt = now_utc - timedelta(days=7)
    last_ts   = window_dt.strftime('%Y-%m-%dT%H:%M:%SZ')
window_epoch = window_dt.timestamp()

# ── Vault walker ──────────────────────────────────────────────────────────────
SKIP_DIRS = frozenset({'.git', '.obsidian', 'worf-scope'})

def walk_md(base, skip_subdirs=frozenset()):
    """Yield (rel, abs_path, mtime) for each .md under base."""
    if not os.path.isdir(base):
        return
    for root, dirs, files in os.walk(base):
        dirs[:] = sorted(d for d in dirs
                         if not d.startswith('.') and d not in SKIP_DIRS
                         and d not in skip_subdirs)
        for fn in sorted(files):
            if fn.endswith('.md'):
                fp = os.path.join(root, fn)
                yield os.path.relpath(fp, base), fp, os.path.getmtime(fp)

# ── Component 1: done.md detection ───────────────────────────────────────────
done_paths = [rel for rel, _, _ in walk_md(VAULT_ROOT)
              if os.path.basename(rel) == 'done.md']
comp1 = {'done_md_paths': done_paths, 'convention_not_adopted': len(done_paths) == 0}

# ── Component 2: actions files ────────────────────────────────────────────────
comp2 = {'actions_files': [
    {'path': rel, 'mtime_iso': datetime.utcfromtimestamp(mt).strftime('%Y-%m-%dT%H:%M:%SZ')}
    for rel, _, mt in walk_md(os.path.join(VAULT_ROOT, 'actions'))
]}

# ── Component 3: logs modified in window ─────────────────────────────────────
LOG_SKIP = frozenset({'daystrom-conversations', 'daystrom-reports', 'daystrom-reviews'})
comp3 = {'log_files_in_window': [
    rel for rel, _, mt in walk_md(os.path.join(VAULT_ROOT, 'logs'), skip_subdirs=LOG_SKIP)
    if mt > window_epoch
]}

# ── Component 4: next.md detection ───────────────────────────────────────────
next_paths = [rel for rel, _, _ in walk_md(os.path.join(VAULT_ROOT, 'projects'))
              if os.path.basename(rel) == 'next.md']
comp4 = {'next_md_paths': next_paths, 'convention_not_adopted': len(next_paths) == 0}

# ── Component 6: learning files ───────────────────────────────────────────────
learning_base = os.path.join(VAULT_ROOT, 'reference', 'learning')
learning_files = [rel for rel, _, _ in walk_md(learning_base)]
comp6 = {'learning_files': learning_files, 'dir_missing': not os.path.isdir(learning_base)}

# ── Component 7: vault hygiene ────────────────────────────────────────────────
# Vault size
try:
    r = subprocess.run(['du', '-sb', VAULT_ROOT], capture_output=True, text=True, check=True)
    vault_size_bytes = int(r.stdout.split()[0])
except Exception:
    vault_size_bytes = -1

# Disk: use VAULT_ROOT path so df reports the underlying host mount
try:
    r = subprocess.run(['df', '-h', VAULT_ROOT], capture_output=True, text=True, check=True)
    cols = r.stdout.strip().split('\n')[1].split()
    disk_str = f'{cols[4]} used, {cols[3]} free' if len(cols) >= 5 else 'unavailable'
except Exception:
    disk_str = 'unavailable'

# Orphan + missing-frontmatter scan
all_vault_md = list(walk_md(VAULT_ROOT))
wikilink_re = re.compile(r'\[\[([^\]|#\n]+?)(?:[|#][^\]]*?)?\]\]')
referenced  = set()
missing_fm  = []
for rel, fp, _ in all_vault_md:
    try:
        content = open(fp, encoding='utf-8', errors='ignore').read()
        for m in wikilink_re.finditer(content):
            t = m.group(1).strip().lower()
            referenced.add(t)
            referenced.add(os.path.basename(t))
        if not content.lstrip().startswith('---'):
            missing_fm.append(rel)
    except Exception:
        pass

orphans = [
    rel for rel, _, _ in all_vault_md
    if os.path.splitext(rel)[0].lower().replace(os.sep, '/') not in referenced
    and os.path.splitext(os.path.basename(rel))[0].lower() not in referenced
]

# Wiki-lint log
wiki_lint_path = os.path.join(VAULT_ROOT, 'wiki', 'log.md')
wiki_lint_content = None
if os.path.exists(wiki_lint_path):
    wiki_lint_content = open(wiki_lint_path, encoding='utf-8', errors='ignore').read(4000).strip()

comp7 = {
    'vault_size_bytes': vault_size_bytes,
    'disk': disk_str,
    'orphans': orphans[:30],
    'orphan_count': len(orphans),
    'missing_frontmatter': missing_fm[:30],
    'missing_frontmatter_count': len(missing_fm),
    'wiki_lint_log': wiki_lint_content,
    'wiki_lint_missing': wiki_lint_content is None,
}

# ── Component 10: sqlite messages ─────────────────────────────────────────────
messages, msg_error = [], None
try:
    with sqlite3.connect(STORE_DB) as conn:
        cur = conn.execute(
            "SELECT timestamp, role, substr(content,1,200) FROM messages "
            "WHERE chat_jid='tg:8669367924' AND timestamp > ? "
            "ORDER BY timestamp DESC LIMIT 200",
            (last_ts,)
        )
        messages = [{'ts': r[0], 'role': r[1], 'excerpt': r[2]} for r in cur]
except Exception as e:
    msg_error = str(e)

comp10 = {'messages': messages, 'message_count': len(messages)}
if msg_error:
    comp10['error'] = msg_error

# ── Emit final-line JSON ───────────────────────────────────────────────────────
print(json.dumps({
    'wakeAgent': True,
    'data': {
        'window_start': last_ts,
        'window_end': now_ts,
        'first_run': first_run,
        'review_count': review_count,
        'components': {
            '1': comp1,
            '2': comp2,
            '3': comp3,
            '4': comp4,
            '6': comp6,
            '7': comp7,
            '10': comp10,
        },
    },
}))
PY
