import { describe, it, expect, beforeEach } from 'vitest';

import {
  ABSENCE_CLAIM_BLOCK_REASON,
  ABSENCE_CLAIM_REGEX,
  VAULT_GREP_BLOCK_REASON,
  createQmdTurnState,
  evaluateAbsenceClaimGate,
  evaluateVaultGrepGate,
  isQmdQuerySuccess,
  isVaultGrepCall,
  looksLikeAbsenceClaim,
  type QmdTurnState,
} from './qmd-gate.js';

describe('isVaultGrepCall', () => {
  it('flags Grep with an absolute vault path', () => {
    expect(
      isVaultGrepCall('Grep', {
        pattern: 'sabbatical',
        path: '/workspace/extra/vault/general',
      }),
    ).toBe(true);
  });

  it('flags Grep on the vault root itself', () => {
    expect(
      isVaultGrepCall('Grep', { pattern: 'x', path: '/workspace/extra/vault' }),
    ).toBe(true);
  });

  it('flags Glob whose glob pattern points at the vault', () => {
    expect(
      isVaultGrepCall('Glob', { pattern: '/workspace/extra/vault/**/*.md' }),
    ).toBe(true);
  });

  it('flags a relative extra/vault path', () => {
    expect(isVaultGrepCall('Grep', { pattern: 'x', path: 'extra/vault' })).toBe(
      true,
    );
  });

  it('flags a vault cwd', () => {
    expect(
      isVaultGrepCall('Glob', {
        pattern: '**/*.md',
        cwd: '/workspace/extra/vault/general',
      }),
    ).toBe(true);
  });

  it('does not flag searches outside the vault', () => {
    expect(
      isVaultGrepCall('Grep', { pattern: 'x', path: '/workspace/group' }),
    ).toBe(false);
    expect(isVaultGrepCall('Glob', { pattern: '**/*.ts' })).toBe(false);
    expect(
      isVaultGrepCall('Grep', {
        pattern: 'x',
        path: '/workspace/extra/readwise',
      }),
    ).toBe(false);
  });

  it('does not flag a lookalike sibling directory', () => {
    expect(
      isVaultGrepCall('Grep', {
        pattern: 'x',
        path: '/workspace/extra/vaultarium',
      }),
    ).toBe(false);
  });

  it('never flags Read, however vault-y the path', () => {
    expect(
      isVaultGrepCall('Read', {
        file_path: '/workspace/extra/vault/general/projects/x/log.md',
      }),
    ).toBe(false);
  });

  it('flags Bash grep/rg/find/ls -R against the vault', () => {
    const commands = [
      'grep -r "sabbatical" /workspace/extra/vault/general',
      'rg -n sabbatical /workspace/extra/vault',
      'find /workspace/extra/vault -name "*.md"',
      'ls -R /workspace/extra/vault/general',
      'ls -la -R /workspace/extra/vault',
      'cat foo.txt | grep x /workspace/extra/vault/a.md',
    ];
    for (const command of commands) {
      expect(isVaultGrepCall('Bash', { command }), command).toBe(true);
    }
  });

  it('does not flag Bash searches elsewhere, or non-search vault commands', () => {
    expect(
      isVaultGrepCall('Bash', { command: 'grep -r foo /workspace/group' }),
    ).toBe(false);
    expect(
      isVaultGrepCall('Bash', {
        command: 'cat /workspace/extra/vault/general/runway.md',
      }),
    ).toBe(false);
    expect(
      isVaultGrepCall('Bash', {
        command: 'ls /workspace/extra/vault/general',
      }),
    ).toBe(false);
  });

  it('tolerates missing/garbage input', () => {
    expect(isVaultGrepCall('Grep', undefined)).toBe(false);
    expect(isVaultGrepCall('Bash', {})).toBe(false);
    expect(isVaultGrepCall('', null)).toBe(false);
  });
});

describe('looksLikeAbsenceClaim', () => {
  const absent = [
    "There's nothing in the vault about that.",
    'Nothing in your vault matches.',
    'Nothing found in the notes you keep.',
    'I see no notes of that conversation.',
    'There are no entries about the sabbatical in your vault.',
    'No mentions on that topic anywhere.',
    'There is no record of it.',
    'No records about the trip.',
    "That's not in the vault.",
    'It is not anywhere in your vault.',
    "I couldn't find anything on this.",
    'I could not find any references.',
    'There is no vault content for that.',
    'No vault notes exist.',
    'No vault entries there.',
    'The vault has nothing on it.',
    'Your vault contains nothing about sailing.',
    // Second pass — common phrasings the first regex missed.
    'There is no mention of WSJ in the vault.',
    "There's nothing on that in your vault.",
    "I don't see anything about the sabbatical in your notes.",
    "I didn't find anything on that.",
    'I found nothing about the trip.',
    "There isn't anything in the vault about WSJ.",
    'There are no matching notes.',
    'I see no relevant entries.',
    "The vault doesn't have anything on that.",
    "Your notes don't mention it.",
    // Third pass — Codex review finding 2 (missed phrasings).
    'I searched and nothing turned up.',
    'There is no note on WSJ.',
    'There was no note about that meeting.',
    // Third pass — finding 3: the generic-noun pattern still fires when the
    // sentence names the vault.
    'There are no entries about WSJ in your notes.',
  ];

  for (const text of absent) {
    it(`matches: ${text}`, () => {
      expect(looksLikeAbsenceClaim(text)).toBe(true);
    });
  }

  const present = [
    'Here are the entries I found in the vault: ...',
    'I found three notes about the sabbatical.',
    'The vault has a project log for this — see general/projects/foo/log.md.',
    'Nothing else to add; the notes are up to date.',
    'I searched extra/vaultarium and found the file.',
    // Restrictive reading, not an absence claim — the vault DOES have content.
    'Nothing in the vault is more recent than 9/10, here is the latest.',
    // Narrowness guard for the "don't see/find anything" rule.
    "I don't have any other updates for you.",
    // Finding 3: generic-noun absence phrasing with no vault relation. The
    // second clause names the vault, but it is a separate clause.
    'No entries about X need changing; I found three relevant vault notes.',
    'There are no results for this API request',
    // Fourth pass: the "isn't anything / aren't any" shape is contextual now.
    "There aren't any other changes.",
  ];

  for (const text of present) {
    it(`does not match: ${text}`, () => {
      expect(looksLikeAbsenceClaim(text)).toBe(false);
    });
  }

  it('is case-insensitive', () => {
    expect(looksLikeAbsenceClaim('NOTHING IN THE VAULT')).toBe(true);
  });

  it('is false for empty/missing text', () => {
    expect(looksLikeAbsenceClaim(undefined)).toBe(false);
    expect(looksLikeAbsenceClaim(null)).toBe(false);
    expect(looksLikeAbsenceClaim('')).toBe(false);
  });

  it('exposes the regex as a single extensible constant', () => {
    expect(ABSENCE_CLAIM_REGEX.flags).toContain('i');
    expect(ABSENCE_CLAIM_REGEX.test('nothing in the vault')).toBe(true);
  });
});

describe('isQmdQuerySuccess', () => {
  it('is true for a successful qmd query', () => {
    expect(isQmdQuerySuccess('mcp__qmd__query', { results: [] })).toBe(true);
  });

  it('is true for a zero-hit query (a real search still happened)', () => {
    expect(isQmdQuerySuccess('mcp__qmd__query', [])).toBe(true);
  });

  it('is false for an errored query', () => {
    expect(isQmdQuerySuccess('mcp__qmd__query', { is_error: true })).toBe(false);
    expect(isQmdQuerySuccess('mcp__qmd__query', { isError: true })).toBe(false);
  });

  // Finding 1: the gate must fail CLOSED on every uncertain shape.
  it('is false when there is no response at all', () => {
    expect(isQmdQuerySuccess('mcp__qmd__query', undefined)).toBe(false);
    expect(isQmdQuerySuccess('mcp__qmd__query', null)).toBe(false);
  });

  it('is false for an error delivered as a bare string', () => {
    expect(
      isQmdQuerySuccess('mcp__qmd__query', 'Error: qmd daemon unavailable'),
    ).toBe(false);
    expect(
      isQmdQuerySuccess('mcp__qmd__query', 'MCP error -32603: tool failed'),
    ).toBe(false);
  });

  it('is true for a normal string response', () => {
    expect(
      isQmdQuerySuccess('mcp__qmd__query', 'general/projects/foo/log.md — 0.82'),
    ).toBe(true);
  });

  it('is false for an error delivered as content blocks', () => {
    expect(
      isQmdQuerySuccess('mcp__qmd__query', [
        { type: 'text', text: 'Error: qmd daemon unavailable' },
      ]),
    ).toBe(false);
    expect(
      isQmdQuerySuccess('mcp__qmd__query', {
        content: [{ type: 'text', text: 'Error: qmd daemon unavailable' }],
        isError: true,
      }),
    ).toBe(false);
    // Same prose error, no flag set — still an error.
    expect(
      isQmdQuerySuccess('mcp__qmd__query', {
        content: [{ type: 'text', text: 'Error: collection not found' }],
      }),
    ).toBe(false);
  });

  it('is true for a normal content array of results', () => {
    expect(
      isQmdQuerySuccess('mcp__qmd__query', [
        { type: 'text', text: '1. general/wiki/wsj.md (0.71)' },
      ]),
    ).toBe(true);
    expect(
      isQmdQuerySuccess('mcp__qmd__query', {
        content: [{ type: 'text', text: '1. general/wiki/wsj.md (0.71)' }],
      }),
    ).toBe(true);
  });

  it('is false for a non-empty array with no text-bearing block', () => {
    expect(isQmdQuerySuccess('mcp__qmd__query', [{ type: 'image' }])).toBe(
      false,
    );
    expect(isQmdQuerySuccess('mcp__qmd__query', [{}])).toBe(false);
  });

  it('is false for a non-string primitive', () => {
    expect(isQmdQuerySuccess('mcp__qmd__query', 0)).toBe(false);
    expect(isQmdQuerySuccess('mcp__qmd__query', 42)).toBe(false);
    expect(isQmdQuerySuccess('mcp__qmd__query', true)).toBe(false);
    expect(isQmdQuerySuccess('mcp__qmd__query', false)).toBe(false);
  });

  it('does not mistake a result that merely mentions errors for an error', () => {
    expect(
      isQmdQuerySuccess('mcp__qmd__query', [
        { type: 'text', text: '1. general/wiki/error-budgets.md (0.66)' },
      ]),
    ).toBe(true);
  });

  it('is false for other qmd tools and other tools', () => {
    expect(isQmdQuerySuccess('mcp__qmd__get', { ok: true })).toBe(false);
    expect(isQmdQuerySuccess('mcp__qmd__status', { ok: true })).toBe(false);
    expect(isQmdQuerySuccess('Grep', { ok: true })).toBe(false);
  });
});

describe('evaluateVaultGrepGate', () => {
  let state: QmdTurnState;
  beforeEach(() => {
    state = createQmdTurnState();
  });

  it('blocks a vault grep before any qmd query', () => {
    expect(
      evaluateVaultGrepGate(state, 'Grep', {
        pattern: 'x',
        path: '/workspace/extra/vault',
      }),
    ).toBe(VAULT_GREP_BLOCK_REASON);
  });

  it('allows the same grep after a successful qmd query', () => {
    state.markQmdSuccess();
    expect(
      evaluateVaultGrepGate(state, 'Grep', {
        pattern: 'x',
        path: '/workspace/extra/vault',
      }),
    ).toBeNull();
  });

  it('allows a non-vault grep even before qmd', () => {
    expect(
      evaluateVaultGrepGate(state, 'Grep', {
        pattern: 'x',
        path: '/workspace/group',
      }),
    ).toBeNull();
  });

  it('blocks a Bash grep of the vault before qmd', () => {
    expect(
      evaluateVaultGrepGate(state, 'Bash', {
        command: 'grep -ri sabbatical /workspace/extra/vault',
      }),
    ).toBe(VAULT_GREP_BLOCK_REASON);
  });

  it('never blocks Read', () => {
    expect(
      evaluateVaultGrepGate(state, 'Read', {
        file_path: '/workspace/extra/vault/general/runway.md',
      }),
    ).toBeNull();
  });

  it('re-locks at the turn boundary', () => {
    state.markQmdSuccess();
    expect(state.hasQmdThisTurn()).toBe(true);
    state.resetTurn();
    expect(state.hasQmdThisTurn()).toBe(false);
    expect(
      evaluateVaultGrepGate(state, 'Grep', {
        pattern: 'x',
        path: '/workspace/extra/vault',
      }),
    ).toBe(VAULT_GREP_BLOCK_REASON);
  });

  it('each turn-state instance is independent', () => {
    const other = createQmdTurnState();
    state.markQmdSuccess();
    expect(other.hasQmdThisTurn()).toBe(false);
  });
});

describe('evaluateAbsenceClaimGate', () => {
  let state: QmdTurnState;
  beforeEach(() => {
    state = createQmdTurnState();
  });

  it('blocks an absence claim with no qmd query this turn', () => {
    expect(
      evaluateAbsenceClaimGate(
        state,
        false,
        "There's nothing in the vault about that.",
      ),
    ).toBe(ABSENCE_CLAIM_BLOCK_REASON);
  });

  it('short-circuits when stop_hook_active is true (loop guard)', () => {
    expect(
      evaluateAbsenceClaimGate(
        state,
        true,
        "There's nothing in the vault about that.",
      ),
    ).toBeNull();
  });

  it('allows an absence claim once a qmd query has run', () => {
    state.markQmdSuccess();
    expect(
      evaluateAbsenceClaimGate(
        state,
        false,
        "There's nothing in the vault about that.",
      ),
    ).toBeNull();
  });

  it('allows a non-absence reply', () => {
    expect(
      evaluateAbsenceClaimGate(
        state,
        false,
        'Here are the entries I found: a, b, c.',
      ),
    ).toBeNull();
  });

  it('allows when there is no last assistant message', () => {
    expect(evaluateAbsenceClaimGate(state, false, undefined)).toBeNull();
  });

  it('re-locks at the turn boundary', () => {
    state.markQmdSuccess();
    state.resetTurn();
    expect(
      evaluateAbsenceClaimGate(state, false, 'No records about the trip.'),
    ).toBe(ABSENCE_CLAIM_BLOCK_REASON);
  });
});
