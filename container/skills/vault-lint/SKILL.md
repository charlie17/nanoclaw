---
name: vault-lint
description: Audit the WHOLE vault for dead wikilinks and link rot. Fires on `/vault-lint`, "check for broken links", "link rot", "are any links dead", "did that rename break anything", or any vault-wide link/reference audit. Also fires after a bulk rename, move, or folder reorg. NOT for wiki-only health (that's /wiki-lint) and NOT for MOC `!index` upkeep (that's /moc-refresh).
---

# /vault-lint — vault-wide dead-wikilink audit (report-only)

## Run it

```bash
python3 /home/node/.claude/skills/vault-lint/vault_lint.py
```

Defaults to `/workspace/extra/vault` (= host `~/vault/general/`). Pass `--root PATH` to scope it narrower. Output is a single JSON object on stdout — parse it, don't re-read the vault yourself. All **file-level** resolution, code-block exclusion, and classification is already done; your job is only to summarize. Read the limits below before claiming a clean bill of health.

Exit 1 with `{"error": ...}` means the root is missing — report that and stop.

## Report it

Per Reply Discipline — executive summary, then what matters. **Drop every empty class entirely**; never emit "0 broken embeds" lines. Silence is the signal.

- **Headline:** files scanned, links checked, total actionable findings.
- **`general_prefix` and `rename_orphan`** are the actionable ones — each carries a `suggested` repoint. Lead with these; show file, the link, and the suggested target.
- **`ambiguous`** — basename matches several files; list the candidates and let JT pick.
- **`broken_embed` / `broken_ref`** — group by file, show the worst offenders, give a count rather than dumping a long tail.
- **`private_unverifiable`** — one line, only if nonzero: "N links point into the private vault, which isn't mounted — not checked." Never call these broken.
- **`historical`** — one line, only if nonzero: "N broken links across M historical snapshot files (informational — snapshots are never edited)." Do not offer to fix them.

## Hard rule

**Report only. Never edit a vault file from this skill** — no repoints, no deletions, no "while I was in there" cleanups, however obvious the fix looks. Present the suggestions and stop. Fixes happen only when JT explicitly says to make them, as a separate instruction.

## Known limits (state them if relevant, don't work around them)

**Anchors are not validated.** `[[note#heading]]` and `[[note#^block]]` are checked at file level only — the subref is stripped before resolution, so a link to a heading that no longer exists reads as fine. A clean run means every link finds its *file*, not its *anchor*.

Bare-basename links that match any file resolve, so a stale link pointing at a since-renamed note only surfaces when it carries a path.

Fence detection allows any indentation, so fences nested under list items are handled. The accepted cost: a 4-space-indented code block whose content happens to include a ```` ``` ````-like line will toggle fence state and hide what follows. Rare-on-rare, and far better than the alternative — missing list-nested fences meant every example link inside one came back a false positive.

Inline code spans that wrap across a line break are not blanked (the scanner works line by line), so a wikilink sitting on the continuation line can be falsely reported. Reviewed and accepted: the shape is rare, the tool is report-only, and carrying backtick state across lines would risk silently swallowing real links — a worse failure than an occasional false positive.
