"""match — put one of JT's Reader highlights onto the right claim card.

Three independent steps, each of which refuses rather than guesses:

  ``normalize``          one canonical text form for both sides of a compare
  ``locate_highlight``   highlight text -> the block indices it covers
  ``match_to_claim``     block indices -> the claim that owns them, or None
  ``parse_stance``       JT's ✅/❌/💡 shorthand -> (stance, remaining note)

Doctrine: an unmatched highlight lands in the bin, which is cheap and visible.
A *mis*-matched highlight silently attaches JT's thinking to the wrong claim,
which is expensive and invisible.  Every ambiguity therefore resolves to None.

Ranges: a claim's ``block_range`` is [first, last] INCLUSIVE — the blocks the
claim was written from.  (Chapter ranges are half-open; see slice.py.)

python3 stdlib only.
"""

import re
import unicodedata
from html import unescape

import manifest as manifest_mod
import slice as slicer

# --------------------------------------------------------------------------
# normalization
# --------------------------------------------------------------------------

_TAG_RE = re.compile(r"<[^>]*>")
_HAS_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")

#: Curly quotes, primes, guillemets and the whole dash family collapse to their
#: ASCII form.  Reader round-trips a highlight through the browser's selection
#: API, which is free to hand back a different quote character than the source
#: html carries, so an un-canonicalised compare loses real matches.
_CHAR_MAP = {
    "\u2018": "'", "\u2019": "'", "\u201a": "'", "\u201b": "'", "\u2032": "'",
    "\u201c": '"', "\u201d": '"', "\u201e": '"', "\u201f": '"',
    "\u00ab": '"', "\u00bb": '"',
    "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-",
    "\u2014": "-", "\u2015": "-", "\u2212": "-",
}
_TRANSLATION = str.maketrans(_CHAR_MAP)

#: Below this a highlight is too short to place with any confidence.
MIN_HIGHLIGHT_CHARS = 12
#: How many consecutive blocks one highlight may span.
MAX_SPAN_BLOCKS = 4
#: A sentence has to be this long before it is evidence of anything.
MIN_SENTENCE_CHARS = 24
#: ...and it has to account for most of the highlight before it may stand in
#: for the whole thing.  Without this, a selection running across ten blocks
#: would be pinned to whichever single block happened to contain one of its
#: sentences — a confident answer to a question we cannot actually answer.
MIN_SENTENCE_COVERAGE = 0.5

_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")


def normalize(text):
    """One canonical comparison form: tags out, entities in, punctuation ASCII.

    Order matters and mirrors ``slice.block_text``: tags are stripped BEFORE
    unescaping, so an escaped ``&lt;p&gt;`` in the prose is never mistaken for
    markup.  Case is preserved — it is signal, not noise.
    """
    if text is None:
        return ""
    value = str(text)
    if _HAS_TAG_RE.search(value):
        value = _TAG_RE.sub(" ", value)
    value = unescape(value)
    value = unicodedata.normalize("NFKC", value)
    value = value.translate(_TRANSLATION)
    return _WS_RE.sub(" ", value).strip()


def block_norm(html, block):
    """Normalized plain text of one slice block."""
    return normalize(slicer.block_text(html, block))


def normalized_blocks(html, blocks):
    """Normalized text for every block, positionally aligned with *blocks*."""
    return [block_norm(html, block) for block in blocks]


# --------------------------------------------------------------------------
# locating a highlight in the source
# --------------------------------------------------------------------------

def _spans_covering(texts, needle):
    """Every minimal run of 2..MAX_SPAN_BLOCKS blocks that contains *needle*.

    A run counts only when the highlight genuinely reaches into the first and
    the last block of the run — otherwise a longer run would "match" merely by
    padding a shorter one with an untouched neighbour.
    """
    found = []
    total = len(texts)
    for start in range(total):
        if not texts[start]:
            continue
        for length in range(2, MAX_SPAN_BLOCKS + 1):
            stop = start + length
            if stop > total:
                break
            window = texts[start:stop]
            if not all(window):
                break
            joined = " ".join(window)
            position = joined.find(needle)
            if position == -1:
                continue
            end = position + len(needle)
            first_end = len(window[0])
            last_start = len(joined) - len(window[-1])
            if position < first_end and end > last_start:
                found.append(list(range(start, stop)))
            # Shortest run wins for this start; a longer one is padding.
            break
    return found


def _sentence_candidates(needle):
    sentences = [s.strip() for s in _SENTENCE_SPLIT_RE.split(needle)]
    sentences = [s for s in sentences if len(s) >= MIN_SENTENCE_CHARS]
    sentences.sort(key=len, reverse=True)
    return sentences


def locate_highlight(html, blocks, highlight_text, texts=None):
    """Block indices covered by *highlight_text*, or [] when unsure.

    Passes, in order of confidence:

    1. one block whose text contains the whole highlight;
    2. a run of up to ``MAX_SPAN_BLOCKS`` consecutive blocks the highlight
       runs across (its head in the first block's tail, its tail in the last
       block's head);
    3. the highlight's longest sentence found in exactly one block — the
       sentence-level overlap that survives a Reader selection which clipped
       or extended a word at either end.

    Any pass that finds more than one candidate returns [] instead: a repeated
    boilerplate paragraph is exactly the case where a guess does damage.
    """
    needle = normalize(highlight_text)
    if len(needle) < MIN_HIGHLIGHT_CHARS:
        return []
    if texts is None:
        texts = normalized_blocks(html, blocks)

    contained = [i for i, text in enumerate(texts) if text and needle in text]
    if len(contained) == 1:
        return contained
    if len(contained) > 1:
        return []

    spans = _spans_covering(texts, needle)
    unique = []
    for span in spans:
        if span not in unique:
            unique.append(span)
    if len(unique) == 1:
        return unique[0]
    if len(unique) > 1:
        return []

    for sentence in _sentence_candidates(needle):
        if len(sentence) < MIN_SENTENCE_COVERAGE * len(needle):
            break            # candidates are longest-first; none will qualify
        hits = [i for i, text in enumerate(texts) if text and sentence in text]
        if len(hits) == 1:
            return hits
        if len(hits) > 1:
            return []
    return []


# --------------------------------------------------------------------------
# matching blocks to a claim
# --------------------------------------------------------------------------

def _claim_depth(claim, by_id):
    depth = 0
    cursor = claim
    seen = set()
    while cursor is not None and cursor.get("parent") != "root":
        if cursor["id"] in seen:
            break
        seen.add(cursor["id"])
        cursor = by_id.get(cursor["parent"])
        depth += 1
    return depth


def _range_contains(outer, inner):
    return outer[0] <= inner[0] and inner[1] <= outer[1]


def match_to_claim(manifest, block_indices):
    """The claim whose block_range holds ALL of *block_indices*, else None.

    Blocks straddling two claims, or landing in none, return None — the caller
    puts those in the unmatched bin.  Where claim ranges nest, the deepest and
    tightest claim wins: that is the most specific thing JT could have meant.
    """
    if not block_indices:
        return None
    lowest = min(block_indices)
    highest = max(block_indices)

    claims = manifest_mod.live_claims(manifest)
    by_id = manifest_mod.claims_by_id(manifest)
    candidates = []
    for claim in claims:
        block_range = claim.get("block_range")
        if not block_range or len(block_range) != 2:
            continue
        start, end = block_range[0], block_range[1]
        if start <= lowest and highest <= end:
            candidates.append((claim, (start, end)))
    if not candidates:
        return None
    if len(candidates) == 1:
        return candidates[0][0]["id"]

    candidates.sort(
        key=lambda item: (
            item[1][1] - item[1][0],
            -_claim_depth(item[0], by_id),
            item[0]["id"],
        )
    )
    tightest, tightest_range = candidates[0]
    for _claim, other_range in candidates[1:]:
        if not _range_contains(other_range, tightest_range):
            # Overlapping-but-not-nested ranges: genuinely ambiguous.
            return None
    return tightest["id"]


# --------------------------------------------------------------------------
# stance shorthand
# --------------------------------------------------------------------------

STANCE_GLYPHS = {
    "✅": "agree",
    "❌": "dispute",
    "\U0001f4a1": "surface",
}

_STANCE_WORD_RE = re.compile(r"^(agree|dispute|surface)\b\s*:?\s*", re.IGNORECASE)
_LEAD_PUNCT_RE = re.compile(r"^[\s:\-\u2013\u2014]+")
_VARIATION_RE = re.compile(r"^[\ufe00-\ufe0f]+")


def parse_stance(note):
    """Split JT's stance shorthand off the front of a highlight note.

    Recognised: a leading ✅ / ❌ / 💡, or a leading word ``agree`` /
    ``dispute`` / ``surface`` (any case, optional colon).  Anything else is
    just a note — stance is NEVER inferred from prose, so ("I disagree with
    this") stays stanceless on purpose.

    Returns ``(stance | None, remainder)``.  With no stance the note comes back
    exactly as it went in.
    """
    if note is None:
        return None, ""
    text = str(note)
    head = text.lstrip()
    if not head:
        return None, text

    stance = None
    remainder = None

    for glyph, name in STANCE_GLYPHS.items():
        if head.startswith(glyph):
            stance = name
            remainder = _VARIATION_RE.sub("", head[len(glyph):])
            remainder = _LEAD_PUNCT_RE.sub("", remainder)
            # "✅ agree — ..." says the same thing twice; keep it once.
            repeat = _STANCE_WORD_RE.match(remainder)
            if repeat and repeat.group(1).lower() == name:
                remainder = remainder[repeat.end():]
            break

    if stance is None:
        word = _STANCE_WORD_RE.match(head)
        if word is None:
            return None, text
        stance = word.group(1).lower()
        remainder = head[word.end():]

    return stance, _LEAD_PUNCT_RE.sub("", remainder).strip()
