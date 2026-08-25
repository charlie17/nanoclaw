#!/usr/bin/env python3
"""vault-lint — deterministic vault-wide dead-wikilink linter (report-only).

Walks every *.md under the vault root, extracts wikilinks/embeds outside of
code, resolves them with Obsidian semantics, and emits a single JSON object on
stdout. This script NEVER writes to the vault.

Python 3 stdlib only (container base is node:22-slim: no jq, no pip packages).
"""

import argparse
import json
import os
import posixpath
import re
import sys

DEFAULT_ROOT = "/workspace/extra/vault"

# Historical snapshot dirs (vault-relative). Point-in-time records, never
# edited by policy — scanned for aggregate counts only, never itemised.
HISTORICAL_DIRS = ("logs/daystrom-reviews", "logs/daystrom-reports")

CLASSES = (
    "broken_embed",
    "general_prefix",
    "rename_orphan",
    "ambiguous",
    "private_unverifiable",
    "broken_ref",
)

# Arbitrary leading whitespace, not CommonMark's 3-space cap: fences nested
# under list items are indented 4+ spaces and were previously missed entirely,
# so every link in a list-nested code block came back a false positive. The
# accepted cost is that a 4-space-indented code block whose content happens to
# contain a ```-like line now toggles fence state.
FENCE_RE = re.compile(r"^\s*(`{3,}|~{3,})")
QUOTE_RE = re.compile(r"^(?:[ \t]{0,3}>[ \t]?)+")
LINK_RE = re.compile(r"(!?)\[\[([^\[\]\n]+)\]\]")


# --------------------------------------------------------------------------
# code stripping
# --------------------------------------------------------------------------


def blank_inline_code(line):
    """Replace inline code spans with spaces, preserving line length."""
    out = list(line)
    n = len(line)
    i = 0
    while i < n:
        if line[i] != "`":
            i += 1
            continue
        j = i
        while j < n and line[j] == "`":
            j += 1
        run = j - i
        k = j
        closed = False
        while k < n:
            if line[k] == "`":
                m = k
                while m < n and line[m] == "`":
                    m += 1
                if m - k == run:
                    for p in range(i, m):
                        out[p] = " "
                    i = m
                    closed = True
                    break
                k = m
            else:
                k += 1
        if not closed:
            # Unterminated run — not a code span; skip past the backticks.
            i = j
    return "".join(out)


def unquote(line):
    """Strip a leading blockquote prefix. Returns (depth, inner_line).

    Fenced code blocks are routinely nested inside blockquotes in these docs
    (`> ```markdown`). Without stripping the prefix the fence goes undetected
    and every example link inside it is falsely reported.
    """
    m = QUOTE_RE.match(line)
    if not m:
        return 0, line
    return m.group(0).count(">"), line[m.end():]


def strip_code(text):
    """Return lines with fenced blocks and inline spans blanked out.

    Line count and line lengths are preserved so reported line numbers stay
    accurate.
    """
    lines = text.split("\n")
    result = []
    fence = None  # (char, length, quote_depth)
    for line in lines:
        depth, inner = unquote(line)
        m = FENCE_RE.match(inner)
        if fence is not None:
            if depth < fence[2]:
                # Left the blockquote — the quoted code block ends with it.
                fence = None
            elif m and depth == fence[2]:
                marker = m.group(1)
                if marker[0] == fence[0] and len(marker) >= fence[1]:
                    fence = None
                result.append("")
                continue
            else:
                result.append("")
                continue
        if m:
            marker = m.group(1)
            fence = (marker[0], len(marker), depth)
            result.append("")
            continue
        result.append(blank_inline_code(line))
    return result


# --------------------------------------------------------------------------
# vault index
# --------------------------------------------------------------------------


def is_historical(rel_dir):
    return any(
        rel_dir == h or rel_dir.startswith(h + "/") for h in HISTORICAL_DIRS
    )


def collect(root):
    """Walk the vault. Returns (live_md, hist_md, all_files) of relpaths.

    Hidden dirs/files (including .obsidian/) are skipped entirely. Historical
    snapshot dirs ARE indexed as link targets but their md files are segregated
    so they can be counted rather than itemised.
    """
    live_md, hist_md, all_files = [], [], []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        rel_dir = os.path.relpath(dirpath, root).replace(os.sep, "/")
        if rel_dir == ".":
            rel_dir = ""
        historical = is_historical(rel_dir)
        for fn in sorted(filenames):
            if fn.startswith("."):
                continue
            rel = "{}/{}".format(rel_dir, fn) if rel_dir else fn
            all_files.append(rel)
            if fn.lower().endswith(".md"):
                (hist_md if historical else live_md).append(rel)
    return live_md, hist_md, all_files


def build_index(all_files):
    idx = {
        "by_path": {},
        "by_path_ci": {},
        "md_stems": {},
        "any_names": {},
        "any_stems": {},
        "all_lower": [],
    }
    for rel in all_files:
        idx["by_path"][rel] = rel
        idx["by_path_ci"].setdefault(rel.lower(), rel)
        idx["all_lower"].append((rel.lower(), rel))
        name = rel.rsplit("/", 1)[-1]
        stem, ext = os.path.splitext(name)
        idx["any_names"].setdefault(name.lower(), []).append(rel)
        idx["any_stems"].setdefault(stem.lower(), []).append(rel)
        if ext.lower() == ".md":
            idx["md_stems"].setdefault(stem.lower(), []).append(rel)
    return idx


def resolve_path(target, idx):
    """Resolve a path-ish target relative to the vault root. Returns rel or None."""
    t = target.strip().strip("/")
    if not t:
        return None
    for cand in (t, t + ".md"):
        if cand in idx["by_path"]:
            return idx["by_path"][cand]
    for cand in (t.lower(), t.lower() + ".md"):
        if cand in idx["by_path_ci"]:
            return idx["by_path_ci"][cand]

    # Obsidian suffix resolution: a partial path resolves if exactly one file
    # in the vault ends with it. Two or more candidates is genuinely
    # ambiguous — leave it unresolved and let classify() bucket it.
    low = t.lower()
    tails = ("/" + low, "/" + low + ".md")
    match = None
    for lower_rel, rel in idx["all_lower"]:
        if lower_rel.endswith(tails):
            if match is not None:
                return None
            match = rel
    return match


def resolve_name(target, is_embed, idx):
    """Resolve a bare basename. Returns a (possibly empty) candidate list."""
    low = target.strip().lower()
    if not low:
        return []
    if is_embed:
        # Embeds resolve against ANY extension (images, PDFs, notes).
        return (
            idx["any_names"].get(low)
            or idx["any_stems"].get(low)
            or []
        )
    hit = idx["md_stems"].get(low)
    if hit:
        return hit
    if low.endswith(".md"):
        return idx["md_stems"].get(low[:-3]) or []
    if "." in low:
        # A bare link (not an embed) to an asset — `[[diagram.pdf]]` — is valid
        # Obsidian. Only honoured when the target carries an extension: an
        # extensionless name keeps preferring md, since an any-stem fallback
        # would over-resolve and hide real rot.
        return idx["any_names"].get(low) or []
    return []


def link_form(rel):
    """Vault-relative path in wikilink form (.md stripped)."""
    return rel[:-3] if rel.lower().endswith(".md") else rel


# --------------------------------------------------------------------------
# link extraction + classification
# --------------------------------------------------------------------------


def extract_links(lines):
    """Yield (line_no, raw, is_embed, target) for every wikilink outside code."""
    for n, line in enumerate(lines, 1):
        for m in LINK_RE.finditer(line):
            bang, inner = m.group(1), m.group(2)
            target = inner.split("|", 1)[0]
            # `[[Note\|alias]]` — the pipe must be escaped inside a markdown
            # table cell. Without this the target keeps a trailing backslash
            # and every table wikilink reads as broken.
            target = target.rstrip("\\")
            target = target.split("#", 1)[0].strip()
            if not target:
                # [[#heading]] / [[#^block]] — same-file anchor, not a file ref.
                continue
            yield n, m.group(0), bang == "!", target


def is_relative_target(target):
    """True for targets Obsidian resolves against the SOURCE file's directory."""
    return (
        target.startswith("../")
        or target.startswith("./")
        or "/../" in target
        or "/./" in target
    )


def normalize_relative(target, source_rel):
    """Vault-root-relative form of a source-relative target.

    Returns None if the target climbs above the vault root — that is
    unresolvable by definition, not something to guess at.
    """
    src_dir = source_rel.rsplit("/", 1)[0] if "/" in source_rel else ""
    norm = posixpath.normpath(posixpath.join(src_dir, target) if src_dir else target)
    if norm == ".." or norm.startswith("../") or norm == ".":
        return None
    return norm.lstrip("/")


def resolve_link(target, is_embed, idx, source_rel):
    """Resolve one link. Returns (resolved, effective_target).

    `effective_target` is what classification should use — for a relative link
    that is the vault-root-relative normalization, so any `suggested` repoint
    comes out sane instead of echoing a `../` fragment.
    """
    if is_relative_target(target):
        norm = normalize_relative(target, source_rel)
        if norm is None:
            # Escapes the vault root — leave the raw target for the report.
            return False, target
        return resolve_path(norm, idx) is not None, norm
    if "/" in target:
        return resolve_path(target, idx) is not None, target
    return len(resolve_name(target, is_embed, idx)) > 0, target


def classify(target, is_embed, idx):
    """Classify an UNRESOLVED link. Returns (cls, extra_dict).

    NOTE (deliberate deviation from the brief's numbering): private_unverifiable
    is evaluated FIRST. The private vault is not mounted, so a private/ target is
    definitionally unverifiable — letting it fall into broken_embed or, worse,
    rename_orphan (which would emit a "suggested" repoint pointing OUT of the
    private vault into general/) produces actively harmful suggestions.
    """
    if target.startswith("private/"):
        return "private_unverifiable", {}

    if is_embed:
        return "broken_embed", {}

    if target.startswith("general/"):
        stripped = target[len("general/"):]
        if stripped and resolve_path(stripped, idx) is not None:
            return "general_prefix", {"suggested": stripped}

    basename = target.rsplit("/", 1)[-1]
    if basename.lower().endswith(".md"):
        basename = basename[:-3]
    cands = idx["md_stems"].get(basename.lower()) or []
    if len(cands) == 1:
        return "rename_orphan", {"suggested": link_form(cands[0])}
    if len(cands) > 1:
        return "ambiguous", {"candidates": [link_form(c) for c in sorted(cands)]}

    return "broken_ref", {}


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------


def read_text(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return None


def lint(root):
    live_md, hist_md, all_files = collect(root)
    idx = build_index(all_files)

    findings = {c: [] for c in CLASSES}
    links_checked = 0
    files_scanned = 0

    for rel in live_md:
        text = read_text(os.path.join(root, rel.replace("/", os.sep)))
        if text is None:
            continue
        files_scanned += 1
        lines = strip_code(text)
        for line_no, raw, is_embed, target in extract_links(lines):
            links_checked += 1
            ok, eff = resolve_link(target, is_embed, idx, rel)
            if ok:
                continue
            cls, extra = classify(eff, is_embed, idx)
            item = {"file": rel, "line": line_no, "raw": raw, "target": eff}
            item.update(extra)
            findings[cls].append(item)

    hist_files = 0
    hist_broken = 0
    for rel in hist_md:
        text = read_text(os.path.join(root, rel.replace("/", os.sep)))
        if text is None:
            continue
        hist_files += 1
        lines = strip_code(text)
        for _, _, is_embed, target in extract_links(lines):
            ok, eff = resolve_link(target, is_embed, idx, rel)
            if ok:
                continue
            cls, _extra = classify(eff, is_embed, idx)
            if cls != "private_unverifiable":
                hist_broken += 1

    for c in CLASSES:
        findings[c].sort(key=lambda f: (f["file"], f["line"]))

    return {
        "root": os.path.abspath(root).replace(os.sep, "/"),
        "files_scanned": files_scanned,
        "links_checked": links_checked,
        "findings": findings,
        "historical": {"files": hist_files, "broken_total": hist_broken},
        "summary": {c: len(findings[c]) for c in CLASSES},
    }


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Vault-wide dead-wikilink linter (report-only)."
    )
    ap.add_argument("--root", default=DEFAULT_ROOT, help="vault root directory")
    args = ap.parse_args(argv)

    if not os.path.isdir(args.root):
        json.dump(
            {"error": "vault root not found", "root": args.root},
            sys.stdout,
            indent=2,
        )
        sys.stdout.write("\n")
        return 1

    json.dump(lint(args.root), sys.stdout, indent=2, sort_keys=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
