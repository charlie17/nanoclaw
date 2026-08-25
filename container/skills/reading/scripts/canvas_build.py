"""canvas_build — project a manifest onto a JSON Canvas 1.0 file.

The projection is a pure function of the manifest: same manifest in, same
bytes out.  Node ids are deterministic hashes of stable keys, so a rebuild
touches only known nodes and never orphans JT's work.

Geometry the user changed is preserved by passing the canvas he has been
working in as ``existing`` — any node id found there keeps its x/y/width/
height.  Pruned claims are never projected (doctrine: a node he deleted is
never recreated).

python3 stdlib only.
"""

import hashlib
import json
import math
import os

import manifest as manifest_mod

# --------------------------------------------------------------------------
# layout constants
# --------------------------------------------------------------------------

CARD_W = 340
COL_GAP = 120
COL_PITCH = CARD_W + COL_GAP        # 460
SIB_GAP = 60
GROUP_PAD = 40
GROUP_GAP = 120

SIDE_X = 0                          # overview group / legend / bin column, far left
SIDE_GAP = 60
GROUP_GAP_X = 240                   # overview group -> first chapter group column

OVERVIEW_IDX = manifest_mod.OVERVIEW_IDX
OVERVIEW_LABEL = "Overview"
ROOT_SLOT = "\x00root"              # the root card's slot in the overview tree

BASE_H = 140
LINE_H = 22
CHARS_PER_LINE = 42
H_MIN = 220
H_MAX = 680
H_ROUND = 10

UNASSIGNED = "unassigned"

# JSON Canvas preset colors: 1 red, 2 orange, 3 yellow, 4 green, 5 cyan, 6 purple.
COLOR_ROOT = "5"
COLOR_LEGEND = "5"
COLOR_BIN = "2"
STANCE_COLOR = {"agree": "4", "dispute": "1", "surface": "6"}
STANCE_GLYPH = {
    "agree": ("✅", "Agree"),
    "dispute": ("❌", "Dispute"),
    "surface": ("\U0001f4a1", "Surface"),
}
STANCE_ALIASES = {
    "✅": "agree", "agree": "agree", "Agree": "agree",
    "❌": "dispute", "dispute": "dispute", "Dispute": "dispute",
    "\U0001f4a1": "surface", "surface": "surface", "Surface": "surface",
}

CITE_PREFIX = "↳ cite:"
JT_SEP = "\n\n---\n— JT —\n"

LEGEND_TEXT = "\n".join([
    "# Legend",
    "",
    "**Triage flags** — prepend to a card title:",
    "⭐ key · \U0001f525 dig in · ⏭️ skip · ❓ clarify",
    "",
    "**Stance** — write it in the highlight note while reading:",
    "✅ agree · ❌ dispute · \U0001f4a1 surface",
    "",
    "**Card colors**",
    "green = agree · red = dispute · purple = surface",
    "cyan = root and legend · orange = unmatched highlights",
    "Source cards stay uncolored.",
    "",
    "**Map structure** — the Overview group holds the root card and the",
    "book-level summary; each chapter gets its own group. An unlabelled arrow",
    "means a claim supports its parent; anything else (objection, reply,",
    "qualifies, contrasts, example, consequence) is written on the arrow.",
    "",
    "**Your edits are safe.** Move, edit, or delete any card — a deleted card is",
    "recorded as pruned and never recreated, and edited text is kept verbatim.",
    "Source content and your overlay never mix: your material lands under the",
    "— JT — rule at the bottom of a card.",
])


# --------------------------------------------------------------------------
# ids
# --------------------------------------------------------------------------

def node_id(slug, key):
    """Deterministic 16-hex-char node id for a stable key."""
    raw = "dsr:%s:%s" % (slug, key)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def claim_node_id(slug, claim_id):
    return node_id(slug, claim_id)


def group_key(chapter_idx):
    return "group:%s" % chapter_idx


def edge_key(child_claim_id):
    return "edge:%s" % child_claim_id


def group_edge_key(chapter_idx):
    return "edge:group:%s" % chapter_idx


def known_ids(manifest):
    """Every node and edge id this manifest could own, pruned claims included.

    Anything on the canvas outside this set is JT's own work — an alien card or
    an edge he drew — and is carried through untouched rather than deleted.
    """
    slug = manifest["slug"]
    keys = ["root", "legend", "bin", group_key(OVERVIEW_IDX)]
    for chapter in manifest.get("chapters", []):
        idx = chapter.get("idx", 0)
        keys.append(group_key(idx))
        keys.append(group_edge_key(idx))
    keys.append(group_key(UNASSIGNED))
    keys.append(group_edge_key(UNASSIGNED))
    for claim in manifest.get("claims", []):
        keys.append(claim["id"])
        keys.append(edge_key(claim["id"]))
    return dict((node_id(slug, key), key) for key in keys)


# --------------------------------------------------------------------------
# text projection
# --------------------------------------------------------------------------

def normalize_stance(value):
    if value is None:
        return None
    return STANCE_ALIASES.get(str(value).strip(), None)


def flag_prefix(claim):
    flags = (claim.get("jt") or {}).get("flags") or []
    joined = "".join(str(f) for f in flags if str(f).strip())
    return joined + " " if joined else ""


def cite_line(claim):
    """The ``↳ cite:`` line, or '' when there is nothing to cite."""
    locator = claim.get("locator") or ""
    phrase = claim.get("anchor_phrase") or ""
    url = (claim.get("cite") or {}).get("url")
    if not (locator or phrase or url):
        return ""
    parts = [CITE_PREFIX]
    if locator:
        parts.append(" " + locator)
    if phrase:
        parts.append(" — “%s”" % phrase)
    if url:
        parts.append(" [link](%s)" % url)
    return "".join(parts)


def title_text(claim):
    """The card's title — JT's rewrite wins over ours wherever he made one."""
    override = (claim.get("jt") or {}).get("title_override")
    if override is not None:
        return override
    return claim.get("title") or ""


def body_text(claim):
    override = (claim.get("jt") or {}).get("body_override")
    if override is not None:
        return override
    return claim.get("body_md") or ""


def source_section(claim, include_flags=True):
    """Title + body + cite — the part of a card that is source content."""
    prefix = flag_prefix(claim) if include_flags else ""
    lines = ["# " + prefix + title_text(claim)]
    body = body_text(claim)
    if body.strip():
        lines.append("")
        lines.append(body)
    cite = cite_line(claim)
    if cite:
        lines.append("")
        lines.append(cite)
    return "\n".join(lines)


def jt_section(claim):
    """The fenced ``— JT —`` overlay block, or '' when there is no overlay."""
    jt = claim.get("jt") or {}
    stance = normalize_stance(jt.get("stance"))
    notes = [str(n).strip() for n in (jt.get("notes") or []) if str(n).strip()]
    highlights = jt.get("highlights") or []
    if not (stance or notes or highlights):
        return ""
    lines = []
    if stance:
        glyph, word = STANCE_GLYPH[stance]
        lines.append("%s %s" % (glyph, word))
    for note in notes:
        lines.append("- " + note)
    for highlight in highlights:
        text = (highlight.get("text") or "").strip()
        note = (highlight.get("note") or "").strip()
        if not text and not note:
            continue
        bullet = "- “%s”" % text if text else "-"
        if note:
            bullet += " — " + note
        lines.append(bullet)
    if not lines:
        return ""
    return JT_SEP + "\n".join(lines)


def card_text(claim):
    return source_section(claim) + jt_section(claim)


def _plain(text):
    """Strip the markdown furniture so sizing measures readable characters."""
    out = []
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped.startswith("# "):
            stripped = stripped[2:]
        elif stripped.startswith("- "):
            stripped = stripped[2:]
        elif stripped == "---":
            stripped = ""
        out.append(stripped)
    return "\n".join(out)


def card_height(text):
    """Deterministic portrait-card height for a projected card text."""
    chars = len(_plain(text))
    height = BASE_H + LINE_H * int(math.ceil(chars / float(CHARS_PER_LINE)))
    height = max(H_MIN, min(H_MAX, height))
    return ((height + H_ROUND // 2) // H_ROUND) * H_ROUND


def card_color(claim):
    stance = normalize_stance((claim.get("jt") or {}).get("stance"))
    return STANCE_COLOR.get(stance)


# --------------------------------------------------------------------------
# fixed cards
# --------------------------------------------------------------------------

EDITABLE_FURNITURE = manifest_mod.EDITABLE_FURNITURE


def furniture_override(manifest, key):
    """JT's own wording for a furniture card, if he has rewritten it."""
    if key not in EDITABLE_FURNITURE:
        return None
    value = (manifest.get("jt_furniture") or {}).get(key)
    return value if isinstance(value, str) else None


def legend_text(manifest):
    override = furniture_override(manifest, "legend")
    return LEGEND_TEXT if override is None else override


def root_text(manifest, live_count, chapter_count):
    override = furniture_override(manifest, "root")
    if override is not None:
        return override
    source = manifest.get("source") or {}
    title = source.get("title") or manifest.get("slug") or "Reading map"
    lines = ["# " + title]
    meta = []
    if source.get("author"):
        meta.append(str(source["author"]))
    if source.get("category"):
        meta.append(str(source["category"]))
    if source.get("word_count"):
        meta.append("{:,} words".format(int(source["word_count"])))
    if meta:
        lines.append("")
        lines.append(" · ".join(meta))
    root_md = manifest.get("root_md")
    if root_md:
        lines.append("")
        lines.append(root_md)
    lines.append("")
    lines.append("%d cards across %d chapters." % (live_count, chapter_count))
    lines.append("A map of the argument — not a substitute for the source.")
    return "\n".join(lines)


def bin_text(manifest):
    unmatched = manifest.get("unmatched") or []
    lines = ["# Unmatched highlights", ""]
    lines.append(
        "Highlights that matched no card. **This card is rebuilt from scratch on "
        "every refresh — don't write here, anything you type will be replaced.** "
        "To keep something, copy it onto a claim card."
    )
    lines.append("")
    for item in unmatched:
        text = (item.get("text") or "").strip()
        note = (item.get("note") or "").strip()
        url = item.get("url") or ""
        bullet = "- “%s”" % text if text else "-"
        if note:
            bullet += " — " + note
        if url:
            bullet += " [link](%s)" % url
        lines.append(bullet)
    return "\n".join(lines)


# --------------------------------------------------------------------------
# tree layout
# --------------------------------------------------------------------------

def _chapter_buckets(manifest, claims):
    """(ordered bucket keys, label per key, claims per key).

    *claims* must already exclude overview claims — they get their own group.
    """
    chapters = sorted(
        [c for c in manifest.get("chapters", []) if c.get("idx") != OVERVIEW_IDX],
        key=lambda c: (c.get("idx", 0), c.get("title") or ""),
    )
    known = {}
    order = []
    for chapter in chapters:
        idx = chapter.get("idx", 0)
        known[idx] = chapter.get("title") or ("Chapter %s" % idx)
        order.append(idx)

    buckets = {}
    for claim in claims:
        idx = claim.get("chapter_idx", 0)
        if idx not in known:
            idx = UNASSIGNED
        buckets.setdefault(idx, []).append(claim)

    keys = [k for k in order if k in buckets]
    labels = dict(known)
    if UNASSIGNED in buckets:
        keys.append(UNASSIGNED)
        labels[UNASSIGNED] = "Unassigned"
    return keys, labels, buckets


def _forest(bucket_claims, live_ids, bucket_ids):
    """Local roots + children map for one chapter.

    A claim is a local root when its parent is "root", is pruned, or lives in
    another chapter (the cross-chapter edge is still drawn, but the layout
    stays inside the group).
    """
    children = {}
    roots = []
    for claim in bucket_claims:
        parent = claim.get("parent")
        if parent != "root" and parent in live_ids and parent in bucket_ids:
            children.setdefault(parent, []).append(claim)
        else:
            roots.append(claim)

    sort_key = lambda c: (c.get("order", 0), c.get("id"))
    roots.sort(key=sort_key)
    for kids in children.values():
        kids.sort(key=sort_key)
    return roots, children


def _spans(roots, children, heights):
    """Vertical band each subtree owns.  Bands of siblings never intersect."""
    spans = {}

    def measure(claim):
        claim_id = claim["id"]
        if claim_id in spans:
            return spans[claim_id]
        kids = children.get(claim_id, [])
        own = heights[claim_id]
        if kids:
            total = sum(measure(k) for k in kids) + SIB_GAP * (len(kids) - 1)
            value = max(own, total)
        else:
            value = own
        spans[claim_id] = value
        return value

    for root in roots:
        measure(root)
    return spans


def _layout_bucket(roots, children, heights, spans):
    """Place one chapter's forest in local coordinates starting at (0, 0)."""
    positions = {}
    order = []

    def place(claim, depth, top):
        claim_id = claim["id"]
        span = spans[claim_id]
        own = heights[claim_id]
        positions[claim_id] = (depth * COL_PITCH, top + (span - own) // 2)
        order.append(claim_id)
        kids = children.get(claim_id, [])
        if kids:
            kids_span = sum(spans[k["id"]] for k in kids) + SIB_GAP * (len(kids) - 1)
            cursor = top + (span - kids_span) // 2
            for kid in kids:
                place(kid, depth + 1, cursor)
                cursor += spans[kid["id"]] + SIB_GAP

    cursor = 0
    for root in roots:
        place(root, 0, cursor)
        cursor += spans[root["id"]] + SIB_GAP
    content_h = max(0, cursor - SIB_GAP)
    content_w = 0
    for claim_id, (x, _y) in positions.items():
        content_w = max(content_w, x + CARD_W)
    return positions, order, content_w, content_h


# --------------------------------------------------------------------------
# build
# --------------------------------------------------------------------------

def _text_node(node_ident, text, x, y, width, height, color=None):
    node = {
        "id": node_ident,
        "type": "text",
        "text": text,
        "x": int(x),
        "y": int(y),
        "width": int(width),
        "height": int(height),
    }
    if color:
        node["color"] = color
    return node


def _group_node(node_ident, label, x, y, width, height):
    return {
        "id": node_ident,
        "type": "group",
        "label": label,
        "x": int(x),
        "y": int(y),
        "width": int(width),
        "height": int(height),
    }


def _edge(edge_ident, from_node, to_node, label=None):
    edge = {
        "id": edge_ident,
        "fromNode": from_node,
        "fromSide": "right",
        "toNode": to_node,
        "toSide": "left",
        "toEnd": "arrow",
    }
    if label:
        edge["label"] = label
    return edge


def _rel_label(claim):
    """The edge label for a claim's relationship to its parent.

    "supports" is the ordinary case and stays unlabelled — the structure
    already says it.  Anything else is worth a word on the edge.  Colour is
    never used here: it is reserved for the JT overlay channel.
    """
    rel = manifest_mod.claim_rel(claim)
    return None if rel == manifest_mod.REL_DEFAULT else rel


def _overview_layout(overview_claims, live_ids, heights, root_height):
    """Lay out the root card with the overview claims hanging off it.

    The root card occupies the depth-0 slot, so root -> overview claim reads as
    an ordinary left-to-right parent/child edge inside the Overview group.
    """
    bucket_ids = set(c["id"] for c in overview_claims)
    children = {}
    top_level = []
    for claim in overview_claims:
        parent = claim.get("parent")
        if parent != "root" and parent in live_ids and parent in bucket_ids:
            children.setdefault(parent, []).append(claim)
        else:
            top_level.append(claim)

    sort_key = lambda c: (c.get("order", 0), c.get("id"))
    top_level.sort(key=sort_key)
    for kids in children.values():
        kids.sort(key=sort_key)

    slot = {"id": ROOT_SLOT}
    children[ROOT_SLOT] = top_level
    sizes = dict(heights)
    sizes[ROOT_SLOT] = root_height
    spans = _spans([slot], children, sizes)
    positions, order, content_w, content_h = _layout_bucket(
        [slot], children, sizes, spans
    )
    return positions, [c for c in order if c != ROOT_SLOT], content_w, content_h, top_level


def build_canvas(manifest, existing=None):
    """Project *manifest* onto a JSON Canvas 1.0 dict.

    ``existing`` — a previously written canvas dict.  Any node id present
    there keeps its x/y/width/height, so cards JT moved or resized stay put.
    """
    slug = manifest["slug"]
    claims = manifest_mod.live_claims(manifest)
    live_ids = set(c["id"] for c in claims)

    overview_claims = [c for c in claims if manifest_mod.is_overview(c)]
    chapter_claims = [c for c in claims if not manifest_mod.is_overview(c)]

    heights = {}
    texts = {}
    for claim in claims:
        text = card_text(claim)
        texts[claim["id"]] = text
        heights[claim["id"]] = card_height(text)

    keys, labels, buckets = _chapter_buckets(manifest, chapter_claims)

    # The root card sits inside the Overview group, so it has to be sized and
    # laid out before the chapter column can know where it starts.
    r_text = root_text(manifest, len(claims), len(keys))
    r_h = card_height(r_text)
    o_positions, o_order, o_content_w, o_content_h, o_top_level = _overview_layout(
        overview_claims, live_ids, heights, r_h
    )
    overview_w = o_content_w + 2 * GROUP_PAD
    overview_h = o_content_h + 2 * GROUP_PAD
    chapter_x = SIDE_X + overview_w + GROUP_GAP_X

    # Chapter groups sit on a horizontal shelf: top-aligned at y = 0, advancing
    # left to right in chapter order.  Stacking them vertically instead makes a
    # book-scale map absurdly tall — 987 claims over 15 chapters measured 1:112,
    # unreadable at fit-to-view — whereas a shelf keeps the aspect workable and
    # matches the left-to-right reading direction the tree already uses.
    groups = []
    placed = {}          # claim id -> (x, y)
    chapter_order = []
    cursor_x = chapter_x
    tallest = 0
    for key in keys:
        bucket_claims = buckets[key]
        bucket_ids = set(c["id"] for c in bucket_claims)
        roots, children = _forest(bucket_claims, live_ids, bucket_ids)
        spans = _spans(roots, children, heights)
        positions, order, content_w, content_h = _layout_bucket(
            roots, children, heights, spans
        )
        group_w = content_w + 2 * GROUP_PAD
        group_h = content_h + 2 * GROUP_PAD
        offset_x = cursor_x + GROUP_PAD
        offset_y = GROUP_PAD
        for claim_id, (x, y) in positions.items():
            placed[claim_id] = (x + offset_x, y + offset_y)
        chapter_order.extend(order)
        groups.append({
            "key": key,
            "label": labels.get(key, str(key)),
            "x": cursor_x,
            "y": 0,
            "width": group_w,
            "height": group_h,
        })
        cursor_x += group_w + GROUP_GAP
        tallest = max(tallest, group_h)

    map_height = tallest

    # --- far-left column: Overview group, then legend, then bin -----------
    overview_y = (map_height - overview_h) // 2
    o_offset_x = SIDE_X + GROUP_PAD
    o_offset_y = overview_y + GROUP_PAD
    for claim_id, (x, y) in o_positions.items():
        if claim_id == ROOT_SLOT:
            continue
        placed[claim_id] = (x + o_offset_x, y + o_offset_y)
    root_x, root_y = o_positions[ROOT_SLOT]
    root_x += o_offset_x
    root_y += o_offset_y

    legend = legend_text(manifest)
    l_h = card_height(legend)
    l_y = overview_y + overview_h + SIDE_GAP

    card_order = list(o_order) + chapter_order

    nodes = []
    nodes.append(_group_node(
        node_id(slug, group_key(OVERVIEW_IDX)), OVERVIEW_LABEL,
        SIDE_X, overview_y, overview_w, overview_h,
    ))
    for group in groups:
        nodes.append(_group_node(
            node_id(slug, group_key(group["key"])),
            group["label"], group["x"], group["y"], group["width"], group["height"],
        ))

    root_ident = node_id(slug, "root")
    nodes.append(_text_node(root_ident, r_text, root_x, root_y, CARD_W, r_h, COLOR_ROOT))
    nodes.append(_text_node(
        node_id(slug, "legend"), legend, SIDE_X, l_y, CARD_W, l_h, COLOR_LEGEND
    ))
    if manifest.get("unmatched"):
        b_text = bin_text(manifest)
        b_h = card_height(b_text)
        b_y = l_y + l_h + SIDE_GAP
        nodes.append(_text_node(
            node_id(slug, "bin"), b_text, SIDE_X, b_y, CARD_W, b_h, COLOR_BIN
        ))

    by_id = manifest_mod.claims_by_id(manifest)
    for claim_id in card_order:
        claim = by_id[claim_id]
        x, y = placed[claim_id]
        nodes.append(_text_node(
            claim_node_id(slug, claim_id), texts[claim_id],
            x, y, CARD_W, heights[claim_id], card_color(claim),
        ))

    # --- edges ------------------------------------------------------------
    edges = []
    for group in groups:
        edges.append(_edge(
            node_id(slug, group_edge_key(group["key"])),
            root_ident,
            node_id(slug, group_key(group["key"])),
        ))
    top_level_overview = set(c["id"] for c in o_top_level)
    for claim_id in card_order:
        claim = by_id[claim_id]
        parent = claim.get("parent")
        if claim_id in top_level_overview:
            # an overview claim hangs directly off the root card
            from_node = root_ident
        elif parent == "root" or parent not in live_ids:
            # a chapter claim's top level hangs off its group, which root feeds
            continue
        else:
            from_node = claim_node_id(slug, parent)
        edges.append(_edge(
            node_id(slug, edge_key(claim_id)),
            from_node,
            claim_node_id(slug, claim_id),
            _rel_label(claim),
        ))

    canvas = {"nodes": nodes, "edges": edges}

    if existing:
        _carry_forward(manifest, canvas, existing)

    return canvas


def furniture_text(manifest):
    """The three furniture cards as they would be projected right now.

    Cheaper than a full build, and it already reflects any wording of JT's that
    has been folded in, so comparing a canvas against it is idempotent.
    """
    claims = manifest_mod.live_claims(manifest)
    chapter_claims = [c for c in claims if not manifest_mod.is_overview(c)]
    keys, _labels, _buckets = _chapter_buckets(manifest, chapter_claims)
    return {
        "root": root_text(manifest, len(claims), len(keys)),
        "legend": legend_text(manifest),
        "bin": bin_text(manifest),
    }


def jt_geometry_ids(manifest, existing):
    """Node ids on *existing* whose geometry is JT's rather than the projection's.

    Pass the result to ``validate.validate_canvas`` as ``jt_geometry_ids``: once
    he drags a card over another, that overlap is his choice, and a strict gate
    should not fail on it forever.
    """
    if not existing:
        return set()
    snapshot = manifest.get("node_geometry")
    ours = known_ids(manifest)
    touched = set()
    for node in existing.get("nodes") or []:
        ident = node.get("id")
        if ident is None:
            continue
        if ident not in ours:
            touched.add(ident)      # a card he added himself
            continue
        geometry = _node_geometry(node)
        if not geometry:
            continue
        if snapshot is None:
            touched.add(ident)
            continue
        previous = snapshot.get(ident)
        if previous is None:
            continue
        if len(previous) != 4:
            touched.add(ident)
            continue
        if (geometry.get("x") != previous[0] or geometry.get("y") != previous[1]
                or geometry.get("width") != previous[2]
                or geometry.get("height") != previous[3]):
            touched.add(ident)
    return touched


def _node_geometry(node):
    geometry = {}
    for field in ("x", "y", "width", "height"):
        value = node.get(field)
        if isinstance(value, int) and not isinstance(value, bool):
            geometry[field] = value
    return geometry


def snapshot_geometry(canvas):
    """The geometry of every node in *canvas*, as written."""
    snapshot = {}
    for node in canvas.get("nodes") or []:
        ident = node.get("id")
        if ident is None:
            continue
        geometry = _node_geometry(node)
        if len(geometry) == 4:
            snapshot[ident] = [
                geometry["x"], geometry["y"], geometry["width"], geometry["height"]
            ]
    return snapshot


def _carry_forward(manifest, canvas, existing):
    """Keep what JT changed; let everything else reflow.

    The snapshot recorded by the last ``write_canvas`` is what makes this
    possible: a node whose geometry still matches the snapshot has not been
    touched since we wrote it, so it takes the fresh projection and its height
    grows to fit newly folded-in overlay text.  A node that differs was moved
    or resized by JT, and his geometry wins.  Position and size are judged
    separately, so a card he dragged still grows when its text grows.

    With no snapshot on the manifest — an older file, or a canvas we have
    never written — every known node keeps its existing geometry, which is the
    conservative behaviour that predates snapshots.
    """
    snapshot = manifest.get("node_geometry")
    keep = {}
    for node in existing.get("nodes") or []:
        ident = node.get("id")
        if ident is None:
            continue
        geometry = _node_geometry(node)
        if geometry:
            keep[ident] = geometry

    for node in canvas["nodes"]:
        geometry = keep.get(node["id"])
        if not geometry:
            continue
        if snapshot is None:
            node.update(geometry)
            continue
        previous = snapshot.get(node["id"])
        if previous is None:
            # not in the last write: a new card, so let the projection place it
            continue
        if len(previous) != 4:
            node.update(geometry)
            continue
        if geometry.get("x") != previous[0] or geometry.get("y") != previous[1]:
            for field in ("x", "y"):
                if field in geometry:
                    node[field] = geometry[field]
        if geometry.get("width") != previous[2] or geometry.get("height") != previous[3]:
            for field in ("width", "height"):
                if field in geometry:
                    node[field] = geometry[field]

    ours = known_ids(manifest)
    for node in existing.get("nodes") or []:
        ident = node.get("id")
        if ident is not None and ident not in ours:
            canvas["nodes"].append(node)
    node_ids = set(n.get("id") for n in canvas["nodes"])
    for edge in existing.get("edges") or []:
        ident = edge.get("id")
        if ident is None or ident in ours:
            continue
        if edge.get("fromNode") in node_ids and edge.get("toNode") in node_ids:
            canvas["edges"].append(edge)


def dumps_canvas(canvas):
    """The exact bytes-as-text form written to disk."""
    return json.dumps(canvas, ensure_ascii=False, indent=1) + "\n"


def canvas_path(manifest, vault_dir):
    filename = manifest.get("canvas_file") or (manifest["slug"] + ".canvas")
    return os.path.join(vault_dir, filename)


def write_canvas(manifest, canvas, vault_dir):
    """Atomically write the canvas, recording its hash and geometry.

    The geometry snapshot is what a later refresh compares against to tell a
    card JT moved from one that is merely waiting to be reflowed.
    """
    path = canvas_path(manifest, vault_dir)
    digest = manifest_mod.atomic_write_text(path, dumps_canvas(canvas))
    manifest["canvas_last_written_sha256"] = digest
    manifest["node_geometry"] = snapshot_geometry(canvas)
    return path


def read_canvas(path):
    """Load a canvas dict from disk, or None when it does not exist."""
    if not os.path.isfile(path):
        return None
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)
