# /wiki-scan — Skill Spec (Karpathy backlog diagnostic, read-only)

When JT invokes `/wiki-scan`, report the delta between `daystrom-wiki`-tagged Readwise items and what the wiki has already processed. This is a diagnostic-only command — you do NOT ingest anything.

Announce model at start: "Running `/wiki-scan` with Haiku — diagnostic report only."

## Scan flow

1. Call `mcp__readwise__reader_list_documents({tag: ["daystrom-wiki"]})` → collect all tagged Readwise doc IDs and titles across all locations (inbox / later / archive). The `daystrom-wiki` tag is the explicit "include in wiki" signal; Reader location reflects JT's reading workflow and is orthogonal to wiki-readiness.
2. Read `general/wiki/_processed.json` → collect set of already-processed doc IDs.
3. Compute delta: tagged items NOT in `_processed.json` = unprocessed backlog.
4. Rank the delta by Readwise signal: starred items first, then by highlight density (items with more highlights rank higher), then by recency.
5. Report to JT: backlog count + top-N candidates with titles + suggested priority order for the next ingest cycle.

## Output shape

Per CLAUDE.md `## Telegram Output Format` — plain-text numbered list, one item per line. Telegram does NOT render `|` table syntax; pipes and dashes show as literal characters. Each item's title is a markdown deep-link to its Readwise Reader URL per CLAUDE.md `### Deep-linking items you surface` — the `reader_list_documents` response contains `id` + `location` for every item; use them to construct `https://read.readwise.io/{location}/read/{id}` for each backlog entry.

**WRONG:**
```
| # | Title          | Author | Saved  |
|---|----------------|--------|--------|
| 1 | Make It Stick  | Brown  | Apr 12 |
```

**RIGHT:**
```
1. [Make It Stick](https://read.readwise.io/archive/read/01kpdqd374qhavgs79cbp9vr8q) — Brown ⭐ Saved Apr 12
2. [Spacing Effect Explained](https://read.readwise.io/archive/read/01kpabc123xyz) — Oakley · Saved Apr 09
```

Keep inline metadata short (author, starred, saved-date is enough). Use em-dashes, middle dots, or labels to separate attributes — never pipes. No vault writes during a scan run.

Optional `log.md` append (only if JT asks): `## [YYYY-MM-DD] scan | N backlog items, priority top-3: X, Y, Z`

## What you MUST NOT do

- Do NOT ingest any item — this command never calls `/wiki-ingest` or writes wiki pages.
- Do NOT modify `_processed.json` — this file is updated only by `/wiki-ingest` on the Readwise path.
- Do NOT fabricate Readwise doc IDs or titles — report only what Readwise returns.
- Do NOT reach outside the `general/` namespace or write to vault during a scan.

## Rationale

`/wiki-scan` is the planning surface for wiki curation. The backlog is a menu, not a debt — JT uses the report to decide what to ingest next in the weekly review (BA §11.2). Keeping scan diagnostic-only (Haiku, read-only) makes it fast and cheap: a weekly status call, not a synthesis operation. Integrated with the weekly review for backlog walkthrough per SA §6.4 and BA §8.3.
