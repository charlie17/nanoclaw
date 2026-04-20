# /qmd — Skill Spec (Batch 3.2a — vault semantic search via MCP)

When you need to find vault content (past decisions, incidents, people, projects, patterns), search via qmd FIRST before reading files directly. qmd is faster than Glob/Grep for vault queries and returns relevant snippets without burning context on full file reads.

## Search modes (pick one per query)

1. **`mcp__qmd__query "..."`** — Best quality. Hybrid BM25 + vector + LLM reranking. Use for complex or conceptual queries.
2. **`mcp__qmd__search "..."`** — Fast BM25 keyword. Use for exact terms, names, ticket numbers, dates.
3. **`mcp__qmd__vsearch "..."`** — Semantic only. Use for exploratory queries where you don't know the exact words.

After search, follow up with `Read` on the specific files surfaced — qmd returns paths + snippets, not full contents.

## When to search

- User mentions a past decision, incident, person, project → `mcp__qmd__query`
- User asks "what did we decide about X" → `mcp__qmd__query`
- User mentions a person by name → `mcp__qmd__search "<name>"`
- Before creating a new vault note → `mcp__qmd__vsearch "<topic>"` to check for existing content
- After creating a vault note → `mcp__qmd__vsearch "<note title>"` to find notes that should link to it

## What you MUST NOT do

- Do NOT query the `private` namespace. You have access only to the `general` namespace via the qmd MCP server. The `private` namespace exists on the host but is not wired into your container by design (D-95, D-96). Any qmd tool call that would target `private` is structurally unreachable — do not attempt.
- Do NOT use `Bash` to invoke `qmd` CLI directly when the MCP path is available. The `qmd` CLI is installed in your container as a fallback for MCP outages only — prefer `mcp__qmd__*` tools.
- Do NOT invoke `qmd update` manually. Reindexing runs on the host via hourly cron (reindexes qmd-general's index). If you suspect index staleness mid-session, surface to JT rather than self-update.

## Rationale

qmd is a local semantic search engine over your vault content. It runs as two host daemons (general namespace on port 8181, private namespace on port 8182), each with its own SQLite index and embedding cache. The MCP server at `host.docker.internal:8181/mcp` exposes the general namespace to your container via a socat gateway-IP bridge (D-95 amendment, Impl-28). The bridge restricts access to the daystrom-net container subnet only — external NICs cannot reach it. The private namespace daemon is reachable only from OWUI per D-38; you have no path to it.
