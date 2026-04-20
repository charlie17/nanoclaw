# /research — Skill Spec

## Overview

JT invokes `/research <query>`. Synthesize from three source pools: Readwise full library (MCP), vault (qmd), and prior research reports/wiki/images also discoverable via qmd. Two paths: **sync** (Readwise + vault sufficient — write directly to vault) and **supplement** (web search via O'Brien when sync sources are insufficient). Model: Opus default (D-78).

## Model dispatch

Default model: Opus (D-78). At session start, announce: `"Using Opus for this research — switch to Sonnet if you'd like (/model sonnet)."` JT can switch mid-conversation via the `/model` native Claude Code command. Do NOT change the default to Sonnet.

## Sync path

### Source pool 1 — Readwise full library

Run both Readwise search surfaces **in parallel**:

```
mcp__readwise__reader_search_documents(query="<JT query>")                 # hybrid (semantic + keyword)
mcp__readwise__readwise_search_highlights(vector_search_term="<JT query>") # semantic
```

`reader_search_documents` is **hybrid (semantic + keyword)** across Daystrom's Readwise library (Reader documents). `readwise_search_highlights` is semantic across highlights. Merge results by document ID; de-duplicate.

### Signal hierarchy

Within the matched result set, prioritize in order:
- Items where JT has written notes — use full_text_queries to surface them:
    mcp__readwise__readwise_search_highlights(
      vector_search_term="<JT query>",
      full_text_queries=[{"field_name": "highlight_note", "search_term": "<JT query>"}]
    )
  Treat notes as curation instructions — JT uses them to state ideas and connections.
- Items with highlighted passages (JT marked specific text as noteworthy).
- Starred/tagged items: modest rank boost; do NOT let starring rescue an off-topic item.
- Unmarked items are accessible but carry less curation signal.

Topical relevance is always the first filter. Annotation signals apply within the
matched set only — never override a relevance mismatch.

### Scoped steering

When JT scopes the query ("scan Readwise specifically for X"; "articles about Y from Z"; "notes I wrote last month on W"), map scope hints to `reader_search_documents` filter params. Filter menu:

- `author_search` — JT names an author.
- `tags_in` (list) — JT names a tag.
- `published_date_gt`, `published_date_lt` — JT constrains by publication date.
- `location_in` (list: `new`/`later`/`shortlist`/`archive`/`feed`) — JT constrains by Readwise status.
- `title_search`, `summary_search`, `note_search` — JT constrains by field content.
- `category_in` (list: `article`/`book`/`podcast`/`video`/`tweet`/`email`/`pdf`/`epub`/`rss`) — JT constrains by content type.

Examples:

```
JT: "/research spaced repetition, articles by Oakley from the last 2 years"
→ reader_search_documents(query="spaced repetition", author_search="Oakley",
    published_date_gt="2024-04-20", category_in=["article"])

JT: "/research TIPS investing, only things I've tagged 'finance'"
→ reader_search_documents(query="TIPS investing inflation-protected treasuries",
    tags_in=["finance"])
```

### Source pool 2 — Vault via qmd

Query the `general` namespace via qmd:

```
mcp__qmd__query "<JT query>"
```

`general` namespace covers prior `/research` reports (type: `research-report`), wiki pages (type: `wiki-page`), image-capture companions (type: `image-capture`), learning entries, brainstorm artifacts, and project notes. Single call surfaces them all. Fall back to `mcp__qmd__vsearch` if hybrid query returns sparse results on exploratory topics. The `private` namespace is structurally unreachable from this container — do not attempt.

### Synthesis

Produce a **structured research note** — not a raw search dump, not a list of links. Standalone, useful, cross-linked to relevant vault content via Obsidian `[[wikilinks]]`. Answer JT's query with synthesized findings. Call out when source material is sparse or stale. Quote JT's own notes where they directly bear on the question (JT's notes are the highest-confidence signal per the hierarchy above). Where relevant wiki pages exist, link them; where a topic could benefit from a new wiki page, mention it. NEVER auto-create wiki pages from `/research` — wiki promotion is JT-invoked only.

### Output

Path: `general/research/research-{YYYY-MM-DD}-{topic-slug}.md` (matches `groups/daystrom/CLAUDE.md:91` convention). Frontmatter:

```yaml
---
type: research-report
run-mode: sync
created: {ISO8601}
topic: "{JT's topic, verbatim}"
---
```

No `trust` field — absence is the trust signal (sync-path sources are JT-curated Readwise + prior Daystrom output; no untrusted web content).

### Telegram reply

Reply format (draft — JT tweak-rights reserved):

Per CLAUDE.md `## Telegram Output Format` — plain-text only, no `|` column syntax. Example for `/research spaced repetition`:

```
Research complete: spaced repetition

[Open in Obsidian](https://daystrom-link.daystrom.workers.dev/?u=obsidian%3A%2F%2Fopen%3Fvault%3DObsidianDaystromVault%26file%3Dgeneral%2Fresearch%2Fresearch-2026-04-20-spaced-repetition)

Top sources:
1. "Make It Stick" highlights — 12 passages on retrieval practice [your note: "key for Anki redesign"]
2. Foer article (archived) — your note: "Anki only works if you build the habit"
3. "Learning How to Learn" (Oakley) — spaced vs massed practice, 4 highlights
4. Spaced repetition vault note — prior research report from 2026-02-14
5. "The Science of Self-Learning" (starred) — 3 highlights on interval scheduling
```

Shape rules:
- Line 1: topic confirmation one-liner
- Line 2: Obsidian deep-link (CF worker URL wrapping `obsidian://open?vault=ObsidianDaystromVault&file=general/research/{filename-without-extension}`)
- Blank line
- "Top sources:" plain-text header
- 3–5 numbered source items, one per line
- JT's own notes quoted inline with `[your note: "..."]` when present
- Never use `|` / `-+-` / table syntax

## Supplement decision

When sync-path sources are insufficient — Readwise + vault too sparse for the query, or content is stale for a "what's recent" type query — recommend a web-search supplement and ask JT for confirmation per D-23. Use the prompt wording verbatim from the dispatch procedure below: `"I'd like to run a web search for this. OK?"` On confirmation, proceed to the dispatch procedure below.

## Dispatch procedure (web-search supplement only)

1. Ask JT for confirmation: "I'd like to run a web search for this. OK?" (D-23 default: ask when in doubt).
2. On confirmation, generate `<topic-slug>` from JT's query (kebab-case, short, descriptive — e.g., "ai-alignment").
3. Write the queue entry using your `Write` tool:

   Path: `/workspace/extra/research-queue/<topic-slug>-<YYYYMMDDHHMMSS>.json`
   Content:
   ```json
   {
     "id": "<topic-slug>-<timestamp>",
     "topic": "<topic-slug>",
     "query": "<JT's original query verbatim>",
     "timestamp": "<ISO8601 timestamp>"
   }
   ```
4. Reply to JT: "Research dispatched. You'll be pinged on Telegram when the results are ready for review."
5. You are DONE with this request. Do not attempt to poll, wait, or read the result.

**Note on filenames:** The quarantine file will be named `<topic-slug>-<YYYYMMDDHHMMSS>.md` (matching the queue entry `id` field), not just `<topic-slug>.md`. This ensures repeat queries on the same topic never overwrite each other. JT may rename the file during the clearance move to `general/research/` if desired.

## What you MUST NOT do

- Do NOT make any Anthropic API call with `web_search_20250305` enabled. (The credential proxy will reject it with 403 anyway, but do not try.)
- Do NOT use `Bash` to `curl` Anthropic directly for any purpose. Your normal LLM API calls are mediated by NanoClaw's SDK layer — you don't need to construct them manually.
- Do NOT write to `general/research/` for supplement results. The file lands in `quarantine/research/` (via O'Brien), not `general/research/`.
- Do NOT inform JT of the quarantine file location manually. `obrien-notify.sh` sends the ping with the cf-worker link.
- Do NOT attempt to read from `/vault/quarantine/` — the folder is not bind-mounted into your container and does not exist in your filesystem.

## Rationale

Web-search results contain uncurated open-web content with potential prompt-injection payloads. Under D-90 (SA §4.1 Leg 3), you never see the returned payload directly. O'Brien (a non-AI host daemon) receives the API response, writes it to a quarantine folder you cannot access, and notifies JT via Telegram. JT reviews in Obsidian, clears the trust flag, and moves the file into `general/research/` where you can read it normally.
