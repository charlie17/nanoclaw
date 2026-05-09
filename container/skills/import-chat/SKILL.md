# /import-chat — Chat-transcript ingestion to vault

When JT says `/import-chat` or pastes a raw transcript for vault import. Announce model: "Running `/import-chat` with Sonnet."

## Trigger phrases

`/import-chat`, "import this chat", "save this transcript to the vault", or any user message that begins with a multi-line speaker-labeled exchange that JT clearly wants archived. When JT pastes a transcript without an explicit `/import-chat`, confirm intent before proceeding.

## Procedure

1. **If no transcript is in the message**, ask: *"Paste the transcript."* Do not proceed until you have content.

2. **Detect platform** from speaker label patterns:
   - `Human` / `Assistant` or `You` / `Claude` → `claude.ai`
   - `You` / `ChatGPT` or `User` / `Assistant` (OpenAI style) → `chatgpt`
   - Search-style Q&A with Perplexity attribution → `perplexity`
   - Anything else → `other`

3. **Clean and format** the transcript:
   - Normalize speaker labels to `**JT:**` and `**{Platform}:**` (e.g., `**Claude:**`, `**ChatGPT:**`).
   - Restore code blocks: wrap detected code in triple backticks with a language hint when the language is identifiable from context.
   - Strip UI artifacts: copy buttons, token counts, timestamps in margins, regeneration labels, "Was this helpful?" prompts, etc.
   - Preserve full conversation. NO summarizing, NO cutting, NO paraphrasing — the value of an imported chat is the verbatim record.

4. **Generate a topic slug** — 2–4 words, kebab-case, descriptive of the conversation subject. Examples:
   - Chat about backtesting an options strategy → `options-backtesting`
   - Chat debugging a Vue 3 reactivity issue → `vue3-reactivity-debug`
   - Open-ended brainstorm on AI tutoring → `ai-tutoring-brainstorm`

5. **Write to the vault.**
   - **Default location:** `research/chat-{YYYY-MM-DD}-{topic-slug}.md`
   - **If JT specified a project** (e.g., "import this for the options project"): `projects/{name}/notes/chat-{YYYY-MM-DD}-{topic-slug}.md`
   - Frontmatter (per CLAUDE.md §Frontmatter Schemas):
     ```yaml
     ---
     type: imported-chat
     platform: claude.ai           # or chatgpt / perplexity / other
     topic: "Options strategy brainstorm"
     date: 2026-03-22
     ---
     ```
   - Body: cleaned + normalized transcript, full and verbatim.

6. **Confirm to JT** with the file path, an Obsidian deep-link (per CLAUDE.md §Obsidian URIs), and a one-line topic summary.

## What you MUST NOT do

- Do NOT summarize, cut, or paraphrase the transcript content. Preserve it whole.
- Do NOT invent a topic slug from JT's project list when JT didn't specify one — default to `research/` location instead.
- Do NOT modify CLAUDE.md, this SKILL.md, or any agent-controlled file as a side effect of an import.
- Do NOT skip the platform-detection step — `platform` in frontmatter is grep-able and downstream skills (`/research`, etc.) may filter by it.

## Rationale

Imported chats are a primary input for vault-scoped reasoning — synthesis runs querying the vault should find them. The verbatim-preservation rule keeps the source-of-truth intact; cleaning + normalization makes the content readable in Obsidian without losing fidelity. The slug + date filename convention parallels research reports and brainstorms (`research-{date}-{topic}.md`, `brainstorm-{date}-{topic}.md`), keeping `research/` browsable as a single namespace.
