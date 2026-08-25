"""canvas_parse — read JT's work back off the canvas onto the manifest.

Every arm/refresh run parses before it projects.  What comes back:

  flags           triage flags per claim (replaces; an empty list clears)
  pruned          claim ids whose card is gone — never recreated
  title_overrides card titles JT rewrote, kept verbatim
  body_overrides  source-section body text JT edited, kept verbatim
  moved           node geometry JT changed (fed back as ``existing``)
  alien_nodes     cards JT added himself — listed, never deleted
  warnings        anything flag-like or edit-like that could not be folded in

Geometry is not stored on the manifest; it lives on the canvas and is carried
forward by passing the canvas to ``canvas_build.build_canvas(m, existing=...)``.

python3 stdlib only.
"""

import canvas_build as cb

# Longest token first: ⏭️ is U+23ED + VS16, ⏭ is the bare base character.
FLAG_TOKENS = ("⏭️", "⏭", "⭐", "\U0001f525", "❓")
FLAG_CANON = {"⏭": "⏭️"}

_VARIATION = (0xFE00, 0xFE0F)
_ZWJ = 0x200D
_EMOJI_RANGES = (
    (0x2300, 0x23FF),      # misc technical: ⏭ ⏸ ⏰
    (0x2600, 0x27BF),      # misc symbols + dingbats: ❓ ✅ ❌
    (0x2B00, 0x2BFF),      # ⭐
    (0x1F000, 0x1FAFF),    # emoji planes
)


def _is_emoji(char):
    code = ord(char)
    for low, high in _EMOJI_RANGES:
        if low <= code <= high:
            return True
    return False


def _is_continuation(char):
    code = ord(char)
    return _VARIATION[0] <= code <= _VARIATION[1] or code == _ZWJ


def split_leading_flags(text):
    """(flags, unknown_emoji, remainder) from the leading run of *text*.

    Flags are a leading run — that is where triage puts them and it is the
    exact inverse of the projection.  Emoji later in a line are prose.
    """
    flags = []
    unknown = []
    index = 0
    length = len(text)
    while index < length:
        char = text[index]
        if char in (" ", "\t"):
            index += 1
            continue
        if _is_continuation(char):
            index += 1
            continue
        matched = None
        for token in FLAG_TOKENS:
            if text.startswith(token, index):
                matched = token
                break
        if matched is not None:
            canonical = FLAG_CANON.get(matched, matched)
            if canonical not in flags:
                flags.append(canonical)
            index += len(matched)
            while index < length and _is_continuation(text[index]):
                index += 1
            continue
        if _is_emoji(char):
            end = index + 1
            while end < length and (
                _is_continuation(text[end])
                or (ord(text[end - 1]) == _ZWJ and _is_emoji(text[end]))
            ):
                end += 1
            unknown.append(text[index:end])
            index = end
            continue
        break
    return flags, unknown, text[index:]


# --------------------------------------------------------------------------
# card text decomposition
# --------------------------------------------------------------------------

def _trim_blank_edges(text):
    lines = text.split("\n")
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines)


def _norm_block(text):
    lines = [line.rstrip() for line in (text or "").split("\n")]
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines)


def split_card(text):
    """Decompose a card's text into its parts.

    Returns a dict with: title (flags stripped), flags, unknown, body,
    cite, jt (the overlay block, verbatim), has_jt.
    """
    text = text or ""
    head, separator, tail = text.rpartition(cb.JT_SEP)
    if separator:
        source, jt, has_jt = head, tail, True
    else:
        source, jt, has_jt = text, "", False

    lines = source.split("\n")
    title_index = None
    for position, line in enumerate(lines):
        if line.strip():
            title_index = position
            break
    if title_index is None:
        return {
            "title": "", "flags": [], "unknown": [], "body": "",
            "cite": "", "jt": jt, "has_jt": has_jt,
        }

    title_raw = lines[title_index].strip()
    while title_raw.startswith("#"):
        title_raw = title_raw[1:]
    flags, unknown, title = split_leading_flags(title_raw)

    cite_index = None
    for position in range(len(lines) - 1, title_index, -1):
        if lines[position].strip().startswith(cb.CITE_PREFIX):
            cite_index = position
            break
    cite = lines[cite_index].strip() if cite_index is not None else ""
    body_lines = lines[title_index + 1:cite_index] if cite_index is not None \
        else lines[title_index + 1:]

    # Flags may also sit on the second non-empty line; strip them there so the
    # body compares clean, but do not warn about prose emoji in the body.
    for position, line in enumerate(body_lines):
        if not line.strip():
            continue
        more, _unknown, remainder = split_leading_flags(line)
        if more:
            for flag in more:
                if flag not in flags:
                    flags.append(flag)
            body_lines = list(body_lines)
            body_lines[position] = remainder
        break

    return {
        "title": title.strip(),
        "flags": flags,
        "unknown": unknown,
        "body": _trim_blank_edges("\n".join(body_lines)),
        "cite": cite,
        "jt": jt,
        "has_jt": has_jt,
    }


# --------------------------------------------------------------------------
# overlay extraction
# --------------------------------------------------------------------------

def known_node_ids(manifest):
    """Every node/edge id this manifest could legitimately own, pruned included."""
    return cb.known_ids(manifest)


def parse_overlay(manifest, canvas_dict):
    """Extract JT's overlay from a canvas he has been working in."""
    slug = manifest["slug"]
    warnings = []
    canvas_dict = canvas_dict or {}
    nodes = canvas_dict.get("nodes")
    if not isinstance(nodes, list):
        warnings.append("canvas: no nodes array; treating the canvas as empty")
        nodes = []

    known = known_node_ids(manifest)
    claim_node = {}
    for claim in manifest.get("claims", []):
        claim_node[cb.claim_node_id(slug, claim["id"])] = claim
    by_node = {}
    for node in nodes:
        ident = node.get("id")
        if ident is None:
            warnings.append("canvas: a node has no id; skipped")
            continue
        if ident in by_node:
            warnings.append("canvas: duplicate node id %s; the last one wins" % ident)
        by_node[ident] = node

    flags = {}
    title_overrides = {}
    body_overrides = {}
    alien_nodes = []

    for ident, node in by_node.items():
        claim = claim_node.get(ident)
        if claim is None:
            if ident not in known and node.get("type") == "text":
                alien_nodes.append(node)
                warnings.append(
                    "canvas: card %s is not in the manifest (added by hand); left in place"
                    % ident
                )
            continue

        claim_id = claim["id"]
        text = node.get("text")
        if not isinstance(text, str):
            warnings.append("%s: card has no text; skipped" % claim_id)
            continue

        parts = split_card(text)
        flags[claim_id] = parts["flags"]
        for glyph in parts["unknown"]:
            warnings.append(
                "%s: unrecognised marker %r in the title line; not read as a flag"
                % (claim_id, glyph)
            )

        expected_body = (claim.get("jt") or {}).get("body_override")
        if expected_body is None:
            expected_body = claim.get("body_md") or ""
        if _norm_block(parts["body"]) != _norm_block(expected_body):
            body_overrides[claim_id] = parts["body"]

        # A title JT rewrote is his material and is kept verbatim, exactly like
        # a rewritten body.  Flags have already been stripped off the front.
        expected_title = (claim.get("jt") or {}).get("title_override")
        if expected_title is None:
            expected_title = claim.get("title") or ""
        if parts["title"] != expected_title.strip():
            title_overrides[claim_id] = parts["title"]

        # The cite line is machine-owned — arming rewrites it — so a hand edit
        # there is surfaced rather than captured.
        expected_cite = cb.cite_line(claim).strip()
        if expected_cite and parts["cite"] != expected_cite:
            warnings.append(
                "%s: cite line edited on the canvas; the manifest cite is unchanged"
                % claim_id
            )

    pruned = []
    for claim in manifest.get("claims", []):
        if cb.claim_node_id(slug, claim["id"]) not in by_node:
            pruned.append(claim["id"])

    # "Moved" means JT touched it.  Measure against the geometry we last wrote
    # when we have it; only fall back to a fresh projection (which reflows, and
    # would report half the map as moved) when there is no snapshot.
    snapshot = manifest.get("node_geometry")
    geometry = {}
    if snapshot is None:
        projected = cb.build_canvas(manifest)
        for node in projected.get("nodes", []):
            geometry[node["id"]] = (node["x"], node["y"], node["width"], node["height"])
    else:
        for ident, box in snapshot.items():
            if isinstance(box, (list, tuple)) and len(box) == 4:
                geometry[ident] = tuple(box)

    moved = {}
    for ident, node in by_node.items():
        reference = geometry.get(ident)
        if reference is None:
            continue
        current = (node.get("x"), node.get("y"), node.get("width"), node.get("height"))
        if current != reference:
            moved[ident] = {
                "x": node.get("x"), "y": node.get("y"),
                "width": node.get("width"), "height": node.get("height"),
            }

    return {
        "flags": flags,
        "pruned": pruned,
        "title_overrides": title_overrides,
        "body_overrides": body_overrides,
        "moved": moved,
        "alien_nodes": alien_nodes,
        "warnings": warnings,
    }


def apply_overlay(manifest, overlay):
    """Fold an overlay into the manifest in place.  Returns the manifest."""
    by_id = {claim["id"]: claim for claim in manifest.get("claims", [])}
    for claim_id, values in (overlay.get("flags") or {}).items():
        claim = by_id.get(claim_id)
        if claim is not None:
            claim.setdefault("jt", {})["flags"] = list(values)
    for claim_id in (overlay.get("pruned") or []):
        claim = by_id.get(claim_id)
        if claim is not None:
            claim.setdefault("jt", {})["pruned"] = True
    for claim_id, title in (overlay.get("title_overrides") or {}).items():
        claim = by_id.get(claim_id)
        if claim is not None:
            claim.setdefault("jt", {})["title_override"] = title
    for claim_id, body in (overlay.get("body_overrides") or {}).items():
        claim = by_id.get(claim_id)
        if claim is not None:
            claim.setdefault("jt", {})["body_override"] = body
    return manifest
