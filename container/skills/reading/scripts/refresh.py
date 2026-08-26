"""refresh — fold JT's reading back onto the map.

He reads in Reader and highlights normally, optionally writing ✅ / ❌ / 💡 (or
``agree`` / ``dispute`` / ``surface``) at the front of a highlight note.  This
sweeps the document's highlights, drops our own tagged anchors, locates each of
his against the cached source, matches it to the claim that owns those blocks,
and projects the result back onto the canvas.

Repeatable by design.  A highlight already recorded — anywhere, on a claim or
in the unmatched bin — is never recorded twice, so running refresh twice with
nothing new produces a byte-identical canvas.  Already-recorded is not the same
as unchanged, though: a note JT adds in Reader after an earlier sweep updates
that record in place and re-reads its stance, because thinking he wrote down is
not allowed to be invisible just because the highlight itself is old news.

What it will not do: infer.  A highlight that lands across two claims, or in
none, goes to the unmatched bin rather than being attached to a plausible
neighbour, and a note without the shorthand leaves stance untouched.

python3 stdlib only.
"""

import arm as arm_mod
import canvas_build as cb
import manifest as manifest_mod
import match as match_mod
import readerapi
import slice as slicer

CLAIM_TAG = arm_mod.CLAIM_TAG

#: Keys a highlight-list payload might be wrapped in.  ``result`` (singular) is
#: what the live MCP gateway actually returned on 2026-08-26 — without it a real
#: sweep reads zero highlights and reports a clean run.  Owned by ``arm`` and
#: aliased here: arm reads the same endpoint for the same reason, and when the
#: two modules each kept their own list they drifted, leaving arm blind to the
#: live envelope and recreating highlights that already existed.
_LIST_KEYS = arm_mod._LIST_KEYS

_ID_KEYS = ("id", "highlight_id", "highlightId", "hid")
_TEXT_KEYS = ("text", "content", "highlight", "quote", "html")
_NOTE_KEYS = ("note", "notes", "annotation")
_URL_KEYS = ("url", "readwise_url", "highlight_url", "link")


# --------------------------------------------------------------------------
# defensive payload handling
# --------------------------------------------------------------------------

#: ``(items, recognized)`` from whatever ``get_document_highlights`` returned.
#: One implementation, living in ``arm`` — see ``_LIST_KEYS`` above.  A
#: recognized envelope holding zero highlights is a document JT has not marked
#: up yet; an UNrecognized envelope is an API change that just silently ate his
#: reading, and the two look identical once coerced to ``[]``.
coerce_highlights = arm_mod.coerce_highlights

#: A short description of an unrecognized payload, for the run report.
_shape_of = arm_mod._shape_of


def as_highlight_list(payload):
    """Just the items from ``coerce_highlights`` — never raises, never guesses."""
    return coerce_highlights(payload)[0]


def _first(source, keys):
    for key in keys:
        value = source.get(key)
        if value is not None and value != "":
            return value
    return None


def normalize_tags(value):
    """Tags as a list of lowercase strings, from strings or {"name": ...} dicts."""
    if value is None:
        return []
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, (list, tuple)):
        return []
    tags = []
    for item in value:
        if isinstance(item, str):
            name = item
        elif isinstance(item, dict):
            name = item.get("name") or item.get("tag") or item.get("key") or ""
        else:
            name = str(item)
        name = str(name).strip().lower()
        if name:
            tags.append(name)
    return tags


def highlight_view(raw):
    """One normalized accessor over a Reader highlight object.

    ``{"reader_id", "text", "note", "tags", "url", "raw"}`` — everything the
    rest of this module is allowed to know about a highlight.
    """
    identifier = _first(raw, _ID_KEYS)
    return {
        "reader_id": str(identifier) if identifier is not None else "",
        "text": str(_first(raw, _TEXT_KEYS) or ""),
        "note": str(_first(raw, _NOTE_KEYS) or ""),
        "tags": normalize_tags(raw.get("tags")),
        "url": str(_first(raw, _URL_KEYS) or ""),
        "raw": raw,
    }


def is_machine_highlight(view):
    return CLAIM_TAG in view["tags"]


# --------------------------------------------------------------------------
# what we have already seen
# --------------------------------------------------------------------------

def recorded_highlights(manifest):
    """``reader id -> (claim | None, record)`` for everything already recorded.

    ``claim`` is None when the record sits in the unmatched bin.  Indexing the
    records themselves — rather than only their ids — is what lets a later
    sweep notice a note JT wrote in Reader AFTER the highlight was first swept
    up, instead of skipping the id and leaving that thinking invisible forever.
    """
    index = {}
    for claim in manifest.get("claims", []):
        for highlight in (claim.get("jt") or {}).get("highlights") or []:
            reader_id = highlight.get("reader_id")
            if reader_id and str(reader_id) not in index:
                index[str(reader_id)] = (claim, highlight)
    for item in manifest.get("unmatched") or []:
        reader_id = item.get("reader_id")
        if reader_id and str(reader_id) not in index:
            index[str(reader_id)] = (None, item)
    return index


def recorded_reader_ids(manifest):
    """Every reader id already on a claim or in the unmatched bin.

    Dedupe spans both, so a highlight that failed to match once does not get
    re-binned on every later refresh.
    """
    return set(recorded_highlights(manifest))


def source_drift(manifest, doc_id, html):
    """``(ok, warning)`` — is this cached html the html the map was built on?

    ``manifest["source"]["html_sha256"]`` is written at assembly against the
    exact html every anchor was verified in.  An empty hash is a legacy or
    unbound map: proceed, but say so out loud.  A non-empty MISmatch means the
    document was re-fetched under the map's feet, so a block index now names a
    different paragraph — matching stops there rather than attaching JT's
    reading to the wrong claims.
    """
    recorded = (manifest.get("source") or {}).get("html_sha256") or ""
    if not recorded:
        return True, (
            "unbound source: this map records no html_sha256, so the cached html "
            "for %s could not be verified; highlights were matched against it "
            "unchecked" % doc_id
        )
    actual = slicer.sha256_text(html)
    if actual != recorded:
        return False, (
            "source drift: the cached html for %s (sha256 %s) is not the html this "
            "map was built against (%s); nothing was matched — re-fetch the "
            "document and rebuild the map before refreshing"
            % (doc_id, actual[:12], recorded[:12])
        )
    return True, None


def _apply_stance(report, claim_id, jt, stance, reader_id):
    """Set a claim's stance, reporting a contradiction instead of hiding it."""
    if stance is None:
        return
    previous = jt.get("stance")
    if previous and previous != stance:
        report["stance_changes"].append({
            "claim_id": claim_id,
            "from": previous,
            "to": stance,
            "reader_id": reader_id,
        })
        report["warnings"].append(
            "%s: stance changed from %s to %s by a later highlight; the later "
            "one in the payload wins" % (claim_id, previous, stance)
        )
    jt["stance"] = stance


def reconcile_known(report, claim, record, view):
    """Fold an edit JT made in Reader to a highlight we already recorded.

    Returns True when something actually changed.  A byte-identical replay
    changes nothing and stays a no-op — that is what keeps refresh repeatable.
    A note written or rewritten after the first sweep updates the record in
    place (no second record, on a claim or in the bin) and re-reads its stance,
    because "we have seen this id" is not the same claim as "nothing about this
    highlight has changed".

    Three things count as changed, and each of the last two was once invisible:

      * the text, or the note.
      * the STANCE.  A matched record stores only the remainder left after the
        shorthand was split off, so ``✅ solid`` and ``❌ solid`` store the same
        note — a mind JT changed in Reader by editing one glyph never reached
        the card.  The parsed stance is therefore tracked beside the note.
      * the URL.  A highlight first swept from a payload that carried no
        permalink would otherwise never gain one.  A payload that omits a URL
        never erases the one already held; only a different URL is a change.
    """
    stance, remainder = match_mod.parse_stance(view["note"])
    # A binned record keeps the raw note; a matched one keeps the remainder
    # left after the stance shorthand was split off.  Compare like with like.
    note = view["note"] if claim is None else remainder

    # Stance is only meaningful on a matched record — a binned one keeps the
    # raw note, so an edited glyph already shows up as a note change.
    tracks_stance = claim is not None
    knew_stance = "stance" in record
    stance_changed = tracks_stance and knew_stance and record.get("stance") != stance
    if tracks_stance and not knew_stance:
        # A record written before stance was tracked: backfill it silently.
        # Counting the backfill as a change would report every pre-existing
        # highlight as edited on the first run after the upgrade.
        record["stance"] = stance

    url_changed = bool(view["url"]) and record.get("url") != view["url"]

    if (record.get("note") == note and record.get("text") == view["text"]
            and not stance_changed and not url_changed):
        return False

    record["note"] = note
    record["text"] = view["text"]
    if tracks_stance:
        record["stance"] = stance
    if view["url"]:
        record["url"] = view["url"]
    report["updated"].append(view["reader_id"])
    if claim is not None:
        _apply_stance(
            report, claim["id"], claim.setdefault("jt", {}), stance,
            view["reader_id"],
        )
    return True


# --------------------------------------------------------------------------
# refresh
# --------------------------------------------------------------------------

def refresh(manifest, doc_id, vault_dir, token=None):
    """Sweep JT's highlights onto the map.  Returns a run report."""
    report = {
        "surface": "refresh",
        "matched": {},
        "unmatched": 0,
        "unmatched_new": [],
        "stance_changes": [],
        "updated": [],
        "skipped_known": 0,
        "machine_highlights": 0,
        "new_highlights": 0,
        "warnings": [],
    }

    # Same check, same wording as arm.  A caller that hands refresh the wrong
    # document fetches one book's highlights and staples them onto another
    # book's claim map — and the html hash cannot catch it, because an unbound
    # manifest has no hash and two documents can share cached html.
    source = manifest.get("source") or {}
    recorded_doc = str(source.get("document_id") or "")
    if recorded_doc and str(doc_id) != recorded_doc:
        report["warnings"].append(
            "document mismatch: this map was built from %s but refresh was asked "
            "to act on %s; nothing was folded, matched or written"
            % (recorded_doc, doc_id)
        )
        return report
    if not recorded_doc:
        report["warnings"].append(
            "the manifest records no document id, so %s could not be checked "
            "against it; proceeding" % doc_id
        )

    existing, overlay, warnings = arm_mod.fold_canvas(manifest, vault_dir)
    report["warnings"].extend(warnings)
    if overlay is not None and overlay.get("invalid"):
        # Nothing was folded in and nothing may be written; the warnings above
        # say why.  arm stops dead on exactly this shape and refresh must too:
        # carrying on mutates the manifest, and because the broken canvas then
        # still matches the run-start snapshot, project() skips the second fold
        # and writes over the very file fold_canvas refused to touch.
        return report

    html = slicer.load_source(doc_id)
    blocks = slicer.load_blocks(doc_id)
    if html is None or blocks is None:
        report["warnings"].append(
            "source html for %s is not cached; highlights could not be located "
            "(re-fetch the document first)" % doc_id
        )
        return report

    ok, drift_warning = source_drift(manifest, doc_id, html)
    if drift_warning:
        report["warnings"].append(drift_warning)
    if not ok:
        return report

    try:
        payload = readerapi.get_document_highlights(doc_id, token=token)
    except readerapi.ReaderAPIError as exc:
        report["warnings"].append("could not read highlights for %s: %s" % (doc_id, exc))
        return report

    raw_items, recognized = coerce_highlights(payload)
    if not recognized:
        report["warnings"].append(
            "the highlights payload for %s came back in an UNRECOGNISED shape (%s) "
            "and no highlights could be read — this run processed nothing, it did "
            "not find nothing; widen refresh._LIST_KEYS to the new envelope key"
            % (doc_id, _shape_of(payload))
        )

    views = [highlight_view(raw) for raw in raw_items]
    machine = [v for v in views if is_machine_highlight(v)]
    theirs = [v for v in views if not is_machine_highlight(v)]
    report["machine_highlights"] = len(machine)

    known = recorded_highlights(manifest)
    seen = set(known)
    fresh = []
    for view in theirs:
        if not view["reader_id"]:
            report["warnings"].append(
                "a highlight came back with no id and was skipped: %r"
                % (view["text"][:80],)
            )
            continue
        if view["reader_id"] in seen:
            entry = known.get(view["reader_id"])
            if entry is None or not reconcile_known(
                report, entry[0], entry[1], view
            ):
                report["skipped_known"] += 1
            continue
        seen.add(view["reader_id"])
        fresh.append(view)
    report["new_highlights"] = len(fresh)

    if fresh:
        texts = match_mod.normalized_blocks(html, blocks)
        by_id = manifest_mod.claims_by_id(manifest)
        for view in fresh:
            indices = match_mod.locate_highlight(
                html, blocks, view["text"], texts=texts
            )
            claim_id = match_mod.match_to_claim(manifest, indices) if indices else None
            stance, remainder = match_mod.parse_stance(view["note"])

            if claim_id is None:
                manifest.setdefault("unmatched", []).append({
                    "reader_id": view["reader_id"],
                    "url": view["url"],
                    "text": view["text"],
                    "note": view["note"],
                })
                report["unmatched_new"].append(view["reader_id"])
                continue

            claim = by_id[claim_id]
            jt = claim.setdefault("jt", {})
            record = manifest_mod.new_highlight(
                reader_id=view["reader_id"],
                url=view["url"],
                text=view["text"],
                note=remainder,
            )
            # The remainder alone cannot tell ✅ solid from ❌ solid; the parsed
            # stance rides along so a later glyph-only edit is visible to
            # reconcile_known instead of reading as an unchanged replay.
            record["stance"] = stance
            jt.setdefault("highlights", []).append(record)
            report["matched"].setdefault(claim_id, []).append(view["reader_id"])
            _apply_stance(report, claim_id, jt, stance, view["reader_id"])

    report["unmatched"] = len(manifest.get("unmatched") or [])

    summary = (
        "matched %d highlight(s) onto %d card(s), %d unmatched, %d updated, "
        "%d already known" % (
            sum(len(v) for v in report["matched"].values()),
            len(report["matched"]),
            len(report["unmatched_new"]),
            len(report["updated"]),
            report["skipped_known"],
        )
    )
    arm_mod.project(manifest, vault_dir, existing, "refresh", "refresh", summary, report)
    report["canvas"] = cb.canvas_path(manifest, vault_dir)
    return report
