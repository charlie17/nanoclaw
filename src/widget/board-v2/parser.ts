// Projects Board v2 — next.md → cards (SPEC §2.1, D14).
//
// Render-oriented, not lossless: one flat list of cards per project, `####`
// dropped as structure (REQ "things dropped"), children accepted on SPACE
// indentation as well as tabs, checkboxes recognized (E5).
//
// Tolerance posture: an unclassifiable column-0 line is KEPT as an `unparsed`
// card + a parse flag, never silently dropped.

import crypto from 'node:crypto';

import { stripFrontmatter } from '../parse-util.js';
import { flattenTokens, normalizeTitleText, tokenizeV2 } from './tokenize.js';
import { KEY_SEP } from './types.js';
import type { CardV2, CheckboxV2, ContentNode, BulletV2 } from './types.js';

// Column-0 top-level item: `1. text` or `- text` (SPEC §2.1 rule 1). Both
// markers require trailing whitespace, so a bare `12.` or a `---` rule falls
// through to the unparsed path rather than becoming an empty card.
const TOP_NUMBERED_RE = /^\d+\.\s+(.*)$/;
const TOP_DASH_RE = /^-\s+(.*)$/;
// Any line indented by tabs OR spaces with content on it (SPEC §2.1 rule 2).
const INDENTED_RE = /^([\t ]+)(.*)$/;
// v1's tolerant board-ignore sentinel — same regex, same semantics.
const BOARD_IGNORE_RE = /^<!--\s*board:ignore\s*-->$/i;
// Checkbox markers, ASCII only, marker + single space (E5).
const CHECKBOX_RE = /^- \[([ xX])\]\s?(.*)$/;
const CHILD_NUMBERED_RE = /^\d+\.\s*(.*)$/;

// Spans a colon may hide inside without being a title splitter (D14): a
// wikilink, a markdown link, or a bare URL. Ordered so the leftmost match wins
// the same way v1's tokenizer resolves overlaps.
const PROTECTED_SPAN_RE = /\[\[.+?\]\]|\[[^\]]*\]\([^)]*\)|https?:\/\/\S+/g;

// Fallback when a file has no space-indented child to infer from (SPEC §2.1
// rule 2).
const DEFAULT_SPACES_PER_LEVEL = 4;

// Index of the first colon that is NOT inside a link/URL, or -1. This is the
// whole of D14: "Redo wiki (TBD): See [Farzaa skill](https://…)" splits at the
// first colon, while "[Arena Leaderboard](https://arena.ai/leaderboard)" — whose
// only colon lives inside the href — never splits.
export function findSplitColon(text: string): number {
  const spans: [number, number][] = [];
  for (const match of text.matchAll(PROTECTED_SPAN_RE)) {
    spans.push([match.index, match.index + match[0].length]);
  }
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== ':') continue;
    if (spans.some(([start, end]) => i >= start && i < end)) continue;
    return i;
  }
  return -1;
}

// Indent width of one level, inferred from the FIRST space-indented line in the
// file (a file that indents with tabs never consults this).
function inferSpacesPerLevel(lines: string[]): number {
  for (const line of lines) {
    const match = /^( +)\S/.exec(line);
    if (match) return match[1].length;
  }
  return DEFAULT_SPACES_PER_LEVEL;
}

// Classify a child line with its indent already stripped.
function classifyChild(content: string): {
  bullet: BulletV2;
  checkbox: CheckboxV2;
  body: string;
} {
  const checkbox = CHECKBOX_RE.exec(content);
  if (checkbox) {
    return {
      bullet: '-',
      checkbox: checkbox[1] === ' ' ? 'unchecked' : 'checked',
      body: checkbox[2],
    };
  }
  if (content === '-') return { bullet: '-', checkbox: null, body: '' };
  if (content.startsWith('- ')) {
    return { bullet: '-', checkbox: null, body: content.slice(2) };
  }
  const numbered = CHILD_NUMBERED_RE.exec(content);
  if (numbered) return { bullet: 'num', checkbox: null, body: numbered[1] };
  return { bullet: 'other', checkbox: null, body: content };
}

// sha256/12 over the card's raw content source (SPEC §1). R1 hashes the
// verbatim child lines (indent + marker included, so an indent-only edit still
// registers); R2 hashes the raw post-colon text; R3 hashes the empty string,
// giving every card a well-formed hash the widget can compare unconditionally.
function contentHashOf(source: string): string {
  return crypto
    .createHash('sha256')
    .update(source, 'utf8')
    .digest('hex')
    .slice(0, 12);
}

// A top-level item as collected in pass 1, before R1/R2/R3 classification.
interface RawItem {
  text: string;
  childLines: string[];
  nodes: ContentNode[];
  unparsed?: true;
}

// Parse one next.md into cards. `folder` is the project folder (used to build
// keys); `fileLabel` prefixes parse flags so a flag points at a real file+line.
// Parse flags are appended to the caller's shared array, v1-style.
export function parseNextV2(
  text: string,
  folder: string,
  fileLabel: string,
  parseFlags: string[],
): CardV2[] {
  const { body, offset } = stripFrontmatter(text);
  // Vera SF6: strip a CRLF carriage return per line. Every regex below anchors
  // on `$` or exact content, so a stray `\r` would turn an entire CRLF-authored
  // file into unparsed cards. Normalizing here also makes `contentHash` stable
  // across a line-ending change.
  const allLines = body.split('\n').map((line) => line.replace(/\r$/, ''));

  // Everything from a `<!-- board:ignore -->` line to EOF is invisible to the
  // board — including for indent inference, so a trailing scratch section can't
  // skew it.
  const stopAt = allLines.findIndex((line) =>
    BOARD_IGNORE_RE.test(line.trim()),
  );
  const lines = stopAt === -1 ? allLines : allLines.slice(0, stopAt);

  const spacesPerLevel = inferSpacesPerLevel(lines);
  const flag = (i: number, reason: string): void => {
    parseFlags.push(`${fileLabel}: line ${offset + i + 1} — ${reason}`);
  };

  const items: RawItem[] = [];
  // Index into `items` of the card currently accepting children; -1 = none.
  let open = -1;
  // nodeStack[d - 1] = most recent node at depth d, for nesting (v1 pattern).
  let nodeStack: ContentNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;

    // `####` (and every other column-0 `#` line) is NOT structure in v2 — v1's
    // group semantics are dropped. Skip it loudly so a file that still uses
    // headers explains its missing content instead of silently losing it. The
    // open card closes here: children after a header don't belong to the card
    // before it.
    if (line.startsWith('#')) {
      flag(i, 'header line skipped (v2 has no groups)');
      open = -1;
      nodeStack = [];
      continue;
    }

    const top = TOP_NUMBERED_RE.exec(line) ?? TOP_DASH_RE.exec(line);
    if (top) {
      open = items.push({ text: top[1], childLines: [], nodes: [] }) - 1;
      nodeStack = [];
      continue;
    }

    const indented = INDENTED_RE.exec(line);
    if (indented && indented[2].trim() !== '') {
      if (open === -1) {
        // Indented line before any top-level item — keep it as its own card and
        // let the rest of the orphan block nest under it rather than emitting a
        // card (and a flag) per line.
        flag(i, 'indented line before any top-level item — kept as a card');
        open =
          items.push({
            text: line.trim(),
            childLines: [],
            nodes: [],
            unparsed: true,
          }) - 1;
        nodeStack = [];
        continue;
      }

      const indent = indented[1];
      const tabs = (indent.match(/\t/g) ?? []).length;
      const spaces = indent.length - tabs;
      let depth: number;
      if (tabs > 0) {
        // Mixed indentation on one line: tabs win, and we say so.
        if (spaces > 0) flag(i, 'mixed tab+space indent — tab count wins');
        depth = tabs;
      } else {
        depth = Math.max(1, Math.floor(spaces / spacesPerLevel));
      }

      const item = items[open];
      const { bullet, checkbox, body: nodeBody } = classifyChild(indented[2]);
      const node: ContentNode = {
        tokens: tokenizeV2(nodeBody),
        bullet,
        checkbox,
        depth,
        children: [],
      };
      const parent = depth >= 2 ? nodeStack[depth - 2] : undefined;
      if (parent) {
        parent.children.push(node);
      } else {
        // depth >= 2 with no parent = indentation jumped a level; attach to the
        // card root, flagged.
        if (depth >= 2) {
          flag(i, 'indent jumped a level — attached to the card root');
        }
        item.nodes.push(node);
      }
      nodeStack = nodeStack.slice(0, depth - 1);
      nodeStack[depth - 1] = node;
      item.childLines.push(line);
      continue;
    }

    // Any other column-0 line (prose, an `##` header the file uses for its own
    // structure, a stray marker). Kept as an unparsed card + flagged; following
    // indented lines attach to it so nothing downstream is lost either.
    flag(i, 'unrecognized line — kept as an unparsed card');
    open =
      items.push({ text: line, childLines: [], nodes: [], unparsed: true }) - 1;
    nodeStack = [];
  }

  return toCards(items, folder, fileLabel, parseFlags);
}

// Pass 2 — apply R1/R2/R3 (SPEC §2.1 rules 3–5) and mint keys.
function toCards(
  items: RawItem[],
  folder: string,
  fileLabel: string,
  parseFlags: string[],
): CardV2[] {
  const cards: CardV2[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    let titleRaw = item.text;
    let content: ContentNode[] = [];
    let hashSource = '';

    if (item.nodes.length > 0) {
      // R1 — children win; colons in the title are irrelevant.
      content = item.nodes;
      hashSource = item.childLines.join('\n');
    } else if (!item.unparsed) {
      const colon = findSplitColon(item.text);
      const remainder = colon === -1 ? '' : item.text.slice(colon + 1).trim();
      if (colon !== -1 && remainder !== '') {
        // R2 — split at the FIRST splitting colon; everything after it (later
        // colons included) becomes the single content line.
        titleRaw = item.text.slice(0, colon);
        content = [
          {
            tokens: tokenizeV2(remainder),
            bullet: 'other',
            checkbox: null,
            depth: 1,
            children: [],
          },
        ];
        hashSource = remainder;
      }
      // else R3 — full text is the title, no content, hash over ''.
    }

    const title = tokenizeV2(titleRaw.trim());
    const titleText = normalizeTitleText(flattenTokens(title));
    const key = `${folder}${KEY_SEP}${titleText}`;
    if (seen.has(key)) {
      // Two cards with the same title in one project would share one overlay
      // slot. Keep both (never drop) and make the collision visible.
      parseFlags.push(
        `${fileLabel}: duplicate card title "${titleText}" — both kept, they share one board slot`,
      );
    }
    seen.add(key);

    const card: CardV2 = {
      key,
      title,
      titleText,
      content,
      contentHash: contentHashOf(hashSource),
    };
    if (item.unparsed) card.unparsed = true;
    cards.push(card);
  }

  return cards;
}
