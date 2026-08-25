"""Tests for validate.py — one seeded violation per class, plus a clean canvas."""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

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
