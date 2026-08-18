// Projects Board v2 — snapshot assembler + state-dir I/O (SPEC §2/§3/§4).
//
// The vault is parsed LIVE on every data GET (D6 plane 1): folder-driven
// enumeration of `general/projects/*/next.md`, no priorities.md dependency
// (D1), no cache. The state dir holds only what the board itself owns — JT's
// arrangement (`overlay.json`), the regen handshake (`regen-request.json`) and
// the agent's output (`insights.json`).
//
// Failure posture, deliberately split (SPEC §4.1): a VAULT read failure throws
// (the route answers 500 — a board with no cards is a real outage), while every
// STATE-dir read is best-effort (absent or corrupt degrades to empty + a parse
// flag, never a 500 — the board must stay usable).

import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseNextV2 } from './parser.js';
import { tokenizeV2 } from './tokenize.js';
import {
  BOARD_V2_WIDGET_ID,
  REGEN_STALE_MS,
  type BoardV2Overlay,
  type BoardV2Snapshot,
  type InsightsBlockV2,
  type InsightsFileV2,
  type ProjectV2,
  type RegenModeV2,
  type RegenRequestV2,
} from './types.js';

const OVERLAY_FILE = 'overlay.json';
const REGEN_FILE = 'regen-request.json';
const INSIGHTS_FILE = 'insights.json';

// Rides the EXISTING v1 `board-cache` RW mount — the container sees this as
// /workspace/extra/board-cache/v2, so P3 needs no new mount config (SPEC §1).
export function boardV2StateDir(): string {
  return path.join(os.homedir(), 'daystrom-ops', 'state', 'board-cache', 'v2');
}

// ── Low-level helpers ───────────────────────────────────────────────────────

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

// Best-effort JSON read of a state-dir file. Absent → null with no flag (a
// board that has never been regenerated is a normal state, not a warning).
// Present-but-broken → null WITH a flag, so a corrupt file is loud.
async function readStateJson<T>(
  filePath: string,
  label: string,
  flags: string[],
): Promise<T | null> {
  let text: string | null;
  try {
    text = await readFileOrNull(filePath);
  } catch (err) {
    flags.push(`${label}: unreadable (${(err as Error).message})`);
    return null;
  }
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    flags.push(`${label}: unparseable JSON (${(err as Error).message})`);
    return null;
  }
}

// tmp + rename in the SAME directory (rename is atomic only within a
// filesystem), 0644 so the container-side agent can read it back.
async function atomicWriteJson(
  dir: string,
  name: string,
  data: unknown,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${name}.tmp-${process.pid}-${Date.now()}`);
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o644 });
  try {
    await rename(tmp, path.join(dir, name));
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

// ── Insights (SPEC §1 staleness rule) ───────────────────────────────────────

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

// Derive the insights block from the two files. `running`/`stale` are computed,
// never stored: a regen newer than the last result is in flight until the
// staleness window expires, after which it is presumed failed. Both the data
// GET and the regen POST call this, so "already running" means exactly the same
// thing on both routes.
export function deriveInsightsBlock(
  insights: InsightsFileV2 | null,
  regen: RegenRequestV2 | null,
  now: number,
): InsightsBlockV2 {
  const asOfMs = parseTime(insights?.asOf);
  const requestedMs = parseTime(regen?.requestedAt);

  let running = false;
  let stale = false;
  // A request is only interesting while it is NEWER than the result we hold.
  if (requestedMs !== null && (asOfMs === null || requestedMs > asOfMs)) {
    if (now - requestedMs <= REGEN_STALE_MS) running = true;
    else stale = true;
  }

  const rawItems = Array.isArray(insights?.items) ? insights.items : [];
  const items = rawItems
    .filter((item) => item && typeof item.text === 'string')
    .map((item) => ({
      id: typeof item.id === 'string' ? item.id : '',
      text: tokenizeV2(item.text),
      projects: Array.isArray(item.projects)
        ? item.projects.filter((p): p is string => typeof p === 'string')
        : [],
    }));

  return { asOf: insights?.asOf ?? null, running, stale, items };
}

export async function readInsightsBlock(
  stateDir: string,
  flags: string[],
  now: number = Date.now(),
): Promise<InsightsBlockV2> {
  const insights = await readStateJson<InsightsFileV2>(
    path.join(stateDir, INSIGHTS_FILE),
    INSIGHTS_FILE,
    flags,
  );
  const regen = await readStateJson<RegenRequestV2>(
    path.join(stateDir, REGEN_FILE),
    REGEN_FILE,
    flags,
  );
  return deriveInsightsBlock(insights, regen, now);
}

export async function writeRegenRequest(
  stateDir: string,
  mode: RegenModeV2,
  requestedAt: string,
): Promise<void> {
  const request: RegenRequestV2 = { mode, requestedAt };
  await atomicWriteJson(stateDir, REGEN_FILE, request);
}

// ── Overlay (SPEC §3) ───────────────────────────────────────────────────────

const ORDER_KEY_RE = /^(active|ondeck|col:[a-z0-9._-]{1,64})$/;
const PLACED_HASH_RE = /^[0-9a-f]{12}$/;
const MAX_STRING = 512;
const MAX_ARRAY = 500;
const OVERLAY_KEYS = [
  'schemaVersion',
  'updatedAt',
  'placements',
  'order',
  'expanded',
  'placedHash',
  'ui',
];
const UI_KEYS = ['theme', 'collapsedColumns'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function badKeys(value: Record<string, unknown>, allowed: string[]): string[] {
  return Object.keys(value).filter((k) => !allowed.includes(k));
}

export type OverlayValidation =
  | { ok: true; overlay: BoardV2Overlay }
  | { ok: false; error: string };

// Strict on purpose (SPEC §3): unknown fields are REJECTED rather than dropped,
// because this file is also read by the P3 agent — silently discarding a field
// the widget thinks it saved would desync the two readers. `updatedAt` is
// accepted but ignored; the caller stamps it.
export function validateOverlay(input: unknown): OverlayValidation {
  if (!isPlainObject(input))
    return { ok: false, error: 'body must be an object' };

  const unknown = badKeys(input, OVERLAY_KEYS);
  if (unknown.length > 0) {
    return { ok: false, error: `unknown field: ${unknown[0]}` };
  }
  if (input.schemaVersion !== 1) {
    return { ok: false, error: 'schemaVersion must be 1' };
  }

  const overlay: BoardV2Overlay = {
    schemaVersion: 1,
    updatedAt: '',
    placements: {},
    order: {},
    expanded: {},
    placedHash: {},
    ui: {},
  };

  const checkKey = (key: string): string | null =>
    key.length > MAX_STRING ? `key longer than ${MAX_STRING} chars` : null;

  if (input.placements !== undefined) {
    if (!isPlainObject(input.placements)) {
      return { ok: false, error: 'placements must be an object' };
    }
    for (const [key, value] of Object.entries(input.placements)) {
      const keyErr = checkKey(key);
      if (keyErr) return { ok: false, error: `placements: ${keyErr}` };
      if (value !== 'active' && value !== 'ondeck') {
        return {
          ok: false,
          error: `placements["${key}"] must be active|ondeck`,
        };
      }
      overlay.placements[key] = value;
    }
  }

  if (input.order !== undefined) {
    if (!isPlainObject(input.order)) {
      return { ok: false, error: 'order must be an object' };
    }
    for (const [key, value] of Object.entries(input.order)) {
      if (!ORDER_KEY_RE.test(key)) {
        return { ok: false, error: `order: invalid column key "${key}"` };
      }
      if (!Array.isArray(value)) {
        return { ok: false, error: `order["${key}"] must be an array` };
      }
      if (value.length > MAX_ARRAY) {
        return {
          ok: false,
          error: `order["${key}"] exceeds ${MAX_ARRAY} entries`,
        };
      }
      for (const entry of value) {
        if (typeof entry !== 'string' || entry.length > MAX_STRING) {
          return {
            ok: false,
            error: `order["${key}"] entries must be strings`,
          };
        }
      }
      overlay.order[key] = value as string[];
    }
  }

  if (input.expanded !== undefined) {
    if (!isPlainObject(input.expanded)) {
      return { ok: false, error: 'expanded must be an object' };
    }
    for (const [key, value] of Object.entries(input.expanded)) {
      const keyErr = checkKey(key);
      if (keyErr) return { ok: false, error: `expanded: ${keyErr}` };
      if (typeof value !== 'boolean') {
        return { ok: false, error: `expanded["${key}"] must be a boolean` };
      }
      overlay.expanded[key] = value;
    }
  }

  if (input.placedHash !== undefined) {
    if (!isPlainObject(input.placedHash)) {
      return { ok: false, error: 'placedHash must be an object' };
    }
    for (const [key, value] of Object.entries(input.placedHash)) {
      const keyErr = checkKey(key);
      if (keyErr) return { ok: false, error: `placedHash: ${keyErr}` };
      if (typeof value !== 'string' || !PLACED_HASH_RE.test(value)) {
        return {
          ok: false,
          error: `placedHash["${key}"] must be 12 hex chars`,
        };
      }
      overlay.placedHash[key] = value;
    }
  }

  if (input.ui !== undefined) {
    if (!isPlainObject(input.ui)) {
      return { ok: false, error: 'ui must be an object' };
    }
    const unknownUi = badKeys(input.ui, UI_KEYS);
    if (unknownUi.length > 0) {
      return { ok: false, error: `unknown ui field: ${unknownUi[0]}` };
    }
    if (input.ui.theme !== undefined) {
      if (input.ui.theme !== 'dark' && input.ui.theme !== 'light') {
        return { ok: false, error: 'ui.theme must be dark|light' };
      }
      overlay.ui.theme = input.ui.theme;
    }
    if (input.ui.collapsedColumns !== undefined) {
      const cols = input.ui.collapsedColumns;
      if (!Array.isArray(cols)) {
        return { ok: false, error: 'ui.collapsedColumns must be an array' };
      }
      if (cols.length > MAX_ARRAY) {
        return {
          ok: false,
          error: `ui.collapsedColumns exceeds ${MAX_ARRAY} entries`,
        };
      }
      for (const col of cols) {
        if (typeof col !== 'string' || col.length > MAX_STRING) {
          return {
            ok: false,
            error: 'ui.collapsedColumns entries must be strings',
          };
        }
      }
      overlay.ui.collapsedColumns = cols as string[];
    }
  }

  return { ok: true, overlay };
}

// Read the stored overlay. Corrupt or schema-invalid → null + a flag; the
// widget then seeds defaults (self-heal, REQ §3.3). Never filtered against the
// snapshot — that reconciliation is client-side, so a transiently missing card
// cannot permanently evict its placement (SPEC §3).
export async function readOverlay(
  stateDir: string,
  flags: string[],
): Promise<BoardV2Overlay | null> {
  const raw = await readStateJson<unknown>(
    path.join(stateDir, OVERLAY_FILE),
    OVERLAY_FILE,
    flags,
  );
  if (raw === null) return null;
  const validated = validateOverlay(raw);
  if (!validated.ok) {
    flags.push(`${OVERLAY_FILE}: invalid (${validated.error}) — ignored`);
    return null;
  }
  const stored = (raw as { updatedAt?: unknown }).updatedAt;
  validated.overlay.updatedAt = typeof stored === 'string' ? stored : '';
  return validated.overlay;
}

export async function writeOverlay(
  stateDir: string,
  overlay: BoardV2Overlay,
): Promise<void> {
  await atomicWriteJson(stateDir, OVERLAY_FILE, overlay);
}

// ── Snapshot ────────────────────────────────────────────────────────────────

// Folder-driven enumeration (D1): every directory under general/projects is a
// project. One with no parseable card goes to `emptyProjects` for the bottom
// bar (D2) instead of rendering an empty column.
export async function buildBoardV2Snapshot(
  vaultRoot: string,
  stateDir: string,
  now: Date = new Date(),
): Promise<BoardV2Snapshot> {
  const projectsDir = path.join(vaultRoot, 'general', 'projects');
  const dirents = await readdir(projectsDir, { withFileTypes: true });
  const folders = dirents
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const parseFlags: string[] = [];
  const projects: ProjectV2[] = [];
  const emptyProjects: string[] = [];

  // Sequential keeps parseFlag ordering deterministic (v1 precedent).
  for (const folder of folders) {
    const nextPath = path.join(projectsDir, folder, 'next.md');
    const text = await readFileOrNull(nextPath);
    if (text === null) {
      emptyProjects.push(folder);
      continue;
    }
    const cards = parseNextV2(text, folder, `${folder}/next.md`, parseFlags);
    if (cards.length === 0) emptyProjects.push(folder);
    else projects.push({ folder, cards });
  }

  const insights = await readInsightsBlock(stateDir, parseFlags, now.getTime());

  return {
    version: 1,
    widgetId: BOARD_V2_WIDGET_ID,
    generatedAt: now.toISOString(),
    projects,
    emptyProjects,
    insights,
    parseFlags,
  };
}
