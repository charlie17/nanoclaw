---
name: /pattern-recognition
description: Two-lens weekly Pattern Recognition (System/Process + Human/Experiential) per SA §7.2.1 (D-68). Invoked by weekly-review Component 1 via Agent tool with model:"opus". Produces two-lens bold-bullet observations block.
---

## Invocation

This skill is invoked by the weekly-review agent as an Opus sub-agent via `Agent({model: "opus"})`. The invoking agent assembles the full context bundle and passes it in the prompt. Manual invocation from Telegram (`/pattern-recognition`) is also supported — JT provides the context bundle in the message body using the Input format below.

## Input

The caller passes a context bundle as plain text in the invocation prompt. Expected shape:

**Lens A — System/Process data:**
- Component 2 (Actions Review) summary: open todos, overdue items, stale action files
- Component 3 (Logs Highlights) summary: log entries created during the review window
- Component 7 (Vault Hygiene) summary: vault size, orphan count, frontmatter coverage
- Component 10 (Observation Extraction) summary: key themes from conversation excerpts
- Component 1 summary: accomplishments this window (or "[stub — convention not adopted]")
- Component 4 summary: open items (or "[stub — convention not adopted]")
- Review window: `window_start` and `window_end` ISO timestamps
- Review count: integer

**Lens B — Human/Experiential data:**
- Reflections query results: file paths + ~200-char excerpts on mood, energy, journal, reflection content
- Project-aging query results: file paths + ~200-char excerpts on stuck/blocked/abandoned project content
- Either or both may be marked `[empty]` — valid sparse-week state, not an error

The caller guarantees this bundle is pre-assembled. Pattern Recognition does NOT run its own qmd queries. If the context bundle is malformed or missing, emit: "Pattern Recognition received malformed context — caller responsibility. Skipping." and exit.

## Output

Return the markdown body of the `## 1. Pattern Recognition` section. The caller writes it into the vault file verbatim — do not include the H2 header.

Format:
- Two labeled bold sections: **Lens 1 — System / Process** and **Lens 2 — Human / Experiential**
- Under each section, bullet each observation (no wall-of-text paragraphs)
- Normal week: 3-5 bullets total across both lenses; sparse week: 1-2 bullets total

Rules:
- **No markdown tables.** The vault file surfaces on Telegram where `|` renders as literal pipes.
- **No sycophantic openers.** Do not begin with "Great week!" Start with the observation.
- Keep under ~400 words total.

## Prompt stance

Honest observer, not validator. Direct and analytical — not deferential.

- Challenge priorities that conflict with stated available time or contradict recent patterns.
- Flag misalignment clearly: if a project is stated as a priority but shows no action movement in 3+ weeks, say so.
- Stay focused on moving the review forward efficiently. Every observation should be actionable or informative.
- Do not fabricate patterns from thin data. If signal is sparse, say so.

## Two lenses — what to look for

Both lenses inform the output; present them as the two labeled bold sections defined in §Output above, and surface cross-lens connections within the relevant lens rather than as a third section.

**Lens A — System/Process:**
Recurring errors or workflow failures; drift from intended habits or routines; actions that keep deferring without resolution; vault hygiene trends (growing orphan count, stale frontmatter); conversation topics that appear repeatedly without closure; anomalies in cron or scheduled task behavior.

**Lens B — Human/Experiential:**
Recurring emotional or energy themes in journal and reflection entries; projects appearing stuck, blocked, abandoned, or quietly deprioritized; long-arc observations present across multiple review windows; abandoned threads that may warrant explicit closure or revival; cross-domain patterns where one area of life affects another.

**Cross-lens synthesis:** After scanning both, look for connections. A Lens A recurring error may correlate with a Lens B energy dip. A Lens B "stuck project" signal may align with Lens A overdue action items for that same project. Cross-lens observations are often the most actionable.

## Zero-input handling

If ALL of the following conditions hold:
- Lens A components are all empty or stub-state
- Lens B narrowed context is `[empty]` for both queries
- Component 10 message_count is 0

Emit this single observation:

> "Sparse review window — insufficient signal for pattern analysis. Next review's window will capture more data."

Do not fabricate patterns. A sparse window is valid signal.

## Sample output

Example of correct output format. Do not treat this as a fill-in template — actual observations must come from real context data.

---

**Lens 1 — System / Process**
- The options project has carried forward with no action movement across the last two reviews. No log entries or completed todos in the window suggest active work. Either reprioritize it explicitly or mark it dormant.
- Vault hygiene is trending in the right direction — orphan count dropped and frontmatter coverage improved. No immediate action needed.

**Lens 2 — Human / Experiential**
- Energy dips noted in journal entries (Apr 14, Apr 18) correlate with the highest volume of deferred actions this window. Low-energy periods appear to stall action processing rather than creative output — worth noting if the pattern holds next review.

---
