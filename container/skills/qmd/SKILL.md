# /qmd — Skill Spec (Batch 3.2a — vault semantic search via MCP)

When you need to find vault content (past decisions, incidents, people, projects, patterns), search via qmd FIRST before reading files directly. qmd is faster than Glob/Grep for vault queries and returns relevant snippets without burning context on full file reads.

## Search modes (pick one per query)

<!-- DEFAULT VERB POLICY (Impl-72 / 2026-06-15): vsearch is the default for all automated and interactive vault lookups.
     search (BM25) is the secondary for exact-term/proper-noun/ticker lookups.
     query (hybrid) is RESERVED for explicit deep-retrieval requests only — never a silent default.
     Rationale: on this CPU (GPU: none, 4 math cores), hybrid query runs the embedding model + Qwen3 reranker +
     1.7B query-expansion model in series and has measured latency of 47s–474s cold. vsearch (embed only) runs
     in ~12s. BM25 search runs in <1s. The FORK-BASELINE.md:215 note already documented this tradeoff as
     "not production hot-path." The weekly-review timed out because hybrid was wired into an automated path.
     DO NOT re-default any automated or interactive path to hybrid query without explicit JT authorization. -->

1. **`mcp__qmd__vsearch "..."`** — **DEFAULT. Semantic (vector) search.** Use for conceptual queries, past decisions, incidents, topic exploration. Completes in ~12s on this hardware.
2. **`mcp__qmd__search "..."`** — **Fast BM25 keyword.** Use for exact terms, proper nouns, names, ticker symbols, ticket numbers, dates — any query where the exact word matters more than meaning.
3. **`mcp__qmd__query "..."`** — **RESERVED. Hybrid BM25 + vector + LLM reranking.** CPU-bound on this box (~47s–474s cold, all 4 cores pinned). Invoke ONLY when JT explicitly asks for deep or thorough retrieval and accepts the wait ("dig deep", "I'll wait", "thorough search"). NEVER invoke on any automated path (scheduled tasks, prefetch scripts) or as a silent interactive default.

After search, follow up with `Read` on the specific files surfaced — qmd returns paths + snippets, not full contents.

## When to search

- User mentions a past decision, incident, person, project → `mcp__qmd__vsearch`
- User asks "what did we decide about X" → `mcp__qmd__vsearch`
- User mentions a person by name → `mcp__qmd__search "<name>"`
- Before creating a new vault note → `mcp__qmd__vsearch "<topic>"` to check for existing content
- After creating a vault note → `mcp__qmd__vsearch "<note title>"` to find notes that should link to it
- JT explicitly requests deep/thorough retrieval ("dig deep", "I'll wait") → `mcp__qmd__query`

## What you MUST NOT do

- Do NOT query the `private` namespace. You have access only to the `general` namespace via the qmd MCP server. The `private` namespace exists on the host but is not wired into your container by design (D-95, D-96). Any qmd tool call that would target `private` is structurally unreachable — do not attempt.
- Do NOT use `Bash` to invoke `qmd` CLI directly when the MCP path is available. The `qmd` CLI is installed in your container as a fallback for MCP outages only — prefer `mcp__qmd__*` tools.
- Do NOT invoke `qmd update` manually. Reindexing runs on the host via hourly cron (reindexes qmd-general's index). If you suspect index staleness mid-session, surface to JT rather than self-update.

## Rationale

qmd is a local semantic search engine over your vault content. It runs as two host daemons (general namespace on port 8181, private namespace on port 8182), each with its own SQLite index and embedding cache. The MCP server at `172.29.0.1:8181/mcp` (daystrom-net gateway) exposes the general namespace to your container via a socat gateway-IP bridge (D-95 amendment, Impl-28). The bridge restricts access to the daystrom-net container subnet only — external NICs cannot reach it. The private namespace daemon is reachable only from OWUI per D-38; you have no path to it.
