import { describe, expect, it } from 'vitest';

import {
  convertResetTimeToEt,
  formatLocalTime,
  isValidTimezone,
  resolveTimezone,
  zonedWallClockToUtc,
} from './timezone.js';

// --- formatLocalTime ---

describe('formatLocalTime', () => {
  it('converts UTC to local time display', () => {
    // 2026-02-04T18:30:00Z in America/New_York (EST, UTC-5) = 1:30 PM
    const result = formatLocalTime(
      '2026-02-04T18:30:00.000Z',
      'America/New_York',
    );
    expect(result).toContain('1:30');
    expect(result).toContain('PM');
    expect(result).toContain('Feb');
    expect(result).toContain('2026');
  });

  it('handles different timezones', () => {
    // Same UTC time should produce different local times
    const utc = '2026-06-15T12:00:00.000Z';
    const ny = formatLocalTime(utc, 'America/New_York');
    const tokyo = formatLocalTime(utc, 'Asia/Tokyo');
    // NY is UTC-4 in summer (EDT), Tokyo is UTC+9
    expect(ny).toContain('8:00');
    expect(tokyo).toContain('9:00');
  });

  it('does not throw on invalid timezone, falls back to UTC', () => {
    expect(() =>
      formatLocalTime('2026-01-01T00:00:00.000Z', 'IST-2'),
    ).not.toThrow();
    const result = formatLocalTime('2026-01-01T12:00:00.000Z', 'IST-2');
    // Should format as UTC (noon UTC = 12:00 PM)
    expect(result).toContain('12:00');
    expect(result).toContain('PM');
  });
});

describe('isValidTimezone', () => {
  it('accepts valid IANA identifiers', () => {
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Asia/Tokyo')).toBe(true);
    expect(isValidTimezone('Asia/Jerusalem')).toBe(true);
  });

  it('rejects invalid timezone strings', () => {
    expect(isValidTimezone('IST-2')).toBe(false);
    expect(isValidTimezone('XYZ+3')).toBe(false);
  });

  it('rejects empty and garbage strings', () => {
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone('NotATimezone')).toBe(false);
  });
});

describe('resolveTimezone', () => {
  it('returns the timezone if valid', () => {
    expect(resolveTimezone('America/New_York')).toBe('America/New_York');
  });

  it('falls back to UTC for invalid timezone', () => {
    expect(resolveTimezone('IST-2')).toBe('UTC');
    expect(resolveTimezone('')).toBe('UTC');
  });
});

// --- convertResetTimeToEt ---

describe('convertResetTimeToEt', () => {
  it('converts the SDK rate-limit message UTC time to ET', () => {
    // 2026-05-05 21:36 UTC = 5:36pm ET (EDT, UTC-4). Reset 9:50pm UTC = 5:50pm ET.
    const now = new Date('2026-05-05T21:36:00.000Z');
    const input = "You've hit your limit · resets 9:50pm (UTC)";
    expect(convertResetTimeToEt(input, now)).toBe(
      "You've hit your limit · resets 5:50pm ET",
    );
  });

  it('handles am times', () => {
    // 2026-01-15 12:00 UTC. Reset 8:30am UTC tomorrow (already past today).
    const now = new Date('2026-01-15T12:00:00.000Z');
    // EST (UTC-5). 8:30am UTC = 3:30am ET (next day).
    const input = 'limit reached · resets 8:30am (UTC)';
    const result = convertResetTimeToEt(input, now);
    expect(result).toContain('resets 3:30am ET');
  });

  it('rolls forward when the reset time has already passed today', () => {
    // 2026-05-05 22:00 UTC. Reset 9:50pm UTC today is in the past → next day.
    const now = new Date('2026-05-05T22:00:00.000Z');
    const input = 'resets 9:50pm (UTC)';
    // 9:50pm UTC next day = 5:50pm ET next day. Wall-clock formatting same.
    expect(convertResetTimeToEt(input, now)).toBe('resets 5:50pm ET');
  });

  it('passes through unchanged when no match', () => {
    expect(convertResetTimeToEt('no rate-limit alert here')).toBe(
      'no rate-limit alert here',
    );
  });

  it('handles multiple matches in one string', () => {
    const now = new Date('2026-05-05T21:36:00.000Z');
    const input = 'first resets 9:50pm (UTC) and also resets 10:50pm (UTC)';
    const result = convertResetTimeToEt(input, now);
    expect(result).toContain('resets 5:50pm ET');
    expect(result).toContain('resets 6:50pm ET');
    expect(result).not.toContain('UTC');
  });
});

// --- zonedWallClockToUtc (Impl-74) ---

describe('zonedWallClockToUtc', () => {
  // ── Core DST correctness ──────────────────────────────────────────────────

  it('converts a summer (EDT, UTC−4) wall-clock to UTC correctly', () => {
    // 2026-06-19 is in EDT (UTC−4); 09:00 ET → 13:00 UTC
    expect(zonedWallClockToUtc('2026-06-19T09:00:00', 'America/New_York')).toBe(
      '2026-06-19T13:00:00.000Z',
    );
  });

  it('converts a winter (EST, UTC−5) wall-clock to UTC correctly', () => {
    // 2026-12-15 is in EST (UTC−5); 09:00 ET → 14:00 UTC
    expect(
      zonedWallClockToUtc('2026-12-15T09:00:00', 'America/New_York'),
    ).toBe('2026-12-15T14:00:00.000Z');
  });

  // ── Incident cases (2026-06-19: 11am and noon fired 4h early) ────────────

  it('converts incident case 11:00 ET (EDT) to 15:00 UTC', () => {
    expect(
      zonedWallClockToUtc('2026-06-19T11:00:00', 'America/New_York'),
    ).toBe('2026-06-19T15:00:00.000Z');
  });

  it('converts incident case 12:00 ET (EDT) to 16:00 UTC', () => {
    expect(
      zonedWallClockToUtc('2026-06-19T12:00:00', 'America/New_York'),
    ).toBe('2026-06-19T16:00:00.000Z');
  });

  // ── Optional seconds ──────────────────────────────────────────────────────

  it('accepts YYYY-MM-DDTHH:MM (no seconds) and produces correct UTC', () => {
    expect(zonedWallClockToUtc('2026-06-19T09:00', 'America/New_York')).toBe(
      '2026-06-19T13:00:00.000Z',
    );
  });

  // ── Rejection of zone-aware inputs ───────────────────────────────────────

  it('throws if the input has a Z suffix', () => {
    expect(() =>
      zonedWallClockToUtc('2026-06-19T09:00:00Z', 'America/New_York'),
    ).toThrow();
  });

  it('throws if the input has a +HH:MM offset', () => {
    expect(() =>
      zonedWallClockToUtc('2026-06-19T09:00:00+00:00', 'America/New_York'),
    ).toThrow();
  });

  it('throws on an unparseable datetime string', () => {
    expect(() =>
      zonedWallClockToUtc('not-a-date', 'America/New_York'),
    ).toThrow();
  });
});

// ── Past-guard: documented as covered by ipc.ts branch logic ──────────────
//
// The in-the-past guardrail lives in src/ipc.ts (schedule_task once-branch).
// It compares new Date(resolved).getTime() <= Date.now() and logs+breaks
// rather than persisting the task.  Testing that branch would require
// mocking Date.now() and the full processTaskIpc dependency graph (db,
// logger, deps).  The logic is a two-line conditional on the output of
// zonedWallClockToUtc, which IS tested above.  Impl-74 B4 documents this
// as covered by helper tests + branch inspection rather than an integration
// test of the full IPC path.
