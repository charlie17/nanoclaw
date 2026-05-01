---
name: /nightly-report
description: Daily 5AM vault-activity digest. Sends compressed Telegram summary. No vault file write.
---

## Invocation

Automated via NanoClaw task scheduler (cron `0 5 * * *`). Manual invocation: `/nightly-report`.

## Input

**Scheduled:** prefetch script runs first and passes a `data` JSON blob in the prompt:

```
[SCHEDULED TASK]

Script output:
{"report_date": "2026-04-21 05:00 ET", "vault_changes": ["general/logs/arts.md"], "task_errors": [], "disk": "42% used, 58G free"}

Instructions:
/nightly-report
```

**Manual:** `data` absent — collect via Bash (see §Fallback data collection).

## Output

Reply with plain-text Telegram summary only (see §Telegram output shape). **No vault file write.**

## Telegram output shape

Two or three lines. No tables. No deep-links.

```
/nightly-report — Mon 4/21/26

Updates: actions/errands.md, logs/mpm.md, reference/food.md
Attention: 1 task error · Disk: 30% used, 103G free
```

**Header line:** `/nightly-report — DOW M/D/YY`
- DOW = Mon/Tue/Wed/Thu/Fri/Sat/Sun
- M/D/YY = numeric with no leading zeros (e.g. `4/21/26`, not `04/21/2026`)
- Derive from `data.report_date` (already in ET per prefetch)

**Updates line:** `Updates: <path1>, <path2>, ...`
- List each path from `data.vault_changes` comma-separated, relative to `general/`
- If empty: `Updates: none`

**Attention line** — include ONLY if there is something to flag:
- Task-error chunk: `<N> task error` (N == 1) or `<N> task errors` (N > 1). Omit if N == 0.
- Disk chunk: `Disk: <pct> used, <free>`. Omit if disk percentage < 50% (nothing to flag).
- Join present chunks with ` · `. Prefix with `Attention: `.
- If BOTH chunks are suppressed, omit the entire Attention line.

**Task error relabeling:** if any entry in `data.task_errors` contains "exit code 137", "exit status 137", or "exited 137", render that entry as "Container exited with code 137 (intermittent — not OOM)" in any count or summary. Do NOT use the label "OOM kill" — root cause confirmed NOT an OOM (no docker memory limit set; kernel logs clean).

## Fallback data collection (manual invocation only)

- `find /workspace/extra/vault -type f -name '*.md' -mtime -1 -not -path '*/worf-scope/*' -not -path '*/.*'` for vault changes
- Read `/workspace/group/last-nightly-report.timestamp` if present for the window reference; otherwise use 24h window
- `df -h /workspace/extra/vault` for disk
- `sqlite3 /workspace/project/store/messages.db "SELECT task_id, datetime(run_at), error FROM task_run_logs WHERE status='error' AND run_at > datetime('now','-1 day');"` for task errors

## Scope locks

- Read ONLY `/workspace/extra/vault/` (= `general/`). Never `private/`, never `worf-scope/`.
- **No Write tool calls.** Telegram-only output — no vault file is written by this skill.
- No web tools. No MCP calls. Deterministic data only.
