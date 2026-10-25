// FU-27a: /model parser + model identifier mapping.
// Parser is leading-only; caller renders user-facing replies + DB writes.

export type ParsedModelCommand =
  | { kind: 'set'; model: 'opus' | 'sonnet' }
  | { kind: 'show' }
  | null;

// Short-name → SDK identifier + display label. Haiku intentionally omitted.
// The only place model IDs are written: containers receive them as the
// opus/sonnet alias defaults, and saved per-group choices are normalized to them.
export const MODEL_MAP: Record<string, { id: string; display: string }> = {
  opus: { id: 'claude-opus-4-8', display: 'Opus' },
  sonnet: { id: 'claude-sonnet-5-5', display: 'Sonnet' },
};

// Used when a group has never run /model.
export const DEFAULT_AGENT_MODEL_ID = MODEL_MAP.sonnet.id;

export function parseModelCommand(text: string): ParsedModelCommand {
  const tokens = text.trim().split(/\s+/);
  if (tokens[0] !== '/model') return null;
  if (tokens.length === 1) return { kind: 'show' };
  if (tokens.length > 2) return null;
  const arg = tokens[1].toLowerCase();
  if (arg === 'opus' || arg === 'sonnet') return { kind: 'set', model: arg };
  return null;
}

// Reverse lookup with raw-identifier fallback for unknown DB values.
export function displayName(fullId: string): string {
  for (const entry of Object.values(MODEL_MAP)) {
    if (entry.id === fullId) return entry.display;
  }
  return fullId;
}

// Real Anthropic IDs only: claude-<family>-<version digits and dashes>.
const ANTHROPIC_MODEL_ID = /^claude-(opus|sonnet)-[0-9][0-9-]*$/;

// Maps a saved identifier to the current ID of its family (opus/sonnet), so a
// MODEL_MAP bump carries stored choices along. Null for anything that is not a
// real Anthropic opus/sonnet ID (bare aliases, other providers, extra words).
export function currentModelId(saved: string): string | null {
  const match = ANTHROPIC_MODEL_ID.exec(saved);
  return match ? MODEL_MAP[match[1]].id : null;
}
