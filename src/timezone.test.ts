import { describe, it, expect } from 'vitest';

import {
  convertResetTimeToEt,
  formatLocalTime,
  isValidTimezone,
  resolveTimezone,
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
