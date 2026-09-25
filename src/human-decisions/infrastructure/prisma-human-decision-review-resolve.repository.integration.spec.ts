/**
 * HD-04c3 — PrismaHumanDecisionReviewResolveRepository real-PostgreSQL
 * integration spec.
 *
 * HD-04c2 shipped the reviewer RESOLVE adapter with a DB-free companion spec
 * (`prisma-human-decision-review-resolve.repository.spec.ts`) that mocks
 * `TenantPrismaService`. That spec proves the adapter SEAMS (ambient-tx guard,
 * CLS tenant resolution, actor verification, the one-winner CAS predicate and
 * the `count === 0` loser classification) but it CANNOT prove what only real
 * PostgreSQL can answer: the persisted `User`/`TenantMembership` authorization
 * read, the durable reviewer snapshot written by the CAS, the real `ON DELETE
 * SET NULL` FK behavior on a deleted reviewer, and — above all — an ACTUAL
 * two-reviewer race against one committed `PENDING` row.
 *
 * This spec closes that gap against the dedicated isolated RESTOCK database
 * (`127.0.0.1:5433/nest-practice-restock-test`) with REAL Prisma and the REAL
 * `TenantPrismaService`. Exactly one thing is not real, and it is stated
 * plainly:
 *
 *   The CLS store is a per-harness `Map` shim, NOT the nestjs-cls
 *   AsyncLocalStorage. Each harness owns its own store, so two harnesses model
 *   two independent request contexts sharing one PostgreSQL pool. Actual ALS
 *   multiplexing, guard provenance and per-request isolation are NOT exercised
 *   here; they belong to the HD-04d HTTP route. This spec deliberately does
 *   NOT boot Nest, the full `AppModule`, the bot, any provider or any live
 *   service, and it issues no HTTP request.
 *
 * TWO-REVIEWER RACE (the headline proof): a test-only `TenantPrismaService`
 * subclass wraps ONLY the `humanDecision.findFirst` seam (the decision-state
 * read). After each transaction has completed its REAL initial `PENDING` read
 * and BEFORE either may run its CAS `updateMany`, both transactions rendezvous
 * on a bounded, single-use barrier. No DB result is mocked and no update is
 * faked: the two transactions then race their real conditional `updateMany`
 * against the same row, exactly one commits version 2, and the loser re-reads
 * the committed winner inside its own transaction and is classified with a
 * stable domain conflict code. The identical-retry variant re-runs the same
 * key/actor concurrently and must yield one `resolved` plus one `replayed`.
 *
 * ISOLATED-DB GUARD: same shape and intent as the HD-04b3b read guard. Before
 * this file touches a row it validates BOTH the `.env.test` file parsed with
 * the local `dotenv` AND the ACTIVE `process.env.DATABASE_URL` that
 * `resetAndSeedBaseline` and the `TenantPrismaService` client actually connect
 * with, aborting unless each resolves to exactly
 * `postgresql://127.0.0.1:5433/nest-practice-restock-test`. The check runs at
 * module load (before any fixture or reset) and again before EVERY
 * `resetAndSeedBaseline()`, which truncates `tenants`/`users` CASCADE and is
 * therefore authorized exclusively for this dedicated database. Mismatch
 * errors are generic and redacted: the raw URL, its credentials and any
 * non-target database name are never echoed.
 *
 * CRITICAL: the integration Jest config runs `globalSetup` — which executes
 * `prisma migrate deploy` — BEFORE this spec module is evaluated. The in-spec
 * guard therefore CANNOT protect the migration step, and this suite must never
 * be the only destination check: every invocation requires the separate
 * pre-Jest destination precheck (see the HD-04c3 task record for the exact
 * command).
 *
 * Scope boundary: this spec proves the resolve WRITE model against real
 * PostgreSQL. It makes NO claim about HTTP routing, JWT/guard provenance,
 * ALS request isolation, RBAC declarations, provider delivery or the full
 * application graph.
 *
 * Skip guard: `SKIP_DB_INTEGRATION=1` or an unset `DATABASE_URL` skips the
 * whole suite, matching the other integration specs.
 */
import type { Prisma } from '@prisma/client';
import * as dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ClsService } from 'nestjs-cls';
import {
  disconnectIntegrationPrisma,
  integrationPrisma,
  resetAndSeedBaseline,
} from '../../../test/integration/reset-db';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import {
  RESTOCK_SOURCE,
  RESTOCK_TYPE,
} from '../domain/restock-request-canonicalizer';
import {
  HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE,
  HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE,
  HumanDecisionReviewResolveError,
  type HumanDecisionReviewResolveErrorCode,
  type HumanDecisionReviewResolveResult,
  type ResolveHumanDecisionProvideCommand,
  type ResolveHumanDecisionUnavailableCommand,
} from '../domain/human-decision-review-resolve.repository';
import { toHumanDecisionReviewResponse } from '../presentation/dto/human-decision-review.response';
import { PrismaHumanDecisionReviewResolveRepository } from './prisma-human-decision-review-resolve.repository';

// ---------------------------------------------------------------------------
// Isolated test-DB target guard
// ---------------------------------------------------------------------------

const ENV_TEST_PATH = path.resolve(process.cwd(), '.env.test');
const EXPECTED_PROTOCOL = 'postgresql:';
const EXPECTED_HOSTNAME = '127.0.0.1';
const EXPECTED_PORT = '5433';
const EXPECTED_DATABASE = 'nest-practice-restock-test';

let targetLoggedOnce = false;

type DatabaseUrlSource = 'file' | 'active';

const SOURCE_LABELS: Record<DatabaseUrlSource, string> = {
  file: '.env.test',
  active: 'active process.env',
};

/**
 * Fail closed unless `rawUrl` resolves to the exact dedicated isolated RESTOCK
 * database. The error is intentionally generic and redacted: it never echoes
 * the raw URL or any of its components (credentials or a non-target database
 * name could be sensitive), only which endpoint was inspected.
 */
function assertMatchesIsolatedTarget(
  rawUrl: string | undefined,
  source: DatabaseUrlSource,
): void {
  if (!rawUrl) {
    throw new Error(
      `[hd-04c3] refusing isolated-DB run: ${SOURCE_LABELS[source]} DATABASE_URL is unset.`,
    );
  }

  let url: globalThis.URL;
  try {
    url = new globalThis.URL(rawUrl);
  } catch {
    throw new Error(
      `[hd-04c3] refusing isolated-DB run: ${SOURCE_LABELS[source]} DATABASE_URL is not a valid URL.`,
    );
  }

  let databaseName = url.pathname.replace(/^\//, '');
  try {
    databaseName = decodeURIComponent(databaseName);
  } catch {
    // Keep the encoded segment when it cannot be decoded.
  }

  const matches =
    url.protocol === EXPECTED_PROTOCOL &&
    url.hostname === EXPECTED_HOSTNAME &&
    url.port === EXPECTED_PORT &&
    databaseName === EXPECTED_DATABASE;

  if (!matches) {
    throw new Error(
      `[hd-04c3] refusing isolated-DB run: ${SOURCE_LABELS[source]} DATABASE_URL does not match the dedicated isolated RESTOCK target.`,
    );
  }
}

/**
 * Validate BOTH database endpoints this suite depends on: the `.env.test` file
 * parsed with the local `dotenv` (authoritative for the Jest globalSetup
 * migration) AND the ACTIVE `process.env.DATABASE_URL`, which is what
 * `resetAndSeedBaseline` and the `TenantPrismaService` client actually connect
 * with. They can diverge (a stale shell export, a partially-applied override),
 * so a file-only check is insufficient. Only the sanitized expected destination
 * is printed once; raw URLs, credentials and any non-target database name are
 * never echoed.
 */
function assertIsolatedTestDatabaseTarget(): void {
  const parsedEnv = dotenv.parse(fs.readFileSync(ENV_TEST_PATH, 'utf8'));
  assertMatchesIsolatedTarget(parsedEnv.DATABASE_URL, 'file');
  assertMatchesIsolatedTarget(process.env.DATABASE_URL, 'active');

  if (!targetLoggedOnce) {
    targetLoggedOnce = true;
    console.log(
      `[hd-04c3] isolated DB target OK: ${EXPECTED_PROTOCOL}//${EXPECTED_HOSTNAME}:${EXPECTED_PORT}/${EXPECTED_DATABASE}`,
    );
  }
}

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;

const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;

if (!SKIP_INTEGRATION) {
  // Fail fast at module load, before any fixture or reset touches the DB.
  assertIsolatedTestDatabaseTarget();
}

/** Guarded baseline reset: the target is re-validated before every truncate. */
async function resetIsolatedBaseline(): Promise<void> {
  assertIsolatedTestDatabaseTarget();
  await resetAndSeedBaseline();
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type TenantScopedClient = ReturnType<TenantPrismaService['getClient']>;

interface ResolveHarness {
  repo: PrismaHumanDecisionReviewResolveRepository;
  tenantPrisma: TenantPrismaService;
}

/**
 * Real Prisma service instance sharing the integration client, plus a
 * PER-HARNESS CLS `Map` shim.
 *
 * The shim is NOT nestjs-cls AsyncLocalStorage: it is an in-memory key/value
 * store created per harness, so two harnesses faithfully model two independent
 * request contexts while sharing one PostgreSQL pool. Everything below the CLS
 * boundary is real: the real tenant-scoping `$extends` factory, the real
 * `TenantPrismaService`, the real `User`/`TenantMembership` reads and the real
 * `HumanDecision` CAS.
 */
function makePrismaAndCls(
  tenantId: string | null,
  isSuperAdmin = false,
): { prisma: PrismaService; cls: ClsService<TenantClsStore> } {
  const store = new Map<string, unknown>();
  store.set('tenantId', tenantId);
  store.set('isSuperAdmin', isSuperAdmin);
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
  return { prisma, cls };
}

function makeHarness(
  tenantId: string | null,
  isSuperAdmin = false,
): ResolveHarness {
  const { prisma, cls } = makePrismaAndCls(tenantId, isSuperAdmin);
  const tenantPrisma = new TenantPrismaService(prisma, cls);
  return {
    repo: new PrismaHumanDecisionReviewResolveRepository(tenantPrisma),
    tenantPrisma,
  };
}

// ---------------------------------------------------------------------------
// Two-reviewer scheduling barrier
// ---------------------------------------------------------------------------

interface SchedulingBarrier {
  /** Number of parties that have arrived (including current waiters). */
  readonly arrivals: number;
  /** Block until every party has arrived, then release all of them. */
  arrive(): Promise<void>;
}

/**
 * Upper bound for a participant that never arrives. Kept BELOW Prisma's default
 * interactive-transaction timeout (5s) so a failed race surfaces as this
 * explicit test-infrastructure error instead of an opaque `P2028 transaction
 * already closed`, yet well under Jest's 30s `testTimeout` so the surviving
 * waiter cannot leak into `afterEach` teardown.
 */
const BARRIER_TIMEOUT_MS = 4_000;

/**
 * Value-free test error for a barrier timeout: the barrier is a scheduling
 * seam, so this is test-infrastructure failure, never a product error, and it
 * carries no payload.
 */
const BARRIER_TIMEOUT_ERROR =
  'HD-04c3 resolve scheduling barrier timed out waiting for a partner';

/**
 * Minimal single-use barrier with no sleep-based synchronization. It only
 * widens the window in which both transactions have completed their REAL
 * decision-state read; every DB query and result stays real. The wait is
 * bounded by `timeoutMs`, the timer starts only once the first party arrives,
 * and it is cleared on a normal `parties`-party release (so nobody arriving
 * leaves no pending timer).
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
 * Narrowly identifies the internal decision-state read by its
 * `resolutionRequestId` allowlist key. The reviewer projection read
 * (`REVIEW_RECORD_SELECT`) deliberately excludes that key, so no other
 * `findFirst` shape — including the loser's post-CAS winner re-read — can be
 * mistaken for the initial `PENDING` read.
 */
function isDecisionStateRead(args: Prisma.HumanDecisionFindFirstArgs): boolean {
  return args.select?.resolutionRequestId === true;
}

/**
 * Test-only subclass with ONE narrow instrumentation seam. The client returned
 * by `getClient()` still runs the real tenant-scoped queries for exactly the
 * four delegates the resolve adapter uses, and ONLY the decision-state read is
 * barriered: once a real `PENDING` decision-state read completes inside the
 * transaction, the caller waits at the shared barrier before it may continue to
 * the CAS update. No DB result is mocked and no adapter private method is
 * touched; the barrier is a controlled scheduling seam over real PostgreSQL.
 */
class BarrierTenantPrismaService extends TenantPrismaService {
  constructor(
    prisma: PrismaService,
    cls: ClsService<TenantClsStore>,
    private readonly barrier: SchedulingBarrier,
  ) {
    super(prisma, cls);
  }

  override getClient(): TenantScopedClient {
    // `super.getClient()` resolves the ambient transaction client per call.
    const client = super.getClient();
    const instrumented = {
      user: {
        findUnique: (args: Prisma.UserFindUniqueArgs) =>
          client.user.findUnique(args),
      },
      tenantMembership: {
        findFirst: (args: Prisma.TenantMembershipFindFirstArgs) =>
          client.tenantMembership.findFirst(args),
      },
      humanDecision: {
        findFirst: async (args: Prisma.HumanDecisionFindFirstArgs) => {
          const result = await client.humanDecision.findFirst(args);
          if (
            result !== null &&
            result.status === 'PENDING' &&
            isDecisionStateRead(args)
          ) {
            await this.barrier.arrive();
          }
          return result;
        },
        updateMany: (args: Prisma.HumanDecisionUpdateManyArgs) =>
          client.humanDecision.updateMany(args),
      },
    };
    return instrumented as unknown as TenantScopedClient;
  }
}

function makeBarrierHarness(
  tenantId: string,
  barrier: SchedulingBarrier,
): ResolveHarness {
  const { prisma, cls } = makePrismaAndCls(tenantId, false);
  const tenantPrisma = new BarrierTenantPrismaService(prisma, cls, barrier);
  return {
    repo: new PrismaHumanDecisionReviewResolveRepository(tenantPrisma),
    tenantPrisma,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CREDENTIAL_ID = 'cred-hd04c3';

/** One explicit tenant per test; the baseline tenant is never reused. */
async function seedTenant(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await integrationPrisma().tenant.create({
    data: { id, name, slug: `hd04c3-${id}` },
  });
  return id;
}

interface SeededReviewer {
  userId: string;
  name: string;
}

/**
 * Seed one real `User`, optionally with an explicit tenant `Role` +
 * `TenantMembership`. The membership is what an ORDINARY reviewer must have;
 * `membership: false` reproduces a nonmember (and the superadmin fixture).
 */
async function seedReviewer(
  tenantId: string | null,
  name: string,
  options: { isActive?: boolean; membership?: boolean } = {},
): Promise<SeededReviewer> {
  const userId = crypto.randomUUID();
  await integrationPrisma().user.create({
    data: {
      id: userId,
      email: `hd04c3-${userId}@example.test`,
      hashedPassword: 'not-a-real-hash',
      name,
      isActive: options.isActive ?? true,
    },
  });
  if (tenantId !== null && options.membership !== false) {
    const role = await integrationPrisma().role.create({
      data: {
        id: crypto.randomUUID(),
        name: `hd04c3-role-${crypto.randomUUID()}`,
        tenantId,
      },
    });
    await integrationPrisma().tenantMembership.create({
      data: { userId, tenantId, roleId: role.id },
    });
  }
  return { userId, name };
}

/**
 * Valid PENDING fixture: status/version defaults plus the immutable intake
 * snapshot. `productId`/`variantId` are canonical RFC 4122 UUIDs so the pure
 * reviewer mapper accepts the persisted row without normalizing anything.
 */
function pendingDecisionData(
  tenantId: string,
  overrides: Partial<Prisma.HumanDecisionUncheckedCreateInput> = {},
): Prisma.HumanDecisionUncheckedCreateInput {
  return {
    tenantId,
    source: RESTOCK_SOURCE,
    sourceRequestId: crypto.randomUUID(),
    type: RESTOCK_TYPE,
    canonicalRequestHash: `hash-${crypto.randomUUID()}`,
    submittedCredentialId: CREDENTIAL_ID,
    branchId: tenantId,
    branchName: 'Sucursal Centro',
    productId: crypto.randomUUID(),
    productName: 'Cafe de altura',
    variantId: null,
    sku: 'SKU-1',
    requestedQuantity: 5,
    observedStockAtRequest: null,
    stockObservedAt: null,
    status: 'PENDING',
    version: 1,
    ...overrides,
  };
}

/** Persist one fixture and return its id. */
async function seedDecision(
  data: Prisma.HumanDecisionUncheckedCreateInput,
): Promise<string> {
  const row = await integrationPrisma().humanDecision.create({ data });
  return row.id;
}

/** Counts every committed `HumanDecision` row regardless of tenant. */
async function totalDecisionRows(): Promise<number> {
  return integrationPrisma().humanDecision.count();
}

function provideCommand(
  decisionId: string,
  actorUserId: string,
  overrides: Partial<ResolveHumanDecisionProvideCommand> = {},
): ResolveHumanDecisionProvideCommand {
  return {
    decisionId,
    expectedVersion: 1,
    resolutionRequestId: crypto.randomUUID(),
    action: HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE,
    restockDays: 3,
    actorUserId,
    actorIsSuperAdmin: false,
    ...overrides,
  };
}

function unavailableCommand(
  decisionId: string,
  actorUserId: string,
  overrides: Partial<ResolveHumanDecisionUnavailableCommand> = {},
): ResolveHumanDecisionUnavailableCommand {
  return {
    decisionId,
    expectedVersion: 1,
    resolutionRequestId: crypto.randomUUID(),
    action: HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE,
    actorUserId,
    actorIsSuperAdmin: false,
    ...overrides,
  };
}

/** Await a resolve expected to fail and return its typed domain error. */
async function expectResolveFailure(
  promise: Promise<HumanDecisionReviewResolveResult>,
  code: HumanDecisionReviewResolveErrorCode,
): Promise<HumanDecisionReviewResolveError> {
  const error: unknown = await promise.then(
    () => {
      throw new Error('expected the resolve to fail');
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(HumanDecisionReviewResolveError);
  if (!(error instanceof HumanDecisionReviewResolveError)) {
    throw new Error('expected HumanDecisionReviewResolveError');
  }
  expect(error.code).toBe(code);
  return error;
}

/**
 * Typed settle wrapper: `Promise.allSettled` would expose `reason: any`, so
 * this keeps the race result a discriminated union whose failure arm is
 * `unknown` and safe to assert on.
 */
type SettledResolve =
  | { ok: true; value: HumanDecisionReviewResolveResult }
  | { ok: false; error: unknown };

async function settleResolve(
  promise: Promise<HumanDecisionReviewResolveResult>,
): Promise<SettledResolve> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeIfDb(
  'PrismaHumanDecisionReviewResolveRepository (HD-04c3 PostgreSQL integration)',
  () => {
    beforeAll(async () => {
      // Force the singleton construction early so a misconfigured
      // DATABASE_URL throws here (loud) rather than in the first test.
      integrationPrisma();
      await resetIsolatedBaseline();
    });

    afterEach(async () => {
      // TRUNCATE … CASCADE + re-seed: robust against any mid-test failure, and
      // it leaves the dedicated test DB at the known baseline for the next
      // test (and any later spec in the same run).
      await resetIsolatedBaseline();
    });

    afterAll(async () => {
      await disconnectIntegrationPrisma();
    });

    describe('isolated-DB target guard (test-only regression)', () => {
      it('rejects a non-target ACTIVE DATABASE_URL with a redacted error before any reset', () => {
        const originalUrl = process.env.DATABASE_URL;
        // Dummy non-target; it is never connected to. Each component (userinfo,
        // port, database name) is distinctive so the test can prove nothing
        // from it is echoed back by the guard.
        const dummyUrl =
          'postgresql://leak_user:leak_secret@127.0.0.1:5432/prod-secret-db';
        try {
          process.env.DATABASE_URL = dummyUrl;

          // No Prisma client is constructed while the env is mismatched: the
          // guard must fail closed before any reset/query.
          expect(() => assertIsolatedTestDatabaseTarget()).toThrow(
            /refusing isolated-DB run/,
          );

          let message = '';
          try {
            assertIsolatedTestDatabaseTarget();
          } catch (error) {
            message = error instanceof Error ? error.message : String(error);
          }
          expect(message).toContain('[hd-04c3]');
          expect(message).toContain('active process.env');
          expect(message).not.toContain('leak_user');
          expect(message).not.toContain('leak_secret');
          expect(message).not.toContain('prod-secret-db');
          expect(message).not.toContain('5432');
          expect(message).not.toContain(dummyUrl);
        } finally {
          process.env.DATABASE_URL = originalUrl;
        }
      });
    });

    describe('ordinary same-tenant resolve', () => {
      it('commits version 2 with a server-derived reviewer snapshot and FK', async () => {
        const tenantId = await seedTenant('Resolve Tenant');
        const reviewer = await seedReviewer(tenantId, 'Ana Reviewer');
        const decisionId = await seedDecision(pendingDecisionData(tenantId));
        const command = provideCommand(decisionId, reviewer.userId, {
          restockDays: 7,
        });

        const result = await makeHarness(tenantId).repo.resolve(command);

        expect(result.status).toBe('resolved');
        expect(result.decision).toMatchObject({
          id: decisionId,
          status: 'RESOLVED',
          version: 2,
          resolutionAction: HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE,
          restockDays: 7,
          // Name/id are SERVER-derived from the persisted `User`, never the
          // command (which only carries the actor id).
          resolvedByActorId: reviewer.userId,
          resolvedByDisplayName: reviewer.name,
        });
        expect(result.decision.resolvedAt).toBeInstanceOf(Date);

        const row = await integrationPrisma().humanDecision.findUniqueOrThrow({
          where: { id: decisionId },
        });
        expect(row).toMatchObject({
          status: 'RESOLVED',
          version: 2,
          resolutionAction: HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE,
          restockDays: 7,
          resolutionRequestId: command.resolutionRequestId,
          resolvedById: reviewer.userId,
          resolvedByActorId: reviewer.userId,
          resolvedByDisplayName: reviewer.name,
        });
        expect(row.resolvedAt).toBeInstanceOf(Date);
      });

      it('resolves the negative action with null days and omits days in the pure projection', async () => {
        const tenantId = await seedTenant('Negative Tenant');
        const reviewer = await seedReviewer(tenantId, 'Beto Reviewer');
        const decisionId = await seedDecision(pendingDecisionData(tenantId));

        const result = await makeHarness(tenantId).repo.resolve(
          unavailableCommand(decisionId, reviewer.userId),
        );

        expect(result.status).toBe('resolved');
        expect(result.decision).toMatchObject({
          status: 'RESOLVED',
          version: 2,
          resolutionAction: HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE,
          restockDays: null,
          resolvedByActorId: reviewer.userId,
          resolvedByDisplayName: reviewer.name,
        });

        const row = await integrationPrisma().humanDecision.findUniqueOrThrow({
          where: { id: decisionId },
        });
        expect(row.restockDays).toBeNull();
        expect(row.resolutionAction).toBe(
          HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE,
        );

        // The pure reviewer mapper is the ONLY projection layer; the negative
        // discriminant must not carry a `restockDays` key at all.
        const dto = toHumanDecisionReviewResponse(result.decision, true);
        expect(dto.status).toBe('RESOLVED');
        expect(dto.version).toBe(2);
        expect(dto.resolution).toMatchObject({
          action: HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE,
          resolvedBy: {
            id: reviewer.userId,
            displayName: reviewer.name,
          },
        });
        expect(dto.resolution).not.toHaveProperty('restockDays');
      });
    });

    describe('idempotent replay and conflicts', () => {
      it('replays exactly after a User rename and preserves the original committed displayName', async () => {
        const tenantId = await seedTenant('Replay Rename Tenant');
        const reviewer = await seedReviewer(tenantId, 'Original Reviewer');
        const decisionId = await seedDecision(pendingDecisionData(tenantId));
        const command = provideCommand(decisionId, reviewer.userId, {
          restockDays: 5,
        });
        const { repo } = makeHarness(tenantId);

        const first = await repo.resolve(command);
        expect(first.status).toBe('resolved');
        const resolvedAtIso = first.decision.resolvedAt?.toISOString();
        expect(resolvedAtIso).toBeDefined();

        // The reviewer is renamed AFTER the commit. The durable snapshot must
        // not move with the mutable `User.name`.
        await integrationPrisma().user.update({
          where: { id: reviewer.userId },
          data: { name: 'Renamed Reviewer' },
        });

        const replay = await repo.resolve(command);
        expect(replay.status).toBe('replayed');
        expect(replay.decision.resolvedByActorId).toBe(reviewer.userId);
        // Original snapshot, NOT the post-rename `User.name`.
        expect(replay.decision.resolvedByDisplayName).toBe('Original Reviewer');
        expect(replay.decision.resolvedAt?.toISOString()).toBe(resolvedAtIso);

        const row = await integrationPrisma().humanDecision.findUniqueOrThrow({
          where: { id: decisionId },
        });
        expect(row.resolvedByDisplayName).toBe('Original Reviewer');
      });

      it('classifies a same-key mismatched payload and a different actor as IDEMPOTENCY_CONFLICT', async () => {
        const tenantId = await seedTenant('Same Key Tenant');
        const reviewer = await seedReviewer(tenantId, 'Carla Reviewer');
        const otherReviewer = await seedReviewer(tenantId, 'Dario Reviewer');
        const decisionId = await seedDecision(pendingDecisionData(tenantId));
        const key = crypto.randomUUID();
        const { repo } = makeHarness(tenantId);

        await repo.resolve(
          provideCommand(decisionId, reviewer.userId, {
            resolutionRequestId: key,
            restockDays: 3,
          }),
        );

        await expectResolveFailure(
          repo.resolve(
            provideCommand(decisionId, reviewer.userId, {
              resolutionRequestId: key,
              restockDays: 5,
            }),
          ),
          'IDEMPOTENCY_CONFLICT',
        );

        await expectResolveFailure(
          repo.resolve(
            provideCommand(decisionId, otherReviewer.userId, {
              resolutionRequestId: key,
              restockDays: 3,
            }),
          ),
          'IDEMPOTENCY_CONFLICT',
        );

        // The committed resolution is untouched by either conflict.
        const row = await integrationPrisma().humanDecision.findUniqueOrThrow({
          where: { id: decisionId },
        });
        expect(row.resolvedByActorId).toBe(reviewer.userId);
        expect(row.restockDays).toBe(3);
      });

      it('classifies a different key against a resolved decision as ALREADY_RESOLVED', async () => {
        const tenantId = await seedTenant('Different Key Tenant');
        const reviewer = await seedReviewer(tenantId, 'Elena Reviewer');
        const decisionId = await seedDecision(pendingDecisionData(tenantId));
        const { repo } = makeHarness(tenantId);

        await repo.resolve(provideCommand(decisionId, reviewer.userId));

        const error = await expectResolveFailure(
          repo.resolve(provideCommand(decisionId, reviewer.userId)),
          'ALREADY_RESOLVED',
        );
        // 409-class domain conflict: value-free and never an existence or
        // payload leak.
        expect(error.message).not.toContain(decisionId);
        expect(error.message).not.toContain(reviewer.userId);

        const row = await integrationPrisma().humanDecision.findUniqueOrThrow({
          where: { id: decisionId },
        });
        expect(row.version).toBe(2);
      });

      it('rejects a stale expectedVersion on a PENDING decision with VERSION_CONFLICT', async () => {
        const tenantId = await seedTenant('Version Tenant');
        const reviewer = await seedReviewer(tenantId, 'Fabi Reviewer');
        const decisionId = await seedDecision(pendingDecisionData(tenantId));

        await expectResolveFailure(
          makeHarness(tenantId).repo.resolve(
            provideCommand(decisionId, reviewer.userId, {
              expectedVersion: 2,
            }),
          ),
          'VERSION_CONFLICT',
        );

        const row = await integrationPrisma().humanDecision.findUniqueOrThrow({
          where: { id: decisionId },
        });
        expect(row.status).toBe('PENDING');
        expect(row.version).toBe(1);
      });
    });

    describe('reviewer authorization against persisted rows', () => {
      it('rejects a missing reviewer with UNAUTHORIZED and no mutation', async () => {
        const tenantId = await seedTenant('Missing Reviewer Tenant');
        const decisionId = await seedDecision(pendingDecisionData(tenantId));

        await expectResolveFailure(
          makeHarness(tenantId).repo.resolve(
            provideCommand(decisionId, crypto.randomUUID()),
          ),
          'UNAUTHORIZED',
        );

        expect(
          await integrationPrisma().humanDecision.findUniqueOrThrow({
            where: { id: decisionId },
          }),
        ).toMatchObject({ status: 'PENDING', version: 1 });
      });

      it('rejects an inactive reviewer with UNAUTHORIZED', async () => {
        const tenantId = await seedTenant('Inactive Reviewer Tenant');
        const reviewer = await seedReviewer(tenantId, 'Inactive Reviewer', {
          isActive: false,
        });
        const decisionId = await seedDecision(pendingDecisionData(tenantId));

        await expectResolveFailure(
          makeHarness(tenantId).repo.resolve(
            provideCommand(decisionId, reviewer.userId),
          ),
          'UNAUTHORIZED',
        );
      });

      it('rejects an active nonmember reviewer with FORBIDDEN and no mutation', async () => {
        const tenantId = await seedTenant('Nonmember Reviewer Tenant');
        const reviewer = await seedReviewer(tenantId, 'Nonmember Reviewer', {
          membership: false,
        });
        const decisionId = await seedDecision(pendingDecisionData(tenantId));

        await expectResolveFailure(
          makeHarness(tenantId).repo.resolve(
            provideCommand(decisionId, reviewer.userId),
          ),
          'FORBIDDEN',
        );

        expect(
          await integrationPrisma().humanDecision.findUniqueOrThrow({
            where: { id: decisionId },
          }),
        ).toMatchObject({ status: 'PENDING', version: 1 });
      });

      it('lets a superadmin with a selected tenant bypass membership when the User is active', async () => {
        const tenantId = await seedTenant('Superadmin Tenant');
        const reviewer = await seedReviewer(tenantId, 'Root Superadmin', {
          membership: false,
        });
        const decisionId = await seedDecision(pendingDecisionData(tenantId));

        const result = await makeHarness(tenantId, true).repo.resolve(
          provideCommand(decisionId, reviewer.userId, {
            actorIsSuperAdmin: true,
          }),
        );

        expect(result.status).toBe('resolved');
        expect(result.decision.resolvedByActorId).toBe(reviewer.userId);
        const memberships = await integrationPrisma().tenantMembership.count({
          where: { userId: reviewer.userId },
        });
        // Non-vacuous: the bypass did not need a membership row.
        expect(memberships).toBe(0);
      });

      it('fails closed before any query for a superadmin session with no tenant context', async () => {
        const tenantId = await seedTenant('No Context Tenant');
        const reviewer = await seedReviewer(tenantId, 'Contextless Root');
        const decisionId = await seedDecision(pendingDecisionData(tenantId));
        const { repo } = makeHarness(null, true);

        await expect(
          repo.resolve(
            provideCommand(decisionId, reviewer.userId, {
              actorIsSuperAdmin: true,
            }),
          ),
        ).rejects.toThrow('Tenant context required');

        expect(
          await integrationPrisma().humanDecision.findUniqueOrThrow({
            where: { id: decisionId },
          }),
        ).toMatchObject({ status: 'PENDING', version: 1 });
      });
    });

    describe('sanitized NOT_FOUND for out-of-scope decisions', () => {
      it('treats a cross-tenant decision as NOT_FOUND without an existence leak', async () => {
        const tenantA = await seedTenant('Scope Tenant A');
        const tenantB = await seedTenant('Scope Tenant B');
        const reviewer = await seedReviewer(tenantA, 'Scoped Reviewer');
        const foreignDecision = await seedDecision(
          pendingDecisionData(tenantB),
        );

        await expectResolveFailure(
          makeHarness(tenantA).repo.resolve(
            provideCommand(foreignDecision, reviewer.userId),
          ),
          'NOT_FOUND',
        );

        // Non-vacuous: the foreign row really is committed and untouched.
        expect(
          await integrationPrisma().humanDecision.findUniqueOrThrow({
            where: { id: foreignDecision },
          }),
        ).toMatchObject({
          id: foreignDecision,
          tenantId: tenantB,
          status: 'PENDING',
          version: 1,
        });
      });

      it('treats a foreign-source decision as NOT_FOUND without an existence leak', async () => {
        const tenantId = await seedTenant('Foreign Source Tenant');
        const reviewer = await seedReviewer(tenantId, 'Source Reviewer');
        const foreignSource = await seedDecision(
          pendingDecisionData(tenantId, { source: 'other-bot-source' }),
        );

        await expectResolveFailure(
          makeHarness(tenantId).repo.resolve(
            provideCommand(foreignSource, reviewer.userId),
          ),
          'NOT_FOUND',
        );

        // Non-vacuous: the row exists in the SAME tenant with the same type,
        // so NOT_FOUND is the pinned RESTOCK source, not tenant scope.
        expect(
          await integrationPrisma().humanDecision.findUniqueOrThrow({
            where: { id: foreignSource },
          }),
        ).toMatchObject({
          id: foreignSource,
          tenantId,
          source: 'other-bot-source',
          type: RESTOCK_TYPE,
          status: 'PENDING',
        });
      });
    });

    describe('durable reviewer snapshot after User deletion', () => {
      it('nulls the FK but keeps the decision and the snapshot readable', async () => {
        const tenantId = await seedTenant('Deleted Reviewer Tenant');
        const reviewer = await seedReviewer(tenantId, 'Gone Reviewer');
        const decisionId = await seedDecision(pendingDecisionData(tenantId));
        const { repo } = makeHarness(tenantId);

        await repo.resolve(provideCommand(decisionId, reviewer.userId));

        // A real `ON DELETE SET NULL` deletion: nothing else references this
        // user, so only the optional FK is nulled. The decision MUST survive.
        await integrationPrisma().user.delete({
          where: { id: reviewer.userId },
        });

        const row = await integrationPrisma().humanDecision.findUniqueOrThrow({
          where: { id: decisionId },
        });
        expect(row).toMatchObject({
          id: decisionId,
          status: 'RESOLVED',
          version: 2,
          resolvedById: null,
          resolvedByActorId: reviewer.userId,
          resolvedByDisplayName: 'Gone Reviewer',
        });
        await expect(totalDecisionRows()).resolves.toBe(1);

        // The projection still renders because it reads the snapshots, not the
        // now-null relation.
        const dto = toHumanDecisionReviewResponse(row, true);
        expect(dto.status).toBe('RESOLVED');
        expect(dto.resolution?.resolvedBy).toEqual({
          id: reviewer.userId,
          displayName: 'Gone Reviewer',
        });
      });
    });

    describe('two-reviewer real PostgreSQL race', () => {
      it('commits exactly one resolution, classifies the loser as ALREADY_RESOLVED and touches no other model', async () => {
        const tenantId = await seedTenant('Race Tenant');
        const reviewerA = await seedReviewer(tenantId, 'Racer A');
        const reviewerB = await seedReviewer(tenantId, 'Racer B');
        const decisionId = await seedDecision(pendingDecisionData(tenantId));

        const salesBefore = await integrationPrisma().sale.count();
        const productsBefore = await integrationPrisma().product.count();

        const barrier = createSchedulingBarrier(2);
        const harnessA = makeBarrierHarness(tenantId, barrier);
        const harnessB = makeBarrierHarness(tenantId, barrier);

        const [settledA, settledB] = await Promise.all([
          settleResolve(
            harnessA.repo.resolve(provideCommand(decisionId, reviewerA.userId)),
          ),
          settleResolve(
            harnessB.repo.resolve(provideCommand(decisionId, reviewerB.userId)),
          ),
        ]);

        // Deterministic: both transactions reached the barrier AFTER a real
        // PENDING read and before either CAS.
        expect(barrier.arrivals).toBe(2);

        const winners = [settledA, settledB].filter(
          (
            settled,
          ): settled is { ok: true; value: HumanDecisionReviewResolveResult } =>
            settled.ok,
        );
        const losers = [settledA, settledB].filter(
          (settled): settled is { ok: false; error: unknown } => !settled.ok,
        );
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(1);

        const winnerResult = winners[0].value;
        expect(winnerResult.status).toBe('resolved');
        const winnerActorId = winnerResult.decision.resolvedByActorId;
        expect([reviewerA.userId, reviewerB.userId]).toContain(winnerActorId);

        // Loser classification: different key against the committed winner.
        await expectResolveFailure(
          Promise.resolve().then(() => {
            throw losers[0].error;
          }),
          'ALREADY_RESOLVED',
        );

        const row = await integrationPrisma().humanDecision.findUniqueOrThrow({
          where: { id: decisionId },
        });
        expect(row).toMatchObject({
          status: 'RESOLVED',
          version: 2,
          resolutionAction: HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE,
          restockDays: 3,
          resolvedById: winnerActorId,
          resolvedByActorId: winnerActorId,
        });
        expect(row.resolvedById).toBe(winnerActorId);
        // Exactly ONE reviewer audit: the winner's actor, never both.
        const auditedReviewers = [reviewerA.userId, reviewerB.userId].filter(
          (userId) => userId === row.resolvedByActorId,
        );
        expect(auditedReviewers).toHaveLength(1);
        expect(row.resolvedByDisplayName).toBe(
          winnerResult.decision.resolvedByDisplayName,
        );

        // No outcome/sale/stock side effect from the resolution write.
        expect(row.applicationOutcome).toBeNull();
        expect(row.applicationAttemptId).toBeNull();
        expect(row.applicationEvidenceHash).toBeNull();
        expect(row.providerMessageId).toBeNull();
        expect(row.applicationAttemptedAt).toBeNull();
        expect(row.ackReceivedAt).toBeNull();
        await expect(totalDecisionRows()).resolves.toBe(1);
        await expect(integrationPrisma().sale.count()).resolves.toBe(
          salesBefore,
        );
        await expect(integrationPrisma().product.count()).resolves.toBe(
          productsBefore,
        );
      });

      it('yields one resolved and one replayed for the identical retry under a race', async () => {
        const tenantId = await seedTenant('Replay Race Tenant');
        const reviewer = await seedReviewer(tenantId, 'Retry Racer');
        const decisionId = await seedDecision(pendingDecisionData(tenantId));
        const key = crypto.randomUUID();

        const barrier = createSchedulingBarrier(2);
        const harnessA = makeBarrierHarness(tenantId, barrier);
        const harnessB = makeBarrierHarness(tenantId, barrier);

        const [settledA, settledB] = await Promise.all([
          settleResolve(
            harnessA.repo.resolve(
              provideCommand(decisionId, reviewer.userId, {
                resolutionRequestId: key,
                restockDays: 4,
              }),
            ),
          ),
          settleResolve(
            harnessB.repo.resolve(
              provideCommand(decisionId, reviewer.userId, {
                resolutionRequestId: key,
                restockDays: 4,
              }),
            ),
          ),
        ]);

        expect(barrier.arrivals).toBe(2);
        expect(settledA.ok).toBe(true);
        expect(settledB.ok).toBe(true);
        if (!settledA.ok || !settledB.ok) {
          throw new Error('expected both identical retries to settle');
        }

        const statuses = [settledA.value.status, settledB.value.status].sort();
        expect(statuses).toEqual(['replayed', 'resolved']);

        const row = await integrationPrisma().humanDecision.findUniqueOrThrow({
          where: { id: decisionId },
        });
        expect(row).toMatchObject({
          status: 'RESOLVED',
          version: 2,
          resolutionRequestId: key,
          restockDays: 4,
          resolvedByActorId: reviewer.userId,
        });
        await expect(totalDecisionRows()).resolves.toBe(1);

        // The replay observed the SAME committed timestamp the winner wrote.
        const winner =
          settledA.value.status === 'resolved'
            ? settledA.value
            : settledB.value;
        const replay =
          settledA.value.status === 'replayed'
            ? settledA.value
            : settledB.value;
        expect(replay.decision.resolvedAt?.toISOString()).toBe(
          winner.decision.resolvedAt?.toISOString(),
        );
      });
    });
  },
);
