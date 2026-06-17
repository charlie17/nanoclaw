// Impl-73 Step 4a — next-file parser (D-4a.4). Tolerant + LOSSLESS.
//
// A next-file is: optional `####` group headers; top-level numbered activities
// (`1.` `2.` …, column 0); each activity's tab-indented sub-tree of children
// (`-` bullets, nested-numbered, 3-deep all occur). Every node keeps its full
// verbatim source line in `text.raw` so 4c round-trips it exactly. Any line we
// cannot classify is kept as an `unparsed` node + a parse flag — never dropped.
//
// Group boundaries key ONLY on `####` (decision 13): a `#`, `##`, or `###` the
// file uses for other structure is NOT a boundary — it falls through as an
// unparsed top-level item.

import { stripFrontmatter, textField } from './parse-util.js';
import { tokenize } from './wikilink.js';
import type {
  Activity,
  BoardNode,
  BulletStyle,
  NextContent,
  NextGroup,
} from './types.js';

// Classify a child line (after its leading tabs are stripped) into a bullet
// style + the marker-stripped body used for render tokens.
function classifyChild(content: string): { bullet: BulletStyle; body: string } {
  if (content === '-') return { bullet: '-', body: '' };
  if (content.startsWith('- ')) return { bullet: '-', body: content.slice(2) };
  const numbered = /^\d+\.\s*(.*)$/.exec(content);
  if (numbered) return { bullet: 'num', body: numbered[1] };
  return { bullet: 'other', body: content };
}

export function parseNext(
  text: string,
  fileLabel: string,
  parseFlags: string[],
): NextContent {
  const { body, offset } = stripFrontmatter(text);
  const lines = body.split('\n');

  const groups: NextGroup[] = [];
  let group: NextGroup | null = null;
  let activity: Activity | null = null;
  // nodeStack[d - 1] = the most recent node at depth d, for nesting.
  let nodeStack: BoardNode[] = [];

  const openGroup = (header: NextGroup['header']): NextGroup => {
    const g: NextGroup = { header, activities: [] };
    groups.push(g);
    group = g;
    activity = null;
    nodeStack = [];
    return g;
  };
  const ensureGroup = (): NextGroup => group ?? openGroup(null);
  const flag = (i: number): void => {
    parseFlags.push(`${fileLabel}: couldn't parse line ${offset + i + 1}`);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;

    // `####` group header — exactly four hashes (decision 13).
    const groupHeader = /^#### +(.*)$/.exec(line);
    if (groupHeader) {
      openGroup(textField(line, groupHeader[1]));
      continue;
    }

    // Top-level numbered activity (column 0 — no leading whitespace).
    const activityMatch = /^(\d+)\.\s*(.*)$/.exec(line);
    if (activityMatch) {
      const g = ensureGroup();
      activity = { text: textField(line, activityMatch[2]), children: [] };
      g.activities.push(activity);
      nodeStack = [];
      continue;
    }

    // Indented child line — depth = leading tab count.
    const indent = /^(\t*)(.*)$/.exec(line) as RegExpExecArray;
    const depth = indent[1].length;
    const rest = indent[2];

    if (depth >= 1) {
      if (!activity) {
        // Orphan indented line before any activity — keep it, flagged.
        const g = ensureGroup();
        flag(i);
        g.activities.push({
          text: textField(line, rest),
          children: [],
          unparsed: true,
        });
        continue;
      }
      const { bullet, body: nodeBody } = classifyChild(rest);
      const node: BoardNode = {
        text: textField(line, nodeBody),
        bullet,
        depth,
        children: [],
      };
      const parent = depth >= 2 ? nodeStack[depth - 2] : undefined;
      if (depth >= 2 && !parent) {
        // Indentation jumped past its parent — attach to the activity, flagged.
        flag(i);
        node.unparsed = true;
        activity.children.push(node);
      } else if (parent) {
        parent.children.push(node);
      } else {
        activity.children.push(node);
      }
      nodeStack = nodeStack.slice(0, depth - 1);
      nodeStack[depth - 1] = node;
      continue;
    }

    // Column-0 line that is neither `####` nor a numbered activity (e.g. an
    // `##` header, a prose line, or a flat `-` bullet the file uses for other
    // structure). Tolerant: keep as an unparsed top-level item + flag.
    const g = ensureGroup();
    flag(i);
    g.activities.push({
      text: { raw: line, tokens: tokenize(line).tokens },
      children: [],
      unparsed: true,
    });
  }

  return { groups };
}
