import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import { parseNext } from './next-parser.js';

function load(rel: string): string {
  return readFileSync(
    fileURLToPath(
      new URL(`./__fixtures__/vault/general/projects/${rel}`, import.meta.url),
    ),
    'utf8',
  );
}

describe('parseNext — ledger/next.md (messy general file, no #### groups)', () => {
  const flags: string[] = [];
  const result = parseNext(load('ledger/next.md'), 'ledger/next.md', flags);
  const acts = result.groups[0].activities;

  it('a file with no #### is one ungrouped (header:null) group of 11 activities', () => {
    expect(result.groups.length).toBe(1);
    expect(result.groups[0].header).toBeNull();
    expect(acts.length).toBe(11);
  });

  it('preserves the literal activity number in raw, strips it from render tokens', () => {
    expect(acts[0].text.raw).toBe('1. First metric as an input');
    expect(acts[0].text.tokens).toEqual([{ text: 'First metric as an input' }]);
  });

  it('an empty bullet → bullet "-" with an empty token list, raw preserved', () => {
    const kids = acts[1].children; // activity 2 "Second topic area"
    const empty = kids[kids.length - 1];
    expect(empty.bullet).toBe('-');
    expect(empty.text.tokens).toEqual([]);
    expect(empty.text.raw).toBe('\t-');
  });

  it('a markdown link in activity text tokenizes to an mdlink segment (FU-2 #8)', () => {
    const watch = acts[2]; // "3. Watch: [The Sample Talk](https://…)"
    expect(watch.text.tokens).toEqual([
      { text: 'Watch: ' },
      {
        mdlink: {
          label: 'The Sample Talk',
          href: 'https://example.com/talks/sample-talk',
        },
      },
    ]);
  });

  it('a bare wikilink child tokenizes to a link segment', () => {
    const metaphor = acts[9].children[0]; // "10. Metaphors" → [[sample-metaphor]]
    expect(metaphor.text.tokens).toEqual([
      { link: { target: 'sample-metaphor' } },
    ]);
  });

  it('the clean file yields no parse flags', () => {
    expect(flags).toEqual([]);
  });
});

// Archie 4a-F required add: the single structural edge most likely to break a
// naive parser — nested-numbered sub-items must parse as CHILDREN of their
// activity, never as new top-level activities.
describe('parseNext — nested-numbered children stay children (Archie 4a-F)', () => {
  const result = parseNext(load('ledger/next.md'), 'ledger/next.md', []);
  const acts = result.groups[0].activities;

  it('top-level activity count stays 11 — nested numbers did NOT become activities', () => {
    expect(acts.length).toBe(11);
  });

  it('activity 4 "Compare A vs B" owns its 2 numbered sub-items as children', () => {
    const compare = acts[3];
    expect(compare.text.raw).toBe('4. Compare A vs B');
    expect(compare.children.length).toBe(2);
    expect(compare.children.every((c) => c.bullet === 'num')).toBe(true);
    expect(compare.children[0].depth).toBe(1);
  });

  it('activity 11 "Study materials" owns its 7 numbered + 3 dash sub-items as children', () => {
    const study = acts[10];
    expect(study.text.raw).toBe('11. Study materials');
    expect(study.children.length).toBe(10);
    expect(study.children.slice(0, 7).every((c) => c.bullet === 'num')).toBe(
      true,
    );
    expect(study.children.slice(7).every((c) => c.bullet === '-')).toBe(true);
  });
});

describe('parseNext — ledger/next-coding.md (3-deep nesting with ∙)', () => {
  const result = parseNext(
    load('ledger/next-coding.md'),
    'ledger/next-coding.md',
    [],
  );
  const acts = result.groups[0].activities;

  it('a depth-2 grandchild attaches under its depth-1 parent, not the activity', () => {
    const token = acts[6]; // "7. Token refresh from mobile"
    expect(token.text.raw.startsWith('7.')).toBe(true);
    const endpoints = token.children.find((c) =>
      c.text.raw.includes('endpoints'),
    );
    expect(endpoints).toBeDefined();
    expect(endpoints?.children.length).toBe(2);
    expect(endpoints?.children[0].depth).toBe(2);
    expect(endpoints?.children[0].bullet).toBe('-');
    const firstToken = endpoints?.children[0].text.tokens[0];
    expect(firstToken && 'text' in firstToken && firstToken.text).toContain(
      '∙ GET',
    );
  });

  it('a code span stays literal text; an inline bold run tokenizes (FU-2 #8)', () => {
    const spec = acts[2].children.find((c) => c.text.raw.includes('spec-030'));
    // FU-2 #8 covers Next children: the `**spec-030**` run is a bold token…
    expect(spec?.text.tokens.some((t) => 'bold' in t)).toBe(true);
    // …while the inline `code span` keeps its backticks as literal text.
    const codeText = spec?.text.tokens.find(
      (t) => 'text' in t && t.text.includes('`z_docs/spec-030.md`'),
    );
    expect(codeText).toBeDefined();
  });
});

describe('parseNext — portfolio/next.md (#### groups, decision 13)', () => {
  const flags: string[] = [];
  const result = parseNext(
    load('portfolio/next.md'),
    'portfolio/next.md',
    flags,
  );

  it('keys group boundaries ONLY on #### (3 named groups, no ungrouped top)', () => {
    expect(result.groups.length).toBe(3);
    expect(result.groups.map((g) => g.header?.raw)).toEqual([
      '#### Resolve open decisions',
      '#### Write the document',
      '#### Operational setup',
    ]);
    expect(result.groups[0].header?.tokens).toEqual([
      { text: 'Resolve open decisions' },
    ]);
  });

  it('an activity heading link tokenizes (e.g. [[notes/x#Section Two]])', () => {
    const second = result.groups[0].activities[1];
    const link = second.text.tokens.find((t) => 'link' in t);
    expect(link).toEqual({
      link: {
        target: 'sample-strategies',
        path: 'notes/sample-strategies',
        heading: 'Section Two',
      },
    });
  });

  it('## Notes index is NOT a group boundary — its lines become flagged unparsed items', () => {
    // The trailing "## Notes index" h2 + prose + 3 flat bullets fall into the
    // last #### group as unparsed top-level items (tolerant, never dropped).
    const last = result.groups[2];
    const unparsed = last.activities.filter((a) => a.unparsed);
    expect(unparsed.length).toBe(5);
    expect(flags.length).toBe(5);
    // The two real activities under "Operational setup" are NOT flagged.
    expect(last.activities.filter((a) => !a.unparsed).length).toBe(2);
  });
});

describe('parseNext — edge cases', () => {
  it('an empty next-file (frontmatter only) → no groups, no flags', () => {
    const flags: string[] = [];
    const result = parseNext(load('coral/next.md'), 'coral/next.md', flags);
    expect(result.groups).toEqual([]);
    expect(flags).toEqual([]);
  });

  it('an empty "- " bullet WITH a trailing space → bullet "-", empty tokens', () => {
    const result = parseNext('1. A\n\t- \n', 'x', []);
    const kid = result.groups[0].activities[0].children[0];
    expect(kid.bullet).toBe('-');
    expect(kid.text.tokens).toEqual([]);
  });

  it('a bare "-" bullet (no trailing space) → bullet "-", empty tokens', () => {
    const result = parseNext('1. A\n\t-\n', 'x', []);
    const kid = result.groups[0].activities[0].children[0];
    expect(kid.bullet).toBe('-');
    expect(kid.text.tokens).toEqual([]);
  });

  it('an unindented non-numbered, non-#### line is kept as a flagged unparsed item', () => {
    const flags: string[] = [];
    const result = parseNext('1. A\nloose prose line\n', 'x', flags);
    const acts = result.groups[0].activities;
    expect(acts.length).toBe(2);
    expect(acts[1].unparsed).toBe(true);
    expect(acts[1].text.raw).toBe('loose prose line');
    expect(flags).toEqual(["x: couldn't parse line 2"]);
  });

  it('a <!-- board:ignore --> sentinel stops parsing — trailing section is dropped, no flags', () => {
    const flags: string[] = [];
    const result = parseNext(
      '1. A\n2. B\n<!-- board:ignore -->\n## Notes index\nprose the parser would otherwise flag\n\t- and a stray indented line\n',
      'x',
      flags,
    );
    const acts = result.groups[0].activities;
    expect(acts.length).toBe(2);
    expect(acts.map((a) => a.text.raw)).toEqual(['1. A', '2. B']);
    expect(flags).toEqual([]);
  });

  it('the board:ignore sentinel is tolerant of inner whitespace + case', () => {
    const flags: string[] = [];
    const result = parseNext('1. A\n<!--   BOARD:Ignore   -->\nignored\n', 'x', flags);
    expect(result.groups[0].activities.length).toBe(1);
    expect(flags).toEqual([]);
  });
});
