The user wants to import a raw chat transcript into the vault.

## Step 1 — Get the transcript

If the transcript was not pasted in this message, ask:
> "Paste the transcript here."

Wait for the full text before proceeding.

## Step 2 — Detect platform and date

Identify the source platform from formatting cues:
- **claude.ai:** Speaker labels like "Human" / "Assistant" or "You" / "Claude"
- **ChatGPT:** Speaker labels like "You" / "ChatGPT" or "User" / "Assistant"
- **Perplexity:** Speaker labels like "You" / "Perplexity" or search-style Q&A blocks

Extract the date from transcript content if visible. If not found, use today's date.

## Step 3 — Clean and format

Transform the raw transcript into a readable vault note:
- Normalize speaker labels to `**JT:**` and `**{Platform}:**`
- Restore code blocks (detect indented or fenced code; wrap in triple backticks with language hint if identifiable)
- Strip UI artifacts: timestamps in sidebars, "Copy" buttons, token counts, "Regenerate response" labels
- Preserve the full conversation — do not summarize or cut content
- Keep paragraph breaks; collapse excessive blank lines to one

## Step 4 — Generate a topic slug

Write a 2-4 word kebab-case topic slug from the conversation subject.
Example: `options-strategy`, `kitchen-reno-budget`, `daystrom-arch-review`

## Step 5 — Write the vault note

**Path:** `general/research/chat-{YYYY-MM-DD}-{topic-slug}.md`

**Frontmatter:**
```
---
date: {YYYY-MM-DD}
platform: {claude.ai | chatgpt | perplexity | other}
topic: {short human-readable topic title}
type: imported-chat
---
```

Write the cleaned transcript below the frontmatter. No extra commentary — just the formatted conversation.

## Step 6 — Confirm

Reply with:
- File path written
- Obsidian link: `obsidian://open?vault=ObsidianDaystromVault&file=general/research/chat-{YYYY-MM-DD}-{topic-slug}`
- One-line topic summary

If the user specified a project subfolder (e.g., "save this under the daystrom project"), write to `general/projects/{name}/notes/chat-{YYYY-MM-DD}-{topic-slug}.md` instead.
