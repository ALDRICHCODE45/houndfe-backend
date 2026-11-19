/**
 * A4 kit — date formatting (pdf-a4-redesign T7, S2).
 *
 * ONE date format for the four A4 documents, matching the artboard
 * (`01-libro-mayor.html`): two-digit day, LOWERCASE short month without a dot,
 * year, then `, HH:mm` in 24 h — e.g. `15 ene 2026, 12:05`.
 *
 * Bit-stable output: uses `hourCycle: 'h23'` (never `24:00`) and strips the
 * abbreviation dot some ICU builds add. Unparseable input is returned as-is;
 * a runtime without `es-MX` ICU data falls back to an ISO-like string.
 */

/** Business time zone of the A4 documents (closing, report, receipt). */
export const A4_TIME_ZONE = 'America/Mexico_City';

function formatWith(
  iso: string,
  options: Intl.DateTimeFormatOptions,
  fallbackEnd: number,
  fallbackTimeSeparator: boolean,
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  try {
    return new Intl.DateTimeFormat('es-MX', {
      ...options,
      hourCycle: 'h23',
    })
      .format(date)
      .replace(/\./g, '')
      .toLowerCase();
  } catch {
    const text = date.toISOString().slice(0, fallbackEnd);
    return fallbackTimeSeparator ? text.replace('T', ' ') : text;
  }
}

/** `15 ene 2026, 12:05` — date and time. */
export function formatA4DateTime(
  iso: string,
  timeZone: string = A4_TIME_ZONE,
): string {
  return formatWith(
    iso,
    {
      timeZone,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    },
    16,
    true,
  );
}

/** `15 ene 2026` — the date part of the same format (no time). */
export function formatA4Date(
  iso: string,
  timeZone: string = A4_TIME_ZONE,
): string {
  return formatWith(
    iso,
    { timeZone, day: '2-digit', month: 'short', year: 'numeric' },
    10,
    false,
  );
}

/** `12:05` — the time part of the same format (24 h). */
export function formatA4Time(
  iso: string,
  timeZone: string = A4_TIME_ZONE,
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  try {
    return new Intl.DateTimeFormat('es-MX', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(date);
  } catch {
    return date.toISOString().slice(11, 16);
  }
}
