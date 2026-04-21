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

# Component (d) S3: scheduled task errors in last 24h
task_errors=$(sqlite3 "$STORE_DB" "
  SELECT task_id, datetime(run_at), coalesce(error, 'unknown')
  FROM task_run_logs
  WHERE status='error' AND run_at > datetime('now','-1 day')
  ORDER BY run_at DESC;
" 2>/dev/null || echo "")

# Component (d) S4: disk free
disk_line=$(df -h / | awk 'NR==2 {printf "%s used, %s free", $5, $4}')

# Emit JSON on the FINAL non-empty stdout line via python3 stdlib.
# Container base (node:22-slim) does not ship jq; python3 is available and avoids
# shell quoting hazards by passing data through the environment, not heredoc interpolation.
CHANGED_FILES="$changed_files" \
TASK_ERRORS="$task_errors" \
DISK_LINE="$disk_line" \
REPORT_TS="$(date '+%Y-%m-%d %H:%M %Z')" \
python3 - <<'PY'
import json, os
def lines(s):
    return [l for l in (s or '').split('\n') if l.strip()]
print(json.dumps({
    'wakeAgent': True,
    'data': {
        'report_date': os.environ['REPORT_TS'],
        'vault_changes': lines(os.environ.get('CHANGED_FILES')),
        'task_errors': lines(os.environ.get('TASK_ERRORS')),
        'disk': os.environ['DISK_LINE'],
    },
}))
PY

# Bump state file AFTER successful emit (next run reads from now)
touch "$STATE_FILE"
