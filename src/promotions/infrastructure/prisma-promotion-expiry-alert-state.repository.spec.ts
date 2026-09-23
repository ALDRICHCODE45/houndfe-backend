/**
 * ADAPTER UNIT SPEC: PrismaPromotionExpiryAlertStateRepository.claimExpiryAlert
 * and the frozen `promotion.expiring.detected` payload contract — pca-3c1a.
 *
 * The expiry scanner (`pca-3c2`) will hand this repository a promotion id it
 * read EARLIER. Between that read and this claim the promotion may have been
 * edited (end date moved, manually ended, deleted), so this spec pins the
 * revalidation contract:
 *
 *   1. LOCK + RE-READ — the claim opens one interactive transaction and
 *      re-reads the current `promotions` row with `FOR UPDATE` and an
 *      explicitly tenant-qualified predicate. Every raw statement carries
 *      `"tenantId"` because these statements bypass the tenant extension.
 *   2. REVALIDATE — the freshly read row must still be effectively ACTIVE
 *      (not manually ended, already started) and end inside `(now, now+7d]`,
 *      where `now` is read AFTER the lock with a separate `clock_timestamp()`
 *      statement on the SAME transaction (never the transaction-fixed
 *      `NOW()`, which can predate a lock wait). A stale scanner id therefore
 *      can never publish an obsolete or already-expired date.
 *   3. SEED + GUARDED FLIP — the fingerprint is the persisted
 *      `endDate.toISOString()`; the state row is seeded with
 *      `INSERT ... ON CONFLICT DO NOTHING` and the `alerted = false` flip is
 *      the single winner gate. Losing the flip means another claim already
 *      alerted that exact effective end date.
 *   4. ONE TRANSACTION — seed, flip, and the outbox row commit together
 *      through `OutboxWriterService`; a publish failure must propagate so the
 *      whole claim rolls back.
 *
 * The Prisma double below is STATEFUL for `promotion_expiry_alert_states`, so
 * A→B→A and retry collapse are proven by real outcomes (not by asserting a
 * mock was called), while the raw SQL is additionally asserted structurally.
 *
 * Scope note: this proves source-level, in-memory behavior only. Real
 * PostgreSQL locking, concurrency, and constraint enforcement belong to
 * `pca-3c1b`; no scanner, poller, dispatcher, or email exists yet.
 */
import { Prisma } from '@prisma/client';
import { PrismaPromotionExpiryAlertStateRepository } from './prisma-promotion-expiry-alert-state.repository';
import { PROMOTION_EXPIRY_ALERT_WINDOW_MS } from '../domain/promotion-expiry-alert-state.repository';
import {
  PROMOTION_EXPIRING_EVENT_TYPE,
  PROMOTION_EXPIRING_INNGEST_EVENT,
  readPromotionExpiryIdentity,
} from '../outbox/promotion-expiry-outbox.types';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import type { OutboxWriterService } from '../../shared/outbox/outbox-writer.service';

const TENANT_ID = 'tenant-1';
const OTHER_TENANT_ID = 'tenant-2';
const PROMOTION_ID = 'promotion-1';
const READ_AT = new Date('2026-07-05T12:00:00.000Z');
const END_DATE = new Date('2026-07-10T05:59:59.999Z');
const END_DATE_ISO = END_DATE.toISOString();
const LATER_END_DATE = new Date('2026-07-11T05:59:59.999Z');

/** Raw `Prisma.sql` statement as the mock sees it. */
type RawQuery = { sql: string; values: unknown[] };

/** The projection the claim re-reads from `promotions`. */
type PromotionRow = {
  id: string;
  tenantId: string;
  startDate: Date | null;
  endDate: Date | null;
  manuallyEnded: boolean;
};

const stateKey = (
  tenantId: string,
  promotionId: string,
  fingerprint: string,
): string => `${tenantId}\u0000${promotionId}\u0000${fingerprint}`;

/**
 * The two database clock instants this claim can observe, modelled exactly:
 *   - `transactionStart` — `NOW()` / `transaction_timestamp()`, frozen at
 *     `BEGIN`, so it does NOT advance while the claim waits on the row lock;
 *   - `lockAcquired` — `clock_timestamp()` read on the SAME transaction only
 *     after `FOR UPDATE` was granted.
 */
type Clock = { transactionStart: Date; lockAcquired: Date };

const DEFAULT_CLOCK: Clock = {
  transactionStart: READ_AT,
  lockAcquired: READ_AT,
};

/**
 * Transaction double with real state semantics:
 *   - the `promotions` re-read matches on BOTH `id` and `tenantId`;
 *   - a locked projection selecting `NOW()` reports `transactionStart` (the
 *     transaction-fixed instant), while a separate `SELECT clock_timestamp()`
 *     reports the post-lock instant;
 *   - `INSERT ... ON CONFLICT DO NOTHING` records an armed row only once;
 *   - the guarded `UPDATE` flips an armed row exactly once and then returns
 *     zero rows, exactly like the real `WHERE ... AND "alerted" = FALSE`.
 */
function makeHarness(rows: PromotionRow[], clock: Clock = DEFAULT_CLOCK) {
  const calls: RawQuery[] = [];
  const state = new Map<string, { alerted: boolean }>();

  const $queryRaw = (query: RawQuery): Promise<unknown> => {
    calls.push({ sql: query.sql, values: query.values });

    if (query.sql.includes('FROM "promotions"')) {
      const [promotionId, tenantId] = query.values;
      const match = rows.find(
        (row) => row.id === promotionId && row.tenantId === tenantId,
      );
      if (match === undefined) {
        return Promise.resolve([]);
      }
      const projection = {
        startDate: match.startDate,
        endDate: match.endDate,
        manuallyEnded: match.manuallyEnded,
      };
      // A locked SELECT that derives its instant from `NOW()` gets the
      // transaction-start value, never the instant the lock was granted.
      return Promise.resolve(
        query.sql.includes('NOW()')
          ? [{ ...projection, readAt: clock.transactionStart }]
          : [projection],
      );
    }

    if (query.sql.includes('clock_timestamp()')) {
      return Promise.resolve([{ readAt: clock.lockAcquired }]);
    }

    if (query.sql.includes('INSERT INTO "promotion_expiry_alert_states"')) {
      const [, tenantId, promotionId, fingerprint] = query.values as string[];
      const key = stateKey(tenantId, promotionId, fingerprint);
      if (!state.has(key)) {
        state.set(key, { alerted: false });
      }
      return Promise.resolve([]);
    }

    if (query.sql.includes('UPDATE "promotion_expiry_alert_states"')) {
      const [tenantId, promotionId, fingerprint] = query.values as string[];
      const key = stateKey(tenantId, promotionId, fingerprint);
      const entry = state.get(key);
      if (entry === undefined || entry.alerted) {
        return Promise.resolve([]);
      }
      entry.alerted = true;
      return Promise.resolve([{ id: `state-${key}` }]);
    }

    return Promise.resolve([]);
  };

  const tx = { $queryRaw } as unknown as Prisma.TransactionClient;
  const $transaction = jest.fn(
    (callback: (client: Prisma.TransactionClient) => Promise<unknown>) =>
      callback(tx),
  );
  const prisma = { $transaction } as unknown as PrismaService;
  const outbox = { publish: jest.fn().mockResolvedValue(undefined) };

  return {
    repository: new PrismaPromotionExpiryAlertStateRepository(
      prisma,
      outbox as unknown as OutboxWriterService,
    ),
    calls,
    outbox,
    $transaction,
    tx,
  };
}

function promotionRow(overrides: Partial<PromotionRow> = {}): PromotionRow {
  return {
    id: PROMOTION_ID,
    tenantId: TENANT_ID,
    startDate: new Date('2026-07-01T06:00:00.000Z'),
    endDate: END_DATE,
    manuallyEnded: false,
    ...overrides,
  };
}

describe('PrismaPromotionExpiryAlertStateRepository.claimExpiryAlert', () => {
  it('locks and re-reads the current promotion with a tenant-qualified predicate first', async () => {
    const harness = makeHarness([promotionRow()]);

    await harness.repository.claimExpiryAlert({
      tenantId: TENANT_ID,
      promotionId: PROMOTION_ID,
    });

    const [lock, clock, seed, flip] = harness.calls;
    expect(lock.sql).toMatch(/FROM "promotions"/);
    expect(lock.sql).toMatch(
      /WHERE "id" = \? AND "tenantId" = \?[\s\S]*FOR UPDATE/,
    );
    expect(lock.values).toEqual([PROMOTION_ID, TENANT_ID]);
    // The locked read must NOT derive the eligibility instant: `NOW()` is
    // transaction-start fixed and can predate a lock wait.
    expect(lock.sql).not.toMatch(/NOW\(\)/);
    expect(lock.sql).not.toMatch(/clock_timestamp\(\)/);
    // The instant is read on the same transaction, only AFTER the lock.
    expect(clock.sql).toMatch(/clock_timestamp\(\) AS "readAt"/);
    // Ordering is the contract: nothing may be written before the locked read.
    expect(seed.sql).toMatch(/INSERT INTO "promotion_expiry_alert_states"/);
    expect(flip.sql).toMatch(/UPDATE "promotion_expiry_alert_states"/);
  });

  it('seeds the persisted endDate fingerprint and flips alerted exactly once', async () => {
    const harness = makeHarness([promotionRow()]);

    const result = await harness.repository.claimExpiryAlert({
      tenantId: TENANT_ID,
      promotionId: PROMOTION_ID,
    });

    expect(result).toEqual({
      outcome: 'claimed',
      endDate: END_DATE_ISO,
      endDateFingerprint: END_DATE_ISO,
    });
    expect(harness.$transaction).toHaveBeenCalledTimes(1);

    const seed = harness.calls[2];
    expect(seed.sql).toMatch(
      /ON CONFLICT \("tenantId", "promotionId", "endDateFingerprint"\) DO NOTHING/,
    );
    expect(seed.values).toEqual([
      expect.any(String),
      TENANT_ID,
      PROMOTION_ID,
      END_DATE_ISO,
    ]);

    const flip = harness.calls[3];
    expect(flip.sql).toMatch(/SET "alerted" = TRUE/);
    expect(flip.sql).toMatch(
      /WHERE "tenantId" = \?\s+AND "promotionId" = \?\s+AND "endDateFingerprint" = \?\s+AND "alerted" = FALSE/,
    );
    expect(flip.sql).toMatch(/RETURNING "id"/);
    expect(flip.sql).toMatch(/"alerted" = FALSE/);
    expect(flip.values).toEqual([TENANT_ID, PROMOTION_ID, END_DATE_ISO]);
  });

  it('publishes the immutable expiring event inside the same transaction', async () => {
    const harness = makeHarness([promotionRow()]);

    await harness.repository.claimExpiryAlert({
      tenantId: TENANT_ID,
      promotionId: PROMOTION_ID,
    });

    expect(harness.outbox.publish).toHaveBeenCalledTimes(1);
    expect(harness.outbox.publish).toHaveBeenCalledWith(
      harness.tx,
      TENANT_ID,
      'Promotion',
      PROMOTION_ID,
      PROMOTION_EXPIRING_EVENT_TYPE,
      {
        tenantId: TENANT_ID,
        promotionId: PROMOTION_ID,
        endDate: END_DATE_ISO,
        endDateFingerprint: END_DATE_ISO,
        occurredAt: READ_AT.toISOString(),
      },
    );
  });

  it('keeps A→B→A deduped: returning to an alerted end date claims nothing', async () => {
    const rows = [promotionRow()];
    const harness = makeHarness(rows);

    await expect(
      harness.repository.claimExpiryAlert({
        tenantId: TENANT_ID,
        promotionId: PROMOTION_ID,
      }),
    ).resolves.toMatchObject({ outcome: 'claimed' });

    rows[0].endDate = LATER_END_DATE;
    await expect(
      harness.repository.claimExpiryAlert({
        tenantId: TENANT_ID,
        promotionId: PROMOTION_ID,
      }),
    ).resolves.toMatchObject({ outcome: 'claimed' });

    rows[0].endDate = END_DATE;
    await expect(
      harness.repository.claimExpiryAlert({
        tenantId: TENANT_ID,
        promotionId: PROMOTION_ID,
      }),
    ).resolves.toEqual({
      outcome: 'already_alerted',
      endDate: END_DATE_ISO,
      endDateFingerprint: END_DATE_ISO,
    });
    expect(harness.outbox.publish).toHaveBeenCalledTimes(2);
  });

  it('collapses a retry of the same effective end date without a second event', async () => {
    const harness = makeHarness([promotionRow()]);
    const claim = () =>
      harness.repository.claimExpiryAlert({
        tenantId: TENANT_ID,
        promotionId: PROMOTION_ID,
      });

    await expect(claim()).resolves.toMatchObject({ outcome: 'claimed' });
    await expect(claim()).resolves.toMatchObject({
      outcome: 'already_alerted',
    });
    expect(harness.outbox.publish).toHaveBeenCalledTimes(1);
  });

  it('classifies against the post-lock instant instead of the transaction-fixed NOW()', async () => {
    // The transaction began (freezing `NOW()`) BEFORE `endDate`, but the
    // `FOR UPDATE` lock was only granted AFTER it. `NOW()` still reports the
    // start instant, so an eligibility check on it would publish an alert for
    // an already-expired promotion; the claim must use the instant read only
    // after the lock was granted.
    const transactionStart = new Date('2026-07-05T12:00:00.000Z');
    const endDate = new Date('2026-07-05T12:00:30.000Z');
    const lockAcquired = new Date('2026-07-05T12:01:00.000Z');
    const harness = makeHarness([promotionRow({ endDate })], {
      transactionStart,
      lockAcquired,
    });

    await expect(
      harness.repository.claimExpiryAlert({
        tenantId: TENANT_ID,
        promotionId: PROMOTION_ID,
      }),
    ).resolves.toEqual({ outcome: 'not_eligible', reason: 'expired' });

    // Both clock observations belong to the one interactive transaction.
    expect(harness.$transaction).toHaveBeenCalledTimes(1);
    expect(harness.outbox.publish).not.toHaveBeenCalled();
    // Lock + post-lock clock read only: nothing was seeded or flipped.
    expect(harness.calls).toHaveLength(2);
  });

  it.each([
    ['the lock is granted exactly at the end date', 0, 'expired'],
    ['the lock is granted one millisecond before the end date', 1, null],
  ])(
    'honours the end-date boundary when %s',
    async (_label, lockOffsetMs, ineligibleReason) => {
      const transactionStart = new Date('2026-07-05T12:00:00.000Z');
      const lockAcquired = new Date(transactionStart.getTime() + 60_000);
      const endDate = new Date(lockAcquired.getTime() + lockOffsetMs);
      const harness = makeHarness([promotionRow({ endDate })], {
        transactionStart,
        lockAcquired,
      });

      const result = await harness.repository.claimExpiryAlert({
        tenantId: TENANT_ID,
        promotionId: PROMOTION_ID,
      });

      if (ineligibleReason === null) {
        expect(result).toEqual({
          outcome: 'claimed',
          endDate: endDate.toISOString(),
          endDateFingerprint: endDate.toISOString(),
        });
        return;
      }
      expect(result).toEqual({
        outcome: 'not_eligible',
        reason: ineligibleReason,
      });
      expect(harness.outbox.publish).not.toHaveBeenCalled();
    },
  );

  it('rejects a promotion id owned by another tenant as not found', async () => {
    const harness = makeHarness([promotionRow({ tenantId: OTHER_TENANT_ID })]);

    await expect(
      harness.repository.claimExpiryAlert({
        tenantId: TENANT_ID,
        promotionId: PROMOTION_ID,
      }),
    ).resolves.toEqual({
      outcome: 'not_eligible',
      reason: 'promotion_not_found',
    });
    expect(harness.calls).toHaveLength(1);
    expect(harness.outbox.publish).not.toHaveBeenCalled();
  });

  it('never publishes the stale scanner date when the promotion was ended meanwhile', async () => {
    const harness = makeHarness([
      promotionRow({ endDate: new Date('2026-07-01T00:00:00.000Z') }),
    ]);

    await expect(
      harness.repository.claimExpiryAlert({
        tenantId: TENANT_ID,
        promotionId: PROMOTION_ID,
      }),
    ).resolves.toEqual({ outcome: 'not_eligible', reason: 'expired' });
    // The locked re-read and its post-lock clock read are the only statements:
    // no seed, flip, or event.
    expect(harness.calls).toHaveLength(2);
    expect(harness.outbox.publish).not.toHaveBeenCalled();
  });

  it.each([
    ['empty tenantId', { tenantId: '', promotionId: PROMOTION_ID }],
    ['empty promotionId', { tenantId: TENANT_ID, promotionId: '' }],
  ])('rejects %s before opening a transaction', async (_label, claim) => {
    const harness = makeHarness([promotionRow()]);

    await expect(
      harness.repository.claimExpiryAlert(claim),
    ).rejects.toMatchObject({ code: 'PROMOTION_EXPIRY_ALERT_CLAIM_INVALID' });
    expect(harness.$transaction).not.toHaveBeenCalled();
    expect(harness.outbox.publish).not.toHaveBeenCalled();
  });

  it('propagates an outbox failure so the claim transaction rolls back', async () => {
    const harness = makeHarness([promotionRow()]);
    harness.outbox.publish.mockRejectedValue(new Error('outbox unavailable'));

    await expect(
      harness.repository.claimExpiryAlert({
        tenantId: TENANT_ID,
        promotionId: PROMOTION_ID,
      }),
    ).rejects.toThrow('outbox unavailable');
  });

  it.each([
    ['exactly at the read instant', 0, 'expired'],
    ['one millisecond inside the window', 1, null],
    [
      'exactly at the seven day threshold',
      PROMOTION_EXPIRY_ALERT_WINDOW_MS,
      null,
    ],
    [
      'one millisecond past the seven day threshold',
      PROMOTION_EXPIRY_ALERT_WINDOW_MS + 1,
      'end_date_out_of_window',
    ],
  ])(
    'classifies an end date %s',
    async (_label, offsetMs, ineligibleReason) => {
      const endDate = new Date(READ_AT.getTime() + offsetMs);
      const harness = makeHarness([promotionRow({ endDate })]);

      const result = await harness.repository.claimExpiryAlert({
        tenantId: TENANT_ID,
        promotionId: PROMOTION_ID,
      });

      if (ineligibleReason === null) {
        expect(result).toEqual({
          outcome: 'claimed',
          endDate: endDate.toISOString(),
          endDateFingerprint: endDate.toISOString(),
        });
        return;
      }
      expect(result).toEqual({
        outcome: 'not_eligible',
        reason: ineligibleReason,
      });
      expect(harness.calls).toHaveLength(2);
      expect(harness.outbox.publish).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'the promotion was manually ended',
      { manuallyEnded: true },
      'manually_ended',
    ],
    [
      'the promotion has not started yet',
      { startDate: new Date('2026-07-06T06:00:00.000Z') },
      'not_started',
    ],
    ['the promotion has no end date', { endDate: null }, 'end_date_missing'],
  ])('returns not_eligible when %s', async (_label, overrides, reason) => {
    const harness = makeHarness([promotionRow(overrides)]);

    await expect(
      harness.repository.claimExpiryAlert({
        tenantId: TENANT_ID,
        promotionId: PROMOTION_ID,
      }),
    ).resolves.toEqual({ outcome: 'not_eligible', reason });
    expect(harness.calls).toHaveLength(2);
    expect(harness.outbox.publish).not.toHaveBeenCalled();
  });
});

describe('promotion.expiring.detected payload contract (pca-3c1a)', () => {
  it('freezes the outbox event type and its Inngest consumer name', () => {
    expect(PROMOTION_EXPIRING_EVENT_TYPE).toBe('promotion.expiring.detected');
    expect(PROMOTION_EXPIRING_INNGEST_EVENT).toBe(
      'promotion/expiring.detected',
    );
  });

  it('reads the tenant-qualified fingerprint identity from a valid payload', () => {
    expect(
      readPromotionExpiryIdentity({
        tenantId: TENANT_ID,
        promotionId: PROMOTION_ID,
        endDate: END_DATE_ISO,
        endDateFingerprint: END_DATE_ISO,
        occurredAt: READ_AT.toISOString(),
      }),
    ).toEqual({
      tenantId: TENANT_ID,
      promotionId: PROMOTION_ID,
      endDateFingerprint: END_DATE_ISO,
    });
  });

  it.each([
    ['null payload', null],
    ['array payload', []],
    ['scalar payload', 'promotion'],
    ['missing fingerprint', { tenantId: TENANT_ID, promotionId: PROMOTION_ID }],
    [
      'empty fingerprint',
      {
        tenantId: TENANT_ID,
        promotionId: PROMOTION_ID,
        endDateFingerprint: '',
      },
    ],
    [
      'non-string fingerprint',
      {
        tenantId: TENANT_ID,
        promotionId: PROMOTION_ID,
        endDateFingerprint: 7,
      },
    ],
  ])('returns null for an unusable %s', (_label, payload) => {
    expect(readPromotionExpiryIdentity(payload as Prisma.JsonValue)).toBeNull();
  });
});
