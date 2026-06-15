# /wiki-query — Skill Spec (Karpathy query, wiki-scoped semantic search)

When JT asks a "what do I know about X" question or explicitly invokes `/wiki-query`, search the wiki corpus as the primary surface. This is the durable-understanding command — synthesized knowledge, not fresh research.

Announce model at start: "Running `/wiki-query` with Opus." Offer to switch: "Say `/model sonnet` for a quicker lookup."

## Query flow

<!-- DEFAULT VERB POLICY (Impl-72 / 2026-06-15): /wiki-query uses vsearch for both primary and secondary
     passes. Hybrid query (mcp__qmd__query) is CPU-bound on this hardware (~47s–474s cold) and must NOT be
     used as a default on any interactive path. See FORK-BASELINE.md:215. Use mcp__qmd__query only if JT
     explicitly requests deeper/thorough retrieval and accepts the wait. -->

1. Read `general/wiki/!index.md` first to identify candidate pages relevant to JT's question (Karpathy index-first discipline).
2. **Primary search:** `mcp__qmd__vsearch "<question>" -c wiki` — scoped to the `wiki` sub-collection (`general/wiki/`). Read the surfaced pages in full. If the query contains exact terms or proper nouns, also run `mcp__qmd__search "<question>" -c wiki` and merge results.
3. **Secondary search:** `mcp__qmd__vsearch "<question>" -c general` — cross-reference pass over the full `general` namespace. Use results for connection surfacing only — research notes, learning entries, brainstorm artifacts, and project notes that carry query-relevant value the wiki doesn't yet cover. This is supplementary, not primary synthesis.
4. Synthesize an answer from the primary wiki results, enriched with connections from the secondary pass. Cite source wiki pages with `[[wikilinks]]`.

## Output forms

Select the form that fits JT's question shape:
- **Markdown page** (default) — structured answer with cross-references
- **Comparison table** — when JT is contrasting entities, concepts, or options
- **Marp slide deck** — markdown-based presentation (Obsidian Marp plugin renders it); use when JT wants a structured presentation of findings

## Filing back

Valuable query results can become new wiki pages — explorations compound in the knowledge base just like ingested sources. Before filing, ask JT: "Want me to file this back as a wiki page?" On confirmation:
- Write `general/wiki/<slug>.md` with standard wiki-page frontmatter (see `wiki/SKILL.md`)
- Set `provenance.source: vault` (or `readwise` if the synthesis drew primarily from Readwise-sourced wiki pages), `provenance.via: /wiki-query`, `source-refs: []` (or list relevant Readwise doc IDs)
- Update `!index.md` with the new page entry
- Append to `log.md`: `## [YYYY-MM-DD] query-filed | <Title>`

## What you MUST NOT do

- Do NOT write to the wiki during a query unless JT explicitly confirms filing back.
- Do NOT reach outside the `general/` namespace — no `private` namespace, no web search.
- Do NOT use web search as a fallback for missing wiki content; surface the gap to JT instead.

## Rationale

The wiki is the primary synthesized-understanding surface for `/wiki-query`. The secondary `general/` pass surfaces connections the wiki doesn't yet cover — this is how the knowledge base compounds over time. Two-collection scoping (primary `wiki`, secondary `general`) is implemented via two sequential `mcp__qmd__vsearch` calls rather than a single wide query, keeping primary-scope semantics clean and the wiki as the authoritative answer surface. Cite SA §6.4 + BA §8.3 for the query architecture. D-78 model-announce pattern applies.
