"""Slice a Readwise Reader ``html_content`` document into anchorable blocks.

python3 stdlib ONLY. Runs unchanged inside the Linux agent container and on
Windows/Claude Code.

The unit of anchoring is the whole ``<p ...>...</p>`` block, byte-for-byte, as
it appears in ``html_content`` — that exact substring is what
``reader_create_highlight`` needs. Everything here therefore works in **Python
str character offsets** into the original html, and ``html[start:end]`` always
reproduces a block exactly, whitespace included. Nothing is ever normalized on
the slicing path.

Range convention: chapter ``block_start`` is inclusive, ``block_end`` is
EXCLUSIVE (half-open, Python style), so consecutive chapters satisfy
``chapters[i]["block_end"] == chapters[i + 1]["block_start"]`` and the last
chapter's ``block_end == len(blocks)``.
"""

from __future__ import annotations

import bisect
import hashlib
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from html import unescape
from pathlib import Path

CACHE_ROOT_NAME = os.path.join(".cache", "daystrom-reading")

_OPEN_P_RE = re.compile(r"<p\b[^>]*>", re.IGNORECASE)
_CLOSE_P_RE = re.compile(r"</p\s*>", re.IGNORECASE)
_TAG_RE = re.compile(r"<[^>]*>")
_WS_RE = re.compile(r"\s+")
_TOC_ATTR_RE = re.compile(r'data-rw-epub-toc\s*=\s*"([^"]*)"', re.IGNORECASE)
_TOC_PRESENT_RE = re.compile(r"data-rw-epub-toc\s*=", re.IGNORECASE)
_BLOCK_TYPE_RE = re.compile(r"block-type\s*=", re.IGNORECASE)
_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_LI_TOKEN_RE = re.compile(r"<li\b[^>]*>|</li\s*>", re.IGNORECASE)

#: List items are rendered under their anchoring paragraph with this marker.
ITEM_BULLET = "•"
ITEM_INDENT = "    "


# --------------------------------------------------------------------------
# Slicing
# --------------------------------------------------------------------------


def slice_blocks(html):
    """Return ``[{"i": idx, "start": s, "end": e}, ...]`` for every ``<p>`` block.

    ``html[s:e]`` is the block verbatim, opening ``<p ...>`` through ``</p>``
    inclusive. Blocks are in document order and never overlap. An unterminated
    trailing ``<p>`` is dropped rather than guessed at.
    """
    blocks = []
    position = 0
    length = len(html)
    while position < length:
        opener = _OPEN_P_RE.search(html, position)
        if opener is None:
            break
        closer = _CLOSE_P_RE.search(html, opener.end())
        if closer is None:
            break
        blocks.append({"i": len(blocks), "start": opener.start(), "end": closer.end()})
        position = closer.end()
    return blocks


def block_html(html, block):
    """The exact source text of one block."""
    return html[block["start"]:block["end"]]


def opening_tag(html, block):
    """Just the ``<p ...>`` opening tag of a block."""
    fragment = html[block["start"]:block["end"]]
    end = fragment.find(">")
    return fragment if end == -1 else fragment[:end + 1]


def block_text(html, block):
    """Plain text of one block: tags stripped, entities unescaped, ws collapsed.

    Reading order matters — tags are stripped BEFORE unescaping, so an escaped
    ``&lt;p&gt;`` in the prose can never be mistaken for markup.
    """
    return _to_text(html[block["start"]:block["end"]])


def _to_text(fragment):
    stripped = _TAG_RE.sub("", fragment)
    return _WS_RE.sub(" ", unescape(stripped)).strip()


def detect_format(html):
    """``"pdf"`` when ``block-type=`` attributes are present, else ``"epub"``."""
    return "pdf" if _BLOCK_TYPE_RE.search(html) else "epub"


# --------------------------------------------------------------------------
# List items — content that lives BETWEEN the p-blocks
# --------------------------------------------------------------------------
#
# Reader's html_content puts ``<li>`` elements outside the ``<p>`` blocks
# entirely. On the pilot EPUB that is 592 items and ~65K characters of real
# argument that ``chapter_text`` never showed the extractor. They are surfaced
# here WITHOUT becoming blocks: block indexing, offsets and the highlight
# anchor unit are untouched, because ``reader_create_highlight`` needs a
# verbatim ``<p>`` and an ``<li>`` cannot be one. Each item is attributed to
# the nearest PRECEDING p-block, which is therefore its citation anchor.


def _li_items(region):
    """Flatten every ``<li>`` in *region* to plain text, in document order.

    Nested lists flatten: an outer item contributes only its own text, each
    inner item follows as its own entry. Unclosed items are closed at the end
    of the region rather than dropped.
    """
    stack = []
    spans = {}
    order = 0
    for match in _LI_TOKEN_RE.finditer(region):
        if match.group(0)[1] == "/":
            if stack:
                index, start = stack.pop()
                spans[index] = (start, match.start())
        else:
            stack.append((order, match.end()))
            order += 1
    while stack:
        index, start = stack.pop()
        spans[index] = (start, len(region))

    items = []
    for index in sorted(spans):
        start, end = spans[index]
        nested = sorted(
            (s, e) for key, (s, e) in spans.items()
            if key != index and start <= s and e <= end
        )
        if nested:
            pieces = []
            cursor = start
            for inner_start, inner_end in nested:
                if inner_start < cursor:
                    continue
                pieces.append(region[cursor:inner_start])
                cursor = inner_end
            pieces.append(region[cursor:end])
            content = "".join(pieces)
        else:
            content = region[start:end]
        text = _to_text(content)
        if text:
            items.append(text)
    return items


def _gap_regions(html, blocks):
    """``[(preceding_block_index, region_text), ...]`` for every inter-block gap.

    The region before the first block is attributed to -1; the region after the
    last block belongs to the last block.
    """
    if not blocks:
        return [(-1, html)]
    regions = [(-1, html[:blocks[0]["start"]])]
    for position in range(len(blocks) - 1):
        regions.append((
            blocks[position]["i"],
            html[blocks[position]["end"]:blocks[position + 1]["start"]],
        ))
    regions.append((blocks[-1]["i"], html[blocks[-1]["end"]:]))
    return regions


def inter_block_items(html, blocks):
    """``{preceding_block_index: [item_text, ...]}`` for every ``<li>`` in the gaps.

    Items before the first p-block are keyed -1. Keys with no items are absent.
    """
    found = {}
    for index, region in _gap_regions(html, blocks):
        if "<li" not in region and "<LI" not in region:
            continue
        items = _li_items(region)
        if items:
            found.setdefault(index, []).extend(items)
    return found


# --------------------------------------------------------------------------
# Chapters
# --------------------------------------------------------------------------


def chapters(html, blocks):
    """Partition ``blocks`` into chapters.

    EPUB: a block whose opening tag carries ``data-rw-epub-toc="..."`` starts a
    new chapter, and that block's text is the chapter title. Blocks before the
    first marker become chapter 0, ``"Front matter"``.

    PDF: chapter detection is out of scope — a single chapter 0, ``"Document"``.

    Every block belongs to exactly one chapter. Returns
    ``[{"idx", "title", "block_start", "block_end"}]`` with ``block_end``
    exclusive. An empty ``blocks`` list yields ``[]``.
    """
    if not blocks:
        return []
    if detect_format(html) == "pdf":
        return [{
            "idx": 0,
            "title": "Document",
            "block_start": 0,
            "block_end": len(blocks),
        }]

    markers = []  # (block_index, title)
    for block in blocks:
        tag = opening_tag(html, block)
        if _TOC_PRESENT_RE.search(tag):
            markers.append((block["i"], block_text(html, block)))

    if not markers:
        return [{
            "idx": 0,
            "title": "Document",
            "block_start": 0,
            "block_end": len(blocks),
        }]

    starts = []  # (block_index, title)
    if markers[0][0] > 0:
        starts.append((0, "Front matter"))
    starts.extend(markers)

    result = []
    for position, (start_index, title) in enumerate(starts):
        if position + 1 < len(starts):
            end_index = starts[position + 1][0]
        else:
            end_index = len(blocks)
        result.append({
            "idx": position,
            "title": title or "Untitled",
            "block_start": start_index,
            "block_end": end_index,
        })
    return result


def toc_marker(html, block):
    """The ``data-rw-epub-toc`` value of a block, or ``None``."""
    match = _TOC_ATTR_RE.search(opening_tag(html, block))
    return match.group(1) if match else None


def chapter_text(html, blocks, chapter, items=None):
    """Plain-text rendering of one chapter, for LLM consumption.

    One paragraph per block, each prefixed with its zero-padded block index —
    ``[0412] ...`` — so downstream extraction can cite block ids. Blocks that
    render to nothing (spacers, image-only paragraphs) are omitted.

    List items found between the blocks follow their anchoring block as
    indented bullets with NO index of their own — they are not anchorable, and
    the ``[NNNN]`` paragraph above them is the block a citation must use. A
    chapter shows only the items attributed to its own blocks, so items sitting
    in the gap before the next chapter's first block stay with this chapter and
    never leak into the next one.

    Pass *items* to reuse a mapping already computed (or cached); by default it
    is derived from *html*.
    """
    if items is None:
        items = inter_block_items(html, blocks)
    paragraphs = []
    for index in range(chapter["block_start"], chapter["block_end"]):
        block = blocks[index]
        entry = []
        text = block_text(html, block)
        if text:
            entry.append("[%04d] %s" % (block["i"], text))
        for item in items.get(block["i"], ()):
            if item:
                entry.append("%s%s %s" % (ITEM_INDENT, ITEM_BULLET, item))
        if entry:
            paragraphs.append("\n".join(entry))
    return "\n\n".join(paragraphs)


# --------------------------------------------------------------------------
# Gap audit — what is in the html that neither blocks nor items surface
# --------------------------------------------------------------------------
#
# Callout boxes, tables, blockquotes and pre blocks all live outside the
# ``<p>`` + ``<li>`` rendering. This is a smoke detector, not a parser: it
# reports how much text extraction cannot see and which tags it sits in, so a
# build reports the gap instead of silently dropping it.

_SKIP_CONTAINERS = ("style", "script", "svg", "head", "noscript")

#: Text is attributed to the innermost of these on the open-tag stack; a run in
#: a ``<td>`` inside a ``<table>`` reports as "table", which is what a human
#: reading the audit wants to know.
_AUDIT_CONTAINERS = (
    "table", "blockquote", "pre", "figure", "figcaption", "aside", "caption",
    "dl", "dt", "dd", "code", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6",
)

_VOID_TAGS = (
    "br", "img", "hr", "input", "meta", "link", "source", "col", "area",
    "base", "embed", "param", "track", "wbr",
)

_TAG_PARSE_RE = re.compile(r"^<\s*(/?)\s*([A-Za-z][A-Za-z0-9:-]*)")
_SELF_CLOSING_RE = re.compile(r"/\s*>$")

AUDIT_SAMPLE_CHARS = 80
AUDIT_SAMPLE_COUNT = 5


def _attribute(stack):
    for name in reversed(stack):
        if name in _AUDIT_CONTAINERS:
            return name
    return "other"


def gap_text_audit(html, blocks):
    """What text lives outside the p-blocks that ``inter_block_items`` misses.

    Returns ``{"total_chars", "by_tag", "samples"}``. ``li`` content is
    excluded — it is already surfaced — as is anything inside ``<style>``,
    ``<script>`` or ``<svg>``, and pure whitespace.

    The tag stack is tracked across the whole document rather than per gap, so
    a ``<table>`` that contains a ``<p>`` block still attributes the text
    around that block to "table".
    """
    spans = [(block["start"], block["end"]) for block in blocks]
    starts = [span[0] for span in spans]

    def inside_block(position):
        index = bisect.bisect_right(starts, position) - 1
        return index >= 0 and position < spans[index][1]

    stack = []
    runs = []
    cursor = 0

    def record(chunk, start_position):
        if inside_block(start_position):
            return
        if "li" in stack:
            return
        for name in stack:
            if name in _SKIP_CONTAINERS:
                return
        text = _to_text(chunk)
        if text:
            runs.append((_attribute(stack), text))

    for match in _TAG_RE.finditer(html):
        record(html[cursor:match.start()], cursor)
        cursor = match.end()
        raw = match.group(0)
        parsed = _TAG_PARSE_RE.match(raw)
        if parsed is None:
            continue                      # comment, doctype, stray bracket
        closing, name = parsed.group(1), parsed.group(2).lower()
        if closing:
            if name in stack:
                while stack and stack.pop() != name:
                    pass
        elif name not in _VOID_TAGS and not _SELF_CLOSING_RE.search(raw):
            stack.append(name)
    record(html[cursor:], cursor)

    by_tag = {}
    longest = {}
    for name, text in runs:
        by_tag[name] = by_tag.get(name, 0) + len(text)
        if len(text) > len(longest.get(name, "")):
            longest[name] = text

    samples = []
    for name in sorted(by_tag, key=lambda k: (-by_tag[k], k)):
        if len(samples) >= AUDIT_SAMPLE_COUNT:
            break
        samples.append(longest[name][:AUDIT_SAMPLE_CHARS])
    if len(samples) < AUDIT_SAMPLE_COUNT:
        for _name, text in sorted(runs, key=lambda item: -len(item[1])):
            clipped = text[:AUDIT_SAMPLE_CHARS]
            if clipped not in samples:
                samples.append(clipped)
            if len(samples) >= AUDIT_SAMPLE_COUNT:
                break

    return {
        "total_chars": sum(by_tag.values()),
        "by_tag": by_tag,
        "samples": samples,
    }


# --------------------------------------------------------------------------
# Cache layout — deliberately OUTSIDE the vault
# --------------------------------------------------------------------------


def _safe_doc_id(doc_id):
    text = str(doc_id or "").strip()
    if not _SAFE_ID_RE.match(text):
        raise ValueError("Unsafe document id for a cache path: %r" % (doc_id,))
    return text


def cache_dir(doc_id, create=True):
    """``~/.cache/daystrom-reading/<doc_id>/`` — created on demand.

    Source html lives outside the Obsidian vault on purpose: it is bulky,
    machine-owned, and must never sync.
    """
    path = Path(os.path.expanduser("~")) / CACHE_ROOT_NAME / _safe_doc_id(doc_id)
    if create:
        path.mkdir(parents=True, exist_ok=True)
    return path


def atomic_write_text(path, text):
    """Write ``text`` to ``path`` atomically (temp in the same dir + replace).

    ``newline=""`` throughout so line endings survive byte-for-byte on Windows —
    the highlight anchor depends on it.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, tmp_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=".%s." % path.name, suffix=".tmp"
    )
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_name, str(path))
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
    return path


def _read_text(path):
    with open(str(path), "r", encoding="utf-8", newline="") as fh:
        return fh.read()


def sha256_text(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def save_source(doc_id, html, extra_meta=None):
    """Cache ``source.html`` plus derived ``blocks/chapters/meta`` json.

    All four files are written atomically. Returns the metadata dict.
    """
    directory = cache_dir(doc_id)
    blocks = slice_blocks(html)
    chapter_list = chapters(html, blocks)
    items = inter_block_items(html, blocks)
    meta = {
        "doc_id": doc_id,
        "sha256": sha256_text(html),
        "html_chars": len(html),
        "block_count": len(blocks),
        "chapter_count": len(chapter_list),
        "format": detect_format(html),
        "list_item_count": sum(len(v) for v in items.values()),
        "cached_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    if extra_meta:
        meta.update(extra_meta)
    atomic_write_text(directory / "source.html", html)
    atomic_write_text(directory / "blocks.json", json.dumps(blocks))
    atomic_write_text(
        directory / "items.json",
        json.dumps(dict((str(k), v) for k, v in items.items()), ensure_ascii=False),
    )
    atomic_write_text(
        directory / "chapters.json", json.dumps(chapter_list, ensure_ascii=False, indent=2)
    )
    atomic_write_text(
        directory / "meta.json", json.dumps(meta, ensure_ascii=False, indent=2)
    )
    return meta


def load_source(doc_id):
    """Cached ``source.html`` as a str, or ``None`` when not cached."""
    path = cache_dir(doc_id, create=False) / "source.html"
    if not path.is_file():
        return None
    return _read_text(path)


def _load_json(doc_id, name):
    path = cache_dir(doc_id, create=False) / name
    if not path.is_file():
        return None
    return json.loads(_read_text(path))


def load_blocks(doc_id):
    return _load_json(doc_id, "blocks.json")


def load_chapters(doc_id):
    return _load_json(doc_id, "chapters.json")


def load_items(doc_id):
    """Cached inter-block list items, keys back to ints, or None when absent.

    JSON object keys are strings; the mapping is keyed by block index, so they
    are converted back on the way in.
    """
    raw = _load_json(doc_id, "items.json")
    if raw is None:
        return None
    return dict((int(key), value) for key, value in raw.items())


def load_meta(doc_id):
    return _load_json(doc_id, "meta.json")


def cache_is_valid(doc_id, html):
    """True when the cached meta sha256 matches ``html``."""
    meta = load_meta(doc_id)
    return bool(meta) and meta.get("sha256") == sha256_text(html)
