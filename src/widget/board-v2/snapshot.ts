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

import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
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
  } catch {
    // Vera SF8: the flag text is served inside a 200 body, so it must not leak
    // host paths (which is exactly why the 500 path scrubs them). The label
    // alone identifies the file; the detail goes nowhere useful anyway.
    flags.push(`${label}: unreadable — ignored`);
    return null;
  }
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    flags.push(`${label}: unparseable JSON — ignored`);
    return null;
  }
}

// tmp + rename in the SAME directory (rename is atomic only within a
// filesystem), 0644 so the container-side agent can read it back.
//
// Vera SF1: the tmp name carries a random UUID, NOT pid+timestamp. Two devices
// saving in the same millisecond would otherwise pick the same tmp path and
// interleave their writes — one 500 on a legitimate save, or a half-written
// overlay that reads back corrupt and self-heals to null (a silent full reset
// of JT's arrangement).
//
// Vera SF2: the guard spans writeFile AND rename, and unlinks the tmp on ANY
// failure path — an ENOSPC/EACCES mid-write would otherwise litter the state
// dir, which the container agent also reads.
async function atomicWriteJson(
  dir: string,
  name: string,
  data: unknown,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${name}.tmp-${randomUUID()}`);
  try {
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o644 });
    await rename(tmp, path.join(dir, name));
  } catch (err) {
    try {
      await rm(tmp, { force: true });
    } catch {
      // Best-effort cleanup — the original failure is the one worth surfacing.
    }
    throw err;
  }
}

// ── Insights (SPEC §1 staleness rule) ───────────────────────────────────────

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

// mtime of a state file in ms, or null when it is absent/unreadable. The
// optional-chain guard also covers a stat stub that returns nothing.
async function fileMtimeMs(filePath: string): Promise<number | null> {
  try {
    const info = await stat(filePath);
    return typeof info?.mtimeMs === 'number' ? info.mtimeMs : null;
  } catch {
    return null;
  }
}

// Derive the insights block from the two files. `running`/`stale` are computed,
// never stored. Both the data GET and the regen POST call this, so "already
// running" means exactly the same thing on both routes.
//
// Vera SF4 (deterministic_over_prompt): the run is considered FINISHED when
// insights.json's MTIME — stamped mechanically by the container's `mv`, not by
// anything the agent writes — is newer than the request. The agent-authored
// `asOf` string is display-only: a skill that forgets to update it, or writes a
// malformed date, can no longer wedge the button in "updating…" for the whole
// staleness window.
export function deriveInsightsBlock(
  insights: InsightsFileV2 | null,
  regen: RegenRequestV2 | null,
  insightsMtimeMs: number | null,
  now: number,
): InsightsBlockV2 {
  const requestedMs = parseTime(regen?.requestedAt);

  let running = false;
  let stale = false;
  // A request is only in flight while it is NEWER than the file on disk (or
  // there is no file yet — a first-ever regen).
  if (
    requestedMs !== null &&
    (insightsMtimeMs === null || requestedMs > insightsMtimeMs)
  ) {
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
  // ORDERING IS LOAD-BEARING: stat BEFORE reading the content.
  //
  // The container replaces insights.json with a `mv` that can land between our
  // two reads. Stat-then-read means the worst case is a FRESH list paired with
  // an mtime from before the move — i.e. new items still labelled "updating…",
  // which self-corrects on the very next fetch. Read-then-stat would produce
  // the opposite and much worse pairing: the OLD list stamped running:false, a
  // stale list confidently labelled "done" until JT manually refreshes.
  const mtime = await fileMtimeMs(path.join(stateDir, INSIGHTS_FILE));
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
  return deriveInsightsBlock(insights, regen, mtime, now);
}

export async function writeRegenRequest(
  stateDir: string,
  mode: RegenModeV2,
  requestedAt: string,
): Promise<void> {
  const request: RegenRequestV2 = { mode, requestedAt };
  await atomicWriteJson(stateDir, REGEN_FILE, request);
}

// Roll back a regen request whose poke failed (Vera SF3), but ONLY if the file
// on disk is still the one this request wrote.
//
// Two near-simultaneous POSTs can both clear the `running` guard. If A's poke
// throws after B's succeeded, an unconditional unlink would delete B's LIVE
// request and the board would report idle in the middle of a real run. So the
// rollback checks ownership by `requestedAt` and otherwise leaves the file
// alone — an orphaned request only mis-reports a UI hint for the staleness
// window, which is strictly the cheaper failure.
//
// Best-effort throughout: if the file can't be read or parsed we cannot prove
// ownership, so we leave it, and a failed unlink never masks the poke error
// that triggered the rollback.
export async function rollbackRegenRequest(
  stateDir: string,
  requestedAt: string,
): Promise<void> {
  const filePath = path.join(stateDir, REGEN_FILE);
  let current: RegenRequestV2 | null;
  try {
    const text = await readFileOrNull(filePath);
    if (text === null) return; // Already gone — nothing to roll back.
    current = JSON.parse(text) as RegenRequestV2;
  } catch {
    return; // Unreadable/corrupt — can't prove it's ours, so don't touch it.
  }
  if (current?.requestedAt !== requestedAt) return;
  try {
    await rm(filePath, { force: true });
  } catch {
    // Nothing further to do — the caller is already reporting a failure.
  }
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
