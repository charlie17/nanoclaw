"""Tests for slice.py's inter-block list items and the gap-text audit.

These cover content that lives OUTSIDE the ``<p>`` blocks: ``<li>`` elements
(surfaced as bullets under their anchoring block) and everything else (reported
by the audit so a build can say what it could not see).

A separate file from test_slice.py on purpose — the p-block slicing contract is
unchanged and its tests must stay untouched.
"""

import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import slice as slicer  # noqa: E402

# Blocks 0-2 are chapter 0, blocks 3-4 chapter 1.  The gap after block 1 holds
# an ordinary list; the gap after block 2 (chapter 0's LAST block) holds a list
# whose content belongs, by attribution, to chapter 0 even though chapter 1
# starts at the very next block.
DOC = (
    "<ul><li>Front matter item</li></ul>"
    '<p data-rw-epub-toc="c1">Chapter One</p>'
    "<p>The author opens with a framing claim about cash flow.</p>"
    "<ul>"
    "  <li>First supporting point</li>"
    "  <li>Second supporting point"
    "    <ul><li>Nested qualification</li><li>Another nested one</li></ul>"
    "  </li>"
    "  <li>Third supporting point</li>"
    "</ul>"
    "<p>A closing paragraph for the first chapter.</p>"
    "<ul><li>Item sitting in the seam before chapter two</li></ul>"
    '<p data-rw-epub-toc="c2">Chapter Two</p>'
    "<p>The second chapter changes the subject entirely.</p>"
    "<ul><li>Trailing item after the very last block</li></ul>"
)


class InterBlockItemsTest(unittest.TestCase):
    def setUp(self):
        self.html = DOC
        self.blocks = slicer.slice_blocks(self.html)
        self.chapters = slicer.chapters(self.html, self.blocks)
        self.items = slicer.inter_block_items(self.html, self.blocks)

    def test_block_slicing_is_unchanged_by_the_lists(self):
        # Five <p> blocks; every one reproduces byte-for-byte from its offsets.
        self.assertEqual(len(self.blocks), 5)
        for block in self.blocks:
            fragment = slicer.block_html(self.html, block)
            self.assertTrue(fragment.startswith("<p"))
            self.assertTrue(fragment.endswith("</p>"))
            self.assertEqual(self.html[block["start"]:block["end"]], fragment)

    def test_items_before_the_first_block_are_keyed_minus_one(self):
        self.assertEqual(self.items[-1], ["Front matter item"])

    def test_items_attribute_to_the_nearest_preceding_block(self):
        self.assertEqual(
            self.items[1],
            [
                "First supporting point",
                "Second supporting point",
                "Nested qualification",
                "Another nested one",
                "Third supporting point",
            ],
        )

    def test_nested_list_is_flattened_in_document_order_without_duplication(self):
        flat = self.items[1]
        # the outer item carries its own text only — the nested text is not
        # repeated inside it
        self.assertEqual(flat[1], "Second supporting point")
        self.assertIn("Nested qualification", flat)
        self.assertEqual(flat.count("Nested qualification"), 1)

    def test_trailing_items_after_the_last_block(self):
        last = self.blocks[-1]["i"]
        self.assertEqual(self.items[last], ["Trailing item after the very last block"])

    def test_gap_between_chapters_belongs_to_the_preceding_block(self):
        self.assertEqual(
            self.items[2], ["Item sitting in the seam before chapter two"]
        )

    def test_a_document_with_no_list_items(self):
        html = "<p>One</p><p>Two</p>"
        blocks = slicer.slice_blocks(html)
        self.assertEqual(slicer.inter_block_items(html, blocks), {})

    def test_no_blocks_at_all(self):
        html = "<ul><li>Orphan item</li></ul>"
        self.assertEqual(slicer.inter_block_items(html, []), {-1: ["Orphan item"]})

    def test_unclosed_item_is_still_captured(self):
        html = "<p>Lead in.</p><ul><li>Never closed"
        blocks = slicer.slice_blocks(html)
        self.assertEqual(slicer.inter_block_items(html, blocks), {0: ["Never closed"]})

    def test_entities_and_whitespace_in_items(self):
        html = "<p>Lead.</p><ul><li>  Rock  &amp;\n roll  </li></ul>"
        blocks = slicer.slice_blocks(html)
        self.assertEqual(slicer.inter_block_items(html, blocks), {0: ["Rock & roll"]})

    def test_inline_markup_inside_an_item_does_not_split_a_word(self):
        html = "<p>Lead.</p><ul><li>catastroph<i>e</i> theory</li></ul>"
        blocks = slicer.slice_blocks(html)
        self.assertEqual(
            slicer.inter_block_items(html, blocks), {0: ["catastrophe theory"]}
        )


class ItemSpanningAnAnchorParagraphTest(unittest.TestCase):
    """An ``<li>`` may legally wrap a ``<p>`` block — calibre emits this shape.

    Every gap used to be parsed on its own, so the trailing ``</li>`` popped an
    empty stack and everything after the nested paragraph was dropped from the
    items; the audit skipped it too, because its own stack knew the ``li`` was
    still open. The text existed in the source and reached no surface at all.
    """

    HTML = (
        "<p>Lead in.</p>"
        "<ul><li>before<p>inside</p>after</li></ul>"
        "<p>Tail.</p>"
    )

    def setUp(self):
        self.blocks = slicer.slice_blocks(self.HTML)
        self.items = slicer.inter_block_items(self.HTML, self.blocks)

    def test_the_nested_paragraph_is_still_its_own_block(self):
        self.assertEqual(len(self.blocks), 3)
        self.assertEqual(slicer.block_text(self.HTML, self.blocks[1]), "inside")

    def test_both_sides_of_the_nested_paragraph_are_attributed(self):
        self.assertEqual(self.items, {0: ["before after"]})

    def test_the_item_reaches_chapter_text(self):
        chapters = slicer.chapters(self.HTML, self.blocks)
        text = slicer.chapter_text(self.HTML, self.blocks, chapters[0])
        self.assertIn("    %s before after" % slicer.ITEM_BULLET, text)

    def test_the_recovered_tail_is_not_also_counted_by_the_audit(self):
        audit = slicer.gap_text_audit(self.HTML, self.blocks)
        self.assertEqual(audit["total_chars"], 0)


class MixedCaseListTagsTest(unittest.TestCase):
    """``<Li>`` is a valid spelling; a case-sensitive fast path skipped it."""

    HTML = "<p>Lead.</p><UL><Li>Mixed case item</Li></UL>"

    def test_a_mixed_case_item_is_captured(self):
        blocks = slicer.slice_blocks(self.HTML)
        self.assertEqual(
            slicer.inter_block_items(self.HTML, blocks), {0: ["Mixed case item"]}
        )

    def test_a_mixed_case_item_is_not_double_counted_by_the_audit(self):
        blocks = slicer.slice_blocks(self.HTML)
        audit = slicer.gap_text_audit(self.HTML, blocks)
        self.assertEqual(audit["total_chars"], 0)


class ChapterTextWithItemsTest(unittest.TestCase):
    def setUp(self):
        self.html = DOC
        self.blocks = slicer.slice_blocks(self.html)
        self.chapters = slicer.chapters(self.html, self.blocks)

    def test_bullets_render_under_their_anchoring_block(self):
        text = slicer.chapter_text(self.html, self.blocks, self.chapters[0])
        lines = text.split("\n")
        anchor = lines.index(
            "[0001] The author opens with a framing claim about cash flow."
        )
        self.assertEqual(lines[anchor + 1], "    • First supporting point")
        self.assertEqual(lines[anchor + 2], "    • Second supporting point")
        self.assertEqual(lines[anchor + 3], "    • Nested qualification")

    def test_bullets_carry_no_block_index_of_their_own(self):
        text = slicer.chapter_text(self.html, self.blocks, self.chapters[0])
        for line in text.split("\n"):
            if line.startswith("    •"):
                self.assertNotIn("[", line)

    def test_seam_items_stay_with_the_preceding_chapter(self):
        first = slicer.chapter_text(self.html, self.blocks, self.chapters[0])
        second = slicer.chapter_text(self.html, self.blocks, self.chapters[1])
        seam = "Item sitting in the seam before chapter two"
        self.assertIn(seam, first)
        self.assertNotIn(seam, second)

    def test_front_matter_items_open_the_first_chapter_with_a_cite_marker(self):
        # Items keyed -1 precede every block, so they have no anchor line of
        # their own; the marker names the block a citation must use instead.
        lines = slicer.chapter_text(
            self.html, self.blocks, self.chapters[0]
        ).split("\n")
        self.assertEqual(lines[0], slicer.FRONT_MATTER_ANCHOR % 0)
        self.assertEqual(lines[1], "    • Front matter item")

    def test_front_matter_items_are_rendered_exactly_once(self):
        joined = "\n".join(
            slicer.chapter_text(self.html, self.blocks, chapter)
            for chapter in self.chapters
        )
        self.assertEqual(joined.count("Front matter item"), 1)
        self.assertNotIn(
            "Front matter item",
            slicer.chapter_text(self.html, self.blocks, self.chapters[1]),
        )

    def test_an_explicit_items_mapping_is_honoured(self):
        text = slicer.chapter_text(
            self.html, self.blocks, self.chapters[1], items={3: ["Injected"]}
        )
        self.assertIn("    • Injected", text)


class EmptyBlockOwningItemsTest(unittest.TestCase):
    """An image-only block that owns items still needs an anchor line.

    Without one the bullets float under whatever came before, and extraction
    has no block id to cite for them.
    """

    HTML = (
        "<p>An ordinary opening paragraph.</p>"
        '<p><img src="figure.png"/></p>'
        "<ul><li>The figure caption lives in a list</li></ul>"
        "<p>A closing paragraph.</p>"
    )

    def setUp(self):
        self.blocks = slicer.slice_blocks(self.HTML)
        self.chapters = slicer.chapters(self.HTML, self.blocks)
        self.text = slicer.chapter_text(self.HTML, self.blocks, self.chapters[0])

    def test_the_block_really_is_empty_and_really_owns_the_item(self):
        self.assertEqual(slicer.block_text(self.HTML, self.blocks[1]), "")
        self.assertEqual(
            slicer.inter_block_items(self.HTML, self.blocks),
            {1: ["The figure caption lives in a list"]},
        )

    def test_the_anchor_line_is_emitted_above_the_bullets(self):
        lines = self.text.split("\n")
        self.assertIn("[0001]", lines)
        self.assertEqual(
            lines[lines.index("[0001]") + 1],
            "    • The figure caption lives in a list",
        )

    def test_an_empty_block_owning_nothing_is_still_omitted(self):
        html = "<p>Opening.</p><p>   </p><p>Closing.</p>"
        blocks = slicer.slice_blocks(html)
        chapters = slicer.chapters(html, blocks)
        self.assertNotIn("[0001]", slicer.chapter_text(html, blocks, chapters[0]))


AUDIT_DOC = (
    "<style>p { color: red; }</style>"
    "<p>The opening paragraph is an ordinary anchorable block.</p>"
    "<table><tr><td>Asset class</td><td>Expected return over the period</td></tr>"
    "<tr><td>Equities</td><td>Seven percent before inflation and fees</td></tr></table>"
    "<p>A paragraph after the table.</p>"
    "<blockquote>Markets can remain irrational longer than you can remain "
    "solvent, as the old line goes.</blockquote>"
    "<ul><li>A list item that inter_block_items already surfaces</li></ul>"
    "<script>var x = 'this should never be counted at all';</script>"
    "<p>The closing paragraph.</p>"
)


class GapTextAuditTest(unittest.TestCase):
    def setUp(self):
        self.html = AUDIT_DOC
        self.blocks = slicer.slice_blocks(self.html)
        self.audit = slicer.gap_text_audit(self.html, self.blocks)

    def test_table_and_blockquote_are_both_reported(self):
        self.assertIn("table", self.audit["by_tag"])
        self.assertIn("blockquote", self.audit["by_tag"])

    def test_char_counts_are_plausible(self):
        self.assertGreater(self.audit["by_tag"]["table"], 60)
        self.assertGreater(self.audit["by_tag"]["blockquote"], 60)
        self.assertEqual(
            self.audit["total_chars"], sum(self.audit["by_tag"].values())
        )

    def test_list_items_are_not_double_counted(self):
        for text in self.audit["samples"]:
            self.assertNotIn("inter_block_items already surfaces", text)
        self.assertNotIn("li", self.audit["by_tag"])
        self.assertNotIn("ul", self.audit["by_tag"])

    def test_style_and_script_content_is_ignored(self):
        joined = " ".join(self.audit["samples"])
        self.assertNotIn("color: red", joined)
        self.assertNotIn("never be counted", joined)

    def test_p_block_text_is_never_counted(self):
        joined = " ".join(self.audit["samples"])
        self.assertNotIn("ordinary anchorable block", joined)
        self.assertNotIn("closing paragraph", joined)

    def test_samples_are_clipped(self):
        self.assertLessEqual(len(self.audit["samples"]), slicer.AUDIT_SAMPLE_COUNT)
        for sample in self.audit["samples"]:
            self.assertLessEqual(len(sample), slicer.AUDIT_SAMPLE_CHARS)

    def test_a_clean_document_audits_to_nothing(self):
        html = "<p>One paragraph.</p><p>And a second one.</p>"
        blocks = slicer.slice_blocks(html)
        audit = slicer.gap_text_audit(html, blocks)
        self.assertEqual(audit["total_chars"], 0)
        self.assertEqual(audit["by_tag"], {})
        self.assertEqual(audit["samples"], [])

    def test_a_table_wrapping_a_p_block_still_attributes_to_table(self):
        html = (
            "<table><tr><td>Leading cell text</td></tr>"
            "<tr><td><p>An anchorable paragraph inside the table.</p></td></tr>"
            "<tr><td>Trailing cell text</td></tr></table>"
        )
        blocks = slicer.slice_blocks(html)
        audit = slicer.gap_text_audit(html, blocks)
        self.assertEqual(len(blocks), 1)
        self.assertIn("table", audit["by_tag"])
        self.assertNotIn("other", audit["by_tag"])


class ItemsCacheTest(unittest.TestCase):
    DOC_ID = "cacheditems"

    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="dsr-items-home-")
        self.addCleanup(shutil.rmtree, self.home, True)
        patcher = mock.patch.dict(
            os.environ, {"HOME": self.home, "USERPROFILE": self.home}
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_save_source_caches_items_and_load_items_restores_int_keys(self):
        meta = slicer.save_source(self.DOC_ID, DOC)
        self.assertEqual(meta["list_item_count"], 8)
        items = slicer.load_items(self.DOC_ID)
        self.assertEqual(items[-1], ["Front matter item"])
        self.assertEqual(items[1][0], "First supporting point")
        for key in items:
            self.assertIsInstance(key, int)

    def test_load_items_missing_cache(self):
        self.assertIsNone(slicer.load_items("nothingcachedhere"))


if __name__ == "__main__":
    unittest.main()
