"""Tests for canvas_parse.py — reading JT's work back off the canvas."""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import canvas_build as cb  # noqa: E402
import canvas_parse as cp  # noqa: E402
import manifest as M  # noqa: E402

SLUG = "control-your-retirement-destiny"

BODY_A = ("**Claim** Retirement is a stream of cash flows, not a lump sum.\n\n"
          "**Reasoning** Each year's spending has to come out of some account.")
BODY_B = "**Support** A worked example across three account types."
BODY_C = "**Qualification** The effect shrinks after the first decade."
BODY_D = "**Claim** Which account you draw from beats which bracket you land in."


def demo_manifest():
    m = M.new_manifest(
        SLUG,
        {"title": "Control Your Retirement Destiny", "author": "Dana Anspach"},
        # half-open: block_end is exclusive
        [{"idx": 0, "title": "Ch 1 — Cash Flow", "block_start": 0, "block_end": 41},
         {"idx": 1, "title": "Ch 2 — Taxes", "block_start": 41, "block_end": 90}],
    )
    m["claims"] = [
        M.new_claim("c-0001", "Retirement is a cash-flow problem", 0, "root", 0,
                    locator="Ch 1", block_range=[2, 9], anchor_block=2,
                    anchor_phrase="cash flow, not a number", body_md=BODY_A),
        M.new_claim("c-0002", "Sequence risk dominates early years", 0, "c-0001", 0,
                    locator="Ch 1 §2", block_range=[10, 18], anchor_block=10,
                    anchor_phrase="the order of returns", body_md=BODY_B),
        M.new_claim("c-0003", "A bad first decade is unrecoverable", 0, "c-0001", 1,
                    locator="Ch 1 §3", block_range=[19, 24], anchor_block=19,
                    anchor_phrase="the first ten years", body_md=BODY_C),
        M.new_claim("c-0004", "Tax location beats tax rate", 1, "root", 0,
                    locator="Ch 2", block_range=[45, 60], anchor_block=45,
                    anchor_phrase="which account, not which rate", body_md=BODY_D),
    ]
    M.validate(m)
    return m


def clone(canvas):
    return json.loads(json.dumps(canvas))


def node_of(canvas, claim_id, slug=SLUG):
    ident = cb.claim_node_id(slug, claim_id)
    for node in canvas["nodes"]:
        if node["id"] == ident:
            return node
    raise AssertionError("no node for %s" % claim_id)


class LeadingFlagTest(unittest.TestCase):
    def test_every_flag_token(self):
        for token in ("⭐", "\U0001f525", "⏭️", "❓"):
            flags, unknown, rest = cp.split_leading_flags(token + " Title")
            self.assertEqual(flags, [token])
            self.assertEqual(unknown, [])
            self.assertEqual(rest, "Title")

    def test_bare_skip_glyph_is_canonicalised(self):
        flags, _unknown, rest = cp.split_leading_flags("⏭ Title")
        self.assertEqual(flags, ["⏭️"])
        self.assertEqual(rest, "Title")

    def test_variation_selector_after_a_flag_is_absorbed(self):
        flags, unknown, rest = cp.split_leading_flags("⭐️ Title")
        self.assertEqual(flags, ["⭐"])
        self.assertEqual(unknown, [])
        self.assertEqual(rest, "Title")

    def test_several_flags_and_dedupe(self):
        flags, _unknown, rest = cp.split_leading_flags("⭐\U0001f525⭐ Title")
        self.assertEqual(flags, ["⭐", "\U0001f525"])
        self.assertEqual(rest, "Title")

    def test_emoji_later_in_the_line_is_prose(self):
        flags, unknown, rest = cp.split_leading_flags("Title with ⭐ inside")
        self.assertEqual(flags, [])
        self.assertEqual(unknown, [])
        self.assertEqual(rest, "Title with ⭐ inside")


class FlagParseTest(unittest.TestCase):
    def test_flag_in_the_title_line(self):
        m = demo_manifest()
        canvas = clone(cb.build_canvas(m))
        node = node_of(canvas, "c-0001")
        node["text"] = node["text"].replace(
            "# Retirement", "# ⭐\U0001f525 Retirement", 1)
        overlay = cp.parse_overlay(m, canvas)
        self.assertEqual(overlay["flags"]["c-0001"], ["⭐", "\U0001f525"])
        self.assertEqual(overlay["flags"]["c-0002"], [])
        self.assertEqual(overlay["body_overrides"], {})
        self.assertEqual(overlay["warnings"], [])

    def test_flag_on_the_second_non_empty_line(self):
        m = demo_manifest()
        canvas = clone(cb.build_canvas(m))
        node = node_of(canvas, "c-0002")
        lines = node["text"].split("\n")
        lines[2] = "❓ " + lines[2]
        node["text"] = "\n".join(lines)
        overlay = cp.parse_overlay(m, canvas)
        self.assertEqual(overlay["flags"]["c-0002"], ["❓"])
        # the flag is stripped before the body is compared, so no false override
        self.assertNotIn("c-0002", overlay["body_overrides"])

    def test_unknown_emoji_in_the_title_warns_and_is_not_a_flag(self):
        m = demo_manifest()
        canvas = clone(cb.build_canvas(m))
        node = node_of(canvas, "c-0003")
        node["text"] = node["text"].replace("# A bad", "# \U0001f984 A bad", 1)
        overlay = cp.parse_overlay(m, canvas)
        self.assertEqual(overlay["flags"]["c-0003"], [])
        warnings = [w for w in overlay["warnings"] if w.startswith("c-0003:")]
        self.assertEqual(len(warnings), 1)
        self.assertIn("unrecognised marker", warnings[0])
        self.assertIn("\U0001f984", warnings[0])

    def test_stance_emoji_in_the_title_is_not_a_flag(self):
        m = demo_manifest()
        canvas = clone(cb.build_canvas(m))
        node = node_of(canvas, "c-0004")
        node["text"] = node["text"].replace("# Tax", "# ✅ Tax", 1)
        overlay = cp.parse_overlay(m, canvas)
        self.assertEqual(overlay["flags"]["c-0004"], [])
        self.assertTrue(any("unrecognised marker" in w for w in overlay["warnings"]))

    def test_clean_canvas_parses_to_nothing(self):
        m = demo_manifest()
        overlay = cp.parse_overlay(m, cb.build_canvas(m))
        self.assertEqual(overlay["pruned"], [])
        self.assertEqual(overlay["title_overrides"], {})
        self.assertEqual(overlay["body_overrides"], {})
        self.assertEqual(overlay["moved"], {})
        self.assertEqual(overlay["alien_nodes"], [])
        self.assertEqual(overlay["warnings"], [])
        self.assertEqual(set(overlay["flags"]), {"c-0001", "c-0002", "c-0003", "c-0004"})
        self.assertTrue(all(v == [] for v in overlay["flags"].values()))


class PruneTest(unittest.TestCase):
    def test_deleted_node_is_pruned(self):
        m = demo_manifest()
        canvas = clone(cb.build_canvas(m))
        target = cb.claim_node_id(SLUG, "c-0003")
        canvas["nodes"] = [n for n in canvas["nodes"] if n["id"] != target]
        canvas["edges"] = [e for e in canvas["edges"]
                           if target not in (e["fromNode"], e["toNode"])]
        overlay = cp.parse_overlay(m, canvas)
        self.assertEqual(overlay["pruned"], ["c-0003"])
        cp.apply_overlay(m, overlay)
        self.assertTrue(m["claims"][2]["jt"]["pruned"])
        rebuilt = cb.build_canvas(m, existing=canvas)
        self.assertNotIn(target, [n["id"] for n in rebuilt["nodes"]])

    def test_pruning_is_idempotent(self):
        m = demo_manifest()
        canvas = clone(cb.build_canvas(m))
        target = cb.claim_node_id(SLUG, "c-0003")
        canvas["nodes"] = [n for n in canvas["nodes"] if n["id"] != target]
        cp.apply_overlay(m, cp.parse_overlay(m, canvas))
        second = cb.build_canvas(m, existing=canvas)
        overlay = cp.parse_overlay(m, second)
        self.assertEqual(overlay["pruned"], ["c-0003"])
        self.assertTrue(m["claims"][2]["jt"]["pruned"])


class BodyOverrideTest(unittest.TestCase):
    def test_body_edit_is_captured_verbatim(self):
        m = demo_manifest()
        canvas = clone(cb.build_canvas(m))
        node = node_of(canvas, "c-0002")
        edited = ("**Support** JT's rewrite.\n\n"
                  "  Indented line, two trailing spaces preserved  \n"
                  "> and a quote with an em dash — right here.")
        node["text"] = node["text"].replace(BODY_B, edited, 1)
        overlay = cp.parse_overlay(m, canvas)
        self.assertEqual(overlay["body_overrides"], {"c-0002": edited})
        cp.apply_overlay(m, overlay)
        self.assertEqual(m["claims"][1]["jt"]["body_override"], edited)
        self.assertIn(edited, cb.card_text(m["claims"][1]))

    def test_override_is_idempotent_on_reparse(self):
        m = demo_manifest()
        canvas = clone(cb.build_canvas(m))
        node = node_of(canvas, "c-0002")
        node["text"] = node["text"].replace(BODY_B, "rewritten", 1)
        cp.apply_overlay(m, cp.parse_overlay(m, canvas))
        rebuilt = cb.build_canvas(m, existing=canvas)
        self.assertEqual(cp.parse_overlay(m, rebuilt)["body_overrides"], {})

    def test_overlay_section_is_not_mistaken_for_a_body_edit(self):
        m = demo_manifest()
        m["claims"][0]["jt"]["stance"] = "agree"
        m["claims"][0]["jt"]["notes"] = ["matches my own numbers"]
        canvas = cb.build_canvas(m)
        overlay = cp.parse_overlay(m, canvas)
        self.assertEqual(overlay["body_overrides"], {})
        self.assertEqual(overlay["warnings"], [])

    def test_cite_edit_is_surfaced_as_a_warning(self):
        m = demo_manifest()
        canvas = clone(cb.build_canvas(m))
        node = node_of(canvas, "c-0004")
        node["text"] = node["text"].replace("↳ cite: Ch 2", "↳ cite: Chapter 2", 1)
        overlay = cp.parse_overlay(m, canvas)
        self.assertTrue(any("cite line edited" in w for w in overlay["warnings"]))


class TitleOverrideTest(unittest.TestCase):
    """A title JT rewrote is his material: kept verbatim, not just warned about."""

    def test_title_edit_is_captured_not_warned(self):
        m = demo_manifest()
        canvas = clone(cb.build_canvas(m))
        node = node_of(canvas, "c-0001")
        node["text"] = node["text"].replace(
            "# Retirement is a cash-flow problem",
            "# Retirement is really a CASH-FLOW problem", 1)
        overlay = cp.parse_overlay(m, canvas)
        self.assertEqual(overlay["title_overrides"],
                         {"c-0001": "Retirement is really a CASH-FLOW problem"})
        self.assertEqual([w for w in overlay["warnings"] if "title" in w], [])

    def test_title_edit_survives_a_rebuild_with_flags_reprefixed(self):
        m = demo_manifest()
        canvas = clone(cb.build_canvas(m))
        node = node_of(canvas, "c-0001")
        node["text"] = node["text"].replace(
            "# Retirement is a cash-flow problem",
            "# ⭐❓ Retirement — my own words for it", 1)
        overlay = cp.parse_overlay(m, canvas)
        self.assertEqual(overlay["flags"]["c-0001"], ["⭐", "❓"])
        self.assertEqual(overlay["title_overrides"],
                         {"c-0001": "Retirement — my own words for it"})

        cp.apply_overlay(m, overlay)
        M.validate(m)
        self.assertEqual(m["claims"][0]["jt"]["title_override"],
                         "Retirement — my own words for it")
        # the machine-authored title is untouched underneath
        self.assertEqual(m["claims"][0]["title"], "Retirement is a cash-flow problem")

        rebuilt = cb.build_canvas(m, existing=canvas)
        text = [n for n in rebuilt["nodes"]
                if n["id"] == cb.claim_node_id(SLUG, "c-0001")][0]["text"]
        self.assertTrue(text.startswith("# ⭐❓ Retirement — my own words for it\n"))
        self.assertNotIn("cash-flow problem", text.split("\n")[0])

    def test_title_override_is_idempotent_on_reparse(self):
        m = demo_manifest()
        canvas = clone(cb.build_canvas(m))
        node = node_of(canvas, "c-0002")
        node["text"] = node["text"].replace(
            "# Sequence risk dominates early years", "# Order of returns matters", 1)
        cp.apply_overlay(m, cp.parse_overlay(m, canvas))
        rebuilt = cb.build_canvas(m, existing=canvas)
        again = cp.parse_overlay(m, rebuilt)
        self.assertEqual(again["title_overrides"], {})
        self.assertEqual(again["warnings"], [])

    def test_title_and_body_edited_together(self):
        m = demo_manifest()
        canvas = clone(cb.build_canvas(m))
        node = node_of(canvas, "c-0002")
        node["text"] = node["text"].replace(
            "# Sequence risk dominates early years", "# Sequence risk, plainly", 1)
        node["text"] = node["text"].replace(BODY_B, "My paraphrase.", 1)
        overlay = cp.parse_overlay(m, canvas)
        self.assertEqual(overlay["title_overrides"], {"c-0002": "Sequence risk, plainly"})
        self.assertEqual(overlay["body_overrides"], {"c-0002": "My paraphrase."})
        cp.apply_overlay(m, overlay)
        text = cb.card_text(m["claims"][1])
        self.assertTrue(text.startswith("# Sequence risk, plainly\n"))
        self.assertIn("My paraphrase.", text)

    def test_reverting_a_title_on_the_canvas_clears_nothing_unexpectedly(self):
        m = demo_manifest()
        m["claims"][0]["jt"]["title_override"] = "JT's earlier wording"
        canvas = clone(cb.build_canvas(m))
        node = node_of(canvas, "c-0001")
        self.assertTrue(node["text"].startswith("# JT's earlier wording"))
        node["text"] = node["text"].replace(
            "# JT's earlier wording", "# JT's newer wording", 1)
        overlay = cp.parse_overlay(m, canvas)
        self.assertEqual(overlay["title_overrides"], {"c-0001": "JT's newer wording"})

    def test_unedited_title_produces_no_override(self):
        m = demo_manifest()
        overlay = cp.parse_overlay(m, cb.build_canvas(m))
        self.assertEqual(overlay["title_overrides"], {})


class AlienNodeTest(unittest.TestCase):
    def test_hand_added_card_is_listed_and_kept(self):
        m = demo_manifest()
        canvas = clone(cb.build_canvas(m))
        alien = {"id": "aaaabbbbccccdddd", "type": "text",
                 "text": "# My own thought\n\nNot from the book.",
                 "x": -1200, "y": -800, "width": 340, "height": 240}
        canvas["nodes"].append(alien)
        overlay = cp.parse_overlay(m, canvas)
        self.assertEqual(overlay["alien_nodes"], [alien])
        self.assertTrue(any("added by hand" in w for w in overlay["warnings"]))
        rebuilt = cb.build_canvas(m, existing=canvas)
        self.assertIn(alien, rebuilt["nodes"])

    def test_alien_card_is_not_treated_as_a_claim(self):
        m = demo_manifest()
        canvas = clone(cb.build_canvas(m))
        canvas["nodes"].append({"id": "1111222233334444", "type": "text",
                                "text": "# ⭐ my own card", "x": 0, "y": -5000,
                                "width": 340, "height": 220})
        overlay = cp.parse_overlay(m, canvas)
        self.assertEqual(len(overlay["flags"]), 4)
        self.assertEqual(overlay["body_overrides"], {})


class MovedTest(unittest.TestCase):
    def test_moved_geometry_is_reported(self):
        m = demo_manifest()
        canvas = clone(cb.build_canvas(m))
        node = node_of(canvas, "c-0004")
        node["x"], node["y"] = 12345, -678
        overlay = cp.parse_overlay(m, canvas)
        self.assertEqual(list(overlay["moved"]), [node["id"]])
        self.assertEqual(overlay["moved"][node["id"]]["x"], 12345)
        self.assertEqual(overlay["moved"][node["id"]]["y"], -678)

    def test_resize_counts_as_moved(self):
        m = demo_manifest()
        canvas = clone(cb.build_canvas(m))
        node = node_of(canvas, "c-0001")
        node["height"] = node["height"] + 200
        overlay = cp.parse_overlay(m, canvas)
        self.assertIn(node["id"], overlay["moved"])
        self.assertEqual(overlay["moved"][node["id"]]["height"], node["height"])


class RoundTripTest(unittest.TestCase):
    """Build, mutate the canvas exactly as JT would, parse, apply, rebuild."""

    def test_every_user_change_survives_a_rebuild(self):
        m = demo_manifest()
        canvas = cb.build_canvas(m)
        working = clone(canvas)

        # 1. moved a card
        moved_node = node_of(working, "c-0001")
        moved_node["x"], moved_node["y"] = 4000, -1500
        moved_xy = (4000, -1500)

        # 2. flagged two cards
        node_of(working, "c-0002")["text"] = node_of(working, "c-0002")["text"].replace(
            "# Sequence", "# ⭐ Sequence", 1)
        node_of(working, "c-0004")["text"] = node_of(working, "c-0004")["text"].replace(
            "# Tax", "# \U0001f525❓ Tax", 1)

        # 3. rewrote a body, and retitled a different card
        rewritten = "**Support** JT's rewrite — three accounts, one worked case."
        node_of(working, "c-0002")["text"] = node_of(working, "c-0002")["text"].replace(
            BODY_B, rewritten, 1)
        retitled = "Tax location — the account matters more"
        node_of(working, "c-0004")["text"] = node_of(working, "c-0004")["text"].replace(
            "Tax location beats tax rate", retitled, 1)

        # 4. deleted a card
        gone = cb.claim_node_id(SLUG, "c-0003")
        working["nodes"] = [n for n in working["nodes"] if n["id"] != gone]
        working["edges"] = [e for e in working["edges"]
                            if gone not in (e["fromNode"], e["toNode"])]

        # 5. added a card of his own
        alien = {"id": "9999888877776666", "type": "text",
                 "text": "# Ask the CPA about this\n\nRoth conversion window?",
                 "x": -900, "y": 2400, "width": 340, "height": 220, "color": "3"}
        working["nodes"].append(alien)

        overlay = cp.parse_overlay(m, working)
        self.assertEqual(overlay["flags"]["c-0002"], ["⭐"])
        self.assertEqual(overlay["flags"]["c-0004"], ["\U0001f525", "❓"])
        self.assertEqual(overlay["pruned"], ["c-0003"])
        self.assertEqual(overlay["body_overrides"], {"c-0002": rewritten})
        self.assertEqual(overlay["title_overrides"], {"c-0004": retitled})
        self.assertEqual(overlay["alien_nodes"], [alien])
        self.assertIn(cb.claim_node_id(SLUG, "c-0001"), overlay["moved"])

        cp.apply_overlay(m, overlay)
        M.validate(m)
        rebuilt = cb.build_canvas(m, existing=working)

        by_id = dict((n["id"], n) for n in rebuilt["nodes"])
        # move survived
        kept = by_id[cb.claim_node_id(SLUG, "c-0001")]
        self.assertEqual((kept["x"], kept["y"]), moved_xy)
        # flags survived, and are projected back onto the titles
        self.assertTrue(by_id[cb.claim_node_id(SLUG, "c-0002")]["text"]
                        .startswith("# ⭐ Sequence risk dominates early years"))
        self.assertTrue(by_id[cb.claim_node_id(SLUG, "c-0004")]["text"]
                        .startswith("# \U0001f525❓ "))
        # body edit survived verbatim
        self.assertIn(rewritten, by_id[cb.claim_node_id(SLUG, "c-0002")]["text"])
        self.assertNotIn(BODY_B, by_id[cb.claim_node_id(SLUG, "c-0002")]["text"])
        # retitle survived, flags and all
        self.assertTrue(by_id[cb.claim_node_id(SLUG, "c-0004")]["text"]
                        .startswith("# \U0001f525❓ " + retitled + "\n"))
        # deletion survived
        self.assertNotIn(gone, by_id)
        # his own card survived
        self.assertEqual(by_id[alien["id"]], alien)

        # and a second pass over the rebuilt canvas changes nothing further
        again = cp.parse_overlay(m, rebuilt)
        self.assertEqual(again["body_overrides"], {})
        self.assertEqual(again["title_overrides"], {})
        self.assertEqual(again["flags"]["c-0002"], ["⭐"])
        self.assertEqual(again["flags"]["c-0004"], ["\U0001f525", "❓"])
        self.assertEqual(again["pruned"], ["c-0003"])
        self.assertEqual(again["alien_nodes"], [alien])
        # the only standing warning is his own card, which is expected forever
        self.assertEqual([w for w in again["warnings"] if alien["id"] not in w], [])

    def test_flags_are_cleared_when_removed_from_the_canvas(self):
        m = demo_manifest()
        m["claims"][0]["jt"]["flags"] = ["⭐"]
        canvas = clone(cb.build_canvas(m))
        node = node_of(canvas, "c-0001")
        node["text"] = node["text"].replace("# ⭐ Retirement", "# Retirement", 1)
        cp.apply_overlay(m, cp.parse_overlay(m, canvas))
        self.assertEqual(m["claims"][0]["jt"]["flags"], [])


class OverviewOverlayTest(unittest.TestCase):
    """Overview cards (chapter_idx -1) take triage exactly like chapter cards."""

    def overview_manifest(self):
        m = demo_manifest()
        m["claims"].extend([
            M.new_claim("o-0001", "The book's central question", -1, "root", 0,
                        body_md="How do you turn a portfolio into a paycheque?"),
            M.new_claim("o-0002", "The thesis in one line", -1, "root", 1,
                        rel="consequence",
                        body_md="Plan the cash flows first; the portfolio follows."),
        ])
        M.validate(m)
        return m

    def test_clean_overview_canvas_parses_to_nothing(self):
        m = self.overview_manifest()
        overlay = cp.parse_overlay(m, cb.build_canvas(m))
        self.assertEqual(overlay["warnings"], [])
        self.assertEqual(overlay["body_overrides"], {})
        self.assertEqual(overlay["pruned"], [])
        self.assertIn("o-0001", overlay["flags"])
        self.assertIn("o-0002", overlay["flags"])

    def test_flag_and_body_edit_on_an_overview_card(self):
        m = self.overview_manifest()
        canvas = clone(cb.build_canvas(m))
        node = node_of(canvas, "o-0001")
        node["text"] = node["text"].replace("# The book's", "# ❓ The book's", 1)
        node["text"] = node["text"].replace(
            "How do you turn a portfolio into a paycheque?",
            "JT: how do I turn this into a paycheque?", 1)
        overlay = cp.parse_overlay(m, canvas)
        self.assertEqual(overlay["flags"]["o-0001"], ["❓"])
        self.assertEqual(overlay["body_overrides"]["o-0001"],
                         "JT: how do I turn this into a paycheque?")
        cp.apply_overlay(m, overlay)
        M.validate(m)
        rebuilt = cb.build_canvas(m, existing=canvas)
        text = [n for n in rebuilt["nodes"]
                if n["id"] == cb.claim_node_id(SLUG, "o-0001")][0]["text"]
        self.assertTrue(text.startswith("# ❓ The book's central question"))
        self.assertIn("JT: how do I turn this into a paycheque?", text)

    def test_deleting_an_overview_card_prunes_it(self):
        m = self.overview_manifest()
        canvas = clone(cb.build_canvas(m))
        gone = cb.claim_node_id(SLUG, "o-0002")
        canvas["nodes"] = [n for n in canvas["nodes"] if n["id"] != gone]
        canvas["edges"] = [e for e in canvas["edges"]
                           if gone not in (e["fromNode"], e["toNode"])]
        overlay = cp.parse_overlay(m, canvas)
        self.assertEqual(overlay["pruned"], ["o-0002"])
        cp.apply_overlay(m, overlay)
        rebuilt = cb.build_canvas(m, existing=canvas)
        self.assertNotIn(gone, [n["id"] for n in rebuilt["nodes"]])
        # the Overview group survives with the remaining card
        self.assertIn(cb.node_id(SLUG, "group:-1"), [n["id"] for n in rebuilt["nodes"]])

    def test_group_and_edge_ids_are_not_alien(self):
        m = self.overview_manifest()
        canvas = cb.build_canvas(m)
        overlay = cp.parse_overlay(m, canvas)
        self.assertEqual(overlay["alien_nodes"], [])
        known = cp.known_node_ids(m)
        self.assertIn(cb.node_id(SLUG, "group:-1"), known)
        for edge in canvas["edges"]:
            self.assertIn(edge["id"], known)


class SplitCardTest(unittest.TestCase):
    def test_card_with_no_body(self):
        claim = M.new_claim("c-9", "Bare claim", 0, "root", 0,
                            locator="Ch 9", anchor_phrase="phrase")
        parts = cp.split_card(cb.card_text(claim))
        self.assertEqual(parts["title"], "Bare claim")
        self.assertEqual(parts["body"], "")
        self.assertTrue(parts["cite"].startswith("↳ cite: Ch 9"))

    def test_card_with_no_cite(self):
        claim = M.new_claim("c-9", "No cite", 0, "root", 0, body_md="Some body.")
        parts = cp.split_card(cb.card_text(claim))
        self.assertEqual(parts["cite"], "")
        self.assertEqual(parts["body"], "Some body.")

    def test_overlay_block_is_separated(self):
        claim = M.new_claim("c-9", "With overlay", 0, "root", 0,
                            body_md="Body.", stance="dispute", notes=["nope"])
        parts = cp.split_card(cb.card_text(claim))
        self.assertTrue(parts["has_jt"])
        self.assertEqual(parts["body"], "Body.")
        self.assertIn("❌ Dispute", parts["jt"])

    def test_body_containing_a_horizontal_rule_survives(self):
        body = "First part.\n\n---\n\nSecond part."
        claim = M.new_claim("c-9", "Ruled", 0, "root", 0, body_md=body)
        parts = cp.split_card(cb.card_text(claim))
        self.assertEqual(parts["body"], body)
        self.assertFalse(parts["has_jt"])


if __name__ == "__main__":
    unittest.main()
