import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, it, expect } from 'vitest';

import {
  boardV2StateDir,
  buildBoardV2Snapshot,
  deriveInsightsBlock,
  readInsightsBlock,
  readOverlay,
  rollbackRegenRequest,
  validateOverlay,
  writeOverlay,
  writeRegenRequest,
} from './snapshot.js';
import type { BoardV2Overlay } from './types.js';

// Real fs against throwaway dirs (this file does NOT mock fs) — the state-dir
// layer is all atomic-write + degrade-gracefully behaviour, which a mock can't
// meaningfully exercise.
let root: string;
let vaultRoot: string;
let stateDir: string;

const FM = '---\ntype: project\nproject: p\nstatus: active\n---\n';

async function project(folder: string, body: string | null): Promise<void> {
  const dir = path.join(vaultRoot, 'general', 'projects', folder);
  await mkdir(dir, { recursive: true });
  if (body !== null) await writeFile(path.join(dir, 'next.md'), FM + body);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'board-v2-'));
  vaultRoot = path.join(root, 'vault');
  stateDir = path.join(root, 'state');
  await mkdir(path.join(vaultRoot, 'general', 'projects'), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// ── Snapshot assembly (SPEC §2) ──────────────────────────────────────────────

describe('buildBoardV2Snapshot', () => {
  it('emits the frozen schema header', async () => {
    const snap = await buildBoardV2Snapshot(vaultRoot, stateDir);
    expect(snap.version).toBe(1);
    expect(snap.widgetId).toBe('projects-board-v2');
    expect(Number.isNaN(Date.parse(snap.generatedAt))).toBe(false);
  });

  it('enumerates folders (D1), sorted, one project per non-empty next.md', async () => {
    await project('podvast', '1. Public app ideas\n');
    await project('daystrom', '1. Path to v3\n');
    await project('fi-master', '1. Historicals dash\n\t- CAPE percentile\n');
    const snap = await buildBoardV2Snapshot(vaultRoot, stateDir);
    expect(snap.projects.map((p) => p.folder)).toEqual([
      'daystrom',
      'fi-master',
      'podvast',
    ]);
    expect(snap.emptyProjects).toEqual([]);
  });

  it('frontmatter-only, absent and unparseable-to-zero next.md → emptyProjects (D2)', async () => {
    await project('coactive', ''); // frontmatter only — the live shape
    await project('flickboard', null); // no next.md at all
    await project('daystrom', '1. Path to v3\n');
    const snap = await buildBoardV2Snapshot(vaultRoot, stateDir);
    expect(snap.emptyProjects).toEqual(['coactive', 'flickboard']);
    expect(snap.projects.map((p) => p.folder)).toEqual(['daystrom']);
  });

  it('files (not folders) under projects/ are ignored', async () => {
    await project('daystrom', '1. Path to v3\n');
    await writeFile(
      path.join(vaultRoot, 'general', 'projects', 'priorities.md'),
      '# not a project\n',
    );
    const snap = await buildBoardV2Snapshot(vaultRoot, stateDir);
    expect(snap.projects).toHaveLength(1);
    expect(snap.emptyProjects).toEqual([]);
  });

  it('parse flags from every project accumulate on the snapshot', async () => {
    await project('daystrom', '#### Coding\n1. Path to v3\n');
    const snap = await buildBoardV2Snapshot(vaultRoot, stateDir);
    expect(snap.parseFlags).toHaveLength(1);
    expect(snap.parseFlags[0]).toContain('daystrom/next.md');
  });

  it('a missing projects dir rejects (the route turns this into a 500)', async () => {
    await expect(
      buildBoardV2Snapshot(path.join(root, 'nope'), stateDir),
    ).rejects.toThrow();
  });

  it('an absent state dir degrades to empty insights, never throws', async () => {
    await project('daystrom', '1. Path to v3\n');
    const snap = await buildBoardV2Snapshot(vaultRoot, stateDir);
    expect(snap.insights).toEqual({
      asOf: null,
      running: false,
      stale: false,
      items: [],
    });
    expect(snap.parseFlags).toEqual([]);
  });
});

// ── Insights state machine (SPEC §1 staleness rule) ──────────────────────────

describe('deriveInsightsBlock', () => {
  const now = Date.parse('2026-08-18T12:00:00.000Z');
  const at = (iso: string) => Date.parse(iso);
  const items = [
    { id: 'v2-001', text: 'See [[notes/x]]', projects: ['daystrom'] },
  ];

  it('no files → empty, idle', () => {
    expect(deriveInsightsBlock(null, null, null, now)).toEqual({
      asOf: null,
      running: false,
      stale: false,
      items: [],
    });
  });

  it('tokenizes item text and preserves id + projects', () => {
    const block = deriveInsightsBlock(
      { asOf: '2026-08-18T11:00:00.000Z', items },
      null,
      at('2026-08-18T11:00:00.000Z'),
      now,
    );
    expect(block.asOf).toBe('2026-08-18T11:00:00.000Z');
    expect(block.items[0]).toEqual({
      id: 'v2-001',
      text: [{ text: 'See ' }, { link: { target: 'x', path: 'notes/x' } }],
      projects: ['daystrom'],
    });
  });

  it('a regen newer than the file mtime, inside the window → running', () => {
    const block = deriveInsightsBlock(
      { asOf: '2026-08-18T11:00:00.000Z', items },
      { mode: 'new-only', requestedAt: '2026-08-18T11:50:00.000Z' },
      at('2026-08-18T11:00:00.000Z'),
      now,
    );
    expect(block).toMatchObject({ running: true, stale: false });
  });

  it('a regen older than 30 min with no newer file → stale, not running', () => {
    const block = deriveInsightsBlock(
      { asOf: '2026-08-18T11:00:00.000Z', items },
      { mode: 'full', requestedAt: '2026-08-18T11:20:00.000Z' },
      at('2026-08-18T11:00:00.000Z'),
      now,
    );
    expect(block).toMatchObject({ running: false, stale: true });
  });

  it('a file mtime newer than the request → idle (the run landed)', () => {
    const block = deriveInsightsBlock(
      { asOf: '2026-08-18T11:55:00.000Z', items },
      { mode: 'full', requestedAt: '2026-08-18T11:50:00.000Z' },
      at('2026-08-18T11:55:00.000Z'),
      now,
    );
    expect(block).toMatchObject({ running: false, stale: false });
  });

  it('a first-ever regen with no insights file at all → running', () => {
    const block = deriveInsightsBlock(
      null,
      { mode: 'new-only', requestedAt: '2026-08-18T11:59:00.000Z' },
      null,
      now,
    );
    expect(block).toMatchObject({ asOf: null, running: true, stale: false });
  });

  it('malformed item entries are dropped rather than crashing the board', () => {
    const block = deriveInsightsBlock(
      {
        asOf: '2026-08-18T11:00:00.000Z',
        items: [{ id: 'v2-001' }, ...items] as never,
      },
      null,
      at('2026-08-18T11:00:00.000Z'),
      now,
    );
    expect(block.items).toHaveLength(1);
  });

  // Vera SF4 — the whole point of switching off `asOf`: the clear must not
  // depend on anything the skill writes.
  it('a fresh mtime clears running even when asOf is GARBAGE', () => {
    const block = deriveInsightsBlock(
      { asOf: 'sometime last Tuesday', items },
      { mode: 'full', requestedAt: '2026-08-18T11:50:00.000Z' },
      at('2026-08-18T11:55:00.000Z'),
      now,
    );
    expect(block).toMatchObject({ running: false, stale: false });
    // …and the garbage still rides through for display only.
    expect(block.asOf).toBe('sometime last Tuesday');
  });

  it('a fresh mtime clears running even when asOf is MISSING entirely', () => {
    const block = deriveInsightsBlock(
      { items } as never,
      { mode: 'full', requestedAt: '2026-08-18T11:50:00.000Z' },
      at('2026-08-18T11:55:00.000Z'),
      now,
    );
    expect(block).toMatchObject({ asOf: null, running: false, stale: false });
  });

  it('a STALE mtime keeps running even when asOf claims a fresh result', () => {
    // The inverse guard: an agent that stamped asOf but never moved the file
    // must not be able to clear the indicator early.
    const block = deriveInsightsBlock(
      { asOf: '2026-08-18T11:59:00.000Z', items },
      { mode: 'full', requestedAt: '2026-08-18T11:50:00.000Z' },
      at('2026-08-18T11:00:00.000Z'),
      now,
    );
    expect(block).toMatchObject({ running: true, stale: false });
  });
});

describe('readInsightsBlock', () => {
  it('a corrupt insights.json degrades to empty + a flag (never throws)', async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, 'insights.json'), '{ not json');
    const flags: string[] = [];
    const block = await readInsightsBlock(stateDir, flags);
    expect(block.items).toEqual([]);
    expect(flags[0]).toContain('insights.json');
  });

  it('a corrupt regen-request.json degrades to idle + a flag', async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, 'regen-request.json'), 'nope');
    const flags: string[] = [];
    const block = await readInsightsBlock(stateDir, flags);
    expect(block.running).toBe(false);
    expect(flags[0]).toContain('regen-request.json');
  });

  it('round-trips a written regen request', async () => {
    await writeRegenRequest(stateDir, 'new-only', '2026-08-18T12:00:00.000Z');
    const written = JSON.parse(
      await readFile(path.join(stateDir, 'regen-request.json'), 'utf8'),
    ) as { mode: string; requestedAt: string };
    expect(written).toEqual({
      mode: 'new-only',
      requestedAt: '2026-08-18T12:00:00.000Z',
    });
    const block = await readInsightsBlock(
      stateDir,
      [],
      Date.parse('2026-08-18T12:01:00.000Z'),
    );
    expect(block.running).toBe(true);
  });

  // Vera SF8 — these flags ship inside a 200 body; the 500 path scrubs paths,
  // so these must too.
  it('degradation flags never leak a host path', async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, 'insights.json'), '{ not json');
    const flags: string[] = [];
    await readInsightsBlock(stateDir, flags);
    expect(flags[0]).toBe('insights.json: unparseable JSON — ignored');
    expect(flags[0]).not.toContain(stateDir);
    expect(flags[0]).not.toContain(path.sep);
  });

  // Vera SF4, end to end against a real file's real mtime.
  it('a real insights.json mtime clears running even with a garbage asOf', async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, 'insights.json'),
      JSON.stringify({ asOf: 'sometime last Tuesday', items: [] }),
    );
    // Request predates the file the container just moved into place.
    await writeRegenRequest(
      stateDir,
      'full',
      new Date(Date.now() - 5_000).toISOString(),
    );
    const block = await readInsightsBlock(stateDir, []);
    expect(block).toMatchObject({ running: false, stale: false });
  });

  it('a request newer than the real insights.json mtime → running', async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, 'insights.json'),
      JSON.stringify({ asOf: '2099-01-01T00:00:00.000Z', items: [] }),
    );
    await writeRegenRequest(
      stateDir,
      'full',
      new Date(Date.now() + 5_000).toISOString(),
    );
    const block = await readInsightsBlock(stateDir, []);
    expect(block).toMatchObject({ running: true, stale: false });
  });

  it('rollbackRegenRequest clears its OWN request and no-ops when absent', async () => {
    const mine = new Date().toISOString();
    await writeRegenRequest(stateDir, 'full', mine);
    expect((await readInsightsBlock(stateDir, [])).running).toBe(true);
    await rollbackRegenRequest(stateDir, mine);
    expect((await readInsightsBlock(stateDir, [])).running).toBe(false);
    await expect(rollbackRegenRequest(stateDir, mine)).resolves.toBeUndefined();
  });

  // Vera round-3 SF2 — a concurrent POST's live request must survive.
  it('rollbackRegenRequest leaves a request written by SOMEONE ELSE', async () => {
    const theirs = new Date().toISOString();
    await writeRegenRequest(stateDir, 'new-only', theirs);
    await rollbackRegenRequest(stateDir, '2026-08-18T00:00:00.000Z');
    const still = JSON.parse(
      await readFile(path.join(stateDir, 'regen-request.json'), 'utf8'),
    ) as { requestedAt: string };
    expect(still.requestedAt).toBe(theirs);
    expect((await readInsightsBlock(stateDir, [])).running).toBe(true);
  });

  it('rollbackRegenRequest leaves an unreadable request in place', async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, 'regen-request.json'), '{ corrupt');
    await rollbackRegenRequest(stateDir, new Date().toISOString());
    await expect(
      readFile(path.join(stateDir, 'regen-request.json'), 'utf8'),
    ).resolves.toBe('{ corrupt');
  });
});

// ── Overlay validation (SPEC §3) ─────────────────────────────────────────────

const VALID: unknown = {
  schemaVersion: 1,
  updatedAt: '2026-08-18T14:22:31Z',
  placements: {
    'daystrom␟Path to v3': 'active',
    'fi-master␟Dailies dash': 'ondeck',
  },
  order: {
    active: ['daystrom␟Path to v3'],
    ondeck: ['fi-master␟Dailies dash'],
    'col:daystrom': ['daystrom␟Redo wiki (TBD)'],
  },
  expanded: { 'daystrom␟Path to v3': true },
  placedHash: { 'daystrom␟Path to v3': 'a1b2c3d4e5f6' },
  ui: { theme: 'dark', collapsedColumns: ['podvast', 'ondeck'] },
};

function reject(mutate: (o: Record<string, unknown>) => void): string {
  const body = JSON.parse(JSON.stringify(VALID)) as Record<string, unknown>;
  mutate(body);
  const result = validateOverlay(body);
  if (result.ok) throw new Error('expected rejection');
  return result.error;
}

describe('validateOverlay', () => {
  it('accepts the full documented shape and ignores the client updatedAt', () => {
    const result = validateOverlay(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.overlay.updatedAt).toBe('');
    expect(result.overlay.placements['daystrom␟Path to v3']).toBe('active');
    expect(result.overlay.ui.collapsedColumns).toEqual(['podvast', 'ondeck']);
  });

  it('accepts a minimal overlay (schemaVersion only)', () => {
    const result = validateOverlay({ schemaVersion: 1 });
    expect(result.ok).toBe(true);
  });

  it('rejects a non-object body', () => {
    expect(validateOverlay('nope').ok).toBe(false);
    expect(validateOverlay([]).ok).toBe(false);
    expect(validateOverlay(null).ok).toBe(false);
  });

  it('rejects a wrong schemaVersion', () => {
    expect(reject((o) => (o.schemaVersion = 2))).toContain('schemaVersion');
  });

  it('rejects unknown top-level fields (strict — the file is agent-read too)', () => {
    expect(reject((o) => (o.sneaky = 1))).toContain('unknown field');
  });

  it('rejects unknown ui fields', () => {
    expect(
      reject((o) => ((o.ui as Record<string, unknown>).zoom = 2)),
    ).toContain('unknown ui field');
  });

  it('rejects a placement value outside active|ondeck', () => {
    expect(
      reject((o) => ((o.placements as Record<string, unknown>).k = 'done')),
    ).toContain('active|ondeck');
  });

  it('rejects an order key outside the allowed column charset', () => {
    expect(
      reject(
        (o) => ((o.order as Record<string, unknown>)['col:Bad Name'] = []),
      ),
    ).toContain('invalid column key');
    expect(
      reject((o) => ((o.order as Record<string, unknown>)['backlog'] = [])),
    ).toContain('invalid column key');
  });

  it('rejects an order array over 500 entries', () => {
    expect(
      reject(
        (o) =>
          ((o.order as Record<string, unknown>).active = new Array(501).fill(
            'k',
          )),
      ),
    ).toContain('exceeds 500');
  });

  it('rejects a key or string over 512 chars', () => {
    expect(
      reject(
        (o) =>
          ((o.placements as Record<string, unknown>)['x'.repeat(513)] =
            'active'),
      ),
    ).toContain('512');
    expect(
      reject(
        (o) =>
          ((o.order as Record<string, unknown>).active = ['x'.repeat(513)]),
      ),
    ).toContain('must be strings');
  });

  it('rejects a non-boolean expanded value', () => {
    expect(
      reject((o) => ((o.expanded as Record<string, unknown>).k = 'yes')),
    ).toContain('boolean');
  });

  it('rejects a placedHash that is not 12 hex chars', () => {
    expect(
      reject((o) => ((o.placedHash as Record<string, unknown>).k = 'ZZZ')),
    ).toContain('12 hex');
  });

  it('rejects a theme outside dark|light', () => {
    expect(
      reject((o) => ((o.ui as Record<string, unknown>).theme = 'solarized')),
    ).toContain('dark|light');
  });

  // ui.fontScale — the widget's text-size toggle (JT request).
  it.each(['s', 'm', 'l'])('accepts ui.fontScale "%s"', (scale) => {
    const body = JSON.parse(JSON.stringify(VALID)) as Record<string, unknown>;
    (body.ui as Record<string, unknown>).fontScale = scale;
    const result = validateOverlay(body);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.overlay.ui.fontScale).toBe(scale);
  });

  it('an absent ui.fontScale is fine and stays absent (widget defaults to m)', () => {
    const result = validateOverlay(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.overlay.ui.fontScale).toBeUndefined();
    expect('fontScale' in result.overlay.ui).toBe(false);
  });

  it('rejects a fontScale outside s|m|l, and a non-string one', () => {
    expect(
      reject((o) => ((o.ui as Record<string, unknown>).fontScale = 'xl')),
    ).toContain('s|m|l');
    expect(
      reject((o) => ((o.ui as Record<string, unknown>).fontScale = 'M')),
    ).toContain('s|m|l');
    expect(
      reject((o) => ((o.ui as Record<string, unknown>).fontScale = 2)),
    ).toContain('s|m|l');
    expect(
      reject((o) => ((o.ui as Record<string, unknown>).fontScale = null)),
    ).toContain('s|m|l');
  });
});

// ── Overlay storage ──────────────────────────────────────────────────────────

describe('writeOverlay / readOverlay', () => {
  const overlay: BoardV2Overlay = {
    schemaVersion: 1,
    updatedAt: '2026-08-18T14:22:31.000Z',
    placements: { 'daystrom␟Path to v3': 'active' },
    order: { active: ['daystrom␟Path to v3'] },
    expanded: {},
    placedHash: { 'daystrom␟Path to v3': 'a1b2c3d4e5f6' },
    ui: { theme: 'dark' },
  };

  it('round-trips, creating the state dir and leaving no tmp file behind', async () => {
    await writeOverlay(stateDir, overlay);
    expect(await readdir(stateDir)).toEqual(['overlay.json']);
    const read = await readOverlay(stateDir, []);
    expect(read).toEqual(overlay);
  });

  it('ui.fontScale survives the storage round-trip like every other ui field', async () => {
    await writeOverlay(stateDir, {
      ...overlay,
      ui: { theme: 'light', collapsedColumns: ['podvast'], fontScale: 'l' },
    });
    const read = await readOverlay(stateDir, []);
    expect(read?.ui).toEqual({
      theme: 'light',
      collapsedColumns: ['podvast'],
      fontScale: 'l',
    });
  });

  it('an absent overlay is null with NO flag (a fresh board is not an error)', async () => {
    const flags: string[] = [];
    expect(await readOverlay(stateDir, flags)).toBeNull();
    expect(flags).toEqual([]);
  });

  it('a corrupt overlay self-heals to null + a flag', async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, 'overlay.json'), '{{{');
    const flags: string[] = [];
    expect(await readOverlay(stateDir, flags)).toBeNull();
    expect(flags[0]).toContain('overlay.json');
  });

  it('a schema-invalid overlay is ignored with a flag naming the violation', async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, 'overlay.json'),
      JSON.stringify({ schemaVersion: 9 }),
    );
    const flags: string[] = [];
    expect(await readOverlay(stateDir, flags)).toBeNull();
    expect(flags[0]).toContain('schemaVersion');
  });

  it('a stored overlay is NEVER filtered against the snapshot', async () => {
    // The key below exists in no project; it must survive a read so a
    // transiently missing card cannot permanently evict its placement.
    await writeOverlay(stateDir, {
      ...overlay,
      placements: { 'gone␟Vanished card': 'active' },
    });
    const read = await readOverlay(stateDir, []);
    expect(read?.placements).toEqual({ 'gone␟Vanished card': 'active' });
  });
});

describe('boardV2StateDir', () => {
  it('resolves under the v1 board-cache mount so P3 needs no new mount', () => {
    expect(boardV2StateDir()).toBe(
      path.join(os.homedir(), 'daystrom-ops', 'state', 'board-cache', 'v2'),
    );
  });
});
