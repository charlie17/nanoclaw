"""Manifest — the backbone record for a reading claim map.

The manifest is authoritative; the canvas is its projection.  Every arm/refresh
run loads the manifest, re-parses the canvas back onto it, then projects
forward.  Nothing here knows about canvas geometry.

python3 stdlib only.  Runs unchanged on Linux containers and Windows.
All writes are atomic (temp file in the same directory + os.replace): the
vault lives under Obsidian Sync and a torn write corrupts a synced file.
"""

import datetime
import hashlib
import json
import os
import tempfile

SCHEMA_VERSION = 1

CATEGORIES = ("epub", "pdf", "article", "email", "tweet", "rss", "note")

# Flag / stance vocabularies live here so every surface agrees on them.
FLAGS = ("⭐", "\U0001f525", "⏭️", "❓")  # key / dig in / skip / clarify
STANCES = ("agree", "dispute", "surface")

# chapter_idx -1 marks a book-level overview card: the source's overall thesis
# in a handful of cards.  Overview claims live in their own group beside the
# root card and are exempt from chapter-range checks.
OVERVIEW_IDX = -1

# How a claim relates to its parent.  "supports" is the default and is left
# unlabelled on the canvas; anything else labels the edge.
REL_DEFAULT = "supports"
REL_VOCABULARY = (
    "supports", "objection", "reply", "qualifies",
    "contrasts", "example", "consequence",
)

# Chapter block ranges are HALF-OPEN: block_end is exclusive, so
# chapters[i].block_end == chapters[i + 1].block_start and the last chapter's
# block_end == len(blocks).  This matches what slice.py emits.


class ManifestError(Exception):
    """Raised when a manifest is structurally invalid."""


# --------------------------------------------------------------------------
# atomic io
# --------------------------------------------------------------------------

def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def atomic_write_bytes(path, data):
    """Write *data* to *path* atomically.  Returns the sha256 of the bytes."""
    path = os.path.abspath(path)
    directory = os.path.dirname(path)
    if directory and not os.path.isdir(directory):
        os.makedirs(directory)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", suffix=".part", dir=directory)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        tmp = None
    finally:
        if tmp is not None:
            try:
                os.unlink(tmp)
            except OSError:
                pass
    return sha256_bytes(data)


def atomic_write_text(path, text):
    """Write *text* as UTF-8 atomically.  Returns the sha256 of the file bytes."""
    return atomic_write_bytes(path, text.encode("utf-8"))


def file_sha256(path):
    """sha256 of a file's bytes, or None when the file does not exist."""
    if not os.path.isfile(path):
        return None
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(65536)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


# --------------------------------------------------------------------------
# construction
# --------------------------------------------------------------------------

def _blank_source():
    return {
        "document_id": "",
        "title": "",
        "author": "",
        "category": "epub",
        "word_count": 0,
        "html_sha256": "",
        "fetched_at": "",
    }


def new_manifest(slug, source_meta=None, chapters=None):
    """Build an empty v1 manifest for *slug*."""
    if not slug or not isinstance(slug, str):
        raise ManifestError("slug must be a non-empty string")
    source = _blank_source()
    for key, value in (source_meta or {}).items():
        source[key] = value

    normalised = []
    for position, chapter in enumerate(chapters or []):
        normalised.append({
            "idx": int(chapter.get("idx", position)),
            "title": chapter.get("title", "") or "",
            "block_start": int(chapter.get("block_start", 0)),
            "block_end": int(chapter.get("block_end", 0)),
        })

    manifest = {
        "version": SCHEMA_VERSION,
        "slug": slug,
        "source": source,
        "canvas_file": slug + ".canvas",
        "canvas_last_written_sha256": None,
        "chapters": normalised,
        "claims": [],
        "unmatched": [],
        "runs": [],
    }
    validate(manifest)
    return manifest


def new_claim(claim_id, title, chapter_idx=0, parent="root", order=0, **kwargs):
    """A fully-populated claim record with every v1 key present.

    An overview claim (chapter_idx -1) that cites nothing gets a null
    block_range and anchor_block — it summarises the book, not a passage.
    """
    is_overview = int(chapter_idx) == OVERVIEW_IDX
    block_range = kwargs.get("block_range")
    if block_range is None and not is_overview:
        block_range = [0, 0]
    anchor_block = kwargs.get("anchor_block")
    if anchor_block is None and not is_overview:
        anchor_block = 0

    claim = {
        "id": claim_id,
        "parent": parent,
        "order": int(order),
        "title": title or "",
        "chapter_idx": int(chapter_idx),
        "rel": kwargs.get("rel", REL_DEFAULT),
        "locator": kwargs.get("locator", "") or "",
        "block_range": list(block_range) if block_range is not None else None,
        "anchor_block": int(anchor_block) if anchor_block is not None else None,
        "anchor_phrase": kwargs.get("anchor_phrase", "") or "",
        "body_md": kwargs.get("body_md", "") or "",
        "cite": {
            "highlight_id": kwargs.get("highlight_id"),
            "url": kwargs.get("url"),
        },
        "jt": {
            "flags": list(kwargs.get("flags", [])),
            "stance": kwargs.get("stance"),
            "notes": list(kwargs.get("notes", [])),
            "highlights": list(kwargs.get("highlights", [])),
            "title_override": kwargs.get("title_override"),
            "body_override": kwargs.get("body_override"),
            "pruned": bool(kwargs.get("pruned", False)),
        },
    }
    return claim


def new_highlight(reader_id="", url="", text="", note=""):
    return {"reader_id": reader_id, "url": url, "text": text, "note": note}


# --------------------------------------------------------------------------
# validation
# --------------------------------------------------------------------------

def _require(condition, message):
    if not condition:
        raise ManifestError(message)


def validate(manifest):
    """Raise ManifestError on a structurally invalid manifest.  Returns None."""
    _require(isinstance(manifest, dict), "manifest: expected a JSON object")
    version = manifest.get("version")
    _require(
        version == SCHEMA_VERSION,
        "manifest.version: expected %r, got %r" % (SCHEMA_VERSION, version),
    )
    _require(
        isinstance(manifest.get("slug"), str) and manifest["slug"].strip(),
        "manifest.slug: must be a non-empty string",
    )
    _require(isinstance(manifest.get("source"), dict), "manifest.source: must be an object")

    chapters = manifest.get("chapters")
    _require(isinstance(chapters, list), "manifest.chapters: must be an array")
    seen_chapter_idx = set()
    spans = []
    for position, chapter in enumerate(chapters):
        _require(isinstance(chapter, dict), "chapters[%d]: must be an object" % position)
        idx = chapter.get("idx")
        _require(
            isinstance(idx, int) and not isinstance(idx, bool),
            "chapters[%d].idx: must be an integer" % position,
        )
        _require(
            idx != OVERVIEW_IDX,
            "chapters[%d].idx: %d is reserved for overview claims" % (position, OVERVIEW_IDX),
        )
        _require(idx not in seen_chapter_idx, "chapters[%d].idx: duplicate idx %r" % (position, idx))
        seen_chapter_idx.add(idx)
        start = chapter.get("block_start", 0)
        end = chapter.get("block_end", 0)
        _require(
            isinstance(start, int) and isinstance(end, int)
            and not isinstance(start, bool) and not isinstance(end, bool),
            "chapters[%d]: block_start/block_end must be integers" % position,
        )
        # half-open: block_end is exclusive, so an empty chapter has start == end.
        _require(
            0 <= start <= end,
            "chapters[%d]: half-open block range [%r, %r) is not sane"
            % (position, start, end),
        )
        spans.append((start, end, idx))

    spans.sort()
    for position in range(len(spans) - 1):
        current_start, current_end, current_idx = spans[position]
        next_start, _next_end, next_idx = spans[position + 1]
        _require(
            current_end <= next_start,
            "manifest.chapters: chapter %r [%d, %d) overlaps chapter %r starting at %d "
            "(block_end is exclusive)"
            % (current_idx, current_start, current_end, next_idx, next_start),
        )

    # Optional: the geometry of the canvas as we last wrote it, used to tell a
    # node JT moved from one that simply has not been reflowed yet.  Absent on
    # a manifest written before snapshots existed, or never written at all.
    snapshot = manifest.get("node_geometry")
    if snapshot is not None:
        _require(
            isinstance(snapshot, dict),
            "manifest.node_geometry: must be an object keyed by node id",
        )
        for ident, box in snapshot.items():
            _require(
                isinstance(box, (list, tuple)) and len(box) == 4
                and all(isinstance(v, int) and not isinstance(v, bool) for v in box),
                "manifest.node_geometry[%r]: must be [x, y, width, height] integers"
                % ident,
            )

    claims = manifest.get("claims")
    _require(isinstance(claims, list), "manifest.claims: must be an array")

    ids = []
    for position, claim in enumerate(claims):
        _require(isinstance(claim, dict), "claims[%d]: must be an object" % position)
        claim_id = claim.get("id")
        _require(
            isinstance(claim_id, str) and claim_id.strip(),
            "claims[%d].id: must be a non-empty string" % position,
        )
        _require(claim_id != "root", "claims[%d].id: 'root' is reserved" % position)
        ids.append(claim_id)

    seen = set()
    duplicates = []
    for claim_id in ids:
        if claim_id in seen and claim_id not in duplicates:
            duplicates.append(claim_id)
        seen.add(claim_id)
    _require(not duplicates, "manifest.claims: duplicate claim id(s): %s" % ", ".join(duplicates))

    for position, claim in enumerate(claims):
        parent = claim.get("parent")
        _require(
            isinstance(parent, str) and parent.strip(),
            "claims[%d].parent: must be a non-empty string" % position,
        )
        _require(
            parent == "root" or parent in seen,
            "claims[%d] (%s).parent: %r resolves to no claim" % (position, claim.get("id"), parent),
        )
        rel = claim.get("rel")
        _require(
            rel is None or rel in REL_VOCABULARY,
            "claims[%d] (%s).rel: %r is not one of %s"
            % (position, claim.get("id"), rel, ", ".join(REL_VOCABULARY)),
        )

        # An overview claim (chapter_idx -1) summarises the book rather than a
        # passage, so it may carry no block range and no cite at all.
        is_overview = claim.get("chapter_idx") == OVERVIEW_IDX
        block_range = claim.get("block_range")
        if not (is_overview and block_range is None):
            _require(
                isinstance(block_range, (list, tuple)) and len(block_range) == 2,
                "claims[%d] (%s).block_range: must be a two-element array"
                % (position, claim.get("id")),
            )
            start, end = block_range[0], block_range[1]
            _require(
                isinstance(start, int) and isinstance(end, int)
                and not isinstance(start, bool) and not isinstance(end, bool),
                "claims[%d] (%s).block_range: must hold integers"
                % (position, claim.get("id")),
            )
            _require(
                0 <= start <= end,
                "claims[%d] (%s).block_range: [%r, %r] is not sane"
                % (position, claim.get("id"), start, end),
            )
        _require(isinstance(claim.get("jt"), dict), "claims[%d] (%s).jt: must be an object"
                 % (position, claim.get("id")))

    # cycle check: a parent chain must terminate at "root".
    by_id = {claim["id"]: claim for claim in claims}
    for claim in claims:
        seen_chain = set()
        cursor = claim
        while cursor is not None and cursor.get("parent") != "root":
            if cursor["id"] in seen_chain:
                raise ManifestError(
                    "manifest.claims: parent cycle through %s" % cursor["id"]
                )
            seen_chain.add(cursor["id"])
            cursor = by_id.get(cursor["parent"])
            if cursor is None:
                break


# --------------------------------------------------------------------------
# io
# --------------------------------------------------------------------------

def dumps(manifest):
    return json.dumps(manifest, ensure_ascii=False, indent=1) + "\n"


def load(path):
    """Read + validate a manifest.  Raises ManifestError on bad content."""
    with open(path, "r", encoding="utf-8") as handle:
        try:
            manifest = json.load(handle)
        except ValueError as exc:
            raise ManifestError("%s: not valid JSON (%s)" % (path, exc))
    validate(manifest)
    return manifest


def save(manifest, path):
    """Validate, then write the manifest atomically.  Returns its sha256."""
    validate(manifest)
    return atomic_write_text(path, dumps(manifest))


# --------------------------------------------------------------------------
# freshness
# --------------------------------------------------------------------------

def canvas_hash(canvas_path):
    """sha256 of the canvas file's bytes, or None when it does not exist."""
    return file_sha256(canvas_path)


def freshness_ok(manifest, canvas_path):
    """True when the canvas on disk is the one this manifest last wrote.

    A recorded hash of None means the canvas was never written by us, so there
    is nothing to clobber.  A missing file is likewise safe to write.
    """
    recorded = manifest.get("canvas_last_written_sha256")
    if recorded is None:
        return True
    current = canvas_hash(canvas_path)
    if current is None:
        return True
    return current == recorded


# --------------------------------------------------------------------------
# run log
# --------------------------------------------------------------------------

def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def record_run(manifest, surface, action, summary):
    """Append a run entry.  Returns the entry that was appended."""
    entry = {
        "ts": utc_now(),
        "surface": surface or "",
        "action": action or "",
        "summary": summary or "",
    }
    manifest.setdefault("runs", []).append(entry)
    return entry


def claims_by_id(manifest):
    return {claim["id"]: claim for claim in manifest.get("claims", [])}


def live_claims(manifest):
    """Claims that are not pruned, in manifest order."""
    return [c for c in manifest.get("claims", []) if not c.get("jt", {}).get("pruned")]


def is_overview(claim):
    return claim.get("chapter_idx") == OVERVIEW_IDX


def claim_rel(claim):
    """The claim's relationship to its parent, defaulted."""
    return claim.get("rel") or REL_DEFAULT
