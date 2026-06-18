// 4b-Log: overlay the nightly synthesized per-project Log cache onto a
// freshly-parsed BoardSnapshot. Extracted from handleWidgetData so the
// producer/consumer keying contract is unit-testable (Vera review 2026-06-18).
//
// KEYED BY entry.folder, NOT entry.slug. The board-synth agent can produce the
// on-disk folder name deterministically, but NOT the parser's deduped/override
// slug (slugify + `-2` dedup + label-vs-folder divergence on `→ folder/next`).
// Folder-keying also makes two same-folder entries (Options Coding + Business)
// share one synthesized Log — the intended behavior. Only `full` entries carry a
// folder; lightweight/pointer entries (folder null) are skipped.

import { tokenize } from './wikilink.js';
import type { BoardSnapshot } from './types.js';

// Raw shape of board-cache/logs.json as written by the synth agent. Plain-text
// `text`; the host tokenizes on read so the cache stays human-readable and the
// widget ships no parser.
export interface LogsCache {
  generatedAt?: string;
  logs: Record<
    string,
    {
      repoMapped?: boolean;
      entries: { text: string; date: string | null; repoDerived?: boolean }[];
    }
  >;
}

// Best-effort, mutates `snapshot` in place. Shape-guards the cache before
// iterating and stamps `cacheGeneratedAt` only after a clean overlay (never a
// time off a half-broken cache). A missing `generatedAt` resolves to null (not
// undefined, which JSON.stringify would drop from the payload entirely).
export function overlayLogCache(
  snapshot: BoardSnapshot,
  logsData: LogsCache,
): void {
  if (!logsData.logs || typeof logsData.logs !== 'object') return;
  for (const entry of [
    ...snapshot.priorities.active,
    ...snapshot.priorities.inactive,
  ]) {
    if (!entry.folder) continue;
    const cached = logsData.logs[entry.folder];
    if (cached && Array.isArray(cached.entries)) {
      entry.log = {
        synthesized: true,
        repoMapped: cached.repoMapped ?? false,
        entries: cached.entries.map((e) => ({
          text: tokenize(e.text),
          date: e.date ?? null,
          repoDerived: e.repoDerived ?? false,
        })),
      };
    }
  }
  snapshot.cacheGeneratedAt = logsData.generatedAt ?? null;
}
