import { describe, it, expect } from 'vitest';

import { tokenize } from '../wikilink.js';
import { flattenTokens, normalizeTitleText, tokenizeV2 } from './tokenize.js';

// All strings here are verbatim fragments of the live vault (fixtures-live-vault
// capture, 2026-08-18) unless a case is explicitly synthetic.

describe('tokenizeV2 — v1 passthrough (must not regress v1 behaviour)', () => {
  it('wikilink / md-link / bold tokens are byte-identical to v1', () => {
    const raw =
      '**Add market cap as % of GDP as recession indicator** — see [[notes/fi-master-frameworks-mental-models]] (Sun 5/3/26)';
    expect(tokenizeV2(raw)).toEqual(tokenize(raw).tokens);
  });

  it('an unsafe md-link href still falls back to literal text (v1 sanitizer)', () => {
    const raw = '[x](javascript:alert(1))';
    // Whatever v1 does with it, v2 must do identically — and no link is emitted.
    expect(tokenizeV2(raw)).toEqual(tokenize(raw).tokens);
    expect(tokenizeV2(raw).some((t) => 'mdlink' in t || 'link' in t)).toBe(
      false,
    );
  });

  it('empty input yields an empty token list', () => {
    expect(tokenizeV2('')).toEqual([]);
  });
});

describe('tokenizeV2 — bare URL linkification (D15)', () => {
  it('splits a trailing bare URL out of its text run (fi-master #1)', () => {
    expect(
      tokenizeV2(
        'Add this as a link: https://www.macrotrends.net/2324/sp-500-historical-chart-data',
      ),
    ).toEqual([
      { text: 'Add this as a link: ' },
      {
        mdlink: {
          label:
            'https://www.macrotrends.net/2324/sp-500-historical-chart-data',
          href: 'https://www.macrotrends.net/2324/sp-500-historical-chart-data',
        },
      },
    ]);
  });

  it('keeps the text on both sides of an interior URL (leanspec #3)', () => {
    expect(
      tokenizeV2('Alibaba https://open-codereview.ai/ - need to BYO agent'),
    ).toEqual([
      { text: 'Alibaba ' },
      {
        mdlink: {
          label: 'https://open-codereview.ai/',
          href: 'https://open-codereview.ai/',
        },
      },
      { text: ' - need to BYO agent' },
    ]);
  });

  it('linkifies two bare URLs in one run (fi-master #3)', () => {
    const tokens = tokenizeV2(
      'A: Found it: https://cashoptimizer.pages.dev/MM/all-rates.csv and https://cashoptimizer.pages.dev/Funds/all-rates.csv',
    );
    expect(tokens.filter((t) => 'mdlink' in t)).toHaveLength(2);
  });

  it('does NOT re-linkify a URL already inside an md-link href', () => {
    const tokens = tokenizeV2(
      'See [here](https://en.macromicro.me/charts/406/us-buffet-index-gspc) now',
    );
    expect(tokens).toEqual([
      { text: 'See ' },
      {
        mdlink: {
          label: 'here',
          href: 'https://en.macromicro.me/charts/406/us-buffet-index-gspc',
        },
      },
      { text: ' now' },
    ]);
  });

  it('strips trailing sentence punctuation off the href, keeping it as text', () => {
    // Synthetic: prose punctuation immediately after a URL.
    expect(
      tokenizeV2('Pod with math: https://overcast.fm/+I6zHgSzlo.'),
    ).toEqual([
      { text: 'Pod with math: ' },
      {
        mdlink: {
          label: 'https://overcast.fm/+I6zHgSzlo',
          href: 'https://overcast.fm/+I6zHgSzlo',
        },
      },
      { text: '.' },
    ]);
  });

  it('a parenthesized URL keeps its closing paren out of the href', () => {
    expect(tokenizeV2('(see https://x.example.com/a)')).toEqual([
      { text: '(see ' },
      {
        mdlink: {
          label: 'https://x.example.com/a',
          href: 'https://x.example.com/a',
        },
      },
      { text: ')' },
    ]);
  });

  it('non-http schemes are never auto-linkified', () => {
    expect(tokenizeV2('run javascript:alert(1) here')).toEqual([
      { text: 'run javascript:alert(1) here' },
    ]);
  });
});

describe('flattenTokens / normalizeTitleText', () => {
  it('a wikilink contributes its alias, else its target', () => {
    expect(
      flattenTokens(tokenizeV2('New Theo-Based Setup - [[LeanSpec-v2026-08]]')),
    ).toBe('New Theo-Based Setup - LeanSpec-v2026-08');
    expect(flattenTokens(tokenizeV2('[[notes/thing|Nice name]]'))).toBe(
      'Nice name',
    );
  });

  it('md-links contribute their label; bold contributes its inner run', () => {
    expect(
      flattenTokens(tokenizeV2('**AA framework** — [here](https://a.b)')),
    ).toBe('AA framework — here');
  });

  it('collapses internal whitespace and trims', () => {
    expect(normalizeTitleText('  Path   to \t v3  ')).toBe('Path to v3');
  });
});
