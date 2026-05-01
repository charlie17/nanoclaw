# /moc-refresh — Skill Spec (MOC integrity walk + auto-fix)

When JT invokes `/moc-refresh`, walk the vault's MOC (Map of Content) tree, detect orphan files and missing context phrases, fix orphans with LLM-generated context phrases tagged `<!-- AUTO -->`, and report findings as a Telegram-friendly numbered list.

Announce model at start: "Running `/moc-refresh` — walking vault MOCs."

## What MOCs cover (and what they don't)

Per pre-pass A11 + scope plan §6 + BA §F12. Three explicit tiers + one extension:

| MOC | Scope | Links to |
|---|---|---|
| `general/!index.md` (hub) | Top-level entry point | All domain MOCs (`logs/!index.md`, `reference/!index.md`, `projects/{name}/!index.md` for each project) |
| `logs/!index.md` | Log-domain MOC | Each `logs/<domain>.md` file (arts, pops, mpm, dogs, family, gifts, slaters, sawyer, poker, coding) |
| `reference/!index.md` | Reference-area MOC | Single-file areas (coding, quotes, facts-stats, remember, org-approach, family-watchlist, reading-list, food) + folder areas (learning/, travel/, house/) |
| `projects/{name}/!index.md` | Per-project MOC | Files inside that project's folder (next.md, notes/, etc.) |

**OUT OF SCOPE for `/moc-refresh`:**
- `general/wiki/!index.md` — Karpathy wiki's own catalog. Owned by `/wiki-lint` + `/wiki-ingest`. Do NOT touch.
- `actions/` and `research/` — no MOCs in v1. Skip.
- `general/tmp/` — short-lived scratch. Skip.
- Anything inside `quarantine/` — never accessible to Daystrom.

## Walk flow

1. **Read CLAUDE.md** §"File paths and naming conventions" to load the authoritative routing schema (single-files + folder areas + log domains).

2. **For each in-scope MOC** (from the table above):
   - **Does the MOC file exist?** If no, create it with the standard MOC template (see below).
   - **Walk the corresponding namespace** — list every file/folder that should appear in this MOC per the routing schema.
   - **Compare MOC contents to namespace** — find:
     - **Orphan files** = files exist in the namespace but have no entry in the MOC
     - **Broken links** = MOC entries pointing to files that no longer exist (renamed, deleted, moved)
     - **Bare-link entries** = entries with no context phrase (per Vera Must-Fix rule)

3. **Auto-fix where safe:**
   - **Orphans** → add entry with LLM-generated context phrase tagged `<!-- AUTO -->`
   - **Broken links** → flag in report; do NOT silently delete (entry might just be a misspelling JT can fix manually)
   - **Bare links** → upgrade to context-phrased entries with `<!-- AUTO -->` tag
   - **Existing context-phrased entries** → never modify. JT-authored prose is sacred.

4. **Per-MOC summary line** — for the report.

5. **Report to JT** as a Telegram-friendly numbered list (per CLAUDE.md `## Telegram Output Format` — never tables).

6. **Update last-run marker** so the nightly skip-when-quiet check sees this run. Use Bash: `touch /workspace/extra/vault/.moc-refresh-last-run`. The mtime of that file is what the prefetch script compares against.

## Context-phrase generation rules

When generating a context phrase for a new or upgraded entry:

- **Length:** 4-12 words. One short clause. No multi-sentence prose.
- **Tone:** match neighbors when neighbors exist. If three other entries say *"daily reflections"*, *"weekly Slater check-ins"*, etc., new entries should sound similar in register.
- **Sources for the phrase:**
  1. The file's H1 heading (if descriptive)
  2. First sentence of any frontmatter `description:` field
  3. First non-frontmatter paragraph (first sentence only)
  4. As a last resort, a phrase derived from the filename slug
- **Mark every auto-generated phrase** with `<!-- AUTO -->` AT END OF LINE (HTML comment — invisible in Obsidian render, greppable for JT review): `- [[some-file]] — context phrase here. <!-- AUTO -->`
- **NEVER** overwrite an entry that already has a non-AUTO context phrase. JT-authored prose stays.
- **If you cannot generate a meaningful phrase** from the file (e.g., empty file, only frontmatter), use `[empty / needs context] <!-- AUTO -->` so JT sees it on review.

## MOC entry shape

Standard format for one entry, with context phrase:

```
- [[reference/coding]] — Evergreen coding precepts, tool tips, stack notes, and API reference. <!-- AUTO -->
```

For folder-pattern areas (which contain multiple files), point to the folder + give a one-line scope:

```
- [[reference/house/]] — House topics: renovations, paint colors, vendor contacts, HVAC, etc. <!-- AUTO -->
```

For per-project MOC entries inside `general/!index.md`, link to the project's own MOC, not directly to project files:

```
- [[projects/options/!index]] — Trading systems and options strategy work. <!-- AUTO -->
```

## Standard MOC template

When creating a MOC file from scratch:

```markdown
---
type: moc
created: <YYYY-MM-DD HH:MM ET>
updated: <YYYY-MM-DD HH:MM ET>
---

# {{NAMESPACE_NAME}}

> Map of content for the {{NAMESPACE_NAME}} namespace. Generated and maintained by Daystrom via `/moc-refresh` and on-write updates. Entries marked `<!-- AUTO -->` were generated by Daystrom; JT may rewrite the context phrases at any time and remove the AUTO tag.

## Entries

<!-- entries below — alphabetical or grouped per JT's editing preference -->

```

For `general/!index.md` (the hub), use a sectioned shape:

```markdown
# Vault hub

> The top of the vault. Each section below points to a namespace MOC; drill in for that namespace's full file index.

## Domains

- [[logs/!index]] — Log domains (arts, pops, family, etc.). Append-only chronological streams. <!-- AUTO -->
- [[reference/!index]] — Evergreen reference (coding, food, house, learning notes, travel guides). <!-- AUTO -->

## Projects

- [[projects/options/!index]] — ... <!-- AUTO -->
- [[projects/daystrom/!index]] — ... <!-- AUTO -->

## Other

- [[general/wiki/!index]] — Karpathy-method synthesized knowledge wiki (separate system; owned by /wiki-ingest + /wiki-lint).
```

## Output to JT

Per CLAUDE.md `## Telegram Output Format` — plain-text numbered list, NEVER tables. Report:

```
1. general/!index.md — created (was missing). 4 orphan domains added with AUTO tags.
2. logs/!index.md — 3 orphans added (coding.md, dogs.md, gifts.md). All AUTO-tagged.
3. reference/!index.md — 1 broken link flagged (reference/old-thing.md → file does not exist). 2 bare links upgraded with AUTO context phrases.
4. projects/options/!index.md — clean. No changes.
5. projects/daystrom/!index.md — created (was missing). 3 orphans added.

Total: 2 MOCs created · 9 entries added · 2 entries upgraded · 1 broken link flagged for JT review.

Suggested next actions:
- Review AUTO-tagged entries (grep `<!-- AUTO -->` across general/) and rewrite phrases that don't match your voice
- Fix the broken link at reference/!index.md (search "old-thing")
```

If grep would help JT find AUTO entries: include the exact command at the end of the report.

## What you MUST NOT do

- **Do NOT touch `general/wiki/!index.md`** — Karpathy's wiki system is owned by `/wiki-lint` + `/wiki-ingest`. Wiki ringfence holds.
- **Do NOT create directories.** Per the no-new-directories write-discipline rule, MOCs only get created inside directories that already exist. If `projects/foo/` doesn't exist, do NOT create `projects/foo/!index.md` — flag to JT.
- **Do NOT overwrite JT-authored context phrases.** Only fill blanks or create AUTO entries.
- **Do NOT silently delete broken-link entries.** Flag them.
- **Do NOT touch `quarantine/` or `private/`** — structurally unreachable anyway.
- **Do NOT batch up changes silently.** The report is the deliverable; JT must see what changed.
- **Do NOT use markdown tables in the Telegram report** — plain-text numbered list per CLAUDE.md `## Telegram Output Format`.

## Rationale

MOCs are *navigation*; qmd is *search*. Both serve different query modes per pre-pass A11. Auto-maintenance keeps the navigation layer alive without burdening JT with bookkeeping. The `<!-- AUTO -->` tag is the human-review breadcrumb — JT periodically scans MOCs, rewrites AUTO phrases that don't match his voice, and removes the tag once the entry is JT-blessed. Over time, the wiki + MOC system fills with hand-curated language; AUTO is the temporary scaffold.

`/moc-refresh` is manually invoked in v1. Future FU: integrate into `/weekly-review` as a Friday-pipeline component.
