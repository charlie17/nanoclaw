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
{"report_date": "2026-04-21 05:00 ET", "vault_changes": ["general/logs/arts/!log.md"], "task_errors": [], "disk": "42% used, 58G free"}

Instructions:
/nightly-report
```

**Manual:** `data` absent — collect via Bash (see §Fallback data collection).

## Output

Reply with plain-text Telegram summary only (see §Telegram output shape). **No vault file write.**

## Telegram output shape

Per CLAUDE.md `## Reply Discipline (executive tone)`. Two or three lines. No tables. No deep-links. No `Updates:` / `Attention:` devops headers — write to JT in plain English.

**Header line:** `/nightly-report — DOW M/D/YY`
- DOW = Mon/Tue/Wed/Thu/Fri/Sat/Sun
- M/D/YY = numeric with no leading zeros (e.g. `4/21/26`)
- Derive from `data.report_date` (already in ET per prefetch)

**Body — two states:**

**Quiet state (no errors, disk healthy):** one line summarizing what got touched in the last 24h, in plain English. Translate paths to human labels:
- `logs/<domain>/!log.md` → `<domain> log`
- `logs/<domain>/<file>.md` → `<domain> notes`
- `actions/errands.md` → `errands list`; `todos.md` → `todos`; `shopping.md` → `shopping list`
- `reference/<area>.md` → `<area> reference`
- `projects/<name>/log.md` → `<name> project log`

If `data.vault_changes` is empty, the body line is just `Quiet last 24h.`

**Attention state (any task errors, disk ≥ 50% used, or other flag-worthy event):** the vault-touches summary line, then a `Heads up: <plain-English description>` line for what JT should know. Drop `Heads up:` if there's nothing to flag — silence on attention items IS the signal.

**Worked examples:**

Quiet day:
```
/nightly-report — Mon 4/21/26

3 vault touches: errands list, MPM log, food log.
```

Truly quiet (zero touches):
```
/nightly-report — Mon 4/21/26

Quiet last 24h.
```

Day with attention:
```
/nightly-report — Mon 4/21/26

3 vault touches: errands list, MPM log, food log.
Heads up: 1 scheduled task errored overnight — see Worf log.
```

Disk filling:
```
/nightly-report — Mon 4/21/26

Quiet last 24h.
Heads up: disk at 78% (38G free) — worth a sweep soon.
```

**Disk threshold:** mention disk only when ≥ 50% used. Below 50%, stay silent — disk health doesn't need a daily ack.

**Task error wording:** if any entry in `data.task_errors` contains "exit code 137", "exit status 137", or "exited 137", phrase the heads-up as `Heads up: 1 container exit-137 overnight (intermittent, not OOM) — see Worf log.` Do NOT use the label "OOM kill" — root cause confirmed NOT an OOM (no docker memory limit set; kernel logs clean).

**One-message rule:** the report IS the close-out. No trailing summary follows.

## Fallback data collection (manual invocation only)

- `find /workspace/extra/vault -type f -name '*.md' -mtime -1 -not -path '*/worf-scope/*' -not -path '*/.*'` for vault changes
- Read `/workspace/group/last-nightly-report.timestamp` if present for the window reference; otherwise use 24h window
- `df -h /workspace/extra/vault` for disk
- `sqlite3 /workspace/project/store/messages.db "SELECT task_id, datetime(run_at), error FROM task_run_logs WHERE status='error' AND run_at > datetime('now','-1 day');"` for task errors

## Scope locks

- Read ONLY `/workspace/extra/vault/` (= `general/`). Never `private/`, never `worf-scope/`.
- **No Write tool calls.** Telegram-only output — no vault file is written by this skill.
- No web tools. No MCP calls. Deterministic data only.
