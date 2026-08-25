// Shared widget text/link types.
// The tokenizer contract (`wikilink.ts` → `Token`/`LinkTarget`) plus the
// `TextField` pair (verbatim `raw` + rendered `tokens`) consumed by the
// Projects Board v2 parser. Board-v2's own snapshot/overlay schema lives in
// `board-v2/types.ts`; this file holds only what is shared.

// A parsed wikilink target. `target` is the basename (last path segment);
// `path` carries the full slash path when present so the renderer can deep-link
// either the basename (Obsidian name-resolution) or the explicit path.
export interface LinkTarget {
  target: string;
  alias?: string;
  heading?: string;
  path?: string;
}

// A run of plain text, a wikilink, an external markdown link, or a bold run.
// Recognition order in a text run is wikilink → md-link → bold; code spans and
// bare URLs are NOT tokenized — they stay literal text runs. `mdlink.href` is
// sanitized server-side (http/https/obsidian/mailto + relative only; unsafe
// schemes fall back to literal text). `bold` carries the inner run verbatim (no
// nested links inside bold). Pure data → the renderer emits escaped
// <strong>/<a> nodes; never raw HTML.
export type Token =
  | { text: string }
  | { link: LinkTarget }
  | { mdlink: { label: string; href: string } }
  | { bold: string };

// Every loaded text field carries BOTH the verbatim source line (`raw`) and
// tokenized render segments (`tokens` — the marker-stripped content split into
// text/link runs).
export interface TextField {
  raw: string;
  tokens: Token[];
}
