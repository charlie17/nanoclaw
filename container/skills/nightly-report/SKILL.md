---
name: /nightly-report
description: Daily 5AM vault-activity digest. Summarizes vault changes + task errors + disk. Writes report to vault + sends Telegram summary.
---

## Invocation

Automated via NanoClaw task scheduler (cron `0 5 * * *`). Manual invocation: `/nightly-report`.

## Input

**Scheduled:** prefetch script runs first and passes a `data` JSON blob in the prompt:

```
[SCHEDULED TASK]

Script output:
{"report_date": "2026-04-21 05:00 PST", "vault_changes": ["general/logs/arts.md"], "task_errors": [], "disk": "42% used, 58G free"}

Instructions:
/nightly-report
```

**Manual:** `data` absent — collect via Bash (see §Fallback data collection).

## Output

1. **Write vault file at this EXACT absolute container path** — do NOT convert to a relative path, do NOT insert `general/` in the path:
   `/workspace/extra/vault/logs/daystrom-reports/nightly-<YYYYMMDD>.md`
   where `<YYYYMMDD>` = `report_date` → strip non-digits, first 8 chars. This path is correct as-written; the container mount `/workspace/extra/vault/` IS the Obsidian `general/` folder, and adding any extra `general/` prefix creates a broken `general/general/` nesting on the host. Use the `Write` tool with this exact absolute path.
2. Reply with plain-text Telegram summary (see §Telegram output shape). You MUST emit both `## Vault activity` AND `## Items requiring attention` sections in the vault file whenever the prefetch `data` blob is provided. Rules for the attention section:
   - Include `task_errors` bullet(s) if `data.task_errors` array is non-empty.
   - Include `disk` bullet ALWAYS (disk is never "clean" — a healthy disk still gets a one-line `Disk: N% used, Y free` entry).
   - Omit the whole `## Items requiring attention` section ONLY if `data.task_errors` is empty AND disk percentage is &lt; 50% (i.e., nothing noteworthy at all).

## Vault file format

```yaml
---
type: daystrom-report
report_date: 2026-04-21  # ISO date (YYYY-MM-DD) — normalize from prefetch's timestamp+TZ
---
```

Body sections:
- `# Nightly Report — Mon 4/21/26`
- `## Vault activity (since [last-run timestamp])` — one bullet per changed file with one-line summary; or "No vault changes in window" if empty
- `## Items requiring attention` — task errors (S3) + disk line (S4); omit section entirely if both are clean

## Telegram output shape

Plain-text list only. No `|---|` tables. CF-worker deep-link at bottom.

```
/nightly-report — Mon 4/21/26

Vault activity (since [time]):
- [path]: [one-line summary]
- [path]: [one-line summary]
(or "No vault changes in window")

Attention:
- N scheduled task errors in last 24h
- Disk: X% used, Y free

[Open report in Obsidian](https://daystrom-link.daystrom.workers.dev/?u=obsidian%3A%2F%2Fopen%3Fvault%3DObsidianDaystromVault%26file%3Dgeneral%2Flogs%2Fdaystrom-reports%2Fnightly-20260421)
```

Rules:
- **Never** use `|---|` tables — Telegram doesn't render them.
- **Always** include the CF-worker deep-link with the actual YYYYMMDD of today's report.
- If both sections empty: one line `/nightly-report — Mon 4/21/26 · Nothing notable overnight. [Open report in Obsidian](<link>)` — still write vault file with "No activity" stub.

## Fallback data collection (manual invocation only)

- `find /workspace/extra/vault -type f -name '*.md' -mtime -1 -not -path '*/worf-scope/*' -not -path '*/.*'` for vault changes
- Read `/workspace/group/last-nightly-report.timestamp` if present; otherwise use 24h window
- `sqlite3 /workspace/project/store/messages.db "SELECT task_id, datetime(run_at), error FROM task_run_logs WHERE status='error' AND run_at > datetime('now','-1 day');"` for task errors
- `df -h /` for disk

## Scope locks

- Read ONLY `/workspace/extra/vault/` (= `general/`). Never read `private/`, never `worf-scope/`.
- Write ONLY to the absolute container path `/workspace/extra/vault/logs/daystrom-reports/` (which maps to host `~/vault/general/logs/daystrom-reports/`). Never elsewhere in the vault.
- No web tools. No MCP calls to readwise/qmd for this skill (v1). Deterministic data only.
- Vault file: one-line-per-item detail. Telegram summary ≤ 15 lines.
