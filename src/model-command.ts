// FU-27a: /model parser + model identifier mapping.
// Parser is leading-only; caller renders user-facing replies + DB writes.

export type ParsedModelCommand =
  | { kind: 'set'; model: 'opus' | 'sonnet' }
  | { kind: 'show' }
  | null;

// Short-name → SDK identifier + display label. Haiku intentionally omitted.
export const MODEL_MAP: Record<string, { id: string; display: string }> = {
  opus: { id: 'claude-opus-4-7', display: 'Opus' },
  sonnet: { id: 'claude-sonnet-4-6', display: 'Sonnet' },
};

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
