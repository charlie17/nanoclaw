---
name: /board-synth-v2
description: On-demand insight synthesis for Projects Board v2. Triggered by the daystrom-board-synth-v2 one-shot scheduled task, itself poked by the board's Regenerate button (no cron — poke-only). Do not invoke manually except for testing.
---

# /board-synth-v2 — on-demand board insight synthesis

Triggered by `daystrom-board-synth-v2` (`schedule_type='once'`), poked by the widget's
`POST /widget/insights-regen/projects-board-v2` route setting `next_run = now`. Runs in an `isolated` agent
context. Produces one cache file — `insights.json` — that the host's board-v2 data route reads on every GET.

Deliberately narrow: no Log synthesis, no GitHub mirror reads, no priorities.md, no ledger reconcile
machinery. Just: read the vault + the arrangement + the prior insight list, write a fresh insight list.

## Inputs (all container-side reads)

- **Per-project next-files:** `/workspace/extra/vault/projects/*/next.md`
- **Board arrangement (RO):** `/workspace/extra/board-cache/v2/overlay.json` — JT's current Active/On Deck
  placements. Absent or corrupt → treat as no arrangement (proceed without it; do not error).
- **Regen request (RO):** `/workspace/extra/board-cache/v2/regen-request.json` — `{ mode, requestedAt }`.
  **Missing or corrupt → treat as `mode: "full"`.** This is the ONLY fallback direction; never default a
  missing/corrupt request to `new-only`.
- **Prior insights (RO):** `/workspace/extra/board-cache/v2/insights.json` — the list from the last run.
  Absent on first run → treat as `{ "items": [] }`.

## Mode (D17 — deterministic, read once at run start)

Read `regen-request.json`'s `mode` field before doing anything else. It selects one of exactly two behaviors:

- **`new-only`** — the prior `insights.json` items are copied through into the output **UNCHANGED** (same
  `id`, same `text`, same `projects`). List them to yourself as "already surfaced — do NOT repeat or
  re-derive." Your only job this run is to look for observations that are genuinely NOT already covered by
  that list, and append them. Do not reword, re-order for emphasis, merge, or drop an existing item in this
  mode — that is `full` mode's job, not this one.
- **`full`** — re-evaluate the whole list from scratch against the current vault + arrangement: retire items
  that no longer hold (the underlying situation resolved), revise items whose framing has evolved, add
  genuinely new observations. This is also the fallback when `regen-request.json` is missing or fails to
  parse — **missing file ⇒ full, always**, never new-only.

## Execution order

1. Read `regen-request.json` → resolve `mode` per the rule above (missing/corrupt ⇒ `full`).
2. Read `insights.json` → prior items (missing/corrupt ⇒ `[]`).
3. Read every `next.md` under `general/projects/*/` for context (skip folders with no file or an empty file
   — that's normal, not an error).
4. Read `overlay.json` for the current Active/On Deck arrangement (skip on missing/corrupt — proceed without
   arrangement context, do not error or block).
5. Apply the mode behavior above to produce the final item list (≤ 6 items — see Output).
6. Write `insights.json` atomically (see Atomic write).

## Insight content

Arrangement-aware: reason about the actual Active/On Deck placements alongside the file content — overlaps
between queued cards, contradictions between where the queue points and where the files are heading,
consolidation opportunities across projects. Every insight is attributed to the project(s) it concerns.

## Voice (D13 — HARD rules, non-negotiable)

- Executive tone: impact-first, no filler, no hedging.
- Every item names the project(s) it concerns (`projects: [...]`) — a global observation with no names is
  not a valid insight.
- **BANNED, ABSOLUTELY, WITH NO EXCEPTIONS: any temporal or staleness observation.** Never write, imply, or
  gesture at "has been sitting/waiting/open for N days/weeks/months," never an age-based nudge, never "this
  hasn't moved," never a framing where an item's *duration on the board* is itself the point. This is not a
  style preference to weigh against other goals — it is a hard content filter applied to every candidate
  insight before it is written. **A long-lived item is normal and expected; its age is never noteworthy on
  this board, under any framing, however indirect.** If the only thing you can say about an item is that it's
  been around a while, that is not an insight — discard the candidate, don't soften it into one.
- No filler, no empty-state items ("nothing notable this run" is not an item — write zero items instead).
  Fewer strong items beats padding to a count.

## Output contract

Atomic write of `insights.json`:

```json
{
  "asOf": "<now ISO 8601>",
  "items": [
    { "id": "v2-001", "text": "<plain text; wikilinks/md-links allowed>", "projects": ["<folder>"] }
  ]
}
```

- `asOf` = this run's completion time, ISO 8601.
- `text` is plain text; markdown links and wikilinks are allowed inline (the host tokenizes on read — do not
  pre-tokenize, do not emit `Token[]` objects here).
- **Ids are stable across runs for carried-over items** — an item that survives from the prior list (either
  copied unchanged in `new-only` mode, or revised-but-continuous in `full` mode) keeps its original `id`.
  Genuinely new items take the next free `v2-NNN` number (highest existing number + 1; never reuse a retired
  number).
- **≤ 6 items total, always** — this caps both modes. In `full` mode, if evaluation would otherwise produce
  more than 6, prune the weakest until 6 remain (retiring resolved/weak items is exactly what `full` mode is
  for). In `new-only` mode, if the carried-through prior list is already at 6, do not append — there is no
  room, and the fix is a `full` regen, not silently exceeding the cap.

## Atomic write

Write to a temp file in the same directory, then rename over the target — never write the target path
directly (eliminates partial-read races with the host's data route):

```
1. Write insights.json → board-cache/v2/.insights.tmp.json  (create/overwrite)
2. mv board-cache/v2/.insights.tmp.json  board-cache/v2/insights.json
```

**Cache directory:** `/workspace/extra/board-cache/v2/` (container-side). Corresponds to
`~/daystrom-ops/state/board-cache/v2/` on the host.

## Scope locks

- **READ ONLY** from the vault (`general/projects/*/next.md`) — no vault writes, ever.
- **READ ONLY** from `overlay.json` and `regen-request.json` — never modify either.
- **WRITE ONLY** to `/workspace/extra/board-cache/v2/insights.json`, and only via the temp+rename sequence
  above. Never write the target path directly. No other files, no other directories.

## Completion reporting (silent success, loud error)

The scheduled-task runner forwards your FINAL message to JT's Telegram. An empty final message sends
nothing. The pattern is silence on success, detail on failure:

- **On success** — after `insights.json` is written atomically, **END YOUR TURN WITH NO FINAL MESSAGE.** Do
  not summarize, confirm, count items, or list what you found. Emit zero output text. The board itself is
  the surface — the widget shows the new insights and the "as of" stamp on its next refresh. A silent run is
  the correct, expected outcome. Do not narrate "done" — that would ping JT for something that requires no
  action from him.
- **On an error you cannot recover from** (can't read any `next.md`, can't write to
  `/workspace/extra/board-cache/v2/`, the mount is missing, etc.) — END with a SINGLE concise line prefixed
  **`⚠️ Board synth v2 error:`** naming what failed and any host action needed. This is the ONLY case you
  emit a final message; it becomes JT's error alert (and surfaces via the task's `last_result`, which the
  widget's `stale` state reflects). Do not write a fallback copy elsewhere — just report and stop.

Note: a missing/corrupt `overlay.json` or `regen-request.json` is NOT an error condition (see Inputs above)
— those degrade gracefully per their documented fallback and must never trigger the error-report path.

## First-run behavior

`insights.json` absent → treat as `{ "items": [] }`. Combined with `regen-request.json` also typically
absent on a true first run, mode resolves to `full`, so all discovered insights are freshly numbered from
`v2-001`.
