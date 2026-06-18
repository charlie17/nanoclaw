---
name: /board-synth
description: Nightly batch — synthesizes LLM Log + cross-project Insights for the Projects Board and writes board-cache/logs.json + insights-ledger.json atomically. Triggered automatically by the daystrom-board-synth-v1 scheduled task (09:00 UTC daily). Do not invoke manually except for testing.
---

# /board-synth — nightly board synthesis

Triggered by `daystrom-board-synth-v1` (cron `0 9 * * *` = 09:00 UTC / 5:00 AM ET). Runs in an `isolated` agent context. Produces two cache files that `handleWidgetData` (host Bridge) reads on every board GET.

## Inputs

All reads happen within the agent container — no network calls.

- **Priorities registry:** `/workspace/extra/vault/general/projects/priorities.md`
- **Per-project next-files:** `/workspace/extra/vault/general/projects/<folder>/next.md` (or named variant)
- **Per-project logs:** `/workspace/extra/vault/general/projects/<folder>/log.md`
- **GitHub mirrors (RO):** `/workspace/extra/github-mirrors/<name>.git` — bare repos maintained by LaForge
- **Prior insights ledger (RW):** `/workspace/extra/board-cache/insights-ledger.json` — read at start, reconciled, rewritten at end

## Project → repo mapping (Archie-maintained; deterministic)

| Project folder | Repo mirror(s) | Mirror status |
|---|---|---|
| `podvast` | `jt-podvast` | mirrored ✓ |
| `options` | `jt-options-backtesting` + `jt-options-data-2026` | mirrored ✓ |
| `daystrom` | `jt-daystrom` + `nanoclaw` | mirrored ✓ |
| `coactive` | `coactive` | mirrored ✓ |
| `leanspec` | `jt-leanspec` | mirrored ✓ (auto-match) |
| `health-agent` | `jt-health-agent` | **not yet mirrored → log.md-only + missing-repo flag** |
| `ips`, `flickboard`, `pops-medicaid` | (none) | log.md-only |

**Auto-match fallback:** if a project folder is not in the table above, check whether a mirror named `jt-<folder>` exists. If it does, use it. If not, treat as log.md-only + surface a missing-repo note in Insights.

**Hard rule: never guess a repo.** Unlisted AND no auto-match → log.md-only + visible Insights flag. Wrong attribution is worse than no attribution.

## Execution order

1. **Read** `priorities.md` and parse the project list.
2. **For each full project** (folder-resolved, in registry order):
   a. Read `log.md` and `next.md` for context.
   b. Run the per-project git-log slice (§ below) for each mapped repo.
   c. Synthesize the Log (§ Log synthesis contract).
3. **Read the prior `insights-ledger.json`** (absent on first run → treat as empty ledger `{ "insights": [] }`).
4. **Synthesize cross-project Insights** using the full loaded context (§ Insights contract).
5. **Write cache files atomically** (§ Atomic writes).

## Per-project git-log slice

For each repo in a project's mirror list, run:

```
git --git-dir=/workspace/extra/github-mirrors/<name>.git log --all --shortstat --since=90d
```

`--all` is MANDATORY — bare-repo HEAD silently drops feature-branch commits (Impl-41 D7; confirmed VPS recon). Never omit it.

Collect the output for all mapped repos; synthesize them together into one combined Log view (no per-repo sections). Newest-first by commit date.

For projects with no mapped repo, log.md-only synthesis is still valuable — proceed without git data.

## Log synthesis contract

**Tone (hard rules — calibrated on the Podvast probe):** executive register, impact-first ("so what?"), jargon eliminated (spec IDs / commit-speak / internal terms removed or parenthetical only when a genuine hook), but not hollow — keep enough concrete substance that the line is meaningful (the "how"/"what").

**Calibration examples (Podvast):**
- ❌ "Shipped spec-005 — the Phase-2 'data spine': server-side ingestion + backup foundation across Groups 0–4." (jargon, no "so what")
- ✅ "Built the core data backbone: the app can now reliably pull in your full podcast library and keep a protected backup of it."
- ✅ "Sped up syncing by only processing what changed instead of reprocessing the whole library each time."
- ✅ "Pinned down how Overcast tracks played vs. deleted episodes — the groundwork for the 'aborted' feature you have queued." ← calibration target

**Format:**
- Blend `log.md` entries + commit synthesis into ONE "recent activity" view. No source headers.
- Repo-derived lines carry a trailing `*` (quiet Daystrom-internal marker; no on-screen legend). Hand-log lines get no `*`.
- Commit material is ALWAYS exec-synthesis — never raw commit messages, paths, diffs, or counts.
- Default most-recent 5, newest-first.
- Each bullet carries an absolute `date` = the most-recent underlying activity date in its cluster (commit date or log.md date stamp). Store `null` if genuinely undatable. The widget renders "Xd ago" client-side from the absolute date.
- A project with no mapped repo → log.md-only synthesis. Surface a one-line missing-repo note in Insights (§ Insights contract § 6.4); never a silent drop, never a guessed repo.

**Cache text format:** store plain-text strings in the cache (`text: string`). The host `handleWidgetData` calls `tokenize()` when reading — do NOT pre-tokenize in the cache (keep the cache human-readable and the tokenization logic server-side).

**Key each project's log by its on-disk FOLDER name** — the directory under `general/projects/` (e.g. `podvast`, `options`, `daystrom`), the same key used in the mapping table above. NOT a display name, NOT a slug. The host (`handleWidgetData`) looks up each board entry's log by its resolved folder, so the keys MUST be folder names or the panel stays "synthesis pending" forever.

- **Multi-entry, one folder:** the two **Options** board entries (Coding + Business) share folder `options` and one `log.md` → write a SINGLE `logs["options"]` entry; both panels pick it up. Never split a shared-folder project into two log keys.

**Full `logs.json` shape:**
```json
{
  "generatedAt": "2026-06-18T09:00:00Z",
  "logs": {
    "podvast": {
      "repoMapped": true,
      "entries": [
        { "text": "Built the core data backbone: …", "date": "2026-06-17T00:00:00Z", "repoDerived": true },
        { "text": "Pinned down how Overcast tracks …", "date": "2026-06-14T00:00:00Z", "repoDerived": false }
      ]
    },
    "options": { "repoMapped": true, "entries": [ "…" ] }
  }
}
```
`generatedAt` = the synth run time (ISO 8601). `logs` = a map of **folder name → per-project log object**. Only `full` (folder-resolved) projects get an entry; lightweight/pointer priorities never have a log. The host sets `synthesized:true` itself when it finds a cache entry — do NOT write a `synthesized` field. The fields the host consumes are `repoMapped` (per project) and per-entry `text` / `date` / `repoDerived`.

## Insights contract

**Why a ledger:** insights are slow-moving (days-to-weeks to work through). Regenerating from scratch nightly would reword the same insights — churn that looks like change. The ledger gives insights memory so the board stays stable and only flags genuine change.

**Scan scope:** every project's activity — Next activities AND the freshly-synthesized Logs. Scan across four lenses:
1. Contradictions (conflicting activities across projects)
2. Consolidation / duplicate activities (same work in two places)
3. Streamlining (scaffolded/empty projects that haven't moved)
4. Cross-cutting patterns (shared infra, upstream dependencies, sequencing leverage)

**Each insight MUST name the project(s) it concerns** — a global box without names is not actionable.

**Reconciliation (in-run; the agent does all bucketing judgment):**
- Generate tonight's candidate set.
- Match semantically against the prior ledger (both sets are in context).
- Carry-forward match → keep its `firstSurfaced`; bump `lastSeen`. Genuinely new → `firstSurfaced = today`, `bucket: "new"`.
- A carried insight seen ≥2 runs (or age ≥14 days) → `bucket: "standing"`.
- An insight absent for ≥3 consecutive runs → `status: "resolved"` (ages out).
- Dedup against the ledger, NOT just the rendered set — a resolved insight must not resurface (check `status:"resolved"` entries before adding a new one that is semantically identical).

**Missing-repo flag (§ 6.4):** for any project with no mapped repo (and no auto-match), surface one Insights line: "Health Agent (or <project>): commits not visible — repo not yet mirrored; log.md-only synthesis." This is `bucket: "new"` on first appearance, `bucket: "standing"` once it persists.

**Output shape for `insights-ledger.json`:**
```json
{
  "generatedAt": "2026-06-18T09:00:00Z",
  "insights": [
    {
      "id": "ins-001",
      "text": "Options (Coding) + IPS: duplicated SP500 viewer work …",
      "projects": ["options-coding", "ips"],
      "firstSurfaced": "2026-06-18T09:00:00Z",
      "lastSeen": "2026-06-18T09:00:00Z",
      "bucket": "standing",
      "status": "active"
    }
  ]
}
```

The host filters `status:active` and splits by `bucket` when serving.

## Atomic cache writes

Write BOTH files atomically using temp-file + rename to eliminate partial-read races with `handleWidgetData`:

```
1. Write logs.json   → board-cache/.logs.tmp.json      (create/overwrite)
2. mv board-cache/.logs.tmp.json      board-cache/logs.json
3. Write insights    → board-cache/.insights.tmp.json
4. mv board-cache/.insights.tmp.json  board-cache/insights-ledger.json
```

Write `logs.json` first (logs before insights — if the run is interrupted, the host serves stale insights rather than mismatched data).

**Cache directory:** `/workspace/extra/board-cache/` (container-side). Corresponds to `~/daystrom-ops/state/board-cache/` on the host.

## Scope locks

- **READ ONLY** from `priorities.md`, `next.md`, `log.md` (no writes to the vault).
- **WRITE ONLY** to `/workspace/extra/board-cache/` (the two cache files via temp+rename above).
- No other vault writes.
- Do not write directly to `logs.json` or `insights-ledger.json` — always go through `.tmp.json` + rename.

## Completion reporting (silent success, loud error)

The scheduled-task runner forwards your FINAL message to JT's Telegram. An empty final message sends nothing. Use that:

- **On success** — after both cache files are written atomically, **END YOUR TURN WITH NO FINAL MESSAGE.** Do NOT summarize, confirm, count projects, or list insights. Emit zero output text. The board itself is the surface; a silent run is the correct, expected outcome. (Do not narrate "done" — that would ping JT.)
- **On an error you cannot recover from** (can't read `priorities.md`, can't write to `/workspace/extra/board-cache/`, the mount is missing, a required input is unreadable, etc.) — END with a SINGLE concise line prefixed **`⚠️ Board synth error:`** naming what failed and any host action needed. This is the ONLY case you emit a final message; it becomes JT's error alert. Do not also write a fallback copy elsewhere in the vault — just report the error and stop.

## First-run behavior

`insights-ledger.json` absent → treat as `{ "insights": [] }` (empty ledger). All discovered insights are `bucket: "new"` on the first run.
