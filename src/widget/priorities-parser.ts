// Impl-73 Step 4a — priorities.md parser (D-4a.3). priorities.md IS the project
// registry: `- Active` / `- Inactive` sections of numbered entries. Each entry
// resolves to a project folder (default slug, or a `→ \`folder / next-file\``
// override), points elsewhere (`→ note: <path>`), or is lightweight
// (ranked/display-only) when its label carries links/URLs/descriptive prose or
// its slug matches no live folder. Lightweight entries are NEVER folder-guessed.

import { stripFrontmatter, textField } from './parse-util.js';
import type { Entry } from './types.js';

// A label is "display-only" when it embeds a markdown link, a URL, or reads as
// descriptive prose (a "label: detail" colon phrase) rather than a project name.
const MD_LINK_RE = /\[[^\]]*\]\([^)]*\)/;
const URL_RE = /https?:\/\//;

function slugify(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, '-');
}

export interface PrioritiesResult {
  active: Entry[];
  inactive: Entry[];
  parseFlags: string[];
}

function buildEntry(rawBody: string, folderSet: Set<string>): Entry {
  const flags: string[] = [];

  const arrowIdx = rawBody.indexOf('→');
  const labelText =
    arrowIdx === -1 ? rawBody.trim() : rawBody.slice(0, arrowIdx).trim();
  const overrideSpec =
    arrowIdx === -1 ? null : rawBody.slice(arrowIdx + '→'.length).trim();
  const label = textField(labelText, labelText);
  const slug = slugify(labelText);

  // `→ note: <path>` pointer — a read-only briefing, not a workable folder.
  if (overrideSpec !== null) {
    const noteMatch = /^note:\s*(.*)$/i.exec(overrideSpec);
    if (noteMatch) {
      return {
        label,
        slug,
        resolved: false,
        kind: 'pointer',
        nextFile: null,
        notePath: noteMatch[1].trim(),
        flags,
        next: null,
        log: null,
      };
    }

    // `→ \`folder / next-file\`` override (strip backticks + surrounding spaces).
    const spec = overrideSpec.replace(/`/g, '').trim();
    const slashIdx = spec.indexOf('/');
    const folder = (slashIdx === -1 ? spec : spec.slice(0, slashIdx)).trim();
    const nextName =
      slashIdx === -1 ? 'next.md' : spec.slice(slashIdx + 1).trim();
    const resolved = folderSet.has(folder);
    if (!resolved) flags.push(`override folder "${folder}" not found`);
    return {
      label,
      slug: folder,
      resolved,
      kind: resolved ? 'full' : 'lightweight',
      nextFile: resolved ? `general/projects/${folder}/${nextName}` : null,
      notePath: null,
      flags,
      next: null,
      log: null,
    };
  }

  // No override — content-lightweight first, then slug-vs-folder resolution.
  if (
    MD_LINK_RE.test(labelText) ||
    URL_RE.test(labelText) ||
    /:\s/.test(labelText)
  ) {
    flags.push('display-only (embedded link/URL or descriptive prose)');
    return lightweight(label, slug, flags);
  }
  if (folderSet.has(slug)) {
    return {
      label,
      slug,
      resolved: true,
      kind: 'full',
      nextFile: `general/projects/${slug}/next.md`,
      notePath: null,
      flags,
      next: null,
      log: null,
    };
  }
  flags.push('no matching project folder (ranked/display-only)');
  return lightweight(label, slug, flags);
}

function lightweight(
  label: Entry['label'],
  slug: string,
  flags: string[],
): Entry {
  return {
    label,
    slug,
    resolved: false,
    kind: 'lightweight',
    nextFile: null,
    notePath: null,
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
