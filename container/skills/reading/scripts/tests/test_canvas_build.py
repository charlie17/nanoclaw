"""Tests for canvas_build.py — determinism, layout, colors, geometry keeping."""

import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import canvas_build as cb  # noqa: E402
import manifest as M  # noqa: E402
from validate import validate_canvas  # noqa: E402

SLUG = "control-your-retirement-destiny"

LOREM = (
    "The author argues that the retirement decision is not a single number but a "
    "sequence of cash flows, each of which has to be sourced from an account with "
    "its own tax treatment, and that treating it as a lump sum obscures the "
    "sequencing problem entirely."
)


def small_manifest(with_unmatched=False, with_overview=False):
    # chapter ranges are half-open: block_end is exclusive and equals the next
    # chapter's block_start.
    m = M.new_manifest(
        SLUG,
        {"title": "Control Your Retirement Destiny", "author": "Dana Anspach",
         "category": "epub", "word_count": 91234},
        [{"idx": 0, "title": "Ch 1 — Cash Flow", "block_start": 0, "block_end": 41},
         {"idx": 1, "title": "Ch 2 — Taxes", "block_start": 41, "block_end": 90}],
    )
    m["claims"] = [
        M.new_claim("c-0001", "Retirement is a cash-flow problem", 0, "root", 0,
                    locator="Ch 1", block_range=[2, 9], anchor_block=2,
                    anchor_phrase="cash flow, not a number", body_md=LOREM),
        M.new_claim("c-0002", "Sequence risk dominates early years", 0, "c-0001", 0,
                    locator="Ch 1 §2", block_range=[10, 18], anchor_block=10,
                    anchor_phrase="the order of returns", body_md=LOREM[:120]),
        M.new_claim("c-0003", "A bad first decade is unrecoverable", 0, "c-0001", 1,
                    locator="Ch 1 §3", block_range=[19, 24], anchor_block=19,
                    anchor_phrase="the first ten years", body_md=LOREM[:60]),
        M.new_claim("c-0004", "Tax location beats tax rate", 1, "root", 0,
                    locator="Ch 2", block_range=[45, 60], anchor_block=45,
                    anchor_phrase="which account, not which rate", body_md=LOREM),
    ]
    if with_overview:
        m["claims"].extend([
            M.new_claim("o-0001", "The book's central question", -1, "root", 0,
                        body_md="How do you turn a portfolio into a paycheque?"),
            M.new_claim("o-0002", "The thesis in one line", -1, "root", 1,
                        body_md="Plan the cash flows first; the portfolio follows."),
            M.new_claim("o-0003", "How the argument is built", -1, "root", 2,
                        body_md="Cash flow, then tax, then sequence risk."),
        ])
    if with_unmatched:
        m["unmatched"] = [
            M.new_highlight("hl-9", "https://readwise.io/x/9", "an orphan highlight", "❓"),
        ]
    M.validate(m)
    return m


def branching_manifest():
    """One chapter with six top-level branches of varied weight, depth 3.

    Enough branches for the balancer to have real work to do.
    """
    m = M.new_manifest(
        "branching", {"title": "Branching", "author": "A. Writer"},
        [{"idx": 0, "title": "The Only Chapter", "block_start": 0, "block_end": 200}],
    )
    claims = []
    counter = 0
    for branch in range(6):
        counter += 1
        root_id = "c-%04d" % counter
        claims.append(M.new_claim(
            root_id, "Branch %d" % branch, 0, "root", branch,
            locator="Ch 1 §%d" % branch, block_range=[branch * 10, branch * 10 + 1],
            anchor_block=branch * 10, anchor_phrase="anchor %d" % branch,
            body_md=LOREM[:120 + branch * 40]))
        # varied subtree weight so balancing is not trivially symmetric
        for child in range(1 + branch % 3):
            counter += 1
            child_id = "c-%04d" % counter
            claims.append(M.new_claim(
                child_id, "Branch %d child %d" % (branch, child), 0, root_id, child,
                locator="Ch 1 §%d.%d" % (branch, child),
                block_range=[branch * 10 + child + 1, branch * 10 + child + 2],
                anchor_block=branch * 10 + child + 1, anchor_phrase="a",
                body_md=LOREM[:150]))
            for grand in range(branch % 2):
                counter += 1
                claims.append(M.new_claim(
                    "c-%04d" % counter, "Branch %d leaf %d" % (branch, grand),
                    0, child_id, grand,
                    locator="Ch 1 §%d.%d.%d" % (branch, child, grand),
                    block_range=[branch * 10 + child + 3, branch * 10 + child + 4],
                    anchor_block=branch * 10 + child + 3, anchor_phrase="b",
                    body_md=LOREM[:130]))
    m["claims"] = claims
    M.validate(m)
    return m


def _col_height(nodes):
    return (max(n["y"] + n["height"] for n in nodes)
            - min(n["y"] for n in nodes))


def tall_manifest(leaves=14):
    """One chapter, many leaf claims — a stack that must spill sideways."""
    m = M.new_manifest(
        "tall", {"title": "Tall", "author": "A. Writer"},
        [{"idx": 0, "title": "The Only Chapter", "block_start": 0, "block_end": 200}],
    )
    m["claims"] = [
        M.new_claim("c-%04d" % (i + 1), "Leaf claim number %d" % (i + 1),
                    0, "root", i,
                    locator="Ch 1 §%d" % i, block_range=[i, i + 1], anchor_block=i,
                    anchor_phrase="anchor %d" % i, body_md=LOREM[:300])
        for i in range(leaves)
    ]
    M.validate(m)
    return m


def granular_manifest(total=330, chapters=15):
    """The v3 content shape: ~330 cards, depth <= 2, 650-char bodies."""
    m = M.new_manifest(
        "granular", {"title": "Granular", "author": "A. Writer", "word_count": 90000},
        [{"idx": i, "title": "Chapter %d" % (i + 1),
          "block_start": i * 100, "block_end": (i + 1) * 100,
          "gloss": "What this chapter establishes and why it matters here."}
         for i in range(chapters)],
    )
    claims = []
    counter = 0
    per_chapter = total // chapters
    for chapter in range(chapters):
        parents = []
        for position in range(per_chapter):
            counter += 1
            claim_id = "c-%04d" % counter
            if position % 3 == 0 or not parents:
                parent, depth_parent = "root", None
                parents.append(claim_id)
            else:
                depth_parent = parents[-1]
                parent = depth_parent
            claims.append(M.new_claim(
                claim_id, "Claim %d on the sequencing problem" % counter,
                chapter, parent, position,
                locator="Ch %d §%d" % (chapter + 1, position),
                block_range=[chapter * 100 + position, chapter * 100 + position + 1],
                anchor_block=chapter * 100 + position,
                anchor_phrase=LOREM[position % 40:position % 40 + 25],
                body_md="\n\n".join([LOREM[:210], LOREM[40:250], LOREM[80:290]]),
            ))
    m["claims"] = claims
    M.validate(m)
    return m


def wide_family_manifest(kids=5):
    """One section with *kids* nominal-height children — tunes the run height."""
    m = M.new_manifest(
        "family", {"title": "Family", "author": "A. Writer"},
        [{"idx": 0, "title": "The Only Chapter", "block_start": 0, "block_end": 200}],
    )
    claims = [M.new_claim("c-0001", "The section claim", 0, "root", 0,
                          locator="Ch 1", block_range=[0, 1], anchor_block=0,
                          anchor_phrase="section", body_md=LOREM[:200])]
    for index in range(kids):
        claims.append(M.new_claim(
            "c-%04d" % (index + 2), "Supporting claim %d" % (index + 1),
            0, "c-0001", index,
            locator="Ch 1 §%d" % index, block_range=[index + 1, index + 2],
            anchor_block=index + 1, anchor_phrase="a", body_md=LOREM[:200]))
    m["claims"] = claims
    M.validate(m)
    return m


def mixed_sections_manifest():
    """Sections sized so sequential banding strands a leaf in its own band.

    Each wing ends up with spans [medium, huge, leaf].  Sequential closes the
    medium band when the huge one will not fit, then cannot fit the leaf into
    the huge band either — three bands.  Compact drops the leaf back into the
    medium band, which had room all along — two bands, one column saved.
    """
    m = M.new_manifest(
        "mixed", {"title": "Mixed", "author": "A. Writer"},
        [{"idx": 0, "title": "The Only Chapter", "block_start": 0, "block_end": 400}],
    )
    claims = []
    counter = 0
    # kid counts per section, in book order, repeated once per wing
    for order, kids in enumerate([3, 5, 0, 3, 5, 0]):
        counter += 1
        section = "c-%04d" % counter
        claims.append(M.new_claim(
            section, "Section %d" % order, 0, "root", order,
            locator="Ch 1 §%d" % order,
            block_range=[order * 20, order * 20 + 1], anchor_block=order * 20,
            anchor_phrase="a", body_md=LOREM[:200]))
        for kid in range(kids):
            counter += 1
            claims.append(M.new_claim(
                "c-%04d" % counter, "Support %d.%d" % (order, kid), 0, section, kid,
                locator="Ch 1 §%d.%d" % (order, kid),
                block_range=[order * 20 + kid + 1, order * 20 + kid + 2],
                anchor_block=order * 20 + kid + 1, anchor_phrase="b",
                body_md=LOREM[:200]))
    m["claims"] = claims
    M.validate(m)
    return m


def front_matter_manifest():
    """A real book's chapter list: front and back matter carry no claims."""
    m = M.new_manifest(
        "frontmatter", {"title": "Front Matter", "author": "A. Writer"},
        [{"idx": 0, "title": "Disclosures", "block_start": 0, "block_end": 5},
         {"idx": 1, "title": "Dedication", "block_start": 5, "block_end": 8},
         {"idx": 2, "title": "Ch 1 — Cash Flow", "block_start": 8, "block_end": 60},
         {"idx": 3, "title": "Ch 2 — Taxes", "block_start": 60, "block_end": 110},
         {"idx": 4, "title": "About the Author", "block_start": 110, "block_end": 115},
         {"idx": 5, "title": "Index", "block_start": 115, "block_end": 130}],
    )
    m["claims"] = [
        M.new_claim("c-0001", "Retirement is a cash-flow problem", 2, "root", 0,
                    locator="Ch 1", block_range=[9, 12], anchor_block=9,
                    anchor_phrase="cash flow", body_md=LOREM[:200]),
        M.new_claim("c-0002", "Tax location beats tax rate", 3, "root", 0,
                    locator="Ch 2", block_range=[61, 64], anchor_block=61,
                    anchor_phrase="which account", body_md=LOREM[:200]),
    ]
    M.validate(m)
    return m


def nodes_by_id(canvas):
    return dict((n["id"], n) for n in canvas["nodes"])


def toc_ids(m):
    return set(cb.node_id(m["slug"], cb.toc_key(c["idx"])) for c in m["chapters"])


def map_nodes(m, canvas):
    """Everything except the heatmap table of contents."""
    skip = toc_ids(m) | {cb.node_id(m["slug"], cb.TOC_GROUP_KEY)}
    return [n for n in canvas["nodes"] if n["id"] not in skip]


def chapter_extents(m, canvas):
    """Per-chapter bounding boxes, derived from the hub and its member cards.

    v2 emits no group boxes — whitespace separates chapters — so a chapter's
    extent has to be measured from the cards that belong to it.
    """
    by_id = nodes_by_id(canvas)
    slug = m["slug"]
    out = []
    for chapter in sorted(m["chapters"], key=lambda c: c["idx"]):
        idx = chapter["idx"]
        hub = by_id.get(cb.node_id(slug, cb.hub_key(idx)))
        if hub is None:
            continue
        members = [hub]
        for claim in m["claims"]:
            if claim["chapter_idx"] == idx and not claim["jt"]["pruned"]:
                node = by_id.get(cb.claim_node_id(slug, claim["id"]))
                if node is not None:
                    members.append(node)
        out.append({
            "idx": idx,
            "label": chapter["title"],
            "hub": hub,
            "members": members,
            "x0": min(n["x"] for n in members),
            "x1": max(n["x"] + n["width"] for n in members),
            "y0": min(n["y"] for n in members),
            "y1": max(n["y"] + n["height"] for n in members),
        })
    return out


def overview_extent(m, canvas):
    """Bounding box of the far-left cluster: root card plus overview claims."""
    by_id = nodes_by_id(canvas)
    slug = m["slug"]
    members = [by_id[cb.node_id(slug, "root")]]
    for claim in m["claims"]:
        if claim["chapter_idx"] == -1 and not claim["jt"]["pruned"]:
            node = by_id.get(cb.claim_node_id(slug, claim["id"]))
            if node is not None:
                members.append(node)
    return {
        "members": members,
        "x0": min(n["x"] for n in members),
        "x1": max(n["x"] + n["width"] for n in members),
        "y0": min(n["y"] for n in members),
        "y1": max(n["y"] + n["height"] for n in members),
    }


def big_manifest(claim_count=60, chapters=3):
    """3 overview cards + 3 chapters, depth 3, varied bodies — the stress case."""
    m = M.new_manifest(
        "stress-source",
        {"title": "Stress Source", "author": "A. Writer", "word_count": 120000},
        # half-open, contiguous: [0,100) [100,200) [200,300)
        [{"idx": i, "title": "Chapter %d" % (i + 1), "block_start": i * 100,
          "block_end": (i + 1) * 100} for i in range(chapters)],
    )
    claims = [
        M.new_claim("o-0001", "Central question", -1, "root", 0,
                    body_md="What the book is trying to answer. " + LOREM),
        M.new_claim("o-0002", "Thesis", -1, "root", 1,
                    rel="consequence", body_md="The one-line answer. " + LOREM * 2),
        M.new_claim("o-0003", "Shape of the argument", -1, "root", 2,
                    body_md="How the chapters build on each other."),
    ]
    per_chapter = claim_count // chapters
    counter = 0
    for chapter in range(chapters):
        chapter_ids = []
        for position in range(per_chapter):
            counter += 1
            claim_id = "c-%04d" % counter
            # depth: 0, 1, 2 cycling so every chapter grows a 3-deep tree
            if position == 0:
                parent, order = "root", 0
            elif position % 5 == 0:
                parent, order = "root", position
            elif position % 3 == 0:
                parent, order = chapter_ids[0], position
            else:
                parent = chapter_ids[min(len(chapter_ids) - 1, position // 3)]
                order = position
            body = LOREM * (1 + (position % 4))
            claims.append(M.new_claim(
                claim_id, "Claim %d — %s" % (counter, LOREM[:20 + (position % 30)]),
                chapter, parent, order,
                locator="Ch %d §%d" % (chapter + 1, position),
                block_range=[chapter * 100 + position, chapter * 100 + position + 1],
                anchor_block=chapter * 100 + position,
                anchor_phrase=LOREM[position % 40:position % 40 + 25],
                body_md=body,
            ))
            chapter_ids.append(claim_id)
    m["claims"] = claims
    M.validate(m)
    return m


class DeterminismTest(unittest.TestCase):
    def test_same_manifest_twice_is_byte_identical(self):
        m = small_manifest(with_unmatched=True)
        first = cb.dumps_canvas(cb.build_canvas(m))
        second = cb.dumps_canvas(cb.build_canvas(m))
        self.assertEqual(first, second)

    def test_identical_after_a_manifest_round_trip(self):
        directory = tempfile.mkdtemp(prefix="dsr-det-")
        self.addCleanup(shutil.rmtree, directory, True)
        m = big_manifest()
        expected = cb.dumps_canvas(cb.build_canvas(m))
        path = os.path.join(directory, "m.json")
        M.save(m, path)
        self.assertEqual(cb.dumps_canvas(cb.build_canvas(M.load(path))), expected)

    def test_node_ids_are_stable_hashes(self):
        m = small_manifest()
        canvas = cb.build_canvas(m)
        ids = [n["id"] for n in canvas["nodes"]]
        self.assertIn(cb.node_id(SLUG, "root"), ids)
        self.assertIn(cb.node_id(SLUG, "legend"), ids)
        self.assertIn(cb.node_id(SLUG, "hub:0"), ids)
        self.assertIn(cb.node_id(SLUG, "c-0002"), ids)
        for ident in ids:
            self.assertEqual(len(ident), 16)
        edge_ids = [e["id"] for e in canvas["edges"]]
        self.assertIn(cb.node_id(SLUG, "edge:c-0002"), edge_ids)
        self.assertNotIn(cb.node_id(SLUG, "edge:hub:0"), edge_ids)

    def test_no_literal_backslash_n_in_written_json(self):
        directory = tempfile.mkdtemp(prefix="dsr-nl-")
        self.addCleanup(shutil.rmtree, directory, True)
        m = small_manifest(with_unmatched=True)
        path = cb.write_canvas(m, cb.build_canvas(m), directory)
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        for node in data["nodes"]:
            self.assertNotIn("\\n", node.get("text", ""))
            self.assertNotIn("\\n", node.get("label", ""))
        # real newlines survived the JSON round trip on a multi-line card
        root = [n for n in data["nodes"] if n["id"] == cb.node_id(SLUG, "root")][0]
        self.assertIn("\n", root["text"])


class GeometryKeepingTest(unittest.TestCase):
    def test_moved_node_position_is_preserved(self):
        m = small_manifest()
        canvas = cb.build_canvas(m)
        target = cb.node_id(SLUG, "c-0002")
        moved = json.loads(json.dumps(canvas))
        for node in moved["nodes"]:
            if node["id"] == target:
                node["x"], node["y"] = -4321, 9876
                node["width"], node["height"] = 500, 300
        rebuilt = cb.build_canvas(m, existing=moved)
        found = [n for n in rebuilt["nodes"] if n["id"] == target][0]
        self.assertEqual((found["x"], found["y"], found["width"], found["height"]),
                         (-4321, 9876, 500, 300))
        # everything else stays where the projection puts it
        original = {n["id"]: (n["x"], n["y"]) for n in canvas["nodes"]}
        for node in rebuilt["nodes"]:
            if node["id"] != target:
                self.assertEqual((node["x"], node["y"]), original[node["id"]])

    def test_existing_geometry_survives_a_text_change(self):
        m = small_manifest()
        canvas = cb.build_canvas(m)
        before = {n["id"]: (n["x"], n["y"], n["width"], n["height"]) for n in canvas["nodes"]}
        m["claims"][0]["body_md"] = LOREM * 5
        rebuilt = cb.build_canvas(m, existing=canvas)
        for node in rebuilt["nodes"]:
            self.assertEqual(
                (node["x"], node["y"], node["width"], node["height"]), before[node["id"]]
            )
        text = [n for n in rebuilt["nodes"] if n["id"] == cb.node_id(SLUG, "c-0001")][0]["text"]
        self.assertIn(LOREM * 5, text)

    def test_alien_nodes_and_edges_are_carried_forward(self):
        m = small_manifest()
        canvas = cb.build_canvas(m)
        alien = {"id": "deadbeefdeadbeef", "type": "text", "text": "JT's own card",
                 "x": -2000, "y": -2000, "width": 300, "height": 200}
        alien_edge = {"id": "feedfacefeedface", "fromNode": alien["id"],
                      "toNode": cb.node_id(SLUG, "c-0001"),
                      "fromSide": "right", "toSide": "left"}
        existing = {"nodes": list(canvas["nodes"]) + [alien],
                    "edges": list(canvas["edges"]) + [alien_edge]}
        rebuilt = cb.build_canvas(m, existing=existing)
        self.assertIn(alien, rebuilt["nodes"])
        self.assertIn(alien_edge, rebuilt["edges"])
        # the projected part is untouched
        projected = [n for n in rebuilt["nodes"] if n["id"] != alien["id"]]
        self.assertEqual(projected, canvas["nodes"])

    def test_alien_edge_is_dropped_when_an_endpoint_is_gone(self):
        m = small_manifest()
        canvas = cb.build_canvas(m)
        orphan_edge = {"id": "0123456789abcdef", "fromNode": "nowhere",
                       "toNode": cb.node_id(SLUG, "c-0001")}
        existing = {"nodes": list(canvas["nodes"]),
                    "edges": list(canvas["edges"]) + [orphan_edge]}
        rebuilt = cb.build_canvas(m, existing=existing)
        self.assertNotIn(orphan_edge, rebuilt["edges"])
        self.assertEqual(validate_canvas(rebuilt), [])


class GeometrySnapshotTest(unittest.TestCase):
    """A refresh must let untouched cards grow while keeping JT's own moves."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="dsr-snap-")
        self.addCleanup(shutil.rmtree, self.dir, True)

    def written(self, m=None):
        """Build + write once, so the manifest carries a geometry snapshot."""
        m = m or small_manifest()
        canvas = cb.build_canvas(m)
        cb.write_canvas(m, canvas, self.dir)
        return m, canvas

    @staticmethod
    def add_overlay(claim):
        """Enough overlay to push the card clear of the nominal 620 height."""
        claim["jt"]["stance"] = "agree"
        claim["jt"]["notes"] = [
            "This is the part that actually changed how I think about the drawdown, "
            "and it is worth coming back to before the next rebalance.",
            "Cross-check against the 2019 spreadsheet before acting on any of it, "
            "because the assumptions there were built for a different tax regime.",
            "Ask the CPA whether the Roth conversion window changes the ordering.",
        ]
        claim["jt"]["highlights"] = [
            M.new_highlight("hl-1", "https://readwise.io/x/1",
                            "the order of returns matters far more than the average "
                            "return over the whole retirement horizon", "✅ exactly this"),
            M.new_highlight("hl-2", "https://readwise.io/x/2",
                            "a bad first decade is not recoverable by saving more "
                            "once the contributions have stopped", ""),
            M.new_highlight("hl-3", "https://readwise.io/x/3",
                            "the sequence of withdrawals is a decision, not an outcome",
                            "worth a second read"),
        ]

    def test_write_records_a_snapshot_of_every_node(self):
        m, canvas = self.written()
        snapshot = m["node_geometry"]
        self.assertEqual(set(snapshot), set(n["id"] for n in canvas["nodes"]))
        for node in canvas["nodes"]:
            self.assertEqual(snapshot[node["id"]],
                             [node["x"], node["y"], node["width"], node["height"]])
        M.validate(m)

    def test_snapshot_is_refreshed_on_every_write(self):
        m, _canvas = self.written()
        first = dict(m["node_geometry"])
        self.add_overlay(m["claims"][2])
        second_canvas = cb.build_canvas(m, existing=cb.read_canvas(
            cb.canvas_path(m, self.dir)))
        cb.write_canvas(m, second_canvas, self.dir)
        target = cb.node_id(SLUG, "c-0003")
        self.assertNotEqual(m["node_geometry"][target], first[target])
        self.assertEqual(m["node_geometry"][target][3],
                         [n for n in second_canvas["nodes"]
                          if n["id"] == target][0]["height"])

    def test_untouched_card_grows_when_overlay_is_folded_in(self):
        m, canvas = self.written()
        target = cb.node_id(SLUG, "c-0003")
        before = [n for n in canvas["nodes"] if n["id"] == target][0]["height"]

        self.add_overlay(m["claims"][2])
        fresh = cb.card_height(cb.card_text(m["claims"][2]))
        self.assertGreater(fresh, before, "fixture must actually grow the card")

        rebuilt = cb.build_canvas(m, existing=json.loads(json.dumps(canvas)))
        after = [n for n in rebuilt["nodes"] if n["id"] == target][0]["height"]
        self.assertEqual(after, fresh)
        self.assertGreater(after, before)
        self.assertIn("✅ Agree",
                      [n for n in rebuilt["nodes"] if n["id"] == target][0]["text"])

    def test_moved_card_keeps_jt_position_but_still_grows(self):
        m, canvas = self.written()
        target = cb.node_id(SLUG, "c-0003")
        working = json.loads(json.dumps(canvas))
        for node in working["nodes"]:
            if node["id"] == target:
                node["x"], node["y"] = -7777, 5555

        self.add_overlay(m["claims"][2])
        rebuilt = cb.build_canvas(m, existing=working)
        node = [n for n in rebuilt["nodes"] if n["id"] == target][0]
        self.assertEqual((node["x"], node["y"]), (-7777, 5555))
        # position is his, size is still allowed to fit the new text
        self.assertEqual(node["height"], cb.card_height(cb.card_text(m["claims"][2])))

    def test_resized_card_keeps_jt_size(self):
        m, canvas = self.written()
        target = cb.node_id(SLUG, "c-0002")
        working = json.loads(json.dumps(canvas))
        for node in working["nodes"]:
            if node["id"] == target:
                node["width"], node["height"] = 620, 900

        self.add_overlay(m["claims"][1])
        rebuilt = cb.build_canvas(m, existing=working)
        node = [n for n in rebuilt["nodes"] if n["id"] == target][0]
        self.assertEqual((node["width"], node["height"]), (620, 900))

    def test_untouched_neighbours_reflow_rather_than_freeze(self):
        m, canvas = self.written()
        before = {n["id"]: (n["x"], n["y"]) for n in canvas["nodes"]}
        self.add_overlay(m["claims"][1])
        rebuilt = cb.build_canvas(m, existing=json.loads(json.dumps(canvas)))
        after = {n["id"]: (n["x"], n["y"]) for n in rebuilt["nodes"]}
        self.assertNotEqual(before, after, "a grown card must be able to reflow the map")
        self.assertEqual(validate_canvas(rebuilt), [])

    def test_new_card_added_since_the_write_is_placed_by_the_projection(self):
        m, canvas = self.written()
        m["claims"].append(M.new_claim(
            "c-0005", "A claim added after the last write", 1, "c-0004", 0,
            locator="Ch 2 §9", block_range=[70, 72], anchor_block=70,
            anchor_phrase="added later", body_md=LOREM[:80]))
        M.validate(m)
        rebuilt = cb.build_canvas(m, existing=json.loads(json.dumps(canvas)))
        fresh = cb.build_canvas(m)
        new_id = cb.node_id(SLUG, "c-0005")
        placed = [n for n in rebuilt["nodes"] if n["id"] == new_id][0]
        expected = [n for n in fresh["nodes"] if n["id"] == new_id][0]
        self.assertEqual((placed["x"], placed["y"]), (expected["x"], expected["y"]))
        self.assertEqual(validate_canvas(rebuilt), [])

    def test_no_snapshot_falls_back_to_keeping_all_geometry(self):
        m, canvas = self.written()
        del m["node_geometry"]          # an older manifest, written before snapshots
        M.validate(m)
        before = {n["id"]: (n["x"], n["y"], n["width"], n["height"])
                  for n in canvas["nodes"]}
        self.add_overlay(m["claims"][2])
        rebuilt = cb.build_canvas(m, existing=json.loads(json.dumps(canvas)))
        for node in rebuilt["nodes"]:
            self.assertEqual(
                (node["x"], node["y"], node["width"], node["height"]),
                before[node["id"]],
                "without a snapshot every known node keeps its geometry",
            )

    def test_alien_carry_forward_is_unaffected_by_snapshots(self):
        m, canvas = self.written()
        alien = {"id": "abcdabcdabcdabcd", "type": "text", "text": "# Mine\n\nkeep me",
                 "x": -3000, "y": -3000, "width": 340, "height": 220}
        working = json.loads(json.dumps(canvas))
        working["nodes"].append(alien)
        self.add_overlay(m["claims"][2])
        rebuilt = cb.build_canvas(m, existing=working)
        self.assertIn(alien, rebuilt["nodes"])

    def test_dragging_a_card_onto_another_does_not_fail_validation_forever(self):
        m, canvas = self.written()
        working = json.loads(json.dumps(canvas))
        victim = [n for n in working["nodes"]
                  if n["id"] == cb.node_id(SLUG, "c-0002")][0]
        dragged_id = cb.node_id(SLUG, "c-0004")
        for node in working["nodes"]:
            if node["id"] == dragged_id:
                node["x"], node["y"] = victim["x"], victim["y"]

        rebuilt = cb.build_canvas(m, existing=working)
        # strict: the overlap he created is a real violation
        strict = validate_canvas(rebuilt)
        self.assertTrue([v for v in strict if v.startswith("overlap:")])
        # with his geometry exempted, the map is clean again
        exempt = cb.jt_geometry_ids(m, working)
        self.assertIn(dragged_id, exempt)
        self.assertEqual(validate_canvas(rebuilt, exempt), [])

    def test_jt_geometry_ids_is_empty_for_an_untouched_canvas(self):
        m, canvas = self.written()
        self.assertEqual(cb.jt_geometry_ids(m, canvas), set())
        self.assertEqual(cb.jt_geometry_ids(m, None), set())

    def test_jt_geometry_ids_includes_alien_cards(self):
        m, canvas = self.written()
        working = json.loads(json.dumps(canvas))
        alien = {"id": "cafecafecafecafe", "type": "text", "text": "# mine",
                 "x": 0, "y": 0, "width": 340, "height": 220}
        working["nodes"].append(alien)
        self.assertEqual(cb.jt_geometry_ids(m, working), {alien["id"]})

    def test_jt_geometry_ids_without_a_snapshot_claims_everything(self):
        m, canvas = self.written()
        del m["node_geometry"]
        self.assertEqual(cb.jt_geometry_ids(m, canvas),
                         set(n["id"] for n in canvas["nodes"]))

    def test_moved_report_uses_the_snapshot_not_a_reflowed_projection(self):
        import canvas_parse as cp
        m, canvas = self.written()
        target = cb.node_id(SLUG, "c-0003")
        working = json.loads(json.dumps(canvas))
        for node in working["nodes"]:
            if node["id"] == target:
                node["x"] += 900
        # a growth elsewhere reflows the projection, but must not look like a move
        self.add_overlay(m["claims"][0])
        overlay = cp.parse_overlay(m, working)
        self.assertEqual(list(overlay["moved"]), [target])


class LayoutTest(unittest.TestCase):
    def test_sixty_claim_map_validates_with_zero_overlaps(self):
        m = big_manifest()
        chapter_claims = [c for c in m["claims"] if c["chapter_idx"] != -1]
        overview = [c for c in m["claims"] if c["chapter_idx"] == -1]
        self.assertEqual(len(chapter_claims), 60)
        self.assertEqual(len(overview), 3)
        canvas = cb.build_canvas(m)
        violations = validate_canvas(canvas)
        self.assertEqual(violations, [], "\n".join(violations))
        overlaps = [v for v in violations if v.startswith("overlap:")]
        self.assertEqual(overlaps, [])
        cards = [n for n in map_nodes(m, canvas) if n["type"] == "text"]
        # 63 claims + root + legend + one hub per chapter, no bin
        self.assertEqual(len(cards), 63 + 2 + 3)
        # the heatmap group is the only group; chapters use whitespace
        self.assertEqual([n["id"] for n in canvas["nodes"] if n["type"] == "group"],
                         [cb.node_id(m["slug"], cb.TOC_GROUP_KEY)])
        self.assertEqual([c["label"] for c in chapter_extents(m, canvas)],
                         ["Chapter 1", "Chapter 2", "Chapter 3"])

    def test_tree_depth_maps_to_x_columns(self):
        m = small_manifest()
        canvas = cb.build_canvas(m)
        by_id = {n["id"]: n for n in canvas["nodes"]}
        parent = by_id[cb.node_id(SLUG, "c-0001")]
        child = by_id[cb.node_id(SLUG, "c-0002")]
        self.assertEqual(child["x"] - parent["x"], cb.COL_PITCH)
        sibling = by_id[cb.node_id(SLUG, "c-0003")]
        self.assertEqual(child["x"], sibling["x"])
        self.assertGreater(sibling["y"], child["y"])

    def test_parent_is_centred_against_its_children(self):
        m = small_manifest()
        canvas = cb.build_canvas(m)
        by_id = {n["id"]: n for n in canvas["nodes"]}
        parent = by_id[cb.node_id(SLUG, "c-0001")]
        child_a = by_id[cb.node_id(SLUG, "c-0002")]
        child_b = by_id[cb.node_id(SLUG, "c-0003")]
        span_mid = (child_a["y"] + (child_b["y"] + child_b["height"])) / 2.0
        parent_mid = parent["y"] + parent["height"] / 2.0
        self.assertLessEqual(abs(span_mid - parent_mid), 1.0)

    def test_every_node_is_a_card_and_chapters_are_named_by_hubs(self):
        m = small_manifest()
        canvas = cb.build_canvas(m)
        self.assertEqual(set(n["type"] for n in map_nodes(m, canvas)), {"text"})
        by_id = nodes_by_id(canvas)
        self.assertEqual(by_id[cb.node_id(SLUG, cb.hub_key(0))]["text"],
                         "# Ch 1 — Cash Flow")
        self.assertEqual(by_id[cb.node_id(SLUG, cb.hub_key(1))]["text"],
                         "# Ch 2 — Taxes")

    def test_each_card_falls_in_exactly_one_chapter_band(self):
        m = big_manifest()
        canvas = cb.build_canvas(m)
        chapters = chapter_extents(m, canvas)
        loose = {cb.node_id(m["slug"], "legend"), cb.node_id(m["slug"], "bin"),
                 cb.node_id(m["slug"], "root")}
        overview_ids = set(cb.claim_node_id(m["slug"], c["id"])
                           for c in m["claims"] if c["chapter_idx"] == -1)
        for card in map_nodes(m, canvas):
            if card["id"] in loose or card["id"] in overview_ids:
                continue
            bands = [c for c in chapters
                     if c["x0"] <= card["x"] and card["x"] + card["width"] <= c["x1"]]
            self.assertEqual(len(bands), 1,
                             "card %s falls in %d chapter bands"
                             % (card["id"], len(bands)))

    def test_card_heights_are_clamped_and_rounded(self):
        m = big_manifest()
        canvas = cb.build_canvas(m)
        for node in map_nodes(m, canvas):
            if node["type"] != "text":
                continue
            self.assertEqual(node["width"], cb.CARD_W)
            self.assertGreaterEqual(node["height"], cb.H_MIN)
            self.assertLessEqual(node["height"], cb.H_MAX)
            self.assertEqual(node["height"] % 10, 0)

    def test_overview_cluster_is_far_left_and_vertically_centred(self):
        m = small_manifest()
        canvas = cb.build_canvas(m)
        by_id = nodes_by_id(canvas)
        root = by_id[cb.node_id(SLUG, "root")]
        legend = by_id[cb.node_id(SLUG, "legend")]
        overview = overview_extent(m, canvas)

        self.assertEqual(root["x"], cb.SIDE_X)
        self.assertEqual(legend["x"], cb.SIDE_X - cb.COL_GAP - cb.CARD_W)

        chapters = chapter_extents(m, canvas)
        for chapter in chapters:
            self.assertGreaterEqual(chapter["x0"], overview["x1"])
        tallest = max(c["y1"] for c in chapters)
        middle = (overview["y0"] + overview["y1"]) / 2.0
        self.assertLessEqual(abs(middle - tallest / 2.0), 2.0)


class HeatmapTocTest(unittest.TestCase):
    """The Heatmap Sections table of contents on the far left."""

    def test_one_card_per_chapter_in_book_order(self):
        m = big_manifest()
        canvas = cb.build_canvas(m)
        by_id = nodes_by_id(canvas)
        cards = [by_id[cb.node_id(m["slug"], cb.toc_key(c["idx"]))]
                 for c in sorted(m["chapters"], key=lambda c: c["idx"])]
        self.assertEqual([c["text"] for c in cards],
                         ["# Chapter 1", "# Chapter 2", "# Chapter 3"])
        # stacked vertically, in order, no overlap
        for earlier, later in zip(cards, cards[1:]):
            self.assertEqual(later["x"], earlier["x"])
            self.assertGreaterEqual(later["y"], earlier["y"] + earlier["height"])

    def test_cards_are_compact_title_only_and_uncoloured(self):
        m = small_manifest()
        canvas = cb.build_canvas(m)
        by_id = nodes_by_id(canvas)
        for chapter in m["chapters"]:
            card = by_id[cb.node_id(SLUG, cb.toc_key(chapter["idx"]))]
            self.assertEqual(card["text"], "# " + chapter["title"])
            self.assertNotIn("gloss", card["text"])
            self.assertNotIn("↳ cite", card["text"])
            self.assertEqual(card["width"], cb.TOC_CARD_W)
            self.assertLess(card["height"], cb.H_MIN)
            self.assertNotIn("color", card)

    def test_group_wraps_the_cards_and_sits_below_the_rail(self):
        m = small_manifest(with_unmatched=True, with_overview=True)
        canvas = cb.build_canvas(m)
        by_id = nodes_by_id(canvas)
        group = by_id[cb.node_id(SLUG, cb.TOC_GROUP_KEY)]
        self.assertEqual(group["type"], "group")
        self.assertEqual(group["label"], "Heatmap Sections")
        root = by_id[cb.node_id(SLUG, "root")]
        bin_node = by_id[cb.node_id(SLUG, "bin")]
        self.assertGreater(group["y"], bin_node["y"] + bin_node["height"] - 1)
        self.assertLess(group["x"], root["x"])
        for chapter in m["chapters"]:
            card = by_id[cb.node_id(SLUG, cb.toc_key(chapter["idx"]))]
            self.assertGreaterEqual(card["x"], group["x"])
            self.assertLessEqual(card["x"] + card["width"],
                                 group["x"] + group["width"])
            self.assertGreaterEqual(card["y"], group["y"])
            self.assertLessEqual(card["y"] + card["height"],
                                 group["y"] + group["height"])
        self.assertEqual(validate_canvas(canvas), [])

    def test_toc_entries_mirror_the_hub_cards_exactly(self):
        for m in (small_manifest(), big_manifest(), granular_manifest(),
                  front_matter_manifest()):
            canvas = cb.build_canvas(m)
            by_id = nodes_by_id(canvas)
            hubs, tocs = [], []
            for node in canvas["nodes"]:
                for chapter in m["chapters"]:
                    idx = chapter["idx"]
                    if node["id"] == cb.node_id(m["slug"], cb.hub_key(idx)):
                        hubs.append((idx, node["text"].split("\n")[0]))
                    if node["id"] == cb.node_id(m["slug"], cb.toc_key(idx)):
                        tocs.append((idx, node["text"].split("\n")[0]))
            self.assertTrue(hubs)
            # identical set, identical order, identical titles
            self.assertEqual([i for i, _t in hubs], [i for i, _t in tocs])
            self.assertEqual([t for _i, t in hubs], [t for _i, t in tocs])

    def test_front_matter_without_claims_gets_no_toc_card(self):
        m = front_matter_manifest()
        canvas = cb.build_canvas(m)
        ids = set(n["id"] for n in canvas["nodes"])
        for title, idx in (("Disclosures", 0), ("Dedication", 1),
                           ("About the Author", 4), ("Index", 5)):
            self.assertNotIn(cb.node_id(m["slug"], cb.toc_key(idx)), ids,
                             "%s should not be listed" % title)
            self.assertNotIn(cb.node_id(m["slug"], cb.hub_key(idx)), ids)
        for idx in (2, 3):
            self.assertIn(cb.node_id(m["slug"], cb.toc_key(idx)), ids)

    def test_entries_wrap_into_columns_and_read_landscape(self):
        m = granular_manifest()          # 15 chapters
        canvas = cb.build_canvas(m)
        by_id = nodes_by_id(canvas)
        group = by_id[cb.node_id(m["slug"], cb.TOC_GROUP_KEY)]
        cards = [by_id[cb.node_id(m["slug"], cb.toc_key(c["idx"]))]
                 for c in sorted(m["chapters"], key=lambda c: c["idx"])]
        self.assertEqual(len(cards), 15)
        columns = sorted(set(c["x"] for c in cards))
        self.assertEqual(len(columns), 3, "15 entries at 5 rows should give 3 columns")
        self.assertGreater(group["width"], group["height"],
                           "the heatmap block must read landscape")
        # top-to-bottom within a column, then wrap right
        for index, card in enumerate(cards):
            column, row = divmod(index, cb.TOC_ROWS)
            self.assertEqual(card["x"], columns[column])
            if row:
                previous = cards[index - 1]
                self.assertGreaterEqual(card["y"],
                                        previous["y"] + previous["height"])
        self.assertEqual(validate_canvas(canvas), [])

    def test_every_card_stays_inside_the_group_box(self):
        m = granular_manifest()
        canvas = cb.build_canvas(m)
        by_id = nodes_by_id(canvas)
        group = by_id[cb.node_id(m["slug"], cb.TOC_GROUP_KEY)]
        for chapter in m["chapters"]:
            card = by_id[cb.node_id(m["slug"], cb.toc_key(chapter["idx"]))]
            self.assertGreaterEqual(card["x"], group["x"])
            self.assertLessEqual(card["x"] + card["width"],
                                 group["x"] + group["width"])
            self.assertGreaterEqual(card["y"], group["y"])
            self.assertLessEqual(card["y"] + card["height"],
                                 group["y"] + group["height"])

    def test_no_edges_touch_the_toc(self):
        m = small_manifest()
        canvas = cb.build_canvas(m)
        ids = toc_ids(m) | {cb.node_id(SLUG, cb.TOC_GROUP_KEY)}
        for edge in canvas["edges"]:
            self.assertNotIn(edge["fromNode"], ids)
            self.assertNotIn(edge["toNode"], ids)

    def test_a_hand_applied_colour_is_carried_forward(self):
        m = small_manifest()
        canvas = json.loads(json.dumps(cb.build_canvas(m)))
        target = cb.node_id(SLUG, cb.toc_key(0))
        for node in canvas["nodes"]:
            if node["id"] == target:
                node["color"] = "1"          # JT heat-maps this chapter red
        rebuilt = cb.build_canvas(m, existing=canvas)
        by_id = nodes_by_id(rebuilt)
        self.assertEqual(by_id[target]["color"], "1")
        # untouched siblings stay uncoloured
        self.assertNotIn("color", by_id[cb.node_id(SLUG, cb.toc_key(1))])

    def test_every_preset_colour_survives_a_rebuild(self):
        m = big_manifest()
        canvas = json.loads(json.dumps(cb.build_canvas(m)))
        wanted = {}
        for index, chapter in enumerate(m["chapters"]):
            ident = cb.node_id(m["slug"], cb.toc_key(chapter["idx"]))
            wanted[ident] = str((index % 6) + 1)
        for node in canvas["nodes"]:
            if node["id"] in wanted:
                node["color"] = wanted[node["id"]]
        rebuilt = cb.build_canvas(m, existing=canvas)
        by_id = nodes_by_id(rebuilt)
        for ident, colour in wanted.items():
            self.assertEqual(by_id[ident]["color"], colour)
        self.assertEqual(validate_canvas(rebuilt), [])

    def test_colour_survives_repeated_rebuilds(self):
        m = small_manifest()
        canvas = json.loads(json.dumps(cb.build_canvas(m)))
        target = cb.node_id(SLUG, cb.toc_key(1))
        for node in canvas["nodes"]:
            if node["id"] == target:
                node["color"] = "4"
        for _ in range(3):
            canvas = cb.build_canvas(m, existing=canvas)
        self.assertEqual(nodes_by_id(canvas)[target]["color"], "4")

    def test_claim_card_colour_is_not_taken_from_the_canvas(self):
        """Only toc cards borrow colour; stance stays manifest-driven."""
        m = small_manifest()
        canvas = json.loads(json.dumps(cb.build_canvas(m)))
        target = cb.claim_node_id(SLUG, "c-0001")
        for node in canvas["nodes"]:
            if node["id"] == target:
                node["color"] = "6"
        rebuilt = cb.build_canvas(m, existing=canvas)
        self.assertNotIn("color", nodes_by_id(rebuilt)[target])

    def test_toc_text_edit_persists_like_other_furniture(self):
        m = small_manifest()
        canvas = json.loads(json.dumps(cb.build_canvas(m)))
        target = cb.node_id(SLUG, cb.toc_key(0))
        mine = "# Cash flow (the important one)"
        for node in canvas["nodes"]:
            if node["id"] == target:
                node["text"] = mine
        import canvas_parse as cp
        overlay = cp.parse_overlay(m, canvas)
        self.assertEqual(overlay["furniture_edits"], {"toc:0": mine})
        cp.apply_overlay(m, overlay)
        M.validate(m)
        rebuilt = cb.build_canvas(m, existing=canvas)
        self.assertEqual(nodes_by_id(rebuilt)[target]["text"], mine)

    def test_a_colour_change_alone_raises_no_warning(self):
        m = small_manifest()
        canvas = json.loads(json.dumps(cb.build_canvas(m)))
        for node in canvas["nodes"]:
            if node["id"] in toc_ids(m):
                node["color"] = "2"
        import canvas_parse as cp
        overlay = cp.parse_overlay(m, canvas)
        self.assertEqual(overlay["warnings"], [])
        self.assertEqual(overlay["furniture_edits"], {})
        self.assertEqual(overlay["alien_nodes"], [])


class OverviewTest(unittest.TestCase):
    def test_overview_cluster_is_just_the_root_card_when_empty(self):
        m = small_manifest()
        self.assertEqual([c for c in m["claims"] if c["chapter_idx"] == -1], [])
        canvas = cb.build_canvas(m)
        overview = overview_extent(m, canvas)
        root = nodes_by_id(canvas)[cb.node_id(SLUG, "root")]
        self.assertEqual(overview["members"], [root])
        self.assertEqual(overview["x1"] - overview["x0"], cb.CARD_W)
        self.assertEqual(validate_canvas(canvas), [])

    def test_overview_claims_sit_one_column_right_of_root(self):
        m = small_manifest(with_overview=True)
        canvas = cb.build_canvas(m)
        by_id = nodes_by_id(canvas)
        root = by_id[cb.node_id(SLUG, "root")]
        overview = overview_extent(m, canvas)
        first = chapter_extents(m, canvas)[0]
        for claim_id in ("o-0001", "o-0002", "o-0003"):
            node = by_id[cb.node_id(SLUG, claim_id)]
            self.assertEqual(node["x"] - root["x"], cb.COL_PITCH)
            self.assertLessEqual(node["x"] + node["width"], overview["x1"])
        # the whole cluster still clears the first chapter
        self.assertGreaterEqual(first["x0"], overview["x1"])
        self.assertEqual(validate_canvas(canvas), [])

    def test_root_edges_only_to_its_own_overview_claims(self):
        m = small_manifest(with_overview=True)
        canvas = cb.build_canvas(m)
        root = cb.node_id(SLUG, "root")
        targets = set(e["toNode"] for e in canvas["edges"] if e["fromNode"] == root)
        self.assertEqual(targets, {
            cb.node_id(SLUG, "o-0001"),
            cb.node_id(SLUG, "o-0002"),
            cb.node_id(SLUG, "o-0003"),
        })

    def test_overview_claims_may_nest(self):
        m = small_manifest(with_overview=True)
        m["claims"][-1]["parent"] = "o-0001"
        M.validate(m)
        canvas = cb.build_canvas(m)
        by_id = {n["id"]: n for n in canvas["nodes"]}
        parent = by_id[cb.node_id(SLUG, "o-0001")]
        child = by_id[cb.node_id(SLUG, "o-0003")]
        self.assertEqual(child["x"] - parent["x"], cb.COL_PITCH)
        edge = [e for e in canvas["edges"]
                if e["id"] == cb.node_id(SLUG, "edge:o-0003")][0]
        self.assertEqual(edge["fromNode"], parent["id"])
        self.assertEqual(validate_canvas(canvas), [])

    def test_chapter_column_shifts_right_of_a_wide_overview(self):
        narrow = cb.build_canvas(small_manifest())
        wide = cb.build_canvas(small_manifest(with_overview=True))
        hub = cb.node_id(SLUG, "hub:0")
        narrow_x = [n for n in narrow["nodes"] if n["id"] == hub][0]["x"]
        wide_x = [n for n in wide["nodes"] if n["id"] == hub][0]["x"]
        self.assertEqual(wide_x - narrow_x, cb.COL_PITCH)

    def test_overview_claim_needs_no_block_range_or_cite(self):
        claim = M.new_claim("o-0009", "Book-level thesis", -1, "root", 0,
                            body_md="The whole argument in one card.")
        self.assertIsNone(claim["block_range"])
        self.assertIsNone(claim["anchor_block"])
        m = small_manifest()
        m["claims"].append(claim)
        M.validate(m)
        canvas = cb.build_canvas(m)
        self.assertEqual(validate_canvas(canvas), [])
        node = [n for n in canvas["nodes"] if n["id"] == cb.node_id(SLUG, "o-0009")][0]
        self.assertNotIn("↳ cite:", node["text"])


class RelationshipEdgeTest(unittest.TestCase):
    def test_default_rel_leaves_the_edge_unlabelled(self):
        m = small_manifest()
        self.assertEqual(m["claims"][1]["rel"], "supports")
        canvas = cb.build_canvas(m)
        edge = [e for e in canvas["edges"]
                if e["id"] == cb.node_id(SLUG, "edge:c-0002")][0]
        self.assertNotIn("label", edge)

    def test_non_default_rel_labels_the_edge(self):
        for rel in ("objection", "reply", "qualifies",
                    "contrasts", "example", "consequence"):
            m = small_manifest()
            m["claims"][1]["rel"] = rel
            M.validate(m)
            canvas = cb.build_canvas(m)
            edge = [e for e in canvas["edges"]
                    if e["id"] == cb.node_id(SLUG, "edge:c-0002")][0]
            self.assertEqual(edge.get("label"), rel)
            self.assertNotIn("color", edge, "colour is reserved for the JT overlay")
            self.assertEqual(validate_canvas(canvas), [])

    def test_rel_labels_an_overview_edge_too(self):
        m = small_manifest(with_overview=True)
        m["claims"][-1]["rel"] = "qualifies"
        M.validate(m)
        canvas = cb.build_canvas(m)
        edge = [e for e in canvas["edges"]
                if e["id"] == cb.node_id(SLUG, "edge:o-0003")][0]
        self.assertEqual(edge["fromNode"], cb.node_id(SLUG, "root"))
        self.assertEqual(edge["label"], "qualifies")

    def test_root_to_group_edges_are_never_labelled(self):
        m = small_manifest()
        canvas = cb.build_canvas(m)
        root = cb.node_id(SLUG, "root")
        for edge in canvas["edges"]:
            if edge["fromNode"] == root:
                self.assertNotIn("label", edge)

    def test_missing_rel_field_defaults_to_supports(self):
        m = small_manifest()
        del m["claims"][1]["rel"]
        M.validate(m)
        canvas = cb.build_canvas(m)
        edge = [e for e in canvas["edges"]
                if e["id"] == cb.node_id(SLUG, "edge:c-0002")][0]
        self.assertNotIn("label", edge)

    def test_pruned_claims_are_never_projected(self):
        m = small_manifest()
        m["claims"][1]["jt"]["pruned"] = True
        canvas = cb.build_canvas(m)
        ids = [n["id"] for n in canvas["nodes"]]
        self.assertNotIn(cb.node_id(SLUG, "c-0002"), ids)
        self.assertIn(cb.node_id(SLUG, "c-0003"), ids)
        edge_ids = [e["id"] for e in canvas["edges"]]
        self.assertNotIn(cb.node_id(SLUG, "edge:c-0002"), edge_ids)
        self.assertEqual(validate_canvas(canvas), [])


class ShelfLayoutTest(unittest.TestCase):
    """Chapter groups sit on a horizontal shelf, not a vertical stack.

    Stacking made a book-scale map ~1:112 and unusable at fit-to-view.
    """

    def test_the_only_group_is_the_heatmap_table_of_contents(self):
        for m in (small_manifest(), small_manifest(with_overview=True), big_manifest()):
            canvas = cb.build_canvas(m)
            groups = [n for n in canvas["nodes"] if n["type"] == "group"]
            self.assertEqual([g["id"] for g in groups],
                             [cb.node_id(m["slug"], cb.TOC_GROUP_KEY)])
            self.assertEqual(groups[0]["label"], "Heatmap Sections")
            # chapters themselves are still separated by whitespace alone
            for node in map_nodes(m, canvas):
                self.assertEqual(node["type"], "text")

    def test_every_chapter_is_top_aligned_at_zero(self):
        for m in (small_manifest(), small_manifest(with_overview=True), big_manifest()):
            canvas = cb.build_canvas(m)
            chapters = chapter_extents(m, canvas)
            self.assertTrue(chapters)
            for chapter in chapters:
                self.assertEqual(chapter["y0"], 0,
                                 "chapter %r is not top-aligned" % chapter["label"])

    def test_chapters_run_strictly_left_to_right_without_overlap(self):
        m = big_manifest()
        chapters = chapter_extents(m, cb.build_canvas(m))
        self.assertEqual([c["label"] for c in chapters],
                         ["Chapter 1", "Chapter 2", "Chapter 3"])
        for earlier, later in zip(chapters, chapters[1:]):
            self.assertGreaterEqual(
                later["x0"], earlier["x1"],
                "%r overlaps %r in x" % (later["label"], earlier["label"]))
            self.assertGreaterEqual(later["x0"] - earlier["x1"], cb.CHAPTER_GAP)

    def test_overview_cluster_precedes_the_first_chapter(self):
        m = small_manifest(with_overview=True)
        canvas = cb.build_canvas(m)
        overview = overview_extent(m, canvas)
        first = chapter_extents(m, canvas)[0]
        self.assertGreaterEqual(first["x0"], overview["x1"])

    def test_overview_is_centred_against_the_tallest_chapter(self):
        m = big_manifest()
        canvas = cb.build_canvas(m)
        overview = overview_extent(m, canvas)
        tallest = max(c["y1"] for c in chapter_extents(m, canvas))
        middle = (overview["y0"] + overview["y1"]) / 2.0
        self.assertLessEqual(abs(middle - tallest / 2.0), 2.0)

    def test_legend_sits_immediately_left_of_root_and_bin_below_it(self):
        m = small_manifest(with_unmatched=True, with_overview=True)
        canvas = cb.build_canvas(m)
        by_id = nodes_by_id(canvas)
        root = by_id[cb.node_id(SLUG, "root")]
        legend = by_id[cb.node_id(SLUG, "legend")]
        bin_node = by_id[cb.node_id(SLUG, "bin")]

        # immediately left of root, one COL_GAP away
        self.assertEqual(root["x"] - (legend["x"] + legend["width"]), cb.COL_GAP)
        # vertically centred against root
        legend_mid = legend["y"] + legend["height"] / 2.0
        root_mid = root["y"] + root["height"] / 2.0
        self.assertLessEqual(abs(legend_mid - root_mid), 1.0)
        # the bin drops below root, in root's own column
        self.assertEqual(bin_node["x"], root["x"])
        self.assertEqual(bin_node["y"], root["y"] + root["height"] + cb.SIDE_GAP)
        self.assertEqual(validate_canvas(canvas), [])

    def test_legend_is_the_leftmost_thing_on_the_map(self):
        m = small_manifest(with_unmatched=True, with_overview=True)
        canvas = cb.build_canvas(m)
        legend = nodes_by_id(canvas)[cb.node_id(SLUG, "legend")]
        self.assertEqual(legend["x"], min(n["x"] for n in canvas["nodes"]))

    def test_hub_card_per_chapter_carrying_its_title(self):
        m = small_manifest()
        canvas = cb.build_canvas(m)
        by_id = nodes_by_id(canvas)
        for idx, title in ((0, "Ch 1 — Cash Flow"), (1, "Ch 2 — Taxes")):
            hub = by_id[cb.node_id(SLUG, cb.hub_key(idx))]
            self.assertEqual(hub["type"], "text")
            self.assertEqual(hub["text"], "# " + title)
            # teal is the machine creation-time colour, shared with root/legend
            self.assertEqual(hub["color"], "5")

    def test_furniture_shares_one_machine_colour(self):
        m = small_manifest(with_unmatched=True)
        by_id = nodes_by_id(cb.build_canvas(m))
        for key in ("root", "legend", cb.hub_key(0), cb.hub_key(1)):
            self.assertEqual(by_id[cb.node_id(SLUG, key)]["color"], "5",
                             "%s should wear the furniture colour" % key)
        self.assertEqual(by_id[cb.node_id(SLUG, "bin")]["color"], "2")

    def test_legend_documents_the_furniture_colour(self):
        self.assertIn("teal = root, legend, and chapter hubs", cb.LEGEND_TEXT)

    def test_yellow_is_reserved_and_never_emitted(self):
        for m in (small_manifest(with_unmatched=True, with_overview=True),
                  big_manifest(), branching_manifest()):
            for node in cb.build_canvas(m)["nodes"]:
                self.assertNotEqual(node.get("color"), "3",
                                    "yellow is reserved as a future highlighter")

    def test_hub_gloss_is_rendered_when_the_chapter_has_one(self):
        m = small_manifest()
        m["chapters"][0]["gloss"] = "Why the paycheque, not the portfolio, comes first."
        M.validate(m)
        canvas = cb.build_canvas(m)
        hub = nodes_by_id(canvas)[cb.node_id(SLUG, cb.hub_key(0))]
        self.assertEqual(
            hub["text"],
            "# Ch 1 — Cash Flow\n\nWhy the paycheque, not the portfolio, comes first.")
        self.assertEqual(validate_canvas(canvas), [])

    def test_no_hub_spoke_edges_are_emitted(self):
        for m in (small_manifest(), small_manifest(with_overview=True),
                  big_manifest(), branching_manifest()):
            canvas = cb.build_canvas(m)
            hub_ids = set(cb.node_id(m["slug"], cb.hub_key(c["idx"]))
                          for c in m["chapters"])
            for edge in canvas["edges"]:
                self.assertNotIn(edge["toNode"], hub_ids,
                                 "nothing may point at a hub")
            spokes = set(cb.node_id(m["slug"], cb.hub_edge_key(c["idx"]))
                         for c in m["chapters"])
            self.assertEqual(
                spokes & set(e["id"] for e in canvas["edges"]), set(),
                "root -> hub spokes must not be emitted")

    def test_hubs_still_edge_to_their_top_level_claims(self):
        m = small_manifest()
        canvas = cb.build_canvas(m)
        hub0 = cb.node_id(SLUG, cb.hub_key(0))
        from_hub0 = set(e["toNode"] for e in canvas["edges"] if e["fromNode"] == hub0)
        self.assertEqual(from_hub0, {cb.claim_node_id(SLUG, "c-0001")})
        edge = [e for e in canvas["edges"]
                if e["id"] == cb.node_id(SLUG, "edge:c-0001")][0]
        self.assertEqual(edge["fromNode"], hub0)

    def test_legacy_hub_spokes_are_dropped_not_carried_forward(self):
        m = small_manifest()
        canvas = cb.build_canvas(m)
        stale = {
            "id": cb.node_id(SLUG, cb.hub_edge_key(0)),
            "fromNode": cb.node_id(SLUG, "root"),
            "toNode": cb.node_id(SLUG, cb.hub_key(0)),
            "fromSide": "right", "toSide": "left", "toEnd": "arrow",
        }
        existing = {"nodes": list(canvas["nodes"]),
                    "edges": list(canvas["edges"]) + [stale]}
        rebuilt = cb.build_canvas(m, existing=existing)
        self.assertNotIn(stale["id"], [e["id"] for e in rebuilt["edges"]])

    def test_hub_edges_carry_rel_labels(self):
        m = small_manifest()
        m["claims"][0]["rel"] = "consequence"
        M.validate(m)
        canvas = cb.build_canvas(m)
        edge = [e for e in canvas["edges"]
                if e["id"] == cb.node_id(SLUG, "edge:c-0001")][0]
        self.assertEqual(edge["label"], "consequence")

    def test_branches_fan_out_both_sides_of_the_hub(self):
        m = branching_manifest()
        canvas = cb.build_canvas(m)
        by_id = nodes_by_id(canvas)
        hub = by_id[cb.node_id(m["slug"], cb.hub_key(0))]
        left, right = [], []
        for claim in m["claims"]:
            node = by_id[cb.claim_node_id(m["slug"], claim["id"])]
            (left if node["x"] < hub["x"] else right).append(node)
        self.assertTrue(left, "nothing was placed on the left of the hub")
        self.assertTrue(right, "nothing was placed on the right of the hub")
        for node in left:
            self.assertLess(node["x"] + node["width"], hub["x"])
        for node in right:
            self.assertGreater(node["x"], hub["x"] + hub["width"])

    def test_left_branch_edges_are_mirrored(self):
        m = branching_manifest()
        canvas = cb.build_canvas(m)
        by_id = nodes_by_id(canvas)
        hub = by_id[cb.node_id(m["slug"], cb.hub_key(0))]
        seen_left = seen_right = False
        for edge in canvas["edges"]:
            target = by_id.get(edge["toNode"])
            if target is None or edge["toNode"] == hub["id"]:
                continue
            if target["x"] < hub["x"]:
                self.assertEqual(edge["fromSide"], "left")
                self.assertEqual(edge["toSide"], "right")
                seen_left = True
            elif target["x"] > hub["x"]:
                self.assertEqual(edge["fromSide"], "right")
                self.assertEqual(edge["toSide"], "left")
                seen_right = True
        self.assertTrue(seen_left and seen_right)

    def test_both_wings_are_balanced_within_forty_percent(self):
        m = branching_manifest()
        canvas = cb.build_canvas(m)
        by_id = nodes_by_id(canvas)
        hub = by_id[cb.node_id(m["slug"], cb.hub_key(0))]
        spans = {"left": [], "right": []}
        for claim in m["claims"]:
            node = by_id[cb.claim_node_id(m["slug"], claim["id"])]
            side = "left" if node["x"] < hub["x"] else "right"
            spans[side].append((node["y"], node["y"] + node["height"]))
        heights = {}
        for side, boxes in spans.items():
            heights[side] = max(b for _a, b in boxes) - min(a for a, _b in boxes)
        bigger = max(heights.values())
        smaller = min(heights.values())
        self.assertGreaterEqual(
            smaller / float(bigger), 0.6,
            "wings are unbalanced: left=%d right=%d" % (heights["left"], heights["right"]))

    def test_bilateral_halves_the_height_a_chapter_needs(self):
        """Fanning both ways trades width for height — height is what was hurting.

        A one-sided chapter has to stack every branch in one column, so its
        height is the sum of both wings; bilateral pays one wing's worth.
        """
        m = branching_manifest()
        canvas = cb.build_canvas(m)
        by_id = nodes_by_id(canvas)
        hub = by_id[cb.node_id(m["slug"], cb.hub_key(0))]
        wings = {"left": [], "right": []}
        for claim in m["claims"]:
            node = by_id[cb.claim_node_id(m["slug"], claim["id"])]
            side = "left" if node["x"] < hub["x"] else "right"
            wings[side].append(node)
        wing_heights = [
            max(n["y"] + n["height"] for n in nodes) - min(n["y"] for n in nodes)
            for nodes in wings.values()
        ]
        chapter = chapter_extents(m, canvas)[0]
        height = chapter["y1"] - chapter["y0"]
        self.assertLessEqual(height, 0.65 * sum(wing_heights))

    def test_card_dimensions_are_480_by_620_nominal(self):
        m = small_manifest()
        canvas = cb.build_canvas(m)
        self.assertEqual(cb.CARD_W, 480)
        self.assertEqual(cb.H_MIN, 620)
        for node in map_nodes(m, canvas):
            self.assertEqual(node["width"], 480)
            self.assertGreaterEqual(node["height"], 620)

    def test_short_cards_sit_at_the_nominal_height(self):
        claim = M.new_claim("c-9", "Short", 0, "root", 0, body_md="Brief.")
        self.assertEqual(cb.card_height(cb.card_text(claim)), 620)

    def test_chapter_content_never_exceeds_the_height_cap(self):
        for m in (tall_manifest(), big_manifest(), branching_manifest(),
                  granular_manifest()):
            canvas = cb.build_canvas(m)
            for chapter in chapter_extents(m, canvas):
                height = chapter["y1"] - chapter["y0"]
                self.assertLessEqual(
                    height, cb.CHAPTER_HEIGHT_CAP,
                    "chapter %r is %d tall, cap is %d"
                    % (chapter["label"], height, cb.CHAPTER_HEIGHT_CAP))

    def test_a_stack_that_would_bust_the_cap_spills_into_more_columns(self):
        m = tall_manifest()
        canvas = cb.build_canvas(m)
        by_id = nodes_by_id(canvas)
        hub = by_id[cb.node_id(m["slug"], cb.hub_key(0))]
        # every top-level claim is a leaf, so without spill they would stack
        # into one very tall column
        naive = sum(by_id[cb.claim_node_id(m["slug"], c["id"])]["height"]
                    for c in m["claims"])
        self.assertGreater(naive, cb.CHAPTER_HEIGHT_CAP)
        columns = sorted(set(by_id[cb.claim_node_id(m["slug"], c["id"])]["x"]
                             for c in m["claims"]))
        self.assertGreater(len(columns), 2, "expected spill into extra columns")
        # both wings spilled, and each wing's columns are one pitch apart
        right = sorted(x for x in columns if x > hub["x"])
        left = sorted((x for x in columns if x < hub["x"]), reverse=True)
        self.assertGreater(len(right), 1)
        self.assertGreater(len(left), 1)
        for wing in (right, left):
            for earlier, later in zip(wing, wing[1:]):
                self.assertEqual(abs(later - earlier), cb.COL_PITCH)
        for x in columns:
            self.assertTrue(x + cb.CARD_W <= hub["x"] or x >= hub["x"] + cb.CARD_W)

    def test_five_nominal_cards_fit_a_column_and_a_sixth_does_not(self):
        pitch = cb.H_MIN + cb.SIB_GAP
        five = 5 * cb.H_MIN + 4 * cb.SIB_GAP
        six = 6 * cb.H_MIN + 5 * cb.SIB_GAP
        self.assertLessEqual(five, cb.CHAPTER_HEIGHT_CAP)
        self.assertGreater(six, cb.CHAPTER_HEIGHT_CAP)
        self.assertEqual(pitch, 680)

    def test_the_cap_constant_is_read_at_call_time(self):
        """The cap must be the single lever — not frozen into a default arg."""
        m = tall_manifest()
        original = cb.CHAPTER_HEIGHT_CAP
        try:
            cb.CHAPTER_HEIGHT_CAP = 1400
            tight = cb.build_canvas(m)
        finally:
            cb.CHAPTER_HEIGHT_CAP = original
        loose = cb.build_canvas(m)
        by_tight = nodes_by_id(tight)
        by_loose = nodes_by_id(loose)
        columns = lambda by: len(set(
            by[cb.claim_node_id(m["slug"], c["id"])]["x"] for c in m["claims"]))
        self.assertGreater(columns(by_tight), columns(by_loose),
                           "lowering the cap must force more columns")

    def test_children_sit_outward_of_their_parent_on_the_same_side(self):
        for m in (branching_manifest(), granular_manifest(), big_manifest()):
            canvas = cb.build_canvas(m)
            by_id = nodes_by_id(canvas)
            hubs = dict((c["idx"], by_id[cb.node_id(m["slug"], cb.hub_key(c["idx"]))])
                        for c in m["chapters"])
            for claim in m["claims"]:
                parent = claim["parent"]
                if parent == "root" or claim["chapter_idx"] == -1:
                    continue
                child = by_id[cb.claim_node_id(m["slug"], claim["id"])]
                parent_node = by_id[cb.claim_node_id(m["slug"], parent)]
                hub = hubs[claim["chapter_idx"]]
                outward = 1 if parent_node["x"] > hub["x"] else -1
                self.assertGreater(
                    (child["x"] - parent_node["x"]) * outward, 0,
                    "%s is not outward of its parent %s" % (claim["id"], parent))

    def test_each_parents_primary_run_is_immediately_beside_it(self):
        """The first run of children is always in the very next column."""
        for m in (branching_manifest(), granular_manifest(), big_manifest()):
            canvas = cb.build_canvas(m)
            by_id = nodes_by_id(canvas)
            groups = {}
            for claim in m["claims"]:
                if claim["parent"] != "root" and claim["chapter_idx"] != -1:
                    groups.setdefault(claim["parent"], []).append(claim["id"])
            for parent_id, kids in groups.items():
                parent = by_id[cb.claim_node_id(m["slug"], parent_id)]
                distances = set(
                    abs(by_id[cb.claim_node_id(m["slug"], k)]["x"] - parent["x"])
                    for k in kids)
                self.assertIn(
                    cb.COL_PITCH, distances,
                    "no child of %s sits in the adjacent column" % parent_id)

    def test_a_parent_is_level_with_its_own_children(self):
        """Adjacency: the run of children is centred on the parent."""
        for m in (branching_manifest(), granular_manifest()):
            canvas = cb.build_canvas(m)
            by_id = nodes_by_id(canvas)
            groups = {}
            for claim in m["claims"]:
                if claim["parent"] != "root" and claim["chapter_idx"] != -1:
                    groups.setdefault(claim["parent"], []).append(claim["id"])
            for parent_id, kids in groups.items():
                parent = by_id[cb.claim_node_id(m["slug"], parent_id)]
                kid_nodes = [by_id[cb.claim_node_id(m["slug"], k)] for k in kids]
                top = min(n["y"] for n in kid_nodes)
                bottom = max(n["y"] + n["height"] for n in kid_nodes)
                middle = parent["y"] + parent["height"] / 2.0
                self.assertTrue(
                    top <= middle <= bottom,
                    "parent %s is not level with its children" % parent_id)

    def test_no_column_interleaves_two_parents_children(self):
        """Subtree contiguity: a column run never mixes two parents' children."""
        for m in (branching_manifest(), granular_manifest(), tall_manifest()):
            canvas = cb.build_canvas(m)
            by_id = nodes_by_id(canvas)
            parent_of = dict((c["id"], c["parent"]) for c in m["claims"])
            per_column = {}
            for claim in m["claims"]:
                if claim["chapter_idx"] == -1:
                    continue
                node = by_id[cb.claim_node_id(m["slug"], claim["id"])]
                key = (claim["chapter_idx"], node["x"])
                per_column.setdefault(key, []).append((node["y"], claim["id"]))
            for key, entries in per_column.items():
                entries.sort()
                seen = []
                for _y, claim_id in entries:
                    parent = parent_of[claim_id]
                    if not seen or seen[-1] != parent:
                        self.assertNotIn(
                            parent, seen,
                            "column %r interleaves children of %s" % (key, parent))
                        seen.append(parent)

    def test_a_subtree_is_never_split_across_bands(self):
        m = granular_manifest()
        canvas = cb.build_canvas(m)
        by_id = nodes_by_id(canvas)
        children = {}
        for claim in m["claims"]:
            if claim["parent"] != "root" and claim["chapter_idx"] != -1:
                children.setdefault(claim["parent"], []).append(claim["id"])
        for parent_id, kids in children.items():
            columns = set(by_id[cb.claim_node_id(m["slug"], k)]["x"] for k in kids)
            # one adjacent run, or an explicit spill into the next column out
            self.assertLessEqual(len(columns), 2,
                                 "children of %s scattered over %d columns"
                                 % (parent_id, len(columns)))

    def test_ordinary_content_never_drifts_above_the_cap(self):
        """The tolerance is not a raised cap — it must stay unspent here."""
        for m in (granular_manifest(), big_manifest(), branching_manifest(),
                  tall_manifest(), small_manifest()):
            canvas = cb.build_canvas(m)
            for chapter in chapter_extents(m, canvas):
                height = chapter["y1"] - chapter["y0"]
                self.assertLessEqual(
                    height, cb.CHAPTER_HEIGHT_CAP,
                    "chapter %r drifted to %d without needing the tolerance"
                    % (chapter["label"], height))

    def test_the_tolerance_is_spent_only_to_avoid_a_split(self):
        # six children whose run lands between the cap and the limit: keeping
        # them in one adjacent run is worth the extra height
        m = wide_family_manifest(kids=6)
        canvas = cb.build_canvas(m)
        by_id = nodes_by_id(canvas)
        kids = [c for c in m["claims"] if c["parent"] != "root"]
        columns = set(by_id[cb.claim_node_id(m["slug"], c["id"])]["x"] for c in kids)
        run = sum(by_id[cb.claim_node_id(m["slug"], c["id"])]["height"]
                  for c in kids) + cb.SIB_GAP * (len(kids) - 1)
        self.assertGreater(run, cb.CHAPTER_HEIGHT_CAP, "fixture must exceed the cap")
        self.assertLessEqual(run, cb.CHAPTER_HEIGHT_LIMIT)
        self.assertEqual(len(columns), 1, "tolerance should have kept one run")
        height = chapter_extents(m, canvas)[0]["y1"]
        self.assertLessEqual(height, cb.CHAPTER_HEIGHT_LIMIT)

    def test_a_run_too_big_even_for_the_tolerance_still_splits(self):
        m = wide_family_manifest(kids=7)
        canvas = cb.build_canvas(m)
        by_id = nodes_by_id(canvas)
        kids = [c for c in m["claims"] if c["parent"] != "root"]
        columns = set(by_id[cb.claim_node_id(m["slug"], c["id"])]["x"] for c in kids)
        self.assertGreater(len(columns), 1, "an unsalvageable run must split")
        for chapter in chapter_extents(m, canvas):
            self.assertLessEqual(chapter["y1"] - chapter["y0"],
                                 cb.CHAPTER_HEIGHT_LIMIT)

    def test_flag_off_is_exactly_the_v5_sequential_packer(self):
        """v5 must stay recoverable: flag-off IS the old sequential greedy."""
        units = [{"id": "u%d" % i} for i in range(9)]
        spans = {"u0": 1300, "u1": 620, "u2": 3000, "u3": 620, "u4": 1300,
                 "u5": 300, "u6": 2400, "u7": 620, "u8": 900}
        widths = dict((u["id"], 1 + (index % 3)) for index, u in enumerate(units))
        self.assertEqual(
            cb._band_pack(units, spans, widths, cb.CHAPTER_HEIGHT_CAP, False),
            cb._greedy_groups(units, lambda u: spans[u["id"]], cb.CHAPTER_HEIGHT_CAP),
        )

    def test_flag_off_map_geometry_is_stable_and_deterministic(self):
        m = mixed_sections_manifest()
        original = cb.BAND_FILL_COMPACT
        try:
            cb.BAND_FILL_COMPACT = False
            first = cb.build_canvas(m)
            second = cb.build_canvas(m)
        finally:
            cb.BAND_FILL_COMPACT = original
        self.assertEqual(cb.dumps_canvas(first), cb.dumps_canvas(second))
        self.assertEqual(validate_canvas(first), [])

    def test_flag_on_packs_a_small_section_into_an_existing_band(self):
        m = mixed_sections_manifest()
        original = cb.BAND_FILL_COMPACT
        try:
            cb.BAND_FILL_COMPACT = False
            loose = cb.build_canvas(m)
            cb.BAND_FILL_COMPACT = True
            tight = cb.build_canvas(m)
        finally:
            cb.BAND_FILL_COMPACT = original

        def columns(canvas):
            by_id = nodes_by_id(canvas)
            return set(by_id[cb.claim_node_id(m["slug"], c["id"])]["x"]
                       for c in m["claims"])

        self.assertLess(len(columns(tight)), len(columns(loose)),
                        "compact packing should save at least one column")
        width = lambda c: (max(n["x"] + n["width"] for n in map_nodes(m, c))
                           - min(n["x"] for n in map_nodes(m, c)))
        self.assertLess(width(tight), width(loose))

    def test_flag_on_keeps_every_invariant(self):
        for m in (mixed_sections_manifest(), granular_manifest(),
                  branching_manifest()):
            canvas = cb.build_canvas(m)
            self.assertEqual(validate_canvas(canvas), [])
            by_id = nodes_by_id(canvas)
            groups = {}
            for claim in m["claims"]:
                if claim["parent"] != "root" and claim["chapter_idx"] != -1:
                    groups.setdefault(claim["parent"], []).append(claim["id"])
            for parent_id, kids in groups.items():
                parent = by_id[cb.claim_node_id(m["slug"], parent_id)]
                kid_nodes = [by_id[cb.claim_node_id(m["slug"], k)] for k in kids]
                distances = set(abs(n["x"] - parent["x"]) for n in kid_nodes)
                self.assertIn(cb.COL_PITCH, distances)
                top = min(n["y"] for n in kid_nodes)
                bottom = max(n["y"] + n["height"] for n in kid_nodes)
                middle = parent["y"] + parent["height"] / 2.0
                self.assertTrue(top <= middle <= bottom)
            for chapter in chapter_extents(m, canvas):
                self.assertLessEqual(chapter["y1"] - chapter["y0"],
                                     cb.CHAPTER_HEIGHT_LIMIT)

    def test_spill_keeps_no_overlap_and_is_deterministic(self):
        m = tall_manifest()
        first = cb.build_canvas(m)
        self.assertEqual(validate_canvas(first), [])
        self.assertEqual(cb.dumps_canvas(first), cb.dumps_canvas(cb.build_canvas(m)))

    def test_columns_fill_one_at_a_time(self):
        m = tall_manifest()
        canvas = cb.build_canvas(m)
        by_id = nodes_by_id(canvas)
        per_column = {}
        for claim in m["claims"]:
            node = by_id[cb.claim_node_id(m["slug"], claim["id"])]
            per_column.setdefault(node["x"], []).append(node)
        # every column except the last of a wing is filled close to the cap
        filled = sorted(
            (_col_height(nodes) for nodes in per_column.values()), reverse=True)
        self.assertGreater(filled[0], cb.CHAPTER_HEIGHT_CAP * 0.5)
        for height in filled:
            self.assertLessEqual(height, cb.CHAPTER_HEIGHT_CAP)

    def test_a_book_scale_map_has_a_workable_aspect_ratio(self):
        m = big_manifest(claim_count=300, chapters=10)
        canvas = cb.build_canvas(m)
        self.assertEqual(validate_canvas(canvas), [])
        left = min(n["x"] for n in canvas["nodes"])
        right = max(n["x"] + n["width"] for n in canvas["nodes"])
        top = min(n["y"] for n in canvas["nodes"])
        bottom = max(n["y"] + n["height"] for n in canvas["nodes"])
        width, height = right - left, bottom - top
        # a shelf is wider than it is tall; the old stack was ~1:112
        self.assertGreater(width, height)
        self.assertLess(height / float(width), 2.0)

    def test_adding_a_chapter_widens_rather_than_lengthens_the_shelf(self):
        m4 = big_manifest(claim_count=80, chapters=4)
        m8 = big_manifest(claim_count=160, chapters=8)
        four, eight = cb.build_canvas(m4), cb.build_canvas(m8)

        def extent(m, canvas):
            nodes = map_nodes(m, canvas)
            return (max(n["x"] + n["width"] for n in nodes)
                    - min(n["x"] for n in nodes),
                    max(c["y1"] for c in chapter_extents(m, canvas)))

        w4, h4 = extent(m4, four)
        w8, h8 = extent(m8, eight)
        self.assertGreater(w8, w4)
        self.assertEqual(h8, h4, "chapter count must not drive shelf height")


class EdgeTest(unittest.TestCase):
    def test_edges_run_right_to_left_with_an_arrow(self):
        m = small_manifest()
        canvas = cb.build_canvas(m)
        self.assertTrue(canvas["edges"])
        for edge in canvas["edges"]:
            self.assertEqual(edge["fromSide"], "right")
            self.assertEqual(edge["toSide"], "left")
            self.assertEqual(edge["toEnd"], "arrow")
            self.assertNotIn("label", edge)

    def test_root_has_no_spokes_to_hubs(self):
        m = small_manifest()
        canvas = cb.build_canvas(m)
        root = cb.node_id(SLUG, "root")
        targets = set(e["toNode"] for e in canvas["edges"] if e["fromNode"] == root)
        # no overview claims in this fixture, so root is edge-less entirely
        self.assertEqual(targets, set())
        hubs = set(cb.node_id(SLUG, cb.hub_key(i)) for i in (0, 1))
        for edge in canvas["edges"]:
            self.assertNotIn(edge["toNode"], hubs,
                             "a hub must have no incoming edge")

    def test_top_level_claims_now_have_a_hub_edge(self):
        m = small_manifest()
        canvas = cb.build_canvas(m)
        by_edge = dict((e["id"], e) for e in canvas["edges"])
        # c-0001 is top level in chapter 0: it hangs off that chapter's hub
        top = by_edge[cb.node_id(SLUG, "edge:c-0001")]
        self.assertEqual(top["fromNode"], cb.node_id(SLUG, "hub:0"))
        # c-0003 is a child claim: it hangs off its parent as before
        child = by_edge[cb.node_id(SLUG, "edge:c-0003")]
        self.assertEqual(child["fromNode"], cb.claim_node_id(SLUG, "c-0001"))


class ColorTest(unittest.TestCase):
    def test_source_cards_carry_no_color(self):
        m = small_manifest()
        canvas = cb.build_canvas(m)
        node = [n for n in canvas["nodes"] if n["id"] == cb.node_id(SLUG, "c-0001")][0]
        self.assertNotIn("color", node)

    def test_stance_recolors_the_card(self):
        expected = {"agree": "4", "dispute": "1", "surface": "6"}
        for stance, color in expected.items():
            m = small_manifest()
            m["claims"][0]["jt"]["stance"] = stance
            canvas = cb.build_canvas(m)
            node = [n for n in canvas["nodes"] if n["id"] == cb.node_id(SLUG, "c-0001")][0]
            self.assertEqual(node.get("color"), color, "stance %s" % stance)

    def test_stance_emoji_is_accepted_as_a_stance_value(self):
        m = small_manifest()
        m["claims"][0]["jt"]["stance"] = "❌"
        canvas = cb.build_canvas(m)
        node = [n for n in canvas["nodes"] if n["id"] == cb.node_id(SLUG, "c-0001")][0]
        self.assertEqual(node["color"], "1")
        self.assertIn("❌ Dispute", node["text"])

    def test_root_legend_and_bin_colors(self):
        m = small_manifest(with_unmatched=True)
        canvas = cb.build_canvas(m)
        by_id = {n["id"]: n for n in canvas["nodes"]}
        self.assertEqual(by_id[cb.node_id(SLUG, "root")]["color"], "5")
        self.assertEqual(by_id[cb.node_id(SLUG, "legend")]["color"], "5")
        self.assertEqual(by_id[cb.node_id(SLUG, "bin")]["color"], "2")

    def test_the_heatmap_group_is_teal_and_is_the_only_group(self):
        m = small_manifest()
        canvas = cb.build_canvas(m)
        groups = [n for n in canvas["nodes"] if n["type"] == "group"]
        self.assertEqual([g["id"] for g in groups],
                         [cb.node_id(SLUG, cb.TOC_GROUP_KEY)])
        self.assertEqual(groups[0]["color"], "5")
        self.assertEqual(validate_canvas(canvas), [])


class BinTest(unittest.TestCase):
    def test_bin_absent_when_unmatched_is_empty(self):
        m = small_manifest()
        ids = [n["id"] for n in cb.build_canvas(m)["nodes"]]
        self.assertNotIn(cb.node_id(SLUG, "bin"), ids)

    def test_bin_present_and_below_root_when_non_empty(self):
        m = small_manifest(with_unmatched=True)
        canvas = cb.build_canvas(m)
        by_id = {n["id"]: n for n in canvas["nodes"]}
        bin_node = by_id[cb.node_id(SLUG, "bin")]
        root = by_id[cb.node_id(SLUG, "root")]
        self.assertEqual(bin_node["y"], root["y"] + root["height"] + cb.SIDE_GAP)
        self.assertEqual(bin_node["x"], root["x"])
        self.assertIn("an orphan highlight", bin_node["text"])
        self.assertEqual(validate_canvas(canvas), [])


class CardTextTest(unittest.TestCase):
    def test_projection_shape(self):
        m = small_manifest()
        claim = m["claims"][0]
        text = cb.card_text(claim)
        self.assertTrue(text.startswith("# Retirement is a cash-flow problem\n"))
        # the whole cite line renders italic, quote included
        self.assertIn("\n*↳ cite: Ch 1 — “cash flow, not a number”*", text)
        self.assertNotIn("— JT —", text)

    def test_cite_line_is_wrapped_in_italics(self):
        m = small_manifest()
        line = cb.cite_line(m["claims"][0])
        self.assertTrue(line.startswith("*"))
        self.assertTrue(line.endswith("*"))
        self.assertIn("↳ cite:", line)

    def test_flags_prefix_the_title(self):
        m = small_manifest()
        m["claims"][0]["jt"]["flags"] = ["⭐", "\U0001f525"]
        text = cb.card_text(m["claims"][0])
        self.assertTrue(text.startswith("# ⭐\U0001f525 Retirement is a cash-flow problem"))

    def test_overlay_section_only_when_there_is_overlay(self):
        m = small_manifest()
        claim = m["claims"][0]
        self.assertNotIn(cb.JT_SEP, cb.card_text(claim))
        claim["jt"]["stance"] = "agree"
        claim["jt"]["notes"] = ["this matches my 2019 spreadsheet"]
        claim["jt"]["highlights"] = [
            M.new_highlight("hl-1", "https://readwise.io/x/1", "not a number", "✅ yes")
        ]
        text = cb.card_text(claim)
        self.assertIn(cb.JT_SEP, text)
        source, _, overlay = text.rpartition(cb.JT_SEP)
        self.assertNotIn("2019 spreadsheet", source)
        self.assertIn("✅ Agree", overlay)
        self.assertIn("- this matches my 2019 spreadsheet", overlay)
        self.assertIn("- “not a number” — ✅ yes", overlay)

    def test_body_override_replaces_body_md(self):
        m = small_manifest()
        claim = m["claims"][0]
        claim["jt"]["body_override"] = "JT's own words, kept exactly."
        text = cb.card_text(claim)
        self.assertIn("JT's own words, kept exactly.", text)
        self.assertNotIn(LOREM, text)

    def test_cite_url_renders_a_live_link(self):
        m = small_manifest()
        claim = m["claims"][0]
        claim["cite"]["url"] = "https://readwise.io/open/123"
        self.assertIn("[link](https://readwise.io/open/123)", cb.card_text(claim))


class WriteCanvasTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="dsr-write-")
        self.addCleanup(shutil.rmtree, self.dir, True)

    def test_write_records_hash_and_stays_fresh(self):
        m = small_manifest()
        path = cb.write_canvas(m, cb.build_canvas(m), self.dir)
        self.assertEqual(os.path.basename(path), SLUG + ".canvas")
        self.assertEqual(m["canvas_last_written_sha256"], M.canvas_hash(path))
        self.assertTrue(M.freshness_ok(m, path))
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(" ")
        self.assertFalse(M.freshness_ok(m, path))

    def test_written_file_reloads_as_the_same_canvas(self):
        m = small_manifest(with_unmatched=True)
        canvas = cb.build_canvas(m)
        path = cb.write_canvas(m, canvas, self.dir)
        self.assertEqual(cb.read_canvas(path), canvas)
        self.assertEqual([n for n in os.listdir(self.dir) if n.startswith(".tmp-")], [])


if __name__ == "__main__":
    unittest.main()
