---
name: /weekly-review
description: Friday weekly digest — 12 components per BA §11.2. Writes vault report + Telegram summary + updates review state.
---

## Invocation

Automated via NanoClaw task scheduler (cron `30 3 * * 5` — Friday 3:30 AM local). Manual invocation: `/weekly-review`.

## Input

**Scheduled:** prefetch script runs first and passes a `data` JSON blob in the prompt:

```
[SCHEDULED TASK]

Script output:
{"wakeAgent": true, "data": {"window_start": "2026-04-14T03:30:00Z", "window_end": "2026-04-21T03:30:00Z", "first_run": false, "review_count": 3, "components": {"1": {"project_log_paths": ["options/log.md", "daystrom/log.md"], "project_log_in_window": ["options/log.md"], "convention_not_adopted": false}, "2": {"actions_files": [...]}, "3": {"log_files_in_window": ["arts/!log.md", "coding/precepts.md"]}, "4": {"next_md_paths": [], "convention_not_adopted": true}, "6": {"learning_files": [], "dir_missing": true}, "7": {"vault_size_bytes": 5000000, "disk": "16% used, 122G free", "orphans": [], "orphan_count": 0, "missing_frontmatter": [], "missing_frontmatter_count": 0, "wiki_lint_log": null, "wiki_lint_missing": true}, "10": {"messages": [...], "message_count": 45}}}}

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

Body: H1 + one H2 per component in order 1–12 + Big 5 closing.

```
# Weekly Review — Fri M/D/YY

## 1. Accomplishments
...

## 2. Actions Review
...

(continue through ## 12. Coding Activity, then ## Big 5 Personality Diagnostic)
```

If `data.first_run` is true, add a note under the H1: "First weekly review — window defaulted to 7-day lookback."

## Tone

Per BA §11.2: "Direct and analytical. Never sycophantic or overly agreeable. Surfaces accomplishments honestly, challenges priorities that conflict with stated available time or contradict recent patterns." Do not open sections with "Great!" or complimentary filler. Report what the data shows.

## Per-component instructions

### 1. Accomplishments

Source: `projects/<name>/log.md` files (project log = accomplishments + learnings stream, seeded vault-wide 2026-05-10 in the vault dimension collapse).

If `data.components['1'].convention_not_adopted` is true — emit this exact text, no paraphrase:
> "No project log.md files in vault — convention not yet adopted."

If `data.components['1'].project_log_in_window` is empty (logs exist but none modified in window):
> "No project accomplishments since last review (no log.md files modified in window)."

Otherwise: Read each path in `project_log_in_window` at `/workspace/extra/vault/projects/<path>`, extract dated entries inside the review window. Surface as bullet list grouped by project. Format: `**<project>**` then dated bullets verbatim.

### 2. Actions Review

Read `data.components['2'].actions_files`. For each entry, Read `/workspace/extra/vault/<path>`. Surface all open (unchecked `- [ ]`) todos grouped by file. Render each open item as a plain bullet (`- item text`) — do NOT include the `[ ]` checkbox in the output (the checkbox would imply interactivity that can't propagate back to the source file). Highlight any dated before `data.window_start` as potentially overdue.

Cross-reference `mtime_iso` — action files not touched since before `data.window_start` are candidates for stale-item callout (the file as a whole hasn't moved this review window, beyond any individual dated items).

Empty-state (no action files): "No action files found in vault."

### 3. Logs Highlights

Read `data.components['3'].log_files_in_window`. Each entry is a path relative to `logs/` (e.g. `arts/!log.md`, `coding/precepts.md`). For each path, Read `/workspace/extra/vault/logs/<path>`. One bullet per file. Format: **`<path>`** — <≤8-word recap of WHAT was touched, NOT a content restatement>.

Examples:
- **`mpm/!log.md`** — care meeting notes + cognition score change.
- **`pops/!log.md`** — MC transition coordinator call.
- **`arts/!log.md`** — Hacks finale + Succession start + hockey.
- **`coding/precepts.md`** — added testing precept.

Do NOT restate the contents of entries. Names, scores, specific details belong in the source file — the weekly review surfaces *what was touched*, not *what was said*.

Empty-state: "No log files updated since last review."

### 4. Projects Runway

If `data.components['4'].convention_not_adopted` is true — emit this exact text, no paraphrase:
> "No project runway surfaced (next.md convention not yet adopted in vault)."

If next.md paths present: Read each, synthesize open project priorities + items. Render open items as plain bullets (`- item text`) — do NOT include `[ ]` checkbox in output.

### 5. Pattern Recognition

Run Pattern Recognition per SA §7.2.1 (D-68) via opus-pinned sub-agent:

**Step 1 — Assemble Lens A bundle** (keep under ~2K tokens):
Compact summaries of components 2/3/7/10 from `data.components` + Component 1 accomplishments summary (write "[stub — convention not adopted]" if `convention_not_adopted`) + Component 4 runway summary (same). Include `data.window_start`, `data.window_end`, and `data.review_count + 1`.

**Step 2 — Assemble Lens B bundle via qmd.**
Run both queries; include file path + ~200-char excerpt per hit. The qmd tool takes a single-string parameter (no `limit` arg); you are responsible for trimming to the top-N most-relevant hits yourself if the returned set is larger:
- `mcp__qmd__query "reflection thoughts energy mood project feeling"` — keep up to ~20 top-relevance hits
- `mcp__qmd__query "project stuck blocked abandoned paused dropped"` — keep up to ~15 top-relevance hits

If either query returns zero hits, include `[empty]` for that entry. Pattern Recognition handles zero-input gracefully.

**Step 3 — Invoke Opus sub-agent.**
```
Agent({
  description: "Pattern recognition analysis (Lens A + Lens B per SA §7.2.1)",
  prompt: "[Lens A bundle]\n\n[Lens B bundle]\n\nReview window: <data.window_start> to <data.window_end>. Review #<data.review_count + 1>. Run /pattern-recognition.",
  model: "opus"
})
```

**Step 4 — Write Agent output into vault file.**
Write the Agent's returned markdown verbatim into the `## 5. Pattern Recognition` H2 section of the vault file. Do not edit the sub-agent's response.

If Agent fails (error or no return): write "Pattern Recognition sub-agent failed to return — see logs. Component 5 skipped this week." Do not block the remaining review components.

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

Read `/workspace/extra/vault/logs/worf-audit.md` (produced by Stage 3 /security-audit 25 min earlier in the Friday pipeline).

If present: render its contents verbatim under the `## 8. Worf Security Report` H2 in the weekly-review vault file. No paraphrase, no re-synthesis — BA §11.3 "Component 8 consumes Stage 3 output. No re-run."

If absent: emit this line instead:
> "No Worf security audit file found for this week — check `task_run_logs` for `task-worf-audit-*` entries."

Do NOT re-invoke /security-audit. Do NOT edit worf-audit.md.

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

**Consume Pattern Recognition (Component 5) observations when proposing priorities:**
- If Component 5 surfaced overcommitment patterns (too many active projects, spreading thin), propose FEWER priorities (2-3 instead of 5) and name the pattern explicitly: "Last review's Pattern Recognition flagged overcommitment — I'm proposing 3 priorities this week instead of 5."
- If Component 5 surfaced consistent underestimation of effort, frame the time-budget question with a tighter lens: "Given the underestimation pattern, how much time can you realistically commit to the top priority alone?"
- If Component 5 surfaced abandoned threads worth revisiting, ask JT whether to promote any to priority status.

**Empty-state rule:** If Components 2 and 4 provide no open actions or runway items, say so explicitly and skip priority proposals — do not manufacture priorities from conversation excerpts (Component 10) alone. Still ask JT about available time this week so the next review has a baseline.

Challenge priorities that conflict with the data (e.g., do not propose a goal with no corresponding open action).

### 12. Coding Activity

Source: local bare git mirrors at container path `/workspace/extra/github-mirrors/<name>.git`. Enumerate all available mirrors at runtime — do NOT hardcode the repo list:

```
ls /workspace/extra/github-mirrors/*.git
```

**Window:** scope every git query to the review window using `--since=<data.window_start>`.

**Per mirror, execute in order:**

1. Count commits:
   ```
   git --git-dir=<path> log --all --oneline --since=<data.window_start> | wc -l
   ```
2. Fetch activity:
   ```
   git --git-dir=<path> log --all --shortstat --since=<data.window_start>
   ```
3. Collect commit subjects (first-line only) within the window for prose synthesis.

**`--all` is mandatory on every git call.** Bare-repo HEAD points only at the default branch; naked `git log` silently drops feature/working-branch commits (coding-recap hard rule D-R4, confirmed Impl-41 D7 — 135 commits invisible without it). No exceptions.

**No diffs.** Never `git log -p` / `--patch` — counts + shortstat + subjects only. Diffs are ~10× token cost per commit and automation has no JT to confirm a diff pull.

**Non-interactive volume cap.** If a repo's window commit count is >150: render that repo as counts + shortstat totals only, append "— high volume, per-commit detail omitted" and move on. Never block, never prompt.

**Render:** prose, executive tone, per CLAUDE.md `## Reply Discipline (executive tone)`. Group by repo. Lead each repo with what got built or shipped; commit count and branch names are supporting context, not the headline. No commit-hash recitation. No markdown tables.

**Empty-state** (zero commits across all mirrors in window):
> "No coding activity in the review window."

**Error-state** (mirror dir missing or unreadable, or git unavailable):
> "Coding activity unavailable — github-mirrors not reachable this run."

Then continue — Component 12 must never block the rest of the review (same resilience contract as Component 5's sub-agent-failure path).

### Big 5 Personality Diagnostic (closing section)

H2: `## Big 5 Personality Diagnostic (Daystrom self-assessment)`

**This is Daystrom's self-assessment of its own behavior in the review window. Score Daystrom, NOT JT.** Ground scores in Component 10 messages — look at how Daystrom responded across the window: did it follow through on multi-step skill calls, did it push back appropriately, did it stay focused, etc.

One sentence per dimension with score x/5:

- **Openness** — Daystrom's willingness to explore novel skill invocations, novel routing decisions, unusual conversational territory.
- **Conscientiousness** — Daystrom's follow-through on multi-step operations (full-ripple ingests, skill chains). Did Daystrom complete what it started?
- **Extraversion** — Daystrom's initiative in conversation. Did Daystrom proactively surface signals JT didn't ask for, or did it stay reactive?
- **Agreeableness** — Daystrom's pushback discipline. Did Daystrom push back on JT when warranted (per `feedback_no_sweeping_under_rug`), or did it roll over?
- **Neuroticism** — Daystrom's stability under load (slow-skill-ack lapses, going-dark mid-task, repeated apologies). Lower is better.

Examples (good — assess Daystrom):
- `Conscientiousness: 4/5 — Daystrom completed full ripple on both wiki ingests this week, but missed the raw-archive backfill on the first one until JT prompted.`
- `Neuroticism: 2/5 — Three "are you there" prompts during long-running operations indicate occasional going-dark; otherwise stable.`

Examples (bad — DO NOT do this; this is assessing JT):
- `Conscientiousness: 3/5 — 14 stale todos this week.` ← wrong subject; that's JT.

Be honest. Do not inflate scores. If a dimension can't be assessed from this week's messages, write `Neuroticism: insufficient signal — Daystrom was largely passive this week.`

## Quarterly model-pin review banner

Emit this exact text, always in v1 — no paraphrase:
> "Quarterly model-pin review deferred to Batch 4.2b — host orchestrator owns calendar check."

## Telegram output shape

Per CLAUDE.md `## Reply Discipline (executive tone)`. The full review lives in the vault file; Telegram surfaces a **1-2 sentence synthesis preview** so JT can decide from his phone alone whether opening Obsidian today is worth it.

**Shape:**

```
/weekly-review #N — Apr 14-21 — ready

<1-2 sentence synthesis preview pulled from Components 5 + 11 — what's top of mind this week>

[Open in Obsidian](https://daystrom-link.daystrom.workers.dev/?u=obsidian%3A%2F%2Fopen%3Fvault%3DObsidianDaystromVault%26file%3Dgeneral%2Flogs%2Fdaystrom-reviews%2Fweekly-YYYYMMDD)
```

**Header line:** `/weekly-review #N — <Mon DD>-<DD> — ready`
- `N` = `data.review_count + 1`
- Window: compact, no brackets, no "Window:" label. `Apr 14-21` if same month; `Apr 28-May 5` across month boundary
- If `data.first_run` is true, append ` · first run` after `ready`

**Synthesis preview line — composed at synth time:**

After Components 5 (Pattern Recognition) + 11 (Structured Planning) are written to the vault file, compose 1-2 sentences in plain English answering: *what should JT pay attention to this week?* Pull from the highest-signal Pattern Recognition flag and the most pressing Structured Planning priority. Examples:

- **Active week with action items:** `Top of mind: 3 stale todos in the options track, overcommitment pattern ticked up vs last week. Detail in Obsidian.`
- **Active week with positive signal:** `Strong follow-through on Daystrom + IPS work this week. Component 5 flagged momentum on the wiki ingest cadence. Detail in Obsidian.`
- **Quiet week:** `Quiet week. 0 new pattern flags, no priority shifts. Open the review when convenient.`
- **Empty / first-run week:** `First weekly review — 7-day lookback covered an early-adoption window. Open Obsidian when convenient to tune the cadence.`

If Component 5 returned `[stub — convention not adopted]` for component 1 or 4 OR Pattern Recognition sub-agent failed, fall back to: `Mostly quiet — see Obsidian for the components that did surface.` Don't fabricate a preview from sparse signal.

**Rules:**
- Exactly 3 content blocks — header / preview / Obsidian link. Blank lines between blocks.
- Preview is plain English, no per-component bullets, no `§5.x` references, no jargon, no stub-component callouts. Translate findings to outcomes JT can act on.
- The link always includes the CF-worker deep-link with the actual YYYYMMDD of the report.
- Never use `|---|` tables — Telegram renders them as literal pipes.
- **One-message rule:** the preview + link IS the close-out. No trailing recap.

**What does NOT change:** the vault file itself stays the canonical 12-component report + Big 5. This change affects only the Telegram surface — it now serves as a triage pointer with a phone-readable preview, not a pure handoff.

## Orchestrator coordination

If the file `/workspace/group/orchestrator-active.flag` exists when `/weekly-review` runs:

1. Still write the vault file and update the state file exactly as normal.
2. SKIP the Telegram reply entirely.
3. Emit a brief `synthesis complete — orchestrator owns notification` acknowledgement to stdout.

The host `weekly-review-orchestrator` will append its host-only sections (Component 9, Host Attention Signals, Quarterly Banner) and send the consolidated Telegram. If the flag is absent, send the Telegram as normal — this is the self-healing path for when the orchestrator is absent or failed before touching the flag.

## Scope locks

- Read ONLY `/workspace/extra/vault/` (= `general/`). Never `private/`, never `worf-scope/`.
- Write ONLY to `/workspace/extra/vault/logs/daystrom-reviews/` (vault file) and `/workspace/group/last-review.json` (state). Never elsewhere in the vault.
- No web tools. MCP calls in v1: qmd-only for Component 5 Lens B narrowing (Batch 4.2c); readwise deferred to future batches. Otherwise deterministic data only.
- Vault file: full narrative for all 12 sections + Big 5. Telegram summary ≤25 lines.
