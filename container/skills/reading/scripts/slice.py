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


def chapter_text(html, blocks, chapter):
    """Plain-text rendering of one chapter, for LLM consumption.

    One paragraph per block, each prefixed with its zero-padded block index —
    ``[0412] ...`` — so downstream extraction can cite block ids. Blocks that
    render to nothing (spacers, image-only paragraphs) are omitted.
    """
    paragraphs = []
    for index in range(chapter["block_start"], chapter["block_end"]):
        block = blocks[index]
        text = block_text(html, block)
        if not text:
            continue
        paragraphs.append("[%04d] %s" % (block["i"], text))
    return "\n\n".join(paragraphs)


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
    meta = {
        "doc_id": doc_id,
        "sha256": sha256_text(html),
        "html_chars": len(html),
        "block_count": len(blocks),
        "chapter_count": len(chapter_list),
        "format": detect_format(html),
        "cached_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    if extra_meta:
        meta.update(extra_meta)
    atomic_write_text(directory / "source.html", html)
    atomic_write_text(directory / "blocks.json", json.dumps(blocks))
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


def load_meta(doc_id):
    return _load_json(doc_id, "meta.json")


def cache_is_valid(doc_id, html):
    """True when the cached meta sha256 matches ``html``."""
    meta = load_meta(doc_id)
    return bool(meta) and meta.get("sha256") == sha256_text(html)
