# /wiki-lint — Skill Spec (Karpathy wiki health-check, on-demand)

When JT invokes `/wiki-lint`, audit the wiki for health issues. On-demand only — Friday pipeline Stage 2 auto-run is deferred to Batch 4.2. Announce model: "Running `/wiki-lint` with Opus — full wiki audit."

## Audit dimensions

Six dimensions, audited in order:

1. **Contradictions** — conflicting claims across pages, especially where a newer source supersedes an older one. Flag for JT's editorial judgment; do NOT auto-correct.
2. **Stale claims** — assertions that newer ingested sources have updated or invalidated. Flag for JT review.
3. **Orphan pages** — pages with no inbound `[[wikilinks]]` from other wiki pages.
4. **Missing concept pages** — important concepts mentioned across multiple pages but lacking a dedicated page.
5. **Missing cross-references** — related pages that should link to each other but don't.
6. **Data gaps** — topic areas that could be enriched by ingesting additional `daystrom-wiki`-tagged sources or running `/research`.

## Output split

**(a) Auto-corrections** — executed inline: add missing `[[wikilinks]]` cross-references; update `!index.md` (missing entries, stale summaries, category fixes).

**(b) JT-attention items** — reported but not auto-corrected: contradictions, stale claims requiring judgment, data gaps suggesting new sources.

## Log format

Append to `general/wiki/log.md` after the audit:

`## [YYYY-MM-DD] lint | <summary>` followed by sub-sections `### Auto-corrected` and `### JT attention required`.

## Invocation

On-demand via `/wiki-lint` at any time. **Friday pipeline Stage 2 auto-run deferred to Batch 4.2** — this batch ships the on-demand path only.

## What you MUST NOT do

- Do NOT auto-correct contradictions — editorial judgment required; surface to JT.
- Do NOT modify wiki page content beyond adding missing `[[wikilinks]]` cross-references.
- Do NOT write to vault dimensions outside `general/wiki/`.
- Do NOT ingest new sources during a lint run.

## Rationale

The Karpathy method prescribes periodic lint as mandatory wiki maintenance — without it, contradictions accumulate, orphan pages proliferate, and the wiki drifts into inconsistency (`02-karpathy-wiki-method.md` §Lint). The auto-correct / JT-attention split keeps Daystrom's autonomous footprint minimal: mechanical fixes happen inline; judgment calls surface to JT. Opus is required for contradiction detection and missing-concept identification — strong-reasoning tasks with no cheap shortcut. D-24 + D-63 govern health-check cadence. SA §6.4 + BA §8.3.
