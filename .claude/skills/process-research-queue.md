Batch research processing using the Anthropic Message Batches API (50% off all tokens).

Two contexts in which this runs:
1. **Immediate batch dispatch** — JT chose "Batch" when requesting research. Call this right after queueing the item.
2. **Nightly sweep** — Scheduled task at 2 AM picks up stragglers, retries failures, polls in-progress batches.

---

## Queue File

Location: `/workspace/extra/vault-general/general/research/_batch_queue.json`

Format — array of items:
```json
[
  {
    "id": "batch-1745000000000",
    "query": "Best practices for ARM cloud workloads",
    "topic": "arm-cloud-best-practices",
    "requestedAt": "2026-04-21T10:00:00",
    "status": "pending",
    "batchId": null,
    "resultFile": null
  }
]
```

`status` values: `pending` → `submitted` → `complete` | `failed`

If the queue file doesn't exist, create it as an empty array `[]`.

---

## Step 1 — Read the Queue

Read `_batch_queue.json`. Process items by status:
- `pending` → submit a new batch
- `submitted` → check status of existing batch
- `complete` / `failed` → skip (will be cleaned up)

If nothing to process, report "Queue empty — nothing to process." and stop.

---

## Step 2 — Submit a Pending Item (curl)

For each `pending` item, submit a Message Batch:

```bash
BATCH_RESPONSE=$(curl -s -X POST "$ANTHROPIC_BASE_URL/v1/messages/batches" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "requests": [{
      "custom_id": "'"$ITEM_ID"'",
      "params": {
        "model": "claude-sonnet-4-6",
        "max_tokens": 8192,
        "system": [{
          "type": "text",
          "text": "You are a research assistant. Search the web thoroughly and write a comprehensive, well-structured research report. Include key findings, multiple perspectives, and source URLs. Format in plain markdown with sections and bullet points.",
          "cache_control": {"type": "ephemeral", "ttl": "1h"}
        }],
        "messages": [{
          "role": "user",
          "content": "Research this topic thoroughly and write a detailed report: '"$RESEARCH_QUERY"'"
        }],
        "tools": [{"type": "web_search_20250305", "name": "web_search"}]
      }
    }]
  }')
```

Extract `id` from the response (the batch ID, format: `msgbatch_...`).

Update the queue item: `status: "submitted"`, `batchId: "<extracted id>"`.

Write the updated queue file back.

---

## Step 3 — Poll a Submitted Item

For each `submitted` item, check batch status:

```bash
STATUS_RESPONSE=$(curl -s "$ANTHROPIC_BASE_URL/v1/messages/batches/$BATCH_ID" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01")
```

Check `processing_status` in response:
- `in_progress` → update nothing, report still waiting
- `ended` → proceed to Step 4

---

## Step 4 — Process Completed Results

When batch status is `ended`, download results:

```bash
RESULTS=$(curl -s "$ANTHROPIC_BASE_URL/v1/messages/batches/$BATCH_ID/results" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01")
```

Results are JSONL — one JSON object per line. For each result:
- If `result.type == "succeeded"`: extract text from `result.message.content[0].text`
- If `result.type == "errored"`: mark item as `failed`, log the error

For succeeded results, write to vault:

**Path:** `general/research/research-{YYYY-MM-DD}-{topic-slug}.md`

**Frontmatter** (untrusted — web-sourced content):
```yaml
---
type: research
topic: "{query}"
requested: {requestedAt date}
completed: {today}
source: batch
run-mode: batch
trust: untrusted
---
```

Write the research report content below the frontmatter.

Update queue item: `status: "complete"`, `resultFile: "research-{date}-{slug}.md"`.

---

## Step 5 — Notify JT

After processing all complete items, send a Telegram summary via `mcp__nanoclaw__send_message`:

```
Batch research complete:
• {topic}: research-{date}-{slug}.md
  obsidian://open?vault=ObsidianDaystromVault&file=general/research/research-{date}-{slug}

{N} item(s) processed. Queue cleared.
```

For failed items: list them and ask if JT wants to retry.

---

## Step 6 — Clean the Queue

Remove items with `status: "complete"` that are older than 7 days. Failed items stay until JT manually retries or dismisses.

Write the trimmed queue file back.

---

## Scheduling the Nightly Sweep

On first run or if not already scheduled, create a nightly task:

```
mcp__nanoclaw__schedule_task:
  prompt: "Run /process-research-queue — check _batch_queue.json for pending or submitted batch research items, process any that are ready, write results to vault, notify JT."
  schedule_type: cron
  schedule_value: "0 2 * * *"
  context_mode: isolated
```

Check with `mcp__nanoclaw__list_tasks` first — only create if no nightly process-research-queue task already exists.

---

## API-Key Mode Check

Before any batch API call: if `$ANTHROPIC_API_KEY` is `placeholder` and the system is in OAuth mode, batch processing is unavailable. Notify JT:
> "Batch mode requires API key mode. Currently running OAuth. Switch to ANTHROPIC_API_KEY in .env to enable."
