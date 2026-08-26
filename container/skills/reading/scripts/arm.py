"""arm — give every triaged card a live cite link in Readwise Reader.

JT triages on the canvas by prepending ⭐ / 🔥 / ⏭️ / ❓ to card titles.  Arming
walks the ⭐ 🔥 ❓ cards, creates one ``daystrom-claim``-tagged highlight on the
exact source paragraph each card was written from, and writes the resulting
URL back onto the card's ``↳ cite`` line.  ⏭️ and untriaged cards are left
alone; a card that already has a highlight id is never armed twice.

Order of operations is doctrine, not preference:

  read the canvas -> fold JT's work into the manifest -> act -> project back

Acting before folding would arm a card JT had already skipped, or resurrect one
he deleted.  ``project`` reads the canvas again immediately before the write and
folds it a second time IF it changed while we were on the network — a paced
create loop runs for minutes, and anything he typed in Obsidian meanwhile would
otherwise be overwritten.  The manifest is saved after every successful create,
so a network failure half way through leaves a resumable run rather than a lost
one.

This module also owns the two helpers ``refresh`` reuses — ``fold_canvas`` and
``project`` — so both surfaces share exactly one implementation of the
read/fold/project cycle.

python3 stdlib only.  Every network call goes through readerapi, which owns
pacing and retry.
"""

import os

import canvas_build as cb
import canvas_parse as cp
import manifest as manifest_mod
import match as match_mod
import readerapi
import slice as slicer
import validate as validate_mod

#: Triage flags that mean "arm this".  ⏭️ (skip) deliberately absent.
ARM_FLAGS = ("⭐", "\U0001f525", "❓")
SKIP_FLAG = "⏭️"

#: Every machine-made highlight carries this tag — it is the cleanup path and
#: the way refresh tells our highlights from JT's.
CLAIM_TAG = "daystrom-claim"

#: A Reader highlight's permalink is derivable from its id, so a create that
#: answers with an id but no url still yields a working cite link.
READER_URL_TEMPLATE = "https://read.readwise.io/read/%s"

#: Payload shapes ``reader_get_document_highlights`` has been seen to use.
#: ``result`` (singular) is what the live MCP gateway actually returned on
#: 2026-08-26 — omitting it made a real response read as "no existing
#: highlights", which is precisely the reading that recreates a duplicate.
#: ``refresh`` aliases this tuple rather than keeping a second copy: two lists
#: of envelope keys is how the two surfaces drifted apart in the first place.
_LIST_KEYS = ("highlights", "results", "result", "data", "items")
_TEXT_KEYS = ("text", "content", "highlight", "quote", "html")


# --------------------------------------------------------------------------
# paths
# --------------------------------------------------------------------------

def manifest_path(manifest, vault_dir):
    """``<vault>/<slug>-manifest.json`` — beside the canvas it projects."""
    name = manifest.get("manifest_file") or (manifest["slug"] + "-manifest.json")
    return os.path.join(vault_dir, name)


def conflict_copies(canvas_path):
    """Sibling files that look like a sync conflict copy of *canvas_path*.

    Obsidian Sync parks the losing copy beside the file as
    ``<name> (conflicted copy <date>).canvas``; other sync clients write
    ``<name>.sync-conflict-<date>.canvas``.  Matched liberally — anything
    beside it whose name starts the same way and carries "conflict" — because
    a false positive costs one warning and a miss costs JT's newest edits.
    """
    directory = os.path.dirname(os.path.abspath(canvas_path))
    filename = os.path.basename(canvas_path)
    stem = os.path.splitext(filename)[0]
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        return []
    found = []
    for name in names:
        if name == filename or not name.lower().endswith(".canvas"):
            continue
        if not name.startswith(stem) or "conflict" not in name.lower():
            continue
        found.append(os.path.join(directory, name))
    return found


def _mtime(path):
    try:
        return os.path.getmtime(path)
    except OSError:
        return None


def _is_newer(candidate, reference):
    """True when *candidate* was modified after *reference* (unknown -> True)."""
    left, right = _mtime(candidate), _mtime(reference)
    if left is None or right is None:
        return True
    return left > right


def write_block_reason(canvas_path):
    """Why this canvas must not be written over right now, or None.

    One reason so far: a sync conflict copy newer than the canvas itself, which
    means JT's most recent work is in the sibling and ours would bury it.
    """
    newer = [p for p in conflict_copies(canvas_path) if _is_newer(p, canvas_path)]
    if newer:
        return ("the conflict copy %s is newer than the canvas itself, so JT's "
                "latest work is probably in it" % os.path.basename(newer[0]))
    return None


def blocked_overlay(reason):
    """An empty overlay carrying *reason* — the "do not fold, do not write" shape.

    Same key as ``canvas_parse.parse_overlay`` uses for a structurally invalid
    canvas, so one check at each caller covers both refusals.
    """
    return {
        "invalid": reason,
        "flags": {},
        "pruned": [],
        "title_overrides": {},
        "body_overrides": {},
        "post_cite_overrides": {},
        "jt_section_overrides": {},
        "furniture_edits": {},
        "moved": {},
        "alien_nodes": [],
        "warnings": [],
    }


def _merge_warnings(report, warnings):
    """Add warnings the report does not already carry.

    A run that folds the canvas twice — once before acting, once before writing
    because it changed meanwhile — would otherwise report the same observation
    about the same file twice.
    """
    have = report.setdefault("warnings", [])
    for warning in warnings:
        if warning not in have:
            have.append(warning)


# --------------------------------------------------------------------------
# the shared read/fold/project cycle
# --------------------------------------------------------------------------

def fold_canvas(manifest, vault_dir, snapshot=None):
    """Read the live canvas and fold JT's work into *manifest* in place.

    Returns ``(existing_canvas, overlay, warnings)``.  ``existing_canvas`` is
    None when there is no canvas yet — a first run — and is passed straight
    back to ``build_canvas`` as ``existing=`` so geometry survives.

    *snapshot* is only passed on a run's SECOND fold: it is the canvas this run
    started from, and every card still byte-identical to it is skipped whole
    (see ``canvas_parse.parse_overlay``), because by then the manifest has moved
    on and our own stale projection would otherwise read back as JT's edits.

    A hash mismatch against ``canvas_last_written_sha256`` is not an error and
    never aborts: it means JT has been working, which is the whole point.  It
    is re-parsed and noted, because the alternative — refusing to run — would
    make the tool useless exactly when he has been using the map.

    Three conditions DO abort, all signalled as ``invalid`` on the returned
    overlay and none of them applied to the manifest:

      * the file will not read or parse at all — a write caught mid-sync is
        truncated JSON, and letting ``JSONDecodeError`` escape would crash the
        run instead of reporting the refusal this method promises.
      * the canvas is structurally invalid (``parse_overlay``'s own verdict).
        A file with no usable nodes is a half-synced or corrupt write, not a
        map JT emptied, and folding it would prune every claim permanently.
      * a sync conflict copy sits beside the canvas and is newer than it, so
        his most recent work is in the sibling and writing ours would bury it.
    """
    warnings = []
    path = cb.canvas_path(manifest, vault_dir)
    try:
        existing = cb.read_canvas(path)
    except (OSError, ValueError) as exc:
        # ValueError covers json.JSONDecodeError.  A file we cannot even parse
        # is never a first run — mapping it to None would look like "no canvas
        # yet" and replace JT's half-written map with a fresh projection.
        reason = "the canvas file could not be read (%s)" % exc
        warnings.append(
            "canvas: %s; that is a broken or half-synced file rather than a map "
            "JT emptied, so nothing was folded in and nothing was written "
            "(repair or restore it, then re-run)" % reason
        )
        return None, blocked_overlay(reason), warnings
    if existing is None:
        return None, None, warnings
    if not manifest_mod.freshness_ok(manifest, path):
        warnings.append(
            "canvas: changed since we last wrote it; JT's edits were re-parsed and "
            "folded in before acting (nothing was clobbered)"
        )

    conflicts = conflict_copies(path)
    if conflicts:
        warnings.append(
            "canvas: sync conflict copies sit beside %s (%s); merge them back by hand"
            % (os.path.basename(path),
               ", ".join(os.path.basename(p) for p in conflicts))
        )
        reason = write_block_reason(path)
        if reason:
            warnings.append(
                "canvas: %s; nothing was folded in and nothing was written" % reason
            )
            return existing, blocked_overlay(reason), warnings

    overlay = cp.parse_overlay(manifest, existing, snapshot=snapshot)
    if overlay.get("invalid"):
        warnings.append(
            "canvas: %s; that is a broken file rather than a map JT emptied, so "
            "nothing was folded in and nothing was written (repair or restore it, "
            "then re-run)" % overlay["invalid"]
        )
        warnings.extend(overlay.get("warnings") or [])
        return existing, overlay, warnings

    cp.apply_overlay(manifest, overlay)
    warnings.extend(overlay.get("warnings") or [])
    return existing, overlay, warnings


def project(manifest, vault_dir, existing, surface, action, summary, report):
    """Re-read the live canvas, rebuild from *manifest*, validate, write, save.

    The canvas is read again HERE rather than trusting the snapshot the caller
    took before its network work: arming paces its creates seconds apart and a
    long run spans minutes, so anything JT typed in Obsidian meanwhile would
    otherwise be silently overwritten by a projection built from a pre-run
    picture of the map.  This is what makes the freshness check happen "before
    writing" for both callers, arm and refresh.

    Only a canvas that actually changed is folded again, and the second fold is
    handed the run-start snapshot so that only the cards whose text ACTUALLY
    changed are re-read.  Both halves guard the same failure: this run has moved
    the manifest on — new cites, matched highlights, a pruned card — while the
    canvas still shows the projection we wrote before it, so any card compared
    afresh reads as rewritten and our own stale text gets frozen into JT's
    verbatim slots.

    A canvas that fails validation is NOT written — a broken canvas file in a
    synced vault is worse than a stale one — but the manifest still is, so the
    highlights this run created are never lost.  The same holds when the write
    is refused outright (a canvas that will not parse, an invalid canvas, or a
    newer conflict copy).  Returns the canvas dict, or None when the write was
    refused.
    """
    canvas_file = cb.canvas_path(manifest, vault_dir)
    path = manifest_path(manifest, vault_dir)
    blocked = None
    live = None

    try:
        live = cb.read_canvas(canvas_file)
    except (OSError, ValueError) as exc:
        # The canvas went truncated or half-synced while we were on the network.
        # This is the documented "save the manifest, refuse the canvas" path:
        # the highlights this run created are real and must not be lost, but a
        # file we cannot even parse is certainly not one to overwrite.
        blocked = "the canvas file could not be read (%s)" % exc

    if blocked is None and live is not None and live != existing:
        live, overlay, warnings = fold_canvas(manifest, vault_dir, snapshot=existing)
        _merge_warnings(report, warnings)
        blocked = (overlay or {}).get("invalid")
    if not blocked:
        blocked = write_block_reason(canvas_file)

    if blocked:
        report.setdefault("warnings", []).append(
            "the canvas was NOT rewritten (%s); the manifest was saved" % blocked
        )
        manifest_mod.record_run(
            manifest, surface, action, summary + " — canvas not written (unsafe)"
        )
        manifest_mod.save(manifest, path)
        return None
    if live is not None:
        existing = live

    canvas = cb.build_canvas(manifest, existing=existing)
    exempt = cb.jt_geometry_ids(manifest, existing)
    violations = validate_mod.validate_canvas(canvas, exempt)

    if violations:
        report.setdefault("canvas_violations", []).extend(violations)
        report.setdefault("warnings", []).append(
            "canvas failed validation (%d problems); the canvas was NOT rewritten, "
            "the manifest was saved" % len(violations)
        )
        manifest_mod.record_run(
            manifest, surface, action, summary + " — canvas not written (invalid)"
        )
        manifest_mod.save(manifest, path)
        return None

    cb.write_canvas(manifest, canvas, vault_dir)
    manifest_mod.record_run(manifest, surface, action, summary)
    manifest_mod.save(manifest, path)
    return canvas


# --------------------------------------------------------------------------
# target selection
# --------------------------------------------------------------------------

def is_armed(claim):
    return bool((claim.get("cite") or {}).get("highlight_id"))


def select_targets(manifest):
    """``(targets, skipped)`` — which live cards this run would arm, and why not.

    A card qualifies when it carries at least one of ⭐ 🔥 ❓, does NOT carry
    ⏭️, and has no highlight id yet.  Skip wins over everything: a title
    reading ⏭️⭐ is a card JT decided against, and arming it would create a
    Reader highlight that cannot be deleted from the Reader side.  Pruned cards
    never appear (``live_claims``), so a card JT deleted stays deleted.
    """
    targets = []
    skipped = []
    for claim in manifest_mod.live_claims(manifest):
        flags = list((claim.get("jt") or {}).get("flags") or [])
        wanted = [f for f in flags if f in ARM_FLAGS]
        if SKIP_FLAG in flags:
            skipped.append({
                "claim_id": claim["id"],
                "reason": ("skip flag wins over %s" % " ".join(wanted)) if wanted
                          else "skip flag only",
            })
            continue
        if not wanted:
            skipped.append({"claim_id": claim["id"], "reason": "not triaged"})
            continue
        if is_armed(claim):
            skipped.append({"claim_id": claim["id"], "reason": "already armed"})
            continue
        if claim.get("anchor_block") is None:
            skipped.append({
                "claim_id": claim["id"],
                "reason": "no anchor block to hang a highlight on",
            })
            continue
        targets.append(claim)
    return targets, skipped


# --------------------------------------------------------------------------
# the highlight payload
# --------------------------------------------------------------------------

def highlight_fields(payload):
    """``(highlight_id, url)`` out of whatever shape the create call returned.

    The MCP tool has answered with ``id`` in every observed run, but the field
    name is not part of any contract we control, so read defensively rather
    than record a null id and re-arm the card forever.
    """
    if not isinstance(payload, dict):
        return None, None
    identifier = None
    for key in ("id", "highlight_id", "highlightId", "hid"):
        value = payload.get(key)
        if value is not None and value != "":
            identifier = str(value)
            break
    url = None
    for key in ("url", "readwise_url", "highlight_url", "link"):
        value = payload.get(key)
        if isinstance(value, str) and value:
            url = value
            break
    return identifier, url


def reader_url(highlight_id):
    """The Reader permalink for a highlight id, or None without one.

    A create that answers with an id but no url would otherwise record a card
    as armed with no link at all — permanently, since ``is_armed`` then keeps
    it out of every later run.  The url shape is documented and stable, so it
    is derived rather than lost.
    """
    if not highlight_id:
        return None
    return READER_URL_TEMPLATE % highlight_id


# --------------------------------------------------------------------------
# reconciling an attempt that may already have committed
# --------------------------------------------------------------------------

def coerce_highlights(payload):
    """``(items, recognized)`` from whatever ``get_document_highlights`` returned.

    The MCP tool hands back JSON decoded from a text block; the wrapper shape is
    not something we control, so accept a bare list or any of the usual envelope
    keys and never explode on a shape we have not seen.

    ``recognized`` is the half callers actually need: a recognized envelope
    holding zero highlights is a document with no machine highlights on it,
    while an UNrecognized envelope is an API change that told us nothing at all.
    The two look identical once the payload has been coerced to ``[]`` — and for
    arm that difference is the difference between "the failed create never
    committed, go ahead" and "we have no idea, do not create a second one".
    """
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)], True
    if isinstance(payload, dict):
        for key in _LIST_KEYS:
            value = payload.get(key)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)], True
    return [], False


def _shape_of(payload):
    """A short description of an unrecognized payload, for the run report."""
    if isinstance(payload, dict):
        keys = sorted(str(key) for key in payload.keys())
        return "a %s with keys: %s" % (
            type(payload).__name__, ", ".join(keys) if keys else "(none)"
        )
    return "a %s" % type(payload).__name__


def _highlight_list(payload):
    """Whatever ``get_document_highlights`` returned, as a list of dicts."""
    return coerce_highlights(payload)[0]


def _tag_names(value):
    """Tags as lowercase strings, from bare strings or ``{"name": ...}`` dicts."""
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, (list, tuple)):
        return []
    names = []
    for item in value:
        if isinstance(item, dict):
            item = item.get("name") or item.get("tag") or item.get("key") or ""
        name = str(item).strip().lower()
        if name:
            names.append(name)
    return names


def machine_highlights(payload):
    """Our own tagged highlights on the document: id, url and text apiece."""
    found = []
    for raw in _highlight_list(payload):
        if CLAIM_TAG not in _tag_names(raw.get("tags")):
            continue
        highlight_id, url = highlight_fields(raw)
        if not highlight_id:
            continue
        text = ""
        for key in _TEXT_KEYS:
            value = raw.get(key)
            if isinstance(value, str) and value:
                text = value
                break
        found.append({
            "highlight_id": highlight_id,
            "url": url or reader_url(highlight_id),
            "text": text,
        })
    return found


#: ``adoptable_highlight`` verdicts.  Only NONE may go on to create.
ADOPT_NONE = "none"
ADOPT_UNIQUE = "unique"
ADOPT_AMBIGUOUS = "ambiguous"


def matching_highlights(existing, html, block):
    """Every machine highlight that IS this block, best tier only.

    Exact normalized equality wins outright; highlights that merely CONTAIN the
    block are considered only when nothing matches exactly.
    """
    wanted = match_mod.block_norm(html, block)
    if not wanted:
        return []
    exact = [h for h in existing if match_mod.normalize(h["text"]) == wanted]
    if exact:
        return exact
    return [h for h in existing if wanted in match_mod.normalize(h["text"])]


def adoptable_highlight(existing, html, block, taken=()):
    """``(verdict, highlight)`` — what the document already holds for this block.

    Three outcomes, and conflating any two of them is a permanent mistake:

      * ``none`` — nothing on the document matches, so the ambiguous attempt
        plainly never committed and the claim may be created after all.
      * ``unique`` — exactly one match and no other card has taken it: adopt.
      * ``ambiguous`` — several matches, or the single match was already adopted
        by another pending claim this run.  Neither adopt nor create; adopting
        the wrong one points a cite at a passage the card was not written from,
        and creating adds yet another highlight Reader cannot delete.

    *taken* is the set of highlight ids already adopted, which is what makes
    adoption one-to-one: one existing highlight cannot settle two claims.
    """
    matches = matching_highlights(existing, html, block)
    if not matches:
        return ADOPT_NONE, None
    if len(matches) > 1:
        return ADOPT_AMBIGUOUS, None
    match = matches[0]
    if match["highlight_id"] in taken:
        return ADOPT_AMBIGUOUS, None
    return ADOPT_UNIQUE, match


def reconcile_attempts(targets, doc_id, html, blocks, token=None):
    """Settle every target whose last create ended ambiguously.

    A create that raised leaves ``attempted`` on the claim's cite: Reader may
    or may not have committed the highlight, and a second one cannot be taken
    back (Reader-side highlight ids are not deletable).  So before this run
    creates anything, the document's own ``daystrom-claim`` highlights are read
    once and an attempt that did commit is adopted instead of repeated.

    Returns ``(adoptions, unresolved)`` — ``{claim_id: highlight}`` for the
    ones already on the document, and ``{claim_id: reason}`` for the ones whose
    fate could not be established, which must not be re-created blind.

    Three ways the fate stays unestablished, all of them ending in
    ``unresolved`` rather than a create: the lookup failed, the payload came
    back in a shape we cannot read, or the document holds more than one
    candidate for the block (or exactly one that another pending card has
    already claimed).
    """
    pending = [c for c in targets if (c.get("cite") or {}).get("attempted")]
    if not pending:
        return {}, {}

    try:
        payload = readerapi.get_document_highlights(doc_id, token=token)
    except readerapi.ReaderAPIError as exc:        # the lookup itself failed
        reason = (
            "a previous run may already have created this highlight, and the "
            "document's highlights could not be read to find out (%s); no "
            "duplicate was created" % exc
        )
        return {}, dict((c["id"], reason) for c in pending)

    items, recognized = coerce_highlights(payload)
    if not recognized:
        # An unknown envelope is not an empty document.  Reading it as one is
        # exactly how a committed attempt gets a permanent twin.
        reason = (
            "a previous run may already have created this highlight, and the "
            "document's highlights came back in an UNRECOGNISED shape (%s) so "
            "nothing could be checked against it; no duplicate was created "
            "(widen arm._LIST_KEYS to the new envelope key)" % _shape_of(payload)
        )
        return {}, dict((c["id"], reason) for c in pending)

    existing = machine_highlights(items)
    adoptions = {}
    unresolved = {}
    taken = set()
    for claim in pending:
        anchor_block = claim.get("anchor_block")
        if not isinstance(anchor_block, int) or isinstance(anchor_block, bool):
            continue
        if not 0 <= anchor_block < len(blocks):
            continue
        verdict, match = adoptable_highlight(
            existing, html, blocks[anchor_block], taken
        )
        if verdict == ADOPT_UNIQUE:
            adoptions[claim["id"]] = match
            taken.add(match["highlight_id"])
        elif verdict == ADOPT_AMBIGUOUS:
            unresolved[claim["id"]] = (
                "a previous run may already have created this highlight and the "
                "document carries more than one tagged candidate for its block, "
                "so which one belongs to this card cannot be told apart; no "
                "duplicate was created (settle it by hand in Reader)"
            )
    return adoptions, unresolved


# --------------------------------------------------------------------------
# arm
# --------------------------------------------------------------------------

def arm(manifest, doc_id, vault_dir, dry_run=False, token=None):
    """Create anchor highlights for every triaged, unarmed card.

    Returns a run report: ``armed``, ``skipped``, ``failed``, ``warnings``.
    With ``dry_run=True`` nothing is created and nothing is written — the
    report names the targets and stops.

    Three checks come before any create, because every one of them guards
    against a permanent wrong highlight: *doc_id* must be this map's document,
    the canvas must be foldable, and the cached html must be the html the map
    was built from.
    """
    report = {
        "surface": "arm",
        "dry_run": bool(dry_run),
        "armed": [],
        "skipped": [],
        "failed": [],
        "warnings": [],
        "targets": [],
    }

    source = manifest.get("source") or {}
    recorded_doc = str(source.get("document_id") or "")
    if recorded_doc and str(doc_id) != recorded_doc:
        report["warnings"].append(
            "document mismatch: this map was built from %s but arm was asked to act "
            "on %s; nothing was folded, created or written" % (recorded_doc, doc_id)
        )
        return report
    if not recorded_doc:
        report["warnings"].append(
            "the manifest records no document id, so %s could not be checked against "
            "it; proceeding" % doc_id
        )

    existing, overlay, warnings = fold_canvas(manifest, vault_dir)
    _merge_warnings(report, warnings)
    if overlay is not None and overlay.get("invalid"):
        # Nothing was folded in and nothing may be written: the warnings above
        # say why.  Acting now would prune or clobber JT's real work.
        return report

    targets, skipped = select_targets(manifest)
    report["skipped"] = skipped
    report["targets"] = [c["id"] for c in targets]

    if dry_run:
        return report

    if not targets:
        project(
            manifest, vault_dir, existing, "arm", "arm",
            "no cards needed arming", report,
        )
        return report

    html = slicer.load_source(doc_id)
    blocks = slicer.load_blocks(doc_id)
    if html is None or blocks is None:
        report["warnings"].append(
            "source html for %s is not cached; nothing could be armed (re-fetch the "
            "document first)" % doc_id
        )
        return report

    # The block indices on the manifest were derived from the html the map was
    # built from.  A different HOME — container vs Claude Code — means a
    # different, freshly fetched cache, and the same index there can be a
    # different paragraph entirely.  A highlight on the wrong paragraph is
    # permanent, so drift stops the run.
    recorded_sha = str(source.get("html_sha256") or "")
    if recorded_sha and recorded_sha != slicer.sha256_text(html):
        report["warnings"].append(
            "source drift — the cached html for %s is not the html this map was "
            "built from, so its block indices cannot be trusted; nothing was armed "
            "(re-slice/rebuild the map first)" % doc_id
        )
        return report
    if not recorded_sha:
        report["warnings"].append(
            "the manifest has no source binding (source.html_sha256 is empty), so "
            "the cached html could not be verified against it; proceeding"
        )

    path = manifest_path(manifest, vault_dir)
    adoptions, unresolved = reconcile_attempts(
        targets, doc_id, html, blocks, token=token
    )

    for claim in targets:
        claim_id = claim["id"]
        if claim_id in unresolved:
            report["failed"].append({
                "claim_id": claim_id, "error": unresolved[claim_id],
            })
            continue

        adopted = adoptions.get(claim_id)
        if adopted is not None:
            claim["cite"] = {
                "highlight_id": adopted["highlight_id"], "url": adopted["url"],
            }
            report["armed"].append({
                "claim_id": claim_id,
                "highlight_id": adopted["highlight_id"],
                "url": adopted["url"],
                "adopted": True,
            })
            manifest_mod.save(manifest, path)
            continue

        anchor_block = claim.get("anchor_block")
        if not 0 <= anchor_block < len(blocks):
            report["failed"].append({
                "claim_id": claim_id,
                "error": "anchor_block %s does not exist (%d blocks cached)"
                         % (anchor_block, len(blocks)),
            })
            continue

        # The index alone is not provenance: assembly can default a missing
        # anchor to the start of the range, which would put a permanent
        # highlight on a paragraph the card was never written from.  The phrase
        # has to actually be in the block.
        block = blocks[anchor_block]
        phrase = match_mod.normalize(claim.get("anchor_phrase") or "")
        if not phrase:
            report["failed"].append({
                "claim_id": claim_id,
                "error": "no anchor phrase, so block %d could not be confirmed as "
                         "this card's source" % anchor_block,
            })
            continue
        if phrase not in match_mod.block_norm(html, block):
            report["failed"].append({
                "claim_id": claim_id,
                "error": "the anchor phrase %r does not occur in block %d, so that "
                         "block is not this card's source"
                         % (claim.get("anchor_phrase"), anchor_block),
            })
            continue

        # Record the attempt BEFORE the call.  A create that raises may still
        # have committed on Reader's side, and only a marker on disk makes that
        # ambiguity visible to the next run (see reconcile_attempts).
        claim["cite"] = {"highlight_id": None, "url": None, "attempted": True}
        manifest_mod.save(manifest, path)

        block_source = slicer.block_html(html, block)
        try:
            payload = readerapi.create_highlight(
                doc_id, block_source, tags=[CLAIM_TAG], token=token
            )
        except readerapi.ReaderAPIError as exc:        # keep going: one bad card
            report["failed"].append({"claim_id": claim_id, "error": str(exc)})
            continue

        highlight_id, url = highlight_fields(payload)
        if not highlight_id:
            report["failed"].append({
                "claim_id": claim_id,
                "error": "the create call returned no usable highlight id",
            })
            continue

        url = url or reader_url(highlight_id)
        claim["cite"] = {"highlight_id": highlight_id, "url": url}
        report["armed"].append({
            "claim_id": claim_id, "highlight_id": highlight_id, "url": url,
        })
        # Save after every success so an interrupted run resumes instead of
        # re-arming cards that already have a live highlight.
        manifest_mod.save(manifest, path)

    summary = "armed %d, skipped %d, failed %d" % (
        len(report["armed"]), len(report["skipped"]), len(report["failed"])
    )
    project(manifest, vault_dir, existing, "arm", "arm", summary, report)
    return report
