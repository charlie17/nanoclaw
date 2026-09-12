# /qmd — Skill Spec (vault search via MCP)

When you need to find vault content (past decisions, incidents, people, projects, tips, patterns), search via qmd FIRST. The harness blocks `Grep`/`Glob`/Bash-grep against `/workspace/extra/vault` until a qmd query has run in the current turn, and bounces any reply that asserts vault absence without one. qmd returns ranked snippets without burning context on full file reads.

<!-- Rewritten 2026-09-12. The MCP server (qmd 2.1.0) exposes exactly four tools: query, get, multi_get, status.
     There is no vsearch or search tool over MCP; those were CLI verbs. Earlier versions of this file named them,
     which made "semantic first" uncallable and led to the 2026-09-10 false "nothing in the vault" report. -->

## The one search tool

`mcp__qmd__query` takes a `searches` array of typed sub-queries (max 10; the first gets 2x weight) plus flags:

- `type:"lex"` — BM25 keywords; supports `"quoted phrases"` and `-negation`. Exact terms, names, tickers, dates.
- `type:"vec"` — semantic; write a natural-language question.
- `type:"hyde"` — hypothetical answer; write a 50-100 word passage the way the answer would read in the vault.
- `rerank` — `false` = fast (well under a second warm). `true` = LLM reranker on CPU, 77 s measured 2026-09-10, 47 s to 474 s cold. **Default is true, so you must pass `false` explicitly.**
- `collections` — always `["general"]` unless the task is wiki-scoped (`["wiki"]`). `general` already contains `wiki/`; without the filter every wiki page appears twice.
- `intent` — one line of background context; improves snippets and disambiguation. Provide it.
- `limit` (default 10), `minScore` (0-1).

## Mandatory sequence (per lookup)

1. **Semantic, DEFAULT:**
   `mcp__qmd__query {"searches":[{"type":"vec","query":"<question>"}],"rerank":false,"collections":["general"],"intent":"<context>"}`
2. **Exact terms when the question carries one** (name, ticker, date, product): add or run a `lex` sub-query. Combined form, most important sub-query first:
   `mcp__qmd__query {"searches":[{"type":"vec","query":"<question>"},{"type":"lex","query":"<term>"}],"rerank":false,"collections":["general"]}`
3. **Reshape before concluding.** When the top hits are the wrong KIND of match (a source cited in wiki pages when JT wants a how-to tip; project notes when he wants a log entry), rewrite the question toward the workflow or concept and rerun step 1, or run a `hyde` sub-query. Reproduced 2026-09-10: "WSJ Readwise fully parsed" buried the tip under wiki citations; "share an article from the browser to Reader so it is fully parsed" ranked it. At least one reshape is required before any "not found".
4. **Deep, RESERVED:** same call with `"rerank":true`. Only when JT explicitly asks for a deep or thorough search ("dig deep", "I'll wait") and accepts the wait. Never on an automated path (scheduled tasks, prefetch scripts). If it fails or is slow, drop to step 1, never to grep.
5. **Then read.** Fetch hits with `mcp__qmd__get {"file":"<path relative to collection>"}` (e.g. `reference/org-approach.md`, or `#docid`; `fromLine`/`maxLines` for long files) or `Read` the container path under `/workspace/extra/vault/`. `mcp__qmd__multi_get {"pattern":"logs/*/!log.md"}` batches by glob.

**Grep is supplementary.** After qmd has surfaced a file, grep it to confirm an exact string. Grep alone can never establish absence. "Nothing in the vault about X" is allowed only after steps 1 and 3 have both run this turn and come back empty; name the queries you ran.

## When to search

- JT mentions a past decision, incident, person, project, tip → step 1
- "What did we decide about X" / "anything in the vault about X" → steps 1 and 3 before answering
- JT names a person, product or ticker → add a `lex` sub-query
- Before creating a new vault note → step 1 on the topic to check for existing content
- After creating a vault note → step 1 on the note title to find notes that should link to it
- JT explicitly asks to dig deep → step 4

## What you MUST NOT do

- Do NOT query the `private` namespace. You have access only to the `general` namespace via the qmd MCP server. The `private` namespace exists on the host but is not wired into your container by design (D-95, D-96). Any call that would target `private` is structurally unreachable — do not attempt.
- Do NOT use `Bash` to invoke the `qmd` CLI when the MCP path is available. The CLI in your container is a fallback for MCP outages only.
- Do NOT invoke `qmd update` or `qmd embed`. Reindexing runs on the host hourly (`qmd-reindex.sh`: update + embed). If results look stale (a file you just read is missing from hits), say so to JT rather than self-update; the host health probe also watches index freshness.

## Rationale

qmd is a local search engine over the vault. Two host daemons (general on port 8181, private on 8182) each own a SQLite index and embedding cache. The MCP server at `172.29.0.1:8181/mcp` (daystrom-net gateway) exposes the general namespace to your container via a socat gateway-IP bridge (D-95 amendment, Impl-28); external NICs cannot reach it. The private daemon is reachable only from OWUI per D-38.
