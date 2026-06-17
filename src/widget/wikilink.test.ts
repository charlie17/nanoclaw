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

describe('tokenize — markdown links + bold (FU-2 #8)', () => {
  it('a markdown link becomes an mdlink token', () => {
    expect(tokenize('see [here](https://example.com/x) now').tokens).toEqual([
      { text: 'see ' },
      { mdlink: { label: 'here', href: 'https://example.com/x' } },
      { text: ' now' },
    ]);
  });

  it('a bold run becomes a bold token', () => {
    expect(tokenize('this is **important** stuff').tokens).toEqual([
      { text: 'this is ' },
      { bold: 'important' },
      { text: ' stuff' },
    ]);
  });

  it('a wikilink adjacent to a markdown link splits cleanly (both tokenized)', () => {
    expect(tokenize('[[a]] then [x](y)').tokens).toEqual([
      { link: { target: 'a' } },
      { text: ' then ' },
      { mdlink: { label: 'x', href: 'y' } },
    ]);
  });

  it('wikilink → md-link → bold all coexist in one run, leftmost-first', () => {
    expect(tokenize('[[w]] a [l](http://e.com) b **c** d').tokens).toEqual([
      { link: { target: 'w' } },
      { text: ' a ' },
      { mdlink: { label: 'l', href: 'http://e.com' } },
      { text: ' b ' },
      { bold: 'c' },
      { text: ' d' },
    ]);
  });
});

describe('tokenize — md-link href sanitization (FU-2 #8 security)', () => {
  it('http/https/obsidian/mailto + relative hrefs are allowed', () => {
    expect(tokenize('[a](https://x.com)').tokens).toEqual([
      { mdlink: { label: 'a', href: 'https://x.com' } },
    ]);
    expect(tokenize('[b](obsidian://open?file=n)').tokens).toEqual([
      { mdlink: { label: 'b', href: 'obsidian://open?file=n' } },
    ]);
    expect(tokenize('[c](mailto:jt@example.com)').tokens).toEqual([
      { mdlink: { label: 'c', href: 'mailto:jt@example.com' } },
    ]);
    expect(tokenize('[d](/relative/path)').tokens).toEqual([
      { mdlink: { label: 'd', href: '/relative/path' } },
    ]);
  });

  it('javascript: / data: / other dangerous schemes fall back to literal text', () => {
    expect(tokenize('[x](javascript:alert(1))').tokens).toEqual([
      { text: '[x](javascript:alert(1)' },
      { text: ')' },
    ]);
    expect(
      tokenize('click [evil](data:text/html,<script>) here').tokens,
    ).toEqual([
      { text: 'click ' },
      { text: '[evil](data:text/html,<script>)' },
      { text: ' here' },
    ]);
  });

  it('control-char obfuscated javascript: falls back to literal text (FU-2 #8 bypass fix)', () => {
    // "java\tscript:alert(1)" — tab in the scheme defeats a naive regex but
    // browsers strip it before evaluating, so it executes. sanitizeHref must
    // strip [\x00-\x20] first so the scheme check still catches it.
    // The md-link regex captures href up to the first ')' so the match is
    // '[x](java\tscript:alert(1)' and the trailing ')' is leftover text.
    expect(tokenize('[x](java\tscript:alert(1))').tokens).toEqual([
      { text: '[x](java\tscript:alert(1)' },
      { text: ')' },
    ]);
    // Leading space before "javascript:" — same bypass: trim() removes it but
    // that's fine because sanitizeHref trims then strips controls; either way
    // cleaned = "javascript:alert(1" → blocked.
    expect(tokenize('[x]( javascript:alert(1))').tokens).toEqual([
      { text: '[x]( javascript:alert(1)' },
      { text: ')' },
    ]);
  });
});

describe('tokenize — still does NOT touch non-link constructs', () => {
  it('bare URL stays literal text', () => {
    const raw = 'visit https://example.com/path?q=1 today';
    expect(tokenize(raw).tokens).toEqual([{ text: raw }]);
  });

  it('code span stays literal text', () => {
    const raw = 'run `z_docs/spec-030.md` first';
    expect(tokenize(raw).tokens).toEqual([{ text: raw }]);
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
