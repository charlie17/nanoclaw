import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import { buildProjectsBoardSnapshot } from './snapshot.js';

// Real fs against the genericized fixture vault (this file does NOT mock fs).
const VAULT_ROOT = fileURLToPath(
  new URL('./__fixtures__/vault', import.meta.url),
);

describe('buildProjectsBoardSnapshot', () => {
  it('assembles the frozen schema header + priorities in file order', async () => {
    const snap = await buildProjectsBoardSnapshot(VAULT_ROOT);
    expect(snap.version).toBe(1);
    expect(snap.widgetId).toBe('projects-board');
    expect(typeof snap.lastRefreshed).toBe('string');
    expect(Number.isNaN(Date.parse(snap.lastRefreshed))).toBe(false);
    expect(snap.priorities.active.map((e) => e.slug)).toEqual([
      'alpha',
      'ledger',
      'beacon',
      'crafter',
    ]);
    expect(snap.priorities.inactive.length).toBe(10);
  });

  it('full entries are enriched with next + log; lightweight stay null', async () => {
    const snap = await buildProjectsBoardSnapshot(VAULT_ROOT);

    const alpha = snap.priorities.active[0];
    expect(alpha.kind).toBe('full');
    expect(alpha.next?.groups[0].activities.length).toBe(4);
    expect(alpha.log?.synthesized).toBe(false);

    const lightweight = snap.priorities.inactive.find(
      (e) => e.slug === 'sample-study',
    );
    expect(lightweight?.resolved).toBe(false);
    expect(lightweight?.next).toBeNull();
    expect(lightweight?.log).toBeNull();
  });

  it('one folder, two next-files: coding vs business resolve correctly', async () => {
    const snap = await buildProjectsBoardSnapshot(VAULT_ROOT);
    const coding = snap.priorities.active[1]; // Ledger (Coding) → next-coding.md
    const business = snap.priorities.inactive[3]; // Ledger (Business) → next.md
    expect(coding.nextFile).toBe('general/projects/ledger/next-coding.md');
    expect(business.nextFile).toBe('general/projects/ledger/next.md');
    expect(coding.next?.groups[0].activities[0].text.raw).toBe(
      '1. First finalization track',
    );
    expect(business.next?.groups[0].activities.length).toBe(11);
  });

  it('a wikilink inside loaded next text survives as a link token', async () => {
    const snap = await buildProjectsBoardSnapshot(VAULT_ROOT);
    const alpha = snap.priorities.active[0];
    const linkActivity = alpha.next?.groups[0].activities[3]; // [[projects/alpha/notes/...|...]]
    const link = linkActivity?.text.tokens.find((t) => 'link' in t);
    expect(link).toEqual({
      link: {
        target: 'alpha-2026-01-01-references',
        path: 'projects/alpha/notes/alpha-2026-01-01-references',
        alias: 'Reference exemplars to consider',
      },
    });
  });

  it('log = raw last-5 lines, un-synthesized (deep nesting preserved verbatim)', async () => {
    const snap = await buildProjectsBoardSnapshot(VAULT_ROOT);
    const beacon = snap.priorities.active[2];
    expect(beacon.log?.synthesized).toBe(false);
    expect(beacon.log?.entries.length).toBe(5);
    expect(beacon.log?.entries[beacon.log.entries.length - 1]).toContain(
      'Note:',
    );
  });

  it('a frontmatter-only log → empty entries (the YAML header is not a log line)', async () => {
    const snap = await buildProjectsBoardSnapshot(VAULT_ROOT);
    const relay = snap.priorities.inactive.find((e) => e.slug === 'relay');
    expect(relay?.log?.entries).toEqual([]);
  });

  it('#### groups survive assembly; ## Notes index is not a boundary', async () => {
    const snap = await buildProjectsBoardSnapshot(VAULT_ROOT);
    const portfolio = snap.priorities.inactive[0];
    expect(portfolio.slug).toBe('portfolio');
    expect(portfolio.next?.groups.length).toBe(3);
  });

  it('parseFlags surfaces the portfolio trailing-section unparsed lines (tolerant)', async () => {
    const snap = await buildProjectsBoardSnapshot(VAULT_ROOT);
    expect(snap.parseFlags.some((f) => f.startsWith('portfolio/next.md'))).toBe(
      true,
    );
  });
});
