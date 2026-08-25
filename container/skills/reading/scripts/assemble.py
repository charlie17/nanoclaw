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
references are remapped in the same pass.

Two reports come out of this module and neither of them judges:

  * anchor verification — does each claim's quoted phrase actually appear in
    the block it claims to come from, and does that block sit inside the
    claim's range inside its chapter's range;
  * ``coverage_report`` — where the extraction may have skipped content, and
    which cards are too thin to be worth a card.

Both are evidence for the reconciliation pass, not a pass/fail gate.

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


def _key(chapter_idx, local_id):
    return "%s:%s" % (chapter_idx, local_id)


# --------------------------------------------------------------------------
# reading the work dir
# --------------------------------------------------------------------------

def load_extractions(extraction_dir):
    """Every ``*.json`` in the work dir, as (filename, payload), name-sorted.

    Files are read in name order so a rerun over the same directory produces
    byte-identical ids.
    """
    names = sorted(
        name for name in os.listdir(extraction_dir) if name.lower().endswith(".json")
    )
    payloads = []
    for name in names:
        path = os.path.join(extraction_dir, name)
        with open(path, "r", encoding="utf-8") as handle:
            payloads.append((name, json.load(handle)))
    return payloads


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
    }

    payloads = load_extractions(extraction_dir)
    manifest = manifest_mod.new_manifest(slug, source_meta, chapters)
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
            key = _key(chapter_idx, local_id)
            if local_id and key in id_map:
                report["warnings"].append(
                    "%s: duplicate local_id %r in chapter %s; the later one keeps its "
                    "own id but parent references resolve to the first"
                    % (name, local_id, chapter_idx)
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
            parent = id_map.get(_key(chapter_idx, str(parent_raw)))
            if parent is None:
                parent = "root"
                report["repairs"].append({
                    "claim_id": claim_id,
                    "kind": "parent",
                    "detail": "parent %r resolves to no claim in %s; reparented to root"
                              % (parent_raw, name),
                })

        rel = raw.get("rel") or manifest_mod.REL_DEFAULT
        if rel not in manifest_mod.REL_VOCABULARY:
            report["repairs"].append({
                "claim_id": claim_id,
                "kind": "rel",
                "detail": "rel %r is not in the vocabulary; recorded as %r"
                          % (rel, manifest_mod.REL_DEFAULT),
            })
            rel = manifest_mod.REL_DEFAULT

        block_range = raw.get("block_range")
        if isinstance(block_range, (list, tuple)) and len(block_range) == 2:
            start, end = int(block_range[0]), int(block_range[1])
            if start > end:
                report["repairs"].append({
                    "claim_id": claim_id,
                    "kind": "block_range",
                    "detail": "block_range [%d, %d] is inverted; swapped" % (start, end),
                })
                start, end = end, start
            block_range = [max(0, start), max(0, end)]
        elif chapter_idx == manifest_mod.OVERVIEW_IDX:
            block_range = None
        else:
            report["repairs"].append({
                "claim_id": claim_id,
                "kind": "block_range",
                "detail": "no usable block_range in the extraction; recorded as [0, 0]",
            })
            block_range = [0, 0]

        anchor_block = raw.get("anchor_block")
        if isinstance(anchor_block, bool) or not isinstance(anchor_block, int):
            anchor_block = None
        if anchor_block is None and block_range is not None:
            anchor_block = block_range[0]

        claims.append(manifest_mod.new_claim(
            claim_id,
            raw.get("title") or "",
            chapter_idx,
            parent,
            raw.get("order", 0) or 0,
            rel=rel,
            locator=raw.get("locator") or "",
            block_range=block_range,
            anchor_block=anchor_block,
            anchor_phrase=raw.get("anchor_phrase") or "",
            body_md=raw.get("body_md") or "",
        ))

    manifest["claims"] = claims
    report["claim_count"] = len(claims)
    report["manifest_warnings"] = manifest_mod.validate(manifest)

    if html is None or blocks is None:
        doc_id = (source_meta or {}).get("document_id")
        if doc_id:
            if html is None:
                html = slicer.load_source(doc_id)
            if blocks is None:
                blocks = slicer.load_blocks(doc_id)
    if html is None or blocks is None:
        report["warnings"].append(
            "source html is not cached; anchor phrases were not verified"
        )
    else:
        report["anchor_failures"] = verify_anchors(manifest, html, blocks)

    return AssembleResult(manifest, report)


# --------------------------------------------------------------------------
# anchor verification
# --------------------------------------------------------------------------

def verify_anchors(manifest, html, blocks):
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

    Returns a list of failure dicts; never raises.
    """
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

        haystack = match_mod.normalize(slicer.block_text(html, blocks[anchor_block]))
        needle = match_mod.normalize(phrase)
        if needle not in haystack:
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

def _nonempty_flags(blocks, html):
    """Per-block "has readable text", or all-True when there is no html."""
    if html is None:
        return [True] * len(blocks)
    return [bool(slicer.block_text(html, block).strip()) for block in blocks]


def coverage_report(manifest, blocks, chapters, html=None):
    """Per-chapter evidence about what the extraction may have missed.

    Pure data, no judgement: it says a stretch of the source has no card and
    a card is short, never that either is wrong.

    Pass *html* to have empty blocks (spacers, image-only paragraphs) excluded
    from the arithmetic; without it every block counts as content, which
    understates coverage rather than overstating it.

    Returns a list of per-chapter dicts in chapter order, plus a trailing
    entry for the overview group (chapter_idx -1) when overview claims exist,
    and — when *html* is available — a trailing ``gap_audit`` entry naming the
    text that lives outside the p-blocks entirely (tables, callouts,
    blockquotes) which no amount of per-chapter coverage would reveal.
    """
    nonempty = _nonempty_flags(blocks, html)
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
