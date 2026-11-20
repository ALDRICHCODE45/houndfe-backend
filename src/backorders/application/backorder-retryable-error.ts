import { Prisma } from '@prisma/client';

/** PostgreSQL SQLSTATE of a deadlock victim. */
const DEADLOCK_SQLSTATE = '40P01';

/**
 * A failure the caller can simply retry (`503 BACKORDER_RETRY_REQUIRED`): the
 * transaction lost a lock race and nothing was committed.
 *
 * - `P2034` (write conflict / deadlock), `P2028` (transaction API error, e.g.
 *   timeout) and `P2024` (connection pool timeout) as before;
 * - a deadlock (SQLSTATE `40P01`) in ANY Prisma error shape: a raw query such
 *   as `pg_advisory_xact_lock` reports it as `P2010` with `meta.code === '40P01'`
 *   (or only in the message of an unknown request error), not as `P2034`.
 *
 * Only Prisma errors are inspected, so an application error whose message
 * happens to say «deadlock» is never turned into a retry.
 */
export function isRetryableTransactionError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (['P2034', 'P2028', 'P2024'].includes(error.code)) return true;
    const metaCode = (error.meta as { code?: unknown } | undefined)?.code;
    return (
      metaCode === DEADLOCK_SQLSTATE ||
      error.message.includes(DEADLOCK_SQLSTATE)
    );
  }
  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    return (
      error.message.includes(DEADLOCK_SQLSTATE) ||
      /deadlock detected/i.test(error.message)
    );
  }
  return false;
}
