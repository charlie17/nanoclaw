---
name: /coding-recap
description: Recap JT's coding activity across GitHub mirrors using git log --all — explicit /coding-recap or natural language like "recap my coding work this week", "recap last month on jt-daystrom", "recap project Y from its first commit".
---

# /coding-recap — GitHub mirror activity recap

On-demand recap of JT's coding work via LaForge-maintained local mirrors. No live GitHub API, no network at query time. Read-only.

## Invocation

Explicit `/coding-recap` or natural language: "recap my coding work", "what did I code this week", "recap last month on <repo>", "recap project Y from its first commit".

## Inputs

- **Repo** (optional): named repo filters to one mirror; omit to recap all 7 grouped by repo.
- **Time range** (optional): "last week" (default), "last N days", "last month", "last year", "since YYYY-MM-DD", "all time". Translate to `--since=` flags. If omitted, default to **last 7 days** and state this explicitly in the recap output.

## Available mirrors

Path: `/workspace/extra/github-mirrors/<name>.git`  
Repos: `coactive`, `jt-ai-counsel`, `jt-daystrom`, `jt-leanspec`, `jt-options-backtesting`, `jt-options-data-2026`, `nanoclaw`

## Discovery flow

If JT asks "what repos can you recap?" or uses an unrecognized name, enumerate mirrors:

```
ls /workspace/extra/github-mirrors/*.git
```

- **Fuzzy match:** "options" matches two repos → list `jt-options-data-2026` + `jt-options-backtesting` and ask JT which one.
- **No match:** report unknown; suggest running the discovery command above.

## Recap flow

For each in-scope mirror, all queries use `git log --all` (full form: `git --git-dir=<mirror-path> log --all <args>`):

1. **Count commits first:**
   ```
   git --git-dir=/workspace/extra/github-mirrors/<name>.git log --all --oneline --since=<range> | wc -l
   ```
2. **Count >150:** surface the count and ask JT to confirm or narrow scope before proceeding.
3. **Count ≤150:** proceed without asking.
4. **Fetch activity:**
   ```
   git --git-dir=/workspace/extra/github-mirrors/<name>.git log --all --shortstat --since=<range>
   ```
5. Synthesize a prose summary. Group by repo; name branches when relevant.

## MUST / MUST NOT

**MUST use `git log --all` on every invocation.** Bare-repo HEAD points to the default branch (`main`). Naked `git log` silently drops all feature/working-branch commits — confirmed Impl-41 D7: 135 commits on `v2-impl` were invisible without `--all`. This is a non-negotiable hard rule. No exceptions.

**MUST ask before pulling diffs.** `git log -p` is ~10× token cost per commit. Before pulling diffs say: "Want me to include full file diffs? They're roughly 10× the token cost per commit." Only proceed on explicit JT confirmation.

**MUST NOT do live codebase scan.** `git show <ref>:<path>` and current file contents are out of scope — defer to a future batch.

**MUST NOT output markdown tables.** Telegram does not render pipe/dash table syntax. Use prose paragraphs or plain-text lists only.

## Output forms

- **Prose paragraph** (default) — flowing summary per repo; mention commit count, branches, notable patterns.
- **Bullet list** — if JT asks for a list.
- **Save to vault** (on explicit JT request only): write `general/research/coding-recap-<YYYY-MM-DD>-<scope>.md` with frontmatter:
  ```
  trust: trusted
  type: coding-recap
  scope: <repo or "all">
  date: <YYYY-MM-DD>
  ```
  Never overwrite; date-stamped name is unique per run.

## Trust framing

Content originates from JT's own repos. Always `trust: trusted` — never `trust: untrusted`.

## Rationale

Implements BA §9.8 UC23. v1 dispatched Riker for live GitHub API fetching; v2 cuts Riker (D-2). The replacement is the LaForge mirror-pull data pipe (Batch 4.5, Impl-41 DEPLOYED) — bare repos at `~/github-mirrors/` on the VPS host, bind-mounted read-only into Daystrom's container at `/workspace/extra/github-mirrors/`. The `--all` constraint (D-R4) closes FU-17, retired into spec at BA §9.8 UC23 (commit `80d72e8`).
