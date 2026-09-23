/**
 * Integration spec for PrismaPromotionExpiryAlertStateRepository against real
 * PostgreSQL — pca-3c1b.
 *
 * `pca-3c1a` proved the expiry-claim contract with a stateful in-memory Prisma
 * double; this spec replaces those assumptions with the real database the
 * adapter will run against in production:
 *
 *   1. persisted-endDate fingerprint A→B→A dedupes once per effective date and
 *      reuses the original A row (never a second alert for the same date);
 *   2. sequential retries and concurrent same-promotion claims collapse to one
 *      winner, one state row, and one outbox event;
 *   3. tenant scope is explicit: a foreign promotion is `promotion_not_found`,
 *      the owning tenant can still alert, and the real composite FK rejects a
 *      cross-tenant state row;
 *   4. the state seed + guarded flip roll back when `OutboxWriterService.publish`
 *      fails, and the rolled-back fingerprint is not burned for a retry;
 *   5. raw `SELECT "endDate"` and the typed Prisma client round-trip the same
 *      `DateTime` (millisecond ISO identity) and the real unique index is the
 *      `ON CONFLICT` target the adapter depends on;
 *   6. a claim transaction that BEGINS before expiration but waits on the
 *      `promotions` row lock past it must classify against the post-lock
 *      `clock_timestamp()` and return `not_eligible`/`expired` with nothing
 *      published — the exact `NOW()` (transaction-fixed) defect pca-3c1a fixed.
 *
 * The lock-wait scenario is synchronized on real database state, not sleeps:
 * a dedicated connection holds `SELECT ... FOR UPDATE`, the claim is observed
 * blocked in `pg_stat_activity`, its `xact_start` is compared against the
 * moved end date, and the blocker only releases after the boundary passed.
 *
 * Loaded by `jest.integration.config.js` against the isolated test database
 * (`.env.test` → `nest-practice-test`); the dev/production DB is never touched.
 * Gated by `DATABASE_URL` and `SKIP_DB_INTEGRATION`. Every fixture and
 * assertion query is tenant qualified on `BASELINE_TENANT_ID`, and each test
 * starts from `resetAndSeedBaseline()`.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaPromotionExpiryAlertStateRepository } from './prisma-promotion-expiry-alert-state.repository';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { OutboxWriterService } from '../../shared/outbox/outbox-writer.service';
import { PROMOTION_EXPIRING_EVENT_TYPE } from '../outbox/promotion-expiry-outbox.types';
import {
  BASELINE_TENANT_ID,
  disconnectIntegrationPrisma,
  resetAndSeedBaseline,
} from '../../../test/integration/reset-db';

const unavailable =
  !process.env.DATABASE_URL || process.env.SKIP_DB_INTEGRATION === '1';
const describeIfDb = unavailable ? describe.skip : describe;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The blocker sets the end date to `clock_timestamp() + 300ms` (literal below)
 * and then holds the row lock for {@link BLOCKER_HOLD_S}, so the lock is
 * granted strictly after the boundary with a bounded safety margin.
 */
const BLOCKER_HOLD_S = 0.6;
/** Upper bound for observing the blocked claim in `pg_stat_activity`. */
const LOCK_WAIT_TIMEOUT_MS = 10_000;

interface PromotionSeed {
  tenantId?: string;
  endDate?: Date | null;
}

interface ExpiryEventRow {
  status: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: {
    tenantId: string;
    promotionId: string;
    endDate: string;
    endDateFingerprint: string;
    occurredAt: string;
  };
}

async function seedPromotion(
  prisma: PrismaClient,
  { tenantId = BASELINE_TENANT_ID, endDate }: PromotionSeed = {},
): Promise<string> {
  const promotionId = randomUUID();
  await prisma.promotion.create({
    data: {
      id: promotionId,
      tenantId,
      title: `Expiry ${promotionId.slice(0, 8)}`,
      type: 'ORDER_DISCOUNT',
      method: 'AUTOMATIC',
      discountType: 'FIXED',
      discountValue: 100,
      // Already started by default so the claim's ACTIVE revalidation is about
      // the end date, not `not_started`.
      startDate: new Date(Date.now() - DAY_MS),
      endDate:
        endDate === undefined ? new Date(Date.now() + 3 * DAY_MS) : endDate,
    },
  });
  return promotionId;
}

async function seedForeignTenant(
  prisma: PrismaClient,
  prefix: string,
): Promise<string> {
  const tenantId = randomUUID();
  await prisma.tenant.create({
    data: {
      id: tenantId,
      name: `Expiry ${prefix} ${tenantId.slice(0, 8)}`,
      slug: `expiry-${prefix}-${tenantId}`,
    },
  });
  return tenantId;
}

function stateRows(
  prisma: PrismaClient,
  promotionId: string,
  tenantId: string = BASELINE_TENANT_ID,
) {
  return prisma.promotionExpiryAlertState.findMany({
    where: { tenantId, promotionId },
    orderBy: { endDateFingerprint: 'asc' },
  });
}

async function expiryEvents(
  prisma: PrismaClient,
  promotionId: string,
  tenantId: string = BASELINE_TENANT_ID,
): Promise<ExpiryEventRow[]> {
  const rows = await prisma.outboxEvent.findMany({
    where: {
      tenantId,
      eventType: PROMOTION_EXPIRING_EVENT_TYPE,
      aggregateId: promotionId,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      status: true,
      aggregateType: true,
      aggregateId: true,
      eventType: true,
      payload: true,
    },
  });
  return rows.map((row) => ({
    ...row,
    payload: row.payload as unknown as ExpiryEventRow['payload'],
  }));
}

async function readDbClock(prisma: PrismaClient): Promise<Date> {
  const rows = await prisma.$queryRaw<Array<{ now: Date }>>(
    Prisma.sql`SELECT clock_timestamp() AS "now"`,
  );
  return rows[0].now;
}

/**
 * Opens a dedicated connection for the row-lock blocker. A separate client (not
 * the shared suite client) keeps the long-lived interactive transaction on its
 * own pool slot so it cannot starve the SUT or the observer queries.
 */
function openBlockerClient(): PrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('[expiry integration] DATABASE_URL is unset');
  }
  return new PrismaClient({ datasources: { db: { url } } });
}

/**
 * Polls `pg_stat_activity` until the claim's locked read is blocked on the
 * promotion row lock, then returns that backend's transaction start instant
 * (`xact_start`, the same instant `NOW()`/`transaction_timestamp()` reports).
 * This synchronizes the scenario on observable database state instead of a
 * sleep, and gives the exact boundary the assertion compares against.
 */
async function waitForBlockedClaim(
  prisma: PrismaClient,
  timeoutMs: number = LOCK_WAIT_TIMEOUT_MS,
): Promise<Date> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<Array<{ xactStart: Date | null }>>(
      Prisma.sql`
        SELECT a.xact_start AS "xactStart"
          FROM pg_stat_activity a
         WHERE a.datname = current_database()
           AND a.wait_event_type = 'Lock'
           AND a.query LIKE '%FOR UPDATE%'
         LIMIT 1
      `,
    );
    const xactStart = rows[0]?.xactStart;
    if (xactStart) {
      return xactStart;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    'Timed out waiting for the expiry claim to block on the promotion row lock',
  );
}

describeIfDb('PrismaPromotionExpiryAlertStateRepository (PostgreSQL)', () => {
  let prisma: PrismaService;
  let repository: PrismaPromotionExpiryAlertStateRepository;
  const outboxWriter = new OutboxWriterService();

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    await resetAndSeedBaseline();
    repository = new PrismaPromotionExpiryAlertStateRepository(
      prisma,
      outboxWriter,
    );
  });

  beforeEach(async () => {
    await resetAndSeedBaseline();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await disconnectIntegrationPrisma();
  });

  it('1) A→B→A dedupes once per persisted end date and reuses the original A row', async () => {
    const endA = new Date(Date.now() + 3 * DAY_MS + 123);
    const endB = new Date(endA.getTime() + DAY_MS);
    const isoA = endA.toISOString();
    const isoB = endB.toISOString();
    const promotionId = await seedPromotion(prisma, { endDate: endA });

    const first = await repository.claimExpiryAlert({
      tenantId: BASELINE_TENANT_ID,
      promotionId,
    });
    expect(first).toEqual({
      outcome: 'claimed',
      endDate: isoA,
      endDateFingerprint: isoA,
    });
    const [stateA] = await stateRows(prisma, promotionId);
    expect(stateA.endDateFingerprint).toBe(isoA);
    expect(stateA.alerted).toBe(true);

    await prisma.promotion.update({
      where: { id: promotionId },
      data: { endDate: endB },
    });
    const second = await repository.claimExpiryAlert({
      tenantId: BASELINE_TENANT_ID,
      promotionId,
    });
    expect(second).toEqual({
      outcome: 'claimed',
      endDate: isoB,
      endDateFingerprint: isoB,
    });

    await prisma.promotion.update({
      where: { id: promotionId },
      data: { endDate: endA },
    });
    const third = await repository.claimExpiryAlert({
      tenantId: BASELINE_TENANT_ID,
      promotionId,
    });
    expect(third).toEqual({
      outcome: 'already_alerted',
      endDate: isoA,
      endDateFingerprint: isoA,
    });

    const states = await stateRows(prisma, promotionId);
    expect(states).toHaveLength(2);
    expect(states.map((state) => state.endDateFingerprint)).toEqual([
      isoA,
      isoB,
    ]);
    const reusedA = states.find((state) => state.endDateFingerprint === isoA);
    expect(reusedA?.id).toBe(stateA.id);
    expect(reusedA?.alertedAt).toEqual(stateA.alertedAt);
    expect(reusedA?.alertEpoch).toBe(1);
    expect(
      states.find((state) => state.endDateFingerprint === isoB),
    ).toMatchObject({ alerted: true, alertEpoch: 1 });

    const events = await expiryEvents(prisma, promotionId);
    expect(events).toHaveLength(2);
    expect(
      events.map((event) => event.payload.endDateFingerprint).sort(),
    ).toEqual([isoA, isoB]);
    for (const event of events) {
      expect(event).toMatchObject({
        status: 'PENDING',
        aggregateType: 'Promotion',
        aggregateId: promotionId,
        eventType: PROMOTION_EXPIRING_EVENT_TYPE,
      });
      expect(event.payload.tenantId).toBe(BASELINE_TENANT_ID);
      expect(event.payload.promotionId).toBe(promotionId);
      expect(event.payload.endDate).toBe(event.payload.endDateFingerprint);
      expect(new Date(event.payload.occurredAt).toISOString()).toBe(
        event.payload.occurredAt,
      );
    }
  });

  it('2) a sequential retry of the same end date collapses without a second event', async () => {
    const endDate = new Date(Date.now() + 2 * DAY_MS + 321);
    const iso = endDate.toISOString();
    const promotionId = await seedPromotion(prisma, { endDate });

    const first = await repository.claimExpiryAlert({
      tenantId: BASELINE_TENANT_ID,
      promotionId,
    });
    const retry = await repository.claimExpiryAlert({
      tenantId: BASELINE_TENANT_ID,
      promotionId,
    });

    expect(first).toEqual({
      outcome: 'claimed',
      endDate: iso,
      endDateFingerprint: iso,
    });
    expect(retry).toEqual({
      outcome: 'already_alerted',
      endDate: iso,
      endDateFingerprint: iso,
    });
    const states = await stateRows(prisma, promotionId);
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ alerted: true, alertEpoch: 1 });
    expect(await expiryEvents(prisma, promotionId)).toHaveLength(1);
  });

  it('3) concurrent claims for one promotion serialize to exactly one alert', async () => {
    const endDate = new Date(Date.now() + 4 * DAY_MS + 654);
    const iso = endDate.toISOString();
    const promotionId = await seedPromotion(prisma, { endDate });

    const settled = await Promise.allSettled([
      repository.claimExpiryAlert({
        tenantId: BASELINE_TENANT_ID,
        promotionId,
      }),
      repository.claimExpiryAlert({
        tenantId: BASELINE_TENANT_ID,
        promotionId,
      }),
    ]);

    const outcomes = settled
      .map((result) => {
        if (result.status !== 'fulfilled') {
          throw new Error(`claim rejected: ${String(result.reason)}`);
        }
        return result.value.outcome;
      })
      .sort();
    expect(outcomes).toEqual(['already_alerted', 'claimed']);

    const states = await stateRows(prisma, promotionId);
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({
      endDateFingerprint: iso,
      alerted: true,
      alertEpoch: 1,
    });
    const events = await expiryEvents(prisma, promotionId);
    expect(events).toHaveLength(1);
    expect(events[0].payload.endDateFingerprint).toBe(iso);
  });

  it('4) tenant scope stays explicit and the composite FK rejects cross-tenant state', async () => {
    const foreignTenantId = await seedForeignTenant(prisma, 'foreign');
    const foreignPromotionId = await seedPromotion(prisma, {
      tenantId: foreignTenantId,
    });

    // The baseline tenant cannot even find the foreign promotion id: the
    // locked re-read is tenant qualified, so nothing is written.
    const foreign = await repository.claimExpiryAlert({
      tenantId: BASELINE_TENANT_ID,
      promotionId: foreignPromotionId,
    });
    expect(foreign).toEqual({
      outcome: 'not_eligible',
      reason: 'promotion_not_found',
    });
    expect(
      await stateRows(prisma, foreignPromotionId, BASELINE_TENANT_ID),
    ).toHaveLength(0);
    expect(await expiryEvents(prisma, foreignPromotionId)).toHaveLength(0);

    // The owning tenant can still alert its own promotion.
    const owned = await repository.claimExpiryAlert({
      tenantId: foreignTenantId,
      promotionId: foreignPromotionId,
    });
    expect(owned.outcome).toBe('claimed');
    expect(
      await stateRows(prisma, foreignPromotionId, foreignTenantId),
    ).toHaveLength(1);
    expect(
      await expiryEvents(prisma, foreignPromotionId, foreignTenantId),
    ).toHaveLength(1);

    // Ownership is enforced by the database, not only by the adapter: the
    // (tenantId, promotionId) composite FK rejects a mismatched state row.
    let failure: unknown;
    try {
      await prisma.promotionExpiryAlertState.create({
        data: {
          tenantId: BASELINE_TENANT_ID,
          promotionId: foreignPromotionId,
          endDateFingerprint: 'cross-tenant-probe',
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'P2003' });
    expect(
      await stateRows(prisma, foreignPromotionId, BASELINE_TENANT_ID),
    ).toHaveLength(0);
  });

  it('5) rolls back the seed, flip, and event when the outbox publish fails', async () => {
    const promotionId = await seedPromotion(prisma);
    const failingWriter = {
      publish: jest.fn().mockRejectedValue(new Error('outbox unavailable')),
    } as unknown as OutboxWriterService;
    const failingRepository = new PrismaPromotionExpiryAlertStateRepository(
      prisma,
      failingWriter,
    );

    await expect(
      failingRepository.claimExpiryAlert({
        tenantId: BASELINE_TENANT_ID,
        promotionId,
      }),
    ).rejects.toThrow('outbox unavailable');

    // One transaction: the seed and the guarded flip are gone too.
    expect(await stateRows(prisma, promotionId)).toHaveLength(0);
    expect(await expiryEvents(prisma, promotionId)).toHaveLength(0);

    // The failed attempt did not burn the fingerprint.
    const retry = await repository.claimExpiryAlert({
      tenantId: BASELINE_TENANT_ID,
      promotionId,
    });
    expect(retry.outcome).toBe('claimed');
    expect(await stateRows(prisma, promotionId)).toHaveLength(1);
    expect(await expiryEvents(prisma, promotionId)).toHaveLength(1);
  });

  it('6) round-trips DateTime through raw SQL and the typed client and backs ON CONFLICT with a real unique index', async () => {
    const endDate = new Date(Date.now() + 3 * DAY_MS + 777);
    const iso = endDate.toISOString();
    const promotionId = await seedPromotion(prisma, { endDate });

    const result = await repository.claimExpiryAlert({
      tenantId: BASELINE_TENANT_ID,
      promotionId,
    });

    // The raw `SELECT "endDate"` returned a JS Date whose ISO identity is
    // byte-identical to what Prisma writes/reads for the same column.
    const typed = await prisma.promotion.findFirstOrThrow({
      where: { id: promotionId, tenantId: BASELINE_TENANT_ID },
      select: { endDate: true },
    });
    expect(typed.endDate).toBeInstanceOf(Date);
    expect(typed.endDate?.toISOString()).toBe(iso);
    expect(result).toEqual({
      outcome: 'claimed',
      endDate: iso,
      endDateFingerprint: iso,
    });

    const states = await stateRows(prisma, promotionId);
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({
      endDateFingerprint: iso,
      alerted: true,
      alertEpoch: 1,
    });
    // Raw INSERT supplied `updatedAt` (no DB default) and the guarded flip
    // stamped `alertedAt`; both survive as real timestamps.
    expect(states[0].createdAt).toBeInstanceOf(Date);
    expect(states[0].updatedAt).toBeInstanceOf(Date);
    expect(states[0].alertedAt).toBeInstanceOf(Date);

    const events = await expiryEvents(prisma, promotionId);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      endDate: iso,
      endDateFingerprint: iso,
    });
    const { occurredAt } = events[0].payload;
    expect(new Date(occurredAt).toISOString()).toBe(occurredAt);

    // The adapter's `ON CONFLICT ("tenantId","promotionId",
    // "endDateFingerprint")` requires a real composite unique index; the
    // database rejects a duplicate fingerprint written around the adapter.
    let failure: unknown;
    try {
      await prisma.promotionExpiryAlertState.create({
        data: {
          tenantId: BASELINE_TENANT_ID,
          promotionId,
          endDateFingerprint: iso,
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'P2002' });
  });

  it('7) classifies a claim that began before expiration but waited on the row lock past it', async () => {
    // Seed out of the alert window; the blocker moves it to a tight boundary
    // strictly after the claim's transaction start and before its lock grant.
    const promotionId = await seedPromotion(prisma, {
      endDate: new Date(Date.now() + 30 * DAY_MS),
    });
    const blocker = openBlockerClient();

    try {
      let markLockHeld: () => void = () => undefined;
      const lockHeld = new Promise<void>((resolve) => {
        markLockHeld = resolve;
      });
      let releaseBlocker: () => void = () => undefined;
      const blockerMayProceed = new Promise<void>((resolve) => {
        releaseBlocker = resolve;
      });

      const blockerRun = blocker.$transaction(
        async (tx) => {
          await tx.$queryRaw(Prisma.sql`
              SELECT "id" FROM "promotions"
               WHERE "id" = ${promotionId}
                 AND "tenantId" = ${BASELINE_TENANT_ID}
               FOR UPDATE
            `);
          markLockHeld();

          // Hold until the test has confirmed the claim is blocked, so the
          // claim's BEGIN is guaranteed to precede the new end date.
          await blockerMayProceed;
          // Interval is a fixed literal (never interpolated): only the
          // promotion id and tenant are parameters.
          await tx.$executeRaw(Prisma.sql`
              UPDATE "promotions"
                 SET "endDate" = clock_timestamp() + interval '300 milliseconds'
               WHERE "id" = ${promotionId}
                 AND "tenantId" = ${BASELINE_TENANT_ID}
            `);
          // Commit strictly after the boundary plus a safety margin. The
          // `SELECT 1 FROM pg_sleep(...)` shape avoids deserializing the
          // function's `void` return type.
          await tx.$queryRaw(
            Prisma.sql`SELECT 1 AS "slept" FROM pg_sleep(${BLOCKER_HOLD_S})`,
          );
        },
        { maxWait: 10_000, timeout: 20_000 },
      );

      await lockHeld;
      const claim = repository.claimExpiryAlert({
        tenantId: BASELINE_TENANT_ID,
        promotionId,
      });
      const xactStart = await waitForBlockedClaim(prisma);
      releaseBlocker();
      await blockerRun;

      const persisted = await prisma.promotion.findFirstOrThrow({
        where: { id: promotionId, tenantId: BASELINE_TENANT_ID },
        select: { endDate: true },
      });
      const endDate = persisted.endDate;
      if (endDate === null) {
        throw new Error('expected the blocker to persist an end date');
      }

      // The claim's transaction began BEFORE expiration…
      expect(xactStart.getTime()).toBeLessThan(endDate.getTime());
      // …and its row lock was granted AFTER it, so the post-lock
      // `clock_timestamp()` is past the end date. A transaction-fixed `NOW()`
      // would still report `xactStart` and wrongly publish the alert.
      const lockGrantedAt = await readDbClock(prisma);
      expect(endDate.getTime()).toBeLessThan(lockGrantedAt.getTime());

      await expect(claim).resolves.toEqual({
        outcome: 'not_eligible',
        reason: 'expired',
      });
      expect(await stateRows(prisma, promotionId)).toHaveLength(0);
      expect(await expiryEvents(prisma, promotionId)).toHaveLength(0);
    } finally {
      await blocker.$disconnect();
    }
  });
});
