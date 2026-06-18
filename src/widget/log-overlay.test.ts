import { describe, it, expect } from 'vitest';

import { overlayLogCache, type LogsCache } from './log-overlay.js';
import type { BoardSnapshot, Entry } from './types.js';

// Minimal Entry factory — only the fields overlayLogCache reads/writes matter.
function entry(slug: string, folder: string | null): Entry {
  return {
    label: { raw: slug, tokens: [{ text: slug }] },
    slug,
    folder,
    resolved: folder !== null,
    kind: folder !== null ? 'full' : 'lightweight',
    nextFile: null,
    notePath: null,
    flags: [],
    next: null,
    log: folder !== null ? { synthesized: false, repoMapped: false, entries: [] } : null,
  };
}

function snap(active: Entry[], inactive: Entry[] = []): BoardSnapshot {
  return {
    version: 2,
    widgetId: 'projects-board',
    lastRefreshed: '2026-06-18T12:00:00Z',
    cacheGeneratedAt: null,
    priorities: { active, inactive },
    insights: { standing: [], new: [] },
    parseFlags: [],
  };
}

describe('overlayLogCache — folder-keyed Log cache overlay', () => {
  it('two same-folder entries (Options Coding + Business) share ONE folder-keyed log', () => {
    // Distinct slugs, shared folder `options` — the exact Must-Fix case.
    const coding = entry('options-coding', 'options');
    const business = entry('options-business', 'options');
    const s = snap([coding], [business]);
    const cache: LogsCache = {
      generatedAt: '2026-06-18T09:00:00Z',
      logs: {
        options: {
          repoMapped: true,
          entries: [{ text: 'Shipped the backtester', date: '2026-06-17T00:00:00Z', repoDerived: true }],
        },
      },
    };

    overlayLogCache(s, cache);

    expect(coding.log?.synthesized).toBe(true);
    expect(business.log?.synthesized).toBe(true);
    expect(coding.log?.repoMapped).toBe(true);
    expect(coding.log?.entries).toHaveLength(1);
    expect(coding.log?.entries[0].text.raw).toBe('Shipped the backtester');
    expect(coding.log?.entries[0].repoDerived).toBe(true);
    // Both panels render the same synthesized Log.
    expect(business.log?.entries[0].text.raw).toBe('Shipped the backtester');
    expect(s.cacheGeneratedAt).toBe('2026-06-18T09:00:00Z');
  });

  it('keys by FOLDER, not slug: a cache keyed by slug does NOT match', () => {
    const coding = entry('options-coding', 'options');
    const s = snap([coding]);
    // Cache mistakenly keyed by the slug — must miss (proves folder-keying).
    const cache: LogsCache = {
      generatedAt: '2026-06-18T09:00:00Z',
      logs: { 'options-coding': { repoMapped: true, entries: [{ text: 'x', date: null }] } },
    };

    overlayLogCache(s, cache);

    expect(coding.log?.synthesized).toBe(false);
    expect(coding.log?.entries).toEqual([]);
  });

  it('skips lightweight entries (folder null) — their log stays null', () => {
    const lightweight = entry('refi-mortgage', null);
    const s = snap([lightweight]);
    overlayLogCache(s, { logs: { 'refi-mortgage': { entries: [{ text: 'x', date: null }] } } });
    expect(lightweight.log).toBeNull();
  });

  it('shape-corrupt cache (logs not an object) is a no-op — no throw, no time stamp', () => {
    const full = entry('podvast', 'podvast');
    const s = snap([full]);
    // `logs` missing/malformed — guard must short-circuit before iterating.
    overlayLogCache(s, { generatedAt: '2026-06-18T09:00:00Z' } as unknown as LogsCache);
    expect(full.log?.synthesized).toBe(false);
    expect(s.cacheGeneratedAt).toBeNull();
  });

  it('missing generatedAt on an otherwise-clean overlay → null (not undefined)', () => {
    const full = entry('podvast', 'podvast');
    const s = snap([full]);
    overlayLogCache(s, { logs: { podvast: { repoMapped: false, entries: [{ text: 'hand log', date: null }] } } });
    expect(full.log?.synthesized).toBe(true);
    expect(full.log?.entries[0].repoDerived).toBe(false); // defaults when absent
    expect(s.cacheGeneratedAt).toBeNull();
  });
});
