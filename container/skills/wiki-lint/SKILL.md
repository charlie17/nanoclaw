# /wiki-lint — Karpathy wiki health-check, aggressive fix-don't-just-report

When JT invokes `/wiki-lint` (manually OR via the nightly @ 2am ET (cron `0 6 * * *` UTC during EDT) scheduled run), audit the wiki for health issues. **Fix what can be fixed; report what requires judgment.** Announce model: "Running `/wiki-lint` with Sonnet — wiki audit."

## Audit dimensions (Karpathy line 66)

Nine dimensions audited in order:

1. **Orphan pages** — pages in `wiki/` with no inbound `[[wikilinks]]` from other wiki pages. **AUTO-FIX:** find 2-3 related concept pages (read `!index.md` + use qmd query for semantic neighbors), add `[[wikilinks]]` from those pages to the orphan, and add return links from the orphan.
2. **Dead-end pages** — pages with no outbound `[[wikilinks]]`. **AUTO-FIX:** scan the page content; for every entity, concept, or source mentioned that has a corresponding wiki page, add `[[wikilink]]`.
3. **Bare-link entries in `!index.md`** — index entries with no context phrase. **AUTO-FIX:** generate a 4-12 word context phrase from the target page's H1 + first paragraph; tag with `<!-- AUTO -->` for JT review.
4. **Broken wikilinks** — `[[link]]` pointing to a page that doesn't exist (renamed, deleted, never created). **AUTO-FIX (cautious):** if the target slug has a clear typo (Levenshtein distance 1-2 from an existing page), correct it. Otherwise FLAG for JT — file may have been intentionally deleted or the link is anticipating a future page.
5. **Missing cross-references** — pages that discuss the same topic but don't link to each other. **AUTO-FIX:** add bidirectional wikilinks.
6. **Contradictions** — claims on one page that conflict with claims on another. **REPORT** with `> [!contradiction]` callout inline AND in the JT report. Editorial judgment required; do NOT auto-correct.
7. **Stale claims** — assertions where a newer source has superseded an older one. **REPORT** for JT review; do NOT auto-rewrite.
8. **Important concepts lacking pages** — concepts mentioned 3+ times across multiple sources but with no dedicated concept page. **REPORT** with proposed slug; JT decides whether to author.
9. **Footnote anchors inside callout blocks** — Obsidian renders `[^key]` anchors inside `> [!type]` callouts as literal attached text (e.g., `Mechanism #2[^gardner]` displays as `Mechanism #2gardner`), not as clickable footnote links. Walk every callout block (contiguous run of lines starting with `>`); flag any `[^...]` anchor inside. Skip fenced code blocks even when they appear inside a callout. **AUTO-FIX:** when the same `[^key]` appears at least once outside the callout on the same page, strip the anchor from inside the callout (citation chain stays intact via the body reference). Footnote definitions at the bottom of the page are preserved unchanged. **FLAG for JT:** when the callout contains the only reference to a footnote on the page — moving the first reference out into body prose is editorial judgment.

## Skip-when-quiet check (nightly mode)

When invoked from the nightly scheduled task, FIRST check whether anything has changed since the last lint run:

```bash
# In the prefetch script (groups/daystrom/scripts/wiki-lint-prefetch.sh):
# Compare mtime of every .md file under ~/vault/general/wiki/ (excluding raw/) 
# against last-lint timestamp stored in ~/vault/general/wiki/.lint-last-run.
# If no file is newer, exit before invoking the agent.
```

If skip-when-quiet fires, log only: `- **<YYYY-MM-DD>** lint: skipped (no wiki changes since last run)` to log.md. NO Telegram notification. NO agent dispatch — saves the API spend.

## Output

If at least one finding (auto-fix or JT-report), produce a Telegram-friendly numbered list (NEVER tables, per CLAUDE.md `## Telegram Output Format`). Skip the Telegram notify entirely if zero findings — silent runs are fine.

```
1. Orphan fixed: [[retirement-tax-efficiency]] — added inbound links from [[asset-allocation]] and [[financial-planning]].
2. Bare-link upgraded in !index.md: 3 entries got AUTO context phrases — review at your leisure (grep `<!-- AUTO -->`).
3. Broken wikilink FLAGGED: [[old-page-slug]] referenced by [[financial-planning]] — does not exist. Fix or remove?
4. Contradiction FLAGGED: [[asset-allocation]] claims X but [[retirement-tax-efficiency]] claims X-prime. JT review.
5. Missing concept page proposed: "Roth conversions" mentioned in 4 sources but no dedicated page. Author?
6. Footnote-in-callout fixed: [[retirement-tax-efficiency]] — stripped 3 [^gardner] anchors from [!tldr]- block (same key referenced in body).

Auto-fixed: 4 items. Flagged for JT: 3 items.
```

## Append to log.md

Always append a bullet entry per the format established 2026-04-29:

```
- **<YYYY-MM-DD>** lint: <one-line summary — N auto-fixed, M flagged>
```

**Update the last-run marker** so next nightly skip-when-quiet check sees this run. Use Bash: `touch /workspace/extra/vault/wiki/.lint-last-run`. The mtime of that file is what the prefetch script compares against.

## Output guarantees

- Auto-fixes are **bidirectional** — every link added between A and B is added on BOTH sides (A → B AND B → A).
- Auto-fixes use `<!-- AUTO -->` tags ONLY where context-phrase generation occurred (`!index.md` entries). Wikilink additions inside concept pages are not AUTO-tagged — they're mechanical, not judgment.
- Reports include a clear "auto-fixed N | flagged M" tally so JT sees the work at a glance.

## What you MUST NOT do

- **Do NOT modify wiki page content beyond adding/fixing wikilinks** in concept and source pages. Don't rewrite prose; don't touch `!home.md`'s narrative.
- **Do NOT auto-correct contradictions or stale claims** — editorial judgment required.
- **Do NOT touch `wiki/raw/`** — immutable per Karpathy.
- **Do NOT write to vault dimensions outside `wiki/`.**
- **Do NOT ingest new sources during a lint run.**
- **Do NOT delete files** even if a wikilink seems orphaned — files might be intentionally kept.
- **Do NOT spam Telegram on quiet nights** — skip-when-quiet logic is mandatory in nightly mode.

## Rationale

Karpathy line 66: *"contradictions, stale claims, orphan pages with no inbound links, important concepts mentioned but lacking their own page, missing cross-references."* The Wikiwise principle of **"fix-don't-just-report"** matches Karpathy's intent — orphans and dead-ends are mechanical bugs that don't need JT's time; contradictions and stale claims do. Aggressive auto-fix on the mechanical layer + cautious report on the judgment layer keeps the wiki healthy without burdening JT with bookkeeping. Per JT directive 2026-04-29.
