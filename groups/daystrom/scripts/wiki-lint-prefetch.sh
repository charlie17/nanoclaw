#!/usr/bin/env bash
# wiki-lint-prefetch.sh — skip-when-quiet check for nightly /wiki-lint @ 2am UTC.
# Runs inside NanoClaw task-spawn container (node:22-slim base).
# Output contract: last non-empty stdout line is JSON {"wakeAgent": <bool>, "data": {...}}.
# Container base lacks jq + sqlite3 CLI; use python3 stdlib for everything.
set -euo pipefail

VAULT_WIKI=/workspace/extra/vault/wiki
LAST_RUN_FILE="${VAULT_WIKI}/.lint-last-run"

python3 - <<'PY'
import json, os, sys
from datetime import datetime, timezone

VAULT_WIKI = '/workspace/extra/vault/wiki'
LAST_RUN_FILE = os.path.join(VAULT_WIKI, '.lint-last-run')

# Read last-run timestamp via mtime of marker file. Skill updates it via `touch` at completion.
if os.path.exists(LAST_RUN_FILE):
    try:
        last_run_ts = os.path.getmtime(LAST_RUN_FILE)
        first_run = False
    except Exception:
        last_run_ts = 0.0
        first_run = True
else:
    last_run_ts = 0.0
    first_run = True

# Walk wiki/, exclude raw/ (immutable, doesn't trigger lint), exclude meta files.
SKIP_DIRS = frozenset({'raw'})
SKIP_FILES = frozenset({'.lint-last-run', '_processed.json'})

newer_count = 0
newest_mtime = last_run_ts
sample = []

if not os.path.isdir(VAULT_WIKI):
    # No wiki yet — skip silently (first wiki ingest hasn't happened).
    print(json.dumps({'wakeAgent': False, 'data': {'reason': 'wiki dir does not exist', 'first_run': True}}))
    sys.exit(0)

for root, dirs, files in os.walk(VAULT_WIKI):
    dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and not d.startswith('.'))
    for fn in files:
        if fn in SKIP_FILES:
            continue
        if not fn.endswith('.md') and not fn.endswith('.json'):
            continue
        try:
            mt = os.path.getmtime(os.path.join(root, fn))
            if mt > last_run_ts:
                newer_count += 1
                if mt > newest_mtime:
                    newest_mtime = mt
                if len(sample) < 10:
                    rel = os.path.relpath(os.path.join(root, fn), VAULT_WIKI)
                    sample.append(rel)
        except Exception:
            pass

# Decision
if newer_count == 0 and not first_run:
    # Quiet night — skip. No agent wakeup, no Telegram noise.
    last_run_iso = datetime.fromtimestamp(last_run_ts, tz=timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    print(json.dumps({
        'wakeAgent': False,
        'data': {'reason': 'no wiki changes since last lint', 'last_run': last_run_iso}
    }))
    sys.exit(0)

# Wake agent — there's work to do.
last_run_iso = datetime.fromtimestamp(last_run_ts, tz=timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ') if last_run_ts > 0 else None
print(json.dumps({
    'wakeAgent': True,
    'data': {
        'first_run': first_run,
        'last_run': last_run_iso,
        'changes_since_last_run': newer_count,
        'sample_changed_files': sample,
    },
}))
PY
