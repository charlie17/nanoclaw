/**
 * Check whether a timezone string is a valid IANA identifier
 * that Intl.DateTimeFormat can use.
 */
export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the given timezone if valid IANA, otherwise fall back to UTC.
 */
export function resolveTimezone(tz: string): string {
  return isValidTimezone(tz) ? tz : 'UTC';
}

/**
 * Convert a UTC ISO timestamp to a localized display string.
 * Uses the Intl API (no external dependencies).
 * Falls back to UTC if the timezone is invalid.
 */
export function formatLocalTime(utcIso: string, timezone: string): string {
  const date = new Date(utcIso);
  return date.toLocaleString('en-US', {
    timeZone: resolveTimezone(timezone),
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Rewrite SDK rate-limit reset timestamps from UTC to ET in agent text.
 *
 * The Claude Code SDK emits messages like:
 *   "You've hit your limit · resets 9:50pm (UTC)"
 * for the 5-hour quota window. JT lives in ET; this helper rewrites the
 * timestamp to America/New_York for the user-facing surfaces (Telegram +
 * Bridge). The reset time is interpreted as the next future occurrence of
 * that wall-clock UTC time (today if still ahead, otherwise tomorrow).
 *
 * Pattern handled (case-insensitive):
 *   "resets H:MM(am|pm) (UTC)"
 * Result:
 *   "resets H:MM(am|pm) ET"
 *
 * Returns the input unchanged if no match.
 */
export function convertResetTimeToEt(text: string, now: Date = new Date()): string {
  return text.replace(
    /resets\s+(\d{1,2}):(\d{2})(am|pm)\s*\(UTC\)/gi,
    (_match, hh: string, mm: string, ampm: string) => {
      let hour = parseInt(hh, 10) % 12;
      if (ampm.toLowerCase() === 'pm') hour += 12;
      const minute = parseInt(mm, 10);

      const candidate = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate(),
          hour,
          minute,
        ),
      );
      if (candidate.getTime() <= now.getTime()) {
        candidate.setUTCDate(candidate.getUTCDate() + 1);
      }

      const formatted = candidate.toLocaleString('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
      // Intl renders "5:50 PM"; normalize to lowercase no-space "5:50pm" to
      // match the source format aesthetic.
      const compact = formatted.replace(/\s+(AM|PM)$/, (_, p) => p.toLowerCase());
      return `resets ${compact} ET`;
    },
  );
}
