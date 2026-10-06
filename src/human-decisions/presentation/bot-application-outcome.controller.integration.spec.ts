/**
 * HD-05c2b — bot terminal ACK HTTP route against REAL PostgreSQL + REAL CLS
 * ALS + REAL service credentials.
 *
 * Contract (read-only):
 * `houndfe-chatbot-human-decisions/docs/human-decisions-contract-v1.md`
 * ("ACK `{attemptId,expectedResolutionVersion,outcome,providerMessageId?,
 * providerAcceptedObservedAt?,attemptedAt?,evidenceCode?}` is one TERMINAL
 * outcome per request: backend hashes the canonical allowlisted evidence, exact
 * replay of the same attempt ID/hash returns the same result, changed payload
 * or second terminal attempt returns `409`").
 *
 * What this spec proves that neither the DB-free HTTP spec
 * (`bot-application-outcome.controller.http.spec.ts`) nor the DB-only adapter
 * spec (`prisma-bot-application-outcome.repository.integration.spec.ts`) can
 * prove on their own: the uncommitted `BotApplicationOutcomeController`
 * (`POST /chatbot-api/human-decisions/:id/application-outcome`) runs end to end
 * through the REAL production chain and a real database —
 *
 *   Supertest → real route-scoped sanitizing body parser
 *   (`installBotApplicationOutcomeBodyParser`, mounted AFTER `enableCors` and
 *   BEFORE `app.init()`, mirroring `main.ts`) → real
 *   `HumanDecisionHttpFilter` (controller-scoped) → real `ServiceAuthGuard`
 *   (SHA-256 hashes the bearer token against the REAL
 *   `PrismaServiceCredentialRepository`, i.e. committed `service_credentials`
 *   rows) → real nestjs-cls `ClsService` ALS store opened by
 *   `ClsModule.forRoot({ middleware: { mount: true } })` → real
 *   `BotApplicationOutcomeController` + the EXACT pure
 *   `parseBotApplicationOutcomeRequest` → real
 *   `PrismaBotApplicationOutcomeRepository` → real `TenantPrismaService`
 *   (CLS-driven `tenantId` WHERE injection) → real `PrismaService` → committed
 *   `HumanDecision` rows in the dedicated isolated test database.
 *
 * Deliberately NOT booted: the full `AppModule` (or `HumanDecisionsModule` /
 * `ChatbotApiModule`), because their transitive imports pull Inngest / mail /
 * provider / outbox registrars. This spec assembles a minimal Nest
 * `TestingModule` with ONLY the real pieces under test, plus `DatabaseModule`
 * (global Prisma + TenantPrisma providers) and the same global
 * `ValidationPipe`/filters that `main.ts` installs. The global
 * `DomainExceptionFilter`/`PrismaExceptionFilter` are REAL so the scoped
 * filter's precedence over them is exercised, not assumed. Module wiring (the
 * ACK controller registration and the `BOT_APPLICATION_OUTCOME_REPOSITORY` →
 * `PrismaBotApplicationOutcomeRepository` binding) is pinned by module METADATA
 * in the DB-free HTTP spec and is NOT re-booted here.
 *
 * Deliberately mocked (and only this): nothing. There is NO mocked credential
 * repository, NO mocked ACK port and NO `ClsService` Map shim. Credentials are
 * seeded as real `service_credentials` rows and hashed by the real guard. The
 * ONLY non-production substitution is the adapter's documented optional clock
 * seam (`BOT_APPLICATION_OUTCOME_CLOCK`, which defaults to `new Date()` in
 * production) so `ackReceivedAt` is deterministic; the adapter itself is the
 * real class, bound via its real token.
 *
 * SCOPED "NO ACK READ/WRITE" PROOF — NOT "NO DB TRAFFIC": the spec wraps the
 * REAL `PrismaBotApplicationOutcomeRepository.record` instance method in a
 * call-through `jest.spyOn` (it never replaces the implementation, so
 * adapter/DB behavior is untouched). An assertion that the spy recorded ZERO
 * calls means the route never reached the ACK PORT (`record`); it does NOT mean
 * the request issued no database query or no write. On any request that
 * authenticates, the REAL `ServiceAuthGuard` has ALREADY run its own
 * `service_credentials` SELECT and `lastUsedAt` UPDATE — it only reaches the
 * handler after authenticating — and the id-rejection test asserts that UPDATE
 * explicitly. The raw decision-row count therefore proves ONLY that the
 * `human_decisions` row cardinality is unchanged; it is NOT a global
 * no-mutation claim. A malformed JSON body is rejected by the route-scoped
 * parser BEFORE the guard, so it is the ONE rejected case where the credential
 * is provably untouched. Because the parser gate mirrors Express routing
 * (`case sensitive routing = false`, `strict routing = false`), the sanitizer
 * also covers the case-variant and single-trailing-slash URLs that resolve to
 * the same ACK route; those routing-equivalent probes are exercised in the
 * same test.
 *
 * NO provider, bot, device, mail, Inngest or listen port is started
 * (`app.init()` only): this spec makes NO claim about provider acceptance,
 * device delivery, stock mutation, the human resolve route or the full
 * application graph. It DOES prove, against a SEEDED NON-EMPTY
 * Product/Variant/Lot/StockAlertState/Sale baseline, that a successful ACK
 * leaves every one of those rows byte-identical (ordered full-row snapshot
 * equality plus per-table cardinality) and that the decision row's `productId`
 * still equals the seeded Product id — so the no-stock/catalog/sale-write claim
 * is non-vacuous.
 *
 * FORCED INTERLEAVING IS NOT CLAIMED: the concurrent test issues two real,
 * simultaneous HTTP ACK requests and asserts only the invariant outcome (one
 * winner, one `409`), which holds for every interleaving. The deterministic
 * barrier-forced two-writer race belongs to the DB adapter spec; no barrier is
 * installed here.
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
 *     src/human-decisions/presentation/bot-application-outcome.controller.integration.spec.ts \
 *     --silent
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
import { PrismaServiceCredentialRepository } from '../../chatbot-api/infrastructure/prisma-service-credential.repository';
import { ServiceAuthGuard } from '../../chatbot-api/presentation/guards/service-auth.guard';
import { DomainExceptionFilter } from '../../shared/filters/domain-exception.filter';
import { PrismaExceptionFilter } from '../../shared/filters/prisma-exception.filter';
import { createListingValidationExceptionFactory } from '../../shared/listing/listing-validation-exception.factory';
import { DatabaseModule } from '../../shared/prisma/prisma.module';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import {
  DELIVERY_UNKNOWN,
  hashBotApplicationOutcomeEvidence,
  parseBotApplicationOutcomeRequest,
  PROVIDER_ACCEPTED,
  PROVIDER_ACCEPTED_LATE,
  STALE,
} from '../domain/bot-application-outcome.request';
import {
  BOT_APPLICATION_OUTCOME_REPOSITORY,
  type BotApplicationOutcomeResult,
} from '../domain/bot-application-outcome.repository';
import { HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE } from '../domain/human-decision-review-resolve.repository';
import {
  RESTOCK_SOURCE,
  RESTOCK_TYPE,
} from '../domain/restock-request-canonicalizer';
import { EXPIRATION_TYPE } from '../domain/expiration-intake.request';
import {
  BOT_APPLICATION_OUTCOME_CLOCK,
  PrismaBotApplicationOutcomeRepository,
} from '../infrastructure/prisma-bot-application-outcome.repository';
import { BotApplicationOutcomeController } from './bot-application-outcome.controller';
import { installBotApplicationOutcomeBodyParser } from './filters/human-decision-body-parser';
import { HumanDecisionHttpFilter } from './filters/human-decision-http.filter';

const URL = '/chatbot-api/human-decisions';
const ACK_SUFFIX = 'application-outcome';

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
      `[hd-05c2b] refusing isolated-DB run: ${SOURCE_LABELS[source]} DATABASE_URL is unset.`,
    );
  }

  let url: globalThis.URL;
  try {
    url = new globalThis.URL(rawUrl);
  } catch {
    throw new Error(
      `[hd-05c2b] refusing isolated-DB run: ${SOURCE_LABELS[source]} DATABASE_URL is not a valid URL.`,
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
      `[hd-05c2b] refusing isolated-DB run: ${SOURCE_LABELS[source]} DATABASE_URL does not match the dedicated isolated RESTOCK target.`,
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
      `[hd-05c2b] isolated DB target OK: ${EXPECTED_PROTOCOL}//${EXPECTED_HOSTNAME}:${EXPECTED_PORT}/${EXPECTED_DATABASE}`,
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

/** The exact 5 top-level keys of the bot ACK response body, sorted. */
const RESPONSE_KEYS = [
  'ackReceivedAt',
  'attemptId',
  'id',
  'outcome',
  'version',
];

/** The exact 3-key sanitized error envelope, sorted. */
const ERROR_KEYS = ['code', 'message', 'statusCode'];

/**
 * Reviewer / authority / provider / evidence columns that must NEVER reach the
 * ACK receipt. The adapter's SELECT keyset is pinned by the adapter spec; here
 * the same keys are asserted absent from the HTTP BODY while the real DB row
 * HOLDS reviewer/provider values.
 */
const FORBIDDEN_RESPONSE_KEYS = [
  'tenantId',
  'source',
  'type',
  'submittedCredentialId',
  'canonicalRequestHash',
  'applicationEvidenceHash',
  'applicationEvidenceCode',
  'applicationAttemptId',
  'providerMessageId',
  'providerAcceptedObservedAt',
  'applicationAttemptedAt',
  'expectedResolutionVersion',
  'resolutionAction',
  'restockDays',
  'resolvedAt',
  'resolvedById',
  'resolvedByActorId',
  'resolvedByDisplayName',
  'acknowledgment',
  'status',
  'needsReconciliation',
  'customerPhone',
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
const VERSION_CONFLICT_BODY = {
  statusCode: 409,
  code: 'VERSION_CONFLICT',
  message: 'Human decision was modified by another reviewer',
};
const IDEMPOTENCY_CONFLICT_BODY = {
  statusCode: 409,
  code: 'IDEMPOTENCY_CONFLICT',
  message: 'Request conflicts with a previous submission',
};
const OUTCOME_ALREADY_RECORDED_BODY = {
  statusCode: 409,
  code: 'OUTCOME_ALREADY_RECORDED',
  message: 'A terminal application outcome is already recorded',
};
const RATE_LIMITED_BODY = {
  statusCode: 429,
  code: 'RATE_LIMITED',
  message: 'Too many requests',
};

// Distinctive persisted values, echoed nowhere in the ACK receipt.
const SUBMITTED_CREDENTIAL_ID = 'cred-intake-hd-05c2b';
const CANONICAL_HASH = 'canonical-hash-hd-05c2b';
const REVIEWER_ACTOR_ID = 'reviewer-actor-hd-05c2b';
const REVIEWER_DISPLAY_NAME = 'Hd05c2b Reviewer';
const PROVIDER_MESSAGE_ID = 'wamid.HBgLNTQ5MTEwMDAwMDAw';
const CHANGED_PROVIDER_MESSAGE_ID = 'wamid.HBgLOTg3NjU0MzIxMA==';

/** Valid RFC 4122 v1-v8 attempt ids (canonical UUID variant). */
const ATTEMPT_ID = '3f1c1b7a-9c2e-4d5f-8a6b-1c2d3e4f5a6b';
const OTHER_ATTEMPT_ID = '0192a1b2-c3d4-7e5f-8a6b-1c2d3e4f5a6b';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

const PRODUCT_NAME = 'Cafe de altura';
const SKU = 'SKU-1';
const REQUESTED_QUANTITY = 5;
const OBSERVED_STOCK = 0;
const PRODUCT_STOCK = 7;
const BRANCH_NAME = 'HD-05c2b Branch';
const CREATED_AT = new Date('2026-06-15T11:00:00.000Z');
const OBSERVED_AT = new Date('2026-06-15T10:30:00.000Z');
const RESOLVED_AT = new Date('2026-06-15T12:00:00.000Z');
/** `resolvedAt + 1h`: the exclusive upper bound of the application window. */
const DEADLINE_AT = '2026-06-15T13:00:00.000Z';
const ATTEMPTED_AT = '2026-06-15T12:05:00.000Z';
const ACCEPTED_OBSERVED_AT = '2026-06-15T12:05:04.500Z';
const LATE_ATTEMPTED_AT = '2026-06-15T12:59:59.000Z';
const LATE_OBSERVED_AT = '2026-06-15T13:05:00.000Z';
const FIXED_NOW = new Date('2026-06-15T12:10:00.000Z');
/** Wall clock well past the deadline, for the long-lived replay. */
const REPLAY_NOW = new Date('2026-06-15T14:30:00.000Z');

type TenantScopedHumanDecisionUpdate = Prisma.HumanDecisionUncheckedCreateInput;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** One explicit tenant per test; the baseline tenant is never reused. */
async function seedTenant(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await integrationPrisma().tenant.create({
    data: { id, name, slug: `hd05c2b-${id}` },
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
      name: 'HD-05c2b ACK bot',
      hashedKey: createHash('sha256').update(token).digest('hex'),
      scopes: params.scopes ?? ['human-decisions:ack'],
      isActive: params.isActive ?? true,
      revokedAt: params.revokedAt ?? null,
      rateLimit: params.rateLimit ?? 60,
    },
  });
  return { id: row.id, token };
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
      email: `hd05c2b-${id}@example.test`,
      hashedPassword: 'not-a-real-password-hash',
      name: REVIEWER_DISPLAY_NAME,
    },
  });
  return id;
}

/**
 * Valid `RESOLVED` fixture satisfying every HD-01 SQL CHECK and leaving the
 * terminal outcome/evidence columns NULL so the ACK adapter can write the
 * single outcome. Reviewer/authority/provider columns are populated so the
 * receipt-exclusion proof is non-vacuous.
 */
function resolvedDecisionData(
  tenantId: string,
  resolvedById: string,
  overrides: Partial<TenantScopedHumanDecisionUpdate> = {},
): TenantScopedHumanDecisionUpdate {
  return {
    tenantId,
    source: RESTOCK_SOURCE,
    sourceRequestId: crypto.randomUUID(),
    type: RESTOCK_TYPE,
    canonicalRequestHash: CANONICAL_HASH,
    submittedCredentialId: SUBMITTED_CREDENTIAL_ID,
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

/** Valid `RESOLVED` EXPIRATION fixture: `productUnit` set, the RESTOCK snapshot NULL. */
function expirationResolvedDecisionData(
  tenantId: string,
  resolvedById: string,
): TenantScopedHumanDecisionUpdate {
  return resolvedDecisionData(tenantId, resolvedById, {
    type: EXPIRATION_TYPE,
    sku: null,
    requestedQuantity: null,
    observedStockAtRequest: null,
    stockObservedAt: null,
    productUnit: 'caja',
    resolutionAction: 'PROVIDE_EXPIRATION_TEXT',
    restockDays: null,
    expirationText: 'Vence en marzo de 2027',
  });
}

/** Valid `PENDING` fixture, used for the version/status conflict case. */
function pendingDecisionData(
  tenantId: string,
  overrides: Partial<TenantScopedHumanDecisionUpdate> = {},
): TenantScopedHumanDecisionUpdate {
  return {
    tenantId,
    source: RESTOCK_SOURCE,
    sourceRequestId: crypto.randomUUID(),
    type: RESTOCK_TYPE,
    canonicalRequestHash: CANONICAL_HASH,
    submittedCredentialId: SUBMITTED_CREDENTIAL_ID,
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

/** Persist one fixture and return its id. */
async function seedDecision(
  data: TenantScopedHumanDecisionUpdate,
): Promise<string> {
  const row = await integrationPrisma().humanDecision.create({ data });
  return row.id;
}

/** Full persisted decision row; the integration client is NOT tenant-extended. */
async function fullRow(id: string) {
  return integrationPrisma().humanDecision.findUnique({ where: { id } });
}

/** Raw decision-row cardinality, independent of the tenant extension. */
async function rawDecisionCount(): Promise<number> {
  return integrationPrisma().humanDecision.count();
}

/**
 * Deterministically ordered snapshot of every Product/Variant/Lot/
 * StockAlertState/Sale row, so a stock, catalog or sale write cannot hide
 * behind an empty baseline. This is a pure read; it never calls a provider or
 * an external service.
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
// Request bodies (the exact HD-05b1 wire shape)
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
    providerAcceptedObservedAt: LATE_OBSERVED_AT,
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

/** Canonical evidence hash the SERVER must derive from an ACK body. */
function hashOf(body: Record<string, unknown>): string {
  return hashBotApplicationOutcomeEvidence(
    parseBotApplicationOutcomeRequest(body),
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeIfDb(
  'Bot application outcome HTTP → PostgreSQL integration (HD-05c2b)',
  () => {
    let app: INestApplication;
    let cls: ClsService<TenantClsStore>;
    let outcomeRepo: PrismaBotApplicationOutcomeRepository;
    let recordSpy: jest.SpyInstance<
      Promise<BotApplicationOutcomeResult>,
      [Parameters<PrismaBotApplicationOutcomeRepository['record']>[0]]
    >;
    let clockNow: Date;

    const http = () =>
      request(app.getHttpServer() as import('node:http').Server);

    const ackUrl = (id: string) => `${URL}/${id}/${ACK_SUFFIX}`;

    const postAck = (
      id: string,
      token: string | null,
      body: unknown = acceptedBody(),
      { raw }: { raw?: string } = {},
    ) => {
      const builder = http().post(ackUrl(id));
      if (token) {
        builder.set('Authorization', `Bearer ${token}`);
      }
      if (raw !== undefined) {
        return builder.set('Content-Type', 'application/json').send(raw);
      }
      return builder.send(body as object);
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
        controllers: [BotApplicationOutcomeController],
        providers: [
          HumanDecisionHttpFilter,
          ServiceAuthGuard,
          {
            provide: SERVICE_CREDENTIAL_REPOSITORY,
            useClass: PrismaServiceCredentialRepository,
          },
          {
            provide: BOT_APPLICATION_OUTCOME_REPOSITORY,
            useClass: PrismaBotApplicationOutcomeRepository,
          },
          {
            // Documented optional clock seam; production defaults to the real
            // wall clock. Deterministic so `ackReceivedAt` can be pinned.
            provide: BOT_APPLICATION_OUTCOME_CLOCK,
            useValue: (): Date => clockNow,
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
      // Mirror `main.ts` order: CORS FIRST, then the route-scoped sanitizing
      // parser, both BEFORE init, so a malformed-body short-circuit still
      // carries the allowlisted origin.
      app.enableCors({
        origin: 'https://sistem.houndfe.com',
        credentials: true,
      });
      installBotApplicationOutcomeBodyParser(app);

      await app.init();

      cls = app.get<ClsService<TenantClsStore>>(ClsService);
      outcomeRepo = app.get<PrismaBotApplicationOutcomeRepository>(
        BOT_APPLICATION_OUTCOME_REPOSITORY,
      );
    });

    beforeEach(() => {
      clockNow = FIXED_NOW;
      // Call-through spy on the REAL adapter instance: the implementation is
      // never replaced, so adapter/DB behavior is untouched. It records ONLY
      // whether the route reached the ACK PORT; it says nothing about the real
      // guard's own credential SELECT/UPDATE.
      recordSpy = jest.spyOn(outcomeRepo, 'record');
    });

    afterEach(async () => {
      recordSpy.mockRestore();
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
          expect(message).toContain('[hd-05c2b]');
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

    describe('success path (recorded 200 first commit over real PostgreSQL)', () => {
      it('records once, returns the exact five-key body, writes the ACK columns, and leaves resolution/version/reviewer and the seeded inventory untouched', async () => {
        const tenantId = await seedTenant('ACK HTTP Tenant A');
        const reviewerId = await seedReviewerUser();
        const credential = await seedCredential({ tenantId });

        // Seed a REAL non-empty inventory/catalog row set FIRST so the
        // no-stock/catalog/sale-write proof is non-vacuous, then link the
        // decision to the seeded Product and Variant by id.
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
        // Non-vacuous: every one of the five tables really holds a row.
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

        const fixture = resolvedDecisionData(tenantId, reviewerId, {
          productId: product.id,
          variantId: variant.id,
        });
        const decisionId = await seedDecision(fixture);

        const res = await postAck(
          decisionId,
          credential.token,
          acceptedBody(),
        ).expect(200);
        const body = res.body as Record<string, unknown>;

        expect(body).toEqual({
          id: decisionId,
          version: 2,
          attemptId: ATTEMPT_ID,
          outcome: PROVIDER_ACCEPTED,
          ackReceivedAt: FIXED_NOW.toISOString(),
        });
        expect(Object.keys(body).sort()).toEqual(RESPONSE_KEYS);
        // A terminal ACK is a mutation: never cached.
        expect(res.headers['cache-control']).toBe('no-store');
        expect(recordSpy).toHaveBeenCalledTimes(1);

        const row = await fullRow(decisionId);
        expect(row).not.toBeNull();
        if (row === null) {
          throw new Error('[hd-05c2b] expected the decision row to persist');
        }
        expect(row.applicationOutcome).toBe(PROVIDER_ACCEPTED);
        expect(row.applicationAttemptId).toBe(ATTEMPT_ID);
        expect(row.applicationEvidenceHash).toBe(hashOf(acceptedBody()));
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
        expect(row.source).toBe(RESTOCK_SOURCE);
        expect(row.submittedCredentialId).toBe(SUBMITTED_CREDENTIAL_ID);
        expect(row.canonicalRequestHash).toBe(CANONICAL_HASH);
        // The decision references the SEEDED Product and Variant by id, so the
        // inventory non-mutation proof is anchored on real linked rows.
        expect(row.productId).toBe(product.id);
        expect(row.variantId).toBe(variant.id);
        expect(row.productId).toBe(inventoryBefore.products[0].id);

        // The bot can infer NO reviewer/authority/provider field from the
        // receipt.
        for (const key of FORBIDDEN_RESPONSE_KEYS) {
          expect(body).not.toHaveProperty(key);
        }
        const serialized = JSON.stringify(body);
        for (const forbiddenValue of [
          PROVIDER_MESSAGE_ID,
          REVIEWER_ACTOR_ID,
          REVIEWER_DISPLAY_NAME,
          reviewerId,
          tenantId,
          credential.id,
          CANONICAL_HASH,
          SUBMITTED_CREDENTIAL_ID,
        ]) {
          expect(serialized).not.toContain(forbiddenValue);
        }

        // No stock/catalog/sale write: the ordered FULL-ROW inventory
        // snapshots are byte-identical and NON-EMPTY both before and after, so
        // a hidden write cannot pass on an empty baseline.
        const inventoryAfter = await snapshotInventoryRows();
        expect(inventoryAfter).toEqual(inventoryBefore);
        expect(inventoryAfter.products).toHaveLength(1);
        expect(inventoryAfter.variants).toHaveLength(1);
        expect(inventoryAfter.lots).toHaveLength(1);
        expect(inventoryAfter.stockStates).toHaveLength(1);
        expect(inventoryAfter.sales).toHaveLength(1);
        expect(inventoryAfter.products[0].id).toBe(product.id);
        expect(inventoryAfter.variants[0].id).toBe(variant.id);
        expect(inventoryAfter.lots[0].id).toBe(lot.id);
        expect(inventoryAfter.stockStates[0].id).toBe(stockState.id);
        expect(inventoryAfter.sales[0].id).toBe(sale.id);
      });
    });

    describe('idempotent replay over real PostgreSQL', () => {
      it('replays the identical attempt/hash with an identical body and an unchanged ackReceivedAt/updatedAt after the wall clock passes the deadline', async () => {
        const tenantId = await seedTenant('ACK HTTP Replay Tenant');
        const reviewerId = await seedReviewerUser();
        const credential = await seedCredential({ tenantId });
        const decisionId = await seedDecision(
          resolvedDecisionData(tenantId, reviewerId),
        );
        const body = acceptedBody();

        const first = await postAck(decisionId, credential.token, body).expect(
          200,
        );
        const persisted = await fullRow(decisionId);
        const ackAt = persisted?.ackReceivedAt?.getTime();
        const updatedAt = persisted?.updatedAt.getTime();

        // Wall clock moves well past the deadline; the replay must NOT
        // re-validate the temporal window nor rewrite ackReceivedAt/updatedAt.
        clockNow = REPLAY_NOW;
        const second = await postAck(decisionId, credential.token, body).expect(
          200,
        );

        expect(second.body).toEqual(first.body);
        expect((second.body as Record<string, unknown>).ackReceivedAt).toBe(
          FIXED_NOW.toISOString(),
        );
        expect(recordSpy).toHaveBeenCalledTimes(2);

        const afterReplay = await fullRow(decisionId);
        expect(afterReplay?.ackReceivedAt?.getTime()).toBe(ackAt);
        expect(afterReplay?.updatedAt.getTime()).toBe(updatedAt);
        expect(afterReplay?.applicationEvidenceHash).toBe(hashOf(body));
      });
    });

    describe('four terminal outcomes persisted over real PostgreSQL + HTTP', () => {
      it('persists PROVIDER_ACCEPTED with provider evidence and an in-window attempt', async () => {
        const tenantId = await seedTenant('ACK Outcome Tenant Accepted');
        const reviewerId = await seedReviewerUser();
        const credential = await seedCredential({ tenantId });
        const decisionId = await seedDecision(
          resolvedDecisionData(tenantId, reviewerId),
        );

        const res = await postAck(
          decisionId,
          credential.token,
          acceptedBody(),
        ).expect(200);

        expect((res.body as { outcome: string }).outcome).toBe(
          PROVIDER_ACCEPTED,
        );
        expect(Object.keys(res.body as object).sort()).toEqual(RESPONSE_KEYS);
        const row = await fullRow(decisionId);
        expect(row?.applicationOutcome).toBe(PROVIDER_ACCEPTED);
        expect(row?.applicationEvidenceHash).toBe(hashOf(acceptedBody()));
        expect(row?.providerMessageId).toBe(PROVIDER_MESSAGE_ID);
        expect(row?.providerAcceptedObservedAt).not.toBeNull();
        expect(row?.applicationAttemptedAt).not.toBeNull();
      });

      it('persists PROVIDER_ACCEPTED_LATE with an in-window attempt and a late provider observation', async () => {
        const tenantId = await seedTenant('ACK Outcome Tenant Late');
        const reviewerId = await seedReviewerUser();
        const credential = await seedCredential({ tenantId });
        const decisionId = await seedDecision(
          resolvedDecisionData(tenantId, reviewerId),
        );

        const res = await postAck(
          decisionId,
          credential.token,
          lateBody(),
        ).expect(200);

        expect((res.body as { outcome: string }).outcome).toBe(
          PROVIDER_ACCEPTED_LATE,
        );
        const row = await fullRow(decisionId);
        expect(row?.applicationOutcome).toBe(PROVIDER_ACCEPTED_LATE);
        expect(row?.applicationEvidenceHash).toBe(hashOf(lateBody()));
        expect(row?.providerAcceptedObservedAt?.toISOString()).toBe(
          new Date(LATE_OBSERVED_AT).toISOString(),
        );
        expect(row?.applicationAttemptedAt?.toISOString()).toBe(
          new Date(LATE_ATTEMPTED_AT).toISOString(),
        );
      });

      it('persists DELIVERY_UNKNOWN with an in-window attempt and NULL provider acceptance', async () => {
        const tenantId = await seedTenant('ACK Outcome Tenant Unknown');
        const reviewerId = await seedReviewerUser();
        const credential = await seedCredential({ tenantId });
        const decisionId = await seedDecision(
          resolvedDecisionData(tenantId, reviewerId),
        );

        const body = unknownBody({ providerMessageId: PROVIDER_MESSAGE_ID });
        const res = await postAck(decisionId, credential.token, body).expect(
          200,
        );

        expect((res.body as { outcome: string }).outcome).toBe(
          DELIVERY_UNKNOWN,
        );
        const row = await fullRow(decisionId);
        expect(row?.applicationOutcome).toBe(DELIVERY_UNKNOWN);
        expect(row?.applicationEvidenceHash).toBe(hashOf(body));
        // Partial audit evidence is retained on UNKNOWN...
        expect(row?.providerMessageId).toBe(PROVIDER_MESSAGE_ID);
        // ...but a definite acceptance timestamp is never fabricated.
        expect(row?.providerAcceptedObservedAt).toBeNull();
        expect(row?.applicationAttemptedAt).not.toBeNull();
      });

      it('persists STALE with no attempt/provider evidence', async () => {
        const tenantId = await seedTenant('ACK Outcome Tenant Stale');
        const reviewerId = await seedReviewerUser();
        const credential = await seedCredential({ tenantId });
        const decisionId = await seedDecision(
          resolvedDecisionData(tenantId, reviewerId),
        );

        const res = await postAck(
          decisionId,
          credential.token,
          staleBody(),
        ).expect(200);

        expect((res.body as { outcome: string }).outcome).toBe(STALE);
        const row = await fullRow(decisionId);
        expect(row?.applicationOutcome).toBe(STALE);
        expect(row?.applicationEvidenceHash).toBe(hashOf(staleBody()));
        expect(row?.applicationAttemptedAt).toBeNull();
        expect(row?.providerMessageId).toBeNull();
        expect(row?.providerAcceptedObservedAt).toBeNull();
        expect(row?.applicationEvidenceCode).toBeNull();
        // The ACK path opens no correlated-successor intake.
        expect(row?.supersedesDecisionId).toBeNull();
        await expect(
          integrationPrisma().humanDecision.count({
            where: { supersedesDecisionId: decisionId },
          }),
        ).resolves.toBe(0);
      });
    });

    describe('EXPIRATION type-aware deadline over real PostgreSQL + HTTP', () => {
      it('records an EXPIRATION ACK 2h inside the 24h window over real HTTP', async () => {
        const tenantId = await seedTenant('ACK Expiration Tenant');
        const reviewerId = await seedReviewerUser();
        const credential = await seedCredential({ tenantId });
        const decisionId = await seedDecision(
          expirationResolvedDecisionData(tenantId, reviewerId),
        );

        const body = acceptedBody({
          attemptedAt: '2026-06-15T14:00:00.000Z',
          providerAcceptedObservedAt: '2026-06-15T14:00:04.500Z',
        });
        const res = await postAck(decisionId, credential.token, body).expect(
          200,
        );

        expect((res.body as { outcome: string }).outcome).toBe(
          PROVIDER_ACCEPTED,
        );
        const row = await fullRow(decisionId);
        expect(row?.type).toBe(EXPIRATION_TYPE);
        expect(row?.applicationOutcome).toBe(PROVIDER_ACCEPTED);
        expect(row?.applicationAttemptedAt?.toISOString()).toBe(
          new Date('2026-06-15T14:00:00.000Z').toISOString(),
        );
        expect(row?.version).toBe(2);
      });
    });

    describe('half-open deadline over real PostgreSQL + HTTP', () => {
      it('rejects an attempt exactly at the deadline with a sanitized 400 and no ACK mutation', async () => {
        const tenantId = await seedTenant('ACK Window Tenant A');
        const reviewerId = await seedReviewerUser();
        const credential = await seedCredential({ tenantId });
        const decisionId = await seedDecision(
          resolvedDecisionData(tenantId, reviewerId),
        );
        const before = await fullRow(decisionId);

        const res = await postAck(
          decisionId,
          credential.token,
          acceptedBody({
            attemptedAt: DEADLINE_AT,
            providerAcceptedObservedAt: DEADLINE_AT,
          }),
        ).expect(400);

        expect(res.body).toEqual(VALIDATION_BODY);
        expect(Object.keys(res.body as object).sort()).toEqual(ERROR_KEYS);
        // A handler-level port error still carries the no-store header.
        expect(res.headers['cache-control']).toBe('no-store');
        // The port WAS reached (400 comes from the adapter's window check), but
        // it wrote nothing.
        expect(recordSpy).toHaveBeenCalledTimes(1);

        const after = await fullRow(decisionId);
        expect(after?.applicationOutcome).toBeNull();
        expect(after?.ackReceivedAt).toBeNull();
        expect(after?.updatedAt.toISOString()).toBe(
          before?.updatedAt.toISOString(),
        );
      });

      it('records PROVIDER_ACCEPTED_LATE observed exactly at the deadline (upper bound inclusive for LATE)', async () => {
        const tenantId = await seedTenant('ACK Window Tenant B');
        const reviewerId = await seedReviewerUser();
        const credential = await seedCredential({ tenantId });
        const decisionId = await seedDecision(
          resolvedDecisionData(tenantId, reviewerId),
        );

        const body = lateBody({ providerAcceptedObservedAt: DEADLINE_AT });
        const res = await postAck(decisionId, credential.token, body).expect(
          200,
        );

        expect((res.body as { outcome: string }).outcome).toBe(
          PROVIDER_ACCEPTED_LATE,
        );
        const row = await fullRow(decisionId);
        expect(row?.applicationOutcome).toBe(PROVIDER_ACCEPTED_LATE);
        expect(row?.providerAcceptedObservedAt?.toISOString()).toBe(
          new Date(DEADLINE_AT).toISOString(),
        );
      });
    });

    describe('terminal conflicts over real PostgreSQL + HTTP', () => {
      it('returns 409 IDEMPOTENCY_CONFLICT for the same attempt with a changed hash and leaves the row unchanged', async () => {
        const tenantId = await seedTenant('ACK Conflict Tenant Hash');
        const reviewerId = await seedReviewerUser();
        const credential = await seedCredential({ tenantId });
        const decisionId = await seedDecision(
          resolvedDecisionData(tenantId, reviewerId),
        );

        await postAck(decisionId, credential.token, acceptedBody()).expect(200);
        const committed = await fullRow(decisionId);

        const res = await postAck(
          decisionId,
          credential.token,
          acceptedBody({ providerMessageId: CHANGED_PROVIDER_MESSAGE_ID }),
        ).expect(409);

        expect(res.body).toEqual(IDEMPOTENCY_CONFLICT_BODY);
        expect(res.headers['cache-control']).toBe('no-store');
        const after = await fullRow(decisionId);
        expect(after?.applicationEvidenceHash).toBe(
          committed?.applicationEvidenceHash,
        );
        expect(after?.updatedAt.toISOString()).toBe(
          committed?.updatedAt.toISOString(),
        );
      });

      it('returns 409 OUTCOME_ALREADY_RECORDED for a different attempt and leaves the row unchanged', async () => {
        const tenantId = await seedTenant('ACK Conflict Tenant Attempt');
        const reviewerId = await seedReviewerUser();
        const credential = await seedCredential({ tenantId });
        const decisionId = await seedDecision(
          resolvedDecisionData(tenantId, reviewerId),
        );

        await postAck(decisionId, credential.token, acceptedBody()).expect(200);
        const committed = await fullRow(decisionId);

        const res = await postAck(
          decisionId,
          credential.token,
          acceptedBody({ attemptId: OTHER_ATTEMPT_ID }),
        ).expect(409);

        expect(res.body).toEqual(OUTCOME_ALREADY_RECORDED_BODY);
        const after = await fullRow(decisionId);
        expect(after?.applicationAttemptId).toBe(
          committed?.applicationAttemptId,
        );
        expect(after?.updatedAt.toISOString()).toBe(
          committed?.updatedAt.toISOString(),
        );
      });

      it('returns 409 VERSION_CONFLICT for a stale expected resolution version without an ACK write', async () => {
        const tenantId = await seedTenant('ACK Conflict Tenant Version');
        const reviewerId = await seedReviewerUser();
        const credential = await seedCredential({ tenantId });
        const decisionId = await seedDecision(
          resolvedDecisionData(tenantId, reviewerId),
        );

        const res = await postAck(
          decisionId,
          credential.token,
          acceptedBody({ expectedResolutionVersion: 1 }),
        ).expect(409);

        expect(res.body).toEqual(VERSION_CONFLICT_BODY);
        const row = await fullRow(decisionId);
        expect(row?.applicationOutcome).toBeNull();
        expect(row?.version).toBe(2);
      });

      it('returns 409 VERSION_CONFLICT for a PENDING decision and writes no outcome', async () => {
        const tenantId = await seedTenant('ACK Conflict Tenant Pending');
        const credential = await seedCredential({ tenantId });
        const decisionId = await seedDecision(pendingDecisionData(tenantId));

        const res = await postAck(
          decisionId,
          credential.token,
          acceptedBody(),
        ).expect(409);

        expect(res.body).toEqual(VERSION_CONFLICT_BODY);
        const row = await fullRow(decisionId);
        expect(row?.status).toBe('PENDING');
        expect(row?.version).toBe(1);
        expect(row?.applicationOutcome).toBeNull();
      });
    });

    describe('404 missing / cross-tenant / foreign-source are indistinguishable', () => {
      it('returns the identical fixed 404 body with no-store for a missing, a cross-tenant and a foreign-source id', async () => {
        const tenantA = await seedTenant('ACK Miss Tenant A');
        const tenantB = await seedTenant('ACK Miss Tenant B');
        const reviewerId = await seedReviewerUser();
        const credentialA = await seedCredential({ tenantId: tenantA });
        const crossTenantId = await seedDecision(
          resolvedDecisionData(tenantB, reviewerId),
        );
        const foreignSourceId = await seedDecision(
          resolvedDecisionData(tenantA, reviewerId, {
            source: 'other-bot-source',
          }),
        );
        const missingId = crypto.randomUUID();

        const missing = await postAck(
          missingId,
          credentialA.token,
          acceptedBody(),
        ).expect(404);
        const crossTenant = await postAck(
          crossTenantId,
          credentialA.token,
          acceptedBody(),
        ).expect(404);
        const foreignSource = await postAck(
          foreignSourceId,
          credentialA.token,
          acceptedBody(),
        ).expect(404);

        expect(missing.body).toEqual(NOT_FOUND_BODY);
        expect(crossTenant.body).toEqual(NOT_FOUND_BODY);
        expect(foreignSource.body).toEqual(NOT_FOUND_BODY);
        expect(Object.keys(missing.body as object).sort()).toEqual(ERROR_KEYS);
        // The handler sets `no-store` BEFORE the port, so a handler-level miss
        // (404) still carries it.
        expect(missing.headers['cache-control']).toBe('no-store');
        expect(crossTenant.headers['cache-control']).toBe('no-store');
        expect(foreignSource.headers['cache-control']).toBe('no-store');
        // The real adapter answered each request (the port was reached).
        expect(recordSpy).toHaveBeenCalledTimes(3);

        // Non-vacuous: both "foreign" rows ARE committed in the dedicated DB
        // and stayed untransformed.
        await expect(fullRow(crossTenantId)).resolves.toMatchObject({
          tenantId: tenantB,
          source: RESTOCK_SOURCE,
          applicationOutcome: null,
        });
        await expect(fullRow(foreignSourceId)).resolves.toMatchObject({
          tenantId: tenantA,
          source: 'other-bot-source',
          applicationOutcome: null,
        });
      });
    });

    describe('canonical id + malformed body 400 with no ACK call and no decision mutation', () => {
      it('rejects the nil/uppercase/malformed id before the ACK port while the real guard still audits its credential use', async () => {
        const tenantId = await seedTenant('ACK 400 Tenant Id');
        const credential = await seedCredential({ tenantId });
        const decisionId = await seedDecision(
          resolvedDecisionData(tenantId, await seedReviewerUser()),
        );
        const before = await rawDecisionCount();

        // Sanity: the canonical lowercase id DOES reach the port (real 200).
        const canonical = await postAck(
          decisionId,
          credential.token,
          acceptedBody(),
        ).expect(200);
        expect(canonical.body).toMatchObject({ id: decisionId });
        expect(recordSpy).toHaveBeenCalledTimes(1);
        // The success above wrote the terminal outcome; reset it for a clean
        // cardinality check.
        await integrationPrisma().humanDecision.update({
          where: { id: decisionId },
          data: {
            applicationOutcome: null,
            applicationAttemptId: null,
            applicationEvidenceHash: null,
            applicationEvidenceCode: null,
            providerMessageId: null,
            providerAcceptedObservedAt: null,
            applicationAttemptedAt: null,
            ackReceivedAt: null,
          },
        });

        // Clear the audit timestamp so the rejected path's real auth write
        // becomes observable.
        await integrationPrisma().serviceCredential.update({
          where: { id: credential.id },
          data: { lastUsedAt: null },
        });

        recordSpy.mockClear();
        for (const badId of [
          NIL_UUID,
          decisionId.toUpperCase(),
          'not-a-uuid',
        ]) {
          const res = await postAck(
            badId,
            credential.token,
            acceptedBody(),
          ).expect(400);
          const body = res.body as Record<string, unknown>;

          expect(body).toEqual(VALIDATION_BODY);
          expect(Object.keys(body).sort()).toEqual(ERROR_KEYS);
          expect(JSON.stringify(body)).not.toContain('Invalid human decision');
          // No `no-store`: early 400s make no caching claim.
          expect(res.headers['cache-control']).toBeUndefined();
        }

        // SCOPED proof: no rejected id reached the ACK PORT. This is NOT a
        // "no database traffic" claim: the real guard already ran its
        // `service_credentials` SELECT and `lastUsedAt` UPDATE for each
        // rejected request, which the next assertion pins.
        expect(recordSpy).not.toHaveBeenCalled();
        const credentialAfter =
          await integrationPrisma().serviceCredential.findUnique({
            where: { id: credential.id },
          });
        expect(credentialAfter?.lastUsedAt).toBeInstanceOf(Date);

        // Raw-SQL decision-row cardinality is unchanged. Other tables
        // (`service_credentials.lastUsedAt`) are outside this count and DO
        // change, as asserted above.
        await expect(rawDecisionCount()).resolves.toBe(before);
      });

      it('sanitizes malformed JSON on the ACK route and its case/trailing-slash routing equivalents, keeps CORS, and never reaches the guard or the ACK port', async () => {
        const tenantId = await seedTenant('ACK 400 Tenant Json');
        const credential = await seedCredential({ tenantId });
        const decisionId = await seedDecision(
          resolvedDecisionData(tenantId, await seedReviewerUser()),
        );
        const rowBefore = await fullRow(decisionId);
        const before = await rawDecisionCount();
        // The credential starts without an audit timestamp; the parser runs
        // BEFORE the guard, so it must stay untouched.
        const credentialBefore =
          await integrationPrisma().serviceCredential.findUnique({
            where: { id: credential.id },
          });
        expect(credentialBefore?.lastUsedAt).toBeNull();

        const malformed = '{"pii":"SENTINEL","attemptId":"SENTINEL_ID"';
        // Express routing is case-insensitive and non-strict, so these URLs all
        // resolve to the SAME ACK route; the parser gate at HEAD mirrors that
        // with a case-insensitive pattern and one optional trailing slash. Each
        // variant must therefore reach the FIXED, value-free 400 envelope, not
        // Nest's default parser.
        const routingEquivalentUrls: string[] = [
          // Canonical exact path.
          ackUrl(decisionId),
          // Uppercase mount prefix and terminal segment.
          `${URL.toUpperCase()}/${decisionId}/APPLICATION-OUTCOME`,
          // Mixed-case terminal segment.
          `${URL}/${decisionId}/Application-Outcome`,
          // Exactly one trailing slash, with canonical and alternate casing.
          `${ackUrl(decisionId)}/`,
          `${URL.toUpperCase()}/${decisionId}/APPLICATION-OUTCOME/`,
        ];

        for (const variantUrl of routingEquivalentUrls) {
          const res = await http()
            .post(variantUrl)
            .set('Origin', 'https://sistem.houndfe.com')
            .set('Content-Type', 'application/json')
            .send(malformed)
            .expect('Access-Control-Allow-Origin', 'https://sistem.houndfe.com')
            .expect(400);
          const body = res.body as Record<string, unknown>;

          expect(body).toEqual(VALIDATION_BODY);
          expect(Object.keys(body).sort()).toEqual(ERROR_KEYS);
          const serialized = JSON.stringify(body);
          expect(serialized).not.toContain('SENTINEL');
          expect(serialized).not.toContain(decisionId);
          // A transport-level parser rejection makes no caching claim.
          expect(res.headers['cache-control']).toBeUndefined();
        }

        // SCOPED proof: every equivalent URL was sanitized BEFORE the guard, so
        // the ACK PORT, the credential audit and the decision row are all
        // untouched.
        expect(recordSpy).not.toHaveBeenCalled();
        await expect(rawDecisionCount()).resolves.toBe(before);
        const credentialAfter =
          await integrationPrisma().serviceCredential.findUnique({
            where: { id: credential.id },
          });
        expect(credentialAfter?.lastUsedAt).toBeNull();
        const rowAfter = await fullRow(decisionId);
        expect(rowAfter).toEqual(rowBefore);

        // Valid control on a routing-equivalent URL: a valid body still reaches
        // the controller (and reaches the real guard) and records. It targets a
        // SEPARATE decision, so the malformed-probe row above is never mutated.
        const controlId = await seedDecision(
          resolvedDecisionData(tenantId, await seedReviewerUser(), {
            sourceRequestId: crypto.randomUUID(),
          }),
        );
        const valid = await http()
          .post(`${URL.toUpperCase()}/${controlId}/Application-Outcome`)
          .set('Authorization', `Bearer ${credential.token}`)
          .send(acceptedBody() as object)
          .expect(200);
        expect((valid.body as { id: string }).id).toBe(controlId);
        expect(recordSpy).toHaveBeenCalledTimes(1);
        const controlRow = await fullRow(controlId);
        expect(controlRow?.applicationOutcome).toBe(PROVIDER_ACCEPTED);
        // The malformed-probe decision stays byte-identical even after the
        // valid case-variant control records a different decision.
        await expect(fullRow(decisionId)).resolves.toEqual(rowBefore);
      });
    });

    describe('service credential authentication (401)', () => {
      it.each([
        ['a missing bearer token', null],
        ['a non-service bearer token', 'customer_jwt_token'],
        ['an unknown service token', 'svc_hd05c2b_unknown'],
      ])(
        'returns the sanitized 401 for %s and never reaches the ACK port',
        async (_label, token) => {
          const tenantId = await seedTenant('ACK 401 Tenant');
          const decisionId = await seedDecision(
            resolvedDecisionData(tenantId, await seedReviewerUser()),
          );
          const before = await fullRow(decisionId);

          const res =
            token === null
              ? // No Authorization header at all.
                await http()
                  .post(ackUrl(decisionId))
                  .send(acceptedBody() as object)
                  .expect(401)
              : await postAck(decisionId, token, acceptedBody()).expect(401);

          expect(res.body).toEqual(UNAUTHORIZED_BODY);
          expect(Object.keys(res.body as object).sort()).toEqual(ERROR_KEYS);
          expect(recordSpy).not.toHaveBeenCalled();
          const after = await fullRow(decisionId);
          expect(after?.applicationOutcome).toBeNull();
          expect(after?.updatedAt.toISOString()).toBe(
            before?.updatedAt.toISOString(),
          );
        },
      );

      it.each([
        ['an inactive credential', { isActive: false }],
        [
          'a revoked credential',
          { revokedAt: new Date('2026-06-02T00:00:00.000Z') },
        ],
      ])('returns the sanitized 401 for %s', async (_label, overrides) => {
        const tenantId = await seedTenant('ACK 401 State Tenant');
        const credential = await seedCredential({ tenantId, ...overrides });
        const decisionId = await seedDecision(
          resolvedDecisionData(tenantId, await seedReviewerUser()),
        );

        const res = await postAck(
          decisionId,
          credential.token,
          acceptedBody(),
        ).expect(401);

        expect(res.body).toEqual(UNAUTHORIZED_BODY);
        expect(recordSpy).not.toHaveBeenCalled();
      });
    });

    describe('service credential authorization (403)', () => {
      it.each([
        ['a create-only credential', ['human-decisions:create']],
        ['a read-only credential', ['human-decisions:read']],
      ])(
        'returns the sanitized 403 for %s and never reaches the ACK port',
        async (_label, scopes) => {
          const tenantId = await seedTenant('ACK 403 Scope Tenant');
          const credential = await seedCredential({ tenantId, scopes });
          const decisionId = await seedDecision(
            resolvedDecisionData(tenantId, await seedReviewerUser()),
          );

          const res = await postAck(
            decisionId,
            credential.token,
            acceptedBody(),
          ).expect(403);

          expect(res.body).toEqual(FORBIDDEN_BODY);
          expect(Object.keys(res.body as object).sort()).toEqual(ERROR_KEYS);
          expect(JSON.stringify(res.body)).not.toContain(credential.id);
          expect(res.headers['cache-control']).toBeUndefined();
          expect(recordSpy).not.toHaveBeenCalled();
        },
      );

      it('returns the sanitized 403 for a foreign x-branch-id and does not ACK the other tenant row', async () => {
        const tenantA = await seedTenant('ACK Branch Tenant A');
        const tenantB = await seedTenant('ACK Branch Tenant B');
        const credentialA = await seedCredential({ tenantId: tenantA });
        const idB = await seedDecision(
          resolvedDecisionData(tenantB, await seedReviewerUser()),
        );

        const foreignBranch = await http()
          .post(ackUrl(idB))
          .set('Authorization', `Bearer ${credentialA.token}`)
          .set('x-branch-id', tenantB)
          .send(acceptedBody() as object)
          .expect(403);

        expect(foreignBranch.body).toEqual(FORBIDDEN_BODY);
        expect(recordSpy).not.toHaveBeenCalled();
        const rowB = await fullRow(idB);
        expect(rowB?.applicationOutcome).toBeNull();

        // The SAME header pinned to the credential's own tenant is accepted,
        // proving the header value — not the header itself — drove the 403.
        const idA = await seedDecision(
          resolvedDecisionData(tenantA, await seedReviewerUser()),
        );
        await http()
          .post(ackUrl(idA))
          .set('Authorization', `Bearer ${credentialA.token}`)
          .set('x-branch-id', tenantA)
          .send(acceptedBody() as object)
          .expect(200);
        expect(recordSpy).toHaveBeenCalledWith({
          decisionId: idA,
          request: parseBotApplicationOutcomeRequest(acceptedBody()),
        });
      });
    });

    describe('credential rate limit (429)', () => {
      it('serves the first ACK then returns the sanitized 429 with Retry-After', async () => {
        const tenantId = await seedTenant('ACK 429 Tenant');
        const credential = await seedCredential({ tenantId, rateLimit: 1 });
        const decisionId = await seedDecision(
          resolvedDecisionData(tenantId, await seedReviewerUser()),
        );

        await postAck(decisionId, credential.token, acceptedBody()).expect(200);

        const limited = await postAck(
          decisionId,
          credential.token,
          acceptedBody({ attemptId: OTHER_ATTEMPT_ID }),
        ).expect(429);
        expect(limited.body).toEqual(RATE_LIMITED_BODY);
        expect(Object.keys(limited.body as object).sort()).toEqual(ERROR_KEYS);
        expect(limited.headers['retry-after']).toBeDefined();
        expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
        // The second request was rejected before the ACK port.
        expect(recordSpy).toHaveBeenCalledTimes(1);
      });
    });

    describe('real concurrent distinct ACK HTTP requests (no forced interleaving claimed)', () => {
      it('yields a single terminal outcome and a 409 loser for two simultaneous distinct attempts', async () => {
        const tenantId = await seedTenant('ACK Race Tenant');
        const reviewerId = await seedReviewerUser();
        const credential = await seedCredential({ tenantId });
        const decisionId = await seedDecision(
          resolvedDecisionData(tenantId, reviewerId),
        );

        // Both HTTP requests are in flight at once. No scheduling barrier is
        // installed: the invariant asserted below holds for every interleaving,
        // and the deterministic barrier-forced race lives in the DB adapter
        // spec.
        const [first, second] = await Promise.all([
          postAck(
            decisionId,
            credential.token,
            acceptedBody({ attemptId: ATTEMPT_ID }),
          ),
          postAck(
            decisionId,
            credential.token,
            acceptedBody({ attemptId: OTHER_ATTEMPT_ID }),
          ),
        ]);

        const statuses = [first.status, second.status].sort();
        expect(statuses).toEqual([200, 409]);

        const winner = first.status === 200 ? first : second;
        const loser = first.status === 200 ? second : first;
        expect(loser.body).toEqual(OUTCOME_ALREADY_RECORDED_BODY);
        expect(Object.keys(winner.body as object).sort()).toEqual(
          RESPONSE_KEYS,
        );

        const row = await fullRow(decisionId);
        const winnerAttempt = (winner.body as { attemptId: string }).attemptId;
        expect([ATTEMPT_ID, OTHER_ATTEMPT_ID]).toContain(winnerAttempt);
        expect(row?.applicationAttemptId).toBe(winnerAttempt);
        expect(row?.applicationOutcome).toBe(PROVIDER_ACCEPTED);
        // Exactly one durable terminal row.
        await expect(
          integrationPrisma().humanDecision.count({
            where: { tenantId, applicationOutcome: { not: null } },
          }),
        ).resolves.toBe(1);
      });
    });

    describe('real parallel A/B ALS isolation', () => {
      it('keeps two simultaneous tenant A/B ACK requests disjoint and correctly scoped', async () => {
        const tenantA = await seedTenant('ACK Als Tenant A');
        const tenantB = await seedTenant('ACK Als Tenant B');
        const reviewerId = await seedReviewerUser();
        const credentialA = await seedCredential({ tenantId: tenantA });
        const credentialB = await seedCredential({ tenantId: tenantB });
        const idA = await seedDecision(
          resolvedDecisionData(tenantA, reviewerId),
        );
        const idB = await seedDecision(
          resolvedDecisionData(tenantB, reviewerId),
        );

        // Both HTTP requests are in flight at once; the express `ClsMiddleware`
        // opens one ALS store per request, so neither can borrow the other's
        // trusted tenant.
        const [resA, resB] = await Promise.all([
          postAck(idA, credentialA.token, acceptedBody()).expect(200),
          postAck(idB, credentialB.token, acceptedBody()).expect(200),
        ]);

        expect((resA.body as { id: string }).id).toBe(idA);
        expect((resB.body as { id: string }).id).toBe(idB);

        const rowA = await fullRow(idA);
        const rowB = await fullRow(idB);
        expect(rowA?.tenantId).toBe(tenantA);
        expect(rowB?.tenantId).toBe(tenantB);
        expect(rowA?.applicationOutcome).toBe(PROVIDER_ACCEPTED);
        expect(rowB?.applicationOutcome).toBe(PROVIDER_ACCEPTED);
        expect(rowA?.submittedCredentialId).toBe(SUBMITTED_CREDENTIAL_ID);
        // Only the two targeted rows were written.
        await expect(
          integrationPrisma().humanDecision.count({
            where: { applicationOutcome: { not: null } },
          }),
        ).resolves.toBe(2);
        // Real nestjs-cls service, and no ambient tenant outside a request.
        expect(cls).toBeInstanceOf(ClsService);
        expect(cls.isActive()).toBe(false);
      });
    });
  },
);
