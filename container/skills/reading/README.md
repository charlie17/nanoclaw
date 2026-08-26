# Reading Maps — how this works

A reading map turns a book in Readwise Reader into a one-canvas visual of its entire argument, built **before** you read. You walk in holding the skeleton; your reading then folds back onto the map.

## The loop, from your side

1. **Ask for a map.** "Build a reading map for `<book>`" — the book must be in Reader (EPUB is the happy path; PDF works). The heavy build runs on Claude Code; expect a fan-out of agents and a validated canvas landing at `reference/learning/<slug>.canvas` in the general vault (with `<slug>-manifest.json` beside it — surface-specific absolute paths are in SKILL.md §Mechanics).

2. **Triage on the canvas.** Skim and prepend flags to card titles: ⭐ key · 🔥 dig in · ⏭️ skip · ❓ clarify. Move cards, edit any text, delete cards, recolor the Heatmap Sections tiles — every edit of yours is permanent. A deleted claim card is never recreated; your wording always wins. (The teal furniture — root, legend, hubs, section tiles — is machine-owned and comes back on the next pass.)

3. **Arm.** Say "arm the map." Every ⭐/🔥/❓ card gets one tagged (`daystrom-claim`) highlight in Reader; its URL becomes the card's live *↳ cite* link — one tap from card to passage. ⏭️ and unflagged cards create nothing, so your reading surface stays clean.

4. **Read in Reader, normally.** Highlight as you go. To attach a stance, start the highlight's note with shorthand: ✅ / ❌ / 💡 (or `agree` / `dispute` / `surface`). A bare highlight is just an attention flag — stance is never inferred.

5. **Refresh.** Say "refresh the map" (works from Telegram or Claude Code). Your new highlights are matched to cards: matched ones appear under the card's `— JT —` rule with their own live links; stance recolors the card (green/red/purple); anything unmatchable lands visibly in the orange **Unmatched highlights** card, never dropped. Repeat as often as you like — refresh is idempotent.

## Reading the map

- **Upper-left:** the teal **Heatmap Sections** box (one tile per chapter — color these however you like; colors persist), then the **Legend**, then the **root card** (the book's thesis) with the overview cards.
- **Chapters** flow left-to-right in book order. Each teal **hub** = chapter title + gloss; sections and their supporting cards radiate beside it — a section always sits next to its own children.
- **Cards:** title = the claim; body = its distilled mechanism and strongest support, short paragraphs, no filler. The *↳ cite* line points at the exact source passage. Unlabeled arrow = supports; a worded arrow marks a turn (objection, reply, qualifies, contrasts, example, consequence).
- **Color:** teal = machine furniture · green/red/purple = your stance · orange = unmatched bin · **yellow is yours** — the builder never uses it, so it's a safe highlighter.

## Guarantees

- **Comprehensive:** every substantive block of the source is covered by some card's range (machine-checked at build); figures/tables/images that can't be read are named as gaps, never invented.
- **Nothing is lost to distillation:** each card archives the full detailed text of everything merged into it (in the manifest) — future syntheses (e.g. wiki work) read from there.
- **Your edits survive everything:** rebuilds and refreshes parse the canvas first and only then project — flags, moves, resizes, rewrites, deletions, tile colors all persist.
- **No scrolling:** every card is sized to show its full text while panning (validator-enforced).

## Under the hood (pointers, not reading assignments)

`SKILL.md` carries the doctrine; `scripts/` carries the mechanics (fetch/slice → extract → distill → assemble → project → arm → refresh), all stdlib Python, with a ~740-test unittest suite (count as of the 2026-08 review close). The manifest is the source of truth; the canvas is its projection. The map is a pre-read instrument — not a substitute for the book.
