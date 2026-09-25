/**
 * HD-02b2 — PrismaRestockIntakeRepository real-PostgreSQL integration spec.
 *
 * Proves the adapter seams the mocked HD-02b1 spec cannot: the PostgreSQL
 * unique constraints, the real `TenantPrismaService` CLS extension and the
 * cross-tenant/supersession behavior against the dedicated isolated test DB
 * (`127.0.0.1:5433/nest-practice-restock-test`). Nothing is mocked; every
 * assertion reads committed rows back through `integrationPrisma()`.
 *
 * Scope: NO source logic is exercised differently here; this file only
 * observes `submit()` against real PostgreSQL. Per-test cleanup uses
 * `resetAndSeedBaseline()` (TRUNCATE `tenants`/`users` CASCADE + re-seed the
 * baseline tenant), so a mid-test failure cannot leak rows. Tenant ids are
 * generated per test with `crypto.randomUUID()`.
 *
 * Skip guard: `SKIP_DB_INTEGRATION=1` or an unset `DATABASE_URL` skips the
 * whole suite, the same convention as the other integration specs.
 */
import type { Prisma } from '@prisma/client';
import type { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import {
  integrationPrisma,
  resetAndSeedBaseline,
  disconnectIntegrationPrisma,
} from '../../../test/integration/reset-db';
import {
  canonicalizeRestockRequest,
  RESTOCK_SOURCE,
  RESTOCK_TYPE,
} from '../domain/restock-request-canonicalizer';
import {
  RestockIntakeError,
  type RestockIntakeInput,
} from '../domain/restock-intake.repository';
import { PrismaRestockIntakeRepository } from './prisma-restock-intake.repository';

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;

const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;

/** Fixed base timestamp for valid RESOLVED predecessor fixtures. */
const PREDECESSOR_RESOLVED_AT = new Date('2026-09-25T00:00:00.000Z');
const PREDECESSOR_ACK_AT = new Date('2026-09-25T00:10:00.000Z');

interface RepositoryHarness {
  repo: PrismaRestockIntakeRepository;
  tenantPrisma: TenantPrismaService;
}

/**
 * Real Prisma-backed `TenantPrismaService` with a per-harness CLS shim. Each
 * call gets its own CLS store, so two harnesses model two independent request
 * contexts that share one PostgreSQL pool — exactly what the concurrency
 * tests need. Nothing is mocked; the CLS store is the only in-memory stand-in.
 */
function makeHarness(tenantId: string | null): RepositoryHarness {
  const store = new Map<string, unknown>();
  store.set('tenantId', tenantId);
  store.set('isSuperAdmin', false);
  const cls = {
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => {
      store.set(key, value);
    },
  } as unknown as ClsService<TenantClsStore>;
  // Instance-level delegation onto a `PrismaService` prototype over the shared
  // integration client; no behavior mocked.
  const prisma = Object.assign(
    Object.create(PrismaService.prototype) as PrismaService,
    integrationPrisma(),
  );
  const tenantPrisma = new TenantPrismaService(prisma, cls);
  return {
    repo: new PrismaRestockIntakeRepository(tenantPrisma),
    tenantPrisma,
  };
}

/** Tenant-scoped Prisma client shape returned by the real service. */
type TenantScopedClient = ReturnType<TenantPrismaService['getClient']>;

interface IdentityReadObservation {
  /** True when the read ran inside `runInTransaction` (pre-insert read). */
  inTransaction: boolean;
  /** id of the row returned, or null when the identity row did not exist. */
  resultId: string | null;
}

interface SchedulingBarrier {
  /** Number of parties that have arrived (including current waiters). */
  readonly arrivals: number;
  /** Block until every party has arrived, then release all of them. */
  arrive(): Promise<void>;
}

/**
 * Upper bound for a participant that never arrives. Kept well below Jest's 30s
 * `testTimeout` so a failed race cannot leave the surviving waiter pending into
 * `afterEach` teardown.
 */
const BARRIER_TIMEOUT_MS = 10_000;

/**
 * Value-free test error for a barrier timeout: the barrier is a scheduling
 * seam, so this is test-infrastructure failure, never a product error, and it
 * carries no payload.
 */
const BARRIER_TIMEOUT_ERROR =
  'RESTOCK intake scheduling barrier timed out waiting for a partner';

/**
 * Minimal single-use barrier with no sleep-based synchronization. It only
 * widens the window in which both transactions have completed their real
 * identity read; every DB query and result stays real. The wait is bounded by
 * `timeoutMs`, the timer starts only once the first party arrives, and it is
 * cleared on a normal `parties`-party release (so nobody arriving leaves no
 * pending timer).
 */
function createSchedulingBarrier(
  parties: number,
  timeoutMs: number = BARRIER_TIMEOUT_MS,
): SchedulingBarrier {
  let arrivals = 0;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let releaseGate: () => void = () => {};
  let rejectGate: (error: Error) => void = () => {};
  const gate = new Promise<void>((resolve, reject) => {
    releaseGate = resolve;
    rejectGate = reject;
  });

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return {
    get arrivals(): number {
      return arrivals;
    },
    async arrive(): Promise<void> {
      if (settled) {
        await gate;
        return;
      }
      arrivals += 1;
      if (arrivals === parties) {
        settled = true;
        clearTimer();
        releaseGate();
        await gate;
        return;
      }
      if (timer === undefined) {
        timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            clearTimer();
            rejectGate(new Error(BARRIER_TIMEOUT_ERROR));
          }
        }, timeoutMs);
      }
      await gate;
    },
  };
}

/**
 * Narrowly identifies the idempotent intake identity read
 * (`{ tenantId, source, sourceRequestId }`) by its `sourceRequestId` predicate,
 * so no other `findFirst` shape — for example a null predecessor lookup keyed
 * by `id` — can accidentally arrive at the barrier or be recorded.
 */
function isIdentityReadWhere(
  where: Prisma.HumanDecisionFindFirstArgs['where'],
): boolean {
  return (
    where !== null && typeof where === 'object' && 'sourceRequestId' in where
  );
}

/**
 * Test-only subclass: same real `TenantPrismaService` behavior, plus ONE
 * narrow instrumentation seam. The client returned by `getClient()` still runs
 * the real tenant-scoped `humanDecision.findFirst`, but only the identity read
 * shape is recorded/barriered: for a null, in-transaction identity read the
 * adapter waits at the shared barrier before it may continue to `create()`.
 * Every method forwards to the real delegate: no DB result is mocked and no
 * adapter private method is touched. The barrier is a controlled scheduling
 * seam over real PostgreSQL, never a substitute for the real query.
 */
class BarrierTenantPrismaService extends TenantPrismaService {
  constructor(
    prisma: PrismaService,
    cls: ClsService<TenantClsStore>,
    private readonly barrier: SchedulingBarrier,
    private readonly observations: IdentityReadObservation[],
  ) {
    super(prisma, cls);
  }

  override getClient(): TenantScopedClient {
    // `super.getClient()` resolves the ambient transaction client per call.
    const client = super.getClient();
    const instrumented = {
      humanDecision: {
        findFirst: async (args: Prisma.HumanDecisionFindFirstArgs) => {
          const result = await client.humanDecision.findFirst(args);
          // Only the identity read (where has `sourceRequestId`) is observed or
          // barriered; the recovery reread stays outside the transaction, so it
          // is recorded but never waits on the barrier.
          if (isIdentityReadWhere(args.where)) {
            const inTransaction = this.isInTransaction();
            this.observations.push({
              inTransaction,
              resultId: result === null ? null : result.id,
            });
            if (result === null && inTransaction) {
              await this.barrier.arrive();
            }
          }
          return result;
        },
        create: (args: Prisma.HumanDecisionCreateArgs) =>
          client.humanDecision.create(args),
      },
      tenant: {
        findUnique: (args: Prisma.TenantFindUniqueArgs) =>
          client.tenant.findUnique(args),
      },
    };
    return instrumented as unknown as TenantScopedClient;
  }
}

function makeBarrierHarness(
  tenantId: string,
  barrier: SchedulingBarrier,
  observations: IdentityReadObservation[],
): RepositoryHarness {
  const store = new Map<string, unknown>();
  store.set('tenantId', tenantId);
  store.set('isSuperAdmin', false);
  const cls = {
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => {
      store.set(key, value);
    },
  } as unknown as ClsService<TenantClsStore>;
  const prisma = Object.assign(
    Object.create(PrismaService.prototype) as PrismaService,
    integrationPrisma(),
  );
  const tenantPrisma = new BarrierTenantPrismaService(
    prisma,
    cls,
    barrier,
    observations,
  );
  return {
    repo: new PrismaRestockIntakeRepository(tenantPrisma),
    tenantPrisma,
  };
}

function baseInput(
  overrides: Partial<RestockIntakeInput> = {},
): RestockIntakeInput {
  return {
    sourceRequestId: crypto.randomUUID(),
    productId: crypto.randomUUID(),
    productName: 'Cafe de altura',
    variantId: null,
    sku: 'SKU-1',
    requestedQuantity: 5,
    observedStockAtRequest: 0,
    stockObservedAt: '2026-09-25T10:00:00.000Z',
    supersedesDecisionId: null,
    submittedCredentialId: 'cred-1',
    ...overrides,
  };
}

function hashFor(input: RestockIntakeInput, tenantId: string): string {
  return canonicalizeRestockRequest({ ...input, tenantId }).requestHash;
}

async function seedTenant(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await integrationPrisma().tenant.create({
    data: { id, name, slug: `restock-${id}` },
  });
  return id;
}

/** Durable `RESOLVED`/`STALE` predecessor satisfying the HD-01 SQL CHECKs. */
async function seedStalePredecessor(tenantId: string): Promise<string> {
  const row = await integrationPrisma().humanDecision.create({
    data: {
      tenantId,
      source: RESTOCK_SOURCE,
      sourceRequestId: crypto.randomUUID(),
      type: RESTOCK_TYPE,
      canonicalRequestHash: 'stale-predecessor-hash',
      submittedCredentialId: 'cred-predecessor',
      branchId: tenantId,
      branchName: 'Predecessor Branch',
      productId: crypto.randomUUID(),
      productName: 'Predecessor product',
      status: 'RESOLVED',
      version: 2,
      resolutionAction: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
      resolutionRequestId: crypto.randomUUID(),
      resolvedAt: PREDECESSOR_RESOLVED_AT,
      resolvedByActorId: 'actor-predecessor',
      resolvedByDisplayName: 'Reviewer Predecessor',
      // STALE forbids attempt/provider evidence; the outcome coupling CHECK
      // still requires attempt id + evidence hash + backend receipt.
      applicationOutcome: 'STALE',
      applicationAttemptId: 'attempt-predecessor',
      applicationEvidenceHash: 'evidence-predecessor',
      ackReceivedAt: PREDECESSOR_ACK_AT,
    },
  });
  return row.id;
}

/** Still-pending predecessor: a HOLD, never supersedable. */
async function seedPendingPredecessor(tenantId: string): Promise<string> {
  const row = await integrationPrisma().humanDecision.create({
    data: {
      tenantId,
      source: RESTOCK_SOURCE,
      sourceRequestId: crypto.randomUUID(),
      type: RESTOCK_TYPE,
      canonicalRequestHash: 'pending-predecessor-hash',
      submittedCredentialId: 'cred-predecessor',
      branchId: tenantId,
      branchName: 'Predecessor Branch',
      productId: crypto.randomUUID(),
      productName: 'Predecessor product',
      status: 'PENDING',
      version: 1,
    },
  });
  return row.id;
}

/** Terminal but unresolved-delivery predecessor: a HOLD, not reconciliation. */
async function seedDeliveryUnknownPredecessor(
  tenantId: string,
): Promise<string> {
  const row = await integrationPrisma().humanDecision.create({
    data: {
      tenantId,
      source: RESTOCK_SOURCE,
      sourceRequestId: crypto.randomUUID(),
      type: RESTOCK_TYPE,
      canonicalRequestHash: 'delivery-unknown-predecessor-hash',
      submittedCredentialId: 'cred-predecessor',
      branchId: tenantId,
      branchName: 'Predecessor Branch',
      productId: crypto.randomUUID(),
      productName: 'Predecessor product',
      status: 'RESOLVED',
      version: 2,
      resolutionAction: 'PROVIDE_RESTOCK_ESTIMATE',
      restockDays: 3,
      resolutionRequestId: crypto.randomUUID(),
      resolvedAt: PREDECESSOR_RESOLVED_AT,
      resolvedByActorId: 'actor-predecessor',
      resolvedByDisplayName: 'Reviewer Predecessor',
      applicationOutcome: 'DELIVERY_UNKNOWN',
      applicationAttemptId: 'attempt-predecessor',
      applicationEvidenceHash: 'evidence-predecessor',
      applicationAttemptedAt: new Date(
        PREDECESSOR_RESOLVED_AT.getTime() + 5 * 60_000,
      ),
      ackReceivedAt: PREDECESSOR_ACK_AT,
    },
  });
  return row.id;
}

function errorCodeOf(error: unknown): string | undefined {
  return error instanceof RestockIntakeError ? error.code : undefined;
}

describeIfDb('PrismaRestockIntakeRepository (PostgreSQL integration)', () => {
  beforeAll(async () => {
    // Force the singleton construction early so a misconfigured
    // DATABASE_URL throws here (loud) rather than in the first test.
    integrationPrisma();
    await resetAndSeedBaseline();
  });

  afterEach(async () => {
    // TRUNCATE … CASCADE + re-seed: robust against any mid-test failure, and
    // it leaves the dedicated test DB at the known baseline for the next
    // test (and any later spec in the same run).
    await resetAndSeedBaseline();
  });

  afterAll(async () => {
    await disconnectIntegrationPrisma();
  });

  describe('baseline create and idempotent identity', () => {
    it('creates a PENDING v1 row with a tenant-derived snapshot and persisted audit', async () => {
      const tenantId = await seedTenant('Create Tenant');
      const input = baseInput();
      const expectedHash = hashFor(input, tenantId);
      const { repo } = makeHarness(tenantId);

      const result = await repo.submit(input);

      expect(result.status).toBe('created');
      const request = result.request;
      expect(request.source).toBe(RESTOCK_SOURCE);
      expect(request.type).toBe(RESTOCK_TYPE);
      expect(request.status).toBe('PENDING');
      expect(request.version).toBe(1);
      expect(request.supersedesDecisionId).toBeNull();
      expect(request.canonicalRequestHash).toBe(expectedHash);
      expect(request.snapshot.branchId).toBe(tenantId);
      expect(request.snapshot.branchName).toBe('Create Tenant');
      expect(request.snapshot.productId).toBe(input.productId);
      expect(request.snapshot.productName).toBe('Cafe de altura');

      const rows = await integrationPrisma().humanDecision.findMany({
        where: { tenantId },
      });
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.id).toBe(request.id);
      expect(row.source).toBe(RESTOCK_SOURCE);
      expect(row.type).toBe(RESTOCK_TYPE);
      expect(row.sourceRequestId).toBe(input.sourceRequestId);
      expect(row.canonicalRequestHash).toBe(expectedHash);
      expect(row.submittedCredentialId).toBe('cred-1');
      expect(row.branchId).toBe(tenantId);
      expect(row.branchName).toBe('Create Tenant');
      expect(row.status).toBe('PENDING');
      expect(row.version).toBe(1);
    });

    it('replays an exact identity after credential rotation without a second row or audit rewrite', async () => {
      const tenantId = await seedTenant('Replay Tenant');
      const input = baseInput({ submittedCredentialId: 'cred-original' });
      const expectedHash = hashFor(input, tenantId);
      const { repo } = makeHarness(tenantId);

      const created = await repo.submit(input);
      const beforeReplay = await integrationPrisma().humanDecision.findUnique({
        where: { id: created.request.id },
      });
      expect(beforeReplay).not.toBeNull();

      const rotated: RestockIntakeInput = {
        ...input,
        submittedCredentialId: 'cred-rotated',
      };

      const replayed = await repo.submit(rotated);

      expect(replayed.status).toBe('replayed');
      expect(replayed.request.id).toBe(created.request.id);
      expect(replayed.request.canonicalRequestHash).toBe(expectedHash);
      expect(replayed.request.snapshot.branchId).toBe(
        created.request.snapshot.branchId,
      );
      expect(replayed.request.createdAt.getTime()).toBe(
        created.request.createdAt.getTime(),
      );

      const afterReplay = await integrationPrisma().humanDecision.findUnique({
        where: { id: created.request.id },
      });
      // Full persisted record is unchanged (every snapshot, resolution and
      // outcome column plus `updatedAt`) — a before/after comparison of the
      // same row, with no time assumption.
      expect(afterReplay).toEqual(beforeReplay);
      expect(afterReplay?.updatedAt.getTime()).toBe(
        beforeReplay?.updatedAt.getTime(),
      );
      expect(afterReplay?.submittedCredentialId).toBe('cred-original');

      const rows = await integrationPrisma().humanDecision.findMany({
        where: { tenantId },
      });
      expect(rows).toHaveLength(1);
    });

    it('returns IDEMPOTENCY_CONFLICT for a same-identity mismatch and leaves the row unchanged', async () => {
      const tenantId = await seedTenant('Conflict Tenant');
      const original = baseInput({
        productName: 'Original Name',
        sku: 'SKU-ORIGINAL',
      });
      const { repo } = makeHarness(tenantId);
      const created = await repo.submit(original);

      const mismatched = baseInput({
        sourceRequestId: original.sourceRequestId,
        productId: original.productId,
        productName: 'Different Name',
        submittedCredentialId: 'cred-2',
      });

      const error: unknown = await repo
        .submit(mismatched)
        .catch((caught: unknown) => caught);

      expect(errorCodeOf(error)).toBe('IDEMPOTENCY_CONFLICT');

      const rows = await integrationPrisma().humanDecision.findMany({
        where: { tenantId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(created.request.id);
      expect(rows[0].productName).toBe('Original Name');
      expect(rows[0].sku).toBe('SKU-ORIGINAL');
      expect(rows[0].submittedCredentialId).toBe('cred-1');
    });
  });

  describe('concurrent same-identity submits', () => {
    it('commits one row as created and replays the loser with no false conflict', async () => {
      const tenantId = await seedTenant('Concurrent Tenant');
      const input = baseInput();
      const repoA = makeHarness(tenantId).repo;
      const repoB = makeHarness(tenantId).repo;

      const settled = await Promise.allSettled([
        repoA.submit(input),
        repoB.submit(input),
      ]);

      expect(settled.map((entry) => entry.status)).toEqual([
        'fulfilled',
        'fulfilled',
      ]);
      const results = settled.map((entry) => {
        if (entry.status !== 'fulfilled') {
          throw new Error('concurrent submit unexpectedly rejected');
        }
        return entry.value;
      });
      expect(results.map((result) => result.status).sort()).toEqual([
        'created',
        'replayed',
      ]);
      expect(results[0].request.id).toBe(results[1].request.id);
      expect(results[0].request.canonicalRequestHash).toBe(
        results[1].request.canonicalRequestHash,
      );

      const rows = await integrationPrisma().humanDecision.findMany({
        where: { tenantId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(results[0].request.id);
    });

    it('recovers the P2002 identity race after both transactions completed the null identity read', async () => {
      const tenantId = await seedTenant('Scheduled Race Tenant');
      const input = baseInput();
      const observations: IdentityReadObservation[] = [];
      const barrier = createSchedulingBarrier(2);
      const repoA = makeBarrierHarness(tenantId, barrier, observations).repo;
      const repoB = makeBarrierHarness(tenantId, barrier, observations).repo;

      const settled = await Promise.allSettled([
        repoA.submit(input),
        repoB.submit(input),
      ]);

      // Both independent transactions reached the barrier ONLY after their
      // real tenant-scoped identity read returned null, so neither could reach
      // `create()` before the other had completed that read. This is the
      // scheduling seam that forces the adapter's P2002 recovery path.
      const preInsertReads = observations.filter(
        (entry) => entry.inTransaction,
      );
      expect(preInsertReads).toHaveLength(2);
      expect(preInsertReads.map((entry) => entry.resultId)).toEqual([
        null,
        null,
      ]);
      expect(barrier.arrivals).toBe(2);

      expect(settled.map((entry) => entry.status)).toEqual([
        'fulfilled',
        'fulfilled',
      ]);
      const results = settled.map((entry) => {
        if (entry.status !== 'fulfilled') {
          throw new Error('concurrent submit unexpectedly rejected');
        }
        return entry.value;
      });
      expect(results.map((result) => result.status).sort()).toEqual([
        'created',
        'replayed',
      ]);

      const rows = await integrationPrisma().humanDecision.findMany({
        where: { tenantId },
      });
      expect(rows).toHaveLength(1);
      const winnerId = rows[0].id;
      expect(results[0].request.id).toBe(winnerId);
      expect(results[1].request.id).toBe(winnerId);

      // The loser recovered OUTSIDE its aborted transaction and reread the
      // committed winner — the explicit P2002 recovery-branch observation.
      const recoveryReads = observations.filter(
        (entry) => !entry.inTransaction,
      );
      expect(recoveryReads).toHaveLength(1);
      expect(recoveryReads[0].resultId).toBe(winnerId);
    });
  });

  describe('tenant isolation of the intake identity', () => {
    it('keeps the same sourceRequestId as separate rows per tenant', async () => {
      const tenantA = await seedTenant('Tenant A');
      const tenantB = await seedTenant('Tenant B');
      const input = baseInput();

      const resultA = await makeHarness(tenantA).repo.submit(input);
      const resultB = await makeHarness(tenantB).repo.submit(input);

      expect(resultA.status).toBe('created');
      expect(resultB.status).toBe('created');
      expect(resultA.request.id).not.toBe(resultB.request.id);

      expect(
        await integrationPrisma().humanDecision.count({
          where: { tenantId: tenantA },
        }),
      ).toBe(1);
      expect(
        await integrationPrisma().humanDecision.count({
          where: { tenantId: tenantB },
        }),
      ).toBe(1);
    });

    it('returns null for a foreign tenant decision id through the real extension', async () => {
      const tenantA = await seedTenant('Scope Tenant A');
      const tenantB = await seedTenant('Scope Tenant B');
      const created = await makeHarness(tenantA).repo.submit(baseInput());

      const { tenantPrisma } = makeHarness(tenantB);
      const foundUnderB = await tenantPrisma
        .getClient()
        .humanDecision.findUnique({ where: { id: created.request.id } });
      expect(foundUnderB).toBeNull();

      // Unscoped reload proves Tenant B's read did not touch A's row.
      const reloaded = await integrationPrisma().humanDecision.findUnique({
        where: { id: created.request.id },
      });
      expect(reloaded).not.toBeNull();
      expect(reloaded?.tenantId).toBe(tenantA);
      expect(reloaded?.canonicalRequestHash).toBe(
        created.request.canonicalRequestHash,
      );
    });

    it('returns the same sanitized NOT_FOUND for a missing and a foreign-tenant predecessor', async () => {
      const tenantA = await seedTenant('Pred A');
      const tenantB = await seedTenant('Pred B');
      const foreignPredecessor = await seedStalePredecessor(tenantA);
      const { repo } = makeHarness(tenantB);

      const missing: unknown = await repo
        .submit(baseInput({ supersedesDecisionId: crypto.randomUUID() }))
        .catch((caught: unknown) => caught);
      const foreign: unknown = await repo
        .submit(baseInput({ supersedesDecisionId: foreignPredecessor }))
        .catch((caught: unknown) => caught);

      expect(errorCodeOf(missing)).toBe('NOT_FOUND');
      expect(errorCodeOf(foreign)).toBe('NOT_FOUND');
      expect((missing as Error).message).toBe('Referenced decision not found');
      expect((foreign as Error).message).toBe((missing as Error).message);
      // Only the tenant-A predecessor exists; neither submit inserted.
      expect(await integrationPrisma().humanDecision.count()).toBe(1);
    });

    it('returns NOT_FOUND for a same-tenant predecessor with a different source', async () => {
      const tenantId = await seedTenant('Foreign Source Tenant');
      const foreignSource = await integrationPrisma().humanDecision.create({
        data: {
          tenantId,
          source: 'other-source',
          sourceRequestId: crypto.randomUUID(),
          type: RESTOCK_TYPE,
          canonicalRequestHash: 'foreign-source-hash',
          submittedCredentialId: 'cred-foreign',
          branchId: tenantId,
          productName: 'Foreign source product',
          productId: crypto.randomUUID(),
          status: 'PENDING',
          version: 1,
        },
      });
      const { repo } = makeHarness(tenantId);

      const error: unknown = await repo
        .submit(baseInput({ supersedesDecisionId: foreignSource.id }))
        .catch((caught: unknown) => caught);

      expect(errorCodeOf(error)).toBe('NOT_FOUND');
      expect(await integrationPrisma().humanDecision.count()).toBe(1);
    });

    it('rejects before any write when the tenant context is absent', async () => {
      const tenantId = await seedTenant('No Context Tenant');
      const { repo } = makeHarness(null);

      await expect(repo.submit(baseInput())).rejects.toThrow(
        'Tenant context required',
      );

      expect(
        await integrationPrisma().humanDecision.count({
          where: { tenantId },
        }),
      ).toBe(0);
    });
  });

  describe('supersession predecessor eligibility', () => {
    it('creates a successor for a durable RESOLVED+STALE predecessor', async () => {
      const tenantId = await seedTenant('Stale Tenant');
      const predecessorId = await seedStalePredecessor(tenantId);
      const { repo } = makeHarness(tenantId);

      const result = await repo.submit(
        baseInput({ supersedesDecisionId: predecessorId }),
      );

      expect(result.status).toBe('created');
      expect(result.request.supersedesDecisionId).toBe(predecessorId);

      const successor = await integrationPrisma().humanDecision.findUnique({
        where: { id: result.request.id },
      });
      expect(successor?.supersedesDecisionId).toBe(predecessorId);
      expect(successor?.status).toBe('PENDING');
      expect(successor?.version).toBe(1);
    });

    it('rejects a PENDING (non-STALE) predecessor with VERSION_CONFLICT', async () => {
      const tenantId = await seedTenant('Pending Pred Tenant');
      const predecessorId = await seedPendingPredecessor(tenantId);
      const { repo } = makeHarness(tenantId);

      const error: unknown = await repo
        .submit(baseInput({ supersedesDecisionId: predecessorId }))
        .catch((caught: unknown) => caught);

      expect(errorCodeOf(error)).toBe('VERSION_CONFLICT');
      expect(await integrationPrisma().humanDecision.count()).toBe(1);
    });

    it('rejects a DELIVERY_UNKNOWN predecessor with VERSION_CONFLICT', async () => {
      const tenantId = await seedTenant('Unknown Pred Tenant');
      const predecessorId = await seedDeliveryUnknownPredecessor(tenantId);
      const { repo } = makeHarness(tenantId);

      const error: unknown = await repo
        .submit(baseInput({ supersedesDecisionId: predecessorId }))
        .catch((caught: unknown) => caught);

      expect(errorCodeOf(error)).toBe('VERSION_CONFLICT');
      expect(await integrationPrisma().humanDecision.count()).toBe(1);
    });

    it('allows exactly one successor when two distinct successors race for the same STALE predecessor', async () => {
      const tenantId = await seedTenant('Race Pred Tenant');
      const predecessorId = await seedStalePredecessor(tenantId);
      const repoA = makeHarness(tenantId).repo;
      const repoB = makeHarness(tenantId).repo;

      const settled = await Promise.allSettled([
        repoA.submit(baseInput({ supersedesDecisionId: predecessorId })),
        repoB.submit(baseInput({ supersedesDecisionId: predecessorId })),
      ]);

      const fulfilled = settled.filter((entry) => entry.status === 'fulfilled');
      const rejected = settled.filter((entry) => entry.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const winner = fulfilled[0];
      if (winner.status !== 'fulfilled') {
        throw new Error('expected a fulfilled successor');
      }
      expect(winner.value.status).toBe('created');
      expect(errorCodeOf(rejected[0].reason)).toBe('VERSION_CONFLICT');

      const successors = await integrationPrisma().humanDecision.findMany({
        where: { tenantId, supersedesDecisionId: predecessorId },
      });
      expect(successors).toHaveLength(1);
      expect(successors[0].id).toBe(winner.value.request.id);
    });
  });

  describe('top-level transaction precondition', () => {
    it('rejects a nested submit with a value-free programmer error and keeps the parent transaction usable', async () => {
      const tenantId = await seedTenant('Tx Tenant');
      const input = baseInput();
      const { repo, tenantPrisma } = makeHarness(tenantId);

      let observedError: unknown;
      let inTransactionRead: unknown;

      await expect(
        tenantPrisma.runInTransaction(async () => {
          observedError = await repo
            .submit(input)
            .catch((caught: unknown) => caught);
          // A P2002/aborted-transaction path would make this read throw
          // (SQLSTATE 25P02) and reject the whole transaction.
          inTransactionRead = await tenantPrisma
            .getClient()
            .humanDecision.findMany();
          return 'committed';
        }),
      ).resolves.toBe('committed');

      expect(observedError).toBeInstanceOf(Error);
      expect(observedError).not.toBeInstanceOf(RestockIntakeError);
      expect((observedError as Error).message).toBe(
        'PrismaRestockIntakeRepository.submit must be called outside an ambient transaction',
      );
      expect((observedError as Error).message).not.toContain(tenantId);
      expect((observedError as Error).message).not.toContain(
        input.sourceRequestId,
      );
      expect(inTransactionRead).toEqual([]);
      expect(
        await integrationPrisma().humanDecision.count({
          where: { tenantId },
        }),
      ).toBe(0);
    });
  });
});

describe('createSchedulingBarrier (test helper)', () => {
  it('rejects a lone waiter promptly when its partner never arrives', async () => {
    const barrier = createSchedulingBarrier(2, 50);

    await expect(barrier.arrive()).rejects.toThrow(BARRIER_TIMEOUT_ERROR);
    expect(barrier.arrivals).toBe(1);
  });

  it('releases every party once the expected count arrives', async () => {
    const barrier = createSchedulingBarrier(2, 50);

    const first = barrier.arrive();
    const second = barrier.arrive();

    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(barrier.arrivals).toBe(2);
  });
});
