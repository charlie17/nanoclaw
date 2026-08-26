"""Tests for manifest.py — schema, atomic writes, freshness."""

import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import manifest as M  # noqa: E402


def sample_manifest():
    m = M.new_manifest(
        "control-your-retirement-destiny",
        {"document_id": "doc-1", "title": "Control Your Retirement Destiny",
         "author": "Dana Anspach", "category": "epub", "word_count": 91234,
         "html_sha256": "a" * 64, "fetched_at": "2026-08-25T12:00:00Z"},
        # half-open: block_end is exclusive and equals the next block_start
        [{"idx": 0, "title": "Ch 1 — Cash Flow", "block_start": 0, "block_end": 41},
         {"idx": 1, "title": "Ch 2 — Taxes", "block_start": 41, "block_end": 90}],
    )
    m["claims"] = [
        M.new_claim("c-0001", "Retirement is a cash-flow problem", 0, "root", 0,
                    locator="Ch 1", block_range=[2, 9], anchor_block=2,
                    anchor_phrase="cash flow, not a number",
                    body_md="**Claim** The author reframes retirement."),
        M.new_claim("c-0002", "Sequence risk dominates early years", 0, "c-0001", 0,
                    locator="Ch 1 §2", block_range=[10, 18], anchor_block=10,
                    anchor_phrase="the order of returns",
                    body_md="**Reasoning** Withdrawals in a down market lock in losses."),
        M.new_claim("c-0003", "Tax location beats tax rate", 1, "root", 0,
                    locator="Ch 2", block_range=[45, 60], anchor_block=45,
                    anchor_phrase="which account, not which rate",
                    body_md="**Support** Worked example across three accounts."),
    ]
    M.validate(m)
    return m


class ManifestRoundTripTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="dsr-manifest-")
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.path = os.path.join(self.dir, "m.json")

    def test_save_load_round_trip(self):
        m = sample_manifest()
        digest = M.save(m, self.path)
        self.assertEqual(len(digest), 64)
        self.assertEqual(digest, M.file_sha256(self.path))
        back = M.load(self.path)
        self.assertEqual(back, m)

    def test_round_trip_preserves_unicode_unescaped(self):
        m = sample_manifest()
        m["claims"][0]["jt"]["flags"] = ["⭐", "\U0001f525"]
        M.save(m, self.path)
        with open(self.path, "r", encoding="utf-8") as handle:
            raw = handle.read()
        self.assertIn("⭐", raw)
        self.assertNotIn("\\u2b50", raw)
        self.assertEqual(M.load(self.path)["claims"][0]["jt"]["flags"], ["⭐", "\U0001f525"])

    def test_new_manifest_shape(self):
        m = M.new_manifest("slug-x", {"title": "T"}, [{"idx": 0, "title": "One"}])
        self.assertEqual(m["version"], 1)
        self.assertEqual(m["canvas_file"], "slug-x.canvas")
        self.assertIsNone(m["canvas_last_written_sha256"])
        self.assertEqual(m["claims"], [])
        self.assertEqual(m["source"]["title"], "T")
        self.assertEqual(m["source"]["category"], "epub")

    def test_record_run_appends(self):
        m = sample_manifest()
        entry = M.record_run(m, "claude-code", "build", "62 cards, 4 chapters")
        self.assertEqual(len(m["runs"]), 1)
        self.assertEqual(m["runs"][0], entry)
        self.assertEqual(entry["surface"], "claude-code")
        self.assertTrue(entry["ts"].endswith("Z"))
        M.record_run(m, "container", "refresh", "9 highlights folded in")
        self.assertEqual(len(m["runs"]), 2)


class AtomicWriteTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="dsr-atomic-")
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.path = os.path.join(self.dir, "m.json")

    def test_no_partial_file_when_replace_fails(self):
        first = sample_manifest()
        M.save(first, self.path)
        with open(self.path, "r", encoding="utf-8") as handle:
            original = handle.read()

        second = sample_manifest()
        second["claims"][0]["title"] = "MUTATED — must never reach disk"
        real_replace = M.os.replace

        def boom(src, dst):
            raise OSError("injected failure during rename")

        M.os.replace = boom
        try:
            with self.assertRaises(OSError):
                M.save(second, self.path)
        finally:
            M.os.replace = real_replace

        with open(self.path, "r", encoding="utf-8") as handle:
            after = handle.read()
        self.assertEqual(after, original)
        self.assertNotIn("MUTATED", after)
        leftovers = [n for n in os.listdir(self.dir) if n.startswith(".tmp-")]
        self.assertEqual(leftovers, [], "temp file leaked: %r" % leftovers)

    def test_no_target_created_when_write_fails(self):
        path = os.path.join(self.dir, "never.json")
        real_replace = M.os.replace
        M.os.replace = lambda src, dst: (_ for _ in ()).throw(OSError("nope"))
        try:
            with self.assertRaises(OSError):
                M.atomic_write_text(path, "hello")
        finally:
            M.os.replace = real_replace
        self.assertFalse(os.path.exists(path))
        self.assertEqual([n for n in os.listdir(self.dir) if n.startswith(".tmp-")], [])

    def test_write_is_utf8_and_replaces_in_place(self):
        M.atomic_write_text(self.path, "café — ⭐\n")
        with open(self.path, "rb") as handle:
            self.assertEqual(handle.read().decode("utf-8"), "café — ⭐\n")
        M.atomic_write_text(self.path, "second\n")
        with open(self.path, "r", encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "second\n")


class ValidationTest(unittest.TestCase):
    def test_rejects_wrong_version(self):
        m = sample_manifest()
        m["version"] = 2
        with self.assertRaises(M.ManifestError) as ctx:
            M.validate(m)
        self.assertIn("version", str(ctx.exception))

    def test_rejects_duplicate_claim_ids(self):
        m = sample_manifest()
        m["claims"][1]["id"] = "c-0001"
        with self.assertRaises(M.ManifestError) as ctx:
            M.validate(m)
        self.assertIn("duplicate claim id", str(ctx.exception))
        self.assertIn("c-0001", str(ctx.exception))

    def test_rejects_dangling_parent(self):
        m = sample_manifest()
        m["claims"][1]["parent"] = "c-9999"
        with self.assertRaises(M.ManifestError) as ctx:
            M.validate(m)
        self.assertIn("resolves to no claim", str(ctx.exception))

    def test_rejects_insane_block_range(self):
        m = sample_manifest()
        m["claims"][0]["block_range"] = [9, 2]
        with self.assertRaises(M.ManifestError) as ctx:
            M.validate(m)
        self.assertIn("not sane", str(ctx.exception))

    def test_rejects_negative_block_range(self):
        m = sample_manifest()
        m["claims"][0]["block_range"] = [-1, 4]
        with self.assertRaises(M.ManifestError):
            M.validate(m)

    def test_rejects_parent_cycle(self):
        m = sample_manifest()
        m["claims"][0]["parent"] = "c-0002"
        with self.assertRaises(M.ManifestError) as ctx:
            M.validate(m)
        self.assertIn("cycle", str(ctx.exception))

    def test_load_rejects_invalid_file(self):
        directory = tempfile.mkdtemp(prefix="dsr-bad-")
        self.addCleanup(shutil.rmtree, directory, True)
        path = os.path.join(directory, "bad.json")
        m = sample_manifest()
        m["claims"][1]["parent"] = "nope"
        M.atomic_write_text(path, M.dumps(m))
        with self.assertRaises(M.ManifestError):
            M.load(path)

    def test_save_refuses_invalid_manifest(self):
        directory = tempfile.mkdtemp(prefix="dsr-bad2-")
        self.addCleanup(shutil.rmtree, directory, True)
        path = os.path.join(directory, "m.json")
        m = sample_manifest()
        m["claims"][0]["id"] = ""
        with self.assertRaises(M.ManifestError):
            M.save(m, path)
        self.assertFalse(os.path.exists(path))


class CoreFieldTypeTest(unittest.TestCase):
    """Loaded manifests are persisted JSON: their types are checked here or nowhere.

    Every shape below used to pass ``load()`` and then crash a surface that
    reads the field without a guard — ``body.strip()``, ``int(word_count)``,
    ``0 <= anchor_block``, ``item.get(...)``.
    """

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="dsr-types-")
        self.addCleanup(shutil.rmtree, self.dir, True)

    def rejected(self, mutate):
        m = sample_manifest()
        mutate(m)
        with self.assertRaises(M.ManifestError) as ctx:
            M.validate(m)
        return str(ctx.exception)

    def accepted(self, mutate):
        m = sample_manifest()
        mutate(m)
        M.validate(m)
        return m

    # ---- claim text fields ------------------------------------------------

    def test_rejects_a_numeric_body(self):
        self.assertIn("body_md", self.rejected(
            lambda m: m["claims"][0].__setitem__("body_md", 1)))

    def test_rejects_a_list_title(self):
        self.assertIn("title", self.rejected(
            lambda m: m["claims"][0].__setitem__("title", ["a", "b"])))

    def test_rejects_a_null_locator(self):
        self.assertIn("locator", self.rejected(
            lambda m: m["claims"][0].__setitem__("locator", None)))

    def test_rejects_a_numeric_anchor_phrase(self):
        self.assertIn("anchor_phrase", self.rejected(
            lambda m: m["claims"][0].__setitem__("anchor_phrase", 7)))

    # ---- claim integer fields ---------------------------------------------

    def test_rejects_a_string_order(self):
        self.assertIn("order", self.rejected(
            lambda m: m["claims"][0].__setitem__("order", "1")))

    def test_rejects_a_boolean_order(self):
        self.assertIn("order", self.rejected(
            lambda m: m["claims"][0].__setitem__("order", True)))

    def test_rejects_a_string_chapter_idx(self):
        self.assertIn("chapter_idx", self.rejected(
            lambda m: m["claims"][0].__setitem__("chapter_idx", "0")))

    def test_rejects_a_string_anchor_block(self):
        self.assertIn("anchor_block", self.rejected(
            lambda m: m["claims"][0].__setitem__("anchor_block", "3")))

    def test_rejects_a_boolean_anchor_block(self):
        self.assertIn("anchor_block", self.rejected(
            lambda m: m["claims"][0].__setitem__("anchor_block", False)))

    def test_a_null_anchor_block_is_still_allowed(self):
        self.accepted(lambda m: m["claims"][0].__setitem__("anchor_block", None))

    # ---- cite -------------------------------------------------------------

    def test_rejects_a_non_object_cite(self):
        self.assertIn("cite", self.rejected(
            lambda m: m["claims"][0].__setitem__("cite", "https://x")))

    def test_rejects_a_numeric_cite_field(self):
        self.assertIn("cite.highlight_id", self.rejected(
            lambda m: m["claims"][0]["cite"].__setitem__("highlight_id", 5)))

    # ---- the jt overlay ---------------------------------------------------

    def test_rejects_a_string_pruned(self):
        # "false" is truthy: it would silently delete the card
        self.assertIn("pruned", self.rejected(
            lambda m: m["claims"][0]["jt"].__setitem__("pruned", "false")))

    def test_rejects_a_bare_string_flags(self):
        self.assertIn("flags", self.rejected(
            lambda m: m["claims"][0]["jt"].__setitem__("flags", "⭐")))

    def test_rejects_null_notes(self):
        self.assertIn("notes", self.rejected(
            lambda m: m["claims"][0]["jt"].__setitem__("notes", None)))

    def test_rejects_a_string_inside_highlights(self):
        self.assertIn("highlights", self.rejected(
            lambda m: m["claims"][0]["jt"].__setitem__("highlights", ["bad"])))

    def test_a_real_highlight_object_is_accepted(self):
        self.accepted(lambda m: m["claims"][0]["jt"].__setitem__(
            "highlights", [M.new_highlight("h-1", "u", "text", "")]))

    # ---- the verbatim slots the canvas writes back -------------------------

    def test_rejects_a_numeric_post_cite(self):
        self.assertIn("post_cite", self.rejected(
            lambda m: m["claims"][0]["jt"].__setitem__("post_cite", 5)))

    def test_rejects_a_numeric_jt_section_override(self):
        self.assertIn("jt_section_override", self.rejected(
            lambda m: m["claims"][0]["jt"].__setitem__("jt_section_override", 5)))

    def test_an_empty_jt_section_override_is_accepted(self):
        # "" is a real value: it is how "JT deleted that section" is recorded.
        self.accepted(lambda m: m["claims"][0]["jt"].__setitem__(
            "jt_section_override", ""))

    def test_an_empty_post_cite_is_accepted(self):
        self.accepted(lambda m: m["claims"][0]["jt"].__setitem__("post_cite", ""))

    def test_real_text_in_both_slots_is_accepted(self):
        def edit(m):
            m["claims"][0]["jt"]["post_cite"] = "My own thought about this."
            m["claims"][0]["jt"]["jt_section_override"] = "— JT —\n\nmy wording"
        self.accepted(edit)

    def test_both_slots_absent_is_the_ordinary_case(self):
        self.accepted(lambda m: None)

    # ---- source -----------------------------------------------------------

    def test_rejects_a_nonnumeric_word_count(self):
        self.assertIn("word_count", self.rejected(
            lambda m: m["source"].__setitem__("word_count", "unknown")))

    def test_rejects_a_negative_word_count(self):
        self.assertIn("word_count", self.rejected(
            lambda m: m["source"].__setitem__("word_count", -1)))

    def test_rejects_a_boolean_word_count(self):
        self.assertIn("word_count", self.rejected(
            lambda m: m["source"].__setitem__("word_count", True)))

    def test_rejects_an_unknown_category(self):
        self.assertIn("category", self.rejected(
            lambda m: m["source"].__setitem__("category", "audiobook")))

    def test_rejects_a_numeric_source_title(self):
        self.assertIn("source.title", self.rejected(
            lambda m: m["source"].__setitem__("title", 5)))

    def test_rejects_a_numeric_html_sha256(self):
        self.assertIn("html_sha256", self.rejected(
            lambda m: m["source"].__setitem__("html_sha256", 0)))

    # ---- the other persisted collections ----------------------------------

    def test_rejects_a_string_in_unmatched(self):
        self.assertIn("unmatched", self.rejected(
            lambda m: m.__setitem__("unmatched", ["bad"])))

    def test_rejects_null_runs(self):
        self.assertIn("runs", self.rejected(
            lambda m: m.__setitem__("runs", None)))

    # ---- back-compat ------------------------------------------------------

    def test_load_rejects_a_malformed_core_field_on_disk(self):
        path = os.path.join(self.dir, "bad-types.json")
        m = sample_manifest()
        m["claims"][0]["body_md"] = 1
        M.atomic_write_text(path, M.dumps(m))
        with self.assertRaises(M.ManifestError):
            M.load(path)

    def test_unknown_extra_keys_still_validate(self):
        # the live pilot manifest carries root_md / body_full alongside the
        # schema; hardening the known fields must not reject the unknown ones
        m = self.accepted(lambda m: m.__setitem__("root_md", "# Root"))
        m["claims"][0]["body_full"] = "the long form"
        m["source"]["reader_url"] = "https://readwise.io/read/x"
        M.validate(m)

    def test_a_constructor_built_manifest_round_trips_through_load(self):
        path = os.path.join(self.dir, "ok.json")
        M.save(sample_manifest(), path)
        self.assertEqual(len(M.load(path)["claims"]), 3)


class HalfOpenChapterTest(unittest.TestCase):
    """block_end is EXCLUSIVE: chapters[i].block_end == chapters[i+1].block_start."""

    def test_contiguous_half_open_ranges_are_valid(self):
        m = M.new_manifest("s", {}, [
            {"idx": 0, "title": "A", "block_start": 0, "block_end": 100},
            {"idx": 1, "title": "B", "block_start": 100, "block_end": 250},
            {"idx": 2, "title": "C", "block_start": 250, "block_end": 300},
        ])
        M.validate(m)

    def test_empty_chapter_is_valid(self):
        m = M.new_manifest("s", {}, [
            {"idx": 0, "title": "A", "block_start": 7, "block_end": 7},
        ])
        M.validate(m)

    def test_overlapping_chapters_are_rejected(self):
        m = M.new_manifest("s", {}, [
            {"idx": 0, "title": "A", "block_start": 0, "block_end": 100},
        ])
        m["chapters"].append(
            {"idx": 1, "title": "B", "block_start": 99, "block_end": 200})
        with self.assertRaises(M.ManifestError) as ctx:
            M.validate(m)
        self.assertIn("overlaps", str(ctx.exception))
        self.assertIn("exclusive", str(ctx.exception))

    def test_inclusive_style_ranges_are_caught_as_overlap(self):
        # the old inclusive convention (end == next start - 1 + 1 overlap) trips
        m = M.new_manifest("s", {}, [{"idx": 0, "block_start": 0, "block_end": 40}])
        m["chapters"].append({"idx": 1, "block_start": 40, "block_end": 90})
        M.validate(m)  # half-open and contiguous: fine
        m["chapters"][1]["block_start"] = 39
        with self.assertRaises(M.ManifestError):
            M.validate(m)

    def test_reversed_chapter_range_is_rejected(self):
        m = M.new_manifest("s", {}, [{"idx": 0, "block_start": 0, "block_end": 10}])
        m["chapters"][0]["block_end"] = 5
        m["chapters"][0]["block_start"] = 9
        with self.assertRaises(M.ManifestError) as ctx:
            M.validate(m)
        self.assertIn("half-open", str(ctx.exception))

    def test_chapter_idx_minus_one_is_reserved(self):
        m = M.new_manifest("s", {}, [{"idx": 0, "block_start": 0, "block_end": 10}])
        m["chapters"][0]["idx"] = -1
        with self.assertRaises(M.ManifestError) as ctx:
            M.validate(m)
        self.assertIn("reserved for overview", str(ctx.exception))


class OverviewClaimTest(unittest.TestCase):
    def test_overview_claim_defaults_to_no_range_and_no_anchor(self):
        claim = M.new_claim("o-1", "Thesis", M.OVERVIEW_IDX, "root", 0,
                            body_md="The whole book in one card.")
        self.assertIsNone(claim["block_range"])
        self.assertIsNone(claim["anchor_block"])
        self.assertTrue(M.is_overview(claim))

    def test_manifest_with_a_rangeless_overview_claim_validates(self):
        m = sample_manifest()
        m["claims"].append(M.new_claim("o-1", "Thesis", -1, "root", 0))
        M.validate(m)

    def test_overview_claim_may_still_cite(self):
        m = sample_manifest()
        m["claims"].append(M.new_claim("o-1", "Thesis", -1, "root", 0,
                                       block_range=[3, 5], anchor_block=3,
                                       url="https://readwise.io/open/1"))
        M.validate(m)
        self.assertEqual(m["claims"][-1]["block_range"], [3, 5])

    def test_overview_claim_with_a_bad_range_is_still_rejected(self):
        m = sample_manifest()
        m["claims"].append(M.new_claim("o-1", "Thesis", -1, "root", 0,
                                       block_range=[9, 2]))
        with self.assertRaises(M.ManifestError) as ctx:
            M.validate(m)
        self.assertIn("not sane", str(ctx.exception))

    def test_chapter_claim_still_requires_a_block_range(self):
        m = sample_manifest()
        m["claims"][0]["block_range"] = None
        with self.assertRaises(M.ManifestError) as ctx:
            M.validate(m)
        self.assertIn("two-element array", str(ctx.exception))


class RelTest(unittest.TestCase):
    def test_default_rel(self):
        claim = M.new_claim("c-1", "T", 0, "root", 0)
        self.assertEqual(claim["rel"], "supports")
        self.assertEqual(M.claim_rel(claim), "supports")

    def test_every_vocabulary_value_validates(self):
        for rel in M.REL_VOCABULARY:
            m = sample_manifest()
            m["claims"][1]["rel"] = rel
            M.validate(m)

    def test_unknown_rel_is_rejected(self):
        m = sample_manifest()
        m["claims"][1]["rel"] = "refutes"
        with self.assertRaises(M.ManifestError) as ctx:
            M.validate(m)
        self.assertIn("rel", str(ctx.exception))
        self.assertIn("refutes", str(ctx.exception))

    def test_absent_rel_is_allowed_and_defaults(self):
        m = sample_manifest()
        del m["claims"][1]["rel"]
        M.validate(m)
        self.assertEqual(M.claim_rel(m["claims"][1]), "supports")

    def test_null_rel_is_allowed_and_defaults(self):
        m = sample_manifest()
        m["claims"][1]["rel"] = None
        M.validate(m)
        self.assertEqual(M.claim_rel(m["claims"][1]), "supports")

    def test_rel_survives_a_save_load_round_trip(self):
        directory = tempfile.mkdtemp(prefix="dsr-rel-")
        self.addCleanup(shutil.rmtree, directory, True)
        path = os.path.join(directory, "m.json")
        m = sample_manifest()
        m["claims"][1]["rel"] = "objection"
        M.save(m, path)
        self.assertEqual(M.load(path)["claims"][1]["rel"], "objection")


class FreshnessTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="dsr-fresh-")
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.canvas = os.path.join(self.dir, "x.canvas")

    def test_never_written_is_ok(self):
        m = sample_manifest()
        self.assertIsNone(m["canvas_last_written_sha256"])
        self.assertTrue(M.freshness_ok(m, self.canvas))

    def test_missing_canvas_is_ok(self):
        m = sample_manifest()
        m["canvas_last_written_sha256"] = "b" * 64
        self.assertTrue(M.freshness_ok(m, self.canvas))

    def test_unmodified_canvas_is_fresh(self):
        m = sample_manifest()
        m["canvas_last_written_sha256"] = M.atomic_write_text(self.canvas, '{"nodes":[]}')
        self.assertTrue(M.freshness_ok(m, self.canvas))

    def test_external_modification_fires(self):
        m = sample_manifest()
        m["canvas_last_written_sha256"] = M.atomic_write_text(self.canvas, '{"nodes":[]}')
        self.assertTrue(M.freshness_ok(m, self.canvas))
        with open(self.canvas, "a", encoding="utf-8") as handle:
            handle.write("\n")
        self.assertFalse(M.freshness_ok(m, self.canvas))

    def test_canvas_hash_matches_file_bytes(self):
        digest = M.atomic_write_text(self.canvas, "abc")
        self.assertEqual(M.canvas_hash(self.canvas), digest)
        self.assertIsNone(M.canvas_hash(os.path.join(self.dir, "gone.canvas")))


if __name__ == "__main__":
    unittest.main()
