/**
 * Promotion date-range normalization — pure helpers.
 *
 * The frontend sends date-only inputs as **UTC midnight** (e.g.
 * "2026-07-11T00:00:00.000Z" for the user-picked day "11 July"). Storing
 * that instant verbatim and comparing against `now` in UTC makes the
 * promotion window drift by the business timezone's offset — at
 * UTC-6 (America/Mexico_City) a promo ending 2026-07-11 is considered
 * ENDED ~6 hours before the local midnight the user actually picked.
 *
 * Contract these helpers enforce:
 *
 *   1. The **intended calendar day** is the UTC date-component of the
 *      incoming `Date` (YYYY-MM-DD). That is the day the user picked
 *      on the frontend date picker — the picker serializes the picked
 *      day as UTC-midnight, so the UTC date part IS the business day.
 *
 *   2. `startOfBusinessDay(input, tz)` → the UTC instant of
 *      `<calendarDay> 00:00:00.000` IN THE BUSINESS TIMEZONE.
 *
 *   3. `endOfBusinessDay(input, tz)` → the UTC instant of
 *      `<calendarDay> 23:59:59.999` IN THE BUSINESS TIMEZONE.
 *
 *   4. Bounds are inclusive: a promo whose window includes the local
 *      business day stays ACTIVE through the entire local day. With
 *      `getEffectiveStatus` (`endDate < now ⇒ ENDED`), the inclusive
 *      end instant ensures the promo is still eligible up to the very
 *      last millisecond of the local day.
 *
 *   5. Offset is computed via `Intl.DateTimeFormat({ timeZone })` —
 *      DST-safe for any IANA zone, including zones that have abolished
 *      DST (current America/Mexico_City is UTC-6 year-round). The
 *      offset is computed at NOON of the target calendar day in the
 *      target zone so fall-back transitions resolve to the offset that
 *      is actually in effect on that day.
 *
 * This module is intentionally framework-free (no NestJS, no Prisma)
 * so the same helpers are safe to reuse from data-fix scripts and
 * seed scripts.
 */

/**
 * Extract the intended business calendar day (YYYY-MM-DD) from an input
 * Date. The frontend serializes date-only picks as UTC-midnight, so the
 * UTC date-component is the day the user picked.
 */
function getUtcCalendarDate(input: Date): string {
  return input.toISOString().slice(0, 10);
}

/**
 * Compute the offset of the business timezone at noon on the given
 * calendar day. Returns minutes east of UTC (e.g. -360 for UTC-6,
 * +300 for UTC+5). Computed via `Intl.DateTimeFormat({ timeZone })`
 * which uses the host's IANA zone database — DST-safe.
 */
function getZoneOffsetMinutes(calendarDate: string, tz: string): number {
  // Probe at noon (UTC) of the target calendar day. Noon is safe across
  // every DST transition — it can't land inside a fall-back ambiguity
  // window, and the offset returned by `longOffset` is the offset that
  // applies on that calendar day.
  const probeInstant = new Date(`${calendarDate}T12:00:00Z`);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'longOffset',
  });
  const parts = formatter.formatToParts(probeInstant);
  const tzPart = parts.find((p) => p.type === 'timeZoneName')?.value;
  if (!tzPart) {
    throw new Error(
      `Unable to resolve timezone offset for "${tz}" on ${calendarDate}`,
    );
  }

  // Examples: "GMT-06:00", "GMT+05:30", "GMT".
  const match = tzPart.match(/^GMT(?:([+-])(\d{1,2})(?::?(\d{2}))?)?$/);
  if (!match) {
    throw new Error(`Unrecognized timezone offset string: "${tzPart}"`);
  }
  const [, sign, hoursStr, minutesStr] = match;
  if (!sign) return 0; // "GMT"
  const hours = parseInt(hoursStr, 10);
  const minutes = parseInt(minutesStr ?? '0', 10);
  const total = hours * 60 + minutes;
  return sign === '-' ? -total : total;
}

/**
 * Verify the timezone is a known IANA zone. Throws loudly so a
 * misconfigured env can't silently produce wrong boundaries.
 */
function assertValidTimezone(tz: string): void {
  // Intl.DateTimeFormat accepts both IANA names and abbreviations.
  // We probe with a known instant; if the timezone is unknown the
  // formatter constructor throws `RangeError: Invalid time zone specified`.
  // We further require the offset to be retrievable as a longOffset
  // (i.e. IANA form), which excludes abbreviations like "CST" that may
  // resolve but don't carry a longOffset representation in some
  // implementations.
  try {
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'longOffset',
    });
  } catch {
    throw new Error(
      `Invalid or unknown IANA timezone for promotion bounds: "${tz}". ` +
        `Use a name like "America/Mexico_City" or "UTC".`,
    );
  }
}

/**
 * UTC instant of local midnight (00:00:00.000) on the picked business
 * day, expressed in the configured business timezone.
 *
 * Example: `startOfBusinessDay(new Date('2026-07-01T00:00:00Z'), 'America/Mexico_City')`
 *   → `2026-07-01T06:00:00.000Z` (UTC-6)
 */
export function startOfBusinessDay(input: Date, tz: string): Date {
  assertValidTimezone(tz);
  const calendarDate = getUtcCalendarDate(input);
  const offsetMinutes = getZoneOffsetMinutes(calendarDate, tz);
  const [year, month, day] = calendarDate
    .split('-')
    .map((s) => parseInt(s, 10));
  const utcMidnightMs = Date.UTC(year, month - 1, day);
  return new Date(utcMidnightMs - offsetMinutes * 60 * 1000);
}

/**
 * UTC instant of local end-of-day (23:59:59.999) on the picked business
 * day, expressed in the configured business timezone.
 *
 * Example: `endOfBusinessDay(new Date('2026-07-11T00:00:00Z'), 'America/Mexico_City')`
 *   → `2026-07-12T05:59:59.999Z` (UTC-6)
 */
export function endOfBusinessDay(input: Date, tz: string): Date {
  assertValidTimezone(tz);
  const start = startOfBusinessDay(input, tz);
  // 24h - 1ms — robust across DST because it is a delta from the
  // already-localized start instant, never a calendar arithmetic
  // across a DST boundary.
  return new Date(start.getTime() + 86_399_999);
}

export interface PromotionDateRangeInput {
  startDate: Date | null;
  endDate: Date | null;
}

export interface PromotionDateRangeNormalized {
  startDate: Date | null;
  endDate: Date | null;
}

/**
 * Normalize a [startDate, endDate] pair to business-day boundaries in
 * the configured timezone. Null bounds pass through unchanged.
 *
 * Use this on every `create()` and `update()` path that takes a
 * date-only input from the user. The output is suitable for direct
 * persistence AND for `validateDateRange` (endDate >= startDate),
 * because endOfBusinessDay is the very last instant of the local day
 * and startOfBusinessDay is the very first.
 */
export function normalizePromotionDateRange(
  input: PromotionDateRangeInput,
  tz: string,
): PromotionDateRangeNormalized {
  return {
    startDate:
      input.startDate !== null && input.startDate !== undefined
        ? startOfBusinessDay(input.startDate, tz)
        : null,
    endDate:
      input.endDate !== null && input.endDate !== undefined
        ? endOfBusinessDay(input.endDate, tz)
        : null,
  };
}
