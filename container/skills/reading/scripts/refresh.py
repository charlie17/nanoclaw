"""refresh — fold JT's reading back onto the map.

He reads in Reader and highlights normally, optionally writing ✅ / ❌ / 💡 (or
``agree`` / ``dispute`` / ``surface``) at the front of a highlight note.  This
sweeps the document's highlights, drops our own tagged anchors, locates each of
his against the cached source, matches it to the claim that owns those blocks,
and projects the result back onto the canvas.

Repeatable by design.  A highlight already recorded — anywhere, on a claim or
in the unmatched bin — is skipped by reader id, so running refresh twice with
nothing new produces a byte-identical canvas.

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

#: Keys a highlight-list payload might be wrapped in.
_LIST_KEYS = ("highlights", "results", "data", "items")

_ID_KEYS = ("id", "highlight_id", "highlightId", "hid")
_TEXT_KEYS = ("text", "content", "highlight", "quote", "html")
_NOTE_KEYS = ("note", "notes", "annotation")
_URL_KEYS = ("url", "readwise_url", "highlight_url", "link")


# --------------------------------------------------------------------------
# defensive payload handling
# --------------------------------------------------------------------------

def as_highlight_list(payload):
    """Coerce whatever ``get_document_highlights`` returned into a list.

    The MCP tool hands back JSON decoded from a text block; the wrapper shape
    is not something we control, so accept a bare list or any of the usual
    envelope keys and never explode on a shape we have not seen.
    """
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict):
        for key in _LIST_KEYS:
            value = payload.get(key)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)]
    return []


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

def recorded_reader_ids(manifest):
    """Every reader id already on a claim or in the unmatched bin.

    Dedupe spans both, so a highlight that failed to match once does not get
    re-binned on every later refresh.
    """
    seen = set()
    for claim in manifest.get("claims", []):
        for highlight in (claim.get("jt") or {}).get("highlights") or []:
            reader_id = highlight.get("reader_id")
            if reader_id:
                seen.add(str(reader_id))
    for item in manifest.get("unmatched") or []:
        reader_id = item.get("reader_id")
        if reader_id:
            seen.add(str(reader_id))
    return seen


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
        "skipped_known": 0,
        "machine_highlights": 0,
        "new_highlights": 0,
        "warnings": [],
    }

    existing, _overlay, warnings = arm_mod.fold_canvas(manifest, vault_dir)
    report["warnings"].extend(warnings)

    html = slicer.load_source(doc_id)
    blocks = slicer.load_blocks(doc_id)
    if html is None or blocks is None:
        report["warnings"].append(
            "source html for %s is not cached; highlights could not be located "
            "(re-fetch the document first)" % doc_id
        )
        return report

    try:
        payload = readerapi.get_document_highlights(doc_id, token=token)
    except Exception as exc:
        report["warnings"].append("could not read highlights for %s: %s" % (doc_id, exc))
        return report

    views = [highlight_view(raw) for raw in as_highlight_list(payload)]
    machine = [v for v in views if is_machine_highlight(v)]
    theirs = [v for v in views if not is_machine_highlight(v)]
    report["machine_highlights"] = len(machine)

    seen = recorded_reader_ids(manifest)
    fresh = []
    for view in theirs:
        if not view["reader_id"]:
            report["warnings"].append(
                "a highlight came back with no id and was skipped: %r"
                % (view["text"][:80],)
            )
            continue
        if view["reader_id"] in seen:
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
            jt.setdefault("highlights", []).append(manifest_mod.new_highlight(
                reader_id=view["reader_id"],
                url=view["url"],
                text=view["text"],
                note=remainder,
            ))
            report["matched"].setdefault(claim_id, []).append(view["reader_id"])

            if stance is not None:
                previous = jt.get("stance")
                if previous and previous != stance:
                    change = {
                        "claim_id": claim_id,
                        "from": previous,
                        "to": stance,
                        "reader_id": view["reader_id"],
                    }
                    report["stance_changes"].append(change)
                    report["warnings"].append(
                        "%s: stance changed from %s to %s by a later highlight; the "
                        "newer one wins" % (claim_id, previous, stance)
                    )
                jt["stance"] = stance

    report["unmatched"] = len(manifest.get("unmatched") or [])

    summary = "matched %d highlight(s) onto %d card(s), %d unmatched, %d already known" % (
        sum(len(v) for v in report["matched"].values()),
        len(report["matched"]),
        len(report["unmatched_new"]),
        report["skipped_known"],
    )
    arm_mod.project(manifest, vault_dir, existing, "refresh", "refresh", summary, report)
    report["canvas"] = cb.canvas_path(manifest, vault_dir)
    return report
