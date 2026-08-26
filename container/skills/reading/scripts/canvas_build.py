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
import re

import manifest as manifest_mod

# --------------------------------------------------------------------------
# layout constants
# --------------------------------------------------------------------------

CARD_W = 480
COL_GAP = 120
COL_PITCH = CARD_W + COL_GAP        # 600
SIB_GAP = 60
CHAPTER_GAP = 480                   # whitespace between chapters (no group boxes)
CLUSTER_GAP = 240                   # overview cluster -> first chapter

# Filmstrip: the map is consumed as a horizontal pan, so a chapter may never
# grow taller than this.  A wing that would stack past it spills sideways into
# further columns instead — width is cheap, vertical scrolling is not.
#
# 3400 is chosen against the nominal card: five 620-high cards plus four 60
# gaps come to 3340 and fit, a sixth would reach 4020 and spill.  This is the
# width lever — column capacity is the cap divided by card pitch, so the cap
# (not the safety margin) is what decides how wide the ribbon runs.
CHAPTER_HEIGHT_CAP = 3400

# A soft tolerance of roughly one card on top of the cap.  It is spent ONLY
# where it prevents a split — keeping a parent's children in a single adjacent
# run instead of spilling them into a second column.  Ordinary packing always
# uses the cap: starting a new band further out costs nothing in traceability,
# so the tolerance is never spent on that.
CHAPTER_HEIGHT_TOLERANCE = 700
CHAPTER_HEIGHT_LIMIT = CHAPTER_HEIGHT_CAP + CHAPTER_HEIGHT_TOLERANCE

# Band packing.  True: a section subtree may join ANY open band in its wing
# that still has room, preferring one already wide enough to hold it — a narrow
# leaf section slotted into an existing wide band costs no extra columns.
# False: strictly sequential bands, which is exactly the v5 behaviour.
# Contiguity and adjacency are untouched either way; only which band a whole
# subtree lands in changes.
BAND_FILL_COMPACT = True

SIDE_X = 0                          # overview cluster / legend / bin column, far left
SIDE_GAP = 60

OVERVIEW_IDX = manifest_mod.OVERVIEW_IDX
OVERVIEW_LABEL = "Overview"
ROOT_SLOT = "\x00root"              # the root card's slot in the overview tree
HUB_SLOT = "\x00hub"                # the hub card's slot in a chapter's tree

RIGHT = 1
LEFT = -1

# --- no-scroll sizing -----------------------------------------------------
# A card must never need scrolling: the map is read at a glance, and a clipped
# card is a silently lost claim.  Every constant here is deliberately
# pessimistic — an over-tall card costs whitespace, a short one costs meaning.
CHARS_PER_LINE = 48                 # at width 480, body text
TITLE_CHARS_PER_LINE = 36           # headings render larger, so they wrap sooner
TITLE_LINE_WEIGHT = 2               # ...and each heading line is ~2 body lines tall
BASE_H = 48                         # padding and chrome
LINE_H = 24
# Calibrated against a screenshot of the real Obsidian render: 1.25 left 25-30%
# dead space at card bottoms.  1.05 still clears the text with the nominal
# height doing most of the work.
SAFETY_MARGIN = 1.05
H_MIN = 620                         # nominal card, roughly 8.5x11 portrait
# H_MAX is a REFERENCE height, not a clamp: ordinary content never reaches it
# (a legacy 1400-char body sits well under).  It used to cap card_height, which
# made the builder emit a card shorter than its own no-scroll estimate as soon
# as a body or the unmatched bin grew past it — the validator then failed every
# subsequent write and the map froze.  Sizing must always satisfy the gate, so
# tall content now gets a tall card.
H_MAX = 2400
H_ROUND = 10

UNASSIGNED = "unassigned"

# Heatmap Sections: a compact table of contents on the far left, one title-only
# card per chapter.  JT colours these by hand to heat-map his reading, so any
# colour found on one is his and is carried forward untouched.
TOC_CARD_W = 300
TOC_TITLE_CPL = 22                  # narrower card wraps titles sooner
TOC_H_MIN = 80
TOC_PAD = 40
TOC_GAP = 20
# Entries flow top-to-bottom then wrap into a new column, so the block reads
# landscape: at a book's usual 12-18 chapters this gives three or four columns.
TOC_ROWS = 5
TOC_COLOR = "5"                     # the tinted group in JT's mockup

# A markdown link renders as its label, so measure the label, not the URL —
# otherwise an armed card with a long cite URL balloons to nonsense.
_MD_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")

# JSON Canvas preset colors: 1 red, 2 orange, 3 yellow, 4 green, 5 cyan, 6 purple.
# Preset "5" (teal) is the machine creation-time colour: everything the builder
# authors as furniture wears it, so JT can tell furniture from claim at a
# glance.  Yellow ("3") is deliberately left unused, reserved as a highlighter.
COLOR_FURNITURE = "5"
COLOR_ROOT = COLOR_FURNITURE
COLOR_LEGEND = COLOR_FURNITURE
COLOR_HUB = COLOR_FURNITURE
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
CITE_WRAP = "*"                     # the cite line renders italic
JT_SEP = "\n\n---\n— JT —\n"

# The legend is the map's instruction card: it reads as the workflow JT
# actually runs (triage -> arm -> read -> refresh), not as a colour key.  Each
# paragraph is ONE logical line — Obsidian turns a bare newline into a hard
# break, so source-side wrapping would show up in the render.  Implicit string
# concatenation keeps the source readable without injecting breaks.
LEGEND_TEXT = "\n".join([
    "# Legend",
    "",
    "**What you're looking at:** chapters flow left→right as teal hubs with "
    "their claim cards beside them; up here sit the Heatmap Sections (color "
    "those tiles freely — yellow is yours, the builder never uses it), this "
    "legend, and the root overview. A card's *↳ cite* line jumps to the exact "
    "passage once armed.",
    "",
    "**1 · Before reading — triage.** Skim the map; prepend flags to card "
    "titles: ⭐ key · \U0001f525 dig in · ⏭️ skip · ❓ clarify. Move, edit, or "
    "delete anything — your edits are permanent and a deleted claim card never "
    "comes back (teal furniture regrows). Your material always lands under a "
    "card's — JT — rule; source text stays above it.",
    "",
    "**2 · Arm — say \"arm the map.\"** Do this once triage is done, "
    "before you start reading. Every ⭐/\U0001f525/❓ card gets a live cite link "
    "into Reader; ⏭️ and unflagged cards create nothing.",
    "",
    "**3 · While reading — in Reader.** Highlight normally. Start a "
    "highlight's note with ✅ / ❌ / \U0001f4a1 (or agree / dispute / surface) "
    "to attach a stance; a bare highlight is just an attention flag.",
    "",
    "**4 · Refresh — say \"refresh the map.\"** After any reading "
    "session, as often as you like. Highlights land on their cards with live "
    "links; stance recolors: ✅ green · ❌ red · \U0001f4a1 purple; anything "
    "unmatched goes to the orange bin, never dropped.",
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


def hub_key(chapter_idx):
    return "hub:%s" % chapter_idx


def hub_edge_key(chapter_idx):
    return "edge:hub:%s" % chapter_idx


def toc_key(chapter_idx):
    return "toc:%s" % chapter_idx


TOC_GROUP_KEY = "group:toc"
TOC_LABEL = "Heatmap Sections"


def known_ids(manifest):
    """Every node and edge id this manifest could own, pruned claims included.

    Anything on the canvas outside this set is JT's own work — an alien card or
    an edge he drew — and is carried through untouched rather than deleted.
    """
    slug = manifest["slug"]
    # group_* keys are no longer emitted — v2 uses hub cards — but they stay in
    # the known set so that groups left over in an older canvas are recognised
    # as ours rather than mistaken for cards JT added by hand.
    keys = ["root", "legend", "bin", group_key(OVERVIEW_IDX), TOC_GROUP_KEY]
    for chapter in manifest.get("chapters", []):
        idx = chapter.get("idx", 0)
        keys.append(group_key(idx))
        keys.append(group_edge_key(idx))
        keys.append(hub_key(idx))
        keys.append(hub_edge_key(idx))
        keys.append(toc_key(idx))
    keys.append(toc_key(UNASSIGNED))
    for idx in (UNASSIGNED, OVERVIEW_IDX):
        keys.append(group_key(idx))
        keys.append(group_edge_key(idx))
        keys.append(hub_key(idx))
        keys.append(hub_edge_key(idx))
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
    """The ``↳ cite:`` line, or '' when there is nothing to cite.

    The whole line renders italic, quote included, so provenance reads as an
    aside rather than as part of the claim.
    """
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
    return CITE_WRAP + "".join(parts) + CITE_WRAP


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


def post_cite_text(claim):
    """Anything JT wrote below the cite line, or '' when he wrote nothing.

    The region under the citation is his: a paragraph appended there used to be
    parsed away and dropped on the next rebuild, so it is now kept verbatim and
    re-rendered in the same place.
    """
    value = (claim.get("jt") or {}).get("post_cite")
    return value if isinstance(value, str) else ""


def source_section(claim, include_flags=True):
    """Title + body + cite — the part of a card that is source content.

    Plus, at the bottom, whatever JT appended below the cite line: it renders
    where he put it, under the citation and above the — JT — rule.
    """
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
    tail = post_cite_text(claim)
    if tail.strip():
        lines.append("")
        lines.append(tail)
    return "\n".join(lines)


def jt_section(claim):
    """The fenced ``— JT —`` overlay block, or '' when there is no overlay.

    Normally projected from the manifest's stance, notes and highlights.  Once
    JT has rewritten the block on the canvas his wording is authoritative and
    is rendered verbatim instead — including an empty override, which means he
    deleted the block and it is not recreated.
    """
    jt = claim.get("jt") or {}
    override = jt.get("jt_section_override")
    if isinstance(override, str):
        body = override.strip("\n")
        return JT_SEP + body if body.strip() else ""
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


def estimate_lines(text):
    """Rendered line count for a card, counted pessimistically.

    Each paragraph wraps at CHARS_PER_LINE; a blank line still occupies one;
    a heading wraps sooner and each of its lines is worth two body lines.
    """
    total = 0
    for raw in (text or "").split("\n"):
        line = _MD_LINK.sub(r"\1", raw.strip())
        if not line:
            total += 1
            continue
        if line.startswith("# "):
            heading = line[2:].strip()
            wrapped = max(1, int(math.ceil(len(heading) / float(TITLE_CHARS_PER_LINE))))
            total += TITLE_LINE_WEIGHT * wrapped
            continue
        if line.startswith("- "):
            line = line[2:]
        total += max(1, int(math.ceil(len(line) / float(CHARS_PER_LINE))))
    return total


def estimate_height(text):
    """Height a card needs so that nothing has to be scrolled, before clamping."""
    raw = BASE_H + LINE_H * estimate_lines(text)
    return int(math.ceil(raw * SAFETY_MARGIN))


def card_height(text):
    """Deterministic portrait-card height for a projected card text.

    Rounds UP to the grid so the result is never below the estimate — that is
    what lets the validator use the same maths without false positives.  There
    is deliberately no upper clamp: see H_MAX.
    """
    height = max(H_MIN, estimate_height(text))
    return ((height + H_ROUND - 1) // H_ROUND) * H_ROUND


def card_color(claim):
    stance = normalize_stance((claim.get("jt") or {}).get("stance"))
    return STANCE_COLOR.get(stance)


# --------------------------------------------------------------------------
# fixed cards
# --------------------------------------------------------------------------

EDITABLE_FURNITURE = manifest_mod.EDITABLE_FURNITURE
is_editable_furniture = manifest_mod.is_editable_furniture


def furniture_override(manifest, key):
    """JT's own wording for a furniture card, if he has rewritten it."""
    if not is_editable_furniture(key):
        return None
    value = (manifest.get("jt_furniture") or {}).get(key)
    return value if isinstance(value, str) else None


def toc_text(manifest, chapter_idx, label):
    """A heatmap card: the chapter title, nothing else.  JT may rewrite it."""
    override = furniture_override(manifest, toc_key(chapter_idx))
    if override is not None:
        return override
    return "# " + (label or "")


def toc_card_height(text):
    """Fitted to the title at the narrower TOC width."""
    lines = 0
    for raw in (text or "").split("\n"):
        line = _MD_LINK.sub(r"\1", raw.strip())
        if not line:
            lines += 1
            continue
        if line.startswith("# "):
            line = line[2:].strip()
            lines += TITLE_LINE_WEIGHT * max(
                1, int(math.ceil(len(line) / float(TOC_TITLE_CPL))))
            continue
        lines += max(1, int(math.ceil(len(line) / float(TOC_TITLE_CPL))))
    raw_height = int(math.ceil((BASE_H + LINE_H * lines) * SAFETY_MARGIN))
    height = max(TOC_H_MIN, raw_height)
    return ((height + H_ROUND - 1) // H_ROUND) * H_ROUND


def hub_entries(manifest):
    """(key, label) for every chapter that renders a hub, in book order.

    This is the canonical chapter set: front matter, dedications and indexes
    carry no claims, so they get no hub — and the heatmap must list exactly the
    same chapters the map itself shows, never the raw chapters array.
    """
    claims = manifest_mod.live_claims(manifest)
    chapter_claims = [c for c in claims if not manifest_mod.is_overview(c)]
    keys, labels, _buckets = _chapter_buckets(manifest, chapter_claims)
    return [(key, labels.get(key, str(key))) for key in keys]


def chapter_by_idx(manifest):
    return dict((c.get("idx"), c) for c in manifest.get("chapters", []))


def hub_text(manifest, chapter_idx, label, chapter=None):
    """A chapter's hub card: its title, plus a gloss when the manifest has one.

    The hub is presentational — it names the chapter and anchors its branches.
    JT may rewrite it, and his wording then persists like the root and legend.
    """
    override = furniture_override(manifest, hub_key(chapter_idx))
    if override is not None:
        return override
    lines = ["# " + (label or "")]
    gloss = (chapter or {}).get("gloss")
    if gloss:
        lines.append("")
        lines.append(gloss)
    return "\n".join(lines)


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


def _balance_sides(roots, spans):
    """Split top-level branches between right and left, largest first.

    Each branch goes to whichever side is currently lighter, measured in
    vertical span, so the two wings finish roughly the same height instead of
    one long tail.  Ties break on order then id, so the split is deterministic.
    """
    ordered = sorted(
        roots, key=lambda c: (-spans[c["id"]], c.get("order", 0), c["id"])
    )
    sides = {RIGHT: [], LEFT: []}
    weight = {RIGHT: 0, LEFT: 0}
    for claim in ordered:
        side = RIGHT if weight[RIGHT] <= weight[LEFT] else LEFT
        sides[side].append(claim)
        weight[side] += spans[claim["id"]] + SIB_GAP
    order_key = lambda c: (c.get("order", 0), c["id"])
    return sorted(sides[RIGHT], key=order_key), sorted(sides[LEFT], key=order_key)


def _stack_height(branches, spans):
    if not branches:
        return 0
    return (sum(spans[c["id"]] for c in branches)
            + SIB_GAP * (len(branches) - 1))


def _greedy_groups(items, span_of, cap):
    """Split *items* into vertical runs, each no taller than *cap*."""
    groups = []
    current = []
    used = 0
    for item in items:
        span = span_of(item)
        added = span if not current else SIB_GAP + span
        if current and used + added > cap:
            groups.append(current)
            current = [item]
            used = span
        else:
            current.append(item)
            used += added
    if current:
        groups.append(current)
    return groups


def _group_span(group, spans):
    if not group:
        return 0
    return (sum(spans[item["id"]] for item in group)
            + SIB_GAP * (len(group) - 1))


def _child_runs(kids, spans, cap, limit):
    """Split a parent's children into adjacent runs.

    The cap decides.  Only if honouring it would break the children into more
    than one run do we test whether the tolerance keeps them together — and
    only if it fully avoids the split is it spent.  A run that would still
    need splitting gets no tolerance at all.
    """
    groups = _greedy_groups(kids, lambda k: spans[k["id"]], cap)
    if len(groups) > 1 and limit > cap:
        relaxed = _greedy_groups(kids, lambda k: spans[k["id"]], limit)
        if len(relaxed) == 1:
            return relaxed
    return groups


def _capped_spans(roots, children, heights, cap, limit):
    """Vertical band each subtree owns, once over-tall child runs have spilled.

    A node's band is its own height or its tallest run of children, whichever
    is larger.  Because a run is capped, and a single card can never exceed the
    cap, every band fits — which is what lets the chapter honour the cap
    without ever splitting a subtree.
    """
    spans = {}

    def compute(claim):
        claim_id = claim["id"]
        if claim_id in spans:
            return spans[claim_id]
        kids = children.get(claim_id, [])
        own = heights[claim_id]
        if not kids:
            spans[claim_id] = own
            return own
        for kid in kids:
            compute(kid)
        tallest = 0
        for group in _child_runs(kids, spans, cap, limit):
            tallest = max(tallest, _group_span(group, spans))
        spans[claim_id] = max(own, tallest)
        return spans[claim_id]

    for root in roots:
        compute(root)
    return spans


def _unit_widths(roots, children, spans, cap, limit):
    """Columns each subtree needs — mirrors how _place_unit advances columns."""
    widths = {}

    def compute(claim):
        claim_id = claim["id"]
        if claim_id in widths:
            return widths[claim_id]
        kids = children.get(claim_id, [])
        if not kids:
            widths[claim_id] = 1
            return 1
        for kid in kids:
            compute(kid)
        total = 0
        for run in _child_runs(kids, spans, cap, limit):
            total += max(widths[kid["id"]] for kid in run)
        widths[claim_id] = 1 + total
        return widths[claim_id]

    for root in roots:
        compute(root)
    return widths


def _band_pack(units, spans, widths, cap, compact):
    """Group whole subtrees into bands.

    Sequential (compact off) is v5: close a band as soon as the next subtree
    will not fit.  Compact lets a subtree join any open band that still has
    room, preferring one already wide enough — that is where the width comes
    back, since a narrow section slotted into an existing wide band costs no
    extra columns.  A subtree is never split either way.
    """
    if not compact:
        return _greedy_groups(units, lambda u: spans[u["id"]], cap)

    bands = []
    for unit in units:
        span = spans[unit["id"]]
        width = widths[unit["id"]]
        best = None
        for index, band in enumerate(bands):
            added = span if not band["items"] else SIB_GAP + span
            if band["used"] + added > cap:
                continue
            # prefer the band that needs no widening, then the earliest one
            key = (max(0, width - band["width"]), index)
            if best is None or key < best[0]:
                best = (key, band, added)
        if best is None:
            bands.append({"items": [unit], "used": span, "width": width})
            continue
        _key, band, added = best
        band["items"].append(unit)
        band["used"] += added
        band["width"] = max(band["width"], width)
    return [band["items"] for band in bands]


def _place_unit(claim, column, top, children, heights, spans, cap, limit,
                positions, order):
    """Place one subtree contiguously, root at *column*, children beside it.

    The root and its children are centred on the same band, so a parent always
    sits level with the run of its own children in the very next column.  Only
    when one run would break the cap does it spill into a further column — and
    even then those children stay beside their parent rather than being pooled
    with anyone else's.
    """
    claim_id = claim["id"]
    span = spans[claim_id]
    own = heights[claim_id]
    positions[claim_id] = (column, top + (span - own) // 2)
    order.append(claim_id)

    kids = children.get(claim_id, [])
    if not kids:
        return column

    rightmost = column
    cursor_column = column + 1
    for group in _child_runs(kids, spans, cap, limit):
        group_span = _group_span(group, spans)
        cursor = top + (span - group_span) // 2
        group_right = cursor_column
        for kid in group:
            group_right = max(group_right, _place_unit(
                kid, cursor_column, cursor, children, heights, spans, cap,
                limit, positions, order))
            cursor += spans[kid["id"]] + SIB_GAP
        rightmost = max(rightmost, group_right)
        cursor_column = group_right + 1
    return rightmost


def _layout_chapter(hub_height, roots, children, heights, cap=None):
    """Filmstrip layout: hub in the middle, capped columns fanning both ways.

    Placement is subtree-contiguous: a section card sits in the wing's first
    column with its own children stacked immediately beside it, and the whole
    subtree is placed as one unit.  Units stack down the wing in sibling order;
    when the stack would break the cap, a new BAND opens further out and the
    next WHOLE subtree starts there.  A subtree is never split across bands.

    That is deliberately wider than pooling cards by depth.  Proximity beats
    density here: a parent must be traceable to its children at a glance, and
    an edge that sweeps across the chapter defeats the map.

    Columns occupy distinct x positions and each subtree owns a disjoint
    vertical band, so nothing can overlap by construction.
    """
    if cap is None:
        cap = CHAPTER_HEIGHT_CAP
    limit = max(cap, CHAPTER_HEIGHT_LIMIT if cap == CHAPTER_HEIGHT_CAP else cap)
    spans = _capped_spans(roots, children, heights, cap, limit)
    widths = _unit_widths(roots, children, spans, cap, limit)
    right, left = _balance_sides(roots, spans)

    wings = {}
    for side, branches in ((RIGHT, right), (LEFT, left)):
        wings[side] = _band_pack(branches, spans, widths, cap, BAND_FILL_COMPACT)

    content_h = max(
        [hub_height]
        + [_group_span(band, spans)
           for side in (RIGHT, LEFT) for band in wings[side]]
    )

    positions = {}
    sides = {}
    order = []
    for side in (RIGHT, LEFT):
        wing_positions = {}
        wing_order = []
        column = 0
        for band in wings[side]:
            top = (content_h - _group_span(band, spans)) // 2
            band_right = column
            for unit in band:
                band_right = max(band_right, _place_unit(
                    unit, column, top, children, heights, spans, cap, limit,
                    wing_positions, wing_order))
                top += spans[unit["id"]] + SIB_GAP
            column = band_right + 1
        # Column indices become x here, mirrored for the left wing.
        for claim_id, (col, y) in wing_positions.items():
            positions[claim_id] = ((col + 1) * COL_PITCH * side, y)
            sides[claim_id] = side
        order.extend(wing_order)

    positions[HUB_SLOT] = (0, (content_h - hub_height) // 2)

    # Normalise so the chapter's own extent starts at x = 0.
    left_edge = min(x for x, _y in positions.values())
    right_edge = max(x + CARD_W for x, _y in positions.values())
    if left_edge:
        positions = dict(
            (key, (x - left_edge, y)) for key, (x, y) in positions.items()
        )
    return {
        "positions": positions,
        "sides": sides,
        "order": order,
        "top_level": [c["id"] for c in right] + [c["id"] for c in left],
        "content_w": right_edge - left_edge,
        "content_h": content_h,
        "bands": dict((side, len(wings[side])) for side in (RIGHT, LEFT)),
    }


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


def _group_node(node_ident, label, x, y, width, height, color=None):
    node = {
        "id": node_ident,
        "type": "group",
        "label": label,
        "x": int(x),
        "y": int(y),
        "width": int(width),
        "height": int(height),
    }
    if color:
        node["color"] = color
    return node


def _edge(edge_ident, from_node, to_node, label=None, side=RIGHT):
    """A parent -> child edge.  A left-wing edge is the mirror of a right one."""
    edge = {
        "id": edge_ident,
        "fromNode": from_node,
        "fromSide": "right" if side == RIGHT else "left",
        "toNode": to_node,
        "toSide": "left" if side == RIGHT else "right",
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
    overview_w = o_content_w
    overview_h = o_content_h

    # --- Heatmap Sections: the map's index, in the top-left corner ----------
    # It reads before the map does, so it anchors the canvas's minimum-x,
    # minimum-y corner and the rest of the left rail flows down beneath it.
    # Its geometry is settled FIRST because the shelf has to start clear of it:
    # the block grows rightward a column at a time, and past ~20 chapters it
    # reaches further right than the overview cluster does.
    nodes = []
    toc_cards = []
    toc_group = None
    # Exactly the chapters that render a hub, in the same order — the heatmap
    # is an index of the map, so it must not list front matter the map omits.
    entries = [(key, labels.get(key, str(key))) for key in keys]
    l_x = SIDE_X - COL_GAP - CARD_W
    rail_top = 0
    toc_right = l_x
    if entries:
        toc_top = 0
        inner_x = l_x + TOC_PAD
        inner_y = toc_top + TOC_PAD
        column_bottom = {}
        for index, (key, label) in enumerate(entries):
            column, _row = divmod(index, TOC_ROWS)
            text = toc_text(manifest, key, label)
            height = toc_card_height(text)
            x = inner_x + column * (TOC_CARD_W + TOC_GAP)
            y = column_bottom.get(column, inner_y)
            toc_cards.append(_text_node(
                node_id(slug, toc_key(key)), text, x, y, TOC_CARD_W, height,
            ))
            column_bottom[column] = y + height + TOC_GAP
        columns_used = max(column_bottom) + 1
        toc_width = (columns_used * TOC_CARD_W
                     + (columns_used - 1) * TOC_GAP + 2 * TOC_PAD)
        toc_bottom = max(column_bottom.values()) - TOC_GAP + TOC_PAD
        toc_group = _group_node(
            node_id(slug, TOC_GROUP_KEY), TOC_LABEL,
            l_x, toc_top, toc_width, toc_bottom - toc_top, TOC_COLOR,
        )
        rail_top = toc_bottom + SIDE_GAP
        toc_right = l_x + toc_width

    # The shelf clears BOTH left-hand blocks: the overview cluster below and
    # the heatmap above.  Taking only the overview into account put chapter
    # cards underneath the heatmap's later columns at 21+ chapters.
    chapter_x = max(SIDE_X + overview_w + CLUSTER_GAP, toc_right + CLUSTER_GAP)

    # Chapters sit on a horizontal shelf, top-aligned at y = 0 and advancing
    # left to right in book order.  Stacking them vertically made a book-scale
    # map 1:112 and unreadable at fit-to-view.  Within a chapter the branches
    # fan out both sides of a hub card, which halves the width a chapter needs
    # and keeps the whole map close to a screen's aspect.  Whitespace separates
    # chapters — there are no group boxes.
    chapter_by = chapter_by_idx(manifest)
    hubs = []
    placed = {}          # claim id -> (x, y)
    chapter_order = []
    sides = {}
    cursor_x = chapter_x
    tallest = 0
    for key in keys:
        bucket_claims = buckets[key]
        bucket_ids = set(c["id"] for c in bucket_claims)
        roots, children = _forest(bucket_claims, live_ids, bucket_ids)
        h_text = hub_text(manifest, key, labels.get(key, str(key)), chapter_by.get(key))
        h_h = card_height(h_text)
        layout = _layout_chapter(h_h, roots, children, heights)
        for claim_id, (x, y) in layout["positions"].items():
            if claim_id == HUB_SLOT:
                continue
            placed[claim_id] = (x + cursor_x, y)
        hub_x, hub_y = layout["positions"][HUB_SLOT]
        hubs.append({
            "key": key,
            "text": h_text,
            "x": hub_x + cursor_x,
            "y": hub_y,
            "height": h_h,
            "top_level": layout["top_level"],
        })
        sides.update(layout["sides"])
        chapter_order.extend(layout["order"])
        cursor_x += layout["content_w"] + CHAPTER_GAP
        tallest = max(tallest, layout["content_h"])

    if toc_group is not None:
        nodes.append(toc_group)

    # --- far-left rail below it: legend, root + overview claims, then bin ---
    # The legend is centred on the root card and is usually the taller of the
    # two, so it reaches above the root.  Push the whole cluster down by that
    # overhang, or the legend would ride up into the heatmap above it.
    legend = legend_text(manifest)
    l_h = card_height(legend)
    o_offset_x = SIDE_X
    o_offset_y = rail_top
    overhang = rail_top - ((o_positions[ROOT_SLOT][1] + rail_top)
                           + (r_h - l_h) // 2)
    if overhang > 0:
        o_offset_y += overhang

    for claim_id, (x, y) in o_positions.items():
        if claim_id == ROOT_SLOT:
            continue
        placed[claim_id] = (x + o_offset_x, y + o_offset_y)
    root_x, root_y = o_positions[ROOT_SLOT]
    root_x += o_offset_x
    root_y += o_offset_y

    # The legend sits immediately left of the root card, centred against it —
    # the key to the map reads before the map.  The unmatched bin drops below
    # the root card, in the root's own column, clear of the overview claims.
    l_y = root_y + (r_h - l_h) // 2

    card_order = list(o_order) + chapter_order

    root_ident = node_id(slug, "root")
    nodes.append(_text_node(root_ident, r_text, root_x, root_y, CARD_W, r_h, COLOR_ROOT))
    nodes.append(_text_node(
        node_id(slug, "legend"), legend, l_x, l_y, CARD_W, l_h, COLOR_LEGEND
    ))
    if manifest.get("unmatched"):
        b_text = bin_text(manifest)
        b_h = card_height(b_text)
        nodes.append(_text_node(
            node_id(slug, "bin"), b_text, root_x, root_y + r_h + SIDE_GAP,
            CARD_W, b_h, COLOR_BIN
        ))
    nodes.extend(toc_cards)

    for hub in hubs:
        nodes.append(_text_node(
            node_id(slug, hub_key(hub["key"])), hub["text"],
            hub["x"], hub["y"], CARD_W, hub["height"], COLOR_HUB,
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
    # No root -> hub spokes.  Shelf position already carries chapter order, and
    # one long line per chapter across the whole map is noise, not structure.
    # The keys stay known (see known_ids) so spokes left in an older canvas are
    # dropped rather than resurrected as JT's own edges.
    edges = []
    hub_of = {}
    for hub in hubs:
        for claim_id in hub["top_level"]:
            hub_of[claim_id] = node_id(slug, hub_key(hub["key"]))

    top_level_overview = set(c["id"] for c in o_top_level)
    for claim_id in card_order:
        claim = by_id[claim_id]
        parent = claim.get("parent")
        if claim_id in top_level_overview:
            # an overview claim hangs directly off the root card
            from_node = root_ident
        elif parent != "root" and parent in live_ids:
            # A live parent owns the edge even when it sits in another chapter:
            # _forest makes such a child a local root for LAYOUT only, and the
            # hub must not quietly stand in for the real parent.
            from_node = claim_node_id(slug, parent)
        elif claim_id in hub_of:
            # a chapter's top-level claim hangs off that chapter's hub card
            from_node = hub_of[claim_id]
        else:
            continue
        edges.append(_edge(
            node_id(slug, edge_key(claim_id)),
            from_node,
            claim_node_id(slug, claim_id),
            _rel_label(claim),
            sides.get(claim_id, RIGHT),
        ))

    canvas = {"nodes": nodes, "edges": edges}

    if existing:
        _carry_forward(manifest, canvas, existing)

    return canvas


def furniture_text(manifest):
    """Every furniture card as it would be projected right now.

    Cheaper than a full build, and it already reflects any wording of JT's that
    has been folded in, so comparing a canvas against it is idempotent.
    """
    claims = manifest_mod.live_claims(manifest)
    chapter_claims = [c for c in claims if not manifest_mod.is_overview(c)]
    keys, labels, _buckets = _chapter_buckets(manifest, chapter_claims)
    chapter_by = chapter_by_idx(manifest)
    out = {
        "root": root_text(manifest, len(claims), len(keys)),
        "legend": legend_text(manifest),
        "bin": bin_text(manifest),
    }
    for key in keys:
        out[hub_key(key)] = hub_text(
            manifest, key, labels.get(key, str(key)), chapter_by.get(key)
        )
    for key in keys:
        out[toc_key(key)] = toc_text(manifest, key, labels.get(key, str(key)))
    return out


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
    colours = {}
    for node in existing.get("nodes") or []:
        ident = node.get("id")
        if ident is None:
            continue
        geometry = _node_geometry(node)
        if geometry:
            keep[ident] = geometry
        if isinstance(node.get("color"), str):
            colours[ident] = node["color"]

    # Heatmap cards are JT's colouring surface: whatever colour one wears is
    # his, so it survives every rebuild.  Nothing else takes colour from the
    # canvas — stance colour is projected from the manifest.
    toc_ids = set(
        node_id(manifest["slug"], toc_key(key))
        for key, _label in hub_entries(manifest)
    )
    for node in canvas["nodes"]:
        if node["id"] in toc_ids and node["id"] in colours:
            node["color"] = colours[node["id"]]

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
