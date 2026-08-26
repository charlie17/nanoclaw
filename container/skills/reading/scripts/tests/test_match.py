"""Tests for match.py — normalization, location, claim matching, stance.

Strictly offline: everything works off a synthetic html document.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import manifest as M  # noqa: E402
import match as MATCH  # noqa: E402
import slice as slicer  # noqa: E402

PARAGRAPHS = [
    "Retirement planning begins as a cash-flow problem, not a lump-sum problem.",
    "The distinction matters because a lump sum invites the wrong question entirely.",
    "Sequence-of-returns risk dominates the first decade after work stops for good.",
    "A portfolio that falls early while withdrawals continue locks those losses in.",
    "Consider two retirees with identical average returns over a thirty-year span.",
    "The one who met a bad market first runs out of money nearly a decade sooner.",
    "Tax location — which account holds which asset — beats tax rate in most plans.",
    "Municipal bonds in a tax-deferred account waste the exemption you paid for.",
    "Annuities solve longevity risk and almost nothing else that people buy them for.",
    "The guarantee is real, the liquidity cost is real, and both should be priced.",
    "Social Security timing is the largest single lever most households still hold.",
    "Delaying to seventy buys an inflation-adjusted annuity no insurer can match.",
]

HTML = "".join("<p>%s</p>" % text for text in PARAGRAPHS)
BLOCKS = slicer.slice_blocks(HTML)


def sample_manifest(claims):
    manifest = M.new_manifest(
        "sequence-risk",
        {"document_id": "doc-match", "title": "Sequence Risk", "category": "epub"},
        [{"idx": 0, "title": "All of it", "block_start": 0,
          "block_end": len(BLOCKS)}],
    )
    manifest["claims"] = claims
    M.validate(manifest)
    return manifest


class NormalizeTest(unittest.TestCase):
    def test_curly_quotes_become_straight(self):
        self.assertEqual(
            MATCH.normalize("“Hello,” he said."),
            '"Hello," he said.',
        )
        self.assertEqual(MATCH.normalize("it’s fine"), "it's fine")

    def test_dash_family_collapses_to_hyphen(self):
        self.assertEqual(MATCH.normalize("a—b"), "a-b")
        self.assertEqual(MATCH.normalize("a–b"), "a-b")
        self.assertEqual(MATCH.normalize("a−b"), "a-b")

    def test_nfkc_folds_ligatures_and_fullwidth(self):
        self.assertEqual(MATCH.normalize("ﬁrst"), "first")
        self.assertEqual(MATCH.normalize("ＡBC"), "ABC")

    def test_entities_unescaped_and_tags_stripped(self):
        self.assertEqual(
            MATCH.normalize("<p><em>Rock</em> &amp; roll</p>"), "Rock & roll"
        )

    def test_escaped_markup_is_not_treated_as_a_tag(self):
        # tags are stripped BEFORE unescaping, so &lt;p&gt; survives as text
        self.assertEqual(MATCH.normalize("a &lt;p&gt; b"), "a <p> b")

    def test_whitespace_collapses_and_case_is_preserved(self):
        self.assertEqual(
            MATCH.normalize("  The\n\tQuick   Brown  "), "The Quick Brown"
        )

    def test_non_breaking_space_is_ordinary_space(self):
        self.assertEqual(MATCH.normalize("a b"), "a b")

    def test_a_bare_less_than_in_prose_is_not_a_tag(self):
        # [28] "<[^>]*>" reads all of "< 5 and y >" as one tag and deletes it.
        self.assertEqual(
            MATCH.normalize("If x < 5 and y > 3 then stop"),
            "If x < 5 and y > 3 then stop",
        )
        # real markup around it is still markup
        self.assertEqual(
            MATCH.normalize("<p>If x < 5 then <em>stop</em></p>"),
            "If x < 5 then stop",
        )

    def test_none_is_empty(self):
        self.assertEqual(MATCH.normalize(None), "")

    def test_inline_markup_mid_word_does_not_split_the_word(self):
        # [R21] replacing EVERY tag with a space normalized
        # "catastroph<i>e</i> theory" to "catastroph e theory", which the
        # Reader highlight "catastrophe theory" can never contain — the
        # highlight fell into the bin with no way back.
        self.assertEqual(
            MATCH.normalize("<p>catastroph<i>e</i> theory</p>"),
            "catastrophe theory",
        )
        for tag in ("b", "em", "strong", "span", "sup", "sub", "u", "a href=x"):
            self.assertEqual(
                MATCH.normalize("word<%s>ing</%s>" % (tag, tag.split(" ")[0])),
                "wording",
                tag,
            )

    def test_structural_markup_still_separates(self):
        self.assertEqual(MATCH.normalize("<p>first</p><p>second</p>"), "first second")
        self.assertEqual(MATCH.normalize("<p>first<br>second</p>"), "first second")
        self.assertEqual(MATCH.normalize("<td>one</td><td>two</td>"), "one two")
        self.assertEqual(
            MATCH.normalize("<ul><li>one</li><li>two</li></ul>"), "one two"
        )

    def test_block_norm_of_a_mid_word_italic_block(self):
        html = "<p>The literature on catastroph<i>e</i> theory says otherwise.</p>"
        block = slicer.slice_blocks(html)[0]
        self.assertEqual(
            MATCH.block_norm(html, block),
            "The literature on catastrophe theory says otherwise.",
        )

    def test_block_norm_keeps_escaped_angle_bracket_prose(self):
        # [28] block_norm normalizes the RAW block html.  Normalizing
        # slicer.block_text's output instead would strip tags twice, and the
        # "< 5 and y >" that the first pass unescaped would be eaten as markup
        # by the second — losing the exact text that tells blocks apart.
        html = "<p>If x &lt; 5 and y &gt; 3 then stop the whole simulation.</p>"
        block = slicer.slice_blocks(html)[0]
        self.assertEqual(
            MATCH.block_norm(html, block),
            "If x < 5 and y > 3 then stop the whole simulation.",
        )


class LocateHighlightTest(unittest.TestCase):
    def test_whole_block_matches_that_block(self):
        self.assertEqual(
            MATCH.locate_highlight(HTML, BLOCKS, PARAGRAPHS[2]), [2]
        )

    def test_substring_of_one_block_matches_that_block(self):
        self.assertEqual(
            MATCH.locate_highlight(
                HTML, BLOCKS, "dominates the first decade after work stops"
            ),
            [2],
        )

    def test_curly_quoted_highlight_still_matches(self):
        highlight = "Tax location — which account holds which asset — beats tax rate"
        self.assertEqual(MATCH.locate_highlight(HTML, BLOCKS, highlight), [6])

    def test_highlight_spanning_three_blocks(self):
        highlight = " ".join([
            "identical average returns over a thirty-year span.",
            PARAGRAPHS[5],
            "Tax location - which account holds which asset - beats tax rate",
        ])
        self.assertEqual(MATCH.locate_highlight(HTML, BLOCKS, highlight), [4, 5, 6])

    def test_highlight_spanning_two_blocks(self):
        highlight = " ".join([
            "locks those losses in.",
            "Consider two retirees with identical average returns",
        ])
        self.assertEqual(MATCH.locate_highlight(HTML, BLOCKS, highlight), [3, 4])

    def test_too_short_to_place(self):
        self.assertEqual(MATCH.locate_highlight(HTML, BLOCKS, "the"), [])

    def test_text_that_is_not_in_the_source(self):
        self.assertEqual(
            MATCH.locate_highlight(
                HTML, BLOCKS, "a sentence the author never wrote anywhere at all"
            ),
            [],
        )

    def test_repeated_text_is_ambiguous_and_refuses(self):
        html = "".join([
            "<p>The same boilerplate paragraph appears twice in this document.</p>",
            "<p>Something else entirely goes here in the middle of the run.</p>",
            "<p>The same boilerplate paragraph appears twice in this document.</p>",
        ])
        blocks = slicer.slice_blocks(html)
        self.assertEqual(
            MATCH.locate_highlight(
                html, blocks, "The same boilerplate paragraph appears twice"
            ),
            [],
        )

    def test_span_longer_than_the_cap_refuses(self):
        highlight = " ".join(PARAGRAPHS[1:8])
        self.assertEqual(MATCH.locate_highlight(HTML, BLOCKS, highlight), [])

    def test_sentence_level_fallback_when_the_ends_drift(self):
        # A selection that dragged in a heading above the paragraph still
        # carries one whole sentence that sits cleanly in a single block.
        highlight = "Longevity and annuities. " + PARAGRAPHS[8]
        self.assertEqual(MATCH.locate_highlight(HTML, BLOCKS, highlight), [8])

    def test_sentence_fallback_refuses_when_the_sentence_is_a_small_fraction(self):
        # One sentence out of many is not evidence for pinning the whole
        # selection to that sentence's block.
        highlight = PARAGRAPHS[8] + " " + (
            "Then a long stretch of text that does not appear in the source at "
            "all, going on for quite a while so that the matched sentence is a "
            "small fraction of the whole selection by character count."
        )
        self.assertEqual(MATCH.locate_highlight(HTML, BLOCKS, highlight), [])

    def test_escaped_angle_bracket_prose_locates(self):
        # [28] the literal "< 5 and y >" is the discriminating text; stripping
        # tags twice deletes it and drops this highlight into the bin.  Reader
        # may hand the text back either escaped or already decoded, so both
        # spellings have to reach the same block.
        html = "".join([
            "<p>If x &lt; 5 and y &gt; 3 then stop the whole simulation at once.</p>",
            "<p>Another paragraph entirely, with nothing bracketed inside of it.</p>",
        ])
        blocks = slicer.slice_blocks(html)
        self.assertEqual(
            MATCH.locate_highlight(html, blocks, "If x &lt; 5 and y &gt; 3 then stop"),
            [0],
        )
        self.assertEqual(
            MATCH.locate_highlight(html, blocks, "If x < 5 and y > 3 then stop"),
            [0],
        )

    def test_a_mid_word_italic_block_matches_the_plain_highlight(self):
        # [R21] end to end: Reader hands back rendered text, with no markup in
        # it at all.  The block side has to produce the same string a reader
        # reads, or this highlight can never be placed on any claim.
        html = "".join([
            "<p>The literature on catastroph<i>e</i> theory is unusually thin.</p>",
            "<p>An unrelated paragraph that shares none of that wording at all.</p>",
        ])
        blocks = slicer.slice_blocks(html)
        self.assertEqual(
            MATCH.locate_highlight(
                html, blocks, "catastrophe theory is unusually thin"
            ),
            [0],
        )

    def test_sentences_drifting_across_two_blocks_keep_both(self):
        # [27] the endpoints drifted, so the exact passes miss; the fallback
        # must report BOTH sentences' blocks rather than pinning the whole
        # selection to whichever one happened to be longest.
        highlight = " ".join([
            "And then he wrote this.",     # nowhere in the source
            PARAGRAPHS[3],
            PARAGRAPHS[9],
        ])
        self.assertEqual(MATCH.locate_highlight(HTML, BLOCKS, highlight), [3, 9])


class MatchToClaimTest(unittest.TestCase):
    def test_all_blocks_inside_one_claim(self):
        manifest = sample_manifest([
            M.new_claim("c-1", "A", 0, "root", 0, block_range=[0, 3], anchor_block=0),
            M.new_claim("c-2", "B", 0, "root", 1, block_range=[4, 9], anchor_block=4),
        ])
        self.assertEqual(MATCH.match_to_claim(manifest, [5, 6]), "c-2")

    def test_blocks_spanning_two_claims_return_none(self):
        manifest = sample_manifest([
            M.new_claim("c-1", "A", 0, "root", 0, block_range=[0, 4], anchor_block=0),
            M.new_claim("c-2", "B", 0, "root", 1, block_range=[5, 9], anchor_block=5),
        ])
        self.assertIsNone(MATCH.match_to_claim(manifest, [4, 5]))

    def test_blocks_in_no_claim_return_none(self):
        manifest = sample_manifest([
            M.new_claim("c-1", "A", 0, "root", 0, block_range=[0, 4], anchor_block=0),
        ])
        self.assertIsNone(MATCH.match_to_claim(manifest, [8]))

    def test_nested_ranges_prefer_the_deepest_claim(self):
        manifest = sample_manifest([
            M.new_claim("c-1", "Parent", 0, "root", 0,
                        block_range=[0, 11], anchor_block=0),
            M.new_claim("c-2", "Child", 0, "c-1", 0,
                        block_range=[4, 8], anchor_block=4),
            M.new_claim("c-3", "Grandchild", 0, "c-2", 0,
                        block_range=[5, 6], anchor_block=5),
        ])
        self.assertEqual(MATCH.match_to_claim(manifest, [5]), "c-3")
        self.assertEqual(MATCH.match_to_claim(manifest, [7]), "c-2")
        self.assertEqual(MATCH.match_to_claim(manifest, [10]), "c-1")

    def test_pruned_claims_are_not_candidates(self):
        manifest = sample_manifest([
            M.new_claim("c-1", "Parent", 0, "root", 0,
                        block_range=[0, 11], anchor_block=0),
            M.new_claim("c-2", "Child", 0, "c-1", 0,
                        block_range=[4, 8], anchor_block=4, pruned=True),
        ])
        self.assertEqual(MATCH.match_to_claim(manifest, [5]), "c-1")

    def test_overlapping_but_not_nested_is_ambiguous(self):
        manifest = sample_manifest([
            M.new_claim("c-1", "A", 0, "root", 0, block_range=[0, 6], anchor_block=0),
            M.new_claim("c-2", "B", 0, "root", 1, block_range=[3, 9], anchor_block=3),
        ])
        self.assertIsNone(MATCH.match_to_claim(manifest, [4]))

    def test_empty_block_list_returns_none(self):
        manifest = sample_manifest([
            M.new_claim("c-1", "A", 0, "root", 0, block_range=[0, 6], anchor_block=0),
        ])
        self.assertIsNone(MATCH.match_to_claim(manifest, []))

    def test_equal_range_siblings_are_ambiguous(self):
        # [30] identical ranges are not nesting — nothing in the source says
        # which of these two JT meant, so the answer is the bin.
        manifest = sample_manifest([
            M.new_claim("c-1", "A", 0, "root", 0, block_range=[2, 6], anchor_block=2),
            M.new_claim("c-2", "B", 0, "root", 1, block_range=[2, 6], anchor_block=2),
        ])
        self.assertIsNone(MATCH.match_to_claim(manifest, [4]))

    def test_equal_ranges_at_different_depths_prefer_the_deeper(self):
        # ...but depth IS evidence: the child is the more specific reading.
        manifest = sample_manifest([
            M.new_claim("c-1", "Parent", 0, "root", 0,
                        block_range=[2, 6], anchor_block=2),
            M.new_claim("c-2", "Child", 0, "c-1", 0,
                        block_range=[2, 6], anchor_block=2),
        ])
        self.assertEqual(MATCH.match_to_claim(manifest, [4]), "c-2")

    def test_drifted_sentences_across_two_claims_go_to_the_bin(self):
        # [27] end to end: the two-block fallback result straddles two claims.
        manifest = sample_manifest([
            M.new_claim("c-1", "A", 0, "root", 0, block_range=[0, 4], anchor_block=0),
            M.new_claim("c-2", "B", 0, "root", 1, block_range=[5, 11], anchor_block=5),
        ])
        highlight = " ".join([
            "And then he wrote this.",
            PARAGRAPHS[3],
            PARAGRAPHS[9],
        ])
        indices = MATCH.locate_highlight(HTML, BLOCKS, highlight)
        self.assertEqual(indices, [3, 9])
        self.assertIsNone(MATCH.match_to_claim(manifest, indices))

    def test_overview_claims_without_a_range_are_skipped(self):
        manifest = sample_manifest([
            M.new_claim("o-1", "Thesis", M.OVERVIEW_IDX, "root", 0),
            M.new_claim("c-1", "A", 0, "root", 0, block_range=[0, 6], anchor_block=0),
        ])
        self.assertEqual(MATCH.match_to_claim(manifest, [2]), "c-1")


class ParseStanceTest(unittest.TestCase):
    def test_check_glyph(self):
        self.assertEqual(MATCH.parse_stance("✅ this lands"), ("agree", "this lands"))

    def test_cross_glyph(self):
        self.assertEqual(MATCH.parse_stance("❌ overstated"), ("dispute", "overstated"))

    def test_bulb_glyph(self):
        self.assertEqual(
            MATCH.parse_stance("\U0001f4a1 worth a wiki note"),
            ("surface", "worth a wiki note"),
        )

    def test_word_with_colon(self):
        self.assertEqual(
            MATCH.parse_stance("Dispute: the data is older than claimed"),
            ("dispute", "the data is older than claimed"),
        )

    def test_word_without_colon_any_case(self):
        self.assertEqual(
            MATCH.parse_stance("surface no colon"), ("surface", "no colon")
        )
        self.assertEqual(MATCH.parse_stance("AGREE fully"), ("agree", "fully"))

    def test_glyph_plus_redundant_word(self):
        self.assertEqual(MATCH.parse_stance("✅ agree — clean"), ("agree", "clean"))

    def test_stance_word_alone(self):
        self.assertEqual(MATCH.parse_stance("dispute"), ("dispute", ""))

    def test_plain_note_gets_no_stance(self):
        note = "I keep coming back to this one"
        self.assertEqual(MATCH.parse_stance(note), (None, note))

    def test_stance_is_never_inferred_from_prose(self):
        note = "I disagree with almost all of this"
        self.assertEqual(MATCH.parse_stance(note), (None, note))

    def test_word_boundary_prevents_a_false_positive(self):
        note = "Agreements like this one rarely hold"
        self.assertEqual(MATCH.parse_stance(note), (None, note))

    def test_empty_and_none(self):
        self.assertEqual(MATCH.parse_stance(""), (None, ""))
        self.assertEqual(MATCH.parse_stance(None), (None, ""))


if __name__ == "__main__":
    unittest.main()
