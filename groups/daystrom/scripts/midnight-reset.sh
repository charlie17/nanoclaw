#!/usr/bin/env bash
set -euo pipefail

# Order is load-bearing: delete session row FIRST so even if the sentinel
# triggers a racing shutdown, the next inbound message starts fresh.
sqlite3 /workspace/project/store/messages.db \
  "DELETE FROM sessions WHERE group_folder='daystrom';"

# Signal any currently-running interactive Daystrom container to exit.
# No-op if no container is running (stale sentinel cleaned up on next start).
touch /workspace/ipc/input/_close

echo '{"wakeAgent": false}'
