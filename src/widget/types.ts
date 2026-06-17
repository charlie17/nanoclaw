// Impl-73 Step 4a — Projects Board data plane.
// The frozen D-4a.7 snapshot schema (ARCHITECT-BRIEF "Step 4a — Data plane").
// 4b (render) and 4c (write-back) both consume these shapes — treat as a
// cross-sub-step contract; do not change a field without an Archie sign-off.

// A parsed wikilink target. `target` is the basename (last path segment);
// `path` carries the full slash path when present so 4b can deep-link either
// the basename (Obsidian name-resolution) or the explicit path. — decision 12.
export interface LinkTarget {
  target: string;
  alias?: string;
  heading?: string;
  path?: string;
}

// A run of plain text, OR a wikilink segment. Markdown links `[x](y)`, code
// spans, and bare URLs are NOT links here — they stay as literal text runs
// (v1 deep-links wikilinks only). Pure data → 4b renders escaped <a> nodes.
export type Token = { text: string } | { link: LinkTarget };

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

// One project in priorities.md. `resolved` is true only for `full` (slug maps
// to a live folder); `lightweight` (ranked/display-only) and `pointer`
// (→ note:) are both resolved:false and carry next/log = null.
export interface Entry {
  label: TextField;
  slug: string;
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
