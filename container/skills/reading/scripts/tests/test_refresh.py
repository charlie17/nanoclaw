"""Tests for refresh.py — the full fold cycle, plus the triage-glyph guardrail.

Strictly offline: readerapi.get_document_highlights is mocked at the function
boundary.
"""

import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import arm as ARM  # noqa: E402
import canvas_build as cb  # noqa: E402
import manifest as M  # noqa: E402
import readerapi  # noqa: E402
import refresh as R  # noqa: E402
import slice as slicer  # noqa: E402

DOC_ID = "docrefresh"
SLUG = "a-read-book"

PARAGRAPHS = [
    "The opening paragraph frames retirement as a cash-flow problem throughout.",
    "Sequence risk is the single largest threat to an early retirement plan.",
    "A portfolio that falls early while withdrawals continue locks losses in.",
    "Two retirees with identical average returns can end in very different places.",
    "The one who met a bad market first runs out of money nearly a decade sooner.",
    "Tax location beats tax rate for almost every household with two accounts.",
    "Municipal bonds inside a tax-deferred account waste the exemption entirely.",
    "Annuities buy longevity insurance and should be priced as insurance is.",
    "The guarantee is real and so is the liquidity cost, and both can be priced.",
    "A worked example runs the numbers across three accounts and thirty years.",
    "Social Security timing is the largest lever most households still hold late.",
    "Delaying to seventy buys an inflation-adjusted annuity no insurer can match.",
]

HTML = "".join("<p>%s</p>" % text for text in PARAGRAPHS)
BLOCKS = slicer.slice_blocks(HTML)

BODY = ("**Claim** The author makes the point plainly. **Reasoning** He builds "
        "it from premises he has already defended at some length.")

# A selection running from the tail of block 4 into the head of block 5 — it
# straddles the boundary between two claims and therefore matches neither.
STRADDLE = (
    "runs out of money nearly a decade sooner. "
    "Tax location beats tax rate for almost every household"
)


def machine_highlight():
    return {
        "id": "machine-1",
        "content": PARAGRAPHS[1],
        "tags": ["daystrom-claim"],
        "url": "https://read.readwise.io/read/machine-1",
        "note": "",
    }


def jt_highlight(reader_id, text, note=""):
    return {
        "id": reader_id,
        "content": text,
        "note": note,
        "tags": [],
        "url": "https://read.readwise.io/read/%s" % reader_id,
    }


BASE_HIGHLIGHTS = [
    machine_highlight(),
    jt_highlight("h1", PARAGRAPHS[2], "✅ solid"),
    jt_highlight("h2", PARAGRAPHS[7], "❌ overstated"),
    jt_highlight("h3", STRADDLE, "no idea where this goes"),
]


def build_manifest(html_sha256=None):
    manifest = M.new_manifest(
        SLUG,
        {"document_id": DOC_ID, "title": "A Read Book", "author": "An Author",
         "category": "epub",
         "html_sha256": slicer.sha256_text(HTML) if html_sha256 is None
                        else html_sha256},
        [{"idx": 0, "title": "The whole thing", "block_start": 0,
          "block_end": len(BLOCKS)}],
    )
    manifest["claims"] = [
        M.new_claim("r1", "Sequence risk dominates", 0, "root", 0,
                    locator="Ch 1", block_range=[0, 4], anchor_block=1,
                    anchor_phrase="Sequence risk", body_md=BODY),
        M.new_claim("r2", "Tax location beats tax rate", 0, "root", 1,
                    locator="Ch 2", block_range=[5, 9], anchor_block=6,
                    anchor_phrase="Municipal bonds", body_md=BODY),
        M.new_claim("r3", "Timing is the last big lever", 0, "root", 2,
                    locator="Ch 3", block_range=[10, 11], anchor_block=10,
                    anchor_phrase="largest lever", body_md=BODY),
    ]
    M.validate(manifest)
    return manifest


class RefreshTestCase(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="dsr-refresh-home-")
        self.vault = tempfile.mkdtemp(prefix="dsr-refresh-vault-")
        self.addCleanup(shutil.rmtree, self.home, True)
        self.addCleanup(shutil.rmtree, self.vault, True)
        patcher = mock.patch.dict(
            os.environ, {"HOME": self.home, "USERPROFILE": self.home}
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        slicer.save_source(DOC_ID, HTML)

        self.manifest = build_manifest()
        cb.write_canvas(self.manifest, cb.build_canvas(self.manifest), self.vault)
        M.save(self.manifest, ARM.manifest_path(self.manifest, self.vault))

    def run_refresh(self, highlights, manifest=None):
        # a list is copied so a test's fixture cannot be mutated; an envelope
        # dict is handed through exactly as the API would return it
        payload = list(highlights) if isinstance(highlights, list) else highlights
        with mock.patch.object(readerapi, "get_document_highlights",
                               return_value=payload):
            return R.refresh(manifest or self.manifest, DOC_ID, self.vault)

    def canvas_path(self):
        return cb.canvas_path(self.manifest, self.vault)

    def canvas_bytes(self):
        with open(self.canvas_path(), "rb") as handle:
            return handle.read()

    def node_text(self, claim_id):
        canvas = cb.read_canvas(self.canvas_path())
        target = cb.claim_node_id(SLUG, claim_id)
        for node in canvas["nodes"]:
            if node["id"] == target:
                return node
        raise AssertionError("no node for %s" % claim_id)


class FoldCycleTest(RefreshTestCase):
    def test_a_new_highlight_lands_on_the_right_claim(self):
        report = self.run_refresh(BASE_HIGHLIGHTS)
        self.assertEqual(report["matched"], {"r1": ["h1"], "r2": ["h2"]})
        highlights = M.claims_by_id(self.manifest)["r1"]["jt"]["highlights"]
        self.assertEqual([h["reader_id"] for h in highlights], ["h1"])
        self.assertEqual(highlights[0]["text"], PARAGRAPHS[2])

    def test_the_stance_shorthand_sets_stance_and_leaves_the_rest_as_a_note(self):
        self.run_refresh(BASE_HIGHLIGHTS)
        by_id = M.claims_by_id(self.manifest)
        self.assertEqual(by_id["r1"]["jt"]["stance"], "agree")
        self.assertEqual(by_id["r1"]["jt"]["highlights"][0]["note"], "solid")
        self.assertEqual(by_id["r2"]["jt"]["stance"], "dispute")

    def test_the_highlight_is_rendered_into_the_jt_section_of_the_card(self):
        self.run_refresh(BASE_HIGHLIGHTS)
        node = self.node_text("r1")
        self.assertIn(cb.JT_SEP.strip(), node["text"])
        self.assertIn(PARAGRAPHS[2], node["text"])
        self.assertIn("solid", node["text"])
        # source content and overlay never mix: the JT block comes last
        self.assertLess(node["text"].index(BODY), node["text"].index(PARAGRAPHS[2]))

    def test_stance_recolors_the_card(self):
        self.run_refresh(BASE_HIGHLIGHTS)
        self.assertEqual(self.node_text("r1").get("color"), "4")     # agree
        self.assertEqual(self.node_text("r2").get("color"), "1")     # dispute
        self.assertIsNone(self.node_text("r3").get("color"))

    def test_machine_highlights_are_not_folded_back_in(self):
        report = self.run_refresh(BASE_HIGHLIGHTS)
        self.assertEqual(report["machine_highlights"], 1)
        for claim in self.manifest["claims"]:
            ids = [h["reader_id"] for h in claim["jt"]["highlights"]]
            self.assertNotIn("machine-1", ids)

    def test_a_bare_highlight_carries_no_stance(self):
        highlights = [jt_highlight("h9", PARAGRAPHS[11])]
        self.run_refresh(highlights)
        by_id = M.claims_by_id(self.manifest)
        self.assertEqual(len(by_id["r3"]["jt"]["highlights"]), 1)
        self.assertIsNone(by_id["r3"]["jt"]["stance"])

    def test_prose_that_sounds_like_a_stance_is_not_one(self):
        highlights = [jt_highlight("h9", PARAGRAPHS[11], "I disagree with all of this")]
        self.run_refresh(highlights)
        by_id = M.claims_by_id(self.manifest)
        self.assertIsNone(by_id["r3"]["jt"]["stance"])
        self.assertEqual(
            by_id["r3"]["jt"]["highlights"][0]["note"], "I disagree with all of this"
        )

    def test_the_run_is_logged(self):
        self.run_refresh(BASE_HIGHLIGHTS)
        entry = M.load(ARM.manifest_path(self.manifest, self.vault))["runs"][-1]
        self.assertEqual(entry["action"], "refresh")
        self.assertIn("matched", entry["summary"])


class UnmatchedTest(RefreshTestCase):
    def test_a_straddling_highlight_goes_to_the_bin(self):
        report = self.run_refresh(BASE_HIGHLIGHTS)
        self.assertEqual(report["unmatched_new"], ["h3"])
        self.assertEqual(len(self.manifest["unmatched"]), 1)
        self.assertEqual(self.manifest["unmatched"][0]["reader_id"], "h3")

    def test_the_bin_card_appears_on_the_canvas(self):
        self.run_refresh(BASE_HIGHLIGHTS)
        canvas = cb.read_canvas(self.canvas_path())
        bin_id = cb.node_id(SLUG, "bin")
        node = [n for n in canvas["nodes"] if n["id"] == bin_id]
        self.assertEqual(len(node), 1)
        self.assertIn("no idea where this goes", node[0]["text"])

    def test_an_unmatched_highlight_is_binned_only_once(self):
        self.run_refresh(BASE_HIGHLIGHTS)
        report = self.run_refresh(BASE_HIGHLIGHTS)
        self.assertEqual(report["unmatched_new"], [])
        self.assertEqual(len(self.manifest["unmatched"]), 1)

    def test_text_that_is_nowhere_in_the_source_is_binned(self):
        report = self.run_refresh(
            [jt_highlight("h9", "a sentence the author never wrote down anywhere")]
        )
        self.assertEqual(report["unmatched_new"], ["h9"])


class IdempotenceTest(RefreshTestCase):
    def test_the_second_run_finds_nothing_new(self):
        self.run_refresh(BASE_HIGHLIGHTS)
        report = self.run_refresh(BASE_HIGHLIGHTS)
        self.assertEqual(report["new_highlights"], 0)
        self.assertEqual(report["skipped_known"], 3)
        self.assertEqual(report["matched"], {})

    def test_the_second_run_does_not_duplicate_highlights(self):
        self.run_refresh(BASE_HIGHLIGHTS)
        self.run_refresh(BASE_HIGHLIGHTS)
        highlights = M.claims_by_id(self.manifest)["r1"]["jt"]["highlights"]
        self.assertEqual(len(highlights), 1)

    def test_the_second_run_leaves_the_canvas_byte_identical(self):
        self.run_refresh(BASE_HIGHLIGHTS)
        first = self.canvas_bytes()
        self.run_refresh(BASE_HIGHLIGHTS)
        self.assertEqual(self.canvas_bytes(), first)

    def test_byte_stable_across_a_reload_from_disk(self):
        self.run_refresh(BASE_HIGHLIGHTS)
        first = self.canvas_bytes()
        reloaded = M.load(ARM.manifest_path(self.manifest, self.vault))
        self.run_refresh(BASE_HIGHLIGHTS, manifest=reloaded)
        self.assertEqual(self.canvas_bytes(), first)


class MidRunCanvasEditTest(RefreshTestCase):
    """JT keeps working in Obsidian while the sweep is out on the network.

    The canvas then differs from the run-start snapshot, so ``project`` folds
    it a second time — and that fold compares the PRE-run canvas against a
    manifest which has already absorbed this run's new highlights.  Every card
    reads as rewritten, and a card that just gained a highlight has its — JT —
    section frozen at the empty text the canvas still showed, permanently.
    """

    RETITLED = "Timing is the last big lever, rethought"

    def sweep_while_jt_retitles(self, highlights, claim_id="r3"):
        """Run refresh; JT retitles *claim_id* during the network call."""
        def call(*args, **kwargs):
            canvas = cb.read_canvas(self.canvas_path())
            target = cb.claim_node_id(SLUG, claim_id)
            for node in canvas["nodes"]:
                if node["id"] == target:
                    lines = node["text"].split("\n")
                    lines[0] = lines[0] + ", rethought"
                    node["text"] = "\n".join(lines)
            M.atomic_write_text(self.canvas_path(), cb.dumps_canvas(canvas))
            return list(highlights)

        with mock.patch.object(readerapi, "get_document_highlights",
                               side_effect=call):
            return R.refresh(self.manifest, DOC_ID, self.vault)

    def test_a_card_that_gained_a_highlight_is_not_frozen(self):
        report = self.sweep_while_jt_retitles(
            [jt_highlight("h1", PARAGRAPHS[2], "✅ solid")]
        )
        self.assertEqual(report["matched"], {"r1": ["h1"]})

        jt = M.claims_by_id(self.manifest)["r1"]["jt"]
        self.assertNotIn("jt_section_override", jt)
        self.assertIsNone(jt["title_override"])
        self.assertEqual(
            [w for w in report["warnings"] if "JT" in w and "edited" in w], []
        )

        node = self.node_text("r1")
        self.assertIn(PARAGRAPHS[2], node["text"])
        self.assertIn("solid", node["text"])

    def test_the_mid_run_retitle_itself_still_lands(self):
        self.sweep_while_jt_retitles([jt_highlight("h1", PARAGRAPHS[2], "✅ solid")])
        jt = M.claims_by_id(self.manifest)["r3"]["jt"]
        self.assertEqual(jt["title_override"], self.RETITLED)
        self.assertIn(self.RETITLED, self.node_text("r3")["text"])

    def test_no_untouched_card_is_reported_as_edited(self):
        report = self.sweep_while_jt_retitles(
            [jt_highlight("h1", PARAGRAPHS[2], "✅ solid")]
        )
        self.assertEqual([w for w in report["warnings"] if "cite line" in w], [])
        by_id = M.claims_by_id(self.manifest)
        for claim_id in ("r1", "r2"):
            jt = by_id[claim_id]["jt"]
            self.assertNotIn("post_cite", jt, claim_id)
            self.assertNotIn("jt_section_override", jt, claim_id)
            self.assertIsNone(jt["title_override"], claim_id)
            self.assertIsNone(jt["body_override"], claim_id)

    def test_the_card_still_takes_highlights_on_a_later_run(self):
        # The freeze was permanent: prove the card is still live afterwards.
        self.sweep_while_jt_retitles([jt_highlight("h1", PARAGRAPHS[2], "✅ solid")])
        self.run_refresh([
            jt_highlight("h1", PARAGRAPHS[2], "✅ solid"),
            jt_highlight("h5", PARAGRAPHS[3], "and this too"),
        ])
        self.assertIn(PARAGRAPHS[3], self.node_text("r1")["text"])

    def test_a_real_pre_run_jt_section_edit_still_wins(self):
        # The guard only silences cards byte-identical to the run-start canvas.
        # An edit JT made BEFORE the run is caught by the first fold and stands.
        self.run_refresh([jt_highlight("h1", PARAGRAPHS[2], "✅ solid")])
        canvas = cb.read_canvas(self.canvas_path())
        target = cb.claim_node_id(SLUG, "r1")
        for node in canvas["nodes"]:
            if node["id"] == target:
                node["text"] = node["text"].replace("solid", "MY OWN WORDS")
        M.atomic_write_text(self.canvas_path(), cb.dumps_canvas(canvas))

        self.sweep_while_jt_retitles([
            jt_highlight("h1", PARAGRAPHS[2], "✅ solid"),
            jt_highlight("h5", PARAGRAPHS[3], "a new one"),
        ])
        jt = M.claims_by_id(self.manifest)["r1"]["jt"]
        self.assertIn("MY OWN WORDS", jt["jt_section_override"])
        self.assertIn("MY OWN WORDS", self.node_text("r1")["text"])


class StanceChangeTest(RefreshTestCase):
    def test_a_later_contrary_stance_overwrites_and_warns(self):
        self.run_refresh(BASE_HIGHLIGHTS)
        self.assertEqual(M.claims_by_id(self.manifest)["r1"]["jt"]["stance"], "agree")

        later = list(BASE_HIGHLIGHTS) + [
            jt_highlight("h4", PARAGRAPHS[3], "Dispute: actually no")
        ]
        report = self.run_refresh(later)

        self.assertEqual(M.claims_by_id(self.manifest)["r1"]["jt"]["stance"], "dispute")
        self.assertEqual(report["stance_changes"], [
            {"claim_id": "r1", "from": "agree", "to": "dispute", "reader_id": "h4"},
        ])
        warning = [w for w in report["warnings"] if "stance changed" in w]
        self.assertEqual(len(warning), 1)
        self.assertIn("agree", warning[0])
        self.assertIn("dispute", warning[0])
        self.assertIn("r1", warning[0])

    def test_the_same_stance_twice_does_not_warn(self):
        self.run_refresh(BASE_HIGHLIGHTS)
        later = list(BASE_HIGHLIGHTS) + [
            jt_highlight("h4", PARAGRAPHS[3], "agree again")
        ]
        report = self.run_refresh(later)
        self.assertEqual(report["stance_changes"], [])

    def test_the_recolored_card_follows_the_new_stance(self):
        self.run_refresh(BASE_HIGHLIGHTS)
        self.run_refresh(list(BASE_HIGHLIGHTS) + [
            jt_highlight("h4", PARAGRAPHS[3], "❌ actually no")
        ])
        self.assertEqual(self.node_text("r1").get("color"), "1")


class KnownHighlightEditTest(RefreshTestCase):
    """[36] a note JT writes in Reader AFTER the first sweep still lands."""

    def test_a_note_added_to_a_known_highlight_updates_the_record(self):
        plain = jt_highlight("h1", PARAGRAPHS[2])
        self.run_refresh([plain])
        by_id = M.claims_by_id(self.manifest)
        self.assertEqual(by_id["r1"]["jt"]["highlights"][0]["note"], "")
        self.assertIsNone(by_id["r1"]["jt"]["stance"])

        report = self.run_refresh([jt_highlight("h1", PARAGRAPHS[2], "❌ revised")])

        by_id = M.claims_by_id(self.manifest)
        self.assertEqual(report["updated"], ["h1"])
        self.assertEqual(report["skipped_known"], 0)
        self.assertEqual(report["new_highlights"], 0)
        self.assertEqual(by_id["r1"]["jt"]["stance"], "dispute")
        highlights = by_id["r1"]["jt"]["highlights"]
        self.assertEqual(len(highlights), 1)          # updated, never duplicated
        self.assertEqual(highlights[0]["note"], "revised")

    def test_a_changed_stance_on_a_known_highlight_warns(self):
        self.run_refresh(BASE_HIGHLIGHTS)             # h1 is "✅ solid"
        edited = [h for h in BASE_HIGHLIGHTS if h["id"] != "h1"]
        edited.append(jt_highlight("h1", PARAGRAPHS[2], "❌ changed my mind"))
        report = self.run_refresh(edited)

        self.assertEqual(M.claims_by_id(self.manifest)["r1"]["jt"]["stance"],
                         "dispute")
        self.assertEqual(report["stance_changes"], [
            {"claim_id": "r1", "from": "agree", "to": "dispute", "reader_id": "h1"},
        ])

    def test_the_recolored_card_follows_the_edited_note(self):
        self.run_refresh(BASE_HIGHLIGHTS)
        self.assertEqual(self.node_text("r1").get("color"), "4")     # agree
        edited = [h for h in BASE_HIGHLIGHTS if h["id"] != "h1"]
        edited.append(jt_highlight("h1", PARAGRAPHS[2], "❌ changed my mind"))
        self.run_refresh(edited)
        self.assertEqual(self.node_text("r1").get("color"), "1")     # dispute
        self.assertIn("changed my mind", self.node_text("r1")["text"])

    def test_an_edited_note_on_a_binned_highlight_updates_the_bin(self):
        self.run_refresh(BASE_HIGHLIGHTS)             # h3 straddles -> bin
        self.assertEqual(self.manifest["unmatched"][0]["note"],
                         "no idea where this goes")
        edited = [h for h in BASE_HIGHLIGHTS if h["id"] != "h3"]
        edited.append(jt_highlight("h3", STRADDLE, "still no idea, but louder"))
        report = self.run_refresh(edited)

        self.assertEqual(report["updated"], ["h3"])
        self.assertEqual(len(self.manifest["unmatched"]), 1)
        self.assertEqual(self.manifest["unmatched"][0]["note"],
                         "still no idea, but louder")

    def test_an_identical_replay_updates_nothing(self):
        self.run_refresh(BASE_HIGHLIGHTS)
        first = self.canvas_bytes()
        report = self.run_refresh(BASE_HIGHLIGHTS)
        self.assertEqual(report["updated"], [])
        self.assertEqual(report["skipped_known"], 3)
        self.assertEqual(self.canvas_bytes(), first)


class SourceDriftTest(RefreshTestCase):
    """[37] the cached html has to be the html the map was built against."""

    def test_a_drifted_cache_aborts_matching_with_a_warning(self):
        drifted = build_manifest(html_sha256=slicer.sha256_text("<p>other</p>"))
        cb.write_canvas(drifted, cb.build_canvas(drifted), self.vault)
        report = self.run_refresh(BASE_HIGHLIGHTS, manifest=drifted)

        warning = [w for w in report["warnings"] if "source drift" in w]
        self.assertEqual(len(warning), 1)
        self.assertIn(DOC_ID, warning[0])
        self.assertEqual(report["matched"], {})
        self.assertEqual(report["new_highlights"], 0)
        self.assertEqual(drifted["unmatched"], [])
        for claim in drifted["claims"]:
            self.assertEqual(claim["jt"]["highlights"], [])

    def test_an_empty_hash_proceeds_with_an_unbound_warning(self):
        unbound = build_manifest(html_sha256="")
        cb.write_canvas(unbound, cb.build_canvas(unbound), self.vault)
        report = self.run_refresh(BASE_HIGHLIGHTS, manifest=unbound)

        warning = [w for w in report["warnings"] if "unbound source" in w]
        self.assertEqual(len(warning), 1)
        self.assertEqual(report["matched"], {"r1": ["h1"], "r2": ["h2"]})

    def test_a_matching_hash_warns_about_nothing(self):
        report = self.run_refresh(BASE_HIGHLIGHTS)
        self.assertEqual(
            [w for w in report["warnings"]
             if "source drift" in w or "unbound source" in w],
            [],
        )


class UnknownEnvelopeTest(RefreshTestCase):
    """[38] processing nothing must not read as having found nothing."""

    def test_an_unrecognised_envelope_warns_loudly(self):
        report = self.run_refresh({"data_v2": {"items": [jt_highlight("h1", "x")]}})
        warning = [w for w in report["warnings"] if "UNRECOGNISED" in w]
        self.assertEqual(len(warning), 1)
        self.assertIn("data_v2", warning[0])
        self.assertEqual(report["new_highlights"], 0)

    def test_a_recognised_empty_envelope_does_not_warn(self):
        report = self.run_refresh({"result": []})
        self.assertEqual(
            [w for w in report["warnings"] if "UNRECOGNISED" in w], []
        )
        self.assertEqual(report["new_highlights"], 0)

    def test_the_singular_result_envelope_is_read(self):
        # ESCALATED: the live MCP gateway returned {"result": [...]} — without
        # this key every sweep reads zero highlights and reports a clean run.
        report = self.run_refresh({"result": list(BASE_HIGHLIGHTS)})
        self.assertEqual(report["matched"], {"r1": ["h1"], "r2": ["h2"]})
        self.assertEqual(report["machine_highlights"], 1)


class LiveDumpEnvelopeTest(unittest.TestCase):
    """[4] recognised-and-empty is a clean 0, not an unknown envelope."""

    def dump(self, payload, argv=None):
        import live_dump_highlights as dump_mod
        buffer = io.StringIO()
        with mock.patch.dict(os.environ, {"RUN_LIVE": "1"}), \
                mock.patch.object(readerapi, "get_document_highlights",
                                  return_value=payload), \
                contextlib.redirect_stdout(buffer):
            code = dump_mod.main(argv or ["--doc", "d"])
        return code, buffer.getvalue()

    def test_a_recognised_empty_payload_succeeds(self):
        code, out = self.dump({"result": []})
        self.assertEqual(code, 0)
        self.assertIn("highlights   : 0", out)
        self.assertNotIn("_LIST_KEYS", out)

    def test_an_unrecognised_payload_still_fails_with_advice(self):
        code, out = self.dump({"data_v2": {}})
        self.assertEqual(code, 1)
        self.assertIn("_LIST_KEYS", out)

    def test_raw_prints_the_whole_payload(self):
        # [5] --raw promised the full payload and truncated it at 16000 chars.
        payload = [{"id": "h%d" % n, "text": "x" * 400} for n in range(80)]
        code, out = self.dump(payload, argv=["--doc", "d", "--raw"])
        self.assertEqual(code, 0)
        self.assertIn(json.dumps(payload, ensure_ascii=False, indent=2), out)


class PayloadShapeTest(unittest.TestCase):
    def test_a_bare_list(self):
        self.assertEqual(len(R.as_highlight_list([{"id": 1}, {"id": 2}])), 2)

    def test_an_envelope(self):
        self.assertEqual(len(R.as_highlight_list({"highlights": [{"id": 1}]})), 1)
        self.assertEqual(len(R.as_highlight_list({"results": [{"id": 1}]})), 1)

    def test_the_singular_result_envelope(self):
        # what the live gateway actually returned on 2026-08-26
        self.assertEqual(len(R.as_highlight_list({"result": [{"id": 1}]})), 1)
        self.assertEqual(R.coerce_highlights({"result": []}), ([], True))

    def test_an_unknown_shape_is_empty_not_an_exception(self):
        self.assertEqual(R.as_highlight_list("nonsense"), [])
        self.assertEqual(R.as_highlight_list({"count": 3}), [])

    def test_coerce_reports_whether_the_shape_was_recognised(self):
        self.assertEqual(R.coerce_highlights([]), ([], True))
        self.assertEqual(R.coerce_highlights({"count": 3}), ([], False))
        self.assertEqual(R.coerce_highlights("nonsense"), ([], False))

    def test_the_accessor_reads_alternate_field_names(self):
        view = R.highlight_view(
            {"highlight_id": 7, "text": "t", "notes": "n", "readwise_url": "u"}
        )
        self.assertEqual(view["reader_id"], "7")
        self.assertEqual(view["text"], "t")
        self.assertEqual(view["note"], "n")
        self.assertEqual(view["url"], "u")

    def test_tags_normalize_from_dicts_and_strings(self):
        self.assertEqual(
            R.normalize_tags(["Daystrom-Claim", {"name": "Other"}]),
            ["daystrom-claim", "other"],
        )
        self.assertEqual(R.normalize_tags(None), [])

    def test_a_machine_highlight_is_recognised_case_insensitively(self):
        view = R.highlight_view({"id": 1, "text": "t", "tags": ["Daystrom-Claim"]})
        self.assertTrue(R.is_machine_highlight(view))


class TriageGlyphGuardrailTest(unittest.TestCase):
    """The manifest.validate warning that closes the triage-collision residue."""

    def base(self, **kwargs):
        manifest = M.new_manifest(
            "guardrail", {"document_id": "d"},
            [{"idx": 0, "title": "One", "block_start": 0, "block_end": 10}],
        )
        manifest["claims"] = [
            M.new_claim("g1", kwargs.get("title", "An ordinary title"), 0, "root", 0,
                        block_range=[0, 4], anchor_block=0,
                        body_md=kwargs.get("body", "An ordinary body.")),
        ]
        return manifest

    def test_a_star_led_title_warns(self):
        warnings = M.validate(self.base(title="⭐ A flagged-looking title"))
        self.assertEqual(len(warnings), 1)
        self.assertIn("g1", warnings[0])
        self.assertIn("title", warnings[0])
        self.assertIn("triage glyph", warnings[0])

    def test_every_triage_glyph_is_covered(self):
        for glyph in ("⭐", "\U0001f525", "⏭️", "⏭", "❓"):
            warnings = M.validate(self.base(title=glyph + " Leading"))
            self.assertEqual(len(warnings), 1, glyph)

    def test_a_glyph_led_body_warns(self):
        warnings = M.validate(self.base(body="❓ Is this really the claim?"))
        self.assertEqual(len(warnings), 1)
        self.assertIn("body_md", warnings[0])

    def test_leading_whitespace_does_not_hide_the_glyph(self):
        self.assertEqual(len(M.validate(self.base(title="  ⭐ Indented"))), 1)

    def test_a_mid_text_glyph_does_not_warn(self):
        self.assertEqual(
            M.validate(self.base(title="The author's ⭐ rating system explained")), []
        )
        self.assertEqual(
            M.validate(self.base(body="He gives it a ❓ and moves on quickly.")), []
        )

    def test_a_clean_manifest_warns_about_nothing(self):
        self.assertEqual(M.validate(self.base()), [])

    def test_the_warning_is_never_fatal(self):
        manifest = self.base(title="⭐ Leading")
        directory = tempfile.mkdtemp(prefix="dsr-guardrail-")
        self.addCleanup(shutil.rmtree, directory, True)
        path = os.path.join(directory, "m.json")
        M.save(manifest, path)                      # must not raise
        self.assertEqual(M.load(path)["claims"][0]["title"], "⭐ Leading")


if __name__ == "__main__":
    unittest.main()
