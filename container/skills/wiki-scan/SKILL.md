# /wiki-scan — Skill Spec (Karpathy backlog diagnostic, read-only)

When JT invokes `/wiki-scan`, report the delta between `daystrom-wiki`-tagged Readwise items and what the wiki has already processed. This is a diagnostic-only command — you do NOT ingest anything.

Announce model at start: "Running `/wiki-scan` with Haiku — diagnostic report only."

## Scan flow

1. Run `readwise reader-list-documents --tag daystrom-wiki --location archive` → collect all tagged Readwise doc IDs and titles. (`[impl-verify]` — command shape per BA §8.4; output format confirmed at first smoke-test.)
2. Read `general/wiki/_processed.json` → collect set of already-processed doc IDs.
3. Compute delta: tagged items NOT in `_processed.json` = unprocessed backlog.
4. Rank the delta by Readwise signal: starred items first, then by highlight density (items with more highlights rank higher), then by recency.
5. Report to JT: backlog count + top-N candidates with titles + suggested priority order for the next ingest cycle.

## Output shape

Conversational report. Optional markdown table for the top candidates. No vault writes during a scan run.

Optional `log.md` append (only if JT asks): `## [YYYY-MM-DD] scan | N backlog items, priority top-3: X, Y, Z`

## What you MUST NOT do

- Do NOT ingest any item — this command never calls `/wiki-ingest` or writes wiki pages.
- Do NOT modify `_processed.json` — this file is updated only by `/wiki-ingest` on the Readwise path.
- Do NOT fabricate Readwise doc IDs or titles — report only what the CLI returns.
- Do NOT reach outside the `general/` namespace or write to vault during a scan.

## Rationale

`/wiki-scan` is the planning surface for wiki curation. The backlog is a menu, not a debt — JT uses the report to decide what to ingest next in the weekly review (BA §11.2). Keeping scan diagnostic-only (Haiku, read-only) makes it fast and cheap: a weekly status call, not a synthesis operation. Integrated with the weekly review for backlog walkthrough per SA §6.4 and BA §8.3.
