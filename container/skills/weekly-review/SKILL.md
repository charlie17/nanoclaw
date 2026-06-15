---
name: /weekly-review
description: Saturday weekly digest — 8 sections + appendix (Pattern Recognition, Accomplishments, Logs, Actions, Planning, Runway, Learning, Big 5). Writes vault report + Telegram summary + updates review state.
---

## Invocation

Automated via NanoClaw task scheduler (cron `30 5 * * 6` — Saturday 1:30 AM ET (05:30 UTC)). Manual invocation: `/weekly-review`.

## Input

**Scheduled:** prefetch script runs first and passes a `data` JSON blob in the prompt:

```
[SCHEDULED TASK]

Script output:
{"wakeAgent": true, "data": {"window_start": "2026-04-14T05:30:00Z", "window_end": "2026-04-21T05:30:00Z", "first_run": false, "review_count": 3, "components": {"1": {"project_log_paths": ["options/log.md", "daystrom/log.md"], "project_log_in_window": ["options/log.md"], "convention_not_adopted": false}, "2": {"actions_files": [...]}, "3": {"log_files_in_window": ["arts/!log.md", "coding/precepts.md"]}, "4": {"next_md_paths": [], "convention_not_adopted": true}, "6": {"learning_files": [], "dir_missing": true}, "7": {"vault_size_bytes": 5000000, "disk": "16% used, 122G free", "orphans": [], "orphan_count": 0, "missing_frontmatter": [], "missing_frontmatter_count": 0, "wiki_lint_log": null, "wiki_lint_missing": true}, "10": {"messages": [...], "message_count": 45}}}}

Instructions:
/weekly-review
```

**Manual:** if `data` absent, run from the VPS host shell:
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

Body: H1 + one H2 per section in order 1–8, then `---` separator + `# Appendix` with H2 A1 and A2.

```
# Weekly Review — Sat M/D/YY

## 1. Pattern Recognition
...

## 2. Accomplishments
...

## 3. Logs Highlights
...

## 4. Actions Review
...

## 5. Structured Planning
...

## 6. Projects Runway
...

## 7. Learning Review
...

## 8. Big 5 Personality Diagnostic (Daystrom self-assessment)
...

---

# Appendix

## A1. Vault Hygiene
...

## A2. Worf Security Summary
...
```

If `data.first_run` is true, add a note under the H1: "First weekly review — window defaulted to 7-day lookback."

## Tone

Per BA §11.2: "Direct and analytical. Never sycophantic or overly agreeable. Surfaces accomplishments honestly, challenges priorities that conflict with stated available time or contradict recent patterns." Do not open sections with "Great!" or complimentary filler. Report what the data shows.

## Per-section instructions

### 1. Pattern Recognition

Run Pattern Recognition via opus-pinned sub-agent:

**Step 1 — Assemble Lens A bundle** (keep under ~2K tokens):
Compact summaries of `data.components['2']` (actions), `['3']` (logs), `['7']` (hygiene), `['10']` (messages) + Component 1 prefetch summary: `project_log_in_window` list (write "[stub — convention not adopted]" if `convention_not_adopted`) + Component 4 prefetch summary: `next_md_paths` list (same stub if `convention_not_adopted`). Include `data.window_start`, `data.window_end`, and `data.review_count + 1`.

**Step 2 — Assemble Lens B bundle via qmd.**
<!-- DEFAULT VERB POLICY (Impl-72 / 2026-06-15): these vault-mood queries MUST use vsearch, not query.
     The weekly-review runs unattended at 05:30 UTC Saturday. Hybrid query (mcp__qmd__query) is CPU-bound
     on this hardware (measured: 277s, 260s on these exact query strings — caused the 2026-06-13 timeout).
     vsearch completes in ~12s. DO NOT change these back to mcp__qmd__query without explicit JT authorization
     and a hardware/GPU change. See FORK-BASELINE.md:215. -->
Run both queries; include file path + ~200-char excerpt per hit. The qmd tool takes a single-string parameter (no `limit` arg); trim to the top-N most-relevant hits yourself:
- `mcp__qmd__vsearch "reflection thoughts energy mood project feeling"` — keep up to ~20 top-relevance hits
- `mcp__qmd__vsearch "project stuck blocked abandoned paused dropped"` — keep up to ~15 top-relevance hits

If either query returns zero hits, include `[empty]` for that entry.

**Step 3 — Invoke Opus sub-agent.**
```
Agent({
  description: "Pattern recognition analysis (Lens A + Lens B)",
  prompt: "[Lens A bundle]\n\n[Lens B bundle]\n\nReview window: <data.window_start> to <data.window_end>. Review #<data.review_count + 1>.\n\nFormat: Two labeled bold sections — **Lens 1 — System / Process** and **Lens 2 — Human / Experiential**. Under each, bullet each observation (no wall-of-text paragraphs). Frame static backlogs (IPS, options) as possibly deliberate parking — neutral framing, do not assert 'X is your stated most important project.' Keep under ~400 words total. Run /pattern-recognition.",
  model: "opus"
})
```

**Step 4 — Write Agent output into vault file.**
Write the Agent's returned markdown verbatim into the `## 1. Pattern Recognition` H2 section. Do not edit the sub-agent's response.

If Agent fails (error or no return): write "Pattern Recognition sub-agent failed to return — see logs. Section 1 skipped this week." Do not block the remaining sections.

### 2. Accomplishments

Three labelled blocks in this order: **Coding**, **Projects**, **Life & logistics**.

**Coding**

Source: local bare git mirrors at `/workspace/extra/github-mirrors/<name>.git`. Enumerate all available mirrors at runtime — do NOT hardcode the repo list:

```
ls /workspace/extra/github-mirrors/*.git
```

**Window:** scope every git query to the review window using `--since=<data.window_start>`.

Per mirror, execute in order:
1. Count commits: `git --git-dir=<path> log --all --oneline --since=<data.window_start> | wc -l`
2. Fetch activity: `git --git-dir=<path> log --all --shortstat --since=<data.window_start>`
3. Collect commit subjects (first-line only) within the window for prose synthesis.

**`--all` is mandatory on every git call.** Bare-repo HEAD points only at the default branch; naked `git log` silently drops feature/working-branch commits (D-R4, confirmed Impl-41 D7). No exceptions.

**No diffs.** Never `git log -p` / `--patch` — counts + shortstat + subjects only.

**Non-interactive volume cap.** If a repo's window commit count is >150: render that repo as counts + shortstat totals only, append "— high volume, per-commit detail omitted" and move on.

**Render per active repo:** header line `**<repo-name>** (<commit-count> commits)` then business-impact sub-bullets — plain-English "what shipped and why it matters," NOT commit prose. Lead with outcome; commit count and branch names are supporting context, not the headline.

List idle repos (zero commits in window) together at end: `*Idle: repo1, repo2, ...*`

Empty-state (zero commits across all mirrors):
> "No coding activity in the review window."

Error-state (mirror dir missing or git unavailable):
> "Coding activity unavailable — github-mirrors not reachable this run."

Then continue — Coding block must never block the rest of §2.

**Projects**

Source: `data.components['1']`.

If `convention_not_adopted` is true:
> "No project logs in vault — convention not yet adopted."

If `project_log_in_window` is empty (logs exist but none modified in window):
> "No project logs updated in window."

Otherwise: Read each path in `project_log_in_window` at `/workspace/extra/vault/projects/<path>`. Extract dated entries inside the review window. For each project with in-window entries, render: `**<project-name>**` header then business-impact sub-bullets (plain-English "what happened and why it matters," not verbatim log entries).

**Life & logistics**

Source: `data.components['10'].messages`.

Synthesize life and logistics themes from the conversation window — travel, health, home, infrastructure, tools, and similar domains. Group by theme. Render: `**<theme>**` header then sub-bullets describing what happened.

Empty-state (`message_count == 0` or `error` field present): omit this block.

Do not fabricate content. Only synthesize themes present in the message excerpts.

### 3. Logs Highlights

Read `data.components['3'].log_files_in_window`. Each entry is a path relative to `logs/` (e.g. `arts/!log.md`, `coding/precepts.md`). For each path, Read `/workspace/extra/vault/logs/<path>`. One bullet per file. Format: **`<path>`** — <≤8-word recap of WHAT was touched, NOT a content restatement>.

Examples:
- **`mpm/!log.md`** — care meeting notes + cognition score change.
- **`pops/!log.md`** — MC transition coordinator call.
- **`arts/!log.md`** — Hacks finale + Succession start + hockey.
- **`coding/precepts.md`** — added testing precept.

Do NOT restate the contents of entries. Names, scores, specific details belong in the source file — this section surfaces *what was touched*, not *what was said*.

Empty-state: "No log files updated since last review."

### 4. Actions Review

Read `data.components['2'].actions_files`. For each entry, Read `/workspace/extra/vault/actions/<path>`. Surface all open (unchecked `- [ ]`) todos grouped by file. Render each open item as a plain bullet (`- item text`) — do NOT include the `[ ]` checkbox in the output. Highlight any dated before `data.window_start` as potentially overdue.

Cross-reference `mtime_iso` — action files not touched since before `data.window_start` are candidates for stale-item callout (the file as a whole hasn't moved this window).

**Blank line between each action-file block.**

Empty-state (no action files): "No action files found in vault."

### 5. Structured Planning

Based on the review above:
1. Propose priorities for the coming week, grounded in open actions (§4) and project runway (§6 data). Propose only data-grounded priorities — open actions with dates, natural forcing functions, or dated deadlines. Do not manufacture priorities from Pattern Recognition observations alone.
2. Flag any todos that appear stale (old dates, no progress signal in the window).
3. Ask JT about available time to enable time-budget calibration.

**Consume Pattern Recognition (§1) observations when proposing priorities:**
- If §1 surfaced overcommitment patterns (too many active projects, spreading thin), propose FEWER priorities (2-3) and name the pattern explicitly: "Pattern Recognition flagged overcommitment — proposing N priorities this week."
- If §1 surfaced consistent underestimation of effort, frame the time-budget question with a tighter lens.
- If §1 surfaced abandoned threads worth revisiting, ask JT whether to promote any to priority status.

**Parked by choice (not flagged as failures):** for backlogs that appear deliberately dormant (IPS, options, or similar), frame them neutrally under a "Parked by choice (not flagged as failures):" line. Offer to surface the single next action if JT wants to thaw one. Do NOT assert these backlogs represent failures or that any one of them is "the stated most important project."

**Stale-item flags:** list items stale beyond the window under a "Stale-item flags (FYI, no action implied):" line. Do not re-list items already covered in a Priority.

**Empty-state rule:** If §4 and §6 data provide no open actions or runway items, say so explicitly and skip priority proposals — do not manufacture priorities from message excerpts alone. Still ask JT about available time.

### 6. Projects Runway

Open-item counts by project — names link to each project's `next.md`.

If `data.components['4'].convention_not_adopted` is true:
> "No project runway surfaced (next.md convention not yet adopted in vault)."

If `next_md_paths` present: Read each path at `/workspace/extra/vault/projects/<path>`. Count numbered open items. Render one line per project, sorted descending by open count:
`- [[general/projects/<name>/next|<name>]] — N open`

### 7. Learning Review

If `data.components['6'].dir_missing` is true OR `data.components['6'].learning_files` is empty:
> "No learning materials since last review (reference/learning/ empty or missing from vault)."

If files present: Read each at `/workspace/extra/vault/reference/learning/<path>`, synthesize 2-4 key insights from the review window. Skip files with mtime before `window_start`.

### 8. Big 5 Personality Diagnostic (Daystrom self-assessment)

**This is Daystrom's self-assessment of its own behavior in the review window. Score Daystrom, NOT JT.** Ground scores in `data.components['10'].messages` — look at how Daystrom responded across the window: did it follow through on multi-step skill calls, did it push back appropriately, did it stay focused, etc.

Format: one bold header per trait with score, then bullets under each:

```
**Openness — N/5**
- bullet observation
- bullet observation

**Conscientiousness — N/5**
- bullet observation
```

Five traits to score:

- **Openness** — Daystrom's willingness to explore novel skill invocations, novel routing decisions, unusual conversational territory.
- **Conscientiousness** — Daystrom's follow-through on multi-step operations (full-ripple ingests, skill chains). Did Daystrom complete what it started?
- **Extraversion** — Daystrom's initiative in conversation. Did Daystrom proactively surface signals JT didn't ask for, or stay reactive?
- **Agreeableness** — Daystrom's pushback discipline. Did Daystrom push back on JT when warranted, or roll over?
- **Neuroticism** — Daystrom's stability under load (slow-skill-ack lapses, going-dark mid-task, repeated apologies). Lower is better.

Be honest. Do not inflate scores. If a dimension can't be assessed from this week's messages, write `**Trait — insufficient signal**` with a one-bullet note.

Examples (correct — assess Daystrom):
- `**Conscientiousness — 4/5**\n- Daystrom completed full ripple on both wiki ingests, but missed the raw-archive backfill until JT prompted.`
- `**Neuroticism — 2/5**\n- Three "are you there" prompts during long-running operations indicate occasional going-dark; otherwise stable.`

Do not do this (wrong subject — assessing JT, not Daystrom):
- `**Conscientiousness — 3/5** — 14 stale todos this week.`

## Appendix sections

### A1. Vault Hygiene

Report all sub-items:

- **Vault size:** `data.components['7'].vault_size_bytes` → human-readable (round to KB/MB).
- **Disk:** `data.components['7'].disk` — report as-is.
- **Orphans:** If `orphan_count` > 0, list up to 10 paths from `data.components['7'].orphans`. If 0: "No orphan files detected."
- **Missing frontmatter (non-system):** If `missing_frontmatter_count` > 0: report count + "schema-bearing files lack frontmatter (could feed a Base later). System files, reports, and binaries excluded from the count." Then list all paths in the array (capped at 30) from `data.components['7'].missing_frontmatter` as tab-indented sub-bullets, each path wrapped in backticks. Then emit the frontmatter tip callout (see below). If 0: "All scanned files have frontmatter."
- **Wiki-lint:** If `wiki_lint_missing` is true: "No wiki-lint run since last review (general/wiki/log.md missing or not yet generated)." If `wiki_lint_log` present: extract the last run date and any summary line from the content.

**Frontmatter tip callout** — render immediately after the missing-frontmatter bullet, ONLY when `missing_frontmatter_count` > 0. Omit entirely when 0 (empty-state silence). Emit an Obsidian `[!tip]` callout whose body is a fenced code block. Every line of the callout (including the code-fence lines) must be prefixed with `> `. List all paths from `data.components['7'].missing_frontmatter` inside the code block, one per line, plain text without backticks. Exact shape:

````
> [!tip] Frontmatter fix — copy this and send to Daystrom on Telegram
> ```
> Add frontmatter to these vault files per your §6.3 frontmatter schemas — infer the type and fields from each file's path and content, and skip any that genuinely shouldn't carry frontmatter:
> <each path from missing_frontmatter, one per line>
> ```
````

### A2. Worf Security Summary

Read `/workspace/extra/vault/logs/worf-audit.md` (produced by the Worf cron ~1 hour before this review runs).

If present: render a **1–2 line executive summary** — PASS/WARN/FAIL counts, any FAIL line, and any genuinely new WARN that isn't routine housekeeping. Then append the full-audit link:

`Full audit: [[general/logs/worf-audit|worf-audit.md]]`

Do NOT render the full audit verbatim. Do NOT include nested `##` headings from the audit file. Do NOT re-invoke `/security-audit`. Do NOT edit `worf-audit.md`.

If absent:
> "No Worf security audit file found for this week — check `task_run_logs` for `daystrom-worf-audit-v1` entries."

## Telegram output shape

Per CLAUDE.md `## Reply Discipline (executive tone)`. The full review lives in the vault file; Telegram surfaces a **1-2 sentence synthesis preview** so JT can decide from his phone alone whether opening Obsidian today is worth it.

**Shape:**

```
/weekly-review #N — Apr 14-21 — ready

<1-2 sentence synthesis preview pulled from §1 + §5 — what's top of mind this week>

[Open in Obsidian](https://daystrom-link.daystrom.workers.dev/?u=obsidian%3A%2F%2Fopen%3Fvault%3DObsidianDaystromVault%26file%3Dgeneral%2Flogs%2Fdaystrom-reviews%2Fweekly-YYYYMMDD)
```

**Header line:** `/weekly-review #N — <Mon DD>-<DD> — ready`
- `N` = `data.review_count + 1`
- Window: compact, no brackets, no "Window:" label. `Apr 14-21` if same month; `Apr 28-May 5` across month boundary
- If `data.first_run` is true, append ` · first run` after `ready`

**Synthesis preview line — composed at synth time:**

After §1 (Pattern Recognition) and §5 (Structured Planning) are written to the vault file, compose 1-2 sentences in plain English: *what should JT pay attention to this week?* Pull from the highest-signal Pattern Recognition flag and the most pressing Structured Planning priority. Examples:

- **Active week with action items:** `Top of mind: 3 stale todos in the options track, overcommitment pattern ticked up vs last week. Detail in Obsidian.`
- **Active week with positive signal:** `Strong follow-through on Daystrom + IPS work this week. Pattern Recognition flagged momentum on the wiki ingest cadence. Detail in Obsidian.`
- **Quiet week:** `Quiet week. 0 new pattern flags, no priority shifts. Open the review when convenient.`
- **Empty / first-run week:** `First weekly review — 7-day lookback covered an early-adoption window. Open Obsidian when convenient to tune the cadence.`

If §1 failed or all components are stub/empty: `Mostly quiet — see Obsidian for the components that did surface.`

**Rules:**
- Exactly 3 content blocks — header / preview / Obsidian link. Blank lines between blocks.
- Preview is plain English, no per-section bullets, no `§N.x` references, no jargon, no stub callouts. Translate findings to outcomes JT can act on.
- The link always includes the CF-worker deep-link with the actual YYYYMMDD of the report.
- Never use `|---|` tables — Telegram renders them as literal pipes.
- **One-message rule:** the preview + link IS the close-out. No trailing recap.

## Orchestrator coordination

If the file `/workspace/group/orchestrator-active.flag` exists when `/weekly-review` runs:

1. Still write the vault file and update the state file exactly as normal.
2. SKIP the Telegram reply entirely.
3. Emit a brief `synthesis complete — orchestrator owns notification` acknowledgement to stdout.

If the flag is absent, send the Telegram as normal — this is the self-healing path for when the orchestrator is absent or failed.

## Scope locks

- Read ONLY `/workspace/extra/vault/` (= `general/`) and `/workspace/extra/github-mirrors/` (read-only git queries, §2 Coding only). Never `private/`, never `worf-scope/`.
- Write ONLY to `/workspace/extra/vault/logs/daystrom-reviews/` (vault file) and `/workspace/group/last-review.json` (state). Never elsewhere in the vault.
- No web tools. MCP calls: qmd-only for §1 Lens B narrowing. Otherwise deterministic data only.
- Vault file: full narrative for all 8 sections + Appendix A1/A2. Telegram summary ≤25 lines.
