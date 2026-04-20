# /wiki-ingest — Skill Spec (Karpathy ingest, one-at-a-time)

When JT invokes `/wiki-ingest`, process the next unprocessed `daystrom-wiki`-tagged Readwise item into the wiki. One source per invocation. Announce model: "Running `/wiki-ingest` with Opus."

## Readwise path (default)

1. Read `general/wiki/_processed.json`. Run `readwise reader-list-documents --tag daystrom-wiki --location archive` to list tagged items. (`[impl-verify]` — command shapes per BA §8.4.) Select the next item NOT in the ledger. Fetch its content with `readwise reader-get-document-details --document-id <id>` and highlights with `readwise reader-get-document-highlights --document-id <id>`.
2. Run `mcp__qmd__query` over the full `general` namespace to surface what Daystrom already knows that's relevant to this source.
3. **Ask JT about emphasis** before synthesizing: *"Should I build the page primarily from your highlights and notes, or treat the full body as primary with highlights and notes as color?"* Ask fresh each ingest — do not persist across sessions.
4. Discuss key takeaways with JT. Surface what's new, what connects, what contradicts prior understanding. **Provenance distinction:** clearly indicate what came from the raw Readwise source vs. existing vault content (Karpathy L9 mandate).
5. Integrate into the wiki: create/update pages at `general/wiki/<slug>.md` with standard wiki-page frontmatter (below). Maintain `[[wikilinks]]` cross-references. One source may touch many pages.
6. Update `_processed.json`. Schema: `{ "<readwise-doc-id>": { "ingested_at": "<ISO8601 UTC>", "pages_touched": ["<slug>.md", ...] } }`
7. Update `!index.md` (add/modify entries; maintain category groupings). Append to `log.md`:
   <!-- JT: pattern from upstream add-karpathy-llm-wiki/llm-wiki.md L50 -->
   `## [YYYY-MM-DD] ingest | <Article Title>`

## Vault-only path (D-80)

If JT invokes naturally without a Readwise source — e.g. *"Create a wiki page on X"* — skip steps 1 and 3 above. Instead:
- Run `mcp__qmd__query` over the full `general` namespace to gather vault material.
- Announce what you found and ask JT to confirm scope before synthesizing.
- Proceed from step 5. Do NOT update `_processed.json`. Set `provenance.source: vault`, `source-refs: []`.

## Wiki page frontmatter

```yaml
---
created: <YYYY-MM-DD HH:MM ET>
updated: <YYYY-MM-DD HH:MM ET>
type: wiki-page
wiki-topic: <slug>
provenance:
  source: readwise          # or "vault" for D-80 path
  by: daystrom
  via: /wiki-ingest
source-refs:                # list of Readwise doc IDs; [] for D-80 vault path
  - <readwise-doc-id>
related-pages:              # optional: sibling wiki pages
  - "[[other-wiki-page]]"
---
```

## One-at-a-time discipline

<!-- JT: pattern from upstream add-karpathy-llm-wiki/SKILL.md §3c -->
When JT points at multiple sources or a tagged backlog, process one at a time. For each source: read it, discuss takeaways, create/update all wiki pages (summary, entities, concepts, cross-references, index, log), and completely finish before moving to the next. Never batch-read many sources then synthesize — the pattern produces shallow pages instead of deep integration.

## What you MUST NOT do

- Do NOT batch-read multiple sources before processing — one at a time, always.
- Do NOT write to vault dimensions other than `general/wiki/` — wiki work is ringfenced to the Research dimension only (Karpathy prime directive).
- Do NOT invent Readwise doc IDs — use only IDs returned by the CLI.
- Do NOT skip the `_processed.json` update on the Readwise path (D-17 idempotency).
- Do NOT self-trigger `/wiki-ingest` — invocation is always explicit by JT (D-17).

## Rationale

The Karpathy method builds a persistent, compounding knowledge base by integrating each source into the existing wiki — not just summarizing in isolation. Four correctness invariants: provenance stamping (Karpathy L9) + ledger idempotency (D-17) + `daystrom-wiki` tag gate (D-58, D-59) + Research-dimension ringfencing (D-63). The D-80 vault-only path preserves tag-gated Readwise discipline while enabling wiki pages from existing vault content. Cite SA §6.4 + BA §8.3.
