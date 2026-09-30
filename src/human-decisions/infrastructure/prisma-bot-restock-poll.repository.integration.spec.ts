/**
 * HD-05a2b — PrismaBotRestockPollRepository real-PostgreSQL integration spec.
 *
 * HD-05a2a shipped the tenant-scoped bot CURRENT-state poll adapter with a
 * DB-free companion spec (`prisma-bot-restock-poll.repository.spec.ts`) that
 * mocks `TenantPrismaService`. That spec proves the adapter SEAMS (pinned
 * predicate, SELECT allowlist, flat-row -> nested-record projection, argument
 * guards). It cannot prove what only PostgreSQL plus the real tenant-scoping
 * extension can answer: the real `tenantId` WHERE-injection, the real
 * `findFirst` no-match for a cross-tenant / foreign-source id, the real
 * persisted resolution state, or that a widened DB row cannot leak a forbidden
 * column into the poll model.
 *
 * This spec closes that gap against the dedicated isolated RESTOCK database
 * (`127.0.0.1:5433/nest-practice-restock-test`) with REAL Prisma, the REAL
 * `TenantPrismaService` and — unlike the HD-04b3b read-repo spec — the REAL
 * nestjs-cls AsyncLocalStorage store.
 *
 * CLS IS REAL HERE: instead of the per-harness `Map` shim used by the earlier
 * repository integration specs, this file boots a minimal Nest
 * `TestingModule` with `ClsModule.forRoot({ global: true })` and seeds each
 * request context through the real `ClsService.runWith(store, work)`. Two
 * concurrent `runWith` scopes are proven to stay isolated, which the shim
 * could never show. No HTTP middleware, listener, controller, guard, provider
 * or full `AppModule` is booted, and no HTTP request is issued: only
 * `ClsModule` (real ALS) and `DatabaseModule` (real `PrismaService` +
 * `TenantPrismaService`) are assembled.
 *
 * THE ONLY INSTRUMENTED SEAM is a single `jest.spyOn(tenantPrisma, 'getClient')`
 * used by the fail-closed test. `jest.spyOn` calls the original method through,
 * so no repository, client or database behavior is replaced; the spy only
 * records whether the tenant gate threw BEFORE a scoped client (and therefore
 * any query) was built.
 *
 * TENANT-EXTENSION PROOF SEPARATION: the adapter passes `tenantId` explicitly,
 * so an adapter assertion alone cannot isolate the extension's
 * WHERE-injection. The superadmin / no-tenant test therefore ALSO reads the
 * tenant-scoped client with an EMPTY `where`, proving the extension's
 * superadmin bypass is real and that the adapter's unconditional
 * `getTenantId()` is the actual fail-closed gate.
 *
 * TYPE PIN, NOT ENUM-ONLY: `HumanDecisionType` has TWO members, so the nulls
 * test seeds a real same-tenant/same-source PENDING EXPIRATION row and proves
 * the `RESTOCK_TYPE` pin excludes it while the row IS committed.
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
 * pre-Jest destination precheck (see the HD-05a2b task record for the exact
 * command).
 *
 * Scope boundary: this spec proves the bot poll read model against real
 * PostgreSQL. It makes NO claim about the bot HTTP route, the ACK /
 * application-outcome write path, HTTP auth, ALS request middleware, provider
 * delivery or the full application graph.
 *
 * Skip guard: `SKIP_DB_INTEGRATION=1` or an unset `DATABASE_URL` skips the
 * whole suite, matching the other integration specs.
 */
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { HumanDecisionType } from '@prisma/client';
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
import { DatabaseModule } from '../../shared/prisma/prisma.module';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import type {
  BotRestockPollRecord,
  BotRestockPollSnapshotRecord,
} from '../domain/bot-restock-poll.repository';
import {
  HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE,
  HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE,
} from '../domain/human-decision-review-resolve.repository';
import type {
  PersistedRestockDecision,
  PersistedRestockDecisionStatus,
} from '../domain/restock-intake.repository';
import {
  RESTOCK_SOURCE,
  RESTOCK_TYPE,
} from '../domain/restock-request-canonicalizer';
import { toBotRestockIntakeResponse } from '../presentation/dto/bot-restock-intake.response';
import { toBotRestockPollResponse } from '../presentation/dto/bot-restock-poll.response';
import {
  BOT_POLL_RECORD_SELECT,
  PrismaBotRestockPollRepository,
} from './prisma-bot-restock-poll.repository';

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
      `[hd-05a2b] refusing isolated-DB run: ${SOURCE_LABELS[source]} DATABASE_URL is unset.`,
    );
  }

  let url: globalThis.URL;
  try {
    url = new globalThis.URL(rawUrl);
  } catch {
    throw new Error(
      `[hd-05a2b] refusing isolated-DB run: ${SOURCE_LABELS[source]} DATABASE_URL is not a valid URL.`,
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
      `[hd-05a2b] refusing isolated-DB run: ${SOURCE_LABELS[source]} DATABASE_URL does not match the dedicated isolated RESTOCK target.`,
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
      `[hd-05a2b] isolated DB target OK: ${EXPECTED_PROTOCOL}//${EXPECTED_HOSTNAME}:${EXPECTED_PORT}/${EXPECTED_DATABASE}`,
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

/**
 * Real Nest DI services: the real `ClsService` backed by nestjs-cls
 * AsyncLocalStorage, the real `PrismaService`, and the real
 * `TenantPrismaService` (CLS-driven tenant-scoping `$extends` factory). The
 * poll adapter under test is the exact production class.
 */
let app: INestApplication;
let cls: ClsService<TenantClsStore>;
let tenantPrisma: TenantPrismaService;
let repo: PrismaBotRestockPollRepository;

/** Fixed `User` id used to populate the reviewer FK column in fixtures. */
const ACTOR_ID = 'actor-hd-05a2b';

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

/** Read a poll record expected to resolve, without a non-null assertion. */
async function readOrFail(
  tenantId: string,
  id: string,
): Promise<BotRestockPollRecord> {
  const record = await withTenant(tenantId, () => repo.findById(id));
  if (record === null) {
    throw new Error('[hd-05a2b] expected the poll read to resolve a record');
  }
  return record;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Distinctive, searchable values so a projection leak is impossible to miss. */
const CREDENTIAL_ID = 'cred-hd-05a2b';
const CANONICAL_HASH = 'canonical-hash-hd-05a2b';
const REVIEWER_ACTOR_ID = 'reviewer-actor-hd-05a2b';
const REVIEWER_DISPLAY_NAME = 'Hd05a2b Reviewer';
const ATTEMPT_ID = 'attempt-hd-05a2b';
const EVIDENCE_HASH = 'evidence-hash-hd-05a2b';
const EVIDENCE_CODE = 'evidence-code-hd-05a2b';
const PROVIDER_MESSAGE_ID = 'provider-message-hd-05a2b';

const PRODUCT_NAME = 'Cafe de altura';
const SKU = 'SKU-1';
const REQUESTED_QUANTITY = 5;
const OBSERVED_STOCK = 0;
const CREATED_AT = new Date('2026-09-30T10:00:00.000Z');
const OBSERVED_AT = new Date('2026-09-30T09:30:00.000Z');
const RESOLVED_AT = new Date('2026-09-30T12:00:00.000Z');
const RESOLVED_PLUS_1H_ISO = new Date(
  RESOLVED_AT.getTime() + 3_600_000,
).toISOString();
const SUPERSEDES_ID = '77777777-7777-4777-8777-777777777777';

/** Top-level keys of the nested poll record (11), sorted. */
const POLL_RECORD_KEYS = [
  'createdAt',
  'id',
  'resolutionAction',
  'resolvedAt',
  'restockDays',
  'snapshot',
  'sourceRequestId',
  'status',
  'supersedesDecisionId',
  'type',
  'version',
];

/** Immutable snapshot keys (9), sorted. */
const SNAPSHOT_KEYS = [
  'branchId',
  'branchName',
  'observedStockAtRequest',
  'productId',
  'productName',
  'requestedQuantity',
  'sku',
  'stockObservedAt',
  'variantId',
];

/** The 19 keys of the adapter's exact SELECT allowlist, sorted. */
const SELECT_KEYS = [
  'branchId',
  'branchName',
  'createdAt',
  'id',
  'observedStockAtRequest',
  'productId',
  'productName',
  'requestedQuantity',
  'resolutionAction',
  'resolvedAt',
  'restockDays',
  'sku',
  'sourceRequestId',
  'status',
  'stockObservedAt',
  'supersedesDecisionId',
  'type',
  'variantId',
  'version',
];

/** The 10 keys of the bot poll response body, sorted. */
const RESPONSE_KEYS = [
  'applyBefore',
  'createdAt',
  'id',
  'resolution',
  'snapshot',
  'sourceRequestId',
  'status',
  'supersedesDecisionId',
  'type',
  'version',
];

/**
 * Authority / credential / reviewer / provider / outcome / PII columns that
 * must never reach the poll record or its response. The adapter's SELECT keyset
 * is asserted separately; this list covers the persisted-with-real-value proof.
 */
const FORBIDDEN_RECORD_KEYS = [
  'tenantId',
  'source',
  'canonicalRequestHash',
  'submittedCredentialId',
  'resolutionRequestId',
  'resolvedById',
  'resolvedByActorId',
  'resolvedByDisplayName',
  'resolvedBy',
  'applicationOutcome',
  'applicationAttemptId',
  'applicationEvidenceHash',
  'applicationEvidenceCode',
  'providerMessageId',
  'providerAcceptedObservedAt',
  'applicationAttemptedAt',
  'ackReceivedAt',
  'updatedAt',
];

/** Non-allowlisted SELECT columns that must never widen the poll projection. */
const FORBIDDEN_SELECT_KEYS = [
  'tenantId',
  'source',
  'canonicalRequestHash',
  'submittedCredentialId',
  'resolutionRequestId',
  'resolvedById',
  'resolvedByActorId',
  'resolvedByDisplayName',
  'applicationOutcome',
  'applicationAttemptId',
  'applicationEvidenceHash',
  'applicationEvidenceCode',
  'providerMessageId',
  'providerAcceptedObservedAt',
  'applicationAttemptedAt',
  'ackReceivedAt',
];

interface PollFixture {
  data: Prisma.HumanDecisionUncheckedCreateInput;
  expectedSnapshot: BotRestockPollSnapshotRecord;
}

/** One explicit tenant per test; the baseline tenant is never reused. */
async function seedTenant(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await integrationPrisma().tenant.create({
    data: { id, name, slug: `hd05a2b-${id}` },
  });
  return id;
}

/**
 * Reviewer `User` row so the `resolvedById` FK column is populated with a real
 * value, making the "the DB HAS the reviewer column" proof non-vacuous.
 */
async function seedReviewerUser(): Promise<string> {
  const id = crypto.randomUUID();
  await integrationPrisma().user.create({
    data: {
      id,
      email: `hd05a2b-${id}@example.test`,
      hashedPassword: 'not-a-real-password-hash',
      name: REVIEWER_DISPLAY_NAME,
    },
  });
  return id;
}

/**
 * Valid PENDING fixture: status/version defaults plus the immutable intake
 * snapshot. `productId` is a canonical RFC 4122 UUID so the committed mapper
 * accepts the persisted row without normalizing anything.
 */
function pendingFixture(
  tenantId: string,
  branchName: string,
  overrides: Partial<Prisma.HumanDecisionUncheckedCreateInput> = {},
): PollFixture {
  const productId = crypto.randomUUID();
  const sourceRequestId = crypto.randomUUID();
  const data: Prisma.HumanDecisionUncheckedCreateInput = {
    tenantId,
    source: RESTOCK_SOURCE,
    sourceRequestId,
    type: RESTOCK_TYPE,
    canonicalRequestHash: CANONICAL_HASH,
    submittedCredentialId: CREDENTIAL_ID,
    branchId: tenantId,
    branchName,
    productId,
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
  return {
    data,
    expectedSnapshot: {
      branchId: tenantId,
      branchName,
      productId,
      productName: PRODUCT_NAME,
      variantId: null,
      sku: SKU,
      requestedQuantity: REQUESTED_QUANTITY,
      observedStockAtRequest: OBSERVED_STOCK,
      stockObservedAt: OBSERVED_AT,
    },
  };
}

/**
 * Valid `RESOLVED` positive fixture satisfying the HD-01 SQL CHECKs AND the
 * outcome CHECK with a terminal `PROVIDER_ACCEPTED` outcome: every
 * reviewer/audit/provider/outcome column is populated so the poll projection's
 * exclusion is proven against a row that actually holds those values.
 */
function resolvedPositiveFixture(
  tenantId: string,
  branchName: string,
  resolvedById: string,
): PollFixture {
  const base = pendingFixture(tenantId, branchName);
  return {
    expectedSnapshot: base.expectedSnapshot,
    data: {
      ...base.data,
      status: 'RESOLVED',
      version: 2,
      resolutionAction: HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE,
      restockDays: 3,
      resolutionRequestId: crypto.randomUUID(),
      resolvedAt: RESOLVED_AT,
      resolvedById,
      resolvedByActorId: REVIEWER_ACTOR_ID,
      resolvedByDisplayName: REVIEWER_DISPLAY_NAME,
      applicationOutcome: 'PROVIDER_ACCEPTED',
      applicationAttemptId: ATTEMPT_ID,
      applicationEvidenceHash: EVIDENCE_HASH,
      applicationEvidenceCode: EVIDENCE_CODE,
      providerMessageId: PROVIDER_MESSAGE_ID,
      providerAcceptedObservedAt: new Date(RESOLVED_AT.getTime() + 300_000),
      applicationAttemptedAt: new Date(RESOLVED_AT.getTime() + 60_000),
      ackReceivedAt: new Date(RESOLVED_AT.getTime() + 360_000),
    },
  };
}

/**
 * Valid `RESOLVED` negative fixture: the no-ETA action must OMIT `restockDays`,
 * and a `NULL` outcome keeps every outcome/evidence column `NULL`.
 */
function resolvedNegativeFixture(
  tenantId: string,
  branchName: string,
  resolvedById: string,
): PollFixture {
  const base = resolvedPositiveFixture(tenantId, branchName, resolvedById);
  return {
    expectedSnapshot: base.expectedSnapshot,
    data: {
      ...base.data,
      resolutionAction: HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE,
      restockDays: null,
      applicationOutcome: null,
      applicationAttemptId: null,
      applicationEvidenceHash: null,
      applicationEvidenceCode: null,
      providerMessageId: null,
      providerAcceptedObservedAt: null,
      applicationAttemptedAt: null,
      ackReceivedAt: null,
    },
  };
}

/** Persist one fixture and return its id. */
async function seedDecision(
  data: Prisma.HumanDecisionUncheckedCreateInput,
): Promise<string> {
  const row = await integrationPrisma().humanDecision.create({ data });
  return row.id;
}

/** Read a persisted row expected to exist, without a non-null assertion. */
async function persistedRow(id: string) {
  const row = await integrationPrisma().humanDecision.findUnique({
    where: { id },
  });
  if (!row) {
    throw new Error(`[hd-05a2b] expected persisted decision ${id} to exist`);
  }
  return row;
}

/**
 * Convert a poll read record into the intake receipt mapper's input. The
 * receipt mapper ignores the mutable `status`/`version`, so the ACTUAL
 * persisted (`RESOLVED`/2) values are passed on purpose.
 */
function toPersistedDecision(
  record: BotRestockPollRecord,
  canonicalRequestHash: string,
): PersistedRestockDecision {
  return {
    id: record.id,
    source: RESTOCK_SOURCE,
    sourceRequestId: record.sourceRequestId,
    type: RESTOCK_TYPE,
    canonicalRequestHash,
    status: record.status as PersistedRestockDecisionStatus,
    version: record.version,
    supersedesDecisionId: record.supersedesDecisionId,
    createdAt: record.createdAt,
    snapshot: record.snapshot,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeIfDb(
  'PrismaBotRestockPollRepository (HD-05a2b PostgreSQL integration)',
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
      repo = new PrismaBotRestockPollRepository(tenantPrisma);
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
          expect(message).toContain('[hd-05a2b]');
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

    describe('findById — PENDING current state', () => {
      it('returns the exact selected PENDING row and never a same-source/foreign-source decoy', async () => {
        const tenantId = await seedTenant('Poll Tenant A');
        const branchName = 'Poll Tenant A';
        const selected = pendingFixture(tenantId, branchName, {
          supersedesDecisionId: SUPERSEDES_ID,
        });
        const sameSourceDecoy = pendingFixture(tenantId, branchName);
        const foreignSource = pendingFixture(tenantId, branchName, {
          source: 'other-bot-source',
        });

        const selectedId = await seedDecision(selected.data);
        const decoyId = await seedDecision(sameSourceDecoy.data);
        const foreignId = await seedDecision(foreignSource.data);

        const record = await readOrFail(tenantId, selectedId);

        expect(record).toEqual({
          id: selectedId,
          sourceRequestId: selected.data.sourceRequestId,
          type: RESTOCK_TYPE,
          status: 'PENDING',
          version: 1,
          createdAt: CREATED_AT,
          snapshot: selected.expectedSnapshot,
          supersedesDecisionId: SUPERSEDES_ID,
          resolutionAction: null,
          restockDays: null,
          resolvedAt: null,
        });
        // The row actually selected is the requested one, not a decoy.
        expect(record.id).not.toBe(decoyId);
        expect(record.id).not.toBe(foreignId);
        // Real DB: exactly the 11 record keys and 9 snapshot keys.
        expect(Object.keys(record).sort()).toEqual(POLL_RECORD_KEYS);
        expect(Object.keys(record.snapshot).sort()).toEqual(SNAPSHOT_KEYS);

        // Non-vacuous: all three rows ARE committed in the dedicated DB, and
        // the two decoys differ from the selected row in the pinned dimensions.
        await expect(
          integrationPrisma().humanDecision.count({ where: { tenantId } }),
        ).resolves.toBe(3);
        await expect(persistedRow(decoyId)).resolves.toMatchObject({
          id: decoyId,
          tenantId,
          source: RESTOCK_SOURCE,
          type: RESTOCK_TYPE,
          status: 'PENDING',
        });
        await expect(persistedRow(foreignId)).resolves.toMatchObject({
          id: foreignId,
          tenantId,
          source: 'other-bot-source',
          type: RESTOCK_TYPE,
          status: 'PENDING',
        });
      });

      it('maps the persisted PENDING row to the current-state projection (null resolution and applyBefore)', async () => {
        const tenantId = await seedTenant('Poll Tenant B');
        const branchName = 'Poll Tenant B';
        const fixture = pendingFixture(tenantId, branchName, {
          supersedesDecisionId: SUPERSEDES_ID,
        });
        const id = await seedDecision(fixture.data);

        const response = toBotRestockPollResponse(
          await readOrFail(tenantId, id),
        );

        expect(response).toEqual({
          id,
          sourceRequestId: fixture.data.sourceRequestId,
          type: RESTOCK_TYPE,
          status: 'PENDING',
          version: 1,
          createdAt: CREATED_AT.toISOString(),
          snapshot: {
            ...fixture.expectedSnapshot,
            stockObservedAt: OBSERVED_AT.toISOString(),
          },
          supersedesDecisionId: SUPERSEDES_ID,
          resolution: null,
          applyBefore: null,
        });
        expect(Object.keys(response).sort()).toEqual(RESPONSE_KEYS);
        expect(Object.keys(response.snapshot).sort()).toEqual(SNAPSHOT_KEYS);
      });
    });

    describe('findById — RESOLVED current state', () => {
      it('returns the RESOLVED positive row and excludes every reviewer/audit/provider/outcome column the DB holds', async () => {
        const tenantId = await seedTenant('Poll Tenant C');
        const branchName = 'Poll Tenant C';
        const reviewerId = await seedReviewerUser();
        const fixture = resolvedPositiveFixture(
          tenantId,
          branchName,
          reviewerId,
        );
        const id = await seedDecision(fixture.data);

        const record = await readOrFail(tenantId, id);

        expect(record).toMatchObject({
          id,
          type: RESTOCK_TYPE,
          status: 'RESOLVED',
          version: 2,
          createdAt: CREATED_AT,
          supersedesDecisionId: null,
          resolutionAction: HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE,
          restockDays: 3,
        });
        expect(record.resolvedAt?.toISOString()).toBe(
          RESOLVED_AT.toISOString(),
        );
        expect(record.snapshot).toEqual(fixture.expectedSnapshot);

        // Exact top-level and snapshot keysets; no forbidden key may appear.
        expect(Object.keys(record).sort()).toEqual(POLL_RECORD_KEYS);
        expect(Object.keys(record.snapshot).sort()).toEqual(SNAPSHOT_KEYS);
        for (const forbidden of FORBIDDEN_RECORD_KEYS) {
          expect(record).not.toHaveProperty(forbidden);
        }
        // The adapter's real SELECT allowlist is exactly 19 columns.
        expect(Object.keys(BOT_POLL_RECORD_SELECT).sort()).toEqual(SELECT_KEYS);
        for (const forbidden of FORBIDDEN_SELECT_KEYS) {
          expect(BOT_POLL_RECORD_SELECT).not.toHaveProperty(forbidden);
        }

        // The forbidden values ARE persisted; the projection still omits them.
        const row = await persistedRow(id);
        expect(row.resolvedById).toBe(reviewerId);
        expect(row.tenantId).toBe(tenantId);
        expect(row.source).toBe(RESTOCK_SOURCE);
        expect(row.canonicalRequestHash).toBe(CANONICAL_HASH);
        expect(row.submittedCredentialId).toBe(CREDENTIAL_ID);
        expect(row.resolvedByActorId).toBe(REVIEWER_ACTOR_ID);
        expect(row.resolvedByDisplayName).toBe(REVIEWER_DISPLAY_NAME);
        expect(row.applicationOutcome).toBe('PROVIDER_ACCEPTED');
        expect(row.applicationAttemptId).toBe(ATTEMPT_ID);
        expect(row.applicationEvidenceHash).toBe(EVIDENCE_HASH);
        expect(row.applicationEvidenceCode).toBe(EVIDENCE_CODE);
        expect(row.providerMessageId).toBe(PROVIDER_MESSAGE_ID);
        expect(row.ackReceivedAt).not.toBeNull();

        // `snapshot.branchId` intentionally IS the tenant-derived branch id, so
        // the tenant id may legitimately appear inside the snapshot; the proof
        // here is the ABSENCE of the tenant key and of every OTHER forbidden
        // value. The tenant id is still asserted absent as a top-level key.
        const serialized = JSON.stringify(record);
        for (const forbiddenValue of [
          RESTOCK_SOURCE,
          CANONICAL_HASH,
          CREDENTIAL_ID,
          REVIEWER_ACTOR_ID,
          REVIEWER_DISPLAY_NAME,
          ATTEMPT_ID,
          EVIDENCE_HASH,
          EVIDENCE_CODE,
          PROVIDER_MESSAGE_ID,
          row.resolutionRequestId ?? '',
        ]) {
          expect(serialized).not.toContain(forbiddenValue);
        }
      });

      it('maps the RESOLVED positive row to the exact current state with a UTC applyBefore', async () => {
        const tenantId = await seedTenant('Poll Tenant D');
        const branchName = 'Poll Tenant D';
        const reviewerId = await seedReviewerUser();
        const fixture = resolvedPositiveFixture(
          tenantId,
          branchName,
          reviewerId,
        );
        const id = await seedDecision(fixture.data);

        const response = toBotRestockPollResponse(
          await readOrFail(tenantId, id),
        );

        expect(response).toEqual({
          id,
          sourceRequestId: fixture.data.sourceRequestId,
          type: RESTOCK_TYPE,
          status: 'RESOLVED',
          version: 2,
          createdAt: CREATED_AT.toISOString(),
          snapshot: {
            ...fixture.expectedSnapshot,
            stockObservedAt: OBSERVED_AT.toISOString(),
          },
          supersedesDecisionId: null,
          resolution: {
            action: HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE,
            restockDays: 3,
            resolvedAt: RESOLVED_AT.toISOString(),
          },
          applyBefore: RESOLVED_PLUS_1H_ISO,
        });
        expect(Object.keys(response).sort()).toEqual(RESPONSE_KEYS);
        // `applyBefore` is the half-open hour deadline as canonical UTC ISO.
        expect(response.applyBefore).toBe(RESOLVED_PLUS_1H_ISO);
        expect(response.applyBefore?.endsWith('Z')).toBe(true);

        // No reviewer/audit/provider value survives the projection.
        const serialized = JSON.stringify(response);
        expect(serialized).not.toContain(REVIEWER_ACTOR_ID);
        expect(serialized).not.toContain(REVIEWER_DISPLAY_NAME);
        expect(serialized).not.toContain(ATTEMPT_ID);
        expect(serialized).not.toContain(PROVIDER_MESSAGE_ID);
        expect(serialized).not.toContain(CANONICAL_HASH);
      });

      it('maps the RESOLVED negative row without fabricating restockDays', async () => {
        const tenantId = await seedTenant('Poll Tenant E');
        const branchName = 'Poll Tenant E';
        const reviewerId = await seedReviewerUser();
        const fixture = resolvedNegativeFixture(
          tenantId,
          branchName,
          reviewerId,
        );
        const id = await seedDecision(fixture.data);

        const record = await readOrFail(tenantId, id);
        const response = toBotRestockPollResponse(record);

        expect(record.status).toBe('RESOLVED');
        expect(record.resolutionAction).toBe(
          HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE,
        );
        expect(record.restockDays).toBeNull();

        expect(response.status).toBe('RESOLVED');
        expect(response.resolution).toEqual({
          action: HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE,
          resolvedAt: RESOLVED_AT.toISOString(),
        });
        // The negative variant OMITS `restockDays` entirely (never `null`).
        expect(response.resolution).not.toHaveProperty('restockDays');
        expect(response.applyBefore).toBe(RESOLVED_PLUS_1H_ISO);
      });

      it('keeps the immutable POST receipt PENDING after the persisted decision was resolved', async () => {
        const tenantId = await seedTenant('Receipt Tenant');
        const branchName = 'Receipt Tenant';
        const reviewerId = await seedReviewerUser();
        const fixture = resolvedPositiveFixture(
          tenantId,
          branchName,
          reviewerId,
        );
        const id = await seedDecision(fixture.data);

        const record = await readOrFail(tenantId, id);
        const row = await persistedRow(id);

        // The committed receipt mapper, fed by the CONVERTED persisted row,
        // still reports the immutable intake view.
        const receipt = toBotRestockIntakeResponse(
          toPersistedDecision(record, row.canonicalRequestHash),
        );

        expect(receipt.status).toBe('PENDING');
        expect(receipt.version).toBe(1);
        expect(receipt.resolution).toBeNull();
        expect(receipt.applyBefore).toBeNull();
        // Same immutable identity and snapshot as the resolved current-state
        // read: the receipt is a historical view, not the current decision.
        expect(receipt.id).toBe(record.id);
        expect(receipt.sourceRequestId).toBe(record.sourceRequestId);
        expect(receipt.createdAt).toBe(record.createdAt.toISOString());
        expect(receipt.supersedesDecisionId).toBe(record.supersedesDecisionId);
        expect(receipt.snapshot).toEqual({
          ...fixture.expectedSnapshot,
          stockObservedAt: OBSERVED_AT.toISOString(),
        });

        // Non-vacuous: the persisted row really is RESOLVED/version 2, so the
        // PENDING receipt above is the immutable projection, not the DB state.
        expect(row.status).toBe('RESOLVED');
        expect(row.version).toBe(2);
        expect(toBotRestockPollResponse(record).status).toBe('RESOLVED');
      });
    });

    describe('indistinguishable nulls and the pinned predicate', () => {
      it('returns null for missing, cross-tenant, foreign-source and EXPIRATION ids while the rows exist', async () => {
        const tenantA = await seedTenant('Miss Tenant A');
        const tenantB = await seedTenant('Miss Tenant B');
        const crossTenantId = await seedDecision(
          pendingFixture(tenantB, 'Miss Tenant B').data,
        );
        const foreignSourceId = await seedDecision(
          pendingFixture(tenantA, 'Miss Tenant A', {
            source: 'other-bot-source',
          }).data,
        );
        // Dormant same-tenant/source PENDING EXPIRATION row: only the type pin
        // excludes it, and every RESTOCK-only snapshot column is NULL.
        const expirationId = await seedDecision(
          pendingFixture(tenantA, 'Miss Tenant A', {
            type: HumanDecisionType.EXPIRATION,
            productUnit: 'UNIDAD',
            sku: null,
            requestedQuantity: null,
            observedStockAtRequest: null,
            stockObservedAt: null,
          }).data,
        );
        const missingId = crypto.randomUUID();

        await expect(
          withTenant(tenantA, () => repo.findById(missingId)),
        ).resolves.toBeNull();
        await expect(
          withTenant(tenantA, () => repo.findById(crossTenantId)),
        ).resolves.toBeNull();
        await expect(
          withTenant(tenantA, () => repo.findById(foreignSourceId)),
        ).resolves.toBeNull();
        await expect(
          withTenant(tenantA, () => repo.findById(expirationId)),
        ).resolves.toBeNull();

        // The cross-tenant id DOES resolve for its owning tenant: the null
        // above is tenant scope, not a missing row.
        await expect(
          withTenant(tenantB, () => repo.findById(crossTenantId)),
        ).resolves.toMatchObject({ id: crossTenantId, status: 'PENDING' });

        // Non-vacuous: both rows are committed in the dedicated DB.
        await expect(persistedRow(crossTenantId)).resolves.toMatchObject({
          id: crossTenantId,
          tenantId: tenantB,
          source: RESTOCK_SOURCE,
          type: RESTOCK_TYPE,
        });
        await expect(persistedRow(foreignSourceId)).resolves.toMatchObject({
          id: foreignSourceId,
          tenantId: tenantA,
          source: 'other-bot-source',
          type: RESTOCK_TYPE,
        });
        await expect(persistedRow(expirationId)).resolves.toMatchObject({
          id: expirationId,
          tenantId: tenantA,
          source: RESTOCK_SOURCE,
          type: HumanDecisionType.EXPIRATION,
          productUnit: 'UNIDAD',
        });

        // Same tenant/source, so only the `type` dimension explains its null.
      });
    });

    describe('tenant context fail-closed', () => {
      it('throws before building a scoped client for a tenantless session, including the superadmin bypass shape', async () => {
        const tenantA = await seedTenant('Context Tenant A');
        const tenantB = await seedTenant('Context Tenant B');
        const idA = await seedDecision(
          pendingFixture(tenantA, 'Context Tenant A').data,
        );
        const idB = await seedDecision(
          pendingFixture(tenantB, 'Context Tenant B').data,
        );

        const getClientSpy = jest.spyOn(tenantPrisma, 'getClient');
        try {
          await expect(
            withSession(null, false, () => repo.findById(idA)),
          ).rejects.toThrow('Tenant context required');
          await expect(
            withSession(null, true, () => repo.findById(idA)),
          ).rejects.toThrow('Tenant context required');
          // The tenant gate resolved BEFORE the scoped client (and therefore
          // any query) was ever built, even for the superadmin session shape.
          expect(getClientSpy).not.toHaveBeenCalled();
        } finally {
          getClientSpy.mockRestore();
        }

        // No ambient ALS context leaks outside an explicit `runWith` scope.
        expect(cls.isActive()).toBe(false);

        // The superadmin/no-tenant bypass IS real for the tenant extension, so
        // the adapter's unconditional `getTenantId()` is the actual gate. The
        // callback MUST await the query INSIDE the ALS scope: Prisma defers
        // the query-extension callback until `.then`, so returning the bare
        // promise would run it after `runWith` has already exited the context.
        const unscoped = await withSession(null, true, async () =>
          tenantPrisma.getClient().humanDecision.findMany({ where: {} }),
        );
        expect(unscoped.map((row) => row.id).sort()).toEqual([idA, idB].sort());
        expect(unscoped.map((row) => row.tenantId).sort()).toEqual(
          [tenantA, tenantB].sort(),
        );
      });
    });

    describe('real ALS isolation', () => {
      it('keeps two simultaneous tenant A/B ALS reads disjoint and correctly scoped', async () => {
        const tenantA = await seedTenant('Als Tenant A');
        const tenantB = await seedTenant('Als Tenant B');
        const idA = await seedDecision(
          pendingFixture(tenantA, 'Als Tenant A').data,
        );
        const idB = await seedDecision(
          pendingFixture(tenantB, 'Als Tenant B').data,
        );

        // Both `runWith` scopes are opened before either awaits the barrier, so
        // the two ALS contexts are provably live and interleaved at once.
        let releaseBarrier: () => void = () => {};
        const barrier = new Promise<void>((resolve) => {
          releaseBarrier = resolve;
        });
        let arrived = 0;

        const runRead = (tenantId: string, id: string) =>
          withTenant(tenantId, async () => {
            const observedTenantId = cls.get('tenantId');
            arrived += 1;
            if (arrived === 2) {
              releaseBarrier();
            }
            await barrier;
            const record = await repo.findById(id);
            return { observedTenantId, record };
          });

        const [fromA, fromB] = await Promise.all([
          runRead(tenantA, idA),
          runRead(tenantB, idB),
        ]);

        expect(fromA.observedTenantId).toBe(tenantA);
        expect(fromB.observedTenantId).toBe(tenantB);
        expect(fromA.record?.id).toBe(idA);
        expect(fromB.record?.id).toBe(idB);
        expect(fromA.record?.snapshot.branchId).toBe(tenantA);
        expect(fromB.record?.snapshot.branchId).toBe(tenantB);

        // Non-vacuous: both rows are committed in the same dedicated DB.
        await expect(integrationPrisma().humanDecision.count()).resolves.toBe(
          2,
        );
      });
    });
  },
);
