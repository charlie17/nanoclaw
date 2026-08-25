"""Tests for assemble.py — extraction JSON to manifest, anchors, coverage.

Strictly offline: a synthetic html document plus hand-written extraction files.
"""

import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import assemble as A  # noqa: E402
import manifest as M  # noqa: E402
import slice as slicer  # noqa: E402

BLOCK_COUNT = 30
TOC_AT = (0, 15)

BODY = (
    "**Claim** The author argues that the point holds across the whole period. "
    "**Reasoning** He builds it from three premises, each of which he defends "
    "separately before combining them. **Support** A worked example runs the "
    "numbers for two households with identical averages."
)
SHORT_BODY = "**Claim** A short one."


def paragraph(index):
    return ("Block %02d - the author develops the argument about topic %02d "
            "in careful detail." % (index, index))


def make_html():
    parts = []
    for index in range(BLOCK_COUNT):
        if index in TOC_AT:
            parts.append('<p data-rw-epub-toc="c%d">%s</p>' % (index, paragraph(index)))
        else:
            parts.append("<p>%s</p>" % paragraph(index))
    return "".join(parts)


HTML = make_html()
BLOCKS = slicer.slice_blocks(HTML)
CHAPTERS = slicer.chapters(HTML, BLOCKS)

SOURCE_META = {
    "document_id": "docassemble",
    "title": "A Careful Book",
    "author": "An Author",
    "category": "epub",
    "word_count": 4242,
}

CHAPTER_0 = {
    "chapter_idx": 0,
    "claims": [
        {"local_id": "x1", "parent": "root", "order": 0, "rel": "supports",
         "title": "The opening claim", "locator": "Ch 1",
         "block_range": [0, 6], "anchor_block": 2, "anchor_phrase": "topic 02",
         "body_md": BODY},
        {"local_id": "x2", "parent": "x1", "order": 0, "rel": "objection",
         "title": "An objection to it", "locator": "Ch 1 §2",
         "block_range": [7, 11], "anchor_block": 8, "anchor_phrase": "topic 08",
         "body_md": BODY},
        {"local_id": "x3", "parent": "root", "order": 1, "rel": "supports",
         "title": "A thin third claim", "locator": "Ch 1 §3",
         "block_range": [12, 14], "anchor_block": 12, "anchor_phrase": "topic 12",
         "body_md": SHORT_BODY},
    ],
}

CHAPTER_1 = {
    "chapter_idx": 1,
    "claims": [
        # anchor phrase that is nowhere in block 16
        {"local_id": "y1", "parent": "root", "order": 0, "rel": "supports",
         "title": "Second chapter opener", "locator": "Ch 2",
         "block_range": [15, 19], "anchor_block": 16,
         "anchor_phrase": "a phrase the author never wrote", "body_md": BODY},
        # anchor block outside the claim's own range
        {"local_id": "y2", "parent": "root", "order": 1, "rel": "consequence",
         "title": "Second chapter close", "locator": "Ch 2 §4",
         "block_range": [25, 29], "anchor_block": 20, "anchor_phrase": "topic 20",
         "body_md": BODY},
    ],
}

OVERVIEW = {
    "chapter_idx": -1,
    "claims": [
        {"local_id": "ov", "parent": "root", "order": 0,
         "title": "The book in one card", "body_md": BODY},
    ],
}


def write_extractions(directory, payloads):
    for name, payload in payloads:
        path = os.path.join(directory, name)
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False)


def row_for(report, chapter_idx):
    for row in report:
        if row.get("chapter_idx") == chapter_idx:
            return row
    raise AssertionError("no coverage row for chapter %r" % (chapter_idx,))


class AssembleBase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="dsr-assemble-")
        self.addCleanup(shutil.rmtree, self.dir, True)

    def build(self, payloads=None, **kwargs):
        write_extractions(self.dir, payloads or [
            ("ch00.json", CHAPTER_0),
            ("ch01.json", CHAPTER_1),
            ("overview.json", OVERVIEW),
        ])
        options = {"html": HTML, "blocks": BLOCKS}
        options.update(kwargs)
        return A.assemble("a-careful-book", SOURCE_META, CHAPTERS, self.dir, **options)


class IdsAndStructureTest(AssembleBase):
    def test_ids_are_namespaced_per_chapter(self):
        result = self.build()
        ids = [claim["id"] for claim in result.manifest["claims"]]
        self.assertEqual(
            ids,
            ["c-0-001", "c-0-002", "c-0-003", "c-1-001", "c-1-002", "o-001"],
        )

    def test_overview_claims_get_the_o_prefix(self):
        result = self.build()
        overview = [c for c in result.manifest["claims"]
                    if c["chapter_idx"] == M.OVERVIEW_IDX]
        self.assertEqual([c["id"] for c in overview], ["o-001"])
        self.assertIsNone(overview[0]["block_range"])
        self.assertIsNone(overview[0]["anchor_block"])

    def test_parents_are_remapped_to_namespaced_ids(self):
        result = self.build()
        by_id = M.claims_by_id(result.manifest)
        self.assertEqual(by_id["c-0-002"]["parent"], "c-0-001")
        self.assertEqual(by_id["c-0-001"]["parent"], "root")
        self.assertEqual(by_id["c-1-001"]["parent"], "root")

    def test_rel_and_order_are_preserved(self):
        result = self.build()
        by_id = M.claims_by_id(result.manifest)
        self.assertEqual(by_id["c-0-002"]["rel"], "objection")
        self.assertEqual(by_id["c-1-002"]["rel"], "consequence")
        self.assertEqual(by_id["c-0-003"]["order"], 1)

    def test_the_result_validates(self):
        result = self.build()
        self.assertEqual(M.validate(result.manifest), [])

    def test_chapter_metadata_comes_through(self):
        result = self.build()
        self.assertEqual(len(result.manifest["chapters"]), 2)
        self.assertEqual(result.manifest["source"]["title"], "A Careful Book")
        self.assertEqual(result.manifest["slug"], "a-careful-book")

    def test_ids_are_deterministic_across_runs(self):
        first = self.build()
        second = self.build()
        self.assertEqual(
            [c["id"] for c in first.manifest["claims"]],
            [c["id"] for c in second.manifest["claims"]],
        )

    def test_unknown_parent_is_reparented_to_root_and_reported(self):
        payload = {
            "chapter_idx": 0,
            "claims": [
                {"local_id": "a", "parent": "ghost", "title": "Orphan",
                 "block_range": [0, 3], "anchor_block": 0,
                 "anchor_phrase": "topic 00", "body_md": BODY},
            ],
        }
        result = self.build([("ch00.json", payload)])
        self.assertEqual(result.manifest["claims"][0]["parent"], "root")
        kinds = [r["kind"] for r in result.report["repairs"]]
        self.assertIn("parent", kinds)

    def test_unknown_rel_falls_back_to_the_default_and_is_reported(self):
        payload = {
            "chapter_idx": 0,
            "claims": [
                {"local_id": "a", "parent": "root", "rel": "vibes",
                 "title": "Odd rel", "block_range": [0, 3], "anchor_block": 0,
                 "anchor_phrase": "topic 00", "body_md": BODY},
            ],
        }
        result = self.build([("ch00.json", payload)])
        self.assertEqual(result.manifest["claims"][0]["rel"], M.REL_DEFAULT)
        self.assertIn("rel", [r["kind"] for r in result.report["repairs"]])

    def test_inverted_block_range_is_swapped_and_reported(self):
        payload = {
            "chapter_idx": 0,
            "claims": [
                {"local_id": "a", "parent": "root", "title": "Backwards",
                 "block_range": [6, 2], "anchor_block": 3,
                 "anchor_phrase": "topic 03", "body_md": BODY},
            ],
        }
        result = self.build([("ch00.json", payload)])
        self.assertEqual(result.manifest["claims"][0]["block_range"], [2, 6])
        self.assertIn("block_range", [r["kind"] for r in result.report["repairs"]])

    def test_a_chapter_idx_with_no_chapter_is_warned_about(self):
        payload = {"chapter_idx": 99, "claims": [
            {"local_id": "a", "parent": "root", "title": "Stray",
             "block_range": [0, 3], "anchor_block": 0,
             "anchor_phrase": "topic 00", "body_md": BODY}]}
        result = self.build([("ch99.json", payload)])
        self.assertTrue(
            any("matches no chapter" in w for w in result.report["warnings"])
        )


class AnchorVerificationTest(AssembleBase):
    def test_phrase_absent_from_the_block_is_caught(self):
        result = self.build()
        failures = [f for f in result.report["anchor_failures"]
                    if f["kind"] == "phrase_not_in_block"]
        self.assertEqual([f["claim_id"] for f in failures], ["c-1-001"])

    def test_anchor_block_outside_the_claim_range_is_caught(self):
        result = self.build()
        failures = [f for f in result.report["anchor_failures"]
                    if f["kind"] == "anchor_outside_range"]
        self.assertEqual([f["claim_id"] for f in failures], ["c-1-002"])

    def test_good_anchors_produce_no_failures(self):
        result = self.build()
        flagged = set(f["claim_id"] for f in result.report["anchor_failures"])
        for claim_id in ("c-0-001", "c-0-002", "c-0-003"):
            self.assertNotIn(claim_id, flagged)

    def test_verification_never_raises(self):
        result = self.build()
        self.assertIsInstance(result.report["anchor_failures"], list)
        self.assertEqual(len(result.manifest["claims"]), 6)

    def test_range_outside_its_chapter_is_caught(self):
        payload = {"chapter_idx": 0, "claims": [
            {"local_id": "a", "parent": "root", "title": "Runs long",
             "block_range": [10, 20], "anchor_block": 12,
             "anchor_phrase": "topic 12", "body_md": BODY}]}
        result = self.build([("ch00.json", payload)])
        kinds = [f["kind"] for f in result.report["anchor_failures"]]
        self.assertIn("range_outside_chapter", kinds)

    def test_anchor_block_beyond_the_document_is_caught(self):
        payload = {"chapter_idx": 0, "claims": [
            {"local_id": "a", "parent": "root", "title": "Off the end",
             "block_range": [0, 900], "anchor_block": 900,
             "anchor_phrase": "topic 00", "body_md": BODY}]}
        result = self.build([("ch00.json", payload)])
        kinds = [f["kind"] for f in result.report["anchor_failures"]]
        self.assertIn("anchor_out_of_bounds", kinds)

    def test_case_differences_count_as_a_miss(self):
        payload = {"chapter_idx": 0, "claims": [
            {"local_id": "a", "parent": "root", "title": "Paraphrased",
             "block_range": [0, 6], "anchor_block": 2,
             "anchor_phrase": "TOPIC 02", "body_md": BODY}]}
        result = self.build([("ch00.json", payload)])
        kinds = [f["kind"] for f in result.report["anchor_failures"]]
        self.assertIn("phrase_not_in_block", kinds)

    def test_overview_claims_are_not_anchor_checked(self):
        result = self.build([("overview.json", OVERVIEW)])
        self.assertEqual(result.report["anchor_failures"], [])


class CoverageReportTest(AssembleBase):
    def test_full_coverage_chapter_has_no_uncovered_runs(self):
        result = self.build()
        report = A.coverage_report(result.manifest, BLOCKS, CHAPTERS, html=HTML)
        row = row_for(report, 0)
        self.assertEqual(row["claim_count"], 3)
        self.assertEqual(row["uncovered_runs"], [])
        self.assertEqual(row["coverage_pct"], 100.0)

    def test_a_five_block_uncovered_run_is_flagged(self):
        result = self.build()
        report = A.coverage_report(result.manifest, BLOCKS, CHAPTERS, html=HTML)
        row = row_for(report, 1)
        self.assertEqual(
            row["uncovered_runs"], [{"start": 20, "end": 24, "blocks": 5}]
        )
        self.assertEqual(row["claim_count"], 2)
        self.assertEqual(row["covered_blocks"], 10)
        self.assertEqual(row["content_blocks"], 15)
        self.assertEqual(row["coverage_pct"], 66.7)

    def test_short_runs_are_below_the_signal_threshold(self):
        payload = {"chapter_idx": 1, "claims": [
            {"local_id": "a", "parent": "root", "title": "Most of it",
             "block_range": [15, 26], "anchor_block": 16,
             "anchor_phrase": "topic 16", "body_md": BODY}]}
        result = self.build([("ch01.json", payload)])
        report = A.coverage_report(result.manifest, BLOCKS, CHAPTERS, html=HTML)
        # blocks 27, 28, 29 are uncovered: three is not "longer than three"
        self.assertEqual(row_for(report, 1)["uncovered_runs"], [])

    def test_thin_cards_are_flagged(self):
        result = self.build()
        report = A.coverage_report(result.manifest, BLOCKS, CHAPTERS, html=HTML)
        thin = row_for(report, 0)["thin_claims"]
        self.assertEqual([t["id"] for t in thin], ["c-0-003"])
        self.assertEqual(thin[0]["body_chars"], len(SHORT_BODY))

    def test_the_overview_group_gets_its_own_row(self):
        result = self.build()
        report = A.coverage_report(result.manifest, BLOCKS, CHAPTERS, html=HTML)
        row = row_for(report, M.OVERVIEW_IDX)
        self.assertEqual(row["claim_count"], 1)
        self.assertIsNone(row["coverage_pct"])

    def test_pruned_claims_do_not_count_as_coverage(self):
        result = self.build()
        manifest = result.manifest
        M.claims_by_id(manifest)["c-0-001"]["jt"]["pruned"] = True
        report = A.coverage_report(manifest, BLOCKS, CHAPTERS, html=HTML)
        row = row_for(report, 0)
        self.assertEqual(row["claim_count"], 2)
        self.assertEqual(
            row["uncovered_runs"], [{"start": 0, "end": 6, "blocks": 7}]
        )

    def test_empty_blocks_do_not_split_an_uncovered_run(self):
        html = "".join(
            "<p></p>" if index == 22 else "<p>%s</p>" % paragraph(index)
            for index in range(BLOCK_COUNT)
        )
        blocks = slicer.slice_blocks(html)
        result = self.build()
        report = A.coverage_report(result.manifest, blocks, CHAPTERS, html=html)
        row = row_for(report, 1)
        # 20,21,23,24 remain: still one run, still over the threshold
        self.assertEqual(
            row["uncovered_runs"], [{"start": 20, "end": 24, "blocks": 4}]
        )

    def test_without_html_every_block_counts_as_content(self):
        result = self.build()
        report = A.coverage_report(result.manifest, BLOCKS, CHAPTERS)
        self.assertEqual(row_for(report, 1)["content_blocks"], 15)


class GapAuditInCoverageTest(AssembleBase):
    def audit_row(self, report):
        for row in report:
            if "gap_audit" in row:
                return row
        raise AssertionError("no gap audit row")

    def test_a_clean_document_reports_no_invisible_text(self):
        result = self.build()
        report = A.coverage_report(result.manifest, BLOCKS, CHAPTERS, html=HTML)
        row = self.audit_row(report)
        self.assertEqual(row["gap_audit"]["total_chars"], 0)
        self.assertEqual(row["warnings"], [])

    def test_a_big_table_trips_the_warning_and_names_the_tag(self):
        cell = "A substantial cell of prose that the extractor never sees at all. "
        table = "<table>" + "".join(
            "<tr><td>%s</td></tr>" % cell for _ in range(40)
        ) + "</table>"
        html = "<p>%s</p>%s<p>%s</p>" % (paragraph(0), table, paragraph(1))
        blocks = slicer.slice_blocks(html)
        chapters = slicer.chapters(html, blocks)
        result = self.build()
        report = A.coverage_report(result.manifest, blocks, chapters, html=html)
        row = self.audit_row(report)
        self.assertGreater(row["gap_audit"]["total_chars"],
                           A.INVISIBLE_TEXT_WARN_CHARS)
        self.assertEqual(len(row["warnings"]), 1)
        self.assertIn("table", row["warnings"][0])

    def test_no_audit_row_without_html(self):
        result = self.build()
        report = A.coverage_report(result.manifest, BLOCKS, CHAPTERS)
        self.assertFalse(any("gap_audit" in row for row in report))


class CacheFallbackTest(AssembleBase):
    def test_anchors_verify_against_the_slice_cache(self):
        home = tempfile.mkdtemp(prefix="dsr-assemble-home-")
        self.addCleanup(shutil.rmtree, home, True)
        with mock.patch.dict(os.environ, {"HOME": home, "USERPROFILE": home}):
            slicer.save_source(SOURCE_META["document_id"], HTML)
            result = self.build(html=None, blocks=None)
        kinds = [f["kind"] for f in result.report["anchor_failures"]]
        self.assertIn("phrase_not_in_block", kinds)
        self.assertIn("anchor_outside_range", kinds)

    def test_missing_cache_warns_instead_of_failing(self):
        home = tempfile.mkdtemp(prefix="dsr-assemble-nohome-")
        self.addCleanup(shutil.rmtree, home, True)
        with mock.patch.dict(os.environ, {"HOME": home, "USERPROFILE": home}):
            result = self.build(html=None, blocks=None)
        self.assertEqual(result.report["anchor_failures"], [])
        self.assertTrue(
            any("not cached" in w for w in result.report["warnings"])
        )
        self.assertEqual(len(result.manifest["claims"]), 6)


class TriageGlyphWarningTest(AssembleBase):
    def test_a_star_led_title_surfaces_through_the_assemble_report(self):
        payload = {"chapter_idx": 0, "claims": [
            {"local_id": "a", "parent": "root", "title": "⭐ Already flagged?",
             "block_range": [0, 3], "anchor_block": 0,
             "anchor_phrase": "topic 00", "body_md": BODY}]}
        result = self.build([("ch00.json", payload)])
        self.assertTrue(
            any("triage glyph" in w for w in result.report["manifest_warnings"])
        )


if __name__ == "__main__":
    unittest.main()
