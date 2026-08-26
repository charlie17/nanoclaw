"""Tests for assemble.py — extraction JSON to manifest, anchors, coverage.

Strictly offline: a synthetic html document plus hand-written extraction files.
"""

import hashlib
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


class UnreadableExtractionFileTest(AssembleBase):
    """One bad file in the work dir must cost that file, not the book."""

    def test_a_truncated_file_is_skipped_and_the_rest_assembles(self):
        path = os.path.join(self.dir, "ch01-truncated.json")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write('{"chapter_idx": 1, "claims": [{"local_id": "y1",')
        result = self.build([("ch00.json", CHAPTER_0)])
        self.assertEqual([c["id"] for c in result.manifest["claims"]],
                         ["c-0-001", "c-0-002", "c-0-003"])
        failures = result.report["unreadable_files"]
        self.assertEqual([f["file"] for f in failures], ["ch01-truncated.json"])
        self.assertTrue(failures[0]["error"])
        self.assertTrue(
            any("ch01-truncated.json" in w for w in result.report["warnings"])
        )

    def test_an_unopenable_path_is_reported_not_raised(self):
        # a directory named *.json raises OSError on open, on every platform
        os.mkdir(os.path.join(self.dir, "zz-not-a-file.json"))
        result = self.build([("ch00.json", CHAPTER_0)])
        self.assertEqual(len(result.manifest["claims"]), 3)
        self.assertEqual([f["file"] for f in result.report["unreadable_files"]],
                         ["zz-not-a-file.json"])


class MalformedFieldRepairTest(AssembleBase):
    """Every extraction field is LLM output: repair it, report it, never raise."""

    def claim_with(self, **fields):
        raw = {"local_id": "a", "parent": "root", "title": "A claim",
               "locator": "Ch 1", "block_range": [0, 3], "anchor_block": 0,
               "anchor_phrase": "topic 00", "body_md": BODY}
        raw.update(fields)
        return self.build([("ch00.json", {"chapter_idx": 0, "claims": [raw]})])

    def repairs(self, result, kind):
        return [r for r in result.report["repairs"] if r["kind"] == kind]

    def only_claim(self, result):
        self.assertEqual(M.validate(result.manifest), [])
        return result.manifest["claims"][0]

    def test_a_string_endpoint_is_repaired_to_zero_zero(self):
        result = self.claim_with(block_range=["bad", 1])
        self.assertEqual(self.only_claim(result)["block_range"], [0, 0])
        self.assertTrue(self.repairs(result, "block_range"))

    def test_a_null_endpoint_is_repaired_to_zero_zero(self):
        result = self.claim_with(block_range=[None, 3])
        self.assertEqual(self.only_claim(result)["block_range"], [0, 0])
        self.assertTrue(self.repairs(result, "block_range"))

    def test_boolean_endpoints_are_not_integers(self):
        result = self.claim_with(block_range=[True, False])
        self.assertEqual(self.only_claim(result)["block_range"], [0, 0])
        detail = self.repairs(result, "block_range")[0]["detail"]
        self.assertNotIn("inverted", detail)
        self.assertIn("plain integers", detail)

    def test_fractional_endpoints_are_repaired_not_truncated(self):
        result = self.claim_with(block_range=[1.9, 3.2])
        self.assertEqual(self.only_claim(result)["block_range"], [0, 0])
        self.assertTrue(self.repairs(result, "block_range"))

    def test_a_negative_endpoint_is_clamped_and_reported(self):
        result = self.claim_with(block_range=[-4, 3])
        self.assertEqual(self.only_claim(result)["block_range"], [0, 3])
        details = [r["detail"] for r in self.repairs(result, "block_range")]
        self.assertEqual(len(details), 1)
        self.assertIn("clamped", details[0])

    def test_an_in_range_pair_is_left_alone(self):
        result = self.claim_with(block_range=[1, 3])
        self.assertEqual(self.only_claim(result)["block_range"], [1, 3])
        self.assertEqual(self.repairs(result, "block_range"), [])

    def test_a_nonnumeric_order_defaults_to_zero(self):
        result = self.claim_with(order="first")
        self.assertEqual(self.only_claim(result)["order"], 0)
        self.assertTrue(self.repairs(result, "order"))

    def test_a_fractional_order_defaults_to_zero(self):
        result = self.claim_with(order=2.9)
        self.assertEqual(self.only_claim(result)["order"], 0)
        self.assertTrue(self.repairs(result, "order"))

    def test_a_boolean_order_defaults_to_zero(self):
        result = self.claim_with(order=True)
        self.assertEqual(self.only_claim(result)["order"], 0)
        self.assertTrue(self.repairs(result, "order"))

    def test_a_missing_order_is_zero_and_silent(self):
        raw = {"local_id": "a", "parent": "root", "title": "No order",
               "block_range": [0, 3], "anchor_block": 0,
               "anchor_phrase": "topic 00", "body_md": BODY}
        result = self.build([("ch00.json", {"chapter_idx": 0, "claims": [raw]})])
        self.assertEqual(self.only_claim(result)["order"], 0)
        self.assertEqual(self.repairs(result, "order"), [])

    def test_a_list_title_becomes_a_placeholder(self):
        result = self.claim_with(title=["a", "b"])
        self.assertEqual(self.only_claim(result)["title"], "(untitled)")
        self.assertTrue(self.repairs(result, "title"))

    def test_a_nonstring_locator_is_repaired(self):
        result = self.claim_with(locator=42)
        self.assertEqual(self.only_claim(result)["locator"], "")
        self.assertTrue(self.repairs(result, "locator"))

    def test_a_nonstring_anchor_phrase_is_repaired(self):
        result = self.claim_with(anchor_phrase={"quote": "topic 00"})
        self.assertEqual(self.only_claim(result)["anchor_phrase"], "")
        self.assertTrue(self.repairs(result, "anchor_phrase"))

    def test_a_list_body_is_joined_into_paragraphs(self):
        result = self.claim_with(body_md=["**Claim** One.", "**Reasoning** Two."])
        self.assertEqual(self.only_claim(result)["body_md"],
                         "**Claim** One.\n\n**Reasoning** Two.")
        self.assertTrue(self.repairs(result, "body_md"))

    def test_another_body_shape_becomes_empty(self):
        result = self.claim_with(body_md={"claim": "One."})
        self.assertEqual(self.only_claim(result)["body_md"], "")
        self.assertTrue(self.repairs(result, "body_md"))

    def test_a_nonint_anchor_block_falls_back_to_the_range_start(self):
        result = self.claim_with(anchor_block="2", block_range=[1, 3])
        self.assertEqual(self.only_claim(result)["anchor_block"], 1)
        self.assertTrue(self.repairs(result, "anchor_block"))

    def test_an_overview_claim_with_a_bad_range_records_no_range(self):
        payload = {"chapter_idx": -1, "claims": [
            {"local_id": "ov", "parent": "root", "title": "Thesis",
             "block_range": "the whole book", "body_md": BODY}]}
        result = self.build([("overview.json", payload)])
        self.assertIsNone(self.only_claim(result)["block_range"])
        self.assertTrue(self.repairs(result, "block_range"))


class ParentCycleTest(AssembleBase):
    def claims(self, entries):
        return self.build([("ch00.json", {"chapter_idx": 0, "claims": entries})])

    def entry(self, local_id, parent):
        return {"local_id": local_id, "parent": parent, "title": "Claim " + local_id,
                "block_range": [0, 3], "anchor_block": 0,
                "anchor_phrase": "topic 00", "body_md": BODY}

    def test_a_self_parent_is_cut_and_reported(self):
        result = self.claims([self.entry("a", "a")])
        self.assertEqual(result.manifest["claims"][0]["parent"], "root")
        self.assertEqual(M.validate(result.manifest), [])
        details = [r["detail"] for r in result.report["repairs"]
                   if r["kind"] == "parent"]
        self.assertTrue(any("cycle" in d for d in details))

    def test_a_two_claim_cycle_is_broken_at_one_edge(self):
        result = self.claims([self.entry("a", "b"), self.entry("b", "a")])
        parents = [c["parent"] for c in result.manifest["claims"]]
        self.assertEqual(parents, ["root", "c-0-001"])
        self.assertEqual(M.validate(result.manifest), [])
        self.assertTrue(any("cycle" in r["detail"]
                            for r in result.report["repairs"]))


class PerFileLocalIdsTest(AssembleBase):
    """Local ids are unique per FILE — one chapter may be fanned out over many."""

    def payload(self, phrase_block):
        return {"chapter_idx": 0, "claims": [
            {"local_id": "x1", "parent": "root", "title": "Parent claim",
             "block_range": [phrase_block, phrase_block + 1],
             "anchor_block": phrase_block,
             "anchor_phrase": "topic %02d" % phrase_block, "body_md": BODY},
            {"local_id": "x2", "parent": "x1", "title": "Child claim",
             "block_range": [phrase_block, phrase_block + 1],
             "anchor_block": phrase_block,
             "anchor_phrase": "topic %02d" % phrase_block, "body_md": BODY},
        ]}

    def test_colliding_local_ids_resolve_within_their_own_file(self):
        result = self.build([("ch00-part1.json", self.payload(0)),
                             ("ch00-part2.json", self.payload(4))])
        by_id = M.claims_by_id(result.manifest)
        self.assertEqual(by_id["c-0-002"]["parent"], "c-0-001")
        # the second file's child must NOT adopt the first file's x1
        self.assertEqual(by_id["c-0-004"]["parent"], "c-0-003")
        self.assertFalse(
            any("duplicate local_id" in w for w in result.report["warnings"])
        )

    def test_a_duplicate_inside_one_file_is_still_warned_about(self):
        payload = self.payload(0)
        payload["claims"][1]["local_id"] = "x1"
        result = self.build([("ch00.json", payload)])
        self.assertTrue(
            any("duplicate local_id" in w for w in result.report["warnings"])
        )


class AssembleCoverageTest(AssembleBase):
    def test_the_report_carries_the_coverage_ledger(self):
        result = self.build()
        coverage = result.report["coverage"]
        self.assertIsInstance(coverage, list)
        self.assertEqual(row_for(coverage, 1)["coverage_pct"], 66.7)
        self.assertEqual([t["id"] for t in row_for(coverage, 0)["thin_claims"]],
                         ["c-0-003"])
        self.assertTrue(any("gap_audit" in row for row in coverage))

    def test_coverage_is_none_and_warned_when_there_is_no_source(self):
        home = tempfile.mkdtemp(prefix="dsr-assemble-nocov-")
        self.addCleanup(shutil.rmtree, home, True)
        with mock.patch.dict(os.environ, {"HOME": home, "USERPROFILE": home}):
            result = self.build(html=None, blocks=None)
        self.assertIsNone(result.report["coverage"])
        self.assertTrue(
            any("coverage could not be computed" in w
                for w in result.report["warnings"])
        )


class ListItemCoverageTest(AssembleBase):
    """A block that owns list items is content even when it renders empty."""

    def test_an_empty_block_owning_a_list_item_counts_as_content(self):
        html = ("<p>%s</p>" % paragraph(0)
                + "<p></p><ul><li>A list item carrying real argument.</li></ul>"
                + "<p>%s</p>" % paragraph(2))
        blocks = slicer.slice_blocks(html)
        chapters = [{"idx": 0, "title": "Only", "block_start": 0, "block_end": 3}]
        manifest = M.new_manifest("s", {}, chapters)
        manifest["claims"] = [
            M.new_claim("c-1", "T", 0, "root", 0, block_range=[0, 0],
                        anchor_block=0),
        ]
        row = row_for(A.coverage_report(manifest, blocks, chapters, html=html), 0)
        # block 1 renders empty but owns the list, so it is in the denominator
        self.assertEqual(row["content_blocks"], 3)
        self.assertEqual(row["covered_blocks"], 1)
        self.assertEqual(row["coverage_pct"], 33.3)

    def test_a_truly_empty_block_is_still_excluded(self):
        html = ("<p>%s</p><p></p><p>%s</p>" % (paragraph(0), paragraph(2)))
        blocks = slicer.slice_blocks(html)
        chapters = [{"idx": 0, "title": "Only", "block_start": 0, "block_end": 3}]
        manifest = M.new_manifest("s", {}, chapters)
        manifest["claims"] = [
            M.new_claim("c-1", "T", 0, "root", 0, block_range=[0, 0],
                        anchor_block=0),
        ]
        row = row_for(A.coverage_report(manifest, blocks, chapters, html=html), 0)
        self.assertEqual(row["content_blocks"], 2)


class ListItemAnchorTest(AssembleBase):
    """slice.py tells extraction to cite a list item under the preceding block."""

    ITEM = "the ledger method beats the budget method"

    def assemble_with(self, phrase):
        html = ("<p>%s</p><ul><li>%s</li></ul><p>%s</p>"
                % (paragraph(0), self.ITEM, paragraph(1)))
        blocks = slicer.slice_blocks(html)
        chapters = slicer.chapters(html, blocks)
        payload = {"chapter_idx": 0, "claims": [
            {"local_id": "a", "parent": "root", "title": "Quotes the list",
             "block_range": [0, 1], "anchor_block": 0,
             "anchor_phrase": phrase, "body_md": BODY}]}
        write_extractions(self.dir, [("ch00.json", payload)])
        result = A.assemble("a-listy-book", SOURCE_META, chapters, self.dir,
                            html=html, blocks=blocks)
        return [f["kind"] for f in result.report["anchor_failures"]]

    def test_a_phrase_from_a_list_item_gets_its_own_status(self):
        kinds = self.assemble_with(self.ITEM)
        self.assertEqual(kinds, ["anchor_in_list_item"])

    def test_a_phrase_in_neither_is_still_a_plain_miss(self):
        kinds = self.assemble_with("a phrase the author never wrote")
        self.assertEqual(kinds, ["phrase_not_in_block"])

    def test_a_phrase_in_the_block_itself_still_passes_clean(self):
        kinds = self.assemble_with("topic 00")
        self.assertEqual(kinds, [])


class FrontMatterItemAnchorTest(AssembleBase):
    """Items ABOVE the first p-block are cited against block 0 by instruction.

    ``inter_block_items`` keys them -1 (nothing precedes them), but
    ``chapter_text`` renders them at the top of the first chapter under a label
    naming block 0 as the block to cite — so a claim that quotes one is doing
    exactly what it was told, and must not read as a phrase that is not there.
    """

    ITEM = "a note about the edition and its translator"

    def assemble_with(self, phrase, anchor_block=0):
        html = ("<ul><li>%s</li></ul><p>%s</p><p>%s</p>"
                % (self.ITEM, paragraph(0), paragraph(1)))
        blocks = slicer.slice_blocks(html)
        chapters = slicer.chapters(html, blocks)
        payload = {"chapter_idx": 0, "claims": [
            {"local_id": "a", "parent": "root", "title": "Quotes the front matter",
             "block_range": [0, 1], "anchor_block": anchor_block,
             "anchor_phrase": phrase, "body_md": BODY}]}
        write_extractions(self.dir, [("ch00.json", payload)])
        result = A.assemble("a-front-matter-book", SOURCE_META, chapters,
                            self.dir, html=html, blocks=blocks)
        return [f["kind"] for f in result.report["anchor_failures"]]

    def test_the_pre_block_items_are_keyed_minus_one(self):
        html = ("<ul><li>%s</li></ul><p>%s</p>" % (self.ITEM, paragraph(0)))
        blocks = slicer.slice_blocks(html)
        self.assertEqual(slicer.inter_block_items(html, blocks), {-1: [self.ITEM]})

    def test_a_claim_quoting_a_front_matter_item_is_verified_not_missing(self):
        kinds = self.assemble_with(self.ITEM)
        self.assertEqual(kinds, ["anchor_in_list_item"])

    def test_a_phrase_in_neither_is_still_a_plain_miss(self):
        kinds = self.assemble_with("a phrase the author never wrote")
        self.assertEqual(kinds, ["phrase_not_in_block"])

    def test_the_exemption_does_not_spread_to_later_blocks(self):
        # Only block 0 carries the front-matter instruction; quoting the same
        # item against block 1 is a real miss.
        kinds = self.assemble_with(self.ITEM, anchor_block=1)
        self.assertEqual(kinds, ["phrase_not_in_block"])


class SourceBindingTest(AssembleBase):
    """manifest.source.html_sha256 binds the map to the html it verified."""

    def test_the_manifest_carries_the_sha_of_the_supplied_html(self):
        result = self.build()
        self.assertEqual(
            result.manifest["source"]["html_sha256"],
            hashlib.sha256(HTML.encode("utf-8")).hexdigest(),
        )

    def test_the_sha_comes_from_the_cache_when_html_is_not_supplied(self):
        home = tempfile.mkdtemp(prefix="dsr-assemble-bind-")
        self.addCleanup(shutil.rmtree, home, True)
        with mock.patch.dict(os.environ, {"HOME": home, "USERPROFILE": home}):
            slicer.save_source(SOURCE_META["document_id"], HTML)
            result = self.build(html=None, blocks=None)
        self.assertEqual(
            result.manifest["source"]["html_sha256"],
            hashlib.sha256(HTML.encode("utf-8")).hexdigest(),
        )

    def test_no_source_leaves_the_manifest_unbound(self):
        home = tempfile.mkdtemp(prefix="dsr-assemble-unbound-")
        self.addCleanup(shutil.rmtree, home, True)
        with mock.patch.dict(os.environ, {"HOME": home, "USERPROFILE": home}):
            result = self.build(html=None, blocks=None)
        self.assertEqual(result.manifest["source"]["html_sha256"], "")


class MalformedSourceMetaTest(AssembleBase):
    """Reader metadata is no more trusted than the extraction."""

    def test_a_bad_word_count_and_category_are_repaired_not_raised(self):
        meta = dict(SOURCE_META, word_count="unknown", category="books")
        write_extractions(self.dir, [("ch00.json", CHAPTER_0)])
        result = A.assemble("a-careful-book", meta, CHAPTERS, self.dir,
                            html=HTML, blocks=BLOCKS)
        self.assertEqual(result.manifest["source"]["word_count"], 0)
        self.assertEqual(result.manifest["source"]["category"], "epub")
        self.assertEqual(len(result.manifest["claims"]), 3)
        self.assertEqual(M.validate(result.manifest), [])


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
