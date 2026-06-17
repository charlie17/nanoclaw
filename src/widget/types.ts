// Impl-73 Step 4a — Projects Board data plane.
// The snapshot schema (ARCHITECT-BRIEF "Step 4a — Data plane"), evolved by the
// FU-2 read-only pivot. 4c (write-back) is dead, so this is now a 4a→4b contract
// only; the FU-2 changes (Entry.folder, mdlink/bold tokens) are Archie-signed-off
// (ARCHITECT-BRIEF FU-2 Phase 1). Still: no field change without an Archie sign-off.

// A parsed wikilink target. `target` is the basename (last path segment);
// `path` carries the full slash path when present so 4b can deep-link either
// the basename (Obsidian name-resolution) or the explicit path. — decision 12.
export interface LinkTarget {
  target: string;
  alias?: string;
  heading?: string;
  path?: string;
}

// A run of plain text, a wikilink, an external markdown link, or a bold run.
// Recognition order in a text run is wikilink → md-link → bold (FU-2 #8); code
// spans and bare URLs are still NOT tokenized — they stay literal text runs.
// `mdlink.href` is sanitized server-side (http/https/obsidian/mailto + relative
// only; unsafe schemes fall back to literal text). `bold` carries the inner run
// verbatim (no nested links inside bold in v1). Pure data → 4b renders escaped
// <strong>/<a> nodes; never raw HTML.
export type Token =
  | { text: string }
  | { link: LinkTarget }
  | { mdlink: { label: string; href: string } }
  | { bold: string };

// Every loaded text field carries BOTH the verbatim source line (`raw` — for
// 4b edit reconstruction + 4c lossless write-back) and tokenized render
// segments (`tokens` — the marker-stripped content split into text/link runs).
export interface TextField {
  raw: string;
  tokens: Token[];
}

export type BulletStyle = '-' | 'num' | 'other';

// A child line under an activity. `depth` = indent level (1 = direct child);
// `bullet` = how to re-render the marker. `text.raw` is the full verbatim line
// (indent + marker included) so 4c round-trips it exactly.
export interface BoardNode {
  text: TextField;
  bullet: BulletStyle;
  depth: number;
  children: BoardNode[];
  unparsed?: true;
}

// A top-level numbered item in a next-file. Identified positionally within its
// group's `activities[]`; the literal number lives in `text.raw`.
export interface Activity {
  text: TextField;
  children: BoardNode[];
  unparsed?: true;
}

// A `####`-delimited section of a next-file. `header` is null for the
// ungrouped top section (activities before the first `####`, or a file with no
// `####` at all). — decision 13.
export interface NextGroup {
  header: TextField | null;
  activities: Activity[];
}

export interface NextContent {
  groups: NextGroup[];
}

// 4a Log = deterministic raw stub: the last-5 lines of log.md, un-synthesized.
// The LLM blend (coding-recap, `*` markers, missing-repo flag) is 4b. — D-4a.6.
export interface LogStub {
  synthesized: false;
  entries: string[];
}

export type EntryKind = 'full' | 'lightweight' | 'pointer';

// One project in priorities.md. `resolved` is true only for `full` (its folder
// maps to a live project folder); `lightweight` (ranked/display-only) and
// `pointer` (→ note:) are both resolved:false and carry next/log = null.
//
// FU-2 #5: `folder` and `slug` are now SPLIT. `folder` = the resolved on-disk
// folder name (drives next/log file resolution); it is shared by two entries
// pointing at one folder (Ledger Coding + Business), and null for non-`full`
// entries. `slug` = a UNIQUE per-entry board identity (slugify of the displayed
// label, deduped across the parsed set) — the widget keys everything by it, so
// two same-folder entries no longer collide.
export interface Entry {
  label: TextField;
  slug: string;
  folder: string | null;
  resolved: boolean;
  kind: EntryKind;
  nextFile: string | null;
  notePath: string | null;
  flags: string[];
  next: NextContent | null;
  log: LogStub | null;
}

export interface BoardSnapshot {
  version: 1;
  widgetId: 'projects-board';
  lastRefreshed: string;
  priorities: {
    active: Entry[];
    inactive: Entry[];
  };
  parseFlags: string[];
}
