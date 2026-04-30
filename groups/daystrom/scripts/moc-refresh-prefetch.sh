#!/usr/bin/env bash
# moc-refresh-prefetch.sh — skip-when-quiet check for nightly /moc-refresh @ 2:15am UTC.
# Runs inside NanoClaw task-spawn container (node:22-slim base).
# Output contract: last non-empty stdout line is JSON {"wakeAgent": <bool>, "data": {...}}.
# Container base lacks jq + sqlite3 CLI; use python3 stdlib for everything.
set -euo pipefail

python3 - <<'PY'
import json, os, sys
from datetime import datetime, timezone

VAULT_GENERAL = '/workspace/extra/vault'   # general namespace (mount root for daystrom)
LAST_RUN_FILE = os.path.join(VAULT_GENERAL, '.moc-refresh-last-run')

# Read last-run timestamp via mtime of marker file. Skill updates via `touch` at completion.
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

# Walk general/. Skip:
#   - wiki/ (handled by /wiki-lint, not /moc-refresh)
#   - tmp/ (short-lived scratch)
#   - quarantine/ (unreachable anyway)
#   - private/ (separate namespace)
#   - dotfiles + dotdirs
SKIP_TOP = frozenset({'wiki', 'tmp', 'quarantine', 'private'})

newer_count = 0
sample = []
file_count = 0

if not os.path.isdir(VAULT_GENERAL):
    print(json.dumps({'wakeAgent': False, 'data': {'reason': 'general namespace dir does not exist'}}))
    sys.exit(0)

for top in sorted(os.listdir(VAULT_GENERAL)):
    if top in SKIP_TOP or top.startswith('.'):
        continue
    top_path = os.path.join(VAULT_GENERAL, top)
    if not os.path.isdir(top_path):
        # Top-level files (rare); still walk
        if top.endswith('.md'):
            try:
                mt = os.path.getmtime(top_path)
                file_count += 1
                if mt > last_run_ts:
                    newer_count += 1
                    if len(sample) < 10:
                        sample.append(top)
            except Exception:
                pass
        continue
    for root, dirs, files in os.walk(top_path):
        dirs[:] = sorted(d for d in dirs if not d.startswith('.'))
        for fn in files:
            if not fn.endswith('.md'):
                continue
            try:
                mt = os.path.getmtime(os.path.join(root, fn))
                file_count += 1
                if mt > last_run_ts:
                    newer_count += 1
                    if len(sample) < 10:
                        rel = os.path.relpath(os.path.join(root, fn), VAULT_GENERAL)
                        sample.append(rel)
            except Exception:
                pass

# Decision
if newer_count == 0 and not first_run:
    last_run_iso = datetime.fromtimestamp(last_run_ts, tz=timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    print(json.dumps({
        'wakeAgent': False,
        'data': {'reason': 'no general/ changes since last moc-refresh', 'last_run': last_run_iso, 'total_files_scanned': file_count}
    }))
    sys.exit(0)

last_run_iso = datetime.fromtimestamp(last_run_ts, tz=timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ') if last_run_ts > 0 else None
print(json.dumps({
    'wakeAgent': True,
    'data': {
        'first_run': first_run,
        'last_run': last_run_iso,
        'changes_since_last_run': newer_count,
        'total_files_scanned': file_count,
        'sample_changed_files': sample,
    },
}))
PY
