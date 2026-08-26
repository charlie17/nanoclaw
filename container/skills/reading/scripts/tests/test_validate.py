"""Tests for validate.py — one seeded violation per class, plus a clean canvas."""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import canvas_build  # noqa: E402
from validate import assert_valid, validate_canvas  # noqa: E402


def text_node(ident, x=0, y=0, width=340, height=220, text="# A card\n\nBody.", **extra):
    node = {"id": ident, "type": "text", "text": text,
            "x": x, "y": y, "width": width, "height": height}
    node.update(extra)
    return node


def clean_canvas():
    return {
        "nodes": [
            {"id": "g1", "type": "group", "label": "Chapter 1",
             "x": -40, "y": -40, "width": 1000, "height": 900},
            text_node("n1", 0, 0),
            text_node("n2", 460, 0),
            text_node("n3", 460, 280),
        ],
        "edges": [
            {"id": "e1", "fromNode": "n1", "toNode": "n2",
             "fromSide": "right", "toSide": "left", "toEnd": "arrow"},
            {"id": "e2", "fromNode": "n1", "toNode": "n3",
             "fromSide": "right", "toSide": "left", "toEnd": "arrow"},
        ],
    }


def only(violations, needle):
    return [v for v in violations if needle in v]


class CleanCanvasTest(unittest.TestCase):
    def test_clean_canvas_has_no_violations(self):
        self.assertEqual(validate_canvas(clean_canvas()), [])

    def test_assert_valid_is_silent_on_a_clean_canvas(self):
        assert_valid(clean_canvas())

    def test_empty_canvas_is_valid(self):
        self.assertEqual(validate_canvas({"nodes": [], "edges": []}), [])

    def test_groups_may_overlap_cards_and_each_other(self):
        canvas = clean_canvas()
        canvas["nodes"].append({"id": "g2", "type": "group", "label": "Chapter 2",
                                "x": -40, "y": -40, "width": 1000, "height": 900})
        self.assertEqual(validate_canvas(canvas), [])

    def test_hex_colors_are_legal(self):
        for color in ("#ff0000", "#F0A", "1", "6"):
            canvas = clean_canvas()
            canvas["nodes"][1]["color"] = color
            self.assertEqual(validate_canvas(canvas), [], "color %s" % color)


class DuplicateIdTest(unittest.TestCase):
    def test_duplicate_node_id(self):
        canvas = clean_canvas()
        canvas["nodes"][3]["id"] = "n2"
        violations = validate_canvas(canvas)
        self.assertTrue(only(violations, "duplicate id"))

    def test_duplicate_edge_id(self):
        canvas = clean_canvas()
        canvas["edges"][1]["id"] = "e1"
        self.assertTrue(only(validate_canvas(canvas), "duplicate id"))

    def test_edge_id_colliding_with_a_node_id(self):
        canvas = clean_canvas()
        canvas["edges"][0]["id"] = "n1"
        self.assertTrue(only(validate_canvas(canvas), "duplicate id"))


class DanglingEdgeTest(unittest.TestCase):
    def test_to_node_resolves_to_nothing(self):
        canvas = clean_canvas()
        canvas["edges"][0]["toNode"] = "n-missing"
        violations = validate_canvas(canvas)
        self.assertTrue(only(violations, "resolves to no node"))
        self.assertTrue(only(violations, "toNode"))

    def test_from_node_resolves_to_nothing(self):
        canvas = clean_canvas()
        canvas["edges"][0]["fromNode"] = "nope"
        self.assertTrue(only(validate_canvas(canvas), "fromNode"))

    def test_missing_endpoint_field(self):
        canvas = clean_canvas()
        del canvas["edges"][0]["toNode"]
        self.assertTrue(only(validate_canvas(canvas), "must be a non-empty node id"))

    def test_bad_side_and_end_values(self):
        canvas = clean_canvas()
        canvas["edges"][0]["fromSide"] = "sideways"
        canvas["edges"][0]["toEnd"] = "spike"
        violations = validate_canvas(canvas)
        self.assertTrue(only(violations, "fromSide"))
        self.assertTrue(only(violations, "toEnd"))


class BadColorTest(unittest.TestCase):
    def test_out_of_range_preset(self):
        canvas = clean_canvas()
        canvas["nodes"][1]["color"] = "7"
        self.assertTrue(only(validate_canvas(canvas), "is not a preset"))

    def test_named_color_is_rejected(self):
        canvas = clean_canvas()
        canvas["nodes"][1]["color"] = "red"
        self.assertTrue(only(validate_canvas(canvas), "is not a preset"))

    def test_malformed_hex_is_rejected(self):
        canvas = clean_canvas()
        canvas["nodes"][1]["color"] = "#ff00"
        self.assertTrue(only(validate_canvas(canvas), "is not a preset"))

    def test_non_string_color_is_rejected(self):
        canvas = clean_canvas()
        canvas["nodes"][1]["color"] = 4
        self.assertTrue(only(validate_canvas(canvas), "color must be a string"))

    def test_edge_color_is_checked_too(self):
        canvas = clean_canvas()
        canvas["edges"][0]["color"] = "9"
        self.assertTrue(only(validate_canvas(canvas), "is not a preset"))


class OverlapTest(unittest.TestCase):
    def test_two_cards_in_the_same_place(self):
        canvas = clean_canvas()
        canvas["nodes"][3]["x"] = canvas["nodes"][2]["x"]
        canvas["nodes"][3]["y"] = canvas["nodes"][2]["y"]
        violations = validate_canvas(canvas)
        self.assertEqual(len(only(violations, "overlap:")), 1)
        self.assertIn("n2", violations[0])
        self.assertIn("n3", violations[0])

    def test_partial_overlap_is_caught(self):
        canvas = clean_canvas()
        canvas["nodes"][3]["y"] = canvas["nodes"][2]["y"] + 219  # 1px of overlap
        self.assertEqual(len(only(validate_canvas(canvas), "overlap:")), 1)

    def test_edge_to_edge_touching_is_not_an_overlap(self):
        canvas = clean_canvas()
        canvas["nodes"][3]["y"] = canvas["nodes"][2]["y"] + 220  # exactly flush
        self.assertEqual(only(validate_canvas(canvas), "overlap:"), [])

    def test_group_containing_cards_is_exempt(self):
        canvas = clean_canvas()
        # the group in the fixture already contains every card
        self.assertEqual(only(validate_canvas(canvas), "overlap:"), [])


class JtGeometryExemptionTest(unittest.TestCase):
    """F4: geometry JT chose is exempt from the overlap check, nothing else."""

    def overlapping(self):
        canvas = clean_canvas()
        canvas["nodes"][3]["x"] = canvas["nodes"][2]["x"]
        canvas["nodes"][3]["y"] = canvas["nodes"][2]["y"]
        return canvas

    def test_overlap_fails_without_the_exemption(self):
        violations = validate_canvas(self.overlapping())
        self.assertEqual(len(only(violations, "overlap:")), 1)

    def test_exempting_the_dragged_node_clears_the_overlap(self):
        self.assertEqual(validate_canvas(self.overlapping(), {"n3"}), [])

    def test_exempting_the_other_node_also_clears_it(self):
        self.assertEqual(validate_canvas(self.overlapping(), {"n2"}), [])

    def test_exempting_an_unrelated_node_does_not_clear_it(self):
        violations = validate_canvas(self.overlapping(), {"n1"})
        self.assertEqual(len(only(violations, "overlap:")), 1)

    def test_two_exempt_nodes_may_overlap_each_other(self):
        self.assertEqual(validate_canvas(self.overlapping(), {"n2", "n3"}), [])

    def test_exempt_nodes_still_face_every_other_check(self):
        canvas = self.overlapping()
        canvas["nodes"][3]["color"] = "9"
        canvas["nodes"][3]["text"] = "torn\\nnewline"
        canvas["nodes"][3]["id"] = "n2"
        violations = validate_canvas(canvas, {"n2", "n3"})
        self.assertEqual(only(violations, "overlap:"), [])
        self.assertTrue(only(violations, "is not a preset"))
        self.assertTrue(only(violations, "literal backslash-n"))
        self.assertTrue(only(violations, "duplicate id"))

    def test_exempt_node_with_a_dangling_edge_still_fails(self):
        canvas = self.overlapping()
        canvas["edges"][0]["toNode"] = "ghost"
        violations = validate_canvas(canvas, {"n2", "n3"})
        self.assertTrue(only(violations, "resolves to no node"))

    def test_default_and_empty_set_are_todays_behaviour(self):
        self.assertEqual(len(only(validate_canvas(self.overlapping()), "overlap:")), 1)
        self.assertEqual(
            len(only(validate_canvas(self.overlapping(), set()), "overlap:")), 1)
        self.assertEqual(
            len(only(validate_canvas(self.overlapping(), None), "overlap:")), 1)

    def test_assert_valid_passes_the_exemption_through(self):
        with self.assertRaises(ValueError):
            assert_valid(self.overlapping())
        assert_valid(self.overlapping(), {"n3"})

    def test_a_list_works_as_well_as_a_set(self):
        self.assertEqual(validate_canvas(self.overlapping(), ["n3"]), [])


class OverflowTest(unittest.TestCase):
    """No-scroll rule: a card too short for its text is a lost claim."""

    LONG = ("The author argues that the retirement decision is not a single number "
            "but a sequence of cash flows, each of which has to be sourced from an "
            "account with its own tax treatment, and that treating it as a lump sum "
            "obscures the sequencing problem entirely, which is the whole point.")

    def test_a_too_short_node_is_caught(self):
        canvas = clean_canvas()
        canvas["nodes"][1]["text"] = "# A long card\n\n" + self.LONG
        canvas["nodes"][1]["height"] = 220
        violations = validate_canvas(canvas)
        self.assertTrue(only(violations, "text likely overflows node"))

    def test_a_properly_sized_node_passes(self):
        canvas = clean_canvas()
        text = "# A long card\n\n" + self.LONG
        canvas["nodes"][1]["text"] = text
        canvas["nodes"][1]["height"] = canvas_build.card_height(text)
        # move the neighbours out of the way of the now-taller card
        canvas["nodes"][2]["y"] = 4000
        canvas["nodes"][3]["y"] = 6000
        self.assertEqual(only(validate_canvas(canvas), "text likely overflows"), [])

    def test_builder_sizing_always_satisfies_the_validator(self):
        for text in ("# T\n\nshort.",
                     "# A somewhat longer title that wraps\n\n" + self.LONG,
                     "# T\n\n" + self.LONG * 5,
                     "# T\n\n" + "\n\n".join([self.LONG[:80]] * 6)):
            height = canvas_build.card_height(text)
            self.assertGreaterEqual(height, canvas_build.estimate_height(text),
                                    "builder under-sized: %r" % text[:40])

    def test_jt_resized_nodes_are_exempt_from_overflow(self):
        canvas = clean_canvas()
        canvas["nodes"][1]["text"] = "# A long card\n\n" + self.LONG
        canvas["nodes"][1]["height"] = 220
        self.assertTrue(only(validate_canvas(canvas), "text likely overflows"))
        self.assertEqual(
            only(validate_canvas(canvas, {"n1"}), "text likely overflows"), [])

    def test_a_legacy_length_body_still_gets_a_tall_enough_card(self):
        body = self.LONG * 5          # ~1400 characters
        text = "# A legacy card\n\n" + body + "\n\n↳ cite: Ch 1 — “anchor phrase”"
        height = canvas_build.card_height(text)
        self.assertLessEqual(height, canvas_build.H_MAX)
        self.assertGreaterEqual(height, canvas_build.estimate_height(text))

    def test_a_450_char_body_fits_well_inside_the_cap(self):
        body = (self.LONG * 2)[:450]
        text = "# A typical v2 card\n\n" + body + "\n\n↳ cite: Ch 2 — “anchor”"
        height = canvas_build.card_height(text)
        self.assertGreaterEqual(height, canvas_build.estimate_height(text))
        self.assertLess(height, canvas_build.H_MAX)

    def test_a_cite_url_does_not_inflate_the_card(self):
        plain = "# T\n\nbody\n\n↳ cite: Ch 1 — “anchor”"
        linked = plain + " [link](https://readwise.io/open/%s)" % ("x" * 120)
        self.assertLessEqual(canvas_build.card_height(linked),
                             canvas_build.card_height(plain) + canvas_build.LINE_H * 2)


class LiteralNewlineTest(unittest.TestCase):
    def test_backslash_n_in_node_text(self):
        canvas = clean_canvas()
        canvas["nodes"][1]["text"] = "# A card\\n\\nBody that never wraps."
        violations = validate_canvas(canvas)
        self.assertTrue(only(violations, "literal backslash-n"))

    def test_backslash_n_in_a_group_label(self):
        canvas = clean_canvas()
        canvas["nodes"][0]["label"] = "Chapter\\n1"
        self.assertTrue(only(validate_canvas(canvas), "literal backslash-n"))

    def test_backslash_n_in_an_edge_label(self):
        canvas = clean_canvas()
        canvas["edges"][0]["label"] = "supports\\nbecause"
        self.assertTrue(only(validate_canvas(canvas), "literal backslash-n"))

    def test_real_newlines_are_fine(self):
        canvas = clean_canvas()
        canvas["nodes"][1]["text"] = "# A card\n\nBody that wraps properly."
        self.assertEqual(validate_canvas(canvas), [])


class RequiredFieldTest(unittest.TestCase):
    def test_missing_node_id(self):
        canvas = clean_canvas()
        del canvas["nodes"][1]["id"]
        self.assertTrue(only(validate_canvas(canvas), "id must be a non-empty string"))

    def test_unknown_node_type(self):
        canvas = clean_canvas()
        canvas["nodes"][1]["type"] = "sticky"
        self.assertTrue(only(validate_canvas(canvas), "is not one of"))

    def test_text_node_without_text(self):
        canvas = clean_canvas()
        del canvas["nodes"][1]["text"]
        self.assertTrue(only(validate_canvas(canvas), 'requires a "text" string'))

    def test_file_node_requires_a_path(self):
        canvas = clean_canvas()
        canvas["nodes"][1] = {"id": "f1", "type": "file", "x": 0, "y": 0,
                              "width": 100, "height": 100}
        self.assertTrue(only(validate_canvas(canvas), 'requires a "file" path'))

    def test_link_node_requires_a_url(self):
        canvas = clean_canvas()
        canvas["nodes"][1] = {"id": "l1", "type": "link", "x": 0, "y": 0,
                              "width": 100, "height": 100}
        self.assertTrue(only(validate_canvas(canvas), 'requires a "url"'))

    def test_non_integer_geometry(self):
        canvas = clean_canvas()
        canvas["nodes"][1]["x"] = 12.5
        self.assertTrue(only(validate_canvas(canvas), "x must be an integer"))

    def test_boolean_is_not_an_integer(self):
        canvas = clean_canvas()
        canvas["nodes"][1]["y"] = True
        self.assertTrue(only(validate_canvas(canvas), "y must be an integer"))

    def test_zero_size_node(self):
        canvas = clean_canvas()
        canvas["nodes"][1]["width"] = 0
        self.assertTrue(only(validate_canvas(canvas), "must be positive"))

    def test_bad_background_style(self):
        canvas = clean_canvas()
        canvas["nodes"][0]["backgroundStyle"] = "stretch"
        self.assertTrue(only(validate_canvas(canvas), "backgroundStyle"))


class MalformedCanvasTest(unittest.TestCase):
    def test_not_an_object(self):
        self.assertEqual(validate_canvas([]), ["canvas: expected a JSON object"])

    def test_nodes_not_an_array(self):
        self.assertTrue(only(validate_canvas({"nodes": {}}), "nodes: must be an array"))

    def test_edges_not_an_array(self):
        self.assertTrue(only(validate_canvas({"nodes": [], "edges": 3}),
                             "edges: must be an array"))

    def test_missing_keys_are_treated_as_empty(self):
        self.assertEqual(validate_canvas({}), [])

    def test_assert_valid_raises_with_every_violation(self):
        canvas = clean_canvas()
        canvas["nodes"][3]["id"] = "n2"
        canvas["edges"][0]["color"] = "9"
        with self.assertRaises(ValueError) as ctx:
            assert_valid(canvas)
        message = str(ctx.exception)
        self.assertIn("duplicate id", message)
        self.assertIn("is not a preset", message)


if __name__ == "__main__":
    unittest.main()
