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
- **JT's material is canonical wherever it appears.** His edits — including edits to source-content sections — are preserved verbatim. A node he deleted is marked pruned and never recreated. Anything flag-like or stance-like that fails to parse is surfaced in the run report, never silently dropped.
- **Stance is never inferred.** A bare highlight is an attention flag with empty stance. Only JT's shorthand sets ✅ Agree · ❌ Dispute · 💡 Surface.
- **Provenance stays legible forever.** Source content and JT overlay never mix: overlay lands in a fenced `— JT —` section at the bottom of a card; stance recolors the node; source cards stay neutral. The legend card documents every convention.
- **One writer at a time.** Check canvas freshness (hash vs. manifest record) before writing; on drift, re-parse — never clobber. All writes atomic (temp + rename): the vault is under Obsidian Sync.

## Build doctrine — comprehensiveness is the point

The map is comprehensive only when every substantive part of the source has a clear place in the tree. The machinery below exists to prevent the one failure that matters: collapsing a book into theme statements.

**Read everything before reducing anything.** Process the entire source. Never infer coverage from the table of contents, headings, an existing summary, or opening/closing passages. If content is inaccessible or unparsed, resolve that first — and never claim comprehensive coverage from partial access.

**Track every substantive move:** central and supporting claims; definitions and terminology shifts; premises and intermediate reasoning; evidence, examples, cases, analogies, counterexamples; comparisons and their dimensions; mechanisms, causal sequences, dependencies; qualifications, uncertainty, exceptions, scope conditions; objections, replies, tensions, argumentative turns; transitions and conclusions that change direction or significance; tables, figures, and lists doing explanatory or evidential work.

**Coverage ledger (persisted, not mental).** Every substantive section and argumentative move maps to a planned card in the ledger before any card is written. Repetition may be consolidated, but each distinct claim or supporting move must have an explicit place. The ledger is the resume point after interruption and the reconciliation instrument at the end.

**Consolidate across chapters before designing the tree.** Per-chapter extraction alone reproduces the outline mechanically. A whole-ledger pass merges claims the author develops in multiple places (with merge provenance), dedupes repetition, and links objection/response arcs that span chapters.

**Design the tree semantically.** Parent-child relationships express decomposition, support, dependency, qualification, objection-and-response, causal development, or branching consequence — not the source's outline where that outline obscures how claims relate. Keep siblings parallel in abstraction and wording. Preserve source order within branches when progression matters. One node = one coherent claim or one necessary argumentative move; split when the author develops claims independently; combine only when passages genuinely develop the same move. Never create a node merely because a page, paragraph, or heading changes.

**No compression targets.** No fixed card count, no ratio, no per-chapter quota. Later and less prominent sections get the same fidelity as earlier ones.

**Reconcile before reporting done.** Every ledger entry maps to a card, AND every card clears the depth bar — a body that collapses its assigned passages into a generic theme statement fails reconciliation even though it exists. Report any access, parsing, or coverage limitation honestly.

## Card format

- **Title:** concise, claim-based — states what the author asserts, readable at map zoom. Portrait card shape.
- **Body sections, as applicable** (adapt to the source; delete empty headings, never stub them): **Claim** (faithful, direct language) · **Meaning** (what it means in context, which problem it addresses) · **Reasoning** (premises, mechanism, intermediate steps) · **Support** (evidence, examples, definitions, comparisons, cases) · **Qualifications** (uncertainty, limits, exceptions, objections and replies, scope) · **Relationship** (how it supports, depends on, qualifies, or contrasts with its parent and key neighbors).
- **Cite line:** locator (chapter/section) + short verbatim anchor phrase; becomes a live `↳ cite` link when armed.
- Preserve the author's modality and certainty level. Restate faithfully — quotation only where exact phrasing is conceptually load-bearing; explanation is never replaced by quotation. No critique and no organizer opinion unless JT asks; if asked, label it and keep it separate.
- **Root card:** the source's central question, thesis, structure of reasoning, conclusion, and the map's scope. **Legend card** beside it: flag emoji, stance emoji, color meanings, how to triage.

## Canvas conventions

Single canvas per source — the full universe of the book in one view. Portrait text nodes only; left-to-right tree with generous breathing room. Structure reads without opening a single card:

- **Overview group (far left, the entry point):** the root card plus a handful of book-level summary cards — the whole thesis at a glance before any chapter detail. Legend card below it; unmatched bin below that.
- **Chapter/part groups** left-to-right after the overview, each holding its claim tree.
- **Connectors:** every parent→child relationship is a drawn edge (arrowed, left-to-right). Support/decomposition edges are unlabeled — that's the default relationship and labels would be noise at 200+ edges. Non-default relationships carry the relationship word as the edge label: `objection`, `reply`, `qualifies`, `contrasts`, `example`, `consequence`. Argumentative turns are visible on the map itself.
- **Color doctrine — color belongs to JT, not the author.** Source cards are neutral; author-side structure is expressed through position, groups, and edges only. Color appears exactly where JT's overlay lands: stance recolors a card (✅ green · ❌ red · 💡 purple), the machine furniture (root/legend cyan, bin orange) is fixed, and edges are never colored. One glance separates "the book" from "what JT thinks of it."

Node ids are deterministic (derived from claim ids). Layout, sizing, validation, and all mechanical rules live in `scripts/` — never hand-place nodes or hand-write canvas JSON.

## Execution — who runs what

- **Build** runs on the Claude Code surface: the lead session orchestrates, fanning per-chapter claim extraction out to Opus subagents (card prose is user-facing — high-taste models only), then performs consolidation, tree design, and reconciliation itself before the scripts project the canvas. Not a Daystrom-container job: a book-scale build exceeds the container's context economics by design.
- **Arm and refresh** are light mechanical sweeps: any surface, container Sonnet included. Follow this SKILL.md and call the scripts; no model escalation needed.

## Mechanics

Scripts in `scripts/` (python3 stdlib only, both surfaces): fetch/slice the source, build/parse/validate the canvas, arm, refresh. Run them; don't reimplement their logic in-session. Vault home: `reference/learning/<slug>.canvas` + `<slug>-manifest.json` (container: `/workspace/extra/vault/reference/learning/`; Claude Code: `Documents\ObsidianDaystromVault\general\reference\learning\`). Highlight anchoring uses whole `<p>` blocks byte-for-byte from the cached source HTML; the manifest stores block offsets, so never re-slice by hand. All machine highlights carry the `daystrom-claim` tag — that tag is the cleanup path.

## Reporting

Close-outs follow Reply Discipline (executive tone): what the map covers, where it lives (Obsidian deep-link), coverage/limitation statements, and — on refresh — what changed: cards gaining stance, unmatched highlights, anything that needs JT's eye. Never describe the map as a substitute for the book.
