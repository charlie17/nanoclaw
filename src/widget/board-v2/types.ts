// Projects Board v2 — data-plane types + shared constants (SPEC §1/§2/§3).
//
// Sibling of the v1 board's `src/widget/types.ts`, which stays UNCHANGED: v2
// reuses v1's `Token` union verbatim and layers its own card/snapshot shapes on
// top. The two boards run side by side during the v2 trial (D10), so nothing
// here may alter a v1 shape.

import type { Token } from '../types.js';

export type { Token };

// ── Shared constants (SPEC §1) ──────────────────────────────────────────────

export const BOARD_V2_WIDGET_ID = 'projects-board-v2';
// U+241F SYMBOL FOR UNIT SEPARATOR — same key separator as v1. A literal
// separator (not an escape) keeps it greppable in the overlay file, which is
// also agent-read.
export const KEY_SEP = '␟';
// A regen requested longer ago than this with no newer insights is treated as a
// failed run (stale), not an in-flight one (SPEC §1).
export const REGEN_STALE_MS = 30 * 60 * 1000;
// Overlay body cap — the route rejects anything larger (SPEC §3).
export const OVERLAY_BODY_LIMIT = 64 * 1024;
// The one-shot scheduled task the regen route pokes (SPEC §1). Created at
// deploy, never by code.
export const BOARD_V2_TASK_ID = 'daystrom-board-synth-v2';

// ── Snapshot (SPEC §2 — P1 produces, P2/P4 consume) ─────────────────────────

export type BulletV2 = '-' | 'num' | 'other';
export type CheckboxV2 = 'checked' | 'unchecked' | null;

// One line of a card's body. `depth` is 1 for a direct child of the card;
// `children` nests deeper lines. `bullet` records how the marker was written so
// the widget can re-render it; the marker itself is stripped from `tokens`.
export interface ContentNode {
  tokens: Token[];
  bullet: BulletV2;
  checkbox: CheckboxV2;
  depth: number;
  children: ContentNode[];
}

// One top-level item of a project's next.md. `key` is `<folder>␟<titleText>`
// and is the ONLY identity the overlay stores — a title edit deliberately
// evaporates the old key (reset-on-rename, REQ §3.3). `unparsed` marks a
// kept-but-flagged line: v2 never silently drops a column-0 line.
export interface CardV2 {
  key: string;
  title: Token[];
  titleText: string;
  content: ContentNode[];
  contentHash: string;
  unparsed?: true;
}

export interface ProjectV2 {
  folder: string;
  cards: CardV2[];
}

// One agent-authored insight, as served. `text` is tokenized host-side so the
// widget never parses markdown.
export interface InsightV2 {
  id: string;
  text: Token[];
  projects: string[];
}

// `running`/`stale` are derived per request from insights.json +
// regen-request.json (SPEC §1 staleness rule) — they are never stored.
export interface InsightsBlockV2 {
  asOf: string | null;
  running: boolean;
  stale: boolean;
  items: InsightV2[];
}

export interface BoardV2Snapshot {
  version: 1;
  widgetId: typeof BOARD_V2_WIDGET_ID;
  generatedAt: string;
  projects: ProjectV2[];
  emptyProjects: string[];
  insights: InsightsBlockV2;
  parseFlags: string[];
}

// ── Overlay (SPEC §3 — P2 writes via route, P1 validates/stores, P3 reads) ──

export type PlacementV2 = 'active' | 'ondeck';
export type ThemeV2 = 'dark' | 'light';
// Card/body font-size step for the widget's text-size toggle (JT request). An
// ABSENT value means 'm' — the widget applies that default, so the stored file
// only ever carries a scale JT actually chose.
export type FontScaleV2 = 's' | 'm' | 'l';

// JT's arrangement. Reconciliation against the live snapshot is CLIENT-side:
// the host stores what it is given (validated) and never filters keys against
// the snapshot, so a transiently missing card cannot permanently evict its
// placement.
export interface BoardV2Overlay {
  schemaVersion: 1;
  updatedAt: string;
  placements: Record<string, PlacementV2>;
  order: Record<string, string[]>;
  expanded: Record<string, boolean>;
  placedHash: Record<string, string>;
  ui: { theme?: ThemeV2; collapsedColumns?: string[]; fontScale?: FontScaleV2 };
}

// ── State-dir files (SPEC §1) ───────────────────────────────────────────────

export type RegenModeV2 = 'new-only' | 'full';

export interface RegenRequestV2 {
  mode: RegenModeV2;
  requestedAt: string;
}

// On-disk shape of insights.json, as written by the board-synth-v2 skill (P3).
// `text` is plain text there; the host tokenizes it on read.
export interface InsightsFileV2 {
  asOf: string;
  items: { id: string; text: string; projects: string[] }[];
}
