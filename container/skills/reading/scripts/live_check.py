#!/usr/bin/env python3
"""Live smoke check: fetch the pilot document, cache it, slice it, print stats.

Refuses to run unless ``RUN_LIVE=1`` — it makes real network calls. It is NOT
part of the unittest suite and it never creates a highlight.

    RUN_LIVE=1 python3 scripts/live_check.py            # fetch + cache + slice
    RUN_LIVE=1 python3 scripts/live_check.py --cached   # slice the cache only
    RUN_LIVE=1 python3 scripts/live_check.py --doc <id>

python3 stdlib ONLY. Never prints a token.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import readerapi  # noqa: E402
import slice as slicer  # noqa: E402

PILOT_DOC_ID = "01m0x3mrxm5r08y1fsxsccksn7"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--doc", default=PILOT_DOC_ID, help="Reader document id")
    parser.add_argument(
        "--cached", action="store_true",
        help="use the cached source.html instead of fetching",
    )
    parser.add_argument(
        "--chapter", type=int, default=None,
        help="also print the first 800 chars of this chapter's text",
    )
    args = parser.parse_args(argv)

    if os.environ.get("RUN_LIVE") != "1":
        print("live_check refuses to run without RUN_LIVE=1 (it hits the network).")
        return 2

    doc_id = args.doc
    title = None

    if args.cached:
        html = slicer.load_source(doc_id)
        if html is None:
            print("No cached source for %s — rerun without --cached." % doc_id)
            return 1
        meta = slicer.load_meta(doc_id) or {}
        title = meta.get("title")
        print("source: cache %s" % slicer.cache_dir(doc_id, create=False))
    else:
        print("fetching document %s ..." % doc_id)
        document = readerapi.get_document(doc_id, with_html=True)
        if document is None:
            print("Document %s not found." % doc_id)
            return 1
        html = document.get("html_content") or ""
        title = document.get("title")
        if not html:
            print("Document %s returned no html_content." % doc_id)
            return 1
        meta = slicer.save_source(
            doc_id, html,
            extra_meta={
                "title": title,
                "author": document.get("author"),
                "category": document.get("category"),
                "source_url": document.get("source_url"),
            },
        )
        print("cached to %s (sha256 %s)" % (slicer.cache_dir(doc_id), meta["sha256"][:16]))

    blocks = slicer.slice_blocks(html)
    chapter_list = slicer.chapters(html, blocks)

    print("")
    print("title        : %s" % (title or "(unknown)"))
    print("format       : %s" % slicer.detect_format(html))
    print("html chars   : %d" % len(html))
    print("blocks       : %d" % len(blocks))
    print("chapters     : %d" % len(chapter_list))
    if blocks:
        first = slicer.block_html(html, blocks[0])
        print("first block  : %s" % (first[:120].replace("\n", "\\n")))
        covered = sum(c["block_end"] - c["block_start"] for c in chapter_list)
        print("blocks covered by chapters: %d / %d" % (covered, len(blocks)))
    print("")
    for chapter in chapter_list:
        print(
            "  [%3d] %-58s blocks %d..%d (%d)"
            % (
                chapter["idx"],
                chapter["title"][:58],
                chapter["block_start"],
                chapter["block_end"] - 1,
                chapter["block_end"] - chapter["block_start"],
            )
        )

    if args.chapter is not None:
        match = [c for c in chapter_list if c["idx"] == args.chapter]
        if not match:
            print("\nNo chapter with idx %d." % args.chapter)
            return 1
        text = slicer.chapter_text(html, blocks, match[0])
        print("\n--- chapter %d text (first 800 chars of %d) ---"
              % (args.chapter, len(text)))
        print(text[:800])
    return 0


if __name__ == "__main__":
    sys.exit(main())
