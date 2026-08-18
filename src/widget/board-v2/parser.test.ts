import { describe, it, expect } from 'vitest';

import { findSplitColon, parseNextV2 } from './parser.js';
import { KEY_SEP } from './types.js';
import type { CardV2 } from './types.js';

// Every fixture below is a VERBATIM excerpt of a live next.md (captured
// 2026-08-18, deploy/widgets/projects-board-v2/fixtures-live-vault.txt) unless
// the test says "synthetic". Lines are joined from an array so the tab
// indentation the vault actually uses is unambiguous in source.
const FM = ['---', 'type: project', 'project: x', 'status: active', '---'];

function parse(lines: string[], folder = 'x') {
  const flags: string[] = [];
  const cards = parseNextV2(
    [...FM, ...lines].join('\n'),
    folder,
    `${folder}/next.md`,
    flags,
  );
  return { cards, flags };
}

function byTitle(cards: CardV2[], title: string): CardV2 {
  const card = cards.find((c) => c.titleText === title);
  if (!card) throw new Error(`no card titled "${title}"`);
  return card;
}

// ── daystrom/next.md ─────────────────────────────────────────────────────────

describe('parseNextV2 — daystrom/next.md', () => {
  const { cards, flags } = parse(
    [
      '1. Redo wiki (TBD): See [Farzaa skill](https://gist.github.com/farzaa/c35ac0cfbeb957788650e36aabea836d) - seems to support bulk processing',
      '2. Projects Board v2',
      '\t- Use widget skill to build a Kanban. It knows/grabs the project. The card title = either the main bullet (if there are subbullets) or what precedes the colon (if there are no subbullets)',
      '\t- The v1 log synthesis is really helpful. Yet it does not appear as such in obsidian',
      "3. O'Brien changes",
      '\t- Audit his fetch behavior for the WebFetch failure mode:',
      '\t\t- Trigger: [Reddit PSA](https://read.readwise.io/read/01kzhaej2m8h4e31p4df0mknsp) — Claude Code’s `WebFetch` tool uses a smaller Haiku-tier model as a summarization middleware',
      "\t\t- Ask Archie to inspect O'Brien's actual host-side code and confirm: does it do a follow-up fetch on surfaced URLs? If yes, with what tool?",
      '\t- Fix the fact that he has a character limit in his output',
      "4. Server hardening + backup steps: Identified Fri 7/3/26 - it's in Archie's checkpoint - just run it w him",
      '5. Google Knowledge Catalog / OKF (TBD)',
      '\t- https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/README.md - Google looking to standardize the wiki method as OKF',
      '6. Path to v3',
      '\t- See 2 PDFs: Links: [main file](https://drive.google.com/file/d/1C7Um-B8O0DaywnfiZgsh7GsHgJFqRmXH/view?usp=drive_link) and [tavily piece](https://drive.google.com/file/d/1k4brF2isDOTmDHq85z4gXrDCJk_2rlz1/view?usp=drive_link)',
    ],
    'daystrom',
  );

  it('yields one card per top-level numbered item, in file order', () => {
    expect(cards.map((c) => c.titleText)).toEqual([
      'Redo wiki (TBD)',
      'Projects Board v2',
      "O'Brien changes",
      'Server hardening + backup steps',
      'Google Knowledge Catalog / OKF (TBD)',
      'Path to v3',
    ]);
  });

  it('#1 — R2: splits at the colon BEFORE the md-link, content keeps the link', () => {
    const card = byTitle(cards, 'Redo wiki (TBD)');
    expect(card.content).toHaveLength(1);
    expect(card.content[0].bullet).toBe('other');
    expect(card.content[0].depth).toBe(1);
    expect(card.content[0].tokens).toEqual([
      { text: 'See ' },
      {
        mdlink: {
          label: 'Farzaa skill',
          href: 'https://gist.github.com/farzaa/c35ac0cfbeb957788650e36aabea836d',
        },
      },
      { text: ' - seems to support bulk processing' },
    ]);
  });

  it('#2 — R1: children win, the title is the whole item text', () => {
    const card = byTitle(cards, 'Projects Board v2');
    expect(card.content).toHaveLength(2);
    expect(card.content.every((n) => n.bullet === '-')).toBe(true);
    expect(card.content.every((n) => n.depth === 1)).toBe(true);
  });

  it('#3 — R1 with three levels: depth-2 children nest under their depth-1 parent', () => {
    const card = byTitle(cards, "O'Brien changes");
    expect(card.content).toHaveLength(2);
    expect(card.content[0].children).toHaveLength(2);
    expect(card.content[0].children[0].depth).toBe(2);
    // A colon inside a CHILD is never a splitter — R2 applies to items only.
    expect(card.content[0].tokens).toEqual([
      { text: 'Audit his fetch behavior for the WebFetch failure mode:' },
    ]);
  });

  it('#4 — R2 plain: everything after the first colon becomes the content', () => {
    const card = byTitle(cards, 'Server hardening + backup steps');
    expect(card.content[0].tokens).toEqual([
      {
        text: "Identified Fri 7/3/26 - it's in Archie's checkpoint - just run it w him",
      },
    ]);
  });

  it('#5 — a bare-URL child is linkified (R1, not R2: the item has children)', () => {
    const card = byTitle(cards, 'Google Knowledge Catalog / OKF (TBD)');
    expect(card.content[0].tokens[0]).toEqual({
      mdlink: {
        label:
          'https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/README.md',
        href: 'https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/README.md',
      },
    });
  });

  it('#6 — md-links inside children survive as mdlink tokens', () => {
    const card = byTitle(cards, 'Path to v3');
    const mdlinks = card.content[0].tokens.filter((t) => 'mdlink' in t);
    expect(mdlinks).toHaveLength(2);
  });

  it('keys are folder␟titleText and the file parses flag-free', () => {
    expect(cards[0].key).toBe(`daystrom${KEY_SEP}Redo wiki (TBD)`);
    expect(flags).toEqual([]);
  });
});

// ── leanspec/next.md — checkboxes (E5) + wikilink-only title ─────────────────

describe('parseNextV2 — leanspec/next.md', () => {
  const { cards, flags } = parse(
    [
      '1. New Theo-Based Setup - [[LeanSpec-v2026-08.canvas]]',
      '3. Separate review agent',
      '\t- [x] Need to replace (or at least supplement) CharlieLabs',
      '\t- [x] Alibaba https://open-codereview.ai/ - need to BYO agent - but purpose built for reviewing',
      '\t- [ ] Codex as code reviewer - [reddit](https://www.reddit.com/r/ClaudeAI/s/O9IBkxSJJk)',
      '4. Fable pivot idea',
      '\t- [X] Theo - the codex app is far superior to codex cli',
      '\t- [ ] See TMT core repo improvements ',
      '\t- Options Archie',
      "\t\t- It's captured as deletions from my own instructions, not additions.",
      '5. Compound learnings as skills (TBD): So each is an atomic skill, invoked via progressive disclosure vs clogging up context, and when a new one comes up it is weighed against the existing and either added, folded into existing, or discarded if redundant. How does the Every repo handle this?',
    ],
    'leanspec',
  );

  it('#1 — a title ending in a wikilink is R3, flattened via the link target', () => {
    const card = cards[0];
    expect(card.titleText).toBe(
      'New Theo-Based Setup - LeanSpec-v2026-08.canvas',
    );
    expect(card.content).toEqual([]);
    expect(card.title.some((t) => 'link' in t)).toBe(true);
  });

  it('#3 — mixed [x]/[ ] children set checkbox and strip the marker (E5)', () => {
    const card = byTitle(cards, 'Separate review agent');
    expect(card.content.map((n) => n.checkbox)).toEqual([
      'checked',
      'checked',
      'unchecked',
    ]);
    expect(card.content[0].tokens).toEqual([
      { text: 'Need to replace (or at least supplement) CharlieLabs' },
    ]);
    expect(card.content.every((n) => n.bullet === '-')).toBe(true);
  });

  it('#3 — a bare URL inside a checkbox child is still linkified', () => {
    const card = byTitle(cards, 'Separate review agent');
    expect(card.content[1].tokens[1]).toEqual({
      mdlink: {
        label: 'https://open-codereview.ai/',
        href: 'https://open-codereview.ai/',
      },
    });
  });

  it('#4 — `[X]` (upper case) is checked; a plain `-` child has checkbox null', () => {
    const card = byTitle(cards, 'Fable pivot idea');
    expect(card.content.map((n) => n.checkbox)).toEqual([
      'checked',
      'unchecked',
      null,
    ]);
    expect(card.content[2].children).toHaveLength(1);
  });

  it('#5 — a very long R2 remainder splits at the FIRST colon only (D14)', () => {
    const card = byTitle(cards, 'Compound learnings as skills (TBD)');
    expect(card.content).toHaveLength(1);
    expect(card.content[0].tokens).toEqual([
      {
        text: 'So each is an atomic skill, invoked via progressive disclosure vs clogging up context, and when a new one comes up it is weighed against the existing and either added, folded into existing, or discarded if redundant. How does the Every repo handle this?',
      },
    ]);
  });

  it('parses flag-free', () => {
    expect(flags).toEqual([]);
  });
});

// ── fi-master/next.md — wikilinks, bold, bare URLs, depth-2 ─────────────────

describe('parseNextV2 — fi-master/next.md', () => {
  const { cards } = parse(
    [
      '1. Historicals dash',
      '\t- Add this as a link: https://www.macrotrends.net/2324/sp-500-historical-chart-data',
      '\t- CAPE percentile since 2020 and all time. Red if > 90',
      '\t- Buffet Indicator. Stock market / GDP (“the economy”) - [here](https://en.macromicro.me/charts/406/us-buffet-index-gspc) and [here](https://www.currentmarketvaluation.com/models/buffett-indicator.php)',
      '\t\t- **Add market cap as % of GDP as recession indicator** — see [[notes/fi-master-frameworks-mental-models]] (Sun 5/3/26)',
      '\t- **AA framework** — work through Mispriced Assets institutional-grade portfolio + Oaktree memo. See [[notes/fi-master-asset-allocation]] (Sun 5/3/26)',
      '12. LLC operating agreements',
      '17. Tools to evaluate',
      '\t1. **ProjectionLab** — see [[notes/fi-master-tools-calculators]] (Sun 5/3/26)',
      '\t2. **Maxifi** — see [[notes/fi-master-tools-calculators]] (Sun 5/3/26)',
    ],
    'fi-master',
  );

  it('#1 — the bare-URL child linkifies; the md-link child keeps both links', () => {
    const card = byTitle(cards, 'Historicals dash');
    expect(card.content).toHaveLength(4);
    expect(card.content[0].tokens[1]).toMatchObject({
      mdlink: {
        href: 'https://www.macrotrends.net/2324/sp-500-historical-chart-data',
      },
    });
    expect(card.content[2].tokens.filter((t) => 'mdlink' in t)).toHaveLength(2);
  });

  it('#1 — a depth-2 child nests and carries bold + wikilink tokens', () => {
    const card = byTitle(cards, 'Historicals dash');
    const nested = card.content[2].children[0];
    expect(nested.depth).toBe(2);
    expect(nested.tokens[0]).toEqual({
      bold: 'Add market cap as % of GDP as recession indicator',
    });
    expect(nested.tokens.some((t) => 'link' in t)).toBe(true);
  });

  it('#12 — R3: no children, no colon → title only, empty content', () => {
    const card = byTitle(cards, 'LLC operating agreements');
    expect(card.content).toEqual([]);
    expect(card.contentHash).toMatch(/^[0-9a-f]{12}$/);
  });

  it('#17 — nested-NUMBERED children stay children with bullet "num"', () => {
    const card = byTitle(cards, 'Tools to evaluate');
    expect(card.content).toHaveLength(2);
    expect(card.content.every((n) => n.bullet === 'num')).toBe(true);
    expect(card.content[0].tokens[0]).toEqual({ bold: 'ProjectionLab' });
  });
});

// ── podvast + options — numbered children, 3-deep sub-tree ───────────────────

describe('parseNextV2 — podvast/next.md', () => {
  const { cards } = parse(
    [
      '1. Public app ideas',
      '\t1. Flip it. Podvast as the central hub and it pushes out vs pulling in. Problem: how do we get listened state?',
      '\t2. OR - become video podcast centric - inline YouTube playback or link out to YT? ',
      '\t3. OR - actually turn it into a full and true podcatcher',
      '2. Pull transcripts at will via Apple API? See [here](https://blog.alexbeals.com/posts/downloading-arbitrary-apple-podcast-episode-transcripts)',
    ],
    'podvast',
  );

  it('numbered children under a numbered top item are children, not new cards', () => {
    expect(cards.map((c) => c.titleText)).toEqual([
      'Public app ideas',
      'Pull transcripts at will via Apple API? See here',
    ]);
    expect(cards[0].content).toHaveLength(3);
    expect(cards[0].content[0].bullet).toBe('num');
  });

  it('a colon inside a numbered CHILD does not split anything', () => {
    expect(cards[0].content[0].tokens).toEqual([
      {
        text: 'Flip it. Podvast as the central hub and it pushes out vs pulling in. Problem: how do we get listened state?',
      },
    ]);
  });

  it('#2 — an item whose only colon is inside a md-link href is R3', () => {
    expect(cards[1].content).toEqual([]);
  });
});

describe('parseNextV2 — options/next.md (3-deep sub-tree)', () => {
  const { cards, flags } = parse(
    [
      '1. Coding - Options 2027 app build',
      '\t- Run a `/code-review ultra` when done',
      '\t- Token refresh from mobile',
      '\t\t- The following needs to be built:',
      '\t\t- There wasn’t a web-accessible way to trigger token refresh before',
      '\t\t- The code I added creates the two new API endpoints that make it possible over HTTP:',
      '\t\t\t- ∙ GET /api/tokens/auth-url — didn’t exist before',
      '\t\t\t- ∙ POST /api/tokens/refresh — didn’t exist before',
      '2. Coding - Principles/Primitives file',
      '\t- [[!principles]]',
    ],
    'options',
  );

  it('depth 1 → 2 → 3 all nest correctly under one card', () => {
    const card = cards[0];
    expect(card.content).toHaveLength(2);
    const tokenRefresh = card.content[1];
    expect(tokenRefresh.children).toHaveLength(3);
    expect(tokenRefresh.children[2].children).toHaveLength(2);
    expect(tokenRefresh.children[2].children[0].depth).toBe(3);
  });

  it('a wikilink-only child tokenizes to a single link token', () => {
    expect(cards[1].content[0].tokens).toEqual([
      { link: { target: '!principles' } },
    ]);
  });

  it('parses flag-free', () => {
    expect(flags).toEqual([]);
  });
});

// ── Structural edges (SPEC §2.1 rules 2, 7, 8) ───────────────────────────────

describe('parseNextV2 — structural edges', () => {
  it('space-indented children work, with the level width inferred from the file', () => {
    // Synthetic: the live vault indents with tabs; v2 must also accept spaces.
    const { cards, flags } = parse([
      '1. Historicals dash',
      '  - CAPE percentile since 2020',
      '    - nested under CAPE',
      '  - Pull daily 2Y treas',
    ]);
    expect(cards[0].content).toHaveLength(2);
    expect(cards[0].content[0].children).toHaveLength(1);
    expect(cards[0].content[0].children[0].depth).toBe(2);
    expect(flags).toEqual([]);
  });

  it('mixed tab+space indent lets tabs win, and flags the line', () => {
    const { cards, flags } = parse([
      '1. Historicals dash',
      '\t - CAPE percentile since 2020',
    ]);
    expect(cards[0].content[0].depth).toBe(1);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toContain('mixed tab+space');
  });

  // Vera SF6 — a next.md edited on Windows (or round-tripped through a tool
  // that rewrites line endings) must parse identically, not collapse into a
  // file full of unparsed cards.
  it('a CRLF file yields exactly the same cards as the LF original', () => {
    const lines = [
      '1. Path to v3',
      '\t- Come back to build this Claude native when the time is right',
      '\t\t- **Note** — see [[notes/path-z]]',
      '2. Server hardening + backup steps: Identified Fri 7/3/26',
      '3. LLC operating agreements',
    ];
    const lf = parse(lines);
    const flags: string[] = [];
    const crlf = parseNextV2(
      [...FM, ...lines].join('\r\n'),
      'x',
      'x/next.md',
      flags,
    );
    expect(crlf).toEqual(lf.cards);
    expect(flags).toEqual([]);
  });

  it('a MIXED CRLF/LF file parses cleanly too', () => {
    const flags: string[] = [];
    const cards = parseNextV2(
      [...FM, '1. Path to v3', '\t- one child'].join('\n') +
        '\r\n2. LLC operating agreements\r\n',
      'x',
      'x/next.md',
      flags,
    );
    expect(cards.map((c) => c.titleText)).toEqual([
      'Path to v3',
      'LLC operating agreements',
    ]);
    expect(cards.every((c) => c.unparsed === undefined)).toBe(true);
    expect(flags).toEqual([]);
  });

  it('a `-` top-level bullet is a card, same as a numbered one', () => {
    const { cards } = parse([
      '- Dailies dash',
      '\t- Recession indicators move here',
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0].titleText).toBe('Dailies dash');
    expect(cards[0].content).toHaveLength(1);
  });

  it('`<!-- board:ignore -->` stops parsing, silently, at that line', () => {
    const { cards, flags } = parse([
      '1. Path to v3',
      '<!--  BOARD:IGNORE  -->',
      '2. Never shown',
      '## a header that would otherwise flag',
    ]);
    expect(cards.map((c) => c.titleText)).toEqual(['Path to v3']);
    expect(flags).toEqual([]);
  });

  it('a `####` line is skipped with a flag (v2 has no groups)', () => {
    const { cards, flags } = parse([
      '#### Coding',
      '1. Coding - Security considerations',
    ]);
    expect(cards.map((c) => c.titleText)).toEqual([
      'Coding - Security considerations',
    ]);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toContain('header line skipped');
  });

  it('an unclassifiable column-0 line is kept as an unparsed card + flagged', () => {
    const { cards, flags } = parse(['Some stray prose line', '1. Real card']);
    expect(cards[0].unparsed).toBe(true);
    expect(cards[0].titleText).toBe('Some stray prose line');
    expect(cards[1].unparsed).toBeUndefined();
    expect(flags[0]).toContain('unrecognized line');
  });

  it('a frontmatter-only file yields zero cards (→ emptyProjects)', () => {
    const { cards, flags } = parse([]);
    expect(cards).toEqual([]);
    expect(flags).toEqual([]);
  });

  it('parse flags carry the file label and a real 1-based file line number', () => {
    const { flags } = parse(['1. ok', '#### Header']);
    // 5 frontmatter lines + '1. ok' → the header is file line 7.
    expect(flags[0]).toBe(
      'x/next.md: line 7 — header line skipped (v2 has no groups)',
    );
  });

  it('a trailing colon with an empty remainder degrades to R3', () => {
    const { cards } = parse(['1. Google Knowledge Catalog / OKF:']);
    expect(cards[0].titleText).toBe('Google Knowledge Catalog / OKF:');
    expect(cards[0].content).toEqual([]);
  });

  it('two identical titles in one project are both kept, and flagged', () => {
    const { cards, flags } = parse(['1. Dailies dash', '2. Dailies dash']);
    expect(cards).toHaveLength(2);
    expect(cards[0].key).toBe(cards[1].key);
    expect(flags[0]).toContain('duplicate card title');
  });
});

// ── contentHash (E2 changed-dot) ─────────────────────────────────────────────

describe('parseNextV2 — contentHash', () => {
  const base = ['1. Historicals dash', '\t- CAPE percentile since 2020'];

  it('is 12 lowercase hex chars and is stable across identical input', () => {
    const a = parse(base).cards[0].contentHash;
    const b = parse(base).cards[0].contentHash;
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(a).toBe(b);
  });

  it('changes when a child line changes but the title does not (E2)', () => {
    const changed = parse([
      '1. Historicals dash',
      '\t- CAPE percentile since 2020 and all time',
    ]).cards[0];
    expect(changed.key).toBe(parse(base).cards[0].key);
    expect(changed.contentHash).not.toBe(parse(base).cards[0].contentHash);
  });

  it('R3 cards share the empty-source hash', () => {
    const a = parse(['1. LLC operating agreements']).cards[0].contentHash;
    const b = parse(['1. Everplans setup']).cards[0].contentHash;
    expect(a).toBe(b);
  });
});

// ── findSplitColon (D14) ─────────────────────────────────────────────────────

describe('findSplitColon (D14)', () => {
  it('ignores a colon inside a markdown link href', () => {
    expect(
      findSplitColon('[Arena Leaderboard](https://arena.ai/leaderboard)'),
    ).toBe(-1);
  });

  it('ignores a colon inside a wikilink and inside a bare URL', () => {
    expect(findSplitColon('[[wiki/sources/passive-income-part-1]]')).toBe(-1);
    expect(findSplitColon('https://open-codereview.ai/')).toBe(-1);
  });

  it('returns the first colon outside every protected span', () => {
    const text = 'See 2 PDFs: Links: [main file](https://drive.google.com/x)';
    expect(findSplitColon(text)).toBe(10);
  });

  it('finds a colon that follows a link', () => {
    expect(findSplitColon('[a](https://x.io) then: rest')).toBe(22);
  });
});
