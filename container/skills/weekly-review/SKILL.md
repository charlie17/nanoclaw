---
name: /weekly-review
description: Friday weekly digest — 11 components per BA §11.2. Writes vault report + Telegram summary + updates review state.
---

## Invocation

Automated via NanoClaw task scheduler (cron `30 3 * * 5` — Friday 3:30 AM local). Manual invocation: `/weekly-review`.

## Input

**Scheduled:** prefetch script runs first and passes a `data` JSON blob in the prompt:

```
[SCHEDULED TASK]

Script output:
{"wakeAgent": true, "data": {"window_start": "2026-04-14T03:30:00Z", "window_end": "2026-04-21T03:30:00Z", "first_run": false, "review_count": 3, "components": {"1": {"done_md_paths": [], "convention_not_adopted": true}, "2": {"actions_files": [...]}, "3": {"log_files_in_window": ["logs/arts.md"]}, "4": {"next_md_paths": [], "convention_not_adopted": true}, "6": {"learning_files": [], "dir_missing": true}, "7": {"vault_size_bytes": 5000000, "disk": "16% used, 122G free", "orphans": [], "orphan_count": 0, "missing_frontmatter": [], "missing_frontmatter_count": 0, "wiki_lint_log": null, "wiki_lint_missing": true}, "10": {"messages": [...], "message_count": 45}}}}

Instructions:
/weekly-review
```

**Manual:** if `data` absent, run from a container shell:
`bash /home/ubuntu/daystrom-nanoclaw/groups/daystrom/scripts/weekly-review-prefetch.sh`

## Output

Execute in this exact order:

1. **`mkdir -p /workspace/extra/vault/logs/daystrom-reviews/`** — the directory does not exist on first run.
2. **Write vault file at this EXACT absolute container path** — NO `general/` prefix, NO relative path:
   `/workspace/extra/vault/logs/daystrom-reviews/weekly-<YYYYMMDD>.md`
   where `<YYYYMMDD>` = compact date from `data.window_end` (strip `-`, first 8 chars). The mount `/workspace/extra/vault/` IS the Obsidian `general/` folder — inserting `general/` creates a broken double-nesting on the host.
3. Reply with plain-text Telegram summary (see §Telegram output shape).
4. **Write state file** `/workspace/group/last-review.json`:
   `{"last_review_ts": "<data.window_end>", "review_count": <data.review_count + 1>}`
   Write state ONLY after the vault file is successfully written. A failed synth must NOT bump the timestamp.

## Vault file format

```yaml
---
type: daystrom-review
review_date: YYYY-MM-DD
review_window_start: <data.window_start>
review_window_end: <data.window_end>
---
```

Body: H1 + one H2 per component in order 1–11 + Big 5 closing.

```
# Weekly Review — Fri M/D/YY

## 1. Accomplishments
...

## 2. Actions Review
...

(continue through ## 11. Structured Planning, then ## Big 5 Personality Diagnostic)
```

If `data.first_run` is true, add a note under the H1: "First weekly review — window defaulted to 7-day lookback."

## Tone

Per BA §11.2: "Direct and analytical. Never sycophantic or overly agreeable. Surfaces accomplishments honestly, challenges priorities that conflict with stated available time or contradict recent patterns." Do not open sections with "Great!" or complimentary filler. Report what the data shows.

## Per-component instructions

### 1. Accomplishments

If `data.components['1'].convention_not_adopted` is true — emit this exact text, no paraphrase:
> "No accomplishments since last review (done.md convention not yet adopted in vault)."

If done.md paths present: Read each at `/workspace/extra/vault/<path>`, extract items completed in the window. If no in-window items: "No accomplishments recorded in done.md files since last review."

### 2. Actions Review

Read `data.components['2'].actions_files`. For each entry, Read `/workspace/extra/vault/<path>`. Surface all open (unchecked `- [ ]`) todos grouped by file. Highlight any dated before `data.window_start` as potentially overdue.

Cross-reference `mtime_iso` — action files not touched since before `data.window_start` are candidates for stale-item callout (the file as a whole hasn't moved this review window, beyond any individual dated items).

Empty-state (no action files): "No action files found in vault."

### 3. Logs Highlights

Read `data.components['3'].log_files_in_window`. For each path, Read `/workspace/extra/vault/<path>`. Summarize entries created during the review window (use entry dates, not file mtime). One bullet per log file.

Empty-state: "No log files updated since last review."

### 4. Projects Runway

If `data.components['4'].convention_not_adopted` is true — emit this exact text, no paraphrase:
> "No project runway surfaced (next.md convention not yet adopted in vault)."

If next.md paths present: Read each, synthesize open project priorities + items.

### 5. Pattern Recognition

Emit this exact text, always, no paraphrase:
> "Component 5 (Pattern Recognition) deferred to Batch 4.2c — opus-pinned sub-skill not yet built."

### 6. Learning Review

If `data.components['6'].dir_missing` is true OR `data.components['6'].learning_files` is empty — emit this exact text, no paraphrase:
> "No learning materials since last review (reference/learning/ empty or missing from vault)."

If files present: Read each at `/workspace/extra/vault/reference/learning/<path>`, synthesize 2-4 key insights from the review window. Skip files with mtime before `window_start`.

### 7. Vault Hygiene

Report all sub-items:

- **Vault size:** `data.components['7'].vault_size_bytes` → human-readable (round to KB/MB).
- **Disk:** `data.components['7'].disk` — report as-is.
- **Orphans:** If `orphan_count` > 0, list up to 10 paths from `data.components['7'].orphans`. If 0: "No orphan files detected."
- **Missing frontmatter:** If `missing_frontmatter_count` > 0, list up to 10 paths. If 0: "All scanned files have frontmatter."
- **Wiki-lint:** If `wiki_lint_missing` is true: "No wiki-lint run since last review (general/wiki/log.md missing or not yet generated)." If `wiki_lint_log` present: extract the last run date and any summary line from the content.

### 8. Worf Security Report

Emit this exact text, always, no paraphrase:
> "Component 8 (Security Report) deferred to Batch 4.2b — Stage 3 /security-audit not yet built."

### 9. Upstream Changes

Emit this exact text, always, no paraphrase:
> "Component 9 (Upstream Changes) deferred to Batch 4.2b — host-side /upstream-review orchestrator not yet built."

### 10. Observation Extraction

Read `data.components['10'].messages`. Each entry: `ts`, `role`, `excerpt` (first 200 chars). Synthesize 3-5 key observations, decisions, or recurring themes from the conversation window. Group by topic where natural. Note total count from `message_count`.

Empty-state (message_count == 0): "No conversation messages in the review window."
Error state (`error` field present): "Observation extraction unavailable — database read error: {error}."

Do not fabricate content beyond the excerpts provided. Do not invent details not present in the data.

### 11. Structured Planning

Based on the review above:
1. Propose 3-5 priorities for the coming week, grounded in open actions (Component 2) and project runway (Component 4).
2. Flag any todos that appear stale (old dates, no progress signal in the window).
3. Ask JT: "What's your available time this week?" to enable time-budget calibration.

**Empty-state rule:** If Components 2 and 4 provide no open actions or runway items, say so explicitly and skip priority proposals — do not manufacture priorities from conversation excerpts (Component 10) alone. Still ask JT about available time this week so the next review has a baseline.

Challenge priorities that conflict with the data (e.g., do not propose a goal with no corresponding open action).

### Big 5 Personality Diagnostic (closing section)

H2: `## Big 5 Personality Diagnostic`

Self-assessment across 5 dimensions, one sentence each with score x/5. Ground scores in the conversation patterns visible in Component 10 data.

- **Openness** — receptiveness to new ideas, curiosity, exploration
- **Conscientiousness** — follow-through on todos, systematic planning, discipline
- **Extraversion** — initiative in conversation, social engagement signals
- **Agreeableness** — collaboration, flexibility, responsiveness
- **Neuroticism** — stress signals, frustration patterns, reactivity

Example: `Conscientiousness: 3/5 — 4 todos from last week carried forward without resolution.`

Be honest. Do not inflate scores to be encouraging.

## Quarterly model-pin review banner

Emit this exact text, always in v1 — no paraphrase:
> "Quarterly model-pin review deferred to Batch 4.2b — host orchestrator owns calendar check."

## Telegram output shape

Plain-text list only. No `|---|` tables. ≤25 lines. CF-worker deep-link at bottom.

```
/weekly-review — Fri M/D/YY (Review #N)
Window: [window_start date] → [window_end date]

Actions Review:
- [1-liner per action file: filename + open todo count — or "No action files"]

Logs Highlights:
- [1-liner per updated log — or "No logs updated this week"]

Vault Hygiene:
- Size: [X MB] · Disk: [X% used, Y free]
- Orphans: N · Missing frontmatter: N
- Wiki-lint: [last run date or "no recent run"]

Observations ([N messages]):
- [2-3 key themes]

Planning:
- [top 2-3 priorities for the week]

Big 5: O:[x]/5 C:[x]/5 E:[x]/5 A:[x]/5 N:[x]/5

(Stubs: 1/4/5/6/8/9 + quarterly banner — see vault file)

[Open in Obsidian](https://daystrom-link.daystrom.workers.dev/?u=obsidian%3A%2F%2Fopen%3Fvault%3DObsidianDaystromVault%26file%3Dgeneral%2Flogs%2Fdaystrom-reviews%2Fweekly-YYYYMMDD)
```

Rules:
- **Never** use `|---|` tables — Telegram renders them as literal pipes.
- **Always** include the CF-worker deep-link with the actual YYYYMMDD of the report.
- `N` = `data.review_count + 1` — same value written to the state file in Step 4.
- If `data.first_run` is true, append ` (First run — 7-day default window)` to the header line after `(Review #N)`.
- STUB components (1/4/5/6/8/9 + quarterly banner) — do NOT repeat each deferred message in Telegram. Collapse to one "(Stubs: 1/4/5/6/8/9 + quarterly banner — see vault file)" line.
- If both Orphans and Missing frontmatter are 0, collapse to one bullet: "Vault hygiene clean."

## Scope locks

- Read ONLY `/workspace/extra/vault/` (= `general/`). Never `private/`, never `worf-scope/`.
- Write ONLY to `/workspace/extra/vault/logs/daystrom-reviews/` (vault file) and `/workspace/group/last-review.json` (state). Never elsewhere in the vault.
- No web tools. No MCP calls in v1 (qmd and readwise deferred to future batches). Deterministic data only.
- Vault file: full narrative for all 11 sections + Big 5. Telegram summary ≤25 lines.
