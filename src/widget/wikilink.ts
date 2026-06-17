// Impl-73 Step 4a + FU-2 — inline-markup tokenizer (decisions 12 + FU-2 #8).
// Pure: `raw` content → { raw, tokens }. Splits a text run into plain-text
// segments interleaved with link / md-link / bold segments, so 4b can render
// them as escaped <a>/<strong> nodes without shipping a parser or injecting raw
// HTML.
//
// Recognition order at a given position (FU-2 #8): wikilink → md-link → bold,
// with the leftmost match overall winning. Beyond these three, NOTHING is
// tokenized — code spans, bare URLs, and other markdown fall through as literal
// `{ text }` runs. Lossless: `raw` is always preserved verbatim.
//
// Wikilink flavors: [[t]], [[t|alias]], [[t#heading]], [[path/t]],
// [[!leading-punct]], [[Two Words]].
//
// SECURITY (FU-2 #8): a markdown link's href is sanitized HERE — only http(s),
// obsidian, mailto, or scheme-less (relative/anchor) hrefs become `{ mdlink }`;
// a `javascript:` / `data:` / other dangerous scheme falls back to a literal
// `{ text }` run (the link is never emitted as an <a>). The widget re-sanitizes
// client-side as belt-and-suspenders.

import type { LinkTarget, TextField, Token } from './types.js';

// One pass, three alternatives. Group 1 = wikilink body; groups 2/3 = md-link
// label/href; group 4 = bold inner run. JS regex takes the leftmost match and,
// at a tie, the first alternative listed → exactly the #8 precedence. Wikilink
// is non-greedy to the first `]]` so a later `]` is never consumed; bold is
// non-greedy across the run (`[\s\S]` so a bold run may span an escaped break).
const TOKEN_RE = /\[\[(.+?)\]\]|\[([^\]]*)\]\(([^)]*)\)|\*\*([\s\S]+?)\*\*/g;

// Schemes safe to emit as a live external/deep link. Scheme-less hrefs
// (relative paths, `#anchor`, `//host`) cannot carry an executable scheme, so
// they are allowed too. Everything else (javascript:, data:, vbscript:, file:…)
// is rejected → the md-link stays literal text.
const SAFE_SCHEMES = new Set(['http', 'https', 'obsidian', 'mailto']);

function sanitizeHref(href: string): string | null {
  const trimmed = href.trim();
  // Strip ASCII control chars + whitespace (U+0000–U+0020) before scheme test.
  // Browsers strip these before evaluating the scheme, so "java\tscript:" would
  // execute as "javascript:" even though the regex below wouldn't match it.
  // Filter via codePoint to avoid no-control-regex ESLint violations.
  const cleaned = Array.from(trimmed)
    .filter((c) => (c.codePointAt(0) ?? 0) > 0x20)
    .join('');
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned);
  if (scheme && !SAFE_SCHEMES.has(scheme[1].toLowerCase())) return null;
  return cleaned;
}

// Parse the inside of `[[ … ]]`. Obsidian order is target#heading|alias.
function parseWikilinkBody(body: string): LinkTarget {
  let rest = body;

  let alias: string | undefined;
  const pipe = rest.indexOf('|');
  if (pipe !== -1) {
    alias = rest.slice(pipe + 1);
    rest = rest.slice(0, pipe);
  }

  let heading: string | undefined;
  const hash = rest.indexOf('#');
  if (hash !== -1) {
    heading = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
  }

  let pathField: string | undefined;
  let target = rest;
  const slash = rest.lastIndexOf('/');
  if (slash !== -1) {
    pathField = rest;
    target = rest.slice(slash + 1);
  }

  const link: LinkTarget = { target };
  if (alias !== undefined) link.alias = alias;
  if (heading !== undefined) link.heading = heading;
  if (pathField !== undefined) link.path = pathField;
  return link;
}

// Tokenize a text run. An empty string yields an empty token list (e.g. an
// empty `- ` bullet renders nothing); a run with no markup yields a single
// text token.
export function tokenize(raw: string): TextField {
  const tokens: Token[] = [];
  let textStart = 0;
  const pushText = (end: number): void => {
    if (end > textStart) tokens.push({ text: raw.slice(textStart, end) });
  };

  for (const match of raw.matchAll(TOKEN_RE)) {
    const start = match.index;
    pushText(start);

    if (match[1] !== undefined) {
      // Wikilink.
      tokens.push({ link: parseWikilinkBody(match[1]) });
    } else if (match[2] !== undefined) {
      // Markdown link — emit only if its href is safe, else keep literal.
      const href = sanitizeHref(match[3]);
      if (href === null) {
        tokens.push({ text: match[0] });
      } else {
        tokens.push({ mdlink: { label: match[2], href } });
      }
    } else {
      // Bold run (match[4]).
      tokens.push({ bold: match[4] });
    }

    textStart = start + match[0].length;
  }

  pushText(raw.length);
  return { raw, tokens };
}
