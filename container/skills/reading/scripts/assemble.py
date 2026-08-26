"""assemble — per-chapter extraction JSON -> one validated manifest.

The build pipeline fans chapter extraction out to subagents; each writes one
JSON file into a work directory:

    {"chapter_idx": 3,
     "claims": [{"local_id": "x1", "parent": "root", "order": 0,
                 "rel": "supports", "title": ..., "locator": ...,
                 "block_range": [120, 138], "anchor_block": 122,
                 "anchor_phrase": ..., "body_md": ...}, ...]}

``chapter_idx`` -1 is the book-level overview file; its claims may carry no
locator, block_range, anchor_block or anchor_phrase at all.

Local ids are only unique *within* a file, so assembly namespaces them:
``c-<chapter_idx>-<ordinal>``, or ``o-<ordinal>`` for the overview.  Parent
references are remapped in the same pass, and resolved WITHIN THE FILE that
named them — one chapter may be split across several extraction files and each
of them may legitimately use ``x1``.

Two reports come out of this module and neither of them judges:

  * anchor verification — does each claim's quoted phrase actually appear in
    the block it claims to come from, and does that block sit inside the
    claim's range inside its chapter's range;
  * ``coverage_report`` — where the extraction may have skipped content, and
    which cards are too thin to be worth a card.  ``assemble()`` runs it and
    hands it back as ``report["coverage"]``.

Both are evidence for the reconciliation pass, not a pass/fail gate.

Everything inside an extraction file is LLM output and is treated as such: a
field may be the wrong type, the wrong sign or the wrong shape, and the answer
is always to repair it and say so in the report.  Nothing here aborts a book
over one bad card.

Ranges: a claim's ``block_range`` is [first, last] INCLUSIVE.  A chapter's
``block_start``/``block_end`` is half-open (block_end exclusive), matching
slice.py.

python3 stdlib only.
"""

import collections
import json
import os

import manifest as manifest_mod
import match as match_mod
import slice as slicer

#: Ordinals are zero-padded so ids sort lexically in the order they were made.
ID_PAD = 3

#: A body shorter than this is very likely a theme statement rather than a
#: claim with its reasoning — the depth bar the SKILL.md build doctrine sets.
THIN_BODY_CHARS = 200

#: An uncovered stretch longer than this many consecutive non-empty blocks is
#: the "did we skip something?" signal.
UNCOVERED_RUN_MIN = 3

#: Text living outside the p-blocks and outside the list items — callout boxes,
#: tables, blockquotes.  Past this many characters it is not rounding error and
#: the build must say so rather than drop it quietly.
INVISIBLE_TEXT_WARN_CHARS = 2000

AssembleResult = collections.namedtuple("AssembleResult", "manifest report")


# --------------------------------------------------------------------------
# ids
# --------------------------------------------------------------------------

def claim_id_for(chapter_idx, ordinal):
    """The namespaced claim id for the *ordinal*-th claim of a chapter."""
    if int(chapter_idx) == manifest_mod.OVERVIEW_IDX:
        return "o-%0*d" % (ID_PAD, ordinal)
    return "c-%s-%0*d" % (chapter_idx, ID_PAD, ordinal)


def _key(source_file, local_id):
    """The id-map key for a local id.

    Keyed by FILE, not by chapter: the extraction contract only promises local
    ids are unique within one file, so a chapter fanned out over two files may
    have an ``x1`` in each and neither may capture the other's children.
    """
    return "%s:%s" % (source_file, local_id)


# --------------------------------------------------------------------------
# reading the work dir
# --------------------------------------------------------------------------

def load_extractions(extraction_dir, failures=None):
    """Every readable ``*.json`` in the work dir, as (filename, payload).

    Files are read in name order so a rerun over the same directory produces
    byte-identical ids.

    A file that cannot be read or parsed is SKIPPED, never raised on: one
    subagent leaving a truncated file behind must not throw away every other
    chapter's work.  Pass a list as *failures* to collect one
    ``{"file", "error"}`` entry per skipped file.
    """
    names = sorted(
        name for name in os.listdir(extraction_dir) if name.lower().endswith(".json")
    )
    payloads = []
    for name in names:
        path = os.path.join(extraction_dir, name)
        try:
            with open(path, "r", encoding="utf-8") as handle:
                payloads.append((name, json.load(handle)))
        except (OSError, ValueError) as exc:
            # ValueError covers json.JSONDecodeError and UnicodeDecodeError.
            if failures is not None:
                failures.append(
                    {"file": name, "error": "%s: %s" % (type(exc).__name__, exc)}
                )
    return payloads


# --------------------------------------------------------------------------
# normalizing untrusted extraction fields
# --------------------------------------------------------------------------

def _repair(report, claim_id, kind, detail):
    report["repairs"].append(
        {"claim_id": claim_id, "kind": kind, "detail": detail}
    )


def _plain_int(value):
    """*value* when it is a real int, else None.  ``True`` is not an int here.

    JSON's ``true`` is a Python bool and a bool is an int, so a block index of
    ``[true, false]`` would otherwise sail through as ``[1, 0]``.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _text_field(raw, field, claim_id, report, repaired=""):
    """One untrusted text field as a str.

    Absent or null is the extraction legitimately omitting an optional field:
    it becomes ``""`` silently.  Any other non-string is content that was lost
    in a shape nothing downstream can render, so it takes *repaired* and says
    so.
    """
    value = raw.get(field)
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    _repair(report, claim_id, field,
            "%s is a %s, not a string; recorded as %r"
            % (field, type(value).__name__, repaired))
    return repaired


def _body_field(raw, claim_id, report):
    """``body_md``, which the extraction sometimes emits as a list of lines.

    A list of strings is a plausible LLM shape carrying the real body, so it is
    joined into paragraphs rather than thrown away.  Anything else falls back
    to the ordinary text rule.
    """
    value = raw.get("body_md")
    if (isinstance(value, (list, tuple)) and value
            and all(isinstance(part, str) for part in value)):
        _repair(report, claim_id, "body_md",
                "body_md is a list of %d strings; joined into paragraphs"
                % len(value))
        return "\n\n".join(value)
    return _text_field(raw, "body_md", claim_id, report)


def normalize_claim(raw, claim_id, chapter_idx, report):
    """Every untrusted field of one extraction claim, repaired and reported.

    Returns the keyword arguments ``manifest.new_claim`` wants — ``title`` and
    ``order`` included.  ``parent`` is deliberately absent: only the caller
    knows the id map of the file this claim came from.

    Never raises.  Every value it returns is a shape ``new_claim`` and
    ``manifest.validate`` accept, so a claim that arrives as
    ``{"block_range": ["bad", 1], "order": "first", "title": ["a", "b"]}``
    costs one card's provenance and three repair lines, not the book.
    """
    is_overview = chapter_idx == manifest_mod.OVERVIEW_IDX

    rel = raw.get("rel") or manifest_mod.REL_DEFAULT
    if rel not in manifest_mod.REL_VOCABULARY:
        _repair(report, claim_id, "rel",
                "rel %r is not in the vocabulary; recorded as %r"
                % (rel, manifest_mod.REL_DEFAULT))
        rel = manifest_mod.REL_DEFAULT

    order = raw.get("order", 0)
    if order is None:
        order = 0                         # an omitted field, spelled null
    if _plain_int(order) is None:
        _repair(report, claim_id, "order",
                "order %r is not a plain integer; recorded as 0" % (order,))
        order = 0

    raw_range = raw.get("block_range")
    start = end = None
    if isinstance(raw_range, (list, tuple)) and len(raw_range) == 2:
        start, end = _plain_int(raw_range[0]), _plain_int(raw_range[1])
        if start is None or end is None:
            start = end = None            # a half-usable range is not usable

    if start is None:
        if is_overview:
            block_range = None            # an overview card cites nothing
            if raw_range is not None:
                _repair(report, claim_id, "block_range",
                        "block_range %r is not a pair of plain integers; the "
                        "overview card records no range" % (raw_range,))
        else:
            _repair(report, claim_id, "block_range",
                    "block_range %r is not a pair of plain integers; recorded "
                    "as [0, 0]" % (raw_range,))
            block_range = [0, 0]
    else:
        if start > end:
            _repair(report, claim_id, "block_range",
                    "block_range [%d, %d] is inverted; swapped" % (start, end))
            start, end = end, start
        if start < 0 or end < 0:
            _repair(report, claim_id, "block_range",
                    "block_range [%d, %d] runs before the first block; clamped "
                    "to [%d, %d]" % (start, end, max(0, start), max(0, end)))
            start, end = max(0, start), max(0, end)
        block_range = [start, end]

    raw_anchor = raw.get("anchor_block")
    anchor_block = _plain_int(raw_anchor)
    if anchor_block is None and raw_anchor is not None:
        _repair(report, claim_id, "anchor_block",
                "anchor_block %r is not a plain integer; discarded"
                % (raw_anchor,))
    if anchor_block is None and block_range is not None:
        anchor_block = block_range[0]

    return {
        "title": _text_field(raw, "title", claim_id, report,
                             repaired="(untitled)"),
        "order": order,
        "rel": rel,
        "locator": _text_field(raw, "locator", claim_id, report),
        "block_range": block_range,
        "anchor_block": anchor_block,
        "anchor_phrase": _text_field(raw, "anchor_phrase", claim_id, report),
        "body_md": _body_field(raw, claim_id, report),
    }


def _break_parent_cycles(claims, report):
    """Cut any parent edge that closes a cycle, reparenting it to root.

    An extraction can name a parent that resolves perfectly well and still
    describe a loop — a card that is its own parent, or ``a -> b -> a``.
    ``manifest.validate`` raises on those, which would discard a whole book's
    work, so the closing edge is cut here and reported instead.
    """
    by_id = dict((claim["id"], claim) for claim in claims)
    for claim in claims:
        walked = set()
        cursor = claim
        while cursor is not None and cursor["parent"] != "root":
            if cursor["id"] in walked:
                _repair(report, cursor["id"], "parent",
                        "parent %r closes a cycle back to %s; reparented to root"
                        % (cursor["parent"], cursor["id"]))
                cursor["parent"] = "root"
                break
            walked.add(cursor["id"])
            cursor = by_id.get(cursor["parent"])


def _sane_source_meta(source_meta, report):
    """Document metadata in a shape ``manifest.validate`` accepts.

    The metadata comes from the Reader API, so it is no more trusted than the
    extraction: a null word count or a category Reader spells its own way must
    not abort a book that assembled fine.
    """
    clean = dict(source_meta or {})
    for field in ("document_id", "title", "author", "fetched_at", "html_sha256"):
        if field in clean and not isinstance(clean[field], str):
            report["warnings"].append(
                "source.%s is a %s, not a string; recorded as empty"
                % (field, type(clean[field]).__name__)
            )
            clean[field] = ""
    if "word_count" in clean:
        count = clean["word_count"]
        if _plain_int(count) is None or count < 0:
            report["warnings"].append(
                "source.word_count %r is not a whole number of words; recorded "
                "as 0" % (count,)
            )
            clean["word_count"] = 0
    if "category" in clean and clean["category"] not in manifest_mod.CATEGORIES:
        report["warnings"].append(
            "source.category %r is not one of %s; recorded as %r"
            % (clean["category"], ", ".join(manifest_mod.CATEGORIES),
               manifest_mod.CATEGORIES[0])
        )
        clean["category"] = manifest_mod.CATEGORIES[0]
    return clean


# --------------------------------------------------------------------------
# assembly
# --------------------------------------------------------------------------

def assemble(slug, source_meta, chapters, extraction_dir, html=None, blocks=None):
    """Build a validated manifest from a directory of extraction files.

    Returns an ``AssembleResult(manifest, report)`` — the manifest is the
    deliverable, the report carries every anchor failure and repair so the
    reconciliation pass can see what the extraction got wrong.  Nothing here
    raises on bad extraction content; it repairs and reports, because a single
    bad anchor must not throw away a book's worth of work.

    *html* / *blocks* default to the slice cache for ``source_meta["document_id"]``.
    When html is available the manifest is BOUND to it —
    ``manifest["source"]["html_sha256"]`` is the sha256 of that exact string —
    so arm/refresh can tell a re-fetched source from the one whose block
    indexes these anchors mean.  No html, no binding: the field stays ``""``.

    ``report["coverage"]`` carries the ``coverage_report`` ledger, or None with
    a warning when there was no source to compute it from.
    """
    report = {
        "slug": slug,
        "files": [],
        "claim_count": 0,
        "anchor_failures": [],
        "repairs": [],
        "warnings": [],
        "id_map": {},
        "manifest_warnings": [],
        "unreadable_files": [],
        "coverage": None,
    }

    payloads = load_extractions(extraction_dir, report["unreadable_files"])
    for failure in report["unreadable_files"]:
        report["warnings"].append(
            "%s: could not be read as extraction JSON (%s); skipped"
            % (failure["file"], failure["error"])
        )
    manifest = manifest_mod.new_manifest(
        slug, _sane_source_meta(source_meta, report), chapters
    )
    chapter_by_idx = dict((c["idx"], c) for c in manifest["chapters"])

    ordinals = {}
    id_map = report["id_map"]
    staged = []          # (chapter_idx, local_id, claim_dict, raw)

    for name, payload in payloads:
        if not isinstance(payload, dict):
            report["warnings"].append("%s: not a JSON object; skipped" % name)
            continue
        chapter_idx = payload.get("chapter_idx")
        if not isinstance(chapter_idx, int) or isinstance(chapter_idx, bool):
            report["warnings"].append(
                "%s: chapter_idx %r is not an integer; skipped" % (name, chapter_idx)
            )
            continue
        raw_claims = payload.get("claims")
        if not isinstance(raw_claims, list):
            report["warnings"].append("%s: claims is not an array; skipped" % name)
            continue
        if (chapter_idx != manifest_mod.OVERVIEW_IDX
                and chapter_idx not in chapter_by_idx):
            report["warnings"].append(
                "%s: chapter_idx %d matches no chapter; its claims will land in the "
                "Unassigned group" % (name, chapter_idx)
            )
        report["files"].append({"file": name, "chapter_idx": chapter_idx,
                                "claims": len(raw_claims)})

        for raw in raw_claims:
            if not isinstance(raw, dict):
                report["warnings"].append("%s: a claim entry is not an object; skipped"
                                          % name)
                continue
            ordinals[chapter_idx] = ordinals.get(chapter_idx, 0) + 1
            claim_id = claim_id_for(chapter_idx, ordinals[chapter_idx])
            local_id = str(raw.get("local_id") or "")
            key = _key(name, local_id)
            if local_id and key in id_map:
                report["warnings"].append(
                    "%s: duplicate local_id %r in this file; the later one keeps its "
                    "own id but parent references resolve to the first"
                    % (name, local_id)
                )
            elif local_id:
                id_map[key] = claim_id
            staged.append((chapter_idx, local_id, claim_id, raw, name))

    claims = []
    for chapter_idx, _local_id, claim_id, raw, name in staged:
        parent_raw = raw.get("parent") or "root"
        if parent_raw == "root":
            parent = "root"
        else:
            # within this file only — another file's x1 is another claim
            parent = id_map.get(_key(name, str(parent_raw)))
            if parent is None:
                parent = "root"
                _repair(report, claim_id, "parent",
                        "parent %r resolves to no claim in %s; reparented to root"
                        % (parent_raw, name))

        fields = normalize_claim(raw, claim_id, chapter_idx, report)
        claims.append(manifest_mod.new_claim(
            claim_id,
            fields.pop("title"),
            chapter_idx,
            parent,
            fields.pop("order"),
            **fields
        ))

    _break_parent_cycles(claims, report)

    if html is None or blocks is None:
        doc_id = (source_meta or {}).get("document_id")
        if doc_id:
            if html is None:
                html = slicer.load_source(doc_id)
            if blocks is None:
                blocks = slicer.load_blocks(doc_id)

    # Bind the manifest to the html these anchors were verified against before
    # validating it, so what gets validated is what gets saved.
    if html is not None:
        manifest["source"]["html_sha256"] = slicer.sha256_text(html)
    elif not isinstance(manifest["source"].get("html_sha256"), str):
        manifest["source"]["html_sha256"] = ""

    manifest["claims"] = claims
    report["claim_count"] = len(claims)
    report["manifest_warnings"] = manifest_mod.validate(manifest)

    if html is None or blocks is None:
        report["warnings"].append(
            "source html is not cached; anchor phrases were not verified"
        )
        report["coverage"] = None
        report["warnings"].append(
            "coverage could not be computed: the source html and blocks are "
            "not available"
        )
    else:
        items = slicer.inter_block_items(html, blocks)
        report["anchor_failures"] = verify_anchors(manifest, html, blocks, items=items)
        report["coverage"] = coverage_report(
            manifest, blocks, manifest["chapters"], html=html, items=items
        )

    return AssembleResult(manifest, report)


# --------------------------------------------------------------------------
# anchor verification
# --------------------------------------------------------------------------

def verify_anchors(manifest, html, blocks, items=None):
    """Check every claim's anchor against the cached source.

    Three questions per anchored claim, all of which the extraction can get
    wrong in ways nothing downstream would notice until arm time produces a
    highlight on the wrong paragraph:

      * is the anchor block inside the claim's own block range?
      * is that range inside the claim's chapter's range?
      * does the anchor phrase actually occur in that block's text?

    The phrase compare is whitespace-normalized (block text has already been
    collapsed) but case-SENSITIVE: a case difference means the extraction
    paraphrased rather than quoted, which is exactly what the cite line
    promises it did not do.

    The third question also searches the inter-block list items attributed to
    the anchor block, because ``slice.chapter_text`` shows those items under
    that block's ``[NNNN]`` id and tells extraction to cite them there.  A
    phrase found ONLY in an item is reported as ``anchor_in_list_item``: the
    quote is real, but arming it would highlight the whole ``<p>``, which does
    not contain that text — verified, and not armable.  The pre-block "front
    matter" items — keyed -1, because nothing precedes them — count as items of
    the FIRST block, which is the block ``chapter_text`` tells extraction to
    cite for them.  Pass *items* to reuse a mapping already computed; by default
    it is derived from *html*.

    Returns a list of failure dicts; never raises.
    """
    if items is None:
        items = slicer.inter_block_items(html, blocks)
    failures = []
    chapter_by_idx = dict(
        (c["idx"], c) for c in manifest.get("chapters", [])
    )
    total_blocks = len(blocks)

    for claim in manifest.get("claims", []):
        anchor_block = claim.get("anchor_block")
        block_range = claim.get("block_range")
        phrase = claim.get("anchor_phrase") or ""
        if anchor_block is None and block_range is None and not phrase:
            continue                      # an overview card cites nothing

        claim_id = claim["id"]
        chapter_idx = claim.get("chapter_idx")
        chapter = chapter_by_idx.get(chapter_idx)

        if block_range is not None and chapter is not None:
            if (block_range[0] < chapter["block_start"]
                    or block_range[1] >= chapter["block_end"]):
                failures.append({
                    "claim_id": claim_id,
                    "kind": "range_outside_chapter",
                    "detail": "block_range [%d, %d] is not inside chapter %s "
                              "[%d, %d)" % (block_range[0], block_range[1],
                                            chapter_idx, chapter["block_start"],
                                            chapter["block_end"]),
                })

        if anchor_block is None:
            if phrase:
                failures.append({
                    "claim_id": claim_id,
                    "kind": "no_anchor_block",
                    "detail": "an anchor phrase is quoted but no anchor_block says "
                              "where it came from",
                })
            continue

        if block_range is not None and not (
                block_range[0] <= anchor_block <= block_range[1]):
            failures.append({
                "claim_id": claim_id,
                "kind": "anchor_outside_range",
                "detail": "anchor_block %d is outside block_range [%d, %d]"
                          % (anchor_block, block_range[0], block_range[1]),
            })

        if not 0 <= anchor_block < total_blocks:
            failures.append({
                "claim_id": claim_id,
                "kind": "anchor_out_of_bounds",
                "detail": "anchor_block %d does not exist (%d blocks in the source)"
                          % (anchor_block, total_blocks),
            })
            continue

        if not phrase:
            failures.append({
                "claim_id": claim_id,
                "kind": "no_anchor_phrase",
                "detail": "anchor_block %d is named but no phrase is quoted from it"
                          % anchor_block,
            })
            continue

        block = blocks[anchor_block]
        haystack = match_mod.normalize(slicer.block_text(html, block))
        needle = match_mod.normalize(phrase)
        if needle in haystack:
            continue
        candidates = list(items.get(block["i"], ()))
        # Items sitting ABOVE the first p-block have no preceding paragraph, so
        # ``inter_block_items`` keys them -1 — but ``slice.chapter_text`` renders
        # them at the top of the first chapter under a label naming the first
        # block as the one to cite.  Extraction that followed that instruction
        # quotes an item block 0's own text does not contain, and would be
        # reported as a phrase that simply is not there.  It is the same verified
        # -but-not-armable case as any other list item.
        if blocks and block["i"] == blocks[0]["i"]:
            candidates.extend(items.get(-1, ()))
        if any(needle in match_mod.normalize(item) for item in candidates):
            failures.append({
                "claim_id": claim_id,
                "kind": "anchor_in_list_item",
                "detail": "anchor phrase %r comes from a list item under block "
                          "%d, not from the block itself; the quote is verified "
                          "but cannot be armed as a highlight"
                          % (phrase, anchor_block),
            })
            continue
        failures.append({
            "claim_id": claim_id,
            "kind": "phrase_not_in_block",
            "detail": "anchor phrase %r does not occur in block %d"
                      % (phrase, anchor_block),
        })

    return failures


# --------------------------------------------------------------------------
# coverage
# --------------------------------------------------------------------------

def _nonempty_flags(blocks, html, items=None):
    """Per-block "has content", or all-True when there is no html.

    Content is the block's own text OR any non-empty list item attributed to
    it.  An empty spacer paragraph that owns a real list is content: extraction
    was shown those items under its ``[NNNN]`` id, the gap audit deliberately
    skips ``li`` text, so leaving it out of the denominator lets a chapter
    report 100% coverage while the whole list went missing.
    """
    if html is None:
        return [True] * len(blocks)
    if items is None:
        items = slicer.inter_block_items(html, blocks)
    flags = []
    for block in blocks:
        has_content = bool(slicer.block_text(html, block).strip())
        if not has_content:
            has_content = any(
                item.strip() for item in items.get(block["i"], ())
            )
        flags.append(has_content)
    return flags


def coverage_report(manifest, blocks, chapters, html=None, items=None):
    """Per-chapter evidence about what the extraction may have missed.

    Pure data, no judgement: it says a stretch of the source has no card and
    a card is short, never that either is wrong.

    Pass *html* to have empty blocks (spacers, image-only paragraphs) excluded
    from the arithmetic; without it every block counts as content, which
    understates coverage rather than overstating it.  A block that renders
    empty but owns list items still counts — see ``_nonempty_flags``.  Pass
    *items* to reuse an inter-block item mapping already computed.

    Returns a list of per-chapter dicts in chapter order, plus a trailing
    entry for the overview group (chapter_idx -1) when overview claims exist,
    and — when *html* is available — a trailing ``gap_audit`` entry naming the
    text that lives outside the p-blocks entirely (tables, callouts,
    blockquotes) which no amount of per-chapter coverage would reveal.
    """
    nonempty = _nonempty_flags(blocks, html, items=items)
    total_blocks = len(blocks)

    live = manifest_mod.live_claims(manifest)
    by_chapter = {}
    for claim in live:
        by_chapter.setdefault(claim.get("chapter_idx"), []).append(claim)

    rows = []
    for chapter in sorted(chapters, key=lambda c: c.get("idx", 0)):
        idx = chapter.get("idx", 0)
        start = chapter.get("block_start", 0)
        end = chapter.get("block_end", 0)
        chapter_claims = by_chapter.get(idx, [])

        covered = set()
        for claim in chapter_claims:
            block_range = claim.get("block_range")
            if not block_range:
                continue
            low = max(start, block_range[0])
            high = min(end - 1, block_range[1])
            for index in range(low, high + 1):
                covered.add(index)

        content = [
            i for i in range(start, min(end, total_blocks)) if nonempty[i]
        ]
        covered_content = [i for i in content if i in covered]

        runs = []
        current = []
        for index in content:
            if index in covered:
                if len(current) > UNCOVERED_RUN_MIN:
                    runs.append(current)
                current = []
            else:
                current.append(index)
        if len(current) > UNCOVERED_RUN_MIN:
            runs.append(current)

        rows.append({
            "chapter_idx": idx,
            "title": chapter.get("title", ""),
            "block_start": start,
            "block_end": end,
            "claim_count": len(chapter_claims),
            "content_blocks": len(content),
            "covered_blocks": len(covered_content),
            "coverage_pct": round(
                100.0 * len(covered_content) / len(content), 1
            ) if content else 0.0,
            "uncovered_runs": [
                {"start": run[0], "end": run[-1], "blocks": len(run)} for run in runs
            ],
            "thin_claims": _thin_claims(chapter_claims),
        })

    overview_claims = by_chapter.get(manifest_mod.OVERVIEW_IDX, [])
    if overview_claims:
        rows.append({
            "chapter_idx": manifest_mod.OVERVIEW_IDX,
            "title": "Overview",
            "block_start": None,
            "block_end": None,
            "claim_count": len(overview_claims),
            "content_blocks": 0,
            "covered_blocks": 0,
            "coverage_pct": None,
            "uncovered_runs": [],
            "thin_claims": _thin_claims(overview_claims),
        })

    if html is not None:
        audit = slicer.gap_text_audit(html, blocks)
        warnings = []
        if audit["total_chars"] > INVISIBLE_TEXT_WARN_CHARS:
            tags = sorted(
                audit["by_tag"], key=lambda k: (-audit["by_tag"][k], k)
            )
            warnings.append(
                "%d characters of text sit outside the p-blocks and outside the "
                "list items, so extraction never saw them. Largest contributors: "
                "%s. Check these before claiming comprehensive coverage."
                % (
                    audit["total_chars"],
                    ", ".join(
                        "%s (%d chars)" % (tag, audit["by_tag"][tag])
                        for tag in tags[:5]
                    ),
                )
            )
        rows.append({
            "chapter_idx": None,
            "title": "Gap audit",
            "gap_audit": audit,
            "warnings": warnings,
        })
    return rows


def _thin_claims(claims):
    thin = []
    for claim in claims:
        body = (claim.get("body_md") or "").strip()
        if len(body) < THIN_BODY_CHARS:
            thin.append({"id": claim["id"], "body_chars": len(body)})
    return thin
