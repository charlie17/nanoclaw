"""Tests for scripts/slice.py — offline, stdlib unittest only."""

from __future__ import annotations

import contextlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import slice as slicer  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures"

EPUB_BLOCK_COUNT = 30
PDF_BLOCK_COUNT = 6

EM_DASH = "—"
E_ACUTE = "é"


def read_fixture(name):
    # newline="" so \n stays \n on Windows: block offsets must be byte-exact.
    with open(str(FIXTURES / name), "r", encoding="utf-8", newline="") as fh:
        return fh.read()


@contextlib.contextmanager
def temp_home():
    with tempfile.TemporaryDirectory() as tmp:
        env = {"HOME": tmp, "USERPROFILE": tmp, "HOMEDRIVE": "", "HOMEPATH": tmp}
        with mock.patch.dict(os.environ, env):
            yield Path(tmp)


class SliceBlocksTests(unittest.TestCase):
    def setUp(self):
        self.html = read_fixture("epub_sample.html")
        self.blocks = slicer.slice_blocks(self.html)

    def test_block_count_and_indices(self):
        self.assertEqual(len(self.blocks), EPUB_BLOCK_COUNT)
        self.assertEqual([b["i"] for b in self.blocks], list(range(EPUB_BLOCK_COUNT)))

    def test_every_block_round_trips_exactly(self):
        for block in self.blocks:
            fragment = self.html[block["start"]:block["end"]]
            self.assertTrue(
                fragment.startswith("<p"),
                "block %d does not start at its opening tag" % block["i"],
            )
            self.assertTrue(
                fragment.endswith("</p>"),
                "block %d does not end at its closing tag" % block["i"],
            )
            # The slice is the literal source text at that exact offset.
            self.assertEqual(self.html.find(fragment, block["start"]), block["start"])
            self.assertEqual(
                self.html[block["start"]:block["start"] + len(fragment)], fragment
            )

    def test_blocks_are_ordered_and_non_overlapping(self):
        previous_end = -1
        for block in self.blocks:
            self.assertGreaterEqual(block["start"], previous_end)
            self.assertGreater(block["end"], block["start"])
            previous_end = block["end"]

    def test_closing_tag_at_column_zero_is_preserved(self):
        fragment = slicer.block_html(self.html, self.blocks[9])
        self.assertTrue(
            fragment.endswith("\n</p>"),
            "the column-zero closing tag was normalized away",
        )
        self.assertIn("sits hard at column zero", fragment)
        # Newline count proves internal whitespace survived untouched.
        self.assertEqual(fragment.count("\n"), 3)

    def test_pre_block_is_never_sliced(self):
        for block in self.blocks:
            self.assertNotIn("pre class", slicer.block_html(self.html, block))

    def test_opening_tag_may_span_a_newline(self):
        matches = [
            b for b in self.blocks
            if "split-open-tag" in slicer.opening_tag(self.html, b)
        ]
        self.assertEqual(len(matches), 1)
        self.assertIn("\n", slicer.opening_tag(self.html, matches[0]))
        self.assertEqual(
            slicer.block_text(self.html, matches[0]),
            "An opening tag whose attributes span a newline.",
        )

    def test_escaped_markup_is_not_treated_as_a_tag(self):
        text = slicer.block_text(self.html, self.blocks[8])
        self.assertEqual(
            text, "Markup like <p> tags & bare entities must survive the round trip."
        )

    def test_pdf_fixture_round_trips(self):
        html = read_fixture("pdf_sample.html")
        blocks = slicer.slice_blocks(html)
        self.assertEqual(len(blocks), PDF_BLOCK_COUNT)
        for block in blocks:
            fragment = html[block["start"]:block["end"]]
            self.assertTrue(fragment.startswith("<p block-type="))
            self.assertTrue(fragment.endswith("</p>"))
        self.assertTrue(slicer.block_html(html, blocks[3]).endswith("\n</p>"))


class BlockTextSeparatorTests(unittest.TestCase):
    """[R33] Whether a stripped tag leaves a space is what a reader sees.

    Deleting every tag with no separator turned "<p>first<br>second</p>" into
    "firstsecond" — it distorts chapter extraction AND stops a Reader highlight
    reading "first second" from matching the block it came from.
    """

    def text_of(self, html):
        return slicer.block_text(html, slicer.slice_blocks(html)[0])

    def test_a_break_tag_separates_words(self):
        self.assertEqual(self.text_of("<p>first<br>second</p>"), "first second")
        self.assertEqual(self.text_of("<p>first<br/>second</p>"), "first second")
        self.assertEqual(self.text_of("<p>first<hr>second</p>"), "first second")

    def test_an_inline_tag_does_not_split_a_word(self):
        self.assertEqual(
            self.text_of("<p>catastroph<i>e</i> theory</p>"), "catastrophe theory"
        )
        self.assertEqual(self.text_of("<p>pre<span>cise</span>ly</p>"), "precisely")
        self.assertEqual(
            self.text_of('<p>a foot<sup>1</sup>note and a <a href="x">link</a></p>'),
            "a foot1note and a link",
        )

    def test_structural_and_inline_markup_side_by_side(self):
        self.assertEqual(
            self.text_of("<p>alpha<span>beta</span><br>gamma</p>"),
            "alphabeta gamma",
        )

    def test_angle_bracket_prose_inside_a_block_survives(self):
        # [R22] the shared tag regex used to eat "< 5 and y >" as one tag.
        self.assertEqual(
            self.text_of("<p>If x < 5 and y > 3 then stop the run.</p>"),
            "If x < 5 and y > 3 then stop the run.",
        )

    def test_a_comment_inside_a_block_is_consumed_whole(self):
        # [R37] matching only to the comment's first ">" leaked the markup
        # inside it back into the text.
        self.assertEqual(
            self.text_of("<p>visible<!-- <b>hidden</b> -->text</p>"),
            "visible text",
        )


class DetectFormatTests(unittest.TestCase):
    def test_epub(self):
        self.assertEqual(slicer.detect_format(read_fixture("epub_sample.html")), "epub")

    def test_pdf(self):
        self.assertEqual(slicer.detect_format(read_fixture("pdf_sample.html")), "pdf")

    def test_empty_html_defaults_to_epub(self):
        self.assertEqual(slicer.detect_format(""), "epub")


class ChapterTests(unittest.TestCase):
    def setUp(self):
        self.html = read_fixture("epub_sample.html")
        self.blocks = slicer.slice_blocks(self.html)
        self.chapters = slicer.chapters(self.html, self.blocks)

    def test_chapter_boundaries_and_titles(self):
        self.assertEqual(
            self.chapters,
            [
                {"idx": 0, "title": "Front matter", "block_start": 0, "block_end": 5},
                {
                    "idx": 1,
                    "title": "Chapter One %s Departure" % EM_DASH,
                    "block_start": 5,
                    "block_end": 14,
                },
                {
                    "idx": 2,
                    "title": "Chapter Two: The Long Calm",
                    "block_start": 14,
                    "block_end": 23,
                },
                {
                    "idx": 3,
                    "title": "Chapter Three & Last",
                    "block_start": 23,
                    "block_end": 30,
                },
            ],
        )

    def test_front_matter_chapter_present(self):
        self.assertEqual(self.chapters[0]["title"], "Front matter")
        self.assertEqual(self.chapters[0]["block_start"], 0)

    def test_ranges_partition_every_block(self):
        covered = []
        for chapter in self.chapters:
            covered.extend(range(chapter["block_start"], chapter["block_end"]))
        self.assertEqual(covered, list(range(len(self.blocks))))
        for earlier, later in zip(self.chapters, self.chapters[1:]):
            self.assertEqual(earlier["block_end"], later["block_start"])
        self.assertEqual(self.chapters[-1]["block_end"], len(self.blocks))

    def test_toc_marker_value(self):
        self.assertEqual(
            slicer.toc_marker(self.html, self.blocks[5]),
            "Chapter One &mdash; Departure",
        )
        self.assertIsNone(slicer.toc_marker(self.html, self.blocks[6]))

    def test_pdf_falls_back_to_single_chapter(self):
        html = read_fixture("pdf_sample.html")
        blocks = slicer.slice_blocks(html)
        self.assertEqual(
            slicer.chapters(html, blocks),
            [{
                "idx": 0,
                "title": "Document",
                "block_start": 0,
                "block_end": PDF_BLOCK_COUNT,
            }],
        )

    def test_no_blocks_yields_no_chapters(self):
        self.assertEqual(slicer.chapters("<div></div>", []), [])

    def test_epub_without_markers_is_one_chapter(self):
        html = "<p>one</p>\n<p>two</p>"
        blocks = slicer.slice_blocks(html)
        self.assertEqual(
            slicer.chapters(html, blocks),
            [{"idx": 0, "title": "Document", "block_start": 0, "block_end": 2}],
        )

    def test_marker_on_first_block_means_no_front_matter(self):
        html = (
            '<p data-rw-epub-toc="A">A</p><p>body</p>'
            '<p data-rw-epub-toc="B">B</p><p>body</p>'
        )
        blocks = slicer.slice_blocks(html)
        result = slicer.chapters(html, blocks)
        self.assertEqual([c["title"] for c in result], ["A", "B"])
        self.assertEqual(result[0]["block_start"], 0)


class ChapterTextTests(unittest.TestCase):
    def setUp(self):
        self.html = read_fixture("epub_sample.html")
        self.blocks = slicer.slice_blocks(self.html)
        self.chapters = slicer.chapters(self.html, self.blocks)

    def test_front_matter_text_ids_entities_and_empty_skip(self):
        text = slicer.chapter_text(self.html, self.blocks, self.chapters[0])
        lines = text.split("\n\n")
        self.assertEqual(lines[0], "[0000] The Wine-Dark Sea")
        self.assertEqual(lines[1], "[0001] by A. Nonymous")
        self.assertIn("Copyright © 2026", lines[2])
        self.assertIn("caf%s district" % E_ACUTE, lines[3])
        self.assertIn("r%ssum%s" % (E_ACUTE, E_ACUTE), lines[3])
        # Block 4 is whitespace-only and must not produce a paragraph.
        self.assertNotIn("[0004]", text)
        self.assertEqual(len(lines), 4)

    def test_tags_are_stripped_and_ids_are_correct(self):
        text = slicer.chapter_text(self.html, self.blocks, self.chapters[1])
        lines = text.split("\n\n")
        self.assertEqual(lines[0], "[0005] Chapter One %s Departure" % EM_DASH)
        self.assertEqual(
            lines[2],
            "[0007] He read slowly, then cited the source in a footnote "
            "nobody would check.",
        )
        self.assertNotIn("<i>", text)
        self.assertNotIn("<a href", text)
        self.assertNotIn("class=", text)

    def test_multiline_block_collapses_to_one_paragraph(self):
        text = slicer.chapter_text(self.html, self.blocks, self.chapters[1])
        line = [l for l in text.split("\n\n") if l.startswith("[0009]")][0]
        self.assertEqual(
            line,
            "[0009] This paragraph runs across several lines of the source file, "
            "and its closing tag sits hard at column zero, exactly the way "
            "calibre emitted it.",
        )

    def test_numeric_entity_unescaped(self):
        text = slicer.chapter_text(self.html, self.blocks, self.chapters[1])
        self.assertIn("three days %s long enough" % EM_DASH, text)

    def test_every_block_id_in_range_appears_or_is_empty(self):
        for chapter in self.chapters:
            text = slicer.chapter_text(self.html, self.blocks, chapter)
            for index in range(chapter["block_start"], chapter["block_end"]):
                block = self.blocks[index]
                if slicer.block_text(self.html, block):
                    self.assertIn("[%04d]" % index, text)


class CacheTests(unittest.TestCase):
    DOC_ID = "01m0x3mrxm5r08y1fsxsccksn7"

    def test_cache_dir_is_under_home_cache(self):
        with temp_home() as home:
            path = slicer.cache_dir(self.DOC_ID)
            self.assertTrue(path.is_dir())
            self.assertEqual(
                path, home / ".cache" / "daystrom-reading" / self.DOC_ID
            )

    def test_cache_dir_rejects_traversal(self):
        with temp_home():
            # [R23] "." and ".." pass the allowlist character-for-character but
            # are path navigation: cache_dir("..") resolved to ~/.cache and
            # wrote source.html outside the per-document root.
            for bad in ("../evil", "a/b", "", "x\\y", ".", "..", " .. "):
                with self.assertRaises(ValueError, msg="accepted %r" % (bad,)):
                    slicer.cache_dir(bad)

    def test_cache_dir_still_accepts_a_dotted_document_id(self):
        # Only the two navigation names are reserved; a dot INSIDE an id is
        # ordinary and must keep working.
        with temp_home() as home:
            path = slicer.cache_dir("doc.v2")
            self.assertEqual(path, home / ".cache" / "daystrom-reading" / "doc.v2")

    def test_save_and_load_source_round_trips_byte_for_byte(self):
        html = read_fixture("epub_sample.html")
        with temp_home():
            meta = slicer.save_source(self.DOC_ID, html, extra_meta={"title": "T"})
            self.assertEqual(slicer.load_source(self.DOC_ID), html)
            self.assertEqual(meta["sha256"], slicer.sha256_text(html))
            self.assertEqual(meta["html_chars"], len(html))
            self.assertEqual(meta["block_count"], EPUB_BLOCK_COUNT)
            self.assertEqual(meta["chapter_count"], 4)
            self.assertEqual(meta["format"], "epub")
            self.assertEqual(meta["title"], "T")
            self.assertTrue(slicer.cache_is_valid(self.DOC_ID, html))
            self.assertFalse(slicer.cache_is_valid(self.DOC_ID, html + "x"))

    def test_offsets_from_cached_blocks_still_slice_correctly(self):
        html = read_fixture("epub_sample.html")
        with temp_home():
            slicer.save_source(self.DOC_ID, html)
            reloaded = slicer.load_source(self.DOC_ID)
            blocks = slicer.load_blocks(self.DOC_ID)
            self.assertEqual(len(blocks), EPUB_BLOCK_COUNT)
            for block in blocks:
                self.assertEqual(
                    reloaded[block["start"]:block["end"]],
                    html[block["start"]:block["end"]],
                )
            self.assertEqual(len(slicer.load_chapters(self.DOC_ID)), 4)

    def test_load_missing_cache_returns_none(self):
        with temp_home():
            self.assertIsNone(slicer.load_source("nothingcachedhere"))
            self.assertIsNone(slicer.load_meta("nothingcachedhere"))

    def test_atomic_write_leaves_no_temp_files(self):
        with temp_home():
            directory = slicer.cache_dir(self.DOC_ID)
            slicer.atomic_write_text(directory / "probe.json", json.dumps({"a": 1}))
            names = sorted(p.name for p in directory.iterdir())
            self.assertEqual(names, ["probe.json"])

    def test_atomic_write_overwrites_in_place(self):
        with temp_home():
            target = slicer.cache_dir(self.DOC_ID) / "probe.txt"
            slicer.atomic_write_text(target, "first")
            slicer.atomic_write_text(target, "second")
            with open(str(target), "r", encoding="utf-8", newline="") as fh:
                self.assertEqual(fh.read(), "second")


if __name__ == "__main__":
    unittest.main()
