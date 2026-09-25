/**
 * HD-05a4 — bot RESTOCK poll HTTP route against REAL PostgreSQL + REAL CLS ALS.
 *
 * Contract (read-only):
 * `houndfe-chatbot-human-decisions/docs/human-decisions-contract-v1.md`
 * ("Historical POST vs current GET").
 *
 * What this spec proves that neither the DB-free HTTP spec
 * (`bot-restock-poll.controller.http.spec.ts`) nor the DB-free/DB-backed poll
 * adapter specs can prove on their own: the uncommitted `BotRestockPollController`
 * (`GET /chatbot-api/human-decisions/:id`) runs end to end through the REAL
 * production chain and a real database —
 *
 *   Supertest → real `HumanDecisionHttpFilter` (controller-scoped) →
 *   real `ServiceAuthGuard` (SHA-256 hashes the bearer token against the REAL
 *   `PrismaServiceCredentialRepository`, i.e. committed `service_credentials`
 *   rows) → real nestjs-cls `ClsService` ALS store opened by
 *   `ClsModule.forRoot({ middleware: { mount: true } })` →
 *   real `PrismaBotRestockPollRepository` → real `TenantPrismaService`
 *   (CLS-driven `tenantId` WHERE injection) → real `PrismaService` →
 *   committed `HumanDecision` rows in the dedicated isolated test database.
 *
 * Deliberately NOT booted: the full `AppModule` (or `HumanDecisionsModule` /
 * `ChatbotApiModule`), because their transitive imports pull Inngest / mail /
 * provider / outbox registrars. This spec assembles a minimal Nest
 * `TestingModule` with ONLY the real pieces under test, plus `DatabaseModule`
 * (global `PrismaService` + `TenantPrismaService`) and the same global
 * `ValidationPipe`/filters that `main.ts` installs. The global
 * `DomainExceptionFilter`/`PrismaExceptionFilter` are REAL so the scoped
 * filter's precedence over them is exercised, not assumed. Module wiring (the
 * poll controller registration and the `BOT_RESTOCK_POLL_REPOSITORY` →
 * `PrismaBotRestockPollRepository` binding) is pinned by module METADATA in the
 * DB-free HTTP spec and is NOT re-booted here.
 *
 * Deliberately mocked (and only this): nothing. There is NO mocked credential
 * repository, NO mocked poll port and NO `ClsService` Map shim. Credentials are
 * seeded as real `service_credentials` rows and hashed by the real guard.
 *
 * NO provider, bot, device, mail, Inngest or listen port is started
 * (`app.init()` only): this spec makes NO claim about provider acceptance,
 * device delivery, stock mutation, the human resolve route or the full
 * application graph.
 *
 * THROTTLER DISCLOSURE: there is NO Nest `ThrottlerModule`/`ThrottlerGuard`
 * anywhere in this repository, so no global HTTP throttler exists in the
 * selected graph. The ONLY 429 source is the REAL `ServiceAuthGuard`'s
 * in-memory `CredentialRateLimiter` (`retry-after` on rejection), and this spec
 * exercises it against real credentials/rows. If a global throttler is ever
 * introduced, this spec must grow the corresponding case.
 *
 * ISOLATED-DB GUARD: before every baseline reset (and at module load) the spec
 * validates BOTH the `.env.test` file parsed with the local `dotenv` AND the
 * ACTIVE `process.env.DATABASE_URL` that `resetAndSeedBaseline` / the Nest
 * `PrismaService` client actually use, aborting unless each resolves to exactly
 * `postgresql://127.0.0.1:5433/nest-practice-restock-test`. Mismatch errors are
 * generic and redacted: neither the raw URL nor its credentials or a
 * non-target database name is ever echoed; only the sanitized expected
 * destination is printed. `resetAndSeedBaseline()` (TRUNCATE `tenants`/`users`
 * CASCADE + re-seed) is authorized exclusively for this dedicated DB.
 *
 * CRITICAL: the integration Jest config runs `globalSetup` — which executes
 * `prisma migrate deploy` — BEFORE this spec module is evaluated. The in-spec
 * guard therefore CANNOT protect the migration step, and this suite must never
 * be the only destination check. Every invocation therefore requires the
 * separate pre-Jest destination precheck FIRST:
 *
 *   node -e 'const fs=require("node:fs"),dotenv=require("dotenv");const e=dotenv.parse(fs.readFileSync(".env.test"));const u=new URL(e.DATABASE_URL);if(u.protocol!=="postgresql:"||u.hostname!=="127.0.0.1"||u.port!=="5433"||decodeURIComponent(u.pathname.slice(1))!=="nest-practice-restock-test")process.exit(1);console.log("dedicated RESTOCK test DB destination verified")'
 *
 * only then:
 *
 *   pnpm exec jest --config jest.integration.config.js --runInBand \
 *     --runTestsByPath \
 *     src/human-decisions/presentation/bot-restock-poll.controller.integration.spec.ts \
 *     --silent
 *
 * SCOPED "NO POLL READ" PROOF — NOT "NO DB TRAFFIC": the spec wraps the REAL
 * `PrismaBotRestockPollRepository.findById` instance method in a call-through
 * `jest.spyOn` (it never replaces the implementation, so adapter/DB behavior is
 * untouched). A 400/401/403 assertion that the spy recorded ZERO calls means
 * the route never reached the POLL DECISION read (the `human_decisions` SELECT);
 * it does NOT mean the request issued no database query or no write. On a
 * rejected id the REAL `ServiceAuthGuard` has ALREADY, and successfully, run its
 * own `service_credentials` SELECT and `lastUsedAt` UPDATE — it only reaches the
 * handler after authenticating — and the id-rejection test asserts that UPDATE
 * explicitly. The raw-SQL count therefore proves ONLY that the `human_decisions`
 * row cardinality is unchanged; it is NOT a global no-mutation claim.
 *
 * Skip guard: `SKIP_DB_INTEGRATION=1` or an unset `DATABASE_URL` skips the
 * whole suite, matching the other integration specs.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Prisma } from '@prisma/client';
import * as dotenv from 'dotenv';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ClsModule, ClsService } from 'nestjs-cls';
import request from 'supertest';
import {
  disconnectIntegrationPrisma,
  integrationPrisma,
  resetAndSeedBaseline,
} from '../../../test/integration/reset-db';
import { SERVICE_CREDENTIAL_REPOSITORY } from '../../chatbot-api/domain/service-credential.repository';
import { ServiceAuthGuard } from '../../chatbot-api/presentation/guards/service-auth.guard';
import { PrismaServiceCredentialRepository } from '../../chatbot-api/infrastructure/prisma-service-credential.repository';
import { DomainExceptionFilter } from '../../shared/filters/domain-exception.filter';
import { PrismaExceptionFilter } from '../../shared/filters/prisma-exception.filter';
import { createListingValidationExceptionFactory } from '../../shared/listing/listing-validation-exception.factory';
import { DatabaseModule } from '../../shared/prisma/prisma.module';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import {
  BOT_RESTOCK_POLL_REPOSITORY,
  type BotRestockPollRecord,
  type BotRestockPollSnapshotRecord,
} from '../domain/bot-restock-poll.repository';
import {
  HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE,
  HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE,
} from '../domain/human-decision-review-resolve.repository';
import {
  RESTOCK_SOURCE,
  RESTOCK_TYPE,
} from '../domain/restock-request-canonicalizer';
import { PrismaBotRestockPollRepository } from '../infrastructure/prisma-bot-restock-poll.repository';
import { BotRestockPollController } from './bot-restock-poll.controller';
import { HumanDecisionHttpFilter } from './filters/human-decision-http.filter';

const URL = '/chatbot-api/human-decisions';

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
      `[hd-05a4] refusing isolated-DB run: ${SOURCE_LABELS[source]} DATABASE_URL is unset.`,
    );
  }

  let url: globalThis.URL;
  try {
    url = new globalThis.URL(rawUrl);
  } catch {
    throw new Error(
      `[hd-05a4] refusing isolated-DB run: ${SOURCE_LABELS[source]} DATABASE_URL is not a valid URL.`,
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
      `[hd-05a4] refusing isolated-DB run: ${SOURCE_LABELS[source]} DATABASE_URL does not match the dedicated isolated RESTOCK target.`,
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
      `[hd-05a4] isolated DB target OK: ${EXPECTED_PROTOCOL}//${EXPECTED_HOSTNAME}:${EXPECTED_PORT}/${EXPECTED_DATABASE}`,
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
// Constants and fixtures
// ---------------------------------------------------------------------------

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

/** The exact 10 top-level keys of the bot poll response body, sorted. */
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

/** The exact 3-key sanitized error envelope, sorted. */
const ERROR_KEYS = ['code', 'message', 'statusCode'];

/**
 * Reviewer / authority / provider / outcome columns that must NEVER reach the
 * poll response. The adapter's SELECT keyset is already pinned by the adapter
 * spec; here the same keys are asserted absent from the HTTP BODY (and its
 * nested objects) while the real DB row HOLDS those values.
 */
const FORBIDDEN_RESPONSE_KEYS = [
  'source',
  'tenantId',
  'canonicalRequestHash',
  'submittedCredentialId',
  'resolutionRequestId',
  'resolvedBy',
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
  'updatedAt',
];

const UNAUTHORIZED_BODY = {
  statusCode: 401,
  code: 'UNAUTHORIZED',
  message: 'Unauthorized',
};
const FORBIDDEN_BODY = {
  statusCode: 403,
  code: 'FORBIDDEN',
  message: 'Forbidden',
};
const NOT_FOUND_BODY = {
  statusCode: 404,
  code: 'NOT_FOUND',
  message: 'Not found',
};
const VALIDATION_BODY = {
  statusCode: 400,
  code: 'VALIDATION_ERROR',
  message: 'Invalid request',
};
const RATE_LIMITED_BODY = {
  statusCode: 429,
  code: 'RATE_LIMITED',
  message: 'Too many requests',
};

/**
 * Fixed, distinctive persisted values. Each is echoed nowhere in the poll
 * response, so a serialized-body search proves the projection exclusion.
 */
const SUBMITTED_CREDENTIAL_ID = 'cred-intake-hd-05a4';
const CANONICAL_HASH = 'canonical-hash-hd-05a4';
const REVIEWER_ACTOR_ID = 'reviewer-actor-hd-05a4';
const REVIEWER_DISPLAY_NAME = 'Hd05a4 Reviewer';
const ATTEMPT_ID = 'attempt-hd-05a4';
const EVIDENCE_HASH = 'evidence-hash-hd-05a4';
const EVIDENCE_CODE = 'evidence-code-hd-05a4';
const PROVIDER_MESSAGE_ID = 'provider-message-hd-05a4';

const PRODUCT_NAME = 'Cafe de altura';
const SKU = 'SKU-1';
const REQUESTED_QUANTITY = 5;
const OBSERVED_STOCK = 0;
const CREATED_AT = new Date('2026-09-30T10:00:00.000Z');
const OBSERVED_AT = new Date('2026-09-30T09:30:00.000Z');
const RESOLVED_AT = new Date('2026-09-30T12:00:00.000Z');
const APPLY_BEFORE_ISO = new Date(
  RESOLVED_AT.getTime() + 3_600_000,
).toISOString();

/**
 * A canonical RFC 4122 v4 lowercase id WITH letters, so its uppercase form is
 * provably different and can pin the route-local uppercase rejection while the
 * lowercase row really exists.
 */
const CANONICAL_ID = '2b7c1a90-6f3e-4d2a-8b1c-0d9e8f7a6b5c';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const MALFORMED_ID = 'not-a-uuid';

interface PollFixture {
  data: Prisma.HumanDecisionUncheckedCreateInput;
  expectedSnapshot: BotRestockPollSnapshotRecord;
}

/** One explicit tenant per test; the baseline tenant is never reused. */
async function seedTenant(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await integrationPrisma().tenant.create({
    data: { id, name, slug: `hd05a4-${id}` },
  });
  return id;
}

interface SeededCredential {
  id: string;
  token: string;
}

/**
 * Seed a REAL `service_credentials` row for `tenantId`. The real guard hashes
 * the returned token and resolves this row through the real
 * `PrismaServiceCredentialRepository`; nothing about the credential chain is
 * mocked.
 */
async function seedCredential(params: {
  tenantId: string;
  scopes?: string[];
  isActive?: boolean;
  revokedAt?: Date | null;
  rateLimit?: number;
}): Promise<SeededCredential> {
  const token = `svc_${crypto.randomUUID().replace(/-/g, '')}`;
  const row = await integrationPrisma().serviceCredential.create({
    data: {
      tenantId: params.tenantId,
      name: 'HD-05a4 poll bot',
      hashedKey: createHash('sha256').update(token).digest('hex'),
      scopes: params.scopes ?? ['human-decisions:read'],
      isActive: params.isActive ?? true,
      revokedAt: params.revokedAt ?? null,
      rateLimit: params.rateLimit ?? 60,
    },
  });
  return { id: row.id, token };
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
      email: `hd05a4-${id}@example.test`,
      hashedPassword: 'not-a-real-password-hash',
      name: REVIEWER_DISPLAY_NAME,
    },
  });
  return id;
}

/**
 * Valid PENDING fixture: status/version defaults plus the immutable intake
 * snapshot. `productId`/`sourceRequestId` are canonical RFC 4122 UUIDs so the
 * committed mapper accepts the persisted row without normalizing anything.
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
    submittedCredentialId: SUBMITTED_CREDENTIAL_ID,
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
    throw new Error(`[hd-05a4] expected persisted decision ${id} to exist`);
  }
  return row;
}

/**
 * Raw-SQL decision-row count only; it does not establish unchanged row contents
 * or absence of credential audit writes. Deliberately independent of repository
 * helpers and the tenant-scoping extension.
 */
async function rawDecisionCount(): Promise<bigint> {
  const rows = await integrationPrisma().$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*) AS count FROM human_decisions
  `;
  return rows[0].count;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeIfDb('Bot restock poll HTTP → PostgreSQL integration (HD-05a4)', () => {
  let app: INestApplication;
  let cls: ClsService<TenantClsStore>;
  let pollRepo: PrismaBotRestockPollRepository;
  let findByIdSpy: jest.SpyInstance<
    Promise<BotRestockPollRecord | null>,
    [string]
  >;

  const http = () => request(app.getHttpServer() as import('node:http').Server);

  const get = (id: string, token: string | null) => {
    const builder = http().get(`${URL}/${id}`);
    return token ? builder.set('Authorization', `Bearer ${token}`) : builder;
  };

  beforeAll(async () => {
    await resetIsolatedBaseline();

    const moduleRef = await Test.createTestingModule({
      imports: [
        // REAL nestjs-cls with the express middleware mount: the guard writes
        // the trusted `tenantId` into the per-request ALS store and the real
        // `TenantPrismaService` reads it back for the WHERE injection. No Map
        // shim anywhere.
        ClsModule.forRoot({
          global: true,
          middleware: { mount: true },
        }),
        // REAL global Prisma + TenantPrisma providers.
        DatabaseModule,
      ],
      controllers: [BotRestockPollController],
      providers: [
        HumanDecisionHttpFilter,
        ServiceAuthGuard,
        {
          provide: SERVICE_CREDENTIAL_REPOSITORY,
          useClass: PrismaServiceCredentialRepository,
        },
        {
          provide: BOT_RESTOCK_POLL_REPOSITORY,
          useClass: PrismaBotRestockPollRepository,
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    // Mirror `main.ts` exactly: global ValidationPipe (whitelist + forbid
    // non-whitelisted + transform) and the two global filters. The
    // controller-scoped HumanDecisionHttpFilter must still win.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        exceptionFactory: createListingValidationExceptionFactory(),
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new PrismaExceptionFilter(),
    );

    await app.init();

    cls = app.get<ClsService<TenantClsStore>>(ClsService);
    pollRepo = app.get<PrismaBotRestockPollRepository>(
      BOT_RESTOCK_POLL_REPOSITORY,
    );
  });

  beforeEach(() => {
    // Call-through spy on the REAL adapter instance: the implementation is
    // never replaced, so the adapter/DB behavior is untouched. It records ONLY
    // whether the route reached the poll DECISION read; it says nothing about
    // the real guard's own credential SELECT/UPDATE, so every "no query" claim
    // below is scoped to `PrismaBotRestockPollRepository.findById`.
    findByIdSpy = jest.spyOn(pollRepo, 'findById');
  });

  afterEach(async () => {
    findByIdSpy.mockRestore();
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

        // No Prisma client is re-constructed while the env is mismatched: the
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
        expect(message).toContain('[hd-05a4]');
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

  describe('GET :id — PENDING current state over real PostgreSQL', () => {
    it('returns the exact 10/9-key PENDING projection with no-store and never a same-source/foreign-source decoy', async () => {
      const tenantId = await seedTenant('Poll HTTP Tenant A');
      const credential = await seedCredential({ tenantId });
      const fixture = pendingFixture(tenantId, 'Poll HTTP Tenant A');
      const id = await seedDecision(fixture.data);
      const sameSourceDecoyId = await seedDecision(
        pendingFixture(tenantId, 'Poll HTTP Tenant A').data,
      );
      const foreignSourceId = await seedDecision(
        pendingFixture(tenantId, 'Poll HTTP Tenant A', {
          source: 'other-bot-source',
        }).data,
      );

      const res = await get(id, credential.token).expect(200);
      const body = res.body as Record<string, unknown>;

      expect(body).toEqual({
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
        supersedesDecisionId: null,
        resolution: null,
        applyBefore: null,
      });
      expect(Object.keys(body).sort()).toEqual(RESPONSE_KEYS);
      expect(Object.keys(body.snapshot as object).sort()).toEqual(
        SNAPSHOT_KEYS,
      );
      // The poll is mutable current state: never cached.
      expect(res.headers['cache-control']).toBe('no-store');
      // The selected row is the requested one, not a decoy.
      expect(body.id).not.toBe(sameSourceDecoyId);
      expect(body.id).not.toBe(foreignSourceId);
      expect(findByIdSpy).toHaveBeenCalledTimes(1);
      expect(findByIdSpy).toHaveBeenCalledWith(id);

      // Non-vacuous: all three rows ARE committed in the dedicated DB and the
      // two decoys differ from the selected row in the pinned dimensions.
      await expect(
        integrationPrisma().humanDecision.count({ where: { tenantId } }),
      ).resolves.toBe(3);
      await expect(persistedRow(sameSourceDecoyId)).resolves.toMatchObject({
        id: sameSourceDecoyId,
        tenantId,
        source: RESTOCK_SOURCE,
        status: 'PENDING',
      });
      await expect(persistedRow(foreignSourceId)).resolves.toMatchObject({
        id: foreignSourceId,
        tenantId,
        source: 'other-bot-source',
        status: 'PENDING',
      });
    });
  });

  describe('GET :id — RESOLVED current state over real PostgreSQL', () => {
    it('returns the exact RESOLVED positive projection with applyBefore = resolvedAt + 1h (UTC ISO)', async () => {
      const tenantId = await seedTenant('Poll HTTP Tenant B');
      const reviewerId = await seedReviewerUser();
      const credential = await seedCredential({ tenantId });
      const fixture = resolvedPositiveFixture(
        tenantId,
        'Poll HTTP Tenant B',
        reviewerId,
      );
      const id = await seedDecision(fixture.data);

      const res = await get(id, credential.token).expect(200);
      const body = res.body as Record<string, unknown>;

      expect(body).toEqual({
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
        applyBefore: APPLY_BEFORE_ISO,
      });
      expect(Object.keys(body).sort()).toEqual(RESPONSE_KEYS);
      expect(Object.keys(body.snapshot as object).sort()).toEqual(
        SNAPSHOT_KEYS,
      );
      expect(Object.keys(body.resolution as object).sort()).toEqual([
        'action',
        'resolvedAt',
        'restockDays',
      ]);
      expect(body.applyBefore).toBe(APPLY_BEFORE_ISO);
      expect((body.applyBefore as string).endsWith('Z')).toBe(true);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('never exposes reviewer identity, authority, credential or provider evidence the DB row holds', async () => {
      const tenantId = await seedTenant('Poll HTTP Tenant C');
      const reviewerId = await seedReviewerUser();
      const credential = await seedCredential({ tenantId });
      const fixture = resolvedPositiveFixture(
        tenantId,
        'Poll HTTP Tenant C',
        reviewerId,
      );
      const id = await seedDecision(fixture.data);

      const res = await get(id, credential.token).expect(200);
      const body = res.body as Record<string, unknown>;
      const snapshot = body.snapshot as Record<string, unknown>;
      const resolution = body.resolution as Record<string, unknown>;

      // Every forbidden key is absent from the body and both nested objects.
      for (const key of FORBIDDEN_RESPONSE_KEYS) {
        expect(body).not.toHaveProperty(key);
        expect(snapshot).not.toHaveProperty(key);
        expect(resolution).not.toHaveProperty(key);
      }

      // No forbidden VALUE survives either.
      const serialized = JSON.stringify(body);
      for (const forbiddenValue of [
        SUBMITTED_CREDENTIAL_ID,
        CANONICAL_HASH,
        REVIEWER_ACTOR_ID,
        REVIEWER_DISPLAY_NAME,
        ATTEMPT_ID,
        EVIDENCE_HASH,
        EVIDENCE_CODE,
        PROVIDER_MESSAGE_ID,
        RESTOCK_SOURCE,
      ]) {
        expect(serialized).not.toContain(forbiddenValue);
      }
      // The persisted row really holds them, so the omission is real.
      await expect(persistedRow(id)).resolves.toMatchObject({
        tenantId,
        source: RESTOCK_SOURCE,
        canonicalRequestHash: CANONICAL_HASH,
        submittedCredentialId: SUBMITTED_CREDENTIAL_ID,
        resolvedById: reviewerId,
        resolvedByActorId: REVIEWER_ACTOR_ID,
        resolvedByDisplayName: REVIEWER_DISPLAY_NAME,
        applicationOutcome: 'PROVIDER_ACCEPTED',
        applicationAttemptId: ATTEMPT_ID,
        applicationEvidenceHash: EVIDENCE_HASH,
        applicationEvidenceCode: EVIDENCE_CODE,
        providerMessageId: PROVIDER_MESSAGE_ID,
      });
    });

    it('returns the RESOLVED negative projection and OMITS restockDays entirely (never null)', async () => {
      const tenantId = await seedTenant('Poll HTTP Tenant D');
      const reviewerId = await seedReviewerUser();
      const credential = await seedCredential({ tenantId });
      const fixture = resolvedNegativeFixture(
        tenantId,
        'Poll HTTP Tenant D',
        reviewerId,
      );
      const id = await seedDecision(fixture.data);

      const res = await get(id, credential.token).expect(200);
      const body = res.body as Record<string, unknown>;
      const resolution = body.resolution as Record<string, unknown>;

      expect(body.status).toBe('RESOLVED');
      expect(body.version).toBe(2);
      expect(body.applyBefore).toBe(APPLY_BEFORE_ISO);
      expect(resolution).toEqual({
        action: HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE,
        resolvedAt: RESOLVED_AT.toISOString(),
      });
      expect(resolution).not.toHaveProperty('restockDays');
      expect(Object.keys(resolution).sort()).toEqual(['action', 'resolvedAt']);
      // Non-vacuous: the persisted resolution really is the negative one.
      await expect(persistedRow(id)).resolves.toMatchObject({
        status: 'RESOLVED',
        version: 2,
        resolutionAction: HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE,
        restockDays: null,
      });
    });
  });

  describe('GET :id — missing / cross-tenant / foreign-source are indistinguishable', () => {
    it('returns the identical fixed 404 body with no-store for a missing, a cross-tenant and a foreign-source id', async () => {
      const tenantA = await seedTenant('Poll HTTP Miss Tenant A');
      const tenantB = await seedTenant('Poll HTTP Miss Tenant B');
      const credentialA = await seedCredential({ tenantId: tenantA });
      // A real decision owned by another tenant, and a real row in tenant A
      // with a foreign source: both must be unreachable, but they exist.
      const crossTenantId = await seedDecision(
        pendingFixture(tenantB, 'Poll HTTP Miss Tenant B').data,
      );
      const foreignSourceId = await seedDecision(
        pendingFixture(tenantA, 'Poll HTTP Miss Tenant A', {
          source: 'other-bot-source',
        }).data,
      );
      const missingId = crypto.randomUUID();

      const missing = await get(missingId, credentialA.token).expect(404);
      const crossTenant = await get(crossTenantId, credentialA.token).expect(
        404,
      );
      const foreignSource = await get(
        foreignSourceId,
        credentialA.token,
      ).expect(404);

      expect(missing.body).toEqual(NOT_FOUND_BODY);
      expect(crossTenant.body).toEqual(NOT_FOUND_BODY);
      expect(foreignSource.body).toEqual(NOT_FOUND_BODY);
      expect(Object.keys(missing.body as object).sort()).toEqual(ERROR_KEYS);
      // The handler sets `no-store` BEFORE the port read, so a handler-level
      // miss (404) still carries it.
      expect(missing.headers['cache-control']).toBe('no-store');
      expect(crossTenant.headers['cache-control']).toBe('no-store');
      expect(foreignSource.headers['cache-control']).toBe('no-store');

      // The real adapter answered each request with a real DB no-match.
      expect(findByIdSpy).toHaveBeenCalledTimes(3);

      // Non-vacuous: both "foreign" rows ARE committed in the dedicated DB.
      await expect(persistedRow(crossTenantId)).resolves.toMatchObject({
        tenantId: tenantB,
        source: RESTOCK_SOURCE,
        status: 'PENDING',
      });
      await expect(persistedRow(foreignSourceId)).resolves.toMatchObject({
        tenantId: tenantA,
        source: 'other-bot-source',
        status: 'PENDING',
      });
    });
  });

  describe('GET :id — service credential authentication (401)', () => {
    it.each([
      ['a missing bearer token', null],
      ['a non-service bearer token', 'customer_jwt_token'],
      ['an unknown service token', 'svc_hd05a4_unknown'],
    ])(
      'returns the sanitized 401 for %s and never reaches the port',
      async (_label, token) => {
        const tenantId = await seedTenant('Poll HTTP 401 Tenant');
        const id = await seedDecision(
          pendingFixture(tenantId, 'Poll HTTP 401 Tenant').data,
        );

        const res = await get(id, token).expect(401);

        expect(res.body).toEqual(UNAUTHORIZED_BODY);
        expect(Object.keys(res.body as object).sort()).toEqual(ERROR_KEYS);
        expect(res.headers['cache-control']).toBeUndefined();
        expect(findByIdSpy).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['an inactive credential', { isActive: false }],
      [
        'a revoked credential',
        { revokedAt: new Date('2026-06-02T00:00:00.000Z') },
      ],
    ])('returns the sanitized 401 for %s', async (_label, overrides) => {
      const tenantId = await seedTenant('Poll HTTP 401 State Tenant');
      const credential = await seedCredential({ tenantId, ...overrides });
      const id = await seedDecision(
        pendingFixture(tenantId, 'Poll HTTP 401 State Tenant').data,
      );

      const res = await get(id, credential.token).expect(401);

      expect(res.body).toEqual(UNAUTHORIZED_BODY);
      expect(findByIdSpy).not.toHaveBeenCalled();
    });
  });

  describe('GET :id — service credential authorization (403)', () => {
    it('returns the sanitized 403 for a create-only credential and never reaches the port', async () => {
      const tenantId = await seedTenant('Poll HTTP 403 Scope Tenant');
      const credential = await seedCredential({
        tenantId,
        scopes: ['human-decisions:create'],
      });
      const id = await seedDecision(
        pendingFixture(tenantId, 'Poll HTTP 403 Scope Tenant').data,
      );

      const res = await get(id, credential.token).expect(403);

      expect(res.body).toEqual(FORBIDDEN_BODY);
      expect(Object.keys(res.body as object).sort()).toEqual(ERROR_KEYS);
      expect(JSON.stringify(res.body)).not.toContain(credential.id);
      expect(res.headers['cache-control']).toBeUndefined();
      expect(findByIdSpy).not.toHaveBeenCalled();
    });

    it('returns the sanitized 403 for a foreign x-branch-id and does not cross-read the other tenant row', async () => {
      const tenantA = await seedTenant('Poll HTTP Branch Tenant A');
      const tenantB = await seedTenant('Poll HTTP Branch Tenant B');
      const credentialA = await seedCredential({ tenantId: tenantA });
      const idB = await seedDecision(
        pendingFixture(tenantB, 'Poll HTTP Branch Tenant B').data,
      );

      // The credential pins tenant A; a foreign branch header is rejected
      // BEFORE the port, so tenant B's id can never be read.
      const foreignBranch = await http()
        .get(`${URL}/${idB}`)
        .set('Authorization', `Bearer ${credentialA.token}`)
        .set('x-branch-id', tenantB)
        .expect(403);

      expect(foreignBranch.body).toEqual(FORBIDDEN_BODY);
      expect(findByIdSpy).not.toHaveBeenCalled();

      // The SAME header pinned to the credential's own tenant is accepted,
      // proving the header value — not the header itself — drove the 403.
      const idA = await seedDecision(
        pendingFixture(tenantA, 'Poll HTTP Branch Tenant A').data,
      );
      await http()
        .get(`${URL}/${idA}`)
        .set('Authorization', `Bearer ${credentialA.token}`)
        .set('x-branch-id', tenantA)
        .expect(200);
      expect(findByIdSpy).toHaveBeenCalledWith(idA);
    });
  });

  describe('GET :id — caller-supplied tenant/source/type are ignored', () => {
    it('serves only the credential-tenant row despite query, header and body overrides', async () => {
      const tenantA = await seedTenant('Poll HTTP Override Tenant A');
      const tenantB = await seedTenant('Poll HTTP Override Tenant B');
      const credentialA = await seedCredential({ tenantId: tenantA });
      const idA = await seedDecision(
        pendingFixture(tenantA, 'Poll HTTP Override Tenant A').data,
      );
      const idB = await seedDecision(
        pendingFixture(tenantB, 'Poll HTTP Override Tenant B').data,
      );

      // Query-string overrides + a spurious JSON body + a FOREIGN branch
      // header alone is a 403 (proven above), so here only the tenant/source
      // query/body spoof is sent: the route must still serve tenant A.
      const res = await http()
        .get(`${URL}/${idA}`)
        .query({ tenantId: tenantB, source: 'evil-source', type: 'evil' })
        .set('Authorization', `Bearer ${credentialA.token}`)
        .send({ tenantId: tenantB, source: 'evil-source', type: 'evil' })
        .expect(200);

      const body = res.body as Record<string, unknown>;
      expect(body.id).toBe(idA);
      expect((body.snapshot as Record<string, unknown>).branchId).toBe(tenantA);
      expect((body.snapshot as Record<string, unknown>).branchName).toBe(
        'Poll HTTP Override Tenant A',
      );
      // Only the path id reached the port; the overrides never widened it.
      expect(findByIdSpy).toHaveBeenCalledTimes(1);
      expect(findByIdSpy).toHaveBeenCalledWith(idA);
      // Tenant B's row stays unreachable from tenant A's credential.
      await get(idB, credentialA.token).expect(404);
      expect(findByIdSpy).toHaveBeenCalledWith(idB);
    });
  });

  describe('GET :id — canonical id guard is a 400 with no poll read and unchanged decision-row cardinality', () => {
    it('rejects nil/uppercase/malformed ids without a poll read or new decision row (the real guard still touches its credential)', async () => {
      const tenantId = await seedTenant('Poll HTTP 400 Tenant');
      const credential = await seedCredential({ tenantId });
      // Seed a REAL row under the canonical lowercase id so the uppercase
      // rejection is provably not a missing-row artifact.
      const id = await seedDecision({
        ...pendingFixture(tenantId, 'Poll HTTP 400 Tenant').data,
        id: CANONICAL_ID,
      });
      expect(id).toBe(CANONICAL_ID);

      const before = await rawDecisionCount();

      // Sanity: the canonical lowercase id DOES resolve.
      await get(CANONICAL_ID, credential.token).expect(200);
      expect(findByIdSpy).toHaveBeenCalledTimes(1);

      // Clear the audit timestamp so the rejected path's auth write becomes
      // observable. The real `ServiceAuthGuard` records every successful
      // credential use — including requests whose id is rejected afterwards.
      await integrationPrisma().serviceCredential.update({
        where: { id: credential.id },
        data: { lastUsedAt: null },
      });

      for (const badId of [
        NIL_UUID,
        CANONICAL_ID.toUpperCase(),
        MALFORMED_ID,
      ]) {
        const res = await get(badId, credential.token).expect(400);
        const body = res.body as Record<string, unknown>;

        expect(body).toEqual(VALIDATION_BODY);
        expect(Object.keys(body).sort()).toEqual(ERROR_KEYS);
        expect(JSON.stringify(body)).not.toContain('Invalid human decision');
        // No `no-store`: early 400s make no caching claim.
        expect(res.headers['cache-control']).toBeUndefined();
      }

      // SCOPED proof: exactly one `findById` call (the lowercase success), so
      // the rejected ids never reached the POLL DECISION read. This is NOT a
      // "no database traffic" claim: the real guard already ran its
      // `service_credentials` SELECT and `lastUsedAt` UPDATE for each rejected
      // request, which the next assertion pins.
      expect(findByIdSpy).toHaveBeenCalledTimes(1);
      expect(findByIdSpy).toHaveBeenCalledWith(CANONICAL_ID);
      const credentialAfter =
        await integrationPrisma().serviceCredential.findUnique({
          where: { id: credential.id },
        });
      expect(credentialAfter).not.toBeNull();
      expect(credentialAfter?.lastUsedAt).toBeInstanceOf(Date);

      // Raw-SQL observation scoped to the DECISION table: its row cardinality is
      // unchanged. Other tables (e.g. `service_credentials.lastUsedAt`) are
      // deliberately outside this count and DO change, as asserted above.
      await expect(rawDecisionCount()).resolves.toBe(before);
    });
  });

  describe('GET :id — credential rate limit (429)', () => {
    it('serves the first read then returns the sanitized 429 with Retry-After', async () => {
      const tenantId = await seedTenant('Poll HTTP 429 Tenant');
      const credential = await seedCredential({ tenantId, rateLimit: 1 });
      const id = await seedDecision(
        pendingFixture(tenantId, 'Poll HTTP 429 Tenant').data,
      );

      await get(id, credential.token).expect(200);

      const limited = await get(id, credential.token).expect(429);
      expect(limited.body).toEqual(RATE_LIMITED_BODY);
      expect(Object.keys(limited.body as object).sort()).toEqual(ERROR_KEYS);
      expect(limited.headers['retry-after']).toBeDefined();
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      // The second request was rejected before the port.
      expect(findByIdSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('GET :id — credential rotation does not re-key the decision', () => {
    it('serves the same decision to a NEW same-tenant credential after the OLD one is revoked, while other-tenant and foreign-branch credentials stay 404/403', async () => {
      const tenantId = await seedTenant('Poll HTTP Rotation Tenant');
      const otherTenantId = await seedTenant('Poll HTTP Rotation Other Tenant');

      // The OLD credential is a REAL seeded `service_credentials` row, and the
      // decision records its id as the immutable `submittedCredentialId` —
      // never a hardcoded value.
      const oldCredential = await seedCredential({ tenantId });
      const fixture = pendingFixture(tenantId, 'Poll HTTP Rotation Tenant', {
        submittedCredentialId: oldCredential.id,
      });
      const id = await seedDecision(fixture.data);
      const before = await persistedRow(id);
      expect(before.submittedCredentialId).toBe(oldCredential.id);

      // Rotate: revoke the OLD credential, then issue a NEW valid same-tenant
      // read credential plus a different-tenant credential for the scope
      // checks below.
      await integrationPrisma().serviceCredential.update({
        where: { id: oldCredential.id },
        data: { revokedAt: new Date('2026-10-01T00:00:00.000Z') },
      });
      const newCredential = await seedCredential({ tenantId });
      const otherCredential = await seedCredential({ tenantId: otherTenantId });
      expect(newCredential.id).not.toBe(oldCredential.id);

      // The revoked credential no longer authenticates, and the poll read is
      // never reached.
      const revoked = await get(id, oldCredential.token).expect(401);
      expect(revoked.body).toEqual(UNAUTHORIZED_BODY);
      expect(findByIdSpy).not.toHaveBeenCalled();

      // The NEW same-tenant credential serves the SAME decision: identity is
      // the DECISION, never the credential that submitted it.
      const res = await get(id, newCredential.token).expect(200);
      const body = res.body as Record<string, unknown>;
      expect(body.id).toBe(id);
      expect(body.sourceRequestId).toBe(fixture.data.sourceRequestId);
      expect(body.status).toBe('PENDING');
      expect(body.version).toBe(1);

      // Neither the OLD (submitting) nor the NEW credential id is echoed.
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(oldCredential.id);
      expect(serialized).not.toContain(newCredential.id);

      // A different tenant's credential is a 404 and a foreign branch header is
      // a 403, even on a decision whose submitter credential was rotated.
      const crossTenant = await get(id, otherCredential.token).expect(404);
      expect(crossTenant.body).toEqual(NOT_FOUND_BODY);
      const foreignBranch = await http()
        .get(`${URL}/${id}`)
        .set('Authorization', `Bearer ${newCredential.token}`)
        .set('x-branch-id', otherTenantId)
        .expect(403);
      expect(foreignBranch.body).toEqual(FORBIDDEN_BODY);

      // The read is immutable: the decision identity/state is untouched and
      // `submittedCredentialId` still points at the OLD (now revoked)
      // credential.
      const after = await persistedRow(id);
      expect(after.id).toBe(before.id);
      expect(after.sourceRequestId).toBe(before.sourceRequestId);
      expect(after.status).toBe('PENDING');
      expect(after.version).toBe(1);
      expect(after.submittedCredentialId).toBe(oldCredential.id);
      expect(after.canonicalRequestHash).toBe(before.canonicalRequestHash);
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    });
  });

  describe('GET :id — real CLS tenant isolation under concurrency', () => {
    it('keeps two simultaneous tenant A/B HTTP reads disjoint and correctly scoped', async () => {
      const tenantA = await seedTenant('Poll HTTP Als Tenant A');
      const tenantB = await seedTenant('Poll HTTP Als Tenant B');
      const credentialA = await seedCredential({ tenantId: tenantA });
      const credentialB = await seedCredential({ tenantId: tenantB });
      const idA = await seedDecision(
        pendingFixture(tenantA, 'Poll HTTP Als Tenant A').data,
      );
      const idB = await seedDecision(
        pendingFixture(tenantB, 'Poll HTTP Als Tenant B').data,
      );

      // Both HTTP requests are in flight at once; the express `ClsMiddleware`
      // opens one ALS store per request, so neither can borrow the other's
      // trusted tenant.
      const [resA, resB] = await Promise.all([
        get(idA, credentialA.token).expect(200),
        get(idB, credentialB.token).expect(200),
      ]);

      const bodyA = resA.body as Record<string, unknown>;
      const bodyB = resB.body as Record<string, unknown>;

      expect(bodyA.id).toBe(idA);
      expect(bodyB.id).toBe(idB);
      expect((bodyA.snapshot as Record<string, unknown>).branchId).toBe(
        tenantA,
      );
      expect((bodyB.snapshot as Record<string, unknown>).branchId).toBe(
        tenantB,
      );
      expect(bodyA.id).not.toBe(bodyB.id);

      // Both ids were resolved independently through the real adapter.
      expect(findByIdSpy).toHaveBeenCalledWith(idA);
      expect(findByIdSpy).toHaveBeenCalledWith(idB);

      // Non-vacuous: both rows are committed in the same dedicated DB.
      await expect(integrationPrisma().humanDecision.count()).resolves.toBe(2);
      // Real nestjs-cls service, and no ambient tenant outside a request.
      expect(cls).toBeInstanceOf(ClsService);
      expect(cls.isActive()).toBe(false);
    });
  });
});
