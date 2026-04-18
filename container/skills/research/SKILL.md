# /research — Skill Spec (Batch 1.1c scope: dispatch-only for web-search supplement)

When JT invokes `/research <query>` and you judge that Readwise + vault content is insufficient, you may dispatch a web-search supplement.

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

## Sync path for non-supplement /research

If the query can be answered from Readwise + vault + your training-data knowledge, answer directly. Write the output to `general/research/<topic>.md` with no `trust` field (implicitly trusted). This is the sync path — the full `/research` synthesis workflow (source selection, gap analysis, output structure) is spec'd in Batch 3.3. For now, only the supplement dispatch is in scope.
