"""arm — give every triaged card a live cite link in Readwise Reader.

JT triages on the canvas by prepending ⭐ / 🔥 / ⏭️ / ❓ to card titles.  Arming
walks the ⭐ 🔥 ❓ cards, creates one ``daystrom-claim``-tagged highlight on the
exact source paragraph each card was written from, and writes the resulting
URL back onto the card's ``↳ cite`` line.  ⏭️ and untriaged cards are left
alone; a card that already has a highlight id is never armed twice.

Order of operations is doctrine, not preference:

  read the canvas -> fold JT's work into the manifest -> act -> project back

Acting before folding would arm a card JT had already skipped, or resurrect one
he deleted.  The manifest is saved after every successful create, so a network
failure half way through leaves a resumable run rather than a lost one.

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
import readerapi
import slice as slicer
import validate as validate_mod

#: Triage flags that mean "arm this".  ⏭️ (skip) deliberately absent.
ARM_FLAGS = ("⭐", "\U0001f525", "❓")
SKIP_FLAG = "⏭️"

#: Every machine-made highlight carries this tag — it is the cleanup path and
#: the way refresh tells our highlights from JT's.
CLAIM_TAG = "daystrom-claim"


# --------------------------------------------------------------------------
# paths
# --------------------------------------------------------------------------

def manifest_path(manifest, vault_dir):
    """``<vault>/<slug>-manifest.json`` — beside the canvas it projects."""
    name = manifest.get("manifest_file") or (manifest["slug"] + "-manifest.json")
    return os.path.join(vault_dir, name)


# --------------------------------------------------------------------------
# the shared read/fold/project cycle
# --------------------------------------------------------------------------

def fold_canvas(manifest, vault_dir):
    """Read the live canvas and fold JT's work into *manifest* in place.

    Returns ``(existing_canvas, overlay, warnings)``.  ``existing_canvas`` is
    None when there is no canvas yet — a first run — and is passed straight
    back to ``build_canvas`` as ``existing=`` so geometry survives.

    A hash mismatch against ``canvas_last_written_sha256`` is not an error and
    never aborts: it means JT has been working, which is the whole point.  It
    is re-parsed and noted, because the alternative — refusing to run — would
    make the tool useless exactly when he has been using the map.
    """
    warnings = []
    path = cb.canvas_path(manifest, vault_dir)
    existing = cb.read_canvas(path)
    if existing is None:
        return None, None, warnings
    if not manifest_mod.freshness_ok(manifest, path):
        warnings.append(
            "canvas: changed since we last wrote it; JT's edits were re-parsed and "
            "folded in before acting (nothing was clobbered)"
        )
    overlay = cp.parse_overlay(manifest, existing)
    cp.apply_overlay(manifest, overlay)
    warnings.extend(overlay.get("warnings") or [])
    return existing, overlay, warnings


def project(manifest, vault_dir, existing, surface, action, summary, report):
    """Rebuild the canvas from *manifest*, validate it, write, save, log.

    A canvas that fails validation is NOT written — a broken canvas file in a
    synced vault is worse than a stale one — but the manifest still is, so the
    highlights this run created are never lost.  Returns the canvas dict, or
    None when validation refused the write.
    """
    canvas = cb.build_canvas(manifest, existing=existing)
    exempt = cb.jt_geometry_ids(manifest, existing)
    violations = validate_mod.validate_canvas(canvas, exempt)
    path = manifest_path(manifest, vault_dir)

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

    A card qualifies when it carries at least one of ⭐ 🔥 ❓ and has no
    highlight id yet.  Pruned cards never appear (``live_claims``), so a card
    JT deleted stays deleted.
    """
    targets = []
    skipped = []
    for claim in manifest_mod.live_claims(manifest):
        flags = list((claim.get("jt") or {}).get("flags") or [])
        wanted = [f for f in flags if f in ARM_FLAGS]
        if not wanted:
            skipped.append({
                "claim_id": claim["id"],
                "reason": "skip flag only" if SKIP_FLAG in flags else "not triaged",
            })
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


# --------------------------------------------------------------------------
# arm
# --------------------------------------------------------------------------

def arm(manifest, doc_id, vault_dir, dry_run=False, token=None):
    """Create anchor highlights for every triaged, unarmed card.

    Returns a run report: ``armed``, ``skipped``, ``failed``, ``warnings``.
    With ``dry_run=True`` nothing is created and nothing is written — the
    report names the targets and stops.
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

    existing, _overlay, warnings = fold_canvas(manifest, vault_dir)
    report["warnings"].extend(warnings)

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

    path = manifest_path(manifest, vault_dir)

    for claim in targets:
        claim_id = claim["id"]
        anchor_block = claim.get("anchor_block")
        if not 0 <= anchor_block < len(blocks):
            report["failed"].append({
                "claim_id": claim_id,
                "error": "anchor_block %s does not exist (%d blocks cached)"
                         % (anchor_block, len(blocks)),
            })
            continue
        block_source = slicer.block_html(html, blocks[anchor_block])
        try:
            payload = readerapi.create_highlight(
                doc_id, block_source, tags=[CLAIM_TAG], token=token
            )
        except Exception as exc:                      # keep going: one bad card
            report["failed"].append({"claim_id": claim_id, "error": str(exc)})
            continue

        highlight_id, url = highlight_fields(payload)
        if not highlight_id:
            report["failed"].append({
                "claim_id": claim_id,
                "error": "the create call returned no usable highlight id",
            })
            continue

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
