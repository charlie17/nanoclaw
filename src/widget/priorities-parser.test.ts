import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import { parsePriorities } from './priorities-parser.js';

const prioritiesText = readFileSync(
  fileURLToPath(
    new URL(
      './__fixtures__/vault/general/projects/priorities.md',
      import.meta.url,
    ),
  ),
  'utf8',
);

// The fixture mirrors the live registry's structure (genericized content):
// 4 active, 10 inactive, 4 of which are lightweight (display-only).
const FOLDER_SET = new Set([
  'alpha',
  'ledger',
  'beacon',
  'crafter',
  'portfolio',
  'coral',
  'vitals',
  'flicker',
  'relay',
]);

describe('parsePriorities — the registry fixture', () => {
  const result = parsePriorities(prioritiesText, FOLDER_SET);

  it('parses 4 active + 10 inactive, in file order', () => {
    expect(result.active.map((e) => e.slug)).toEqual([
      'alpha',
      'ledger',
      'beacon',
      'crafter',
    ]);
    expect(result.inactive.length).toBe(10);
  });

  it('a backtick override resolves to its folder + named next-file', () => {
    const coding = result.active[1]; // Ledger (Coding) → `ledger / next-coding.md`
    expect(coding.kind).toBe('full');
    expect(coding.resolved).toBe(true);
    expect(coding.slug).toBe('ledger');
    expect(coding.nextFile).toBe('general/projects/ledger/next-coding.md');
    expect(coding.label.raw).toBe('Ledger (Coding)');
  });

  it('two entries can share one folder with different next-files', () => {
    const coding = result.active[1]; // → next-coding.md
    const business = result.inactive[3]; // Ledger (Business) → `ledger / next.md`
    expect(business.slug).toBe('ledger');
    expect(business.nextFile).toBe('general/projects/ledger/next.md');
    expect(coding.slug).toBe(business.slug);
    expect(coding.nextFile).not.toBe(business.nextFile);
  });

  it('the 4 lightweight entries are resolved:false and NEVER folder-guessed', () => {
    const lightweight = [...result.active, ...result.inactive].filter(
      (e) => !e.resolved,
    );
    expect(lightweight.map((e) => e.label.raw)).toEqual([
      'Sample Study',
      'Reference list: [first ref](http://localhost:9000/read/aaa) and [second ref](http://localhost:9000/read/bbb)',
      'Brainstorm: sample topic exploration, write it up',
      'Sample Certification',
    ]);
    for (const e of lightweight) {
      expect(e.kind).toBe('lightweight');
      expect(e.nextFile).toBeNull();
      expect(e.next).toBeNull();
      expect(e.log).toBeNull();
      expect(e.flags.length).toBeGreaterThan(0);
    }
  });

  it('a lightweight label with markdown links keeps them as literal text (not link tokens)', () => {
    const ref = result.inactive.find((e) =>
      e.label.raw.startsWith('Reference list'),
    );
    expect(ref?.label.tokens).toEqual([{ text: ref?.label.raw }]);
  });

  it('a resolved label tokenizes plainly', () => {
    expect(result.active[0].label).toEqual({
      raw: 'Alpha',
      tokens: [{ text: 'Alpha' }],
    });
  });

  it('the clean registry produces no global parse flags', () => {
    expect(result.parseFlags).toEqual([]);
  });
});

describe('parsePriorities — capability cases (synthetic)', () => {
  it('→ note: <path> makes a pointer entry (resolved:false, no next/log)', () => {
    const result = parsePriorities(
      '- Active\n\t1. Onboarding briefing → note: general/notes/onboarding.md\n',
      new Set(),
    );
    const entry = result.active[0];
    expect(entry.kind).toBe('pointer');
    expect(entry.notePath).toBe('general/notes/onboarding.md');
    expect(entry.resolved).toBe(false);
    expect(entry.nextFile).toBeNull();
    expect(entry.next).toBeNull();
    expect(entry.log).toBeNull();
  });

  it('an override whose folder is missing is flagged, not guessed', () => {
    const result = parsePriorities(
      '- Active\n\t1. Ghost → `ghost / next.md`\n',
      new Set(['real']),
    );
    const entry = result.active[0];
    expect(entry.resolved).toBe(false);
    expect(entry.kind).toBe('lightweight');
    expect(entry.nextFile).toBeNull();
    expect(entry.flags.some((f) => f.includes('ghost'))).toBe(true);
  });

  it('a bare label whose slug matches no folder is lightweight (display-only)', () => {
    const result = parsePriorities(
      '- Inactive\n\t1. Poker Study\n',
      new Set(['alpha']),
    );
    expect(result.inactive[0].slug).toBe('poker-study');
    expect(result.inactive[0].resolved).toBe(false);
    expect(result.inactive[0].kind).toBe('lightweight');
  });

  it('space-indented entries parse the same as tab-indented (Vera Should-Fix)', () => {
    const result = parsePriorities(
      '- Active\n  1. Alpha\n  2. Beacon\n',
      new Set(['alpha', 'beacon']),
    );
    expect(result.active.map((e) => e.slug)).toEqual(['alpha', 'beacon']);
    expect(result.active.every((e) => e.resolved)).toBe(true);
    expect(result.parseFlags).toEqual([]);
  });
});
