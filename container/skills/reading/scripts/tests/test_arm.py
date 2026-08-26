"""Tests for arm.py — target selection, cite recording, resumability.

Strictly offline: readerapi.create_highlight is mocked at the function
boundary, so no network call and no token read can happen.
"""

import os
import shutil
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import arm as ARM  # noqa: E402
import canvas_build as cb  # noqa: E402
import manifest as M  # noqa: E402
import readerapi  # noqa: E402
import slice as slicer  # noqa: E402

DOC_ID = "docarm"
SLUG = "an-armed-book"
SKIP = ARM.SKIP_FLAG

PARAGRAPHS = [
    "The opening paragraph frames the whole argument in terms of cash flow.",
    "Sequence risk is the single largest threat to an early retirement plan.",
    "A skipped digression about the author's own first job in the industry.",
    "Tax location beats tax rate for almost every household with two accounts.",
    "An aside the reader is invited to ignore entirely on a first pass.",
    "Annuities buy longevity insurance and should be priced as insurance.",
    "A paragraph with no particular claim attached to it at all this time.",
    "Social Security timing is the largest lever most households still hold.",
    "Filler paragraph that belongs to nothing in particular in this argument.",
    "The closing paragraph restates the thesis without adding to it.",
]

HTML = "".join("<p>%s</p>" % text for text in PARAGRAPHS)
BLOCKS = slicer.slice_blocks(HTML)

BODY = ("**Claim** The author makes the point plainly. **Reasoning** He builds "
        "it from premises he has already defended at some length.")


def payload(number):
    return {
        "id": "hl-%d" % number,
        "url": "https://read.readwise.io/read/hl-%d" % number,
    }


def build_manifest():
    manifest = M.new_manifest(
        SLUG,
        {"document_id": DOC_ID, "title": "An Armed Book", "author": "An Author",
         "category": "epub", "html_sha256": slicer.sha256_text(HTML)},
        [{"idx": 0, "title": "The whole thing", "block_start": 0,
          "block_end": len(BLOCKS)}],
    )
    manifest["claims"] = [
        M.new_claim("a1", "Cash flow framing", 0, "root", 0,
                    locator="Ch 1", block_range=[0, 1], anchor_block=1,
                    anchor_phrase="Sequence risk", body_md=BODY, flags=["⭐"]),
        M.new_claim("a2", "A digression", 0, "root", 1,
                    locator="Ch 1 §2", block_range=[2, 2], anchor_block=2,
                    anchor_phrase="own first job", body_md=BODY, flags=["⏭️"]),
        M.new_claim("a3", "Tax location", 0, "root", 2,
                    locator="Ch 1 §3", block_range=[3, 3], anchor_block=3,
                    anchor_phrase="Tax location", body_md=BODY,
                    flags=["\U0001f525"], highlight_id="already-armed",
                    url="https://read.readwise.io/read/already-armed"),
        M.new_claim("a4", "A deleted card", 0, "root", 3,
                    locator="Ch 1 §4", block_range=[4, 4], anchor_block=4,
                    anchor_phrase="An aside", body_md=BODY, flags=["❓"],
                    pruned=True),
        M.new_claim("a5", "Annuities", 0, "root", 4,
                    locator="Ch 1 §5", block_range=[5, 5], anchor_block=5,
                    anchor_phrase="longevity insurance", body_md=BODY,
                    flags=["❓"]),
        M.new_claim("a6", "An untriaged card", 0, "root", 5,
                    locator="Ch 1 §6", block_range=[6, 6], anchor_block=6,
                    anchor_phrase="no particular claim", body_md=BODY),
        M.new_claim("a7", "Social Security timing", 0, "root", 6,
                    locator="Ch 1 §7", block_range=[7, 7], anchor_block=7,
                    anchor_phrase="largest lever", body_md=BODY, flags=["⭐"]),
    ]
    M.validate(manifest)
    return manifest


class ArmTestCase(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="dsr-arm-home-")
        self.vault = tempfile.mkdtemp(prefix="dsr-arm-vault-")
        self.addCleanup(shutil.rmtree, self.home, True)
        self.addCleanup(shutil.rmtree, self.vault, True)
        patcher = mock.patch.dict(
            os.environ, {"HOME": self.home, "USERPROFILE": self.home}
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        slicer.save_source(DOC_ID, HTML)

        self.manifest = build_manifest()
        canvas = cb.build_canvas(self.manifest)
        cb.write_canvas(self.manifest, canvas, self.vault)
        M.save(self.manifest, ARM.manifest_path(self.manifest, self.vault))

    # -- helpers ---------------------------------------------------------

    def canvas_path(self):
        return cb.canvas_path(self.manifest, self.vault)

    def canvas_bytes(self):
        with open(self.canvas_path(), "rb") as handle:
            return handle.read()

    def saved_manifest(self):
        return M.load(ARM.manifest_path(self.manifest, self.vault))

    def node_by_claim(self, claim_id, canvas=None):
        canvas = canvas or cb.read_canvas(self.canvas_path())
        target = cb.claim_node_id(SLUG, claim_id)
        for node in canvas["nodes"]:
            if node["id"] == target:
                return node
        return None

    def fail_a5(self):
        """One run in which a5's create raises — an ambiguous outcome."""
        with mock.patch.object(
            readerapi, "create_highlight",
            side_effect=[payload(1), readerapi.ReaderAPIError("boom"), payload(3)],
        ):
            return ARM.arm(self.manifest, DOC_ID, self.vault)


class TargetSelectionTest(ArmTestCase):
    def test_only_star_fire_and_question_cards_are_targets(self):
        targets, _skipped = ARM.select_targets(self.manifest)
        self.assertEqual([c["id"] for c in targets], ["a1", "a5", "a7"])

    def test_skip_flagged_card_is_skipped_with_a_reason(self):
        _targets, skipped = ARM.select_targets(self.manifest)
        reasons = dict((s["claim_id"], s["reason"]) for s in skipped)
        self.assertEqual(reasons["a2"], "skip flag only")

    def test_a_mixed_flag_card_is_skipped_because_skip_wins(self):
        M.claims_by_id(self.manifest)["a1"]["jt"]["flags"] = [SKIP, "⭐"]
        targets, skipped = ARM.select_targets(self.manifest)
        self.assertNotIn("a1", [c["id"] for c in targets])
        reasons = dict((s["claim_id"], s["reason"]) for s in skipped)
        self.assertIn("skip flag wins", reasons["a1"])

    def test_a_mixed_flag_card_is_not_armed_end_to_end(self):
        M.claims_by_id(self.manifest)["a1"]["jt"]["flags"] = [SKIP, "⭐"]
        cb.write_canvas(self.manifest, cb.build_canvas(self.manifest), self.vault)
        with mock.patch.object(readerapi, "create_highlight",
                               side_effect=[payload(2), payload(3)]) as create:
            report = ARM.arm(self.manifest, DOC_ID, self.vault)
        self.assertEqual([a["claim_id"] for a in report["armed"]], ["a5", "a7"])
        self.assertEqual(create.call_count, 2)

    def test_already_armed_card_is_never_rearmed(self):
        _targets, skipped = ARM.select_targets(self.manifest)
        reasons = dict((s["claim_id"], s["reason"]) for s in skipped)
        self.assertEqual(reasons["a3"], "already armed")

    def test_pruned_card_is_not_a_target_at_all(self):
        targets, skipped = ARM.select_targets(self.manifest)
        self.assertNotIn("a4", [c["id"] for c in targets])
        self.assertNotIn("a4", [s["claim_id"] for s in skipped])

    def test_untriaged_card_is_skipped(self):
        _targets, skipped = ARM.select_targets(self.manifest)
        reasons = dict((s["claim_id"], s["reason"]) for s in skipped)
        self.assertEqual(reasons["a6"], "not triaged")

    def test_a_card_with_no_anchor_block_cannot_be_armed(self):
        self.manifest["claims"].append(M.new_claim(
            "o1", "Overview card", M.OVERVIEW_IDX, "root", 0,
            body_md=BODY, flags=["⭐"],
        ))
        _targets, skipped = ARM.select_targets(self.manifest)
        reasons = dict((s["claim_id"], s["reason"]) for s in skipped)
        self.assertIn("no anchor block", reasons["o1"])


class DryRunTest(ArmTestCase):
    def test_dry_run_makes_no_calls_and_no_writes(self):
        before_canvas = self.canvas_bytes()
        before_manifest = M.dumps(self.saved_manifest())
        with mock.patch.object(readerapi, "create_highlight") as create:
            report = ARM.arm(self.manifest, DOC_ID, self.vault, dry_run=True)
        self.assertEqual(create.call_count, 0)
        self.assertEqual(report["targets"], ["a1", "a5", "a7"])
        self.assertEqual(report["armed"], [])
        self.assertTrue(report["dry_run"])
        self.assertEqual(self.canvas_bytes(), before_canvas)
        self.assertEqual(M.dumps(self.saved_manifest()), before_manifest)


class ArmRunTest(ArmTestCase):
    def test_cites_are_recorded_on_the_targets(self):
        with mock.patch.object(readerapi, "create_highlight",
                               side_effect=[payload(1), payload(2), payload(3)]):
            report = ARM.arm(self.manifest, DOC_ID, self.vault)
        self.assertEqual([a["claim_id"] for a in report["armed"]],
                         ["a1", "a5", "a7"])
        by_id = M.claims_by_id(self.manifest)
        self.assertEqual(by_id["a1"]["cite"]["highlight_id"], "hl-1")
        self.assertEqual(by_id["a5"]["cite"]["highlight_id"], "hl-2")
        self.assertEqual(by_id["a7"]["cite"]["url"],
                         "https://read.readwise.io/read/hl-3")
        self.assertEqual(report["failed"], [])

    def test_the_verbatim_block_and_the_claim_tag_are_sent(self):
        with mock.patch.object(readerapi, "create_highlight",
                               side_effect=[payload(1), payload(2), payload(3)]) as create:
            ARM.arm(self.manifest, DOC_ID, self.vault)
        first = create.call_args_list[0]
        self.assertEqual(first.args[0], DOC_ID)
        self.assertEqual(first.args[1], slicer.block_html(HTML, BLOCKS[1]))
        self.assertEqual(first.kwargs["tags"], [ARM.CLAIM_TAG])

    def test_the_cite_link_reaches_the_canvas(self):
        with mock.patch.object(readerapi, "create_highlight",
                               side_effect=[payload(1), payload(2), payload(3)]):
            ARM.arm(self.manifest, DOC_ID, self.vault)
        node = self.node_by_claim("a1")
        self.assertIn("https://read.readwise.io/read/hl-1", node["text"])
        self.assertIn(cb.CITE_PREFIX, node["text"])

    def test_a_second_run_arms_nothing(self):
        with mock.patch.object(readerapi, "create_highlight",
                               side_effect=[payload(1), payload(2), payload(3)]):
            ARM.arm(self.manifest, DOC_ID, self.vault)
        with mock.patch.object(readerapi, "create_highlight") as create:
            report = ARM.arm(self.manifest, DOC_ID, self.vault)
        self.assertEqual(create.call_count, 0)
        self.assertEqual(report["armed"], [])

    def test_a_run_with_no_targets_still_projects(self):
        # Triage lives on the canvas, so clearing it in memory is not enough —
        # the flags have to come off the cards themselves.
        for claim in self.manifest["claims"]:
            claim["jt"]["flags"] = []
        cb.write_canvas(self.manifest, cb.build_canvas(self.manifest), self.vault)
        with mock.patch.object(readerapi, "create_highlight") as create:
            report = ARM.arm(self.manifest, DOC_ID, self.vault)
        self.assertEqual(create.call_count, 0)
        self.assertEqual(report["armed"], [])
        self.assertEqual(self.saved_manifest()["runs"][-1]["action"], "arm")

    def test_a_payload_without_an_id_is_a_failure_not_a_silent_pass(self):
        with mock.patch.object(readerapi, "create_highlight",
                               side_effect=[{"nope": 1}, payload(2), payload(3)]):
            report = ARM.arm(self.manifest, DOC_ID, self.vault)
        self.assertEqual([f["claim_id"] for f in report["failed"]], ["a1"])
        self.assertIsNone(M.claims_by_id(self.manifest)["a1"]["cite"]["highlight_id"])

    def test_an_uncached_source_arms_nothing(self):
        shutil.rmtree(str(slicer.cache_dir(DOC_ID, create=False)), True)
        with mock.patch.object(readerapi, "create_highlight") as create:
            report = ARM.arm(self.manifest, DOC_ID, self.vault)
        self.assertEqual(create.call_count, 0)
        self.assertTrue(any("not cached" in w for w in report["warnings"]))


class ResumeTest(ArmTestCase):
    def test_a_failure_mid_run_leaves_resumable_state_on_disk(self):
        with mock.patch.object(
            readerapi, "create_highlight",
            side_effect=[payload(1), readerapi.ReaderAPIError("boom"), payload(3)],
        ):
            report = ARM.arm(self.manifest, DOC_ID, self.vault)

        self.assertEqual([a["claim_id"] for a in report["armed"]], ["a1", "a7"])
        self.assertEqual([f["claim_id"] for f in report["failed"]], ["a5"])
        self.assertIn("boom", report["failed"][0]["error"])

        saved = M.claims_by_id(self.saved_manifest())
        self.assertEqual(saved["a1"]["cite"]["highlight_id"], "hl-1")
        self.assertEqual(saved["a7"]["cite"]["highlight_id"], "hl-3")
        self.assertIsNone(saved["a5"]["cite"]["highlight_id"])

    def test_the_rerun_arms_only_what_failed(self):
        self.fail_a5()

        resumed = M.load(ARM.manifest_path(self.manifest, self.vault))
        # The ambiguous attempt is reconciled first: Reader has no tagged
        # highlight for that block, so the attempt plainly did not commit.
        with mock.patch.object(readerapi, "get_document_highlights",
                               return_value={"highlights": []}) as lookup, \
                mock.patch.object(readerapi, "create_highlight",
                                  side_effect=[payload(9)]) as create:
            report = ARM.arm(resumed, DOC_ID, self.vault)
        self.assertEqual(lookup.call_count, 1)
        self.assertEqual(create.call_count, 1)
        self.assertEqual([a["claim_id"] for a in report["armed"]], ["a5"])
        self.assertEqual(
            M.claims_by_id(resumed)["a5"]["cite"]["highlight_id"], "hl-9"
        )


class AmbiguousAttemptTest(ArmTestCase):
    """A create that raised may still have committed on Reader's side."""

    def test_the_attempt_is_recorded_before_the_call_goes_out(self):
        self.fail_a5()
        saved = M.claims_by_id(self.saved_manifest())
        self.assertTrue(saved["a5"]["cite"].get("attempted"))
        self.assertIsNone(saved["a5"]["cite"]["highlight_id"])
        # A card that came back clean carries no marker.
        self.assertFalse(saved["a1"]["cite"].get("attempted"))

    def test_the_rerun_adopts_the_highlight_the_attempt_did_create(self):
        self.fail_a5()
        resumed = M.load(ARM.manifest_path(self.manifest, self.vault))
        already_there = {"highlights": [
            {"id": "hl-ghost", "text": PARAGRAPHS[5],
             "tags": ["daystrom-claim"]},
            {"id": "hl-jt", "text": PARAGRAPHS[5], "tags": ["something-else"]},
        ]}
        with mock.patch.object(readerapi, "get_document_highlights",
                               return_value=already_there), \
                mock.patch.object(readerapi, "create_highlight") as create:
            report = ARM.arm(resumed, DOC_ID, self.vault)
        self.assertEqual(create.call_count, 0)
        self.assertEqual([a["claim_id"] for a in report["armed"]], ["a5"])
        self.assertTrue(report["armed"][0]["adopted"])
        cite = M.claims_by_id(resumed)["a5"]["cite"]
        self.assertEqual(cite["highlight_id"], "hl-ghost")
        self.assertEqual(cite["url"], "https://read.readwise.io/read/hl-ghost")

    def test_a_lookup_that_fails_refuses_to_create_a_possible_duplicate(self):
        self.fail_a5()
        resumed = M.load(ARM.manifest_path(self.manifest, self.vault))
        with mock.patch.object(readerapi, "get_document_highlights",
                               side_effect=readerapi.ReaderAPIError("no answer")), \
                mock.patch.object(readerapi, "create_highlight") as create:
            report = ARM.arm(resumed, DOC_ID, self.vault)
        self.assertEqual(create.call_count, 0)
        self.assertEqual([f["claim_id"] for f in report["failed"]], ["a5"])
        self.assertIn("no duplicate was created", report["failed"][0]["error"])


class GeometryTest(ArmTestCase):
    def test_a_card_jt_moved_keeps_its_position(self):
        canvas = cb.read_canvas(self.canvas_path())
        target = cb.claim_node_id(SLUG, "a1")
        moved = None
        for node in canvas["nodes"]:
            if node["id"] == target:
                node["x"] = node["x"] + 1500
                node["y"] = node["y"] - 900
                moved = (node["x"], node["y"])
        M.atomic_write_text(self.canvas_path(), cb.dumps_canvas(canvas))

        with mock.patch.object(readerapi, "create_highlight",
                               side_effect=[payload(1), payload(2), payload(3)]):
            report = ARM.arm(self.manifest, DOC_ID, self.vault)

        self.assertEqual(report.get("canvas_violations", []), [])
        node = self.node_by_claim("a1")
        self.assertEqual((node["x"], node["y"]), moved)
        self.assertIn("hl-1", node["text"])

    def test_triage_flags_added_on_the_canvas_are_folded_in_before_arming(self):
        canvas = cb.read_canvas(self.canvas_path())
        target = cb.claim_node_id(SLUG, "a6")
        for node in canvas["nodes"]:
            if node["id"] == target:
                node["text"] = "# ⭐ " + node["text"].split("\n", 1)[0][2:] + \
                    "\n" + node["text"].split("\n", 1)[1]
        M.atomic_write_text(self.canvas_path(), cb.dumps_canvas(canvas))

        with mock.patch.object(
            readerapi, "create_highlight",
            side_effect=[payload(1), payload(2), payload(3), payload(4)],
        ):
            report = ARM.arm(self.manifest, DOC_ID, self.vault)
        self.assertIn("a6", [a["claim_id"] for a in report["armed"]])
        self.assertEqual(M.claims_by_id(self.manifest)["a6"]["jt"]["flags"], ["⭐"])

    def test_a_card_deleted_on_the_canvas_is_pruned_and_not_armed(self):
        canvas = cb.read_canvas(self.canvas_path())
        target = cb.claim_node_id(SLUG, "a1")
        canvas["nodes"] = [n for n in canvas["nodes"] if n["id"] != target]
        canvas["edges"] = [
            e for e in canvas["edges"]
            if e.get("fromNode") != target and e.get("toNode") != target
        ]
        M.atomic_write_text(self.canvas_path(), cb.dumps_canvas(canvas))

        with mock.patch.object(readerapi, "create_highlight",
                               side_effect=[payload(2), payload(3)]):
            report = ARM.arm(self.manifest, DOC_ID, self.vault)
        self.assertEqual([a["claim_id"] for a in report["armed"]], ["a5", "a7"])
        self.assertTrue(M.claims_by_id(self.manifest)["a1"]["jt"]["pruned"])


class MidRunCanvasEditTest(ArmTestCase):
    """The create loop runs for minutes; JT keeps working while it does."""

    def test_an_edit_made_during_the_create_loop_survives_the_write(self):
        calls = []

        def create(*args, **kwargs):
            if not calls:
                canvas = cb.read_canvas(self.canvas_path())
                target = cb.claim_node_id(SLUG, "a5")
                for node in canvas["nodes"]:
                    if node["id"] == target:
                        lines = node["text"].split("\n")
                        lines[0] = lines[0] + ", rethought"
                        node["text"] = "\n".join(lines)
                canvas["nodes"].append({
                    "id": "jt-sticky", "type": "text", "x": 9000, "y": 9000,
                    "width": 400, "height": 200, "text": "a thought of my own",
                })
                M.atomic_write_text(self.canvas_path(), cb.dumps_canvas(canvas))
            calls.append(args)
            return payload(len(calls))

        with mock.patch.object(readerapi, "create_highlight", side_effect=create):
            report = ARM.arm(self.manifest, DOC_ID, self.vault)

        self.assertEqual(len(report["armed"]), 3)
        # The retitle reached the manifest and came back out on the canvas...
        self.assertEqual(
            M.claims_by_id(self.manifest)["a5"]["jt"]["title_override"],
            "Annuities, rethought",
        )
        self.assertIn("Annuities, rethought", self.node_by_claim("a5")["text"])
        # ...and the card he added mid-run was not wiped off the map.
        written = cb.read_canvas(self.canvas_path())
        self.assertIn("jt-sticky", [n["id"] for n in written["nodes"]])

    def test_arming_is_not_read_back_as_a_hand_edited_cite_line(self):
        """The second fold must not mistake this run's own work for JT's.

        Arming rewrites every target's cite line ON THE MANIFEST; the canvas
        still shows the pre-run projection until we write it.  A blanket
        re-fold therefore reported each armed card as having had its cite line
        edited by hand — and captured a — JT — section override for it.
        """
        calls = []

        def create(*args, **kwargs):
            if not calls:
                # JT touches ONE card that this run is not arming at all.
                canvas = cb.read_canvas(self.canvas_path())
                target = cb.claim_node_id(SLUG, "a6")
                for node in canvas["nodes"]:
                    if node["id"] == target:
                        node["text"] = node["text"].replace(
                            "An untriaged card", "A card JT retitled", 1)
                M.atomic_write_text(self.canvas_path(), cb.dumps_canvas(canvas))
            calls.append(args)
            return payload(len(calls))

        with mock.patch.object(readerapi, "create_highlight", side_effect=create):
            report = ARM.arm(self.manifest, DOC_ID, self.vault)

        self.assertEqual([a["claim_id"] for a in report["armed"]],
                         ["a1", "a5", "a7"])
        self.assertEqual([w for w in report["warnings"] if "cite line" in w], [])

        by_id = M.claims_by_id(self.manifest)
        for claim_id in ("a1", "a5", "a7"):
            jt = by_id[claim_id]["jt"]
            self.assertNotIn("jt_section_override", jt, claim_id)
            self.assertIsNone(jt["title_override"], claim_id)
        # ...while the card he really did retitle came through.
        self.assertEqual(by_id["a6"]["jt"]["title_override"], "A card JT retitled")

    def test_a_card_deleted_during_the_create_loop_stays_deleted(self):
        calls = []

        def create(*args, **kwargs):
            if not calls:
                canvas = cb.read_canvas(self.canvas_path())
                target = cb.claim_node_id(SLUG, "a7")
                canvas["nodes"] = [n for n in canvas["nodes"] if n["id"] != target]
                canvas["edges"] = [
                    e for e in canvas["edges"]
                    if e.get("fromNode") != target and e.get("toNode") != target
                ]
                M.atomic_write_text(self.canvas_path(), cb.dumps_canvas(canvas))
            calls.append(args)
            return payload(len(calls))

        with mock.patch.object(readerapi, "create_highlight", side_effect=create):
            ARM.arm(self.manifest, DOC_ID, self.vault)

        self.assertTrue(M.claims_by_id(self.manifest)["a7"]["jt"]["pruned"])
        self.assertIsNone(self.node_by_claim("a7"))


class InvalidCanvasTest(ArmTestCase):
    """A canvas with no usable nodes is a broken file, not an emptied map."""

    def test_a_structurally_invalid_canvas_stops_the_run_dead(self):
        before_canvas = self.canvas_bytes()
        before_manifest = M.dumps(self.saved_manifest())
        with mock.patch.object(ARM.cp, "parse_overlay",
                               return_value=ARM.blocked_overlay("no nodes array")), \
                mock.patch.object(readerapi, "create_highlight") as create:
            report = ARM.arm(self.manifest, DOC_ID, self.vault)

        self.assertEqual(create.call_count, 0)
        self.assertEqual(self.canvas_bytes(), before_canvas)
        self.assertEqual(M.dumps(self.saved_manifest()), before_manifest)
        self.assertTrue(any("no nodes array" in w for w in report["warnings"]))
        # Nothing was folded in, so no claim was pruned by the broken file.
        pruned = [c["id"] for c in self.manifest["claims"]
                  if c["jt"]["pruned"] and c["id"] != "a4"]
        self.assertEqual(pruned, [])

    def test_a_real_nodeless_canvas_file_stops_the_run_dead(self):
        # The same refusal without a stub: a half-synced file that is valid
        # JSON and has no nodes list at all.
        M.atomic_write_text(self.canvas_path(), '{"edges": []}\n')
        before_manifest = M.dumps(self.saved_manifest())
        with mock.patch.object(readerapi, "create_highlight") as create:
            report = ARM.arm(self.manifest, DOC_ID, self.vault)

        self.assertEqual(create.call_count, 0)
        self.assertEqual(M.dumps(self.saved_manifest()), before_manifest)
        with open(self.canvas_path(), "r", encoding="utf-8") as handle:
            self.assertEqual(handle.read(), '{"edges": []}\n')
        self.assertTrue(any("nodes" in w for w in report["warnings"]))
        pruned = [c["id"] for c in self.manifest["claims"]
                  if c["jt"]["pruned"] and c["id"] != "a4"]
        self.assertEqual(pruned, [])


class SourceBindingTest(ArmTestCase):
    def test_a_drifted_cache_arms_nothing(self):
        self.manifest["source"]["html_sha256"] = "0" * 64
        before = self.canvas_bytes()
        with mock.patch.object(readerapi, "create_highlight") as create:
            report = ARM.arm(self.manifest, DOC_ID, self.vault)
        self.assertEqual(create.call_count, 0)
        self.assertEqual(report["armed"], [])
        self.assertEqual(self.canvas_bytes(), before)
        self.assertTrue(any("source drift" in w for w in report["warnings"]))

    def test_an_unbound_manifest_warns_and_proceeds(self):
        self.manifest["source"]["html_sha256"] = ""
        with mock.patch.object(readerapi, "create_highlight",
                               side_effect=[payload(1), payload(2), payload(3)]):
            report = ARM.arm(self.manifest, DOC_ID, self.vault)
        self.assertEqual(len(report["armed"]), 3)
        self.assertTrue(any("no source binding" in w for w in report["warnings"]))


class DocumentIdTest(ArmTestCase):
    def test_a_doc_id_that_is_not_this_maps_document_does_nothing(self):
        before = self.canvas_bytes()
        with mock.patch.object(readerapi, "create_highlight") as create:
            report = ARM.arm(self.manifest, "some-other-doc", self.vault)
        self.assertEqual(create.call_count, 0)
        self.assertEqual(self.canvas_bytes(), before)
        self.assertTrue(any("document mismatch" in w for w in report["warnings"]))

    def test_a_manifest_with_no_document_id_warns_and_proceeds(self):
        self.manifest["source"]["document_id"] = ""
        with mock.patch.object(readerapi, "create_highlight",
                               side_effect=[payload(1), payload(2), payload(3)]):
            report = ARM.arm(self.manifest, DOC_ID, self.vault)
        self.assertEqual(len(report["armed"]), 3)
        self.assertTrue(
            any("records no document id" in w for w in report["warnings"])
        )


class ConflictCopyTest(ArmTestCase):
    """Obsidian Sync parks the losing copy beside the file JT was editing."""

    def make_conflict(self, age_seconds):
        sibling = os.path.join(
            self.vault, "%s (conflicted copy 2026-08-26).canvas" % SLUG
        )
        shutil.copyfile(self.canvas_path(), sibling)
        stamp = time.time() + age_seconds
        os.utime(sibling, (stamp, stamp))
        return sibling

    def test_a_newer_conflict_copy_blocks_every_write(self):
        self.make_conflict(600)
        before_canvas = self.canvas_bytes()
        before_manifest = M.dumps(self.saved_manifest())
        with mock.patch.object(readerapi, "create_highlight") as create:
            report = ARM.arm(self.manifest, DOC_ID, self.vault)
        self.assertEqual(create.call_count, 0)
        self.assertEqual(self.canvas_bytes(), before_canvas)
        self.assertEqual(M.dumps(self.saved_manifest()), before_manifest)
        self.assertTrue(any("conflict copy" in w for w in report["warnings"]))

    def test_an_older_conflict_copy_only_warns(self):
        self.make_conflict(-600)
        with mock.patch.object(readerapi, "create_highlight",
                               side_effect=[payload(1), payload(2), payload(3)]):
            report = ARM.arm(self.manifest, DOC_ID, self.vault)
        self.assertEqual(len(report["armed"]), 3)
        self.assertTrue(any("conflict copies sit beside" in w
                            for w in report["warnings"]))


class AnchorPhraseTest(ArmTestCase):
    """The block index is not provenance — the quoted phrase is."""

    def resync_canvas(self):
        cb.write_canvas(self.manifest, cb.build_canvas(self.manifest), self.vault)

    def test_a_phrase_that_is_not_in_its_block_is_not_armed(self):
        M.claims_by_id(self.manifest)["a1"]["anchor_phrase"] = "a phrase from nowhere"
        self.resync_canvas()
        with mock.patch.object(readerapi, "create_highlight",
                               side_effect=[payload(2), payload(3)]) as create:
            report = ARM.arm(self.manifest, DOC_ID, self.vault)
        self.assertEqual(create.call_count, 2)
        self.assertEqual([f["claim_id"] for f in report["failed"]], ["a1"])
        self.assertIn("does not occur in block", report["failed"][0]["error"])
        self.assertIsNone(M.claims_by_id(self.manifest)["a1"]["cite"]["highlight_id"])

    def test_a_card_with_no_anchor_phrase_at_all_is_not_armed(self):
        M.claims_by_id(self.manifest)["a1"]["anchor_phrase"] = ""
        self.resync_canvas()
        with mock.patch.object(readerapi, "create_highlight",
                               side_effect=[payload(2), payload(3)]) as create:
            report = ARM.arm(self.manifest, DOC_ID, self.vault)
        self.assertEqual(create.call_count, 2)
        self.assertEqual([f["claim_id"] for f in report["failed"]], ["a1"])
        self.assertIn("no anchor phrase", report["failed"][0]["error"])


class DerivedCiteUrlTest(ArmTestCase):
    def test_an_id_only_payload_still_yields_a_cite_link(self):
        with mock.patch.object(readerapi, "create_highlight",
                               side_effect=[{"id": "hl-nourl"}, payload(2),
                                            payload(3)]):
            report = ARM.arm(self.manifest, DOC_ID, self.vault)
        armed = dict((a["claim_id"], a["url"]) for a in report["armed"])
        self.assertEqual(armed["a1"], "https://read.readwise.io/read/hl-nourl")
        self.assertEqual(
            M.claims_by_id(self.manifest)["a1"]["cite"]["url"],
            "https://read.readwise.io/read/hl-nourl",
        )
        self.assertIn("https://read.readwise.io/read/hl-nourl",
                      self.node_by_claim("a1")["text"])


class HighlightFieldsTest(unittest.TestCase):
    def test_reads_the_ordinary_shape(self):
        self.assertEqual(
            ARM.highlight_fields({"id": "abc", "url": "u"}), ("abc", "u")
        )

    def test_falls_back_to_other_id_keys(self):
        self.assertEqual(
            ARM.highlight_fields({"highlight_id": 42, "link": "u"}), ("42", "u")
        )

    def test_missing_everything(self):
        self.assertEqual(ARM.highlight_fields({}), (None, None))
        self.assertEqual(ARM.highlight_fields("nope"), (None, None))


if __name__ == "__main__":
    unittest.main()
