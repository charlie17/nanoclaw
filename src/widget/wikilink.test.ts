import { describe, it, expect } from 'vitest';

import { tokenize } from './wikilink.js';

describe('tokenize — wikilink flavors (decision 12)', () => {
  it('bare [[t]]', () => {
    expect(tokenize('see [[note]] here').tokens).toEqual([
      { text: 'see ' },
      { link: { target: 'note' } },
      { text: ' here' },
    ]);
  });

  it('alias [[t|alias]]', () => {
    expect(tokenize('[[note|Display Text]]').tokens).toEqual([
      { link: { target: 'note', alias: 'Display Text' } },
    ]);
  });

  it('heading [[t#h]]', () => {
    expect(tokenize('[[note#Section Two]]').tokens).toEqual([
      { link: { target: 'note', heading: 'Section Two' } },
    ]);
  });

  it('path [[path/t]] — target is basename, path is the full slug', () => {
    expect(tokenize('[[a/b/note]]').tokens).toEqual([
      { link: { target: 'note', path: 'a/b/note' } },
    ]);
  });

  it('leading punctuation [[!principles]]', () => {
    expect(tokenize('[[!principles]]').tokens).toEqual([
      { link: { target: '!principles' } },
    ]);
  });

  it('spaces [[Two Words]]', () => {
    expect(tokenize('[[Trade Busters]]').tokens).toEqual([
      { link: { target: 'Trade Busters' } },
    ]);
  });

  it('combined path#heading|alias', () => {
    expect(tokenize('[[a/b/note#Heading|Alias text]]').tokens).toEqual([
      {
        link: {
          target: 'note',
          path: 'a/b/note',
          heading: 'Heading',
          alias: 'Alias text',
        },
      },
    ]);
  });

  it('multiple links in one run, with text between', () => {
    expect(tokenize('[[a]] and [[b]]').tokens).toEqual([
      { link: { target: 'a' } },
      { text: ' and ' },
      { link: { target: 'b' } },
    ]);
  });
});

describe('tokenize — must NOT touch non-wikilink constructs', () => {
  it('markdown link stays a single literal text run', () => {
    const raw = 'see [here](https://example.com/x) now';
    expect(tokenize(raw).tokens).toEqual([{ text: raw }]);
  });

  it('bare URL stays literal text', () => {
    const raw = 'visit https://example.com/path?q=1 today';
    expect(tokenize(raw).tokens).toEqual([{ text: raw }]);
  });

  it('code span stays literal text', () => {
    const raw = 'run `z_docs/spec-030.md` first';
    expect(tokenize(raw).tokens).toEqual([{ text: raw }]);
  });

  it('a wikilink adjacent to a markdown link splits cleanly without eating the md-link', () => {
    expect(tokenize('[[a]] then [x](y)').tokens).toEqual([
      { link: { target: 'a' } },
      { text: ' then [x](y)' },
    ]);
  });
});

describe('tokenize — invariants', () => {
  it('empty string → empty token list', () => {
    expect(tokenize('').tokens).toEqual([]);
  });

  it('always preserves raw verbatim', () => {
    const raw = '[[a/b#c|d]] x [e](f) `g`';
    expect(tokenize(raw).raw).toBe(raw);
  });
});
