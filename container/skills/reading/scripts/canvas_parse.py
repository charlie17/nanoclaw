"""canvas_parse — read JT's work back off the canvas onto the manifest.

Every arm/refresh run parses before it projects.  What comes back:

  flags           triage flags per claim (replaces; an empty list clears)
  pruned          claim ids whose card is gone — never recreated
  title_overrides card titles JT rewrote, kept verbatim
  body_overrides  source-section body text JT edited, kept verbatim
  furniture_edits root/legend cards JT rewrote, kept verbatim
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


def _emoji_cluster(text, index):
    end = index + 1
    length = len(text)
    while end < length and (
        _is_continuation(text[end])
        or (ord(text[end - 1]) == _ZWJ and _is_emoji(text[end]))
    ):
        end += 1
    return text[index:end]


def scan_leading_flags(text):
    """Scan the leading run of *text* for triage flags.

    Returns (tokens, unknown, offsets).  ``offsets[k]`` is the index at which
    the text resumes after consuming k flag tokens, so a caller can try each
    possible flag prefix.  An unrecognised glyph ends the run and is NOT
    consumed — it stays in the remainder so that the ordinary title comparison
    sees it and JT's wording is preserved rather than quietly deleted.
    """
    tokens = []
    unknown = []
    offsets = [0]
    index = 0
    length = len(text)
    while index < length:
        char = text[index]
        if char in (" ", "\t") or _is_continuation(char):
            index += 1
            continue
        matched = None
        for token in FLAG_TOKENS:
            if text.startswith(token, index):
                matched = token
                break
        if matched is None:
            if _is_emoji(char):
                unknown.append(_emoji_cluster(text, index))
            break
        index += len(matched)
        while index < length and _is_continuation(text[index]):
            index += 1
        tokens.append(FLAG_CANON.get(matched, matched))
        skip = index
        while skip < length and text[skip] in (" ", "\t"):
            skip += 1
        offsets.append(skip)
    return tokens, unknown, offsets


def _dedupe(values):
    out = []
    for value in values:
        if value not in out:
            out.append(value)
    return out


def split_leading_flags(text):
    """(flags, unknown_emoji, remainder) — the context-free reading.

    Every leading flag token is taken as a flag.  Prefer ``resolve_flags``
    when the expected text is known: it will not invent a flag out of a title
    that genuinely begins with a flag glyph.
    """
    tokens, unknown, offsets = scan_leading_flags(text)
    return _dedupe(tokens), unknown, text[offsets[len(tokens)]:]


def resolve_flags(raw, expected):
    """Split *raw* into (flags, unknown, remainder) against a known *expected*.

    Flags are only read off the front when removing them makes the remainder
    match what we projected.  A title or body that legitimately starts with ⭐
    therefore yields no flags at all, which is what stops a fabricated flag
    from becoming a real tagged highlight at arm time.
    """
    tokens, unknown, offsets = scan_leading_flags(raw)
    if expected is None:
        return _dedupe(tokens), unknown, raw[offsets[len(tokens)]:].strip()
    target = expected.strip()
    for count in range(len(tokens), -1, -1):
        if raw[offsets[count]:].strip() == target:
            return _dedupe(tokens[:count]), unknown, target
    # The text itself changed, so no prefix can be confirmed.  Triage by
    # prepending flags is the documented action, so read the run as flags and
    # let the remainder be captured as JT's new wording.
    return _dedupe(tokens), unknown, raw[offsets[len(tokens)]:].strip()


# --------------------------------------------------------------------------
# card text decomposition
# --------------------------------------------------------------------------

def strip_emphasis(text):
    """Drop balanced leading/trailing asterisks.

    The cite line renders italic (``*↳ cite: ...*``).  Comparing with the
    markers removed means a canvas written before italics, or one where JT
    dropped the markers, still matches instead of raising a phantom edit.
    """
    stripped = (text or "").strip()
    lead = len(stripped) - len(stripped.lstrip("*"))
    trail = len(stripped) - len(stripped.rstrip("*"))
    count = min(lead, trail)
    if count and len(stripped) > 2 * count:
        stripped = stripped[count:len(stripped) - count].strip()
    return stripped


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


def _resolve_body(body, expected):
    """(flags, body) — read second-line flags only when they explain a diff.

    If the body already matches what we projected, nothing was prepended and
    there is nothing to strip.  Only when it differs do we test whether
    removing a leading flag run restores the expected text; if it does, JT
    prepended flags to otherwise-untouched prose.  If it does not, the body is
    his and is left exactly as written.
    """
    if expected is None:
        return [], body
    if _norm_block(body) == _norm_block(expected):
        return [], body

    lines = body.split("\n")
    position = None
    for index, line in enumerate(lines):
        if line.strip():
            position = index
            break
    if position is None:
        return [], body

    tokens, _unknown, offsets = scan_leading_flags(lines[position])
    for count in range(len(tokens), 0, -1):
        candidate = list(lines)
        candidate[position] = lines[position][offsets[count]:]
        joined = _trim_blank_edges("\n".join(candidate))
        if _norm_block(joined) == _norm_block(expected):
            return _dedupe(tokens[:count]), joined
    return [], body


def split_card(text, expected_title=None, expected_body=None):
    """Decompose a card's text into its parts.

    Returns a dict with: title (flags stripped), flags, unknown, body,
    cite, jt (the overlay block, verbatim), has_jt.

    Pass the expected title and body whenever they are known — without them a
    leading flag glyph that is genuinely part of the text is misread as triage.
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
    flags, unknown, title = resolve_flags(title_raw, expected_title)

    cite_index = None
    for position in range(len(lines) - 1, title_index, -1):
        if strip_emphasis(lines[position]).startswith(cb.CITE_PREFIX):
            cite_index = position
            break
    cite = lines[cite_index].strip() if cite_index is not None else ""
    body_lines = lines[title_index + 1:cite_index] if cite_index is not None \
        else lines[title_index + 1:]

    # Flags may also sit on the second non-empty line.  Only read them there
    # when removing them restores the body we projected — otherwise a body that
    # simply starts with ⭐ would fabricate a triage flag.
    body = _trim_blank_edges("\n".join(body_lines))
    more, body = _resolve_body(body, expected_body)
    for flag in more:
        if flag not in flags:
            flags.append(flag)

    return {
        "title": title.strip(),
        "flags": flags,
        "unknown": unknown,
        "body": body,
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
    furniture_edits = {}
    alien_nodes = []

    # The root and legend cards are JT-editable furniture: his wording wins and
    # is projected verbatim from then on.  The bin is regenerated from unmatched
    # state every refresh, so an edit there cannot be kept — it is quoted back
    # in full instead, so nothing he wrote is lost.
    furniture = cb.furniture_text(manifest)
    furniture_nodes = dict(
        (cb.node_id(slug, key), key) for key in furniture
    )

    for ident, node in by_node.items():
        claim = claim_node.get(ident)
        if claim is None:
            furniture_key = furniture_nodes.get(ident)
            if furniture_key is not None:
                text = node.get("text")
                if not isinstance(text, str):
                    warnings.append("%s card has no text; skipped" % furniture_key)
                    continue
                if _norm_block(text) == _norm_block(furniture[furniture_key]):
                    continue
                if furniture_key == "bin":
                    warnings.append(
                        "The unmatched-highlights card was edited on the canvas. That "
                        "card is rebuilt from scratch on every refresh, so the edit "
                        "cannot be kept. Here is exactly what it said, in full, so "
                        "nothing is lost:\n%s" % text
                    )
                else:
                    furniture_edits[furniture_key] = text
                continue
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

        expected_body = (claim.get("jt") or {}).get("body_override")
        if expected_body is None:
            expected_body = claim.get("body_md") or ""
        # A title JT rewrote is his material and is kept verbatim, exactly like
        # a rewritten body.
        expected_title = (claim.get("jt") or {}).get("title_override")
        if expected_title is None:
            expected_title = claim.get("title") or ""

        parts = split_card(text, expected_title, expected_body)
        flags[claim_id] = parts["flags"]
        for glyph in parts["unknown"]:
            # Once the glyph is part of the accepted title it is settled wording,
            # not a mis-typed flag, so say it once and then stop.
            if expected_title.strip().startswith(glyph):
                continue
            warnings.append(
                "%s: unrecognised marker %r in the title line; not read as a flag "
                "(kept as part of the title)" % (claim_id, glyph)
            )

        if _norm_block(parts["body"]) != _norm_block(expected_body):
            body_overrides[claim_id] = parts["body"]
        if parts["title"] != expected_title.strip():
            title_overrides[claim_id] = parts["title"]

        # The cite line is machine-owned — arming rewrites it — so a hand edit
        # there is surfaced rather than captured.
        expected_cite = strip_emphasis(cb.cite_line(claim))
        if expected_cite and strip_emphasis(parts["cite"]) != expected_cite:
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
        "furniture_edits": furniture_edits,
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
    edits = overlay.get("furniture_edits") or {}
    if edits:
        furniture = manifest.setdefault("jt_furniture", {})
        for key, text in edits.items():
            if cb.is_editable_furniture(key):
                furniture[key] = text
    return manifest
