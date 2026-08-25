#!/usr/bin/env python3
"""Live probe: what shape does a Reader highlight object actually have?

``refresh.py`` codes against a normalized accessor rather than a guessed field
name.  This script is how that accessor gets checked against reality: it dumps
the key set and a truncated sample of every highlight on a document.

Refuses to run without ``RUN_LIVE=1`` — it makes real network calls.  It is NOT
part of the unittest suite, it never creates or deletes anything, and it never
prints a token.

    RUN_LIVE=1 python3 scripts/live_dump_highlights.py --doc <id>
    RUN_LIVE=1 python3 scripts/live_dump_highlights.py --doc <id> --raw

python3 stdlib ONLY.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import readerapi  # noqa: E402
import refresh as refresh_mod  # noqa: E402

PILOT_DOC_ID = "01m0x3mrxm5r08y1fsxsccksn7"

TRUNCATE = 90


def _clip(value):
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    text = text.replace("\n", "\\n")
    return text if len(text) <= TRUNCATE else text[:TRUNCATE] + "…"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--doc", default=PILOT_DOC_ID, help="Reader document id")
    parser.add_argument("--raw", action="store_true",
                        help="also print the full decoded payload as JSON")
    args = parser.parse_args(argv)

    if os.environ.get("RUN_LIVE") != "1":
        print("live_dump_highlights refuses to run without RUN_LIVE=1 "
              "(it hits the network).")
        return 2

    payload = readerapi.get_document_highlights(args.doc)
    print("payload type : %s" % type(payload).__name__)
    if isinstance(payload, dict):
        print("payload keys : %s" % ", ".join(sorted(payload.keys())))

    items = refresh_mod.as_highlight_list(payload)
    print("highlights   : %d" % len(items))
    if not items:
        print("")
        print("Nothing came back in a recognised shape. Rerun with --raw and widen "
              "refresh._LIST_KEYS if the envelope key is new.")
        if args.raw:
            print(json.dumps(payload, ensure_ascii=False, indent=2)[:8000])
        return 1

    key_union = set()
    for item in items:
        key_union.update(item.keys())
    print("field union  : %s" % ", ".join(sorted(key_union)))
    print("")

    for position, item in enumerate(items):
        view = refresh_mod.highlight_view(item)
        print("[%d] keys: %s" % (position, ", ".join(sorted(item.keys()))))
        print("    reader_id : %s" % view["reader_id"])
        print("    text      : %s" % _clip(view["text"]))
        print("    note      : %s" % _clip(view["note"]))
        print("    tags      : %s  (machine=%s)"
              % (view["tags"], refresh_mod.is_machine_highlight(view)))
        print("    url       : %s" % view["url"])
        missing = [k for k in ("reader_id", "text") if not view[k]]
        if missing:
            print("    !! accessor found nothing for: %s" % ", ".join(missing))
        print("")

    if args.raw:
        print("--- raw payload ---")
        print(json.dumps(payload, ensure_ascii=False, indent=2)[:16000])
    return 0


if __name__ == "__main__":
    sys.exit(main())
