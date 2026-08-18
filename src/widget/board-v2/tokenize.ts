// Projects Board v2 — tokenizer wrapper (SPEC §2, D15).
//
// v1's `tokenize()` recognizes wikilinks, md-links and bold, and deliberately
// leaves bare URLs as literal text. v2 wants bare URLs to render as real
// hyperlinks, and the live vault is full of them ("Add this as a link:
// https://www.macrotrends.net/…").
//
// This module WRAPS v1 rather than editing it: `tokenize()` runs first, then
// only its `{ text }` runs are re-split on a conservative bare-URL regex. Link /
// md-link / bold tokens pass through untouched, so a URL already inside a
// md-link href is never double-linked. The v1 board depends on `tokenize()`
// byte-for-byte — do NOT change it.

import { tokenize } from '../wikilink.js';
import type { Token } from './types.js';

// Deliberately conservative: absolute http(s) only, terminated by whitespace or
// a character that can't sit inside a URL in prose. `obsidian:`/`mailto:` are
// NOT auto-linkified — they appear in the vault only as explicit md-links,
// which v1 already handles (and sanitizes).
const BARE_URL_RE = /https?:\/\/[^\s<>"'`\]]+/g;

// Prose punctuation that a writer meant as sentence punctuation, not as part of
// the URL — "…(see https://x.com/a)." Stripped from the END only; the stripped
// characters stay in the following text run so nothing is lost.
const TRAILING_PUNCT_RE = /[).,]+$/;

// Split one plain-text run into text / bare-URL segments. The URL becomes an
// `mdlink` whose label IS the url (that is exactly how the widget renders an
// external link — no new token kind, so P2/P4 need no extra branch).
//
// Scheme sanitizing (v1's http/https/obsidian/mailto allowlist) is satisfied
// structurally here: the regex only ever matches `http://` or `https://`, so an
// unsafe scheme can never reach an href by this path.
function splitBareUrls(text: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;

  for (const match of text.matchAll(BARE_URL_RE)) {
    const start = match.index;
    const stripped = match[0].replace(TRAILING_PUNCT_RE, '');
    // A run of pure punctuation after the scheme can't happen (the regex needs
    // at least one host character), but guard rather than emit an empty href.
    if (stripped.length === 0) continue;
    if (start > cursor) tokens.push({ text: text.slice(cursor, start) });
    tokens.push({ mdlink: { label: stripped, href: stripped } });
    cursor = start + stripped.length;
  }

  if (cursor < text.length) tokens.push({ text: text.slice(cursor) });
  return tokens;
}

// Tokenize a text run for the v2 board. Same contract as v1's `tokenize()` —
// pure, lossless in content, empty input yields an empty token list — but
// returns the token array directly (v2 has no `raw` round-trip requirement;
// there is no write-back plane).
export function tokenizeV2(raw: string): Token[] {
  const tokens: Token[] = [];
  for (const token of tokenize(raw).tokens) {
    if ('text' in token) tokens.push(...splitBareUrls(token.text));
    else tokens.push(token);
  }
  return tokens;
}

// Flatten render tokens to the plain text a human reads. Drives `titleText`
// (and therefore the card key), so it must be stable: a wikilink contributes
// its alias when it has one, else its target; an md-link contributes its label;
// bold contributes its inner run.
export function flattenTokens(tokens: Token[]): string {
  let out = '';
  for (const token of tokens) {
    if ('text' in token) out += token.text;
    else if ('bold' in token) out += token.bold;
    else if ('mdlink' in token) out += token.mdlink.label;
    else out += token.link.alias ?? token.link.target;
  }
  return out;
}

// Normalize a flattened title for use in a card key (SPEC §1): trimmed,
// internal whitespace collapsed. Case-SENSITIVE by design — a case change is a
// rename, and a rename is a reset.
export function normalizeTitleText(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}
