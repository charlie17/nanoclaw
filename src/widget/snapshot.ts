// Impl-73 Step 4a — board snapshot assembler. Reads priorities.md + each
// resolved project's next-file (parsed) + log.md (raw last-5), serializes the
// frozen D-4a.7 schema. Deterministic, always-current — the Bridge parses live
// on each GET (D-4a.1); no agent, no cache, no synthesis. The LLM Log blend is
// 4b (D-4a.6) — here `log` is the raw last-5 stub, `synthesized: false`.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { parseNext } from './next-parser.js';
import { parsePriorities } from './priorities-parser.js';
import { stripFrontmatter } from './parse-util.js';
import type { BoardSnapshot, Entry } from './types.js';

const LOG_TAIL = 5;

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

// Last-5 content lines of a log.md (frontmatter stripped, trailing blanks
// dropped). The YAML header is not a "log line", so a log holding only
// frontmatter yields []. The LLM synthesis (4b) replaces this stub.
function logTail(text: string): string[] {
  const { body } = stripFrontmatter(text);
  const lines = body.split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  while (lines.length > 0 && lines[0].trim() === '') {
    lines.shift();
  }
  return lines.slice(-LOG_TAIL);
}

async function enrichEntry(
  entry: Entry,
  vaultRoot: string,
  parseFlags: string[],
): Promise<void> {
  if (entry.nextFile) {
    const nextText = await readFileOrNull(path.join(vaultRoot, entry.nextFile));
    if (nextText === null) {
      entry.flags.push(`next-file missing: ${entry.nextFile}`);
      entry.next = { groups: [] };
    } else {
      const label = `${entry.slug}/${path.basename(entry.nextFile)}`;
      entry.next = parseNext(nextText, label, parseFlags);
    }
  }

  const logRel = `general/projects/${entry.slug}/log.md`;
  const logText = await readFileOrNull(path.join(vaultRoot, logRel));
  if (logText === null) {
    entry.flags.push(`log missing: ${logRel}`);
    entry.log = { synthesized: false, entries: [] };
  } else {
    entry.log = { synthesized: false, entries: logTail(logText) };
  }
}

export async function buildProjectsBoardSnapshot(
  vaultRoot: string,
): Promise<BoardSnapshot> {
  const projectsDir = path.join(vaultRoot, 'general', 'projects');

  const prioritiesText = await readFile(
    path.join(projectsDir, 'priorities.md'),
    'utf8',
  );
  const dirents = await readdir(projectsDir, { withFileTypes: true });
  const folderSet = new Set(
    dirents.filter((d) => d.isDirectory()).map((d) => d.name),
  );

  const { active, inactive, parseFlags } = parsePriorities(
    prioritiesText,
    folderSet,
  );

  // Only `full` entries have a folder to read; lightweight/pointer keep
  // next/log = null. Sequential keeps parseFlag ordering deterministic.
  for (const entry of [...active, ...inactive]) {
    if (entry.kind === 'full') {
      await enrichEntry(entry, vaultRoot, parseFlags);
    }
  }

  return {
    version: 1,
    widgetId: 'projects-board',
    lastRefreshed: new Date().toISOString(),
    priorities: { active, inactive },
    parseFlags,
  };
}
