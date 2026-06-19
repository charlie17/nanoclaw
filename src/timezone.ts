/**
 * Convert a naive wall-clock datetime string in a given IANA timezone to a
 * UTC ISO instant string.
 *
 * Accepts: YYYY-MM-DDTHH:MM or YYYY-MM-DDTHH:MM:SS (no Z / offset suffix).
 * Returns: a UTC ISO string with Z suffix, e.g. "2026-06-19T13:00:00.000Z".
 * Throws: if the input already has a Z/offset suffix, or if the value cannot
 * be parsed as a valid datetime.
 *
 * Technique: interpret the naive string as a UTC instant, ask Intl what the
 * wall-clock time would be in the target zone at that instant, compute the
 * delta from the naive input, and apply the correction. This resolves DST at
 * the TARGET instant (not "now"), so a June-set reminder for a December date
 * correctly uses EST (−5) rather than EDT (−4).
 *
 * DST gap/overlap ambiguity at transitions (e.g. clocks spring forward):
 * a naive time that falls inside the skipped hour will resolve to the
 * post-gap UTC equivalent. This is acceptable for reminders — document,
 * don't over-engineer.
 */
export function zonedWallClockToUtc(naive: string, timeZone: string): string {
  // Reject strings that already carry zone information.
  if (/Z$|[+-]\d{2}:\d{2}$/.test(naive)) {
    throw new Error(
      `zonedWallClockToUtc: input must be a naive wall-clock string (no Z/offset), got: ${naive}`,
    );
  }

  // Parse the naive string as if it were UTC to get a Date object we can
  // feed to Intl.DateTimeFormat. We need a valid ISO string — append :00 if
  // seconds are missing (YYYY-MM-DDTHH:MM form).
  const normalized = /T\d{2}:\d{2}$/.test(naive) ? `${naive}:00` : naive;
  const naiveAsUtc = new Date(`${normalized}Z`);
  if (isNaN(naiveAsUtc.getTime())) {
    throw new Error(
      `zonedWallClockToUtc: unparseable datetime string: ${naive}`,
    );
  }

  // Ask Intl what wall-clock time corresponds to naiveAsUtc in the target
  // zone. The offset between the naive input components and this result is
  // the zone's UTC offset at that instant (modulo the DST ambiguity above).
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(naiveAsUtc);

  const get = (type: string) =>
    parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);

  // Reconstruct wall-clock in the target zone from Intl output as a UTC ms
  // value (for arithmetic). Note: Intl hour12:false may return 24 for
  // midnight — clamp to 0.
  const hour = get('hour') % 24;
  const zonedWallMs = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    hour,
    get('minute'),
    get('second'),
  );

  // The zone offset (in ms) at this instant: naiveAsUtc is the assumed UTC
  // moment; zonedWallMs is what Intl shows as wall-clock there. The
  // difference is how far the zone is from UTC.
  const offsetMs = naiveAsUtc.getTime() - zonedWallMs;

  // Actual UTC = naive wall-clock interpreted in zone + offset correction.
  const utcMs = naiveAsUtc.getTime() + offsetMs;
  return new Date(utcMs).toISOString();
}

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
export function convertResetTimeToEt(
  text: string,
  now: Date = new Date(),
): string {
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
      const compact = formatted.replace(/\s+(AM|PM)$/, (_, p) =>
        p.toLowerCase(),
      );
      return `resets ${compact} ET`;
    },
  );
}
