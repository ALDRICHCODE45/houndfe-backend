/**
 * UNIT SPEC: PromotionExpiryScanner — pca-3c2.
 *
 * The scanner is the scheduled producer of expiry-alert candidates. It runs
 * OUTSIDE the HTTP CLS context (no ambient transaction, no tenant extension),
 * so it injects the global `PrismaService` and the committed
 * `PROMOTION_EXPIRY_ALERT_STATE_REPOSITORY` port. It never trusts the stale
 * persisted `status` column: eligibility is derived from dates only.
 *
 * Contract pinned here:
 *
 *   1. SCAN PREDICATE — only effectively ACTIVE promotions that end inside
 *      `(now, now+7d]`: `manuallyEnded = FALSE`, `endDate IS NOT NULL`,
 *      `endDate > NOW()`, `endDate <= NOW() + INTERVAL '7 days'`, and an open
 *      or already-started `startDate`. A stale `status` value is ignored.
 *   2. ATOMIC CLAIM — every candidate is handed to
 *      `claimExpiryAlert({ tenantId, promotionId })`; the repository owns the
 *      post-lock revalidation, so the scanner never decides on its own.
 *   3. BOUNDED TICK — at most `batchSize` candidates per tick, so one tick
 *      cannot read or claim an unbounded due set.
 *   4. NO STARVATION — the in-memory rotation cursor advances past the last
 *      scanned id and wraps to the start once the due set is exhausted, so a
 *      due set larger than the batch cap is fully covered across ticks.
 *   5. NO OVERLAP + ISOLATION — a tick in flight blocks the next, a per-item
 *      failure never aborts the batch, and a batch-read failure never rejects
 *      out of the scheduled tick.
 *
 * The fake Prisma double below is STATEFUL: it evaluates the documented
 * eligibility window and the rotation cursor against a real fixture set, so
 * rotation, boundary, and wrap behavior are proven by observed outcomes rather
 * than by asserting that a mock was called.
 *
 * Scope note: this proves source-level, in-memory behavior only. Real
 * PostgreSQL planning, the claim transaction, and the outbox write belong to
 * `pca-3c1a`/`pca-3c1b`. The module stays unregistered until `pca-3c4c`
 * activates the complete delivery path.
 */
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../shared/prisma/prisma.service';
import {
  PROMOTION_EXPIRY_ALERT_STATE_REPOSITORY,
  PROMOTION_EXPIRY_ALERT_WINDOW_DAYS,
  PROMOTION_EXPIRY_ALERT_WINDOW_MS,
  type PromotionExpiryAlertClaim,
  type PromotionExpiryAlertClaimResult,
} from '../domain/promotion-expiry-alert-state.repository';
import { PrismaPromotionExpiryAlertStateRepository } from '../infrastructure/prisma-promotion-expiry-alert-state.repository';
import { PromotionExpiryModule } from './promotion-expiry.module';
import {
  PROMOTION_EXPIRY_SCANNER_BATCH_SIZE,
  PROMOTION_EXPIRY_SCANNER_INTERVAL_MS,
  PromotionExpiryScanner,
  type PromotionExpiryCandidate,
} from './promotion-expiry.scanner';

/** The scan instant the fake database clock reports for `NOW()`. */
const NOW = new Date('2026-07-05T12:00:00.000Z');
const WINDOW_MS = PROMOTION_EXPIRY_ALERT_WINDOW_MS;
const END_ISO = '2026-07-10T05:59:59.999Z';

/** One `promotions` row as the fake scan query sees it. */
type PromotionFixture = {
  promotionId: string;
  tenantId: string;
  /** Persisted status column; stale values must be ignored by the scanner. */
  status: string;
  startDate: Date | null;
  endDate: Date | null;
  manuallyEnded: boolean;
};

/** Raw `Prisma.sql` statement as the fake `$queryRaw` sees it. */
type RawQuery = { sql: string; values: unknown[] };

function offset(ms: number): Date {
  return new Date(NOW.getTime() + ms);
}

function promotion(
  overrides: Partial<PromotionFixture> = {},
): PromotionFixture {
  return {
    promotionId: 'id-01',
    tenantId: 'tenant-1',
    status: 'ACTIVE',
    startDate: offset(-24 * 60 * 60 * 1000),
    endDate: offset(3 * 24 * 60 * 60 * 1000),
    manuallyEnded: false,
    ...overrides,
  };
}

/**
 * Applies the documented scan predicate, the rotation cursor, and the batch
 * cap to the fixture set — the same semantics the SQL expresses, so the
 * scanner's observed claims are a real outcome of the fake data.
 */
function selectDue(
  rows: PromotionFixture[],
  query: RawQuery,
): PromotionExpiryCandidate[] {
  const limit = Number(query.values[query.values.length - 1]);
  const cursor = query.values.length > 2 ? String(query.values[1]) : null;
  const nowMs = NOW.getTime();

  return rows
    .filter((row) => !row.manuallyEnded)
    .filter((row) => row.endDate !== null && row.endDate.getTime() > nowMs)
    .filter(
      (row) =>
        row.endDate !== null && row.endDate.getTime() <= nowMs + WINDOW_MS,
    )
    .filter((row) => row.startDate === null || row.startDate.getTime() <= nowMs)
    .filter((row) => cursor === null || row.promotionId > cursor)
    .sort((a, b) => (a.promotionId < b.promotionId ? -1 : 1))
    .slice(0, limit)
    .map((row) => ({
      promotionId: row.promotionId,
      tenantId: row.tenantId,
    }));
}

type QueryRawMock = jest.Mock<Promise<PromotionExpiryCandidate[]>, [RawQuery]>;

function makePrisma(rows: PromotionFixture[]) {
  const calls: RawQuery[] = [];
  const $queryRaw: QueryRawMock = jest.fn((query: RawQuery) => {
    calls.push({ sql: query.sql, values: query.values });
    return Promise.resolve(selectDue(rows, query));
  });

  return {
    prisma: { $queryRaw } as unknown as PrismaService,
    $queryRaw,
    calls,
  };
}

function claimedResult(): PromotionExpiryAlertClaimResult {
  return {
    outcome: 'claimed',
    endDate: END_ISO,
    endDateFingerprint: END_ISO,
  };
}

function makeRepository() {
  const claimExpiryAlert = jest.fn<
    Promise<PromotionExpiryAlertClaimResult>,
    [PromotionExpiryAlertClaim]
  >(() => Promise.resolve(claimedResult()));

  return {
    claimExpiryAlert,
    // Read through `mock.calls` so claims made by a one-off
    // `mockImplementationOnce` override are still observable.
    get claims(): PromotionExpiryAlertClaim[] {
      return claimExpiryAlert.mock.calls.map(([claim]) => claim);
    },
  };
}

function buildScanner(
  prisma: unknown,
  repository: unknown,
  intervalMs = 0,
  batchSize = 25,
): PromotionExpiryScanner {
  return new PromotionExpiryScanner(
    prisma as never,
    repository as never,
    intervalMs,
    batchSize,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

describe('PromotionExpiryScanner (pca-3c2)', () => {
  it('scans only effectively ACTIVE promotions ending inside (now, now+7d] and never trusts the persisted status', async () => {
    const rows: PromotionFixture[] = [
      // Included: plain active, stale status must not exclude it.
      promotion({ promotionId: 'id-01', status: 'ENDED' }),
      // Included: end date exactly at the inclusive window boundary.
      promotion({ promotionId: 'id-02', endDate: offset(WINDOW_MS) }),
      // Excluded: no end date.
      promotion({ promotionId: 'id-03', endDate: null }),
      // Excluded: scheduled (not started yet).
      promotion({
        promotionId: 'id-04',
        startDate: offset(24 * 60 * 60 * 1000),
      }),
      // Excluded: already expired at the read instant.
      promotion({ promotionId: 'id-05', endDate: NOW }),
      // Excluded: one millisecond past the inclusive window boundary.
      promotion({ promotionId: 'id-06', endDate: offset(WINDOW_MS + 1) }),
      // Excluded: manually ended.
      promotion({ promotionId: 'id-07', manuallyEnded: true }),
      // Included: open start date + near end date.
      promotion({
        promotionId: 'id-08',
        startDate: null,
        endDate: offset(60 * 60 * 1000),
      }),
      // Included: start date exactly at the read instant.
      promotion({ promotionId: 'id-09', startDate: NOW }),
    ];
    const harness = makePrisma(rows);
    const repository = makeRepository();
    const scanner = buildScanner(harness.prisma, repository);

    const summary = await scanner.scan();

    const sql = harness.calls[0].sql;
    expect(sql).toMatch(/FROM "promotions"/);
    expect(sql).toContain(`"manuallyEnded" = FALSE`);
    expect(sql).toContain(`"endDate" IS NOT NULL`);
    expect(sql).toContain(`"endDate" > NOW()`);
    expect(sql).toContain(`"endDate" <= NOW() + (? * INTERVAL '1 day')`);
    expect(sql).toContain(`("startDate" IS NULL OR "startDate" <= NOW())`);
    expect(sql).toMatch(/ORDER BY "id" ASC/);
    expect(sql).toMatch(/LIMIT \?/);
    // The window is bound from the shared constant, never interpolated.
    expect(harness.calls[0].values[0]).toBe(PROMOTION_EXPIRY_ALERT_WINDOW_DAYS);
    // Dates decide ACTIVE: a stale persisted status must never be consulted,
    // and the scanner must not hold row locks (the claim owns the lock).
    expect(sql).not.toMatch(/"status"/);
    expect(sql).not.toMatch(/FOR\s+UPDATE/i);

    expect(summary.scanned).toBe(4);
    expect(repository.claims).toEqual([
      { tenantId: 'tenant-1', promotionId: 'id-01' },
      { tenantId: 'tenant-1', promotionId: 'id-02' },
      { tenantId: 'tenant-1', promotionId: 'id-08' },
      { tenantId: 'tenant-1', promotionId: 'id-09' },
    ]);
  });

  it('hands each candidate to the atomic claim with its own tenantId and promotionId in id order', async () => {
    const rows: PromotionFixture[] = [
      promotion({ promotionId: 'id-01', tenantId: 'tenant-a' }),
      promotion({ promotionId: 'id-02', tenantId: 'tenant-b' }),
      promotion({ promotionId: 'id-03', tenantId: 'tenant-c' }),
    ];
    const harness = makePrisma(rows);
    const repository = makeRepository();
    const scanner = buildScanner(harness.prisma, repository);

    await scanner.scan();

    expect(repository.claimExpiryAlert).toHaveBeenCalledTimes(3);
    expect(repository.claims).toEqual([
      { tenantId: 'tenant-a', promotionId: 'id-01' },
      { tenantId: 'tenant-b', promotionId: 'id-02' },
      { tenantId: 'tenant-c', promotionId: 'id-03' },
    ]);
  });

  it('summarizes claim outcomes without treating already-alerted or ineligible rows as failures', async () => {
    const rows: PromotionFixture[] = [
      promotion({ promotionId: 'id-01' }),
      promotion({ promotionId: 'id-02' }),
      promotion({ promotionId: 'id-03' }),
      promotion({ promotionId: 'id-04' }),
    ];
    const harness = makePrisma(rows);
    const repository = makeRepository();
    repository.claimExpiryAlert
      .mockImplementationOnce(() => Promise.resolve(claimedResult()))
      .mockImplementationOnce(() =>
        Promise.resolve({
          outcome: 'already_alerted' as const,
          endDate: END_ISO,
          endDateFingerprint: END_ISO,
        }),
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          outcome: 'not_eligible' as const,
          reason: 'expired' as const,
        }),
      )
      .mockImplementationOnce(() => Promise.resolve(claimedResult()));
    const scanner = buildScanner(harness.prisma, repository);

    const summary = await scanner.scan();

    expect(summary).toEqual({
      scanned: 4,
      claimed: 2,
      alreadyAlerted: 1,
      notEligible: 1,
      failures: 0,
    });
  });

  it('isolates a per-item claim failure and keeps scanning the rest of the batch', async () => {
    const rows: PromotionFixture[] = [
      promotion({ promotionId: 'id-01' }),
      promotion({ promotionId: 'id-02' }),
      promotion({ promotionId: 'id-03' }),
    ];
    const harness = makePrisma(rows);
    const repository = makeRepository();
    repository.claimExpiryAlert
      .mockImplementationOnce(() => Promise.resolve(claimedResult()))
      .mockImplementationOnce(() =>
        Promise.reject(new Error('claim-BOOM — must NOT abort the batch')),
      )
      .mockImplementationOnce(() => Promise.resolve(claimedResult()));
    const scanner = buildScanner(harness.prisma, repository);

    const summary = await scanner.scan();

    expect(repository.claimExpiryAlert).toHaveBeenCalledTimes(3);
    expect(summary).toEqual({
      scanned: 3,
      claimed: 2,
      alreadyAlerted: 0,
      notEligible: 0,
      failures: 1,
    });
  });

  it('bounds every tick to batchSize and rotates through a due set larger than the cap without starving it', async () => {
    const rows: PromotionFixture[] = [
      'id-01',
      'id-02',
      'id-03',
      'id-04',
      'id-05',
    ].map((promotionId) => promotion({ promotionId }));
    const harness = makePrisma(rows);
    const repository = makeRepository();
    const scanner = buildScanner(harness.prisma, repository, 0, 2);

    const first = await scanner.scan();
    const afterFirst = [...repository.claims];
    const second = await scanner.scan();
    const third = await scanner.scan();

    // Bounded: never more than batchSize candidates (and claims) in one tick.
    expect(first.scanned).toBe(2);
    expect(second.scanned).toBe(2);
    expect(third.scanned).toBe(1);
    expect(harness.calls[0].values).toEqual([
      PROMOTION_EXPIRY_ALERT_WINDOW_DAYS,
      2,
    ]);
    // The cursor advanced past the last scanned id on each tick.
    expect(harness.calls[1].values).toEqual([
      PROMOTION_EXPIRY_ALERT_WINDOW_DAYS,
      'id-02',
      2,
    ]);
    expect(harness.calls[2].values).toEqual([
      PROMOTION_EXPIRY_ALERT_WINDOW_DAYS,
      'id-04',
      2,
    ]);

    // No starvation: the whole due set is covered across three ticks.
    const coveredAcrossTicks = repository.claims.map(
      (claim) => claim.promotionId,
    );
    expect(coveredAcrossTicks).toEqual([
      'id-01',
      'id-02',
      'id-03',
      'id-04',
      'id-05',
    ]);
    expect(afterFirst.map((claim) => claim.promotionId)).toEqual([
      'id-01',
      'id-02',
    ]);
  });

  it('wraps the rotation cursor to the start once the due set is exhausted and after an empty tick', async () => {
    const rows: PromotionFixture[] = [
      promotion({ promotionId: 'id-01' }),
      promotion({ promotionId: 'id-02' }),
    ];
    const harness = makePrisma(rows);
    const repository = makeRepository();
    const scanner = buildScanner(harness.prisma, repository, 0, 1);

    await scanner.scan(); // id-01 (cursor advances to id-01)
    await scanner.scan(); // id-02 (end of range → cursor resets)
    const empty = await scanner.scan(); // no rows → cursor stays reset
    await scanner.scan(); // wraps back to id-01

    expect(empty).toEqual({
      scanned: 0,
      claimed: 0,
      alreadyAlerted: 0,
      notEligible: 0,
      failures: 0,
    });
    expect(harness.calls[2].values).toEqual([
      PROMOTION_EXPIRY_ALERT_WINDOW_DAYS,
      'id-02',
      1,
    ]);
    expect(harness.calls[3].values).toEqual([
      PROMOTION_EXPIRY_ALERT_WINDOW_DAYS,
      1,
    ]);
    expect(repository.claims.map((claim) => claim.promotionId)).toEqual([
      'id-01',
      'id-02',
      'id-01',
    ]);
  });

  it('lets a retryable claim failure leave the tail reachable on the next rotation', async () => {
    const rows: PromotionFixture[] = [
      promotion({ promotionId: 'id-01' }),
      promotion({ promotionId: 'id-02' }),
    ];
    const harness = makePrisma(rows);
    const repository = makeRepository();
    repository.claimExpiryAlert
      .mockImplementationOnce(() => Promise.reject(new Error('transient-BOOM')))
      .mockImplementationOnce(() => Promise.resolve(claimedResult()));
    const scanner = buildScanner(harness.prisma, repository, 0, 1);

    const first = await scanner.scan();
    const second = await scanner.scan();

    // The failing head did not block the tail.
    expect(first.failures).toBe(1);
    expect(second.claimed).toBe(1);
    expect(repository.claims.map((claim) => claim.promotionId)).toEqual([
      'id-01',
      'id-02',
    ]);
    expect(harness.calls[1].values).toEqual([
      PROMOTION_EXPIRY_ALERT_WINDOW_DAYS,
      'id-01',
      1,
    ]);
  });

  it('prevents overlapping ticks and releases the guard when the tick settles', async () => {
    const rows: PromotionFixture[] = [promotion({ promotionId: 'id-01' })];
    const harness = makePrisma(rows);
    const repository = makeRepository();
    const pending = deferred<PromotionExpiryAlertClaimResult>();
    repository.claimExpiryAlert.mockImplementationOnce(() => pending.promise);
    const scanner = buildScanner(harness.prisma, repository, 0, 25);

    const first = scanner.poll();
    await flushMicrotasks();
    expect(harness.calls).toHaveLength(1);

    // The tick is still in flight (awaiting the claim) → the next tick is a no-op.
    const second = scanner.poll();
    await second;
    expect(harness.calls).toHaveLength(1);

    pending.resolve(claimedResult());
    await first;
    expect(harness.calls).toHaveLength(1);
    expect(repository.claimExpiryAlert).toHaveBeenCalledTimes(1);

    // The guard was released in `finally` → the next tick runs again.
    await scanner.poll();
    expect(harness.calls).toHaveLength(2);
  });

  it('throttles ticks by the injectable interval', async () => {
    const rows: PromotionFixture[] = [promotion({ promotionId: 'id-01' })];
    const harness = makePrisma(rows);
    const repository = makeRepository();
    const scanner = buildScanner(harness.prisma, repository, 5000, 25);

    await scanner.poll();
    await scanner.poll();

    expect(harness.calls).toHaveLength(1);
    expect(repository.claimExpiryAlert).toHaveBeenCalledTimes(1);
  });

  it('never rejects a scheduled tick when the batch read fails, and recovers on the next tick', async () => {
    const rows: PromotionFixture[] = [promotion({ promotionId: 'id-01' })];
    const harness = makePrisma(rows);
    const repository = makeRepository();
    const scanner = buildScanner(harness.prisma, repository, 0, 25);

    harness.$queryRaw.mockRejectedValueOnce(new Error('scan-read-BOOM'));

    await expect(scanner.poll()).resolves.toBeUndefined();
    expect(repository.claimExpiryAlert).not.toHaveBeenCalled();

    await scanner.poll();
    expect(repository.claims).toEqual([
      { tenantId: 'tenant-1', promotionId: 'id-01' },
    ]);
  });

  it('exposes the documented interval/batch injection tokens', () => {
    expect(typeof PROMOTION_EXPIRY_SCANNER_INTERVAL_MS).toBe('symbol');
    expect(typeof PROMOTION_EXPIRY_SCANNER_BATCH_SIZE).toBe('symbol');
  });
});

describe('PromotionExpiryModule (pca-3c2)', () => {
  it('compiles the inert module graph and resolves the scanner, its port binding, and the engineering tokens', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PromotionExpiryModule],
    })
      .overrideProvider(PrismaService)
      .useValue({ $queryRaw: jest.fn().mockResolvedValue([]) })
      .compile();

    expect(moduleRef.get(PromotionExpiryScanner)).toBeInstanceOf(
      PromotionExpiryScanner,
    );
    expect(
      moduleRef.get(PROMOTION_EXPIRY_ALERT_STATE_REPOSITORY),
    ).toBeInstanceOf(PrismaPromotionExpiryAlertStateRepository);
    expect(moduleRef.get<number>(PROMOTION_EXPIRY_SCANNER_BATCH_SIZE)).toBe(25);
    expect(moduleRef.get<number>(PROMOTION_EXPIRY_SCANNER_INTERVAL_MS)).toBe(
      300000,
    );

    await moduleRef.close();
  });
});
