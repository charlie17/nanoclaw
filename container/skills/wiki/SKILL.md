# /wiki-ingest — Karpathy-method ingest with full ripple

When JT invokes `/wiki-ingest`, process one source from Readwise (or naturally-pointed-at vault content) into the wiki. **One source per invocation.** Announce model: "Running `/wiki-ingest` with Opus."

## Architecture (three layers, per Karpathy)

The wiki has three layers under `wiki/` (host: `~/vault/general/wiki/`):

1. **`wiki/raw/<doc-id>.md`** — Immutable source archive. Read-only after write. Karpathy line 52: *"This is your source of truth."*
2. **`wiki/sources/<source-slug>.md`** — Per-source summary pages. One per ingested source. **Filename is a human-readable kebab-case slug derived from the article title** (NOT the Readwise doc ID — that lives in frontmatter). Frontmatter carries `source-id` (doc ID), `provenance`, source attribution. See §"Source-summary slug rules" below.
3. **`wiki/<topic-slug>.md`** — Concept/entity pages built across multiple sources. The Karpathy compounding layer. Topic-themed slug (e.g., `retirement-tax-efficiency.md`). Cite each source via Obsidian footnotes (see §"Citation pattern — footnotes" below).

Plus five meta files:
- **`wiki/!home.md`** — Human narrative entry point. Updated when the picture shifts.
- **`wiki/!index.md`** — Agent catalog. Updated every ingest.
- **`wiki/!log.md`** — Chronological op log. Append-only bullet format.
- **`wiki/!style.md`** — Canonical page-style guide. **Read this before drafting or modifying any wiki page** (see §"Style canon" below).
- **`wiki/_processed.json`** — Processed Readwise doc ID ledger.

## Style canon — `wiki/!style.md`

`wiki/!style.md` is the canonical reference for page style. **Read it once at the start of every `/wiki-ingest` run, before drafting any source-summary or concept page.** Apply its seven load-bearing rules to everything you write or modify:

1. Italic teaser under H1 (concept pages, landing-page voice — `!style.md` §1 + §7).
2. Pattern B top-of-page on concept pages — italic teaser + `[!info]` cluster hub + `[!tldr]-` synthesis (§1).
3. Heading spacing — no blank line between `#`/`##`/`###` and body, with two carve-outs (§2).
4. Frontmatter → H1 — no blank line between closing `---` and `# H1` (§2, §8).
5. One emoji level per page — pick the level with the most navigational value (§4).
6. Direct quotes — prose lead-in + plain `>` blockquote, never `[!quote]` (§5).
7. Footnote anchors never inside `[!type]` callout blocks (§6 + §"Citation pattern" below).

If a styling question is not covered by `!style.md`, follow the most recent redraft exemplar (May 2026 Stage-3 pages: `alzheimers-prevention-treatment.md`, `retirement-tax-efficiency.md`, `healthy-longevity.md`).

## Readwise path (default)

Per the SKILL.md the agent follows step-by-step:

### Step 1 — Pick the next source + announce

1. Read `wiki/_processed.json` (collect already-processed doc IDs).
2. Call `mcp__readwise__reader_list_documents({tag: ["daystrom-wiki"]})` to list all tagged items across inbox/later/archive (location-agnostic per JT directive 2026-04-29).
3. Select the next item NOT in the ledger. If JT pointed at a specific item naturally (e.g. "ingest the Make It Stick article"), use that.
4. Capture `id` + `location` for the deep-link.
5. Announce to JT: *"Reading [Title](https://read.readwise.io/{location}/read/{id})..."*

### Step 2 — Fetch + archive raw

1. Call `mcp__readwise__reader_get_document_details({document_id: "<id>"})` for body content.
2. Call `mcp__readwise__reader_get_document_highlights({document_id: "<id>"})` for highlights.
3. **Write raw archive** to `wiki/raw/<doc-id>.md` with this shape:

```yaml
---
type: raw-source
doc-id: <readwise-doc-id>
title: <title>
author: <author>
url: <reader URL>
saved-date: <YYYY-MM-DD>
fetched-at: <YYYY-MM-DD HH:MM ET>
truncated: false   # true if size cap hit
---

# <Title>

<full body content>
```

**Size cap: 200KB.** If the raw body exceeds 200KB, write the metadata block + first ~1000 words + a truncation marker:
```
[truncated — full source at <reader URL>; this archive contains first 1000 words for grep / re-ingest scaffolding]
```
Set `truncated: true` in frontmatter. Karpathy mandates raw storage as source-of-truth (line 52); the cap keeps disk usage bounded for occasional 50-page PDFs.

### Step 3 — Surface related vault content (provenance distinction)

1. Run `mcp__qmd__query` over the full `general` namespace to find vault content semantically related to this source.
2. **Distinguish provenance clearly when discussing with JT** — surface vault hits as *"From your existing vault: [[path]]"* and source content as *"From this Readwise source: <quote>"*. The agent reasons across both but is transparent about origin.

### Step 4 — Discuss with JT

1. **Ask emphasis question** (every ingest, fresh — never persist across sessions): *"Should I build the page primarily from your highlights and notes, or treat the full body as primary with highlights/notes as color?"*
2. Discuss key takeaways. Surface what's new, what connects, what contradicts prior understanding.
3. **Provenance distinction in this discussion is mandatory** — JT must be able to tell what came from the raw Readwise source vs existing vault content.
4. Wait for JT to confirm scope before writing.

### Step 5 — Write source-summary page

#### Source-summary slug rules

Filename for the source-summary page is a kebab-case slug derived from the article title — readable in the file tree + readable as a wikilink target. Doc ID lives in frontmatter, NOT in the filename.

1. **Generate slug from title** — kebab-case, lowercase, ASCII-only. Drop punctuation other than hyphens. Soft cap ~50 chars; preserve meaningful tokens; truncate trailing fluff if needed. Examples:
   - `"The 0% Tax Bracket Most Retirees Walk Right Past"` → `the-0-percent-tax-bracket-most-retirees-walk-right-past`
   - `"Make It Stick: The Science of Successful Learning"` → `make-it-stick-science-of-successful-learning`
2. **Collision detection BEFORE writing** — the doc ID, NOT the filename, is the dedup key:
   - If `_processed.json` already contains this `doc-id`, the source has been ingested. Read the existing `slug` field from `_processed.json` and use it (do NOT re-slug the title — slugs snapshot at first ingest, even if Readwise retitles the article).
   - If `_processed.json` does NOT contain this doc ID, but the filesystem has `sources/<slug>.md` already (rare, e.g. two different articles with the same title), append `-2`, `-3` to the slug to disambiguate. Record the chosen slug in `_processed.json`.
3. **Slug snapshot is permanent.** Once recorded in `_processed.json`, never regenerate.

Create `wiki/sources/<source-slug>.md`. **Tight spacing per `!style.md` §2** — no blank line between frontmatter `---` and `# H1`, no blank line between any heading and its body. Same discipline as concept pages.

```yaml
---
created: <YYYY-MM-DD HH:MM ET>
updated: <YYYY-MM-DD HH:MM ET>
type: source-summary
title: <title>
author: <author>
source-url: <reader URL>
saved-date: <YYYY-MM-DD>
provenance:
  source: readwise
  by: daystrom
  via: /wiki-ingest
source-id: <readwise-doc-id>
raw-archive: "[[raw/<doc-id>]]"
related-pages:
  - "[[<topic-slug>]]"   # concept pages this source feeds
---
# <Title> (source summary)
<TL;DR — 1-2 sentences capturing the source's core argument or contribution>
## Key takeaways
<3-7 bullets summarizing what this source delivers, opinionated voice, blog-post style>
## Notable claims
<Claims worth citing into concept pages, each as a sentence or short paragraph>
## Related vault material
<Vault content that surfaced via qmd, with provenance attribution>
```

## Citation pattern — footnotes

**Concept pages cite sources via Obsidian footnotes, NOT via repeated inline `[[sources/<slug>]]` links.** The repeated inline pattern was used in early ingests (Apr 29, 2026) and produced visual clutter — a single source could be cited 7+ times on one page. Migrated to footnotes 2026-05-01 per JT directive.

### Pattern

For each source cited on a concept page:

1. **Pick a stable footnote key** for the source — short, lowercase, kebab-case if multi-word. Conventions:
   - Author surname (e.g., `gardner` for Tyler Gardner).
   - First distinctive slug word if author is unknown or generic (e.g., `sbloc` if no author identified).
   - If two cited sources collide on key, append disambiguator (e.g., `gardner-2026-04`).
   - Record the chosen key in the source-summary frontmatter as `wiki-key: <key>` so future re-ingests of the same source reuse it.

2. **First reference** to the source on the page: include the full wikilink AND the footnote anchor.
   ```
   ... according to [[sources/the-0-percent-tax-bracket-most-retirees-walk-right-past]][^gardner].
   ```

3. **Subsequent references** on the same page: footnote anchor only.
   ```
   ... per Mechanism #2[^gardner].
   ```

4. **Bottom of page** — a `## Sources informing this page` H2 section with one footnote definition per source:
   ```
   ## Sources informing this page

   [^gardner]: [[sources/the-0-percent-tax-bracket-most-retirees-walk-right-past]] — Tyler Gardner, *Your Money Guide on the Side*: all five core mechanisms.
   [^kawashima]: [[sources/securities-based-line-of-credit]] — Chris Kawashima, *Schwab Center for Financial Research*: SBLOC mechanics + use cases.
   ```

   The footnote definition lines REPLACE the previous bullet-list catalog (same content, footnote syntax). Obsidian renders the inline `[^gardner]` as a clickable superscript number that jumps to the def.

### Why footnotes

- **Visual cleanliness.** Inline `[[sources/<long-slug>]]` repeated 7× on one page is unreadable; `[^gardner]` is unobtrusive.
- **Single source of truth.** The footnote definitions at the bottom replace the prior `## Sources informing this page` bullet list — same content, single representation.
- **First-reference context preserved.** The first inline use still shows the full source link, so a reader scanning the page top-to-bottom sees the source name explicitly. Re-references after that are compact.
- **Obsidian-native.** No plugin required; standard markdown footnote syntax that Obsidian renders out-of-box.

### What NOT to do

- Do NOT use `([[sources/<slug>]])` parenthesized inline citations (the legacy Apr 29, 2026 pattern). All concept pages migrated to footnotes 2026-05-01.
- Do NOT use plain numeric footnote keys (`[^1]`, `[^2]`) — they are not stable across edits (insertion of a new source between `[^1]` and `[^2]` forces renumbering). Always use named keys.
- Do NOT duplicate the source in BOTH the footnote def AND a bullet list at the bottom — the footnote defs ARE the source catalog now.
- Do NOT place footnote anchors (`[^key]`) inside Obsidian callout blocks (`> [!type]`). Obsidian renders the anchor as literal attached text inside callouts, not as a clickable footnote link (rendering bug; no version of this looks right). When citing inside a callout, either: (a) cite via the body sentence immediately preceding or following the callout, or (b) put the source name inline as plain text inside the callout. The footnote def at the bottom is unaffected — only the anchor is the problem inside callouts.


## Step 6 — Full-ripple propagation (MANDATORY EVERY RUN)

This is the load-bearing Karpathy operation. **Every `/wiki-ingest` must do the full ripple — no shortcuts, no "I'll come back later," no skipping.** Per Karpathy line 60: *"a single source might touch 10-15 wiki pages."*

For each topic/concept this source materially informs:

1. **Determine if a concept page exists** at `wiki/<topic-slug>.md`. If yes, you're updating; if no, you're creating.
2. **Create or update the concept page** with claims from this source. Each claim cites the source via the footnote pattern below.
3. **Surgical edits, not rewrites** — when updating an existing concept page, integrate new claims into the existing structure. Don't duplicate sections.
4. **Cross-link aggressively (no orphans):**
   - The new/updated concept page links OUT to other related concept pages already in the wiki.
   - Find 2-3 existing pages that should reference this concept page and add `[[wikilinks]]` from them TO it.
   - Read `!index.md` to know what other pages exist.
5. **Flag contradictions** — if this source contradicts an existing claim on another page, mark inline with `> [!contradiction]` callout. Surface in your reply to JT.
6. **Concept-page frontmatter:**

```yaml
---
created: <when first created>
updated: <YYYY-MM-DD HH:MM ET>
type: concept-page
wiki-topic: <slug>
provenance:
  by: daystrom
  via: /wiki-ingest
source-refs:                 # all sources that contribute to this page
  - <doc-id-1>
  - <doc-id-2>
related-pages:
  - "[[other-concept]]"
---
```

**Number of pages touched per ingest is typically 3-10**, sometimes more for dense sources. If the source only touches 1 page, that's a signal — either you're under-propagating or the source is genuinely narrow. Justify in your reply to JT.

### Step 6.5 — Self-check against `!style.md`

Before finalizing, re-read every page you wrote or modified during this run against `wiki/!style.md`. For each page, walk the seven load-bearing rules:

- Concept pages: italic teaser present? Pattern B complete (`[!info]` + `[!tldr]-`)?
- All pages: heading spacing tight (no blank line before body, except the two carve-outs)? Frontmatter → H1 tight? `[!quote]` absent? Emoji on at most one heading level? `[^key]` anchors only outside callout blocks?

Self-correct any violations in place. This catches drift at compose time so the nightly `/wiki-lint` run has nothing to flag from your work. Cheaper here than there.

### Step 7 — Update meta files

1. **`wiki/_processed.json`** — append/update entry: `"<doc-id>": { "ingested_at": "<ISO8601 UTC>", "slug": "<source-slug>", "source_summary": "sources/<source-slug>.md", "concept_pages": ["<topic1>.md", "<topic2>.md"], "raw_archive": "raw/<doc-id>.md" }`. Note: raw archive still uses doc-id naming (programmatic backstop, never browsed); only sources/ uses slug-naming.
2. **`wiki/!index.md`** — agent catalog. Add new pages with one-line summary; update existing entries if their summary shifted. Group by category (concepts / sources / etc.).
3. **`wiki/!home.md`** — narrative entry point. **Update only if this source materially shifts the wiki's big-picture narrative.** Don't update for incremental additions; do update when a new theme emerges or an existing theme changes shape.
4. **`wiki/!log.md`** — append a bullet entry per the format established 2026-04-29:
   ```
   - **<YYYY-MM-DD>** ingest: *<Article Title>* — <source attribution> → `sources/<source-slug>.md` + concept pages: `<topic1>.md`, `<topic2>.md`
   ```

### Step 8 — Report to JT

Telegram-friendly summary per CLAUDE.md `## Telegram Output Format` — plain-text numbered list, NEVER tables. Include:
- Source ingested (with deep-link)
- Source-summary page created (path)
- Concept pages created or updated (paths)
- Existing pages cross-linked (paths)
- Any contradictions flagged
- Brief judgment-call notes worth JT review

## Progress pings (interactive long-running runs only)

Wiki-ingest is an 8–15 min synthesis run; phase-boundary pings to JT via Telegram keep the run observable without polling.

**Phases (declarative — count auto-derives):**

```yaml
phases:
  - { idx: 1,        label: source-fetch,   output: "raw/<doc-id>.md" }
  - { idx: 2,        label: source-summary, output: "sources/<source-slug>.md" }
  - { idx: 3..M-1,   label: concept-page,   output: "<topic-slug>.md" }   # one ping per concept page
  - { idx: M,        label: meta-files,     output: "!index.md / !log.md / _processed.json" }
```

`M = 3 + concept_page_count`. Compute once at the end of Step 4 (after scope and concept pages are pinned with JT) and use that `M` for every ping in the run.

For the vault-only path (D-80): substitute `vault-query` for `source-fetch` and drop `source-summary`. `M = 2 + concept_page_count`.

**Format:**

- **Success:** `[N/M] <label> — <filename>`
  - Examples: `[1/5] source-fetch — raw/01k83vyqf...md` · `[3/5] concept-page — retirement-tax-efficiency.md`
- **Error:** `[N/M] <label> FAILED: <reason>` — emit BEFORE the error bubbles up.

**Rules:**

1. **Heartbeat-only content.** Pings contain phase label, output filename, counter, and (on error) reason. **NEVER quote source content** — no claims, no paragraphs, no excerpts. Pings live in the Telegram message log; that surface is not appropriate for source content (privacy + paywall-leak posture).

2. **Fail-soft on Telegram outage.** Wrap each ping send in try/catch. On failure, log `telegram-ping-failed: <phase>` at trace level and continue the ingest. Observability failures **never** block synthesis.

3. **Mandatory error pings.** When a phase fails, emit the `[N/M] FAILED: <reason>` ping BEFORE bubbling up the error. Without this, JT sees pings up to `N-1` then silence then a final error reply — the failure window is unobservable. With it, JT knows which phase died and why, immediately.

4. **Scope: interactive long-running skills only.** Progress pings apply to `/wiki-ingest`. Scheduled and short-running skills stay silent — cron-fired skills emitting pings would surprise JT mid-night, and short skills don't need observability:
   - **Silent (explicit list):** `/weekly-review`, `/security-audit` (Worf), `/pattern-recognition`, `/nightly-report`, `/wiki-lint`, `/moc-refresh`.
   - **When in doubt:** human-triggered + multi-minute → ping. Cron-fired or sub-minute → silent.

5. **`--quiet` opt-out.** Pass `--quiet` (e.g., `/wiki-ingest --quiet`) to suppress progress pings for a specific run. Useful during batch sessions when per-source pings become notification noise. Default is pings-on; `--quiet` is opt-out per-run.

6. **Sub-phase heartbeats during long phases (mandatory).** Phase-boundary pings are not enough — concept-page work can legitimately take 8-15 min per page (footnote ripples + cross-link edits). During that time, JT sees silence and the host's no-output watchdog can mistake real work for a stuck container. **Every ~120 seconds during a multi-minute phase, emit a brief status string** describing what you're working on right now. Format examples:

   - `… working on alzheimers-blood-tests.md (3/5 sections done)`
   - `… still on alzheimers-disease.md, integrating Reddy footnotes`
   - `… concept-page 4/5: cross-linking new claims into !index.md`

   These are first-class agent outputs (same surface as phase pings) — they reset the no-output watchdog AND keep JT informed continuously. JT 2026-05-02 directive: long runtimes are fine as long as heartbeats prove progress; the pain is silence, not duration.

7. **Resume announcement (mandatory on state-file pickup).** If `/wiki-ingest` invocation finds an existing `wiki/.in-progress.json` AND JT chose "resume," the FIRST output back to JT MUST be a single-line announcement before any phase work begins:

   - `↪ Resuming from phase <current_phase> (<current_phase_progress>) — <N>/<M> phases complete from prior session.`

   This sets context so JT knows what's about to happen rather than wondering why output looks like it's mid-stream.

8. **Per-concept-page pings on the resume path.** When resuming mid-ripple, EACH remaining concept page still emits its own `[N/M] concept-page — <topic-slug>.md` ping at completion. Don't skip pings just because earlier phases happened in a prior container.

## In-progress state file (resume after interruption)

Pings address silence-during-work but don't catch *agent forgets context mid-task*. A `wiki/.in-progress.json` ledger lets a fresh session resume cleanly when a prior session was interrupted, lost context, or stalled.

**Write timing:** at every phase boundary (immediately before emitting the success ping for the phase that just completed).

**Schema:**

```yaml
---
started_at: <ISO8601 UTC>
doc_id: <readwise-doc-id>          # null for vault-only path
source_slug: <source-slug>
phase_total: <M>
phases_completed: [source-fetch, source-summary, ...]
current_phase: concept-page         # next phase to attempt
current_phase_progress: "memory.md (2/3)"   # for concept-page; null otherwise
last_ping_at: <ISO8601 UTC>
---
```

**Atomic write:** temp file + rename (`os.replace`). Obsidian Sync compatible (per the host atomic-write rule).

**Lifecycle:**

- Created (or overwritten) at the **first phase boundary** of the run — i.e., immediately after Step 1 (source-fetch) completes. NOT after Step 4 — the state file must exist from very early because container watchdogs (10-min no-SDK-output) can fire during Steps 1-3 too. `phase_total` is left `null` until Step 4 sets it; `phases_completed: ["source-fetch"]` is recorded immediately.
- Updated at every subsequent phase boundary.
- **Deleted** when Step 7 (`meta-files`) completes successfully — completion is the signal that the run finished cleanly.

**Resume protocol:** at the start of every `/wiki-ingest` invocation, check whether `wiki/.in-progress.json` exists. If yes, surface to JT BEFORE picking a new source:

> "I see an in-progress ingest of `<title>` started <X> ago, last activity <Y> ago, currently in phase `<current_phase>` (<phase_progress>). Three options: (a) resume from where it left off, (b) discard this state and start fresh on a new source, (c) discard and re-run the same source from scratch. Which?"

JT picks the option; act accordingly. The in-progress file is then either updated (resume) or deleted (discard).

**Watchdog (shipped 2026-05-02 as R-8):** A fully frozen agent doesn't emit pings AND doesn't update the state file. The host-side timer at `daystrom-ops/scripts/stalled-ingest-watch.sh` runs every 5 min, reads this in-progress state file, and Telegram-alerts the operator if `last_ping_at` is older than 10 min. Independent of the skill — fires even if the agent is in a state where no skill-side mechanism could surface the stall.

## Vault-only path (D-80)

If JT invokes naturally without a Readwise source — e.g. *"Create a wiki page on X"* — skip Steps 1, 2, 5 above. Instead:
- Run `mcp__qmd__query` over the full `general` namespace to gather vault material.
- Discuss scope with JT.
- Skip raw archive + source-summary creation (no Readwise doc).
- Proceed with Step 6 (concept page creation) — `provenance.source: vault`, `source-refs: []`, citations point at vault paths instead of source-summary slugs.
- Update `!index.md` + `!log.md` with a `vault-ingest` op type.

## What you MUST NOT do

- **Do NOT batch-read multiple sources before processing.** One at a time, always (Karpathy + JT directive).
- **Do NOT skip the full ripple.** Step 6 is mandatory every run. *"I'll deepen this later"* is the wrong answer.
- **Do NOT write inline tables in Telegram replies** — plain-text numbered list per CLAUDE.md `## Telegram Output Format`.
- **Do NOT touch any vault content outside `wiki/`** — Karpathy ringfence + JT directive. Wiki work is `general/wiki/` only.
- **Do NOT write to `wiki/raw/` after initial archive** — raw is immutable.
- **Do NOT modify a non-AUTO context phrase in `!index.md`** — JT-authored prose is sacred. Only fill blanks or upgrade AUTO entries.
- **Do NOT modify schema files (CLAUDE.md, this SKILL.md).** Architect-controlled.

## Rationale

Karpathy line 30: *"the LLM doesn't just index it for later retrieval. It reads it, extracts the key information, and integrates it into the existing wiki — updating entity pages, revising topic summaries, noting where new data contradicts old claims, strengthening or challenging the evolving synthesis."*

The compounding effect comes from concept-page maintenance across many sources. Source pages are leaf nodes; concept pages are where ideas get woven. Without the split, the wiki shape is "list of summaries" not "graph of ideas." This skill enforces the split + the full ripple.

The 200KB raw cap, the deep-link-on-announcement pattern, the `<!-- AUTO -->` MOC tag, and the no-tables Telegram format are Daystrom-specific conventions. Everything else is Karpathy.
