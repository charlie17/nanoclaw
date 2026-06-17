// Impl-73 Step 4a — Obsidian wikilink tokenizer (decision 12, D-4a.5).
// Pure: `raw` content → { raw, tokens }. Splits a text run into plain-text
// segments interleaved with link segments, so 4b can render `[[…]]` as escaped
// <a> deep-links without shipping a parser or injecting raw HTML.
//
// Handles every live flavor: [[t]], [[t|alias]], [[t#heading]], [[path/t]],
// [[!leading-punct]], [[Two Words]] (spaces). It does NOT touch markdown links
// `[x](y)`, code spans, or bare URLs — none contain `[[`, so they fall through
// as literal `{ text }` runs untouched.

import type { LinkTarget, TextField, Token } from './types.js';

// Non-greedy to the first `]]` so a later markdown-link `]` is never consumed.
const WIKILINK_RE = /\[\[(.+?)\]\]/g;

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
// empty `- ` bullet renders nothing); a run with no `[[…]]` yields a single
// text token.
export function tokenize(raw: string): TextField {
  const tokens: Token[] = [];
  let lastIndex = 0;

  for (const match of raw.matchAll(WIKILINK_RE)) {
    const start = match.index;
    if (start > lastIndex) {
      tokens.push({ text: raw.slice(lastIndex, start) });
    }
    tokens.push({ link: parseWikilinkBody(match[1]) });
    lastIndex = start + match[0].length;
  }

  if (lastIndex < raw.length) {
    tokens.push({ text: raw.slice(lastIndex) });
  }

  return { raw, tokens };
}
