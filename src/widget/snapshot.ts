// Impl-73 Step 4a — board snapshot assembler. Reads priorities.md + each
// resolved project's next-file, serializes the schema. Deterministic,
// always-current — the Bridge parses live on each GET (D-4a.1); no agent,
// no cache, no synthesis. Log synthesis is 4b-Log: handleWidgetData overlays
// each entry.log from board-cache/logs.json; here the log is always the
// graceful-fallback empty stub (synthesized:false, repoMapped:false).

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { parseNext } from './next-parser.js';
import { parsePriorities } from './priorities-parser.js';
import type { BoardSnapshot, Entry } from './types.js';

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
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
      const label = `${entry.folder}/${path.basename(entry.nextFile)}`;
      entry.next = parseNext(nextText, label, parseFlags);
    }
  }

  // 4b-Log: the synthesized log is served from board-cache/logs.json by
  // handleWidgetData; here we emit the graceful-fallback stub only.
  entry.log = { synthesized: false, repoMapped: false, entries: [] };
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
    version: 2,
    widgetId: 'projects-board',
    lastRefreshed: new Date().toISOString(),
    cacheGeneratedAt: null,
    priorities: { active, inactive },
    insights: { standing: [], new: [] },
    parseFlags,
  };
}
