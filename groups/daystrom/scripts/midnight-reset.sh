#!/usr/bin/env bash
set -euo pipefail

# Order is load-bearing: delete session row FIRST so even if the sentinel
# triggers a racing shutdown, the next inbound message starts fresh.
#
# Container base (node:22-slim) does not ship the sqlite3 CLI; python3 + its
# sqlite3 stdlib module ARE present. Use python for the DELETE so the call is
# not silently swallowed with `command not found`.
python3 - <<'PY'
import sqlite3
with sqlite3.connect('/workspace/project/store/messages.db') as conn:
    conn.execute("DELETE FROM sessions WHERE group_folder = 'daystrom'")
    conn.commit()
PY

# Signal any currently-running interactive Daystrom container to exit.
# No-op if no container is running (stale sentinel cleaned up on next start).
touch /workspace/ipc/input/_close

echo '{"wakeAgent": false}'
