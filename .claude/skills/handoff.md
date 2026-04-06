---
name: handoff
description: Format private vault content for manual transfer to Claude — JT reviews before sharing
type: operational
---

When JT types `/handoff [question]`:

**Purpose:** Troi has no internet access and cannot call Claude directly. `/handoff` lets JT use Claude on private content by formatting the minimal relevant context for JT to review and manually paste into a Daystrom or claude.ai session. JT is the security review step — no automated pipeline ever moves private data to cloud AI.

**Steps:**
1. JT says: `/handoff` + the specific question or task
2. Extract the **minimal relevant context** from the private vault needed to answer the question
3. Format it as a structured message with clear source attribution
4. Present it for JT to review before sharing
5. JT pastes the formatted context into a Daystrom or claude.ai session themselves
6. JT may manually relay the response back to Troi if desired

**Output format:**
```
Here's the relevant context for: [question]. Review before sharing with Claude.

[Formatted excerpt — only what's needed to answer the question]

Source: [file path(s) read, e.g. `private/logs/health.md` (last 10 entries)]
```

**Rules:**
- Extract only what's needed — not bulk vault content
- Always note which private files were read
- Never send data anywhere — output is for JT's eyes first
