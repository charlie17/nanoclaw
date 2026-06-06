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

# ── Component 1: project log.md detection (scoped to projects/ for symmetry with
#   Component 4; log.md is project-local by convention: projects/{name}/log.md).
#   Replaces the pre-2026-05-10 done.md detection — done.md never landed; the
#   vault dimension collapse seeded log.md across all projects as the canonical
#   accomplishments + learnings stream per project.
project_log_paths = [rel for rel, fp, mt in walk_md(os.path.join(VAULT_ROOT, 'projects'))
                     if os.path.basename(rel) == 'log.md']
project_log_in_window = [rel for rel, fp, mt in walk_md(os.path.join(VAULT_ROOT, 'projects'))
                         if os.path.basename(rel) == 'log.md' and mt > window_epoch]
comp1 = {
    'project_log_paths': project_log_paths,
    'project_log_in_window': project_log_in_window,
    'convention_not_adopted': len(project_log_paths) == 0,
}

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
# Vault size — surface exception text explicitly (mirror comp10 error pattern)
vault_size_error = None
try:
    r = subprocess.run(['du', '-sb', VAULT_ROOT], capture_output=True, text=True, check=True)
    vault_size_bytes = int(r.stdout.split()[0])
except Exception as e:
    vault_size_bytes = -1
    vault_size_error = str(e)

# Disk: use VAULT_ROOT path so df reports the underlying host mount
disk_error = None
try:
    r = subprocess.run(['df', '-h', VAULT_ROOT], capture_output=True, text=True, check=True)
    cols = r.stdout.strip().split('\n')[1].split()
    disk_str = f'{cols[4]} used, {cols[3]} free' if len(cols) >= 5 else 'unavailable'
except Exception as e:
    disk_str = 'unavailable'
    disk_error = str(e)

# Orphan + missing-frontmatter scan
all_vault_md = list(walk_md(VAULT_ROOT))
wikilink_re = re.compile(r'\[\[([^\]|#\n]+?)(?:[|#][^\]]*?)?\]\]')
referenced  = set()
missing_fm  = []

# System/machine-generated files excluded from frontmatter count — only count
# schema-bearing non-system files that could feed an Obsidian Base later.
FM_EXCLUDE_PREFIXES = (
    'logs/daystrom-reports/',
    'logs/daystrom-reviews/',
    'tmp/',
    'logs/worf-audit.md',
)

for rel, fp, _ in all_vault_md:
    rel_fwd = rel.replace(os.sep, '/')
    try:
        content = open(fp, encoding='utf-8', errors='ignore').read()
        for m in wikilink_re.finditer(content):
            t = m.group(1).strip().lower()
            referenced.add(t)
            referenced.add(os.path.basename(t))
        if (not content.lstrip().startswith('---')
                and not any(rel_fwd.startswith(p) for p in FM_EXCLUDE_PREFIXES)):
            missing_fm.append(rel)
    except Exception:
        pass

ORPHAN_EXCLUDE_PREFIXES = (
    'actions/',
    'logs/daystrom-reports/',
    'logs/daystrom-reviews/',
    'tmp/',
    'projects/options/notes/options-strategies/',
)

orphans = [
    rel for rel, _, _ in all_vault_md
    if os.path.splitext(rel)[0].lower().replace(os.sep, '/') not in referenced
    and os.path.splitext(os.path.basename(rel))[0].lower() not in referenced
    and not any(rel.replace(os.sep, '/').startswith(p) for p in ORPHAN_EXCLUDE_PREFIXES)
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
if vault_size_error:
    comp7['vault_size_error'] = vault_size_error
if disk_error:
    comp7['disk_error'] = disk_error

# ── Component 10: sqlite messages ─────────────────────────────────────────────
# Schema: NanoClaw v1 `messages` table uses `is_from_me` (0=JT, 1=Daystrom) and
# `is_bot_message` (1=/slash command injection etc.); there is no `role` column.
# Map to a role string in-Python for synth convenience.
messages, msg_error = [], None
try:
    with sqlite3.connect(STORE_DB) as conn:
        cur = conn.execute(
            "SELECT timestamp, is_from_me, is_bot_message, substr(content,1,200) "
            "FROM messages "
            "WHERE chat_jid='tg:8669367924' AND timestamp > ? "
            "ORDER BY timestamp DESC LIMIT 200",
            (last_ts,)
        )
        for ts, is_from_me, is_bot, excerpt in cur:
            role = 'assistant' if is_from_me else ('bot' if is_bot else 'user')
            messages.append({'ts': ts, 'role': role, 'excerpt': excerpt})
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
