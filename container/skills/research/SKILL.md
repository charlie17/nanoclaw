# /research — Skill Spec

## Overview

JT invokes `/research <query>`. Synthesize from three source pools: Readwise full library (MCP), vault (qmd), and prior research reports/wiki/images also discoverable via qmd. Two paths: **sync** (Readwise + vault sufficient — write directly to vault) and **supplement** (web search via O'Brien when sync sources are insufficient). Model: Opus default (D-78).

## Model dispatch

Default model: Opus (D-78).

**Before executing any research, do the following in order:**

1. Announce: `"Using Opus for this research — switch to Sonnet if you'd like (/model sonnet)."`
2. Ask: `"Run now (vault + Readwise only, ~30-60s) or dispatch O'Brien to run a web search (~5-10 min)?"`
3. Wait for JT's reply before proceeding. If JT says "run now" (or equivalent affirmation), proceed to the sync path below. If JT says "O'Brien" or "web search" or "dispatch", proceed directly to the dispatch procedure below without running the sync path first.

JT can switch models mid-conversation via the `/model` native Claude Code command. Do NOT change the default to Sonnet.

## Sync path

### Source pool 1 — Readwise full library

Run both Readwise search surfaces **in parallel**:

```
mcp__readwise__reader_search_documents(query="<JT query>")                 # hybrid (semantic + keyword)
mcp__readwise__readwise_search_highlights(vector_search_term="<JT query>") # semantic
```

`reader_search_documents` is **hybrid (semantic + keyword)** across Daystrom's Readwise library (Reader documents). `readwise_search_highlights` is semantic across highlights. Merge results by document ID; de-duplicate.

Capture `id` and `location` for every surfaced document — you need both to construct the deep-link in the Telegram reply (see `### Telegram reply` below + CLAUDE.md `## Telegram Output Format` → Deep-linking). For `readwise_search_highlights`, join each highlight to its parent doc via `document_id` + `document_location` in the response.

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
mcp__qmd__vsearch "<JT query>"
```

<!-- DEFAULT VERB POLICY (Impl-72 / 2026-06-15): vsearch is the default for vault retrieval on the /research
     sync path. Hybrid query (mcp__qmd__query) is CPU-bound on this hardware (~47s–474s cold) and must NOT be
     used as a default on any path. See FORK-BASELINE.md:215. -->

`general` namespace covers prior `/research` reports (type: `research-report`), wiki pages (type: `wiki-page`), image-capture companions (type: `image-capture`), learning entries, brainstorm artifacts, and project notes. Single call surfaces them all. If vsearch returns sparse results, try `mcp__qmd__search "<JT query>"` for exact-term coverage. Use `mcp__qmd__query` only if JT explicitly requests a deeper search and accepts the wait. The `private` namespace is structurally unreachable from this container — do not attempt.

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
model: "{model used, e.g. claude-opus-4-7}"
sources: "{N Readwise items + N vault notes}"
---
```

Immediately after the frontmatter block, add a provenance line before the synthesis body:

```
Drawn from: {N} Readwise items + {N} vault notes
```

No `trust` field — absence is the trust signal (sync-path sources are JT-curated Readwise + prior Daystrom output; no untrusted web content).

### Telegram reply

Per CLAUDE.md `## Reply Discipline (executive tone)` + `## Telegram Output Format`. Each cited source title is a markdown deep-link per CLAUDE.md `### Deep-linking items you surface` (Readwise: `https://read.readwise.io/{location}/read/{id}`; vault: Obsidian CF-worker URL).

**Shape:**
1. **Synthesis preview line** — 1-2 sentences in plain English answering the question JT actually asked. The synthesis itself, not a "research complete" confirmation. Surface the load-bearing finding; if there's a high-confidence nuance worth flagging on the phone (e.g., "but most studies are short-window"), one extra sentence is fine.
2. **Obsidian deep-link** — for the newly written research report.
3. **Blank line, then `Top sources:` header.**
4. **3-5 numbered source items**, blank line between items, one source per line. Title as markdown deep-link, then ` — ` separator, then concise metadata (highlight count or "starred" or "your note: \"...\"" — pick the most signal-rich attribute).

**Worked example for `/research spaced repetition`:**

```
Anki + retrieval practice is the highest-leverage learning technique for durable recall — ~30 min/day across 2 months builds long-term retention. Caveat: it only works if the habit sticks.

[Open in Obsidian](https://daystrom-link.daystrom.workers.dev/?u=obsidian%3A%2F%2Fopen%3Fvault%3DObsidianDaystromVault%26file%3Dgeneral%2Fresearch%2Fresearch-2026-04-20-spaced-repetition)

Top sources:

1. ["Make It Stick"](https://read.readwise.io/archive/read/01kpdqd374qhavgs79cbp9vr8q) — your note: "key for Anki redesign"

2. [Foer article](https://read.readwise.io/archive/read/01kpabc123xyz) — your note: "Anki only works if you build the habit"

3. ["Learning How to Learn" (Oakley)](https://read.readwise.io/later/read/01kpdef456uvw) — spaced vs massed practice

4. [Spaced repetition vault note](https://daystrom-link.daystrom.workers.dev/?u=obsidian%3A%2F%2Fopen%3Fvault%3DObsidianDaystromVault%26file%3Dgeneral%2Fresearch%2Fresearch-2026-02-14-spaced-repetition) — prior research report

5. ["The Science of Self-Learning"](https://read.readwise.io/archive/read/01kpghi789rst) (starred) — interval scheduling
```

The synthesis preview line gives JT enough to act from the phone alone (or to decide opening Obsidian is worth it). The numbered list is loose (blank line between items). No trailing "research complete" recap — the preview + link + sources IS the close-out.

## Supplement decision

When sync-path sources are insufficient — Readwise + vault too sparse for the query, or content is stale for a "what's recent" type query — recommend a web-search supplement and ask JT for confirmation per D-23. Use the prompt wording verbatim from the dispatch procedure below: `"I'd like to run a web search for this. OK?"` On confirmation, proceed to the dispatch procedure below.

## Dispatch procedure (web-search supplement only)

1. **Confirm fresh dispatch intent.** Verify the LITERAL `/research` slash-command invocation appears in the most recent user message (the one currently being processed), or that JT just answered "yes" / "OK" / "go" to your own immediately-prior question about web-search dispatch. If neither — STOP. Do not dispatch. The query text being present in older conversation history is NOT sufficient justification; only act on a fresh, explicit invocation in the current turn. This prevents context bleed from prior topic-completed dispatches.
2. Ask JT for confirmation: "I'd like to run a web search for this. OK?" (D-23 default: ask when in doubt).
3. On confirmation, generate `<topic-slug>` from JT's query (kebab-case, short, descriptive — e.g., "ai-alignment").
4. Write the queue entry using your `Write` tool:

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
5. Reply to JT: "Research dispatched. You'll be pinged on Telegram when the results are ready for review."
6. You are DONE with this request. Do not attempt to poll, wait, or read the result.

**Note on filenames:** The quarantine file will be named `<topic-slug>-<YYYYMMDDHHMMSS>.md` (matching the queue entry `id` field), not just `<topic-slug>.md`. This ensures repeat queries on the same topic never overwrite each other. JT may rename the file during the clearance move to `general/research/` if desired.

## What you MUST NOT do

- Do NOT make any Anthropic API call with `web_search_20250305` enabled. (The credential proxy will reject it with 403 anyway, but do not try.)
- Do NOT use `Bash` to `curl` Anthropic directly for any purpose. Your normal LLM API calls are mediated by NanoClaw's SDK layer — you don't need to construct them manually.
- Do NOT write to `general/research/` for supplement results. The file lands in `quarantine/research/` (via O'Brien), not `general/research/`.
- Do NOT inform JT of the quarantine file location manually. `obrien-notify.sh` sends the ping with the cf-worker link.
- Do NOT attempt to read from `/vault/quarantine/` — the folder is not bind-mounted into your container and does not exist in your filesystem.

## Rationale

Web-search results contain uncurated open-web content with potential prompt-injection payloads. Under D-90 (SA §4.1 Leg 3), you never see the returned payload directly. O'Brien (a non-AI host daemon) receives the API response, writes it to a quarantine folder you cannot access, and notifies JT via Telegram. JT reviews in Obsidian, clears the trust flag, and moves the file into `general/research/` where you can read it normally.

## Why dispatch is gated on the current turn

The dispatch action (a `Write` of the queue JSON) is a side effect — once written, O'Brien picks it up and runs a multi-minute paid web search. False dispatches cost tokens, JT attention, and confused conversation context. Daystrom's session resumes across topics, so verbatim user queries from days-old conversations remain in context and can re-trigger the dispatch action on otherwise-unrelated turns. The guardrail at step 1 makes the dispatch dependent on the current turn alone, not on conversation history.
