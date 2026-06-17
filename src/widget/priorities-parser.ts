// Impl-73 Step 4a + FU-2 — priorities.md parser (D-4a.3). priorities.md IS the
// project registry: `- Active` / `- Inactive` sections of numbered entries. Each
// entry resolves to a project folder (default folder name, or a
// `→ \`folder / next-file\`` override), points elsewhere (`→ note: <path>`), or
// is lightweight (ranked/display-only) when its label carries links/URLs/
// descriptive prose or its name matches no live folder. Lightweight entries are
// NEVER folder-guessed.
//
// FU-2 #5 — `folder` (resolution key) and `slug` (unique board identity) are
// SPLIT: two entries sharing one folder (Ledger Coding + Business) get the same
// `folder` but distinct `slug`s, so the widget no longer collapses them.
// FU-2 #6 — a lightweight label is TRUNCATED for display at the first colon or
// space-surrounded dash; the full original survives in `label.raw`.

import { stripFrontmatter, textField } from './parse-util.js';
import type { Entry, EntryKind } from './types.js';

// A label is "display-only" when it embeds a markdown link, a URL, or reads as
// descriptive prose (a "label: detail" colon phrase) rather than a project name.
const MD_LINK_RE = /\[[^\]]*\]\([^)]*\)/;
const URL_RE = /https?:\/\//;

function slugify(label: string): string {
  const s = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'item';
}

// FU-2 #6: truncate a lightweight label at the first `:` (no surrounding space
// needed) or the first space-surrounded dash (` - ` / ` — `), dropping the rest.
// The dash MUST be space-surrounded so a hyphenated name (`sequence-of-returns`)
// is never chopped. Only the DISPLAYED text is truncated — `label.raw` keeps the
// full original line (lossless).
function truncateLightweightLabel(text: string): string {
  let cut = text.length;
  const colon = text.indexOf(':');
  if (colon !== -1) cut = Math.min(cut, colon);
  const dash = text.search(/ [-—] /);
  if (dash !== -1) cut = Math.min(cut, dash);
  return text.slice(0, cut).trim();
}

export interface PrioritiesResult {
  active: Entry[];
  inactive: Entry[];
  parseFlags: string[];
}

// Build an entry with a BASE slug; parsePriorities dedupes slugs across the set.
function buildEntry(rawBody: string, folderSet: Set<string>): Entry {
  const flags: string[] = [];

  const arrowIdx = rawBody.indexOf('→');
  const labelText =
    arrowIdx === -1 ? rawBody.trim() : rawBody.slice(0, arrowIdx).trim();
  const overrideSpec =
    arrowIdx === -1 ? null : rawBody.slice(arrowIdx + '→'.length).trim();

  // Resolve kind + folder + file targets first; build the label/slug after, so
  // truncation (#6) keys on the resolved kind.
  let kind: EntryKind;
  let resolved: boolean;
  let folder: string | null = null;
  let nextFile: string | null = null;
  let notePath: string | null = null;

  if (overrideSpec !== null) {
    const noteMatch = /^note:\s*(.*)$/i.exec(overrideSpec);
    if (noteMatch) {
      // `→ note: <path>` pointer — a read-only briefing, not a workable folder.
      kind = 'pointer';
      resolved = false;
      notePath = noteMatch[1].trim();
    } else {
      // `→ \`folder / next-file\`` override (strip backticks + surrounding space).
      const spec = overrideSpec.replace(/`/g, '').trim();
      const slashIdx = spec.indexOf('/');
      const overrideFolder = (
        slashIdx === -1 ? spec : spec.slice(0, slashIdx)
      ).trim();
      const nextName =
        slashIdx === -1 ? 'next.md' : spec.slice(slashIdx + 1).trim();
      resolved = folderSet.has(overrideFolder);
      if (resolved) {
        kind = 'full';
        folder = overrideFolder;
        nextFile = `general/projects/${overrideFolder}/${nextName}`;
      } else {
        kind = 'lightweight';
        flags.push(`override folder "${overrideFolder}" not found`);
      }
    }
  } else if (
    MD_LINK_RE.test(labelText) ||
    URL_RE.test(labelText) ||
    /:\s/.test(labelText)
  ) {
    // No override — content-lightweight first.
    kind = 'lightweight';
    resolved = false;
    flags.push('display-only (embedded link/URL or descriptive prose)');
  } else if (folderSet.has(slugify(labelText))) {
    // Bare label whose slug names a live folder → full. folder == slug here.
    kind = 'full';
    resolved = true;
    folder = slugify(labelText);
    nextFile = `general/projects/${folder}/next.md`;
  } else {
    kind = 'lightweight';
    resolved = false;
    flags.push('no matching project folder (ranked/display-only)');
  }

  // Displayed label (#6: truncate lightweight only) + base slug (#5). `raw`
  // keeps the full original; `tokens` carry only the kept prefix.
  const displayText =
    kind === 'lightweight' ? truncateLightweightLabel(labelText) : labelText;
  const label = textField(labelText, displayText);
  const slug = slugify(displayText);

  return {
    label,
    slug,
    folder,
    resolved,
    kind,
    nextFile,
    notePath,
    flags,
    next: null,
    log: null,
  };
}

export function parsePriorities(
  text: string,
  folderSet: Set<string>,
): PrioritiesResult {
  const { body, offset } = stripFrontmatter(text);
  const lines = body.split('\n');
  const active: Entry[] = [];
  const inactive: Entry[] = [];
  const parseFlags: string[] = [];
  let section: 'active' | 'inactive' | null = null;

  // FU-2 #5: ensure slug uniqueness across the parsed set — a true duplicate
  // base slug (two one-offs truncating to the same prefix) gets `-2`, `-3`, …
  const slugCounts = new Map<string, number>();
  const uniqueSlug = (base: string): string => {
    const n = slugCounts.get(base) ?? 0;
    slugCounts.set(base, n + 1);
    return n === 0 ? base : `${base}-${n + 1}`;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;

    const trimmed = line.trim();
    if (/^-\s+active$/i.test(trimmed)) {
      section = 'active';
      continue;
    }
    if (/^-\s+inactive$/i.test(trimmed)) {
      section = 'inactive';
      continue;
    }

    const entryMatch = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (entryMatch) {
      const entry = buildEntry(entryMatch[1], folderSet);
      entry.slug = uniqueSlug(entry.slug);
      if (section === 'inactive') {
        inactive.push(entry);
      } else {
        if (section === null) {
          parseFlags.push(
            `priorities.md: entry before any Active/Inactive section (line ${offset + i + 1})`,
          );
        }
        active.push(entry);
      }
      continue;
    }

    parseFlags.push(`priorities.md: couldn't parse line ${offset + i + 1}`);
  }

  return { active, inactive, parseFlags };
}
