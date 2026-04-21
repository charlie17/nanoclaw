#!/usr/bin/env bash
set -euo pipefail

STATE_FILE="/workspace/group/last-nightly-report.timestamp"
VAULT_ROOT="/workspace/extra/vault"
STORE_DB="/workspace/project/store/messages.db"

# Component (a): vault files modified since last report
# If state file missing (first run), use "24h ago" as fallback reference
if [ ! -f "$STATE_FILE" ]; then
  reference=$(date -d '24 hours ago' '+%Y-%m-%dT%H:%M:%S')
  touch -d "$reference" "$STATE_FILE"
fi

# Scope: general/ only. Exclude worf-scope/, dotfiles, and template dirs.
changed_files=$(find "$VAULT_ROOT" \
  -type f -name '*.md' \
  -newer "$STATE_FILE" \
  -not -path '*/worf-scope/*' \
  -not -path '*/.*' \
  -printf '%P\n' 2>/dev/null | sort)

# Component (d) S4: disk free (host `df` is in the container image)
disk_line=$(df -h / | awk 'NR==2 {printf "%s used, %s free", $5, $4}')

# Component (d) S3: scheduled-task errors in last 24h — done inside python
# below via the sqlite3 STDLIB module (the container image ships libsqlite3 + the
# Python binding but NOT the sqlite3 CLI, so a bash `sqlite3 ...` call would
# silently return empty and hide the signal).
#
# Emit JSON on the FINAL non-empty stdout line via python3 stdlib.
# Container base (node:22-slim) does not ship jq or the sqlite3 CLI; python3 and
# its sqlite3 stdlib ARE present. Data passed through the environment to avoid
# shell-quoting hazards around filenames with spaces/quotes.
CHANGED_FILES="$changed_files" \
DISK_LINE="$disk_line" \
REPORT_TS="$(date '+%Y-%m-%d %H:%M %Z')" \
STORE_DB="$STORE_DB" \
python3 - <<'PY'
import json, os, sqlite3
def lines(s):
    return [l for l in (s or '').split('\n') if l.strip()]

task_errors = []
try:
    with sqlite3.connect(os.environ['STORE_DB']) as conn:
        cur = conn.execute(
            "SELECT task_id, datetime(run_at), coalesce(error, 'unknown') "
            "FROM task_run_logs "
            "WHERE status = 'error' AND run_at > datetime('now', '-1 day') "
            "ORDER BY run_at DESC"
        )
        task_errors = [f"{r[0]} @ {r[1]}: {r[2]}" for r in cur]
except Exception:
    # Non-fatal: if the store is unreachable from this container, surface an
    # empty list rather than aborting the whole report. An unreachable store
    # is itself an attention signal but is already surfaced by LaForge.
    pass

print(json.dumps({
    'wakeAgent': True,
    'data': {
        'report_date': os.environ['REPORT_TS'],
        'vault_changes': lines(os.environ.get('CHANGED_FILES')),
        'task_errors': task_errors,
        'disk': os.environ['DISK_LINE'],
    },
}))
PY

# Bump state file AFTER successful emit (next run reads from now)
touch "$STATE_FILE"
