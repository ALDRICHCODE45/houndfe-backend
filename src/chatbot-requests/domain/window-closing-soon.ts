/**
 * "Ventana por cerrar" (S11, T7g): the ONE rule behind the `windowClosingSoon`
 * inbox filter, the `/counts` number and the per-row boolean.
 *
 * A request is closing soon when it is OPEN, has a WhatsApp window, and that
 * window closes in `(now, now + windowWarningMinutes]`: the end is inclusive, a
 * window that closed already (or closes exactly now) never matches, and zero
 * minutes is an empty range (the warning is off).
 *
 * `windowClosingSoonRange` is the single definition of the bounds. The SQL
 * fragment of the read store binds its two instants and `isWindowClosingSoon`
 * compares against them, so the filter and the row cannot drift.
 */

const MINUTE_MS = 60_000;

/** The statuses of an open request (the same pair the store's OPEN uses). */
export const OPEN_REQUEST_STATUSES = ['NEW', 'IN_PROGRESS'] as const;

/** `after` is exclusive, `upTo` inclusive. */
export interface WindowClosingSoonRange {
  after: Date;
  upTo: Date;
}

export function windowClosingSoonRange(
  now: Date,
  warningMinutes: number,
): WindowClosingSoonRange {
  return {
    after: now,
    upTo: new Date(now.getTime() + warningMinutes * MINUTE_MS),
  };
}

export function isWindowClosingSoon(
  row: { status: string; whatsappWindowClosesAt: Date | null },
  now: Date,
  warningMinutes: number,
): boolean {
  if (!(OPEN_REQUEST_STATUSES as readonly string[]).includes(row.status)) {
    return false;
  }
  const closesAt = row.whatsappWindowClosesAt;
  if (closesAt === null) return false;
  const { after, upTo } = windowClosingSoonRange(now, warningMinutes);
  return (
    closesAt.getTime() > after.getTime() && closesAt.getTime() <= upTo.getTime()
  );
}
