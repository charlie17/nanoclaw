---
name: reading
description: Use when JT asks to build a claim map / pre-read map of a source in Readwise Reader ("map this book", "build the reading map"), to arm a triaged map with cite links, or to refresh a map with his reading highlights ("refresh the map"). Covers the full pre-read → triage → arm → read → refresh loop.
---

# Reading — Comprehensive Claim Map

Transform a complete source in Readwise Reader (book-scale EPUB, PDF, or article) into a comprehensive claim-card mind map on a single Obsidian canvas, **before JT reads it** — so he walks into the source already holding its skeleton. Then fold his reading back onto the map. The artifact helps JT reconstruct the source's full argument, not merely remember selected takeaways. It is never a replacement for reading the original.

## The loop

1. **Build** (heavy, Claude Code surface) — source → claim map: canvas + manifest. No highlights created.
2. **Triage** (JT, Obsidian) — flags prepended to card titles: ⭐ key · 🔥 dig in · ⏭️ skip · ❓ clarify.
3. **Arm** (either surface) — every ⭐/🔥/❓ card gets one tagged (`daystrom-claim`) anchor highlight; its URL becomes the card's live `↳ cite` link. Never re-arm a card that has a highlight id.
4. **Read** (JT, Reader) — normal reading and highlighting. Stance shorthand goes in the highlight note: ✅/❌/💡 or `agree`/`dispute`/`surface` prefix.
5. **Refresh** (either surface) — sweep JT's highlights, match them to cards, fold stance + notes onto the map. Repeatable any number of times.

## Ground rules

- **The manifest is the backbone; the canvas is its projection.** Never regenerate the canvas. Every arm/refresh first parses the canvas back into the manifest (flags, moves, edits, deletions), then projects forward, touching known node ids only.
- **JT's material is canonical wherever it appears.** His edits — including edits to source-content sections, text added below the cite line, and rewrites of the `— JT —` block (which freeze that section's machine rendering until he clears them) — are preserved verbatim. A node he deleted is marked pruned and never recreated. Anything flag-like or stance-like that fails to parse is surfaced in the run report, never silently dropped.
- **Stance is never inferred.** A bare highlight is an attention flag with empty stance. Only JT's shorthand sets ✅ Agree · ❌ Dispute · 💡 Surface.
- **Provenance stays legible forever.** Source content and JT overlay never mix: overlay lands in a fenced `— JT —` section at the bottom of a card; stance recolors the node; source cards stay neutral. The legend card documents every convention.
- **One writer at a time.** Check canvas freshness (hash vs. manifest record) before writing; on drift, re-parse — never clobber. All writes atomic (temp + rename): the vault is under Obsidian Sync.
- **Runs refuse rather than guess.** Arm and refresh abort with a report warning — no writes, no highlight creates — when: the doc id doesn't match the manifest; the cached source no longer matches the manifest's `html_sha256` (source drift → re-slice and rebuild); the canvas is structurally invalid (never read a broken file as "JT deleted everything"); or a newer Sync conflict copy sits beside the canvas. Arm also creates nothing for a card whose anchor phrase can't be verified in its block, and ⏭️ beats every other flag in a mixed run.

## Build doctrine — comprehensiveness is the point

The map is comprehensive only when every substantive part of the source has a clear place in the tree. The machinery below exists to prevent the one failure that matters: collapsing a book into theme statements.

**Read everything before reducing anything.** Process the entire source. Never infer coverage from the table of contents, headings, an existing summary, or opening/closing passages. If content is inaccessible or unparsed, resolve that first — and never claim comprehensive coverage from partial access.

**Track every substantive move:** central and supporting claims; definitions and terminology shifts; premises and intermediate reasoning; evidence, examples, cases, analogies, counterexamples; comparisons and their dimensions; mechanisms, causal sequences, dependencies; qualifications, uncertainty, exceptions, scope conditions; objections, replies, tensions, argumentative turns; transitions and conclusions that change direction or significance; tables, figures, and lists doing explanatory or evidential work.

**Coverage ledger (persisted, not mental).** Every substantive section and argumentative move maps to a planned card in the ledger before any card is written. Repetition may be consolidated, but each distinct claim or supporting move must have an explicit place. The ledger is the resume point after interruption and the reconciliation instrument at the end.

**Consolidate across chapters before designing the tree.** Per-chapter extraction alone reproduces the outline mechanically. A whole-ledger pass merges claims the author develops in multiple places (with merge provenance), dedupes repetition, and links objection/response arcs that span chapters.

**Design the tree semantically.** Parent-child relationships express decomposition, support, dependency, qualification, objection-and-response, causal development, or branching consequence — not the source's outline where that outline obscures how claims relate. Keep siblings parallel in abstraction and wording. Preserve source order within branches when progression matters. One node = one coherent claim or one necessary argumentative move; split when the author develops claims independently; combine only when passages genuinely develop the same move. Never create a node merely because a page, paragraph, or heading changes.

**Altitude (ratified by the pilot).** The map's unit is the developed idea, not the argumentative move. Target ≈ 1 card per 350–500 source words (a 120K-word book lands at 250–350 cards); tree depth ≤ 2 below each chapter hub. Build in two passes: extract per-move first (fine-grained, block-cited — this is the coverage instrument), then merge and distill move-clusters into idea-cards. Every merged move's full text is archived on its surviving card (`body_full` in the manifest) — display gets lighter, the record never does. Later and less prominent sections get the same fidelity as earlier ones.

**Reconcile before reporting done.** Every ledger entry maps to a card, AND every card clears the depth bar — a body that collapses its assigned passages into a generic theme statement fails reconciliation even though it exists. Report any access, parsing, or coverage limitation honestly.

## Card format — distilled essence (ratified by the pilot)

- **Title:** the claim as a direct assertion, ≤ 80 chars, never starting with a flag glyph. The title carries the claim; the body must start where the title leaves off — **never restate it**.
- **Body:** 150–550 chars, 2–4 SHORT paragraphs of 1–2 sentences each, blank line between every paragraph. Telegraphic register ("First move: get a good accountant."). Weave mechanism + strongest support; secondary examples and restatements drop from display (they live in the archive). Load-bearing numbers ALWAYS survive.
- **No attributions or qualifiers.** No "the author argues", no named studies/institutions/products — findings state themselves ("Study: …", "Survey data shows…"). Surviving-name exceptions, exactly these classes: named-party disagreements where the dispute is the card; authorial belief/judgment markers where modality is content ("belief doesn't make it so"); client-case names; domain vocabulary; resource-locators when the card's point is "go here". The book itself carries the full detail — that is what it's for.
- **Cite line, italic:** `*↳ cite: locator — "anchor phrase"*`; becomes a live link when armed.
- Preserve the author's modality and certainty. No critique or organizer opinion unless JT asks; if included, label it and keep it separate.
- **Root card** (labels allowed here only): central question, thesis, structure, scope. **Chapter hub cards:** chapter title + 2–3 sentence gloss (same no-attribution rules). **Legend card:** flags, stance, colors, edit-safety notes.

## Canvas conventions (ratified by the pilot)

Single canvas per source — a horizontal FILMSTRIP consumed by one left-to-right pan: chapters flow in book order as hub-centered rosettes, per-chapter content height capped (~3,400px, plus a soft one-card tolerance spent only to keep a subtree intact). Cards are wide-portrait (480×620 nominal, ~8.5×11 aspect), sized so every card reads fully while panning — no internal scrolling, enforced by the overflow validator.

- **Upper-left corner, the entry point:** the teal **"Heatmap Sections"** group — one title-only card per chapter (mirrors the hub set exactly, column-wrapped landscape block). Built for JT's heat-mapping: colors he applies persist across rebuilds. Below it: the Legend, then the root card with the book-level overview cards, then the unmatched bin.
- **Chapter hubs** (teal; title + gloss) center each chapter; branches radiate left and right, **subtree-contiguous**: each section card sits beside its own children, subtrees are unbroken blocks, no interleaving — proximity outranks density (width is the accepted cost). No root→hub spokes; shelf order carries the sequence.
- **Connectors:** parent→child edges only; support edges unlabeled; non-default relationships carry the word on the edge (`objection`, `reply`, `qualifies`, `contrasts`, `example`, `consequence`).
- **Color doctrine:** teal = machine furniture (root, legend, hubs, TOC group). Stance recolors claim cards (✅ green · ❌ red · 💡 purple); bin orange; **yellow is RESERVED for JT's own highlighting — never emitted by the builder** (test-pinned). Source cards stay uncolored; edges never colored.

Node ids are deterministic (derived from claim ids). Layout, sizing, validation, and all mechanical rules live in `scripts/` — never hand-place nodes or hand-write canvas JSON. `BAND_FILL_COMPACT` in `canvas_build.py` toggles the density packer (False reproduces the pure block layout).

## Execution — who runs what

- **Build** runs on the Claude Code surface: the lead session orchestrates, fanning per-chapter claim extraction out to Opus subagents (card prose is user-facing — high-taste models only), then performs consolidation, tree design, and reconciliation itself before the scripts project the canvas. Not a Daystrom-container job: a book-scale build exceeds the container's context economics by design.
- **Arm and refresh** are light mechanical sweeps: any surface, container Sonnet included. Follow this SKILL.md and call the scripts; no model escalation needed.

## Mechanics

Scripts in `scripts/` (python3 stdlib only, both surfaces): fetch/slice the source, build/parse/validate the canvas, arm, refresh. Run them; don't reimplement their logic in-session. Vault home: `reference/learning/<slug>.canvas` + `<slug>-manifest.json` (container: `/workspace/extra/vault/reference/learning/`; Claude Code: `Documents\ObsidianDaystromVault\general\reference\learning\`). Highlight anchoring uses whole `<p>` blocks byte-for-byte from the cached source HTML; the manifest stores block offsets, so never re-slice by hand. All machine highlights carry the `daystrom-claim` tag — that tag is the cleanup path.

## Reporting

Close-outs follow Reply Discipline (executive tone): what the map covers, where it lives (Obsidian deep-link), coverage/limitation statements, and — on refresh — what changed: cards gaining stance, unmatched highlights, anything that needs JT's eye. Never describe the map as a substitute for the book.
