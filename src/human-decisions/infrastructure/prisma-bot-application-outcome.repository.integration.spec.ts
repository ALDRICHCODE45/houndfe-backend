/**
 * HD-05b3 — PrismaBotApplicationOutcomeRepository real-PostgreSQL +
 * real-nestjs-cls-ALS integration spec.
 *
 * HD-05b2 shipped the terminal bot ACK adapter with a DB-free companion spec
 * (`prisma-bot-application-outcome.repository.spec.ts`) that mocks
 * `TenantPrismaService`. That spec proves the adapter SEAMS (the ambient-tx
 * guard, the unconditional CLS tenant resolution, the defensive re-parse +
 * canonical evidence hash, the tenant/source/type-scoped state read, the
 * `RESOLVED`/version-2 gate, the half-open `[resolvedAt, resolvedAt + 1h)`
 * window, the one-terminal `updateMany` CAS and the recorded/replayed/conflict
 * codes). It CANNOT prove what only real PostgreSQL plus a real
 * AsyncLocalStorage can answer: the persisted evidence/ACK columns surviving
 * the real `human_decisions_application_outcome_state` DB CHECK, the durable
 * replay identity (unchanged `ackReceivedAt`/`updatedAt`), an ACTUAL
 * two-writer race against one committed row, or that two concurrent CLS
 * request scopes stay isolated.
 *
 * This spec closes that gap against the dedicated isolated RESTOCK database
 * (`127.0.0.1:5433/nest-practice-restock-test`) with REAL Prisma, the REAL
 * `TenantPrismaService` and the REAL nestjs-cls AsyncLocalStorage store. It
 * boots a minimal Nest `TestingModule` with `ClsModule.forRoot({ global: true })`
 * plus `DatabaseModule`; each request context is opened through the real
 * `ClsService.runWith(store, work)`. No HTTP middleware, listener, controller,
 * guard, provider or full `AppModule` is booted, and no HTTP request is issued.
 *
 * THE ONLY INSTRUMENTED SEAM is a test-only `TenantPrismaService` subclass used
 * by the two concurrency tests. It wraps ONLY the transaction client's
 * `humanDecision.findFirst`/`updateMany` delegates with a bounded, single-use
 * scheduling barrier placed immediately BEFORE the real CAS `updateMany`. Both
 * transactions have already completed their REAL initial state read and are
 * about to race their REAL conditional `updateMany` against the same row; no
 * DB result is mocked and no update is faked. Every other test uses the exact
 * production adapter with no instrumentation at all.
 *
 * A+D DISCLOSURE (what this spec deliberately does NOT claim):
 *   - It makes NO claim about the HTTP route, DTO serialization,
 *     service-credential guard provenance, ALS request middleware, the full
 *     `AppModule` or any live service. It never calls a provider or device.
 *   - It does NOT exercise the `supersedesDecisionId` correlated-successor path
 *     through the intake adapter; for `STALE` it only proves the persisted row
 *     is a valid `STALE` terminal (no attempt/provider evidence) and that the
 *     outcome path itself creates no successor row.
 *   - The two-writer race IS forced by a bounded barrier (documented inline);
 *     it is not an unforced `Promise.all` scheduling accident.
 *   - `applicationEvidenceCode` is always `NULL` here because the wire carries
 *     no approved evidence-code enum (the adapter pins it null).
 *
 * ISOLATED-DB GUARD: before this file touches a row it validates BOTH the
 * `.env.test` file parsed with the local `dotenv` AND the ACTIVE
 * `process.env.DATABASE_URL` that `resetAndSeedBaseline` and the Nest
 * `PrismaService` client actually connect with, aborting unless each resolves
 * to exactly `postgresql://127.0.0.1:5433/nest-practice-restock-test`. The
 * check runs at module load (before any fixture or reset) and again before
 * EVERY `resetAndSeedBaseline()`, which truncates `tenants`/`users` CASCADE and
 * is therefore authorized exclusively for this dedicated database. Mismatch
 * errors are generic and redacted: the raw URL, its credentials and any
 * non-target database name are never echoed.
 *
 * CRITICAL: the integration Jest config runs `globalSetup` — which executes
 * `prisma migrate deploy` — BEFORE this spec module is evaluated. The in-spec
 * guard therefore CANNOT protect the migration step, and this suite must never
 * be the only destination check: every invocation requires the separate
 * pre-Jest destination precheck (see the HD-05b3 task record for the exact
 * command).
 *
 * Skip guard: `SKIP_DB_INTEGRATION=1` or an unset `DATABASE_URL` skips the
 * whole suite, matching the other integration specs.
 */
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Prisma } from '@prisma/client';
import * as dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ClsModule, ClsService } from 'nestjs-cls';
import {
  disconnectIntegrationPrisma,
  integrationPrisma,
  resetAndSeedBaseline,
} from '../../../test/integration/reset-db';
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import { DatabaseModule } from '../../shared/prisma/prisma.module';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import {
  DELIVERY_UNKNOWN,
  hashBotApplicationOutcomeEvidence,
  parseBotApplicationOutcomeRequest,
  PROVIDER_ACCEPTED,
  PROVIDER_ACCEPTED_LATE,
  STALE,
  type BotApplicationOutcomeRequest,
} from '../domain/bot-application-outcome.request';
import {
  BotApplicationOutcomeError,
  type BotApplicationOutcomeErrorCode,
  type BotApplicationOutcomeResult,
  type RecordBotApplicationOutcomeCommand,
} from '../domain/bot-application-outcome.repository';
import {
  HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE,
  HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE,
} from '../domain/human-decision-review-resolve.repository';
import {
  RESTOCK_SOURCE,
  RESTOCK_TYPE,
} from '../domain/restock-request-canonicalizer';
import {
  APPLICATION_OUTCOME_STATE_SELECT,
  INVALID_OUTCOME_WINDOW_CODE,
  PrismaBotApplicationOutcomeRepository,
} from './prisma-bot-application-outcome.repository';

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
      `[hd-05b3] refusing isolated-DB run: ${SOURCE_LABELS[source]} DATABASE_URL is unset.`,
    );
  }

  let url: globalThis.URL;
  try {
    url = new globalThis.URL(rawUrl);
  } catch {
    throw new Error(
      `[hd-05b3] refusing isolated-DB run: ${SOURCE_LABELS[source]} DATABASE_URL is not a valid URL.`,
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
      `[hd-05b3] refusing isolated-DB run: ${SOURCE_LABELS[source]} DATABASE_URL does not match the dedicated isolated RESTOCK target.`,
    );
  }
}

/**
 * Validate BOTH database endpoints this suite depends on: the `.env.test` file
 * parsed with the local `dotenv` (authoritative for the Jest globalSetup
 * migration) AND the ACTIVE `process.env.DATABASE_URL`, which is what
 * `resetAndSeedBaseline` and the Nest `PrismaService` client actually connect
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
      `[hd-05b3] isolated DB target OK: ${EXPECTED_PROTOCOL}//${EXPECTED_HOSTNAME}:${EXPECTED_PORT}/${EXPECTED_DATABASE}`,
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
// Fixed fixture values
// ---------------------------------------------------------------------------

/** Fixed `User` id used to populate the reviewer FK column in fixtures. */
const ACTOR_ID = 'actor-hd-05b3';
const REVIEWER_ACTOR_ID = 'reviewer-actor-hd-05b3';
const REVIEWER_DISPLAY_NAME = 'Hd05b3 Reviewer';
const CREDENTIAL_ID = 'cred-hd-05b3';
const CANONICAL_HASH = 'canonical-hash-hd-05b3';
const PROVIDER_MESSAGE_ID = 'wamid.HBgLMTIzNDU2Nzg5MA==';
const CHANGED_PROVIDER_MESSAGE_ID = 'wamid.HBgLOTg3NjU0MzIxMA==';

/** Valid RFC 4122 v1-v8 attempt ids (canonical UUID variant). */
const ATTEMPT_ID = '3f1c1b7a-9c2e-4d5f-8a6b-1c2d3e4f5a6b';
const OTHER_ATTEMPT_ID = '0192a1b2-c3d4-7e5f-8a6b-1c2d3e4f5a6b';

const PRODUCT_NAME = 'Cafe de altura';
const SKU = 'SKU-1';
const REQUESTED_QUANTITY = 5;
const OBSERVED_STOCK = 0;
const PRODUCT_STOCK = 7;
const BRANCH_NAME = 'HD-05b3 Branch';
const CREATED_AT = new Date('2026-06-15T11:00:00.000Z');
const OBSERVED_AT = new Date('2026-06-15T10:30:00.000Z');
const RESOLVED_AT = new Date('2026-06-15T12:00:00.000Z');
const DEADLINE_AT = '2026-06-15T13:00:00.000Z';
const ATTEMPTED_AT = '2026-06-15T12:00:00.000Z';
const ACCEPTED_OBSERVED_AT = '2026-06-15T12:00:04.500Z';
const LATE_ATTEMPTED_AT = '2026-06-15T12:59:59.000Z';
const LATE_ACCEPTED_OBSERVED_AT = '2026-06-15T13:05:00.000Z';
const BEFORE_RESOLVED_AT = '2026-06-15T11:59:59.000Z';
const FIXED_NOW = new Date('2026-06-15T12:05:00.000Z');
const REPLAY_NOW = new Date('2026-06-15T14:30:00.000Z');

/** The 8 keys of the adapter's exact state SELECT allowlist, sorted. */
const STATE_SELECT_KEYS = [
  'ackReceivedAt',
  'applicationAttemptId',
  'applicationEvidenceHash',
  'applicationOutcome',
  'id',
  'resolvedAt',
  'status',
  'version',
];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type TenantScopedClient = ReturnType<TenantPrismaService['getClient']>;

let app: INestApplication;
let cls: ClsService<TenantClsStore>;
let tenantPrisma: TenantPrismaService;
let prismaService: PrismaService;
let repo: PrismaBotApplicationOutcomeRepository;

/** Mutable server clock; the adapter's optional `now()` seam. */
let clockNow: Date = FIXED_NOW;

/**
 * Run `work` inside a fresh nestjs-cls ALS scope holding the given session
 * shape. This is the real `ClsService.runWith`, not a store shim: concurrent
 * scopes are isolated by AsyncLocalStorage.
 */
function withSession<T>(
  tenantId: string | null,
  isSuperAdmin: boolean,
  work: () => Promise<T>,
): Promise<T> {
  return cls.runWith<T | Promise<T>>(
    { tenantId, userId: ACTOR_ID, isSuperAdmin },
    work,
  ) as Promise<T>;
}

/** Convenience: a tenant-scoped, non-superadmin session. */
function withTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
  return withSession(tenantId, false, work);
}

/** Await a promise and return the thrown value instead of rejecting. */
async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  return run().catch((caught: unknown) => caught);
}

/** Narrow a captured value to a terminal-outcome domain error. */
function expectDomainError(error: unknown): BotApplicationOutcomeError {
  expect(error).toBeInstanceOf(BotApplicationOutcomeError);
  if (!(error instanceof BotApplicationOutcomeError)) {
    throw new Error('expected BotApplicationOutcomeError');
  }
  return error;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** One explicit tenant per test; the baseline tenant is never reused. */
async function seedTenant(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await integrationPrisma().tenant.create({
    data: { id, name, slug: `hd05b3-${id}` },
  });
  return id;
}

/**
 * Reviewer `User` row so the `resolvedById` FK column is populated with a real
 * value, making the immutable reviewer snapshot columns non-vacuous.
 */
async function seedReviewerUser(): Promise<string> {
  const id = crypto.randomUUID();
  await integrationPrisma().user.create({
    data: {
      id,
      email: `hd05b3-${id}@example.test`,
      hashedPassword: 'not-a-real-password-hash',
      name: REVIEWER_DISPLAY_NAME,
    },
  });
  return id;
}

/** Valid PENDING fixture: status/version defaults plus the intake snapshot. */
function pendingDecisionData(
  tenantId: string,
  overrides: Partial<Prisma.HumanDecisionUncheckedCreateInput> = {},
): Prisma.HumanDecisionUncheckedCreateInput {
  return {
    tenantId,
    source: RESTOCK_SOURCE,
    sourceRequestId: crypto.randomUUID(),
    type: RESTOCK_TYPE,
    canonicalRequestHash: CANONICAL_HASH,
    submittedCredentialId: CREDENTIAL_ID,
    branchId: tenantId,
    branchName: BRANCH_NAME,
    productId: crypto.randomUUID(),
    productName: PRODUCT_NAME,
    variantId: null,
    sku: SKU,
    requestedQuantity: REQUESTED_QUANTITY,
    observedStockAtRequest: OBSERVED_STOCK,
    stockObservedAt: OBSERVED_AT,
    supersedesDecisionId: null,
    status: 'PENDING',
    version: 1,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

/**
 * Valid `RESOLVED` positive fixture satisfying the HD-01 SQL CHECKs: the
 * immutable reviewer snapshot, the resolution audit and `version = 2` are all
 * present, and every terminal outcome/evidence column stays `NULL` so the
 * adapter can write the single outcome.
 */
function resolvedDecisionData(
  tenantId: string,
  resolvedById: string,
  overrides: Partial<Prisma.HumanDecisionUncheckedCreateInput> = {},
): Prisma.HumanDecisionUncheckedCreateInput {
  return {
    tenantId,
    source: RESTOCK_SOURCE,
    sourceRequestId: crypto.randomUUID(),
    type: RESTOCK_TYPE,
    canonicalRequestHash: CANONICAL_HASH,
    submittedCredentialId: CREDENTIAL_ID,
    branchId: tenantId,
    branchName: BRANCH_NAME,
    productId: crypto.randomUUID(),
    productName: PRODUCT_NAME,
    variantId: null,
    sku: SKU,
    requestedQuantity: REQUESTED_QUANTITY,
    observedStockAtRequest: OBSERVED_STOCK,
    stockObservedAt: OBSERVED_AT,
    supersedesDecisionId: null,
    status: 'RESOLVED',
    version: 2,
    resolutionAction: HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE,
    restockDays: 3,
    resolutionRequestId: crypto.randomUUID(),
    resolvedAt: RESOLVED_AT,
    resolvedById,
    resolvedByActorId: REVIEWER_ACTOR_ID,
    resolvedByDisplayName: REVIEWER_DISPLAY_NAME,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

/** Valid `RESOLVED` negative fixture: the no-ETA action omits `restockDays`. */
function resolvedNegativeDecisionData(
  tenantId: string,
  resolvedById: string,
): Prisma.HumanDecisionUncheckedCreateInput {
  return resolvedDecisionData(tenantId, resolvedById, {
    resolutionAction: HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE,
    restockDays: null,
  });
}

/** Persist one fixture and return its id. */
async function seedDecision(
  data: Prisma.HumanDecisionUncheckedCreateInput,
): Promise<string> {
  const row = await integrationPrisma().humanDecision.create({ data });
  return row.id;
}

/** Full persisted row; the integration client is NOT tenant-extended. */
async function fullRow(id: string) {
  return integrationPrisma().humanDecision.findUnique({ where: { id } });
}

/**
 * Full, deterministically ordered snapshot of EVERY Product/StockAlertState/
 * Sale row, plus the stock-bearing Variant/Lot tables, so a newly created row
 * or an unrelated mutation cannot hide behind a single-id comparison. All five
 * tables are tenant-scoped and cascaded away by the `tenants` TRUNCATE in
 * `resetAndSeedBaseline`, so the test baseline is empty and `orderBy: id` is
 * stable. This is a pure read; it never calls a provider or an external
 * service.
 */
async function snapshotInventoryRows() {
  const prisma = integrationPrisma();
  const [products, variants, lots, stockStates, sales] = await Promise.all([
    prisma.product.findMany({ orderBy: { id: 'asc' } }),
    prisma.variant.findMany({ orderBy: { id: 'asc' } }),
    prisma.lot.findMany({ orderBy: { id: 'asc' } }),
    prisma.stockAlertState.findMany({ orderBy: { id: 'asc' } }),
    prisma.sale.findMany({ orderBy: { id: 'asc' } }),
  ]);
  return { products, variants, lots, stockStates, sales };
}

// ---------------------------------------------------------------------------
// Request bodies (the exact HD-05b1 wire shape) + command builders
// ---------------------------------------------------------------------------

function acceptedBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    attemptId: ATTEMPT_ID,
    attemptedAt: ATTEMPTED_AT,
    expectedResolutionVersion: 2,
    outcome: PROVIDER_ACCEPTED,
    providerAcceptedObservedAt: ACCEPTED_OBSERVED_AT,
    providerMessageId: PROVIDER_MESSAGE_ID,
    ...overrides,
  };
}

function lateBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    attemptId: ATTEMPT_ID,
    attemptedAt: LATE_ATTEMPTED_AT,
    expectedResolutionVersion: 2,
    outcome: PROVIDER_ACCEPTED_LATE,
    providerAcceptedObservedAt: LATE_ACCEPTED_OBSERVED_AT,
    providerMessageId: PROVIDER_MESSAGE_ID,
    ...overrides,
  };
}

function unknownBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    attemptId: ATTEMPT_ID,
    attemptedAt: ATTEMPTED_AT,
    expectedResolutionVersion: 2,
    outcome: DELIVERY_UNKNOWN,
    ...overrides,
  };
}

function staleBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    attemptId: ATTEMPT_ID,
    expectedResolutionVersion: 2,
    outcome: STALE,
    ...overrides,
  };
}

function parseRequest(
  body: Record<string, unknown>,
): BotApplicationOutcomeRequest {
  return parseBotApplicationOutcomeRequest(body);
}

function command(
  request: BotApplicationOutcomeRequest,
  decisionId: string,
): RecordBotApplicationOutcomeCommand {
  return { decisionId, request };
}

function hashOf(body: Record<string, unknown>): string {
  return hashBotApplicationOutcomeEvidence(parseRequest(body));
}

// ---------------------------------------------------------------------------
// Two-writer scheduling barrier + instrumented service
// ---------------------------------------------------------------------------

interface SchedulingBarrier {
  /** Number of parties that have arrived (including current waiters). */
  readonly arrivals: number;
  /** Block until every party has arrived, then release all of them. */
  arrive(): Promise<void>;
}

/**
 * Upper bound for a participant that never arrives, measured from the moment
 * the FIRST party reaches the barrier — which is AFTER each transaction has
 * already run its real state read. It bounds only the barrier wait, NOT the
 * whole transaction: if the pre-read is slow, the overall Prisma interactive
 * transaction can still exceed its default 5s lifetime and surface an opaque
 * `P2028 transaction already closed`. Jest's 30s `testTimeout` and the
 * `afterEach` baseline reset remain the outer bound, and a barrier timeout
 * rejects the waiting transaction so no waiter leaks into teardown.
 */
const BARRIER_TIMEOUT_MS = 2_000;

/**
 * Value-free test error for a barrier timeout: the barrier is a scheduling
 * seam, so this is test-infrastructure failure, never a product error.
 */
const BARRIER_TIMEOUT_ERROR =
  'HD-05b3 outcome scheduling barrier timed out waiting for a partner';

/**
 * Minimal single-use barrier with no sleep-based synchronization. It only
 * widens the window in which both transactions have completed their REAL state
 * read; every DB query and result stays real. The wait is bounded by
 * `timeoutMs`, the timer starts only once the first party arrives, and it is
 * cleared on a normal `parties`-party release.
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
 * Test-only subclass with ONE narrow instrumentation seam: the transaction
 * client's `humanDecision.updateMany` waits at a shared barrier immediately
 * BEFORE running the real CAS. Both transactions have already executed their
 * REAL initial `humanDecision.findFirst` state read, so the subsequent
 * conditional update is a genuine race against one committed row. The
 * `findFirst` delegate (including the loser's post-CAS winner re-read) runs
 * untouched.
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
      humanDecision: {
        findFirst: (args: Prisma.HumanDecisionFindFirstArgs) =>
          client.humanDecision.findFirst(args),
        updateMany: async (args: Prisma.HumanDecisionUpdateManyArgs) => {
          await this.barrier.arrive();
          return client.humanDecision.updateMany(args);
        },
      },
    };
    return instrumented as unknown as TenantScopedClient;
  }
}

/** A repository whose CAS `updateMany` is barriered (see above). */
function makeBarrierRepo(
  barrier: SchedulingBarrier,
): PrismaBotApplicationOutcomeRepository {
  const service = new BarrierTenantPrismaService(prismaService, cls, barrier);
  return new PrismaBotApplicationOutcomeRepository(service, () => clockNow);
}

// ---------------------------------------------------------------------------
// DB CHECK probe helper
// ---------------------------------------------------------------------------

/**
 * Run `mutate` inside an interactive transaction that is ALWAYS rolled back.
 * The expected PostgreSQL CHECK violation aborts the statement and rolls the
 * transaction back, so the probe can never permanently corrupt the row; the
 * returned error is asserted to be the CHECK violation (not the rollback
 * marker) by the caller.
 */
async function probeDbCheck(
  mutate: (tx: Prisma.TransactionClient) => Promise<unknown>,
): Promise<unknown> {
  return integrationPrisma()
    .$transaction(async (tx) => {
      await mutate(tx);
      // Reached only when the invalid write was NOT rejected: force rollback.
      throw new Error('[hd-05b3] probe rollback marker');
    })
    .catch((caught: unknown) => caught);
}

/**
 * True only when the thrown value is an `Error` whose message names the EXACT
 * `human_decisions_application_outcome_state` CHECK constraint. Callers assert
 * this boolean (never the raw error/message) so a failing probe prints only
 * `true`/`false` and can never dump a Prisma/PostgreSQL diagnostic. The name is
 * present on `PrismaClientUnknownRequestError.message` for CHECK violations
 * (verified against this dedicated DB), so a generic `/check constraint/`
 * match — which would also accept an UNRELATED CHECK — is deliberately NOT
 * used.
 */
function isExpectedOutcomeConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('human_decisions_application_outcome_state')
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeIfDb(
  'PrismaBotApplicationOutcomeRepository (HD-05b3 PostgreSQL + ALS integration)',
  () => {
    beforeAll(async () => {
      await resetIsolatedBaseline();

      const moduleRef = await Test.createTestingModule({
        imports: [
          // REAL nestjs-cls ALS provider. No middleware mount is needed because
          // these tests open their own per-call scopes with `runWith`; the
          // AsyncLocalStorage instance is the same one the middleware would use.
          ClsModule.forRoot({ global: true }),
          // REAL global Prisma + TenantPrisma providers against the dedicated DB.
          DatabaseModule,
        ],
      }).compile();

      app = moduleRef.createNestApplication();
      await app.init();

      cls = app.get<ClsService<TenantClsStore>>(ClsService);
      tenantPrisma = app.get(TenantPrismaService);
      prismaService = app.get(PrismaService);
      repo = new PrismaBotApplicationOutcomeRepository(
        tenantPrisma,
        () => clockNow,
      );
    });

    beforeEach(() => {
      clockNow = FIXED_NOW;
    });

    afterEach(async () => {
      // TRUNCATE … CASCADE + re-seed: robust against any mid-test failure, and
      // it leaves the dedicated test DB at the known baseline for the next
      // test (and any later spec in the same run).
      await resetIsolatedBaseline();
    });

    afterAll(async () => {
      if (app) {
        await app.close();
      }
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

          expect(() => assertIsolatedTestDatabaseTarget()).toThrow(
            /refusing isolated-DB run/,
          );

          let message = '';
          try {
            assertIsolatedTestDatabaseTarget();
          } catch (error) {
            message = error instanceof Error ? error.message : String(error);
          }
          expect(message).toContain('[hd-05b3]');
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

    describe('record — four outcomes persisted with mapped evidence', () => {
      it('persists PROVIDER_ACCEPTED evidence and leaves status/version/human resolution and every Product/Stock/Sale row untouched', async () => {
        const tenantId = await seedTenant('Outcome Tenant A');
        const reviewerId = await seedReviewerUser();

        // Non-vacuous side-effect baseline: seed the inventory rows FIRST (the
        // decision references the real Product below), then snapshot EVERY row
        // in Product/StockAlertState/Sale plus the stock-bearing Variant/Lot
        // tables with deterministic ordering. `resetAndSeedBaseline` cascades
        // these tenant-scoped tables, so the baseline starts empty.
        const product = await integrationPrisma().product.create({
          data: { tenantId, name: PRODUCT_NAME, quantity: PRODUCT_STOCK },
        });
        const variant = await integrationPrisma().variant.create({
          data: {
            tenantId,
            productId: product.id,
            name: 'Default',
            quantity: 3,
          },
        });
        const lot = await integrationPrisma().lot.create({
          data: {
            tenantId,
            productId: product.id,
            lotNumber: 'LOT-1',
            quantity: 2,
            expirationDate: new Date('2027-01-01T00:00:00.000Z'),
          },
        });
        const stockState = await integrationPrisma().stockAlertState.create({
          data: {
            tenantId,
            productId: product.id,
            variantKey: 'default',
            alerted: true,
          },
        });
        const sale = await integrationPrisma().sale.create({
          data: { tenantId, userId: reviewerId },
        });

        const inventoryBefore = await snapshotInventoryRows();
        expect(inventoryBefore.products).toHaveLength(1);
        expect(inventoryBefore.products[0].id).toBe(product.id);
        expect(inventoryBefore.variants).toHaveLength(1);
        expect(inventoryBefore.variants[0].id).toBe(variant.id);
        expect(inventoryBefore.lots).toHaveLength(1);
        expect(inventoryBefore.lots[0].id).toBe(lot.id);
        expect(inventoryBefore.stockStates).toHaveLength(1);
        expect(inventoryBefore.stockStates[0].id).toBe(stockState.id);
        expect(inventoryBefore.sales).toHaveLength(1);
        expect(inventoryBefore.sales[0].id).toBe(sale.id);

        // The decision references the seeded Product by id, never a random one.
        const fixture = resolvedDecisionData(tenantId, reviewerId, {
          productId: product.id,
        });
        const decisionId = await seedDecision(fixture);

        const request = parseRequest(acceptedBody());
        const result = await withTenant(tenantId, () =>
          repo.record(command(request, decisionId)),
        );

        expect(result.status).toBe('recorded');
        expect(Object.keys(result.acknowledgment).sort()).toEqual([
          'ackReceivedAt',
          'attemptId',
          'id',
          'outcome',
          'version',
        ]);
        expect(result.acknowledgment).toEqual({
          id: decisionId,
          version: 2,
          attemptId: ATTEMPT_ID,
          outcome: PROVIDER_ACCEPTED,
          ackReceivedAt: FIXED_NOW,
        });

        const row = await fullRow(decisionId);
        expect(row).not.toBeNull();
        if (row === null) {
          throw new Error('[hd-05b3] expected the decision row to persist');
        }
        expect(row.applicationOutcome).toBe(PROVIDER_ACCEPTED);
        expect(row.applicationAttemptId).toBe(ATTEMPT_ID);
        expect(row.applicationEvidenceHash).toBe(hashOf(acceptedBody()));
        // No approved evidence-code enum on the wire: always NULL.
        expect(row.applicationEvidenceCode).toBeNull();
        expect(row.providerMessageId).toBe(PROVIDER_MESSAGE_ID);
        expect(row.providerAcceptedObservedAt?.toISOString()).toBe(
          new Date(ACCEPTED_OBSERVED_AT).toISOString(),
        );
        expect(row.applicationAttemptedAt?.toISOString()).toBe(
          new Date(ATTEMPTED_AT).toISOString(),
        );
        // `ackReceivedAt` is the backend receipt clock, independent of the
        // bot-observed provider timestamp.
        expect(row.ackReceivedAt?.toISOString()).toBe(FIXED_NOW.toISOString());
        expect(row.ackReceivedAt?.toISOString()).not.toBe(
          row.providerAcceptedObservedAt?.toISOString(),
        );

        // Status/version and the immutable human resolution are untouched.
        expect(row.status).toBe('RESOLVED');
        expect(row.version).toBe(2);
        expect(row.resolutionAction).toBe(
          HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE,
        );
        expect(row.restockDays).toBe(3);
        expect(row.resolutionRequestId).toBe(fixture.resolutionRequestId);
        expect(row.resolvedAt?.toISOString()).toBe(RESOLVED_AT.toISOString());
        expect(row.resolvedById).toBe(reviewerId);
        expect(row.resolvedByActorId).toBe(REVIEWER_ACTOR_ID);
        expect(row.resolvedByDisplayName).toBe(REVIEWER_DISPLAY_NAME);
        expect(row.canonicalRequestHash).toBe(CANONICAL_HASH);
        expect(row.createdAt.toISOString()).toBe(CREATED_AT.toISOString());
        // The decision points at the seeded Product, not a random id.
        expect(row.productId).toBe(product.id);
        expect(row.productName).toBe(PRODUCT_NAME);
        expect(row.productId).toBe(inventoryBefore.products[0].id);

        // No side effect on ANY Product/StockAlertState/Sale (or Variant/Lot)
        // row: the full ordered snapshots must be byte-identical, and the
        // counts pin the cardinality so a newly created row cannot slip past.
        const inventoryAfter = await snapshotInventoryRows();
        expect(inventoryAfter).toEqual(inventoryBefore);
        expect(inventoryAfter.products).toHaveLength(1);
        expect(inventoryAfter.variants).toHaveLength(1);
        expect(inventoryAfter.lots).toHaveLength(1);
        expect(inventoryAfter.stockStates).toHaveLength(1);
        expect(inventoryAfter.sales).toHaveLength(1);
        expect(inventoryAfter.products[0].id).toBe(product.id);
        expect(inventoryAfter.sales[0].id).toBe(sale.id);
      });

      it('persists PROVIDER_ACCEPTED_LATE with late provider evidence and an in-window attempt', async () => {
        const tenantId = await seedTenant('Outcome Tenant B');
        const reviewerId = await seedReviewerUser();
        const decisionId = await seedDecision(
          resolvedDecisionData(tenantId, reviewerId),
        );

        const request = parseRequest(lateBody());
        const result = await withTenant(tenantId, () =>
          repo.record(command(request, decisionId)),
        );

        expect(result.status).toBe('recorded');
        expect(result.acknowledgment.outcome).toBe(PROVIDER_ACCEPTED_LATE);

        const row = await fullRow(decisionId);
        expect(row?.applicationOutcome).toBe(PROVIDER_ACCEPTED_LATE);
        expect(row?.applicationEvidenceHash).toBe(hashOf(lateBody()));
        expect(row?.applicationEvidenceCode).toBeNull();
        expect(row?.providerMessageId).toBe(PROVIDER_MESSAGE_ID);
        // The observation is at/after the deadline; the attempt stayed inside.
        expect(row?.providerAcceptedObservedAt?.toISOString()).toBe(
          new Date(LATE_ACCEPTED_OBSERVED_AT).toISOString(),
        );
        expect(row?.applicationAttemptedAt?.toISOString()).toBe(
          new Date(LATE_ATTEMPTED_AT).toISOString(),
        );
        expect(row?.ackReceivedAt?.toISOString()).toBe(FIXED_NOW.toISOString());
        expect(row?.status).toBe('RESOLVED');
        expect(row?.version).toBe(2);
      });

      it('persists DELIVERY_UNKNOWN with the optional provider id kept audit-only and observedAt NULL', async () => {
        const tenantId = await seedTenant('Outcome Tenant C');
        const reviewerId = await seedReviewerUser();
        const decisionId = await seedDecision(
          resolvedDecisionData(tenantId, reviewerId),
        );

        const body = unknownBody({ providerMessageId: PROVIDER_MESSAGE_ID });
        const result = await withTenant(tenantId, () =>
          repo.record(command(parseRequest(body), decisionId)),
        );

        expect(result.status).toBe('recorded');
        expect(result.acknowledgment.outcome).toBe(DELIVERY_UNKNOWN);

        const row = await fullRow(decisionId);
        expect(row?.applicationOutcome).toBe(DELIVERY_UNKNOWN);
        expect(row?.applicationEvidenceHash).toBe(hashOf(body));
        // Partial audit evidence is retained...
        expect(row?.providerMessageId).toBe(PROVIDER_MESSAGE_ID);
        // ...but a definite acceptance timestamp must never be fabricated.
        expect(row?.providerAcceptedObservedAt).toBeNull();
        expect(row?.applicationAttemptedAt?.toISOString()).toBe(
          new Date(ATTEMPTED_AT).toISOString(),
        );
        expect(row?.ackReceivedAt?.toISOString()).toBe(FIXED_NOW.toISOString());
      });

      it('persists DELIVERY_UNKNOWN without a provider id as an all-NULL audit field', async () => {
        const tenantId = await seedTenant('Outcome Tenant D');
        const reviewerId = await seedReviewerUser();
        const decisionId = await seedDecision(
          resolvedDecisionData(tenantId, reviewerId),
        );

        const body = unknownBody();
        const result = await withTenant(tenantId, () =>
          repo.record(command(parseRequest(body), decisionId)),
        );

        expect(result.status).toBe('recorded');
        const row = await fullRow(decisionId);
        expect(row?.applicationOutcome).toBe(DELIVERY_UNKNOWN);
        expect(row?.providerMessageId).toBeNull();
        expect(row?.providerAcceptedObservedAt).toBeNull();
        expect(row?.applicationEvidenceHash).toBe(hashOf(body));
      });

      it('persists STALE with no attempt/provider evidence and creates no successor row', async () => {
        const tenantId = await seedTenant('Outcome Tenant E');
        const reviewerId = await seedReviewerUser();
        const decisionId = await seedDecision(
          resolvedDecisionData(tenantId, reviewerId),
        );

        const body = staleBody();
        const result = await withTenant(tenantId, () =>
          repo.record(command(parseRequest(body), decisionId)),
        );

        expect(result.status).toBe('recorded');
        expect(result.acknowledgment.outcome).toBe(STALE);

        const row = await fullRow(decisionId);
        expect(row?.applicationOutcome).toBe(STALE);
        expect(row?.applicationEvidenceHash).toBe(hashOf(body));
        // STALE forbids every send evidence column.
        expect(row?.applicationAttemptedAt).toBeNull();
        expect(row?.providerMessageId).toBeNull();
        expect(row?.providerAcceptedObservedAt).toBeNull();
        expect(row?.applicationEvidenceCode).toBeNull();
        expect(row?.ackReceivedAt?.toISOString()).toBe(FIXED_NOW.toISOString());
        expect(row?.status).toBe('RESOLVED');
        expect(row?.version).toBe(2);

        // The outcome path itself never opens the correlated-successor intake
        // path: no row references this STALE decision as its predecessor. The
        // `unique (tenantId, source, supersedesDecisionId)` guard lives in the
        // intake adapter and is intentionally NOT exercised here.
        expect(row?.supersedesDecisionId).toBeNull();
        await expect(
          integrationPrisma().humanDecision.count({
            where: { supersedesDecisionId: decisionId },
          }),
        ).resolves.toBe(0);
      });
    });

    describe('record — half-open window and acceptance classification', () => {
      it('records PROVIDER_ACCEPTED with an attempt exactly at the window start (inclusive)', async () => {
        const tenantId = await seedTenant('Window Tenant A');
        const reviewerId = await seedReviewerUser();
        const decisionId = await seedDecision(
          resolvedDecisionData(tenantId, reviewerId),
        );

        const result = await withTenant(tenantId, () =>
          repo.record(
            command(
              parseRequest(acceptedBody({ attemptedAt: ATTEMPTED_AT })),
              decisionId,
            ),
          ),
        );

        expect(result.status).toBe('recorded');
        const row = await fullRow(decisionId);
        expect(row?.applicationAttemptedAt?.toISOString()).toBe(
          new Date(ATTEMPTED_AT).toISOString(),
        );
      });

      it('rejects an attempt exactly at the deadline (half-open upper bound) value-free with no mutation', async () => {
        const tenantId = await seedTenant('Window Tenant B');
        const reviewerId = await seedReviewerUser();
        const decisionId = await seedDecision(
          resolvedDecisionData(tenantId, reviewerId),
        );
        const before = await fullRow(decisionId);

        const error = await captureError(() =>
          withTenant(tenantId, () =>
            repo.record(
              command(
                parseRequest(
                  acceptedBody({
                    attemptedAt: DEADLINE_AT,
                    providerAcceptedObservedAt: DEADLINE_AT,
                  }),
                ),
                decisionId,
              ),
            ),
          ),
        );

        expect(error).toBeInstanceOf(InvalidArgumentError);
        const invalid = error as InvalidArgumentError;
        expect(invalid.code).toBe(INVALID_OUTCOME_WINDOW_CODE);
        for (const leaked of [decisionId, ATTEMPT_ID, tenantId, DEADLINE_AT]) {
          expect(invalid.message).not.toContain(leaked);
        }

        const after = await fullRow(decisionId);
        expect(after?.applicationOutcome).toBeNull();
        expect(after?.updatedAt.toISOString()).toBe(
          before?.updatedAt.toISOString(),
        );
      });

      it('rejects an attempt strictly before resolvedAt without writing', async () => {
        const tenantId = await seedTenant('Window Tenant C');
        const reviewerId = await seedReviewerUser();
        const decisionId = await seedDecision(
          resolvedDecisionData(tenantId, reviewerId),
        );

        const error = await captureError(() =>
          withTenant(tenantId, () =>
            repo.record(
              command(
                parseRequest(
                  acceptedBody({
                    attemptedAt: BEFORE_RESOLVED_AT,
                    providerAcceptedObservedAt: ACCEPTED_OBSERVED_AT,
                  }),
                ),
                decisionId,
              ),
            ),
          ),
        );

        expect(error).toBeInstanceOf(InvalidArgumentError);
        const row = await fullRow(decisionId);
        expect(row?.applicationOutcome).toBeNull();
      });

      it('rejects PROVIDER_ACCEPTED observed exactly at the deadline (wrong acceptance classification)', async () => {
        const tenantId = await seedTenant('Window Tenant D');
        const reviewerId = await seedReviewerUser();
        const decisionId = await seedDecision(
          resolvedDecisionData(tenantId, reviewerId),
        );

        const error = await captureError(() =>
          withTenant(tenantId, () =>
            repo.record(
              command(
                parseRequest(
                  acceptedBody({
                    attemptedAt: LATE_ATTEMPTED_AT,
                    providerAcceptedObservedAt: DEADLINE_AT,
                  }),
                ),
                decisionId,
              ),
            ),
          ),
        );

        expect(error).toBeInstanceOf(InvalidArgumentError);
        expect((error as InvalidArgumentError).code).toBe(
          INVALID_OUTCOME_WINDOW_CODE,
        );
        const row = await fullRow(decisionId);
        expect(row?.applicationOutcome).toBeNull();
      });

      it('rejects PROVIDER_ACCEPTED_LATE observed before the deadline', async () => {
        const tenantId = await seedTenant('Window Tenant E');
        const reviewerId = await seedReviewerUser();
        const decisionId = await seedDecision(
          resolvedDecisionData(tenantId, reviewerId),
        );

        const error = await captureError(() =>
          withTenant(tenantId, () =>
            repo.record(
              command(
                parseRequest(
                  lateBody({ providerAcceptedObservedAt: LATE_ATTEMPTED_AT }),
                ),
                decisionId,
              ),
            ),
          ),
        );

        expect(error).toBeInstanceOf(InvalidArgumentError);
        const row = await fullRow(decisionId);
        expect(row?.applicationOutcome).toBeNull();
      });

      it('records PROVIDER_ACCEPTED_LATE observed exactly at the deadline (upper bound inclusive for LATE)', async () => {
        const tenantId = await seedTenant('Window Tenant F');
        const reviewerId = await seedReviewerUser();
        const decisionId = await seedDecision(
          resolvedDecisionData(tenantId, reviewerId),
        );

        const result = await withTenant(tenantId, () =>
          repo.record(
            command(
              parseRequest(
                lateBody({ providerAcceptedObservedAt: DEADLINE_AT }),
              ),
              decisionId,
            ),
          ),
        );

        expect(result.status).toBe('recorded');
        const row = await fullRow(decisionId);
        expect(row?.providerAcceptedObservedAt?.toISOString()).toBe(
          new Date(DEADLINE_AT).toISOString(),
        );
      });
    });

    describe('record — idempotent replay and terminal conflicts', () => {
      it('replays the exact same attempt/hash with an equal acknowledgment and unchanged ackReceivedAt/updatedAt after the wall clock passes the deadline', async () => {
        const tenantId = await seedTenant('Replay Tenant A');
        const reviewerId = await seedReviewerUser();
        const decisionId = await seedDecision(
          resolvedDecisionData(tenantId, reviewerId),
        );

        clockNow = FIXED_NOW;
        const body = acceptedBody();
        const first = await withTenant(tenantId, () =>
          repo.record(command(parseRequest(body), decisionId)),
        );
        expect(first.status).toBe('recorded');

        const persisted = await fullRow(decisionId);
        expect(persisted?.ackReceivedAt?.toISOString()).toBe(
          FIXED_NOW.toISOString(),
        );
        const ackAt = persisted?.ackReceivedAt?.getTime();
        const updatedAt = persisted?.updatedAt.getTime();

        // Wall clock moves well past the deadline; the replay must NOT
        // re-validate the temporal window nor rewrite ackReceivedAt/updatedAt.
        clockNow = REPLAY_NOW;
        const second = await withTenant(tenantId, () =>
          repo.record(command(parseRequest(body), decisionId)),
        );

        expect(second.status).toBe('replayed');
        expect(second.acknowledgment).toEqual(first.acknowledgment);
        expect(second.acknowledgment.ackReceivedAt.toISOString()).toBe(
          FIXED_NOW.toISOString(),
        );

        const afterReplay = await fullRow(decisionId);
        expect(afterReplay?.ackReceivedAt?.getTime()).toBe(ackAt);
        expect(afterReplay?.updatedAt.getTime()).toBe(updatedAt);
        expect(afterReplay?.applicationEvidenceHash).toBe(hashOf(body));
      });

      it('returns IDEMPOTENCY_CONFLICT for the same attempt id with a changed hash', async () => {
        const tenantId = await seedTenant('Replay Tenant B');
        const reviewerId = await seedReviewerUser();
        const decisionId = await seedDecision(
          resolvedDecisionData(tenantId, reviewerId),
        );

        await withTenant(tenantId, () =>
          repo.record(command(parseRequest(acceptedBody()), decisionId)),
        );

        const error = expectDomainError(
          await captureError(() =>
            withTenant(tenantId, () =>
              repo.record(
                command(
                  parseRequest(
                    acceptedBody({
                      providerMessageId: CHANGED_PROVIDER_MESSAGE_ID,
                    }),
                  ),
                  decisionId,
                ),
              ),
            ),
          ),
        );
        expect(error.code).toBe('IDEMPOTENCY_CONFLICT');
        expect(error.message).not.toContain(ATTEMPT_ID);
        expect(error.message).not.toContain(decisionId);
      });

      it.each<[string, Record<string, unknown>]>([
        ['PROVIDER_ACCEPTED', acceptedBody()],
        [
          'PROVIDER_ACCEPTED_LATE',
          lateBody({ providerAcceptedObservedAt: DEADLINE_AT }),
        ],
        ['DELIVERY_UNKNOWN', unknownBody()],
      ])(
        'returns OUTCOME_ALREADY_RECORDED for a different attempt id after a %s terminal',
        async (_label, body) => {
          const tenantId = await seedTenant('Replay Tenant C');
          const reviewerId = await seedReviewerUser();
          const decisionId = await seedDecision(
            resolvedDecisionData(tenantId, reviewerId),
          );

          await withTenant(tenantId, () =>
            repo.record(command(parseRequest(body), decisionId)),
          );
          const committed = await fullRow(decisionId);

          const error = expectDomainError(
            await captureError(() =>
              withTenant(tenantId, () =>
                repo.record(
                  command(
                    parseRequest(acceptedBody({ attemptId: OTHER_ATTEMPT_ID })),
                    decisionId,
                  ),
                ),
              ),
            ),
          );
          expect(error.code).toBe('OUTCOME_ALREADY_RECORDED');

          // The terminal hold is durable: nothing changed.
          const after = await fullRow(decisionId);
          expect(after?.applicationAttemptId).toBe(
            committed?.applicationAttemptId,
          );
          expect(after?.updatedAt.getTime()).toBe(
            committed?.updatedAt.getTime(),
          );
        },
      );
    });

    describe('record — eligibility, tenant scope and the state SELECT', () => {
      it('returns NOT_FOUND for missing, cross-tenant and foreign-source ids while the rows exist', async () => {
        const tenantA = await seedTenant('Miss Tenant A');
        const tenantB = await seedTenant('Miss Tenant B');
        const reviewerId = await seedReviewerUser();

        const crossTenantId = await seedDecision(
          resolvedDecisionData(tenantB, reviewerId),
        );
        const foreignSourceId = await seedDecision(
          resolvedDecisionData(tenantA, reviewerId, {
            source: 'other-bot-source',
          }),
        );
        const missingId = crypto.randomUUID();

        const error = expectDomainError(
          await captureError(() =>
            withTenant(tenantA, () =>
              repo.record(command(parseRequest(acceptedBody()), missingId)),
            ),
          ),
        );
        // All three failures are deliberately indistinguishable and value-free.
        for (const id of [missingId, crossTenantId, foreignSourceId]) {
          const caught = expectDomainError(
            await captureError(() =>
              withTenant(tenantA, () =>
                repo.record(command(parseRequest(acceptedBody()), id)),
              ),
            ),
          );
          expect(caught.code).toBe<BotApplicationOutcomeErrorCode>('NOT_FOUND');
          expect(caught.message).not.toContain(id);
          expect(caught.message).not.toContain(tenantA);
        }
        expect(error.code).toBe('NOT_FOUND');

        // Non-vacuous: the cross-tenant and foreign-source rows DO exist.
        await expect(fullRow(crossTenantId)).resolves.toMatchObject({
          tenantId: tenantB,
          applicationOutcome: null,
        });
        await expect(fullRow(foreignSourceId)).resolves.toMatchObject({
          tenantId: tenantA,
          source: 'other-bot-source',
          applicationOutcome: null,
        });
      });

      it('returns VERSION_CONFLICT for a PENDING decision without mutating it', async () => {
        const tenantId = await seedTenant('Eligibility Tenant A');
        const decisionId = await seedDecision(pendingDecisionData(tenantId));
        const before = await fullRow(decisionId);

        const error = expectDomainError(
          await captureError(() =>
            withTenant(tenantId, () =>
              repo.record(command(parseRequest(acceptedBody()), decisionId)),
            ),
          ),
        );
        expect(error.code).toBe('VERSION_CONFLICT');

        const after = await fullRow(decisionId);
        expect(after?.status).toBe('PENDING');
        expect(after?.version).toBe(1);
        expect(after?.applicationOutcome).toBeNull();
        expect(after?.updatedAt.toISOString()).toBe(
          before?.updatedAt.toISOString(),
        );
      });

      it('returns VERSION_CONFLICT for a stale expectedResolutionVersion', async () => {
        const tenantId = await seedTenant('Eligibility Tenant B');
        const reviewerId = await seedReviewerUser();
        const decisionId = await seedDecision(
          resolvedDecisionData(tenantId, reviewerId),
        );

        const error = expectDomainError(
          await captureError(() =>
            withTenant(tenantId, () =>
              repo.record(
                command(
                  parseRequest(acceptedBody({ expectedResolutionVersion: 1 })),
                  decisionId,
                ),
              ),
            ),
          ),
        );
        expect(error.code).toBe('VERSION_CONFLICT');
        const row = await fullRow(decisionId);
        expect(row?.applicationOutcome).toBeNull();
        expect(row?.version).toBe(2);
      });

      it('pins the classification SELECT allowlist to the 8 state columns (no evidence widening)', () => {
        expect(Object.keys(APPLICATION_OUTCOME_STATE_SELECT).sort()).toEqual(
          STATE_SELECT_KEYS,
        );
        for (const forbidden of [
          'applicationEvidenceCode',
          'applicationAttemptedAt',
          'providerMessageId',
          'providerAcceptedObservedAt',
          'tenantId',
          'source',
          'canonicalRequestHash',
        ]) {
          expect(APPLICATION_OUTCOME_STATE_SELECT).not.toHaveProperty(
            forbidden,
          );
        }
      });
    });

    describe('record — real concurrent writers (bounded barrier)', () => {
      it('forces exactly one winner and one OUTCOME_ALREADY_RECORDED for two different attempt ids', async () => {
        const tenantId = await seedTenant('Race Tenant A');
        const reviewerId = await seedReviewerUser();
        const decisionId = await seedDecision(
          resolvedDecisionData(tenantId, reviewerId),
        );

        const barrier = createSchedulingBarrier(2);
        const raceRepo = makeBarrierRepo(barrier);

        // The barrier is placed immediately BEFORE the CAS updateMany, so both
        // transactions have completed their real state read and their real
        // conditional update races the SAME committed row. The race is FORCED.
        const settled = await Promise.allSettled([
          withTenant(tenantId, () =>
            raceRepo.record(
              command(
                parseRequest(acceptedBody({ attemptId: ATTEMPT_ID })),
                decisionId,
              ),
            ),
          ),
          withTenant(tenantId, () =>
            raceRepo.record(
              command(
                parseRequest(acceptedBody({ attemptId: OTHER_ATTEMPT_ID })),
                decisionId,
              ),
            ),
          ),
        ]);

        expect(barrier.arrivals).toBe(2);
        const fulfilled = settled.filter(
          (
            entry,
          ): entry is PromiseFulfilledResult<BotApplicationOutcomeResult> =>
            entry.status === 'fulfilled',
        );
        const rejected = settled.filter(
          (entry): entry is PromiseRejectedResult =>
            entry.status === 'rejected',
        );
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(fulfilled[0].value.status).toBe('recorded');

        const loser = expectDomainError(rejected[0].reason);
        expect(loser.code).toBe('OUTCOME_ALREADY_RECORDED');

        const row = await fullRow(decisionId);
        const winnerAttempt = fulfilled[0].value.acknowledgment.attemptId;
        expect([ATTEMPT_ID, OTHER_ATTEMPT_ID]).toContain(winnerAttempt);
        expect(row?.applicationAttemptId).toBe(winnerAttempt);
        expect(row?.applicationOutcome).toBe(PROVIDER_ACCEPTED);
      });

      it('forces exactly one recorded + one replayed for two identical attempt/hash ACKs', async () => {
        const tenantId = await seedTenant('Race Tenant B');
        const reviewerId = await seedReviewerUser();
        const decisionId = await seedDecision(
          resolvedDecisionData(tenantId, reviewerId),
        );

        const barrier = createSchedulingBarrier(2);
        const raceRepo = makeBarrierRepo(barrier);
        const body = acceptedBody();

        const settled = await Promise.allSettled([
          withTenant(tenantId, () =>
            raceRepo.record(command(parseRequest(body), decisionId)),
          ),
          withTenant(tenantId, () =>
            raceRepo.record(command(parseRequest(body), decisionId)),
          ),
        ]);

        expect(barrier.arrivals).toBe(2);
        const statuses = settled
          .map((entry) =>
            entry.status === 'fulfilled' ? entry.value.status : 'rejected',
          )
          .sort();
        expect(statuses).toEqual(['recorded', 'replayed']);

        const row = await fullRow(decisionId);
        expect(row?.applicationOutcome).toBe(PROVIDER_ACCEPTED);
        expect(row?.applicationAttemptId).toBe(ATTEMPT_ID);
        // Exactly one durable terminal row.
        await expect(
          integrationPrisma().humanDecision.count({
            where: { tenantId, applicationOutcome: { not: null } },
          }),
        ).resolves.toBe(1);
      });
    });

    describe('real ALS isolation', () => {
      it('keeps two simultaneous tenant A/B records disjoint and correctly scoped', async () => {
        const tenantA = await seedTenant('Als Tenant A');
        const tenantB = await seedTenant('Als Tenant B');
        const reviewerId = await seedReviewerUser();
        const idA = await seedDecision(
          resolvedDecisionData(tenantA, reviewerId),
        );
        const idB = await seedDecision(
          resolvedDecisionData(tenantB, reviewerId, {
            sourceRequestId: crypto.randomUUID(),
          }),
        );

        // Both `runWith` scopes are opened before either awaits the released
        // gate, so the two ALS contexts are provably live and interleaved.
        let releaseGate: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
          releaseGate = resolve;
        });
        let arrived = 0;

        const runRecord = (tenantId: string, id: string) =>
          withTenant(tenantId, async () => {
            const observedTenantId = cls.get('tenantId');
            arrived += 1;
            if (arrived === 2) {
              releaseGate();
            }
            await gate;
            const result = await repo.record(
              command(parseRequest(acceptedBody()), id),
            );
            return { observedTenantId, result };
          });

        const [fromA, fromB] = await Promise.all([
          runRecord(tenantA, idA),
          runRecord(tenantB, idB),
        ]);

        expect(fromA.observedTenantId).toBe(tenantA);
        expect(fromB.observedTenantId).toBe(tenantB);
        expect(fromA.result.status).toBe('recorded');
        expect(fromB.result.status).toBe('recorded');

        const rowA = await fullRow(idA);
        const rowB = await fullRow(idB);
        expect(rowA?.tenantId).toBe(tenantA);
        expect(rowB?.tenantId).toBe(tenantB);
        expect(rowA?.applicationOutcome).toBe(PROVIDER_ACCEPTED);
        expect(rowB?.applicationOutcome).toBe(PROVIDER_ACCEPTED);
        // Only the two targeted rows were written.
        await expect(
          integrationPrisma().humanDecision.count({
            where: { applicationOutcome: { not: null } },
          }),
        ).resolves.toBe(2);
        expect(cls.isActive()).toBe(false);
      });
    });

    describe('PostgreSQL CHECK probes (rolled back, no permanent corruption)', () => {
      it('rejects STALE with an attempted timestamp and leaves the row untouched', async () => {
        const tenantId = await seedTenant('Check Tenant A');
        const reviewerId = await seedReviewerUser();
        const decisionId = await seedDecision(
          resolvedNegativeDecisionData(tenantId, reviewerId),
        );
        const before = await fullRow(decisionId);

        const error = await probeDbCheck((tx) =>
          tx.humanDecision.update({
            where: { id: decisionId },
            data: {
              applicationOutcome: STALE,
              applicationAttemptId: ATTEMPT_ID,
              applicationEvidenceHash: CANONICAL_HASH,
              providerMessageId: null,
              providerAcceptedObservedAt: null,
              ackReceivedAt: FIXED_NOW,
              applicationAttemptedAt: RESOLVED_AT,
            },
          }),
        );

        expect(isExpectedOutcomeConstraint(error)).toBe(true);

        const after = await fullRow(decisionId);
        expect(after).toEqual(before);
        expect(after?.applicationOutcome).toBeNull();
      });

      it('rejects PROVIDER_ACCEPTED observed before resolvedAt and leaves the row untouched', async () => {
        const tenantId = await seedTenant('Check Tenant B');
        const reviewerId = await seedReviewerUser();
        const decisionId = await seedDecision(
          resolvedNegativeDecisionData(tenantId, reviewerId),
        );
        const before = await fullRow(decisionId);

        const error = await probeDbCheck((tx) =>
          tx.humanDecision.update({
            where: { id: decisionId },
            data: {
              applicationOutcome: PROVIDER_ACCEPTED,
              applicationAttemptId: ATTEMPT_ID,
              applicationEvidenceHash: CANONICAL_HASH,
              providerMessageId: PROVIDER_MESSAGE_ID,
              providerAcceptedObservedAt: new Date(BEFORE_RESOLVED_AT),
              ackReceivedAt: FIXED_NOW,
              applicationAttemptedAt: RESOLVED_AT,
            },
          }),
        );

        expect(isExpectedOutcomeConstraint(error)).toBe(true);

        const after = await fullRow(decisionId);
        expect(after).toEqual(before);
        expect(after?.applicationOutcome).toBeNull();
      });

      it('rejects a NULL outcome with an ackReceivedAt and leaves the row untouched', async () => {
        const tenantId = await seedTenant('Check Tenant C');
        const reviewerId = await seedReviewerUser();
        const decisionId = await seedDecision(
          resolvedNegativeDecisionData(tenantId, reviewerId),
        );
        const before = await fullRow(decisionId);

        const error = await probeDbCheck((tx) =>
          tx.humanDecision.update({
            where: { id: decisionId },
            data: { ackReceivedAt: FIXED_NOW },
          }),
        );

        expect(isExpectedOutcomeConstraint(error)).toBe(true);

        const after = await fullRow(decisionId);
        expect(after).toEqual(before);
        expect(after?.ackReceivedAt).toBeNull();
      });
    });
  },
);
