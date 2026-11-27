/**
 * customers-bulk-actions / T3 (S5) — names for the bulk statements ZIP.
 *
 * - Entry names (frontend L3.3): the customer's name («Ana López.pdf»),
 *   sanitized for file names (accents kept, invalid characters replaced, no
 *   path separators) and disambiguated in ZIP order («Ana López (2).pdf»).
 *   Nothing usable left → `cliente-<first 8 chars of the id>.pdf`.
 * - ZIP name: `estados-de-cuenta-<from>-<to>.zip`, user-data-free (it goes
 *   into a response header), every component re-sanitized like the single
 *   statement filename.
 * - DOS timestamps in a ZIP are wall-clock fields encoded from the server's
 *   local time; `businessWallClock` returns a Date whose LOCAL getters show
 *   the business-timezone wall time, so the files look right in Mexico
 *   whatever the server TZ is (verified under several server zones). Known
 *   limit: the ZIP writer (src/shared/zip) reads local getters, so a business
 *   wall time that falls in the SERVER's spring-forward gap does not exist
 *   locally and comes out shifted forward by the gap (+1 h, at most once a
 *   year, only on a server whose TZ observes DST; none with TZ=UTC).
 */
import { createFileNameAllocator } from '../shared/zip';

export interface StatementEntryCustomer {
  id: string;
  firstName: string;
  lastName: string | null;
}

/** `firstName lastName`, trimmed (the statement's customer name). */
export function customerStatementDisplayName(
  customer: StatementEntryCustomer,
): string {
  return [customer.firstName, customer.lastName ?? '']
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(' ');
}

/** One unique, safe `.pdf` entry name per customer, in input order. */
export function allocateStatementEntryNames(
  customers: readonly StatementEntryCustomer[],
): string[] {
  const allocator = createFileNameAllocator({ extension: '.pdf' });
  return customers.map((customer) =>
    allocator.allocate(
      customerStatementDisplayName(customer),
      `cliente-${customer.id.slice(0, 8)}`,
    ),
  );
}

export function buildBulkStatementsZipFilename(range: {
  from: string;
  to: string;
}): string {
  const safe = (value: string): string =>
    value.replace(/[^0-9-]/g, '').replace(/^-+|-+$/g, '');
  return `estados-de-cuenta-${safe(range.from)}-${safe(range.to)}.zip`;
}

/**
 * A Date whose local (server-TZ) fields equal the wall time of `instant` in
 * `timeZone`. Only for encoding ZIP DOS timestamps; not a real instant. Inside
 * a server-TZ spring-forward gap no such Date exists (see the header note).
 */
export function businessWallClock(instant: Date, timeZone: string): Date {
  const parts: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return new Date(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
}
