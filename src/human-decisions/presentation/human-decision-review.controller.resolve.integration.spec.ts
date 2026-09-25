/**
 * HD-04d2b — guarded HUMAN reviewer RESOLVE route against REAL PostgreSQL +
 * REAL nestjs-cls AsyncLocalStorage.
 *
 * Approved design (read-only):
 * `houndfe-chatbot-human-decisions/docs/human-decisions-contract-v1.md`.
 *
 * What this spec proves that the HD-04d2a mocked HTTP spec could not: the
 * guarded WRITE route runs end to end through the REAL components and a real
 * database —
 *
 *   Supertest → real `HumanDecisionHttpFilter` (controller-scoped) →
 *   real `JwtStrategy` + real `JwtAuthGuard` (test-only secret) →
 *   real `TenantContextGuard` → real `HumanDecisionActiveReviewerGuard`
 *   (current-account admission) → real `PermissionsGuard` + real
 *   `CaslAbilityFactory` reading the ACTUAL `RolePermission` grants from
 *   PostgreSQL → real nestjs-cls `ClsService` ALS store opened by
 *   `ClsModule.forRoot({ middleware: { mount: true } })` →
 *   real `HumanDecisionReviewController.resolve` + the EXACT pure
 *   `parseResolveHumanDecisionRequest` → real
 *   `PrismaHumanDecisionReviewResolveRepository` → real
 *   `TenantPrismaService` (CLS-driven `tenantId` WHERE injection) → real
 *   `PrismaService` → committed `HumanDecision` rows in the dedicated test
 *   database.
 *
 * The real route is exercised, so this spec also re-proves the transport seams
 * over a live DB: the route-scoped sanitizing body parser
 * (`installHumanDecisionBodyParser`, mounted AFTER `enableCors` and BEFORE
 * `app.init()`) keeps the allowlisted CORS header on malformed-body
 * short-circuits, and the exact 3-key value-free envelope never echoes input.
 *
 * Deliberately NOT booted: the full `AppModule` (or `HumanDecisionsModule` /
 * `ChatbotApiModule`), because their transitive imports pull Inngest / mail /
 * provider / outbox registrars. This spec assembles a minimal Nest
 * `TestingModule` with only the real pieces under test, plus `DatabaseModule`
 * (global Prisma + TenantPrisma providers) and the same global
 * `ValidationPipe`/filters that `main.ts` installs. Module wiring
 * (`HumanDecisionsModule` imports `AuthModule` and binds BOTH the read and the
 * resolve ports to their Prisma adapters) is asserted via controller/module
 * METADATA, never by booting the full graph. The global
 * `DomainExceptionFilter`/`PrismaExceptionFilter` are REAL so the scoped
 * filter's precedence over them is exercised, not assumed.
 *
 * Deliberately mocked (and only this): nothing in the request/authorization/
 * resolve path. There is NO mocked user, ability, read port or resolve port.
 * The ONLY non-production substitutions are the test-only `ConfigService`
 * (pinned `JWT_SECRET`) and the JWT signing helper used to mint principal
 * tokens. No provider, no bot, no network, no listen port (`app.init()` only).
 * The bot intake route is intentionally absent — the committed decision rows
 * are seeded directly, so no historical bot intake receipt is part of this
 * selected graph. This spec makes NO claim about provider delivery, the bot
 * ACK/poll or the intake route.
 *
 * ADAPTER OUTCOME IS NOT PRODUCED HERE: a successful resolve writes ONLY the
 * decision resolution columns. The bot application outcome/provider/evidence
 * columns stay NULL until a later bot ACK slice; this spec pins that
 * "pending/unapplied until bot ACK, no automatic apply" state directly on the
 * row and on the response.
 *
 * ISOLATED-DB GUARD: before every baseline reset (and at module load) the spec
 * validates BOTH the `.env.test` file parsed with the local `dotenv` and the
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
 * be the only destination check: every invocation requires the separate
 * pre-Jest destination precheck (see the HD-04d2b task record for the exact
 * command).
 *
 * Skip guard: `SKIP_DB_INTEGRATION=1` or an unset `DATABASE_URL` skips the
 * whole suite, matching the other integration specs.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import type { Prisma } from '@prisma/client';
import * as dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ClsModule, ClsService } from 'nestjs-cls';
import request from 'supertest';
import {
  disconnectIntegrationPrisma,
  integrationPrisma,
  resetAndSeedBaseline,
} from '../../../test/integration/reset-db';
import { AuthModule } from '../../auth/auth.module';
import { CaslAbilityFactory } from '../../auth/authorization/casl-ability.factory';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { JwtStrategy } from '../../auth/infrastructure/strategies/jwt.strategy';
import { DomainExceptionFilter } from '../../shared/filters/domain-exception.filter';
import { PrismaExceptionFilter } from '../../shared/filters/prisma-exception.filter';
import { createListingValidationExceptionFactory } from '../../shared/listing/listing-validation-exception.factory';
import { DatabaseModule } from '../../shared/prisma/prisma.module';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { HUMAN_DECISION_REVIEW_READ_REPOSITORY } from '../domain/human-decision-review-read.repository';
import { HUMAN_DECISION_REVIEW_RESOLVE_REPOSITORY } from '../domain/human-decision-review-resolve.repository';
import {
  RESTOCK_SOURCE,
  RESTOCK_TYPE,
} from '../domain/restock-request-canonicalizer';
import { HumanDecisionsModule } from '../human-decisions.module';
import { PrismaHumanDecisionReviewReadRepository } from '../infrastructure/prisma-human-decision-review-read.repository';
import { PrismaHumanDecisionReviewResolveRepository } from '../infrastructure/prisma-human-decision-review-resolve.repository';
import { installHumanDecisionBodyParser } from './filters/human-decision-body-parser';
import { HumanDecisionHttpFilter } from './filters/human-decision-http.filter';
import { HumanDecisionActiveReviewerGuard } from './guards/human-decision-active-reviewer.guard';
import { HumanDecisionReviewController } from './human-decision-review.controller';

const LIST_URL = '/human-decisions';

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
      `[hd-04d2b] refusing isolated-DB run: ${SOURCE_LABELS[source]} DATABASE_URL is unset.`,
    );
  }

  let url: globalThis.URL;
  try {
    url = new globalThis.URL(rawUrl);
  } catch {
    throw new Error(
      `[hd-04d2b] refusing isolated-DB run: ${SOURCE_LABELS[source]} DATABASE_URL is not a valid URL.`,
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
      `[hd-04d2b] refusing isolated-DB run: ${SOURCE_LABELS[source]} DATABASE_URL does not match the dedicated isolated RESTOCK target.`,
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
      `[hd-04d2b] isolated DB target OK: ${EXPECTED_PROTOCOL}//${EXPECTED_HOSTNAME}:${EXPECTED_PORT}/${EXPECTED_DATABASE}`,
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
// Constants, fixtures and helpers
// ---------------------------------------------------------------------------

const TEST_SECRET = 'hd-04d2b-test-secret-not-a-production-key';

/** Allowlisted browser FE origin wired into the test app's CORS config. */
const ALLOWED_ORIGIN = 'https://allowed.hd04d2b.test';

const jwtService = new JwtService({
  secret: TEST_SECRET,
  signOptions: { expiresIn: '1h' },
});

const POSITIVE_ACTION = 'PROVIDE_RESTOCK_ESTIMATE';
const NEGATIVE_ACTION = 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE';

const ERROR_ENVELOPE_KEYS = ['code', 'message', 'statusCode'];

/** Exact reviewer projection top-level key set (literal, never derived). */
const RESPONSE_KEYS = [
  'allowedActions',
  'createdAt',
  'id',
  'resolution',
  'sanitizedSummary',
  'snapshot',
  'status',
  'title',
  'type',
  'version',
];

/** Exact nested `snapshot` key set (sorted). */
const SNAPSHOT_RESPONSE_KEYS = [
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

/** Exact positive resolution key set (sorted), including `restockDays`. */
const POSITIVE_RESOLUTION_KEYS = [
  'action',
  'resolvedAt',
  'resolvedBy',
  'restockDays',
];

/** Exact negative resolution key set (sorted): `restockDays` MUST be absent. */
const NEGATIVE_RESOLUTION_KEYS = ['action', 'resolvedAt', 'resolvedBy'];

/** Exact `resolvedBy` key set (sorted). */
const RESOLVED_BY_KEYS = ['displayName', 'id'];

/** Keys that must NEVER appear on a human reviewer resolve projection. */
const FORBIDDEN_KEYS = [
  'source',
  'tenantId',
  'sourceRequestId',
  'canonicalRequestHash',
  'submittedCredentialId',
  'supersedesDecisionId',
  'applyBefore',
  'resolutionRequestId',
  'resolvedById',
  'applicationOutcome',
  'applicationAttemptId',
  'applicationEvidenceHash',
  'providerMessageId',
  'ackReceivedAt',
  'pii',
  'customerPhone',
];

const RESTOCK_TITLE = 'Solicitud de reposición de stock';
const RESTOCK_SANITIZED_SUMMARY =
  'El chatbot solicitó una estimación de reposición de stock para un producto.';

/** Stable, deterministic fixture identities (no random ids for assertions). */
const DECISION_ID = '2b7c1a90-6f3e-4d2a-8b1c-0d9e8f7a6b5c';
const STABLE_PRODUCT_ID = '8f14e45f-ceea-4e42-9f62-1a2b3c4d5e6f';
const STABLE_VARIANT_ID = '550e8400-e29b-41d4-a716-446655440000';
const STABLE_CREATED_AT = new Date('2026-04-01T10:00:00.000Z');
const STABLE_OBSERVED_AT = new Date('2026-03-31T23:30:00.000Z');
const RESOLUTION_REQUEST_ID = '3f1c1b7a-9c2e-4d5f-8a6b-1c2d3e4f5a6b';
const RESOLUTION_REQUEST_ID_ALT = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const SUBMITTED_CREDENTIAL_ID = 'cred-hd04d2b';

const EXPECTED_SNAPSHOT = {
  branchId: 'branch-stable',
  branchName: 'Sucursal Centro',
  productId: STABLE_PRODUCT_ID,
  productName: 'Filtro de aceite',
  variantId: STABLE_VARIANT_ID,
  sku: 'SKU-STABLE',
  requestedQuantity: 3,
  observedStockAtRequest: 2,
  stockObservedAt: STABLE_OBSERVED_AT.toISOString(),
};

const MANAGER_A_NAME = 'Manager A';
const MANAGER_A2_NAME = 'Manager A2';

interface TokenClaims {
  sub: string;
  email: string;
  tenantId: string | null;
  tenantSlug: string | null;
  isSuperAdmin: boolean;
}

function signToken(claims: TokenClaims): string {
  return jwtService.sign(claims);
}

/** Persist one tenant and return its id. */
async function seedTenant(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await integrationPrisma().tenant.create({
    data: { id, name, slug: `hd04d2b-${id}` },
  });
  return id;
}

/** Upsert one registry permission; `permissions` survives the tenant truncate. */
async function seedPermission(subject: string, action: string) {
  return integrationPrisma().permission.upsert({
    where: { subject_action: { subject, action } },
    update: {},
    create: { subject, action, description: `${action} ${subject}` },
  });
}

async function seedRole(tenantId: string, name: string) {
  return integrationPrisma().role.create({ data: { tenantId, name } });
}

async function grant(roleId: string, permissionId: string): Promise<void> {
  await integrationPrisma().rolePermission.create({
    data: { roleId, permissionId },
  });
}

/** Create an active/inactive User plus its TenantMembership and return its id. */
async function seedMember(params: {
  tenantId: string;
  roleId: string;
  email: string;
  name: string;
  isActive?: boolean;
}): Promise<string> {
  const id = crypto.randomUUID();
  await integrationPrisma().user.create({
    data: {
      id,
      email: params.email,
      name: params.name,
      hashedPassword: 'not-a-real-hash',
      isActive: params.isActive ?? true,
    },
  });
  await integrationPrisma().tenantMembership.create({
    data: { userId: id, tenantId: params.tenantId, roleId: params.roleId },
  });
  return id;
}

/**
 * Valid PENDING fixture: status/version defaults plus the immutable intake
 * snapshot. `productId`/`variantId` are canonical RFC 4122 UUIDs and
 * `observedStockAtRequest`/`stockObservedAt` are a valid pair so the pure
 * reviewer mapper accepts the persisted row without normalizing anything.
 * `submittedCredentialId` stands in for the historical bot intake audit, which
 * this selected graph never reads or writes.
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
    submittedCredentialId: SUBMITTED_CREDENTIAL_ID,
    branchId: 'branch-stable',
    branchName: 'Sucursal Centro',
    productId: STABLE_PRODUCT_ID,
    productName: 'Filtro de aceite',
    variantId: STABLE_VARIANT_ID,
    sku: 'SKU-STABLE',
    requestedQuantity: 3,
    observedStockAtRequest: 2,
    stockObservedAt: STABLE_OBSERVED_AT,
    status: 'PENDING',
    version: 1,
    createdAt: STABLE_CREATED_AT,
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

/** Well-formed positive body; the four exact keys only. */
function positiveBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    action: POSITIVE_ACTION,
    restockDays: 7,
    expectedVersion: 1,
    resolutionRequestId: RESOLUTION_REQUEST_ID,
    ...overrides,
  };
}

/** Well-formed negative body; `restockDays` is deliberately ABSENT. */
function negativeBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    action: NEGATIVE_ACTION,
    expectedVersion: 1,
    resolutionRequestId: RESOLUTION_REQUEST_ID,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Real RBAC world (real Permission/Role/RolePermission/User/Membership rows)
// ---------------------------------------------------------------------------

interface ResolveWorld {
  tenantA: string;
  tenantB: string;
  managerAId: string;
  managerA2Id: string;
  managerBId: string;
  inactiveAId: string;
  deletedAId: string;
  tokens: {
    managerA: string;
    managerA2: string;
    cashierA: string;
    noReadA: string;
    inactiveA: string;
    deletedA: string;
    managerB: string;
    superTenantless: string;
  };
}

/**
 * Seed two tenants with REAL role grants: Manager gets read+update on
 * `HumanDecision`, Cashier gets read only, and a NoRead reviewer role gets
 * neither. The inactive manager token and the deleted-account token prove the
 * current-account admission guard against committed state.
 */
async function seedResolveWorld(): Promise<ResolveWorld> {
  const [readPermission, updatePermission, saleReadPermission] =
    await Promise.all([
      seedPermission('HumanDecision', 'read'),
      seedPermission('HumanDecision', 'update'),
      seedPermission('Sale', 'read'),
    ]);

  const tenantA = await seedTenant('Centro A');
  const tenantB = await seedTenant('Centro B');

  const managerARole = await seedRole(tenantA, 'Manager');
  const cashierARole = await seedRole(tenantA, 'Cashier');
  const noReadARole = await seedRole(tenantA, 'NoReadReviewer');
  const managerBRole = await seedRole(tenantB, 'Manager');

  await Promise.all([
    grant(managerARole.id, readPermission.id),
    grant(managerARole.id, updatePermission.id),
    grant(cashierARole.id, readPermission.id),
    grant(noReadARole.id, saleReadPermission.id),
    grant(managerBRole.id, readPermission.id),
    grant(managerBRole.id, updatePermission.id),
  ]);

  const managerAId = await seedMember({
    tenantId: tenantA,
    roleId: managerARole.id,
    email: 'manager.a@hd04d2b.test',
    name: MANAGER_A_NAME,
  });
  const managerA2Id = await seedMember({
    tenantId: tenantA,
    roleId: managerARole.id,
    email: 'manager.a2@hd04d2b.test',
    name: MANAGER_A2_NAME,
  });
  const cashierA = await seedMember({
    tenantId: tenantA,
    roleId: cashierARole.id,
    email: 'cashier.a@hd04d2b.test',
    name: 'Cashier A',
  });
  const noReadA = await seedMember({
    tenantId: tenantA,
    roleId: noReadARole.id,
    email: 'noread.a@hd04d2b.test',
    name: 'No Read A',
  });
  const inactiveAId = await seedMember({
    tenantId: tenantA,
    roleId: managerARole.id,
    email: 'inactive.a@hd04d2b.test',
    name: 'Inactive A',
    isActive: false,
  });
  const managerB = await seedMember({
    tenantId: tenantB,
    roleId: managerBRole.id,
    email: 'manager.b@hd04d2b.test',
    name: 'Manager B',
  });

  // No User row is ever created for this subject, so the deleted-token test
  // proves the subject is genuinely absent (distinct from the deactivated
  // account, which DOES exist with isActive=false).
  const deletedAId = crypto.randomUUID();

  return {
    tenantA,
    tenantB,
    managerAId,
    managerA2Id,
    managerBId: managerB,
    inactiveAId,
    deletedAId,
    tokens: {
      managerA: signToken({
        sub: managerAId,
        email: 'manager.a@hd04d2b.test',
        tenantId: tenantA,
        tenantSlug: 'centro-a',
        isSuperAdmin: false,
      }),
      managerA2: signToken({
        sub: managerA2Id,
        email: 'manager.a2@hd04d2b.test',
        tenantId: tenantA,
        tenantSlug: 'centro-a',
        isSuperAdmin: false,
      }),
      cashierA: signToken({
        sub: cashierA,
        email: 'cashier.a@hd04d2b.test',
        tenantId: tenantA,
        tenantSlug: 'centro-a',
        isSuperAdmin: false,
      }),
      noReadA: signToken({
        sub: noReadA,
        email: 'noread.a@hd04d2b.test',
        tenantId: tenantA,
        tenantSlug: 'centro-a',
        isSuperAdmin: false,
      }),
      inactiveA: signToken({
        sub: inactiveAId,
        email: 'inactive.a@hd04d2b.test',
        tenantId: tenantA,
        tenantSlug: 'centro-a',
        isSuperAdmin: false,
      }),
      // No User row exists for this subject.
      deletedA: signToken({
        sub: deletedAId,
        email: 'deleted.a@hd04d2b.test',
        tenantId: tenantA,
        tenantSlug: 'centro-a',
        isSuperAdmin: false,
      }),
      managerB: signToken({
        sub: managerB,
        email: 'manager.b@hd04d2b.test',
        tenantId: tenantB,
        tenantSlug: 'centro-b',
        isSuperAdmin: false,
      }),
      // Tenantless global superadmin: passes TenantContextGuard but must be
      // stopped by the route's active-reviewer tenant gate.
      superTenantless: signToken({
        sub: crypto.randomUUID(),
        email: 'super@hd04d2b.test',
        tenantId: null,
        tenantSlug: null,
        isSuperAdmin: true,
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeIfDb(
  'Human decision resolve HTTP integration (HD-04d2b PostgreSQL + real ALS)',
  () => {
    let app: INestApplication;
    let world: ResolveWorld;

    const http = () =>
      request(app.getHttpServer() as import('node:http').Server);

    const resolveUrl = (id: string = DECISION_ID) =>
      `${LIST_URL}/${id}/resolve`;

    const postResolve = (
      id: string,
      body: unknown,
      token: string | null = world.tokens.managerA,
    ) => {
      const builder = http().post(resolveUrl(id));
      return token
        ? builder.set('Authorization', `Bearer ${token}`).send(body as object)
        : builder.send(body as object);
    };

    beforeAll(async () => {
      // Force the singleton construction early so a misconfigured
      // DATABASE_URL throws here (loud) rather than in the first test.
      integrationPrisma();
      await resetIsolatedBaseline();

      const moduleRef = await Test.createTestingModule({
        imports: [
          // REAL bearer strategy registration.
          PassportModule.register({ defaultStrategy: 'jwt' }),
          // REAL nestjs-cls with the express middleware mount: this opens the
          // per-request ALS store `TenantContextGuard` writes `tenantId` into
          // and the resolve adapter reads back. No Map shim anywhere.
          ClsModule.forRoot({ global: true, middleware: { mount: true } }),
          // REAL global Prisma + TenantPrisma providers.
          DatabaseModule,
        ],
        controllers: [HumanDecisionReviewController],
        providers: [
          HumanDecisionHttpFilter,
          JwtStrategy,
          JwtAuthGuard,
          TenantContextGuard,
          PermissionsGuard,
          // REAL CASL factory: it reads the actual RolePermission grants.
          CaslAbilityFactory,
          HumanDecisionActiveReviewerGuard,
          {
            // The ONLY substitution outside the real graph: a test-only secret
            // so the spec can mint its own principals.
            provide: ConfigService,
            useValue: {
              getOrThrow: jest.fn(() => TEST_SECRET),
              get: jest.fn(() => TEST_SECRET),
            },
          },
          {
            // REAL read adapter (the controller still injects it).
            provide: HUMAN_DECISION_REVIEW_READ_REPOSITORY,
            useClass: PrismaHumanDecisionReviewReadRepository,
          },
          {
            // REAL resolve adapter against the dedicated DB.
            provide: HUMAN_DECISION_REVIEW_RESOLVE_REPOSITORY,
            useClass: PrismaHumanDecisionReviewResolveRepository,
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
      app.enableCors({ origin: ALLOWED_ORIGIN, credentials: true });
      installHumanDecisionBodyParser(app);

      await app.init();
    });

    beforeEach(async () => {
      world = await seedResolveWorld();
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
          expect(message).toContain('[hd-04d2b]');
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

    describe('module wiring (metadata only, no AppModule boot)', () => {
      it('imports AuthModule and binds the read AND resolve ports to the Prisma adapters', () => {
        const imports = (Reflect.getMetadata(
          MODULE_METADATA.IMPORTS,
          HumanDecisionsModule,
        ) ?? []) as unknown[];
        const controllers = (Reflect.getMetadata(
          MODULE_METADATA.CONTROLLERS,
          HumanDecisionsModule,
        ) ?? []) as unknown[];
        const providers = (Reflect.getMetadata(
          MODULE_METADATA.PROVIDERS,
          HumanDecisionsModule,
        ) ?? []) as Array<{ provide?: unknown; useClass?: unknown }>;

        expect(imports).toContain(AuthModule);
        expect(controllers).toContain(HumanDecisionReviewController);

        const readBinding = providers.find(
          (provider) =>
            provider?.provide === HUMAN_DECISION_REVIEW_READ_REPOSITORY,
        );
        expect(readBinding?.useClass).toBe(
          PrismaHumanDecisionReviewReadRepository,
        );

        const resolveBinding = providers.find(
          (provider) =>
            provider?.provide === HUMAN_DECISION_REVIEW_RESOLVE_REPOSITORY,
        );
        expect(resolveBinding?.useClass).toBe(
          PrismaHumanDecisionReviewResolveRepository,
        );
      });
    });

    describe('authentication (401)', () => {
      it('rejects a missing bearer token with a sanitized 401', async () => {
        const res = await postResolve(DECISION_ID, positiveBody(), null).expect(
          401,
        );

        expect(res.body).toEqual({
          statusCode: 401,
          code: 'UNAUTHORIZED',
          message: 'Unauthorized',
        });
        expect(Object.keys(res.body as object).sort()).toEqual(
          ERROR_ENVELOPE_KEYS,
        );
      });

      it('rejects an invalid bearer token with a sanitized 401', async () => {
        const res = await http()
          .post(resolveUrl())
          .set('Authorization', 'Bearer not-a-valid-jwt')
          .send(positiveBody())
          .expect(401);

        expect(res.body).toEqual({
          statusCode: 401,
          code: 'UNAUTHORIZED',
          message: 'Unauthorized',
        });
      });

      it('rejects a valid JWT for a deactivated or deleted User with a sanitized 401', async () => {
        // Prove the committed account state BEFORE the request: a real User row
        // with isActive=false and an ACTIVE tenant membership. The rejection is
        // therefore the admission guard reading real PostgreSQL state, not a
        // missing row or a missing grant.
        const account = await integrationPrisma().user.findUnique({
          where: { id: world.inactiveAId },
          select: { isActive: true },
        });
        expect(account).toEqual({ isActive: false });
        const membership = await integrationPrisma().tenantMembership.findFirst(
          { where: { userId: world.inactiveAId } },
        );
        expect(membership?.tenantId).toBe(world.tenantA);

        const inactive = await postResolve(
          DECISION_ID,
          positiveBody(),
          world.tokens.inactiveA,
        ).expect(401);
        // Distinct from the deactivated case: this subject has NO User row.
        await expect(
          integrationPrisma().user.findUnique({
            where: { id: world.deletedAId },
          }),
        ).resolves.toBeNull();
        const deleted = await postResolve(
          DECISION_ID,
          positiveBody(),
          world.tokens.deletedA,
        ).expect(401);

        const expected = {
          statusCode: 401,
          code: 'UNAUTHORIZED',
          message: 'Unauthorized',
        };
        expect(inactive.body).toEqual(expected);
        expect(deleted.body).toEqual(expected);
      });
    });

    describe('authorization (403) before the resolve write', () => {
      it('rejects a Cashier without update:HumanDecision and writes nothing', async () => {
        const decisionId = await seedDecision(
          pendingDecisionData(world.tenantA),
        );

        const res = await postResolve(
          decisionId,
          positiveBody(),
          world.tokens.cashierA,
        ).expect(403);

        expect(res.body).toEqual({
          statusCode: 403,
          code: 'FORBIDDEN',
          message: 'Forbidden',
        });
        expect(Object.keys(res.body as object).sort()).toEqual(
          ERROR_ENVELOPE_KEYS,
        );

        // Non-vacuous: the row really is committed and still PENDING.
        await expect(
          integrationPrisma().humanDecision.findUniqueOrThrow({
            where: { id: decisionId },
          }),
        ).resolves.toMatchObject({ status: 'PENDING', version: 1 });
        await expect(totalDecisionRows()).resolves.toBe(1);
      });

      it('rejects a reviewer whose role lacks HumanDecision permissions and writes nothing', async () => {
        const decisionId = await seedDecision(
          pendingDecisionData(world.tenantA),
        );

        const res = await postResolve(
          decisionId,
          positiveBody(),
          world.tokens.noReadA,
        ).expect(403);

        expect(res.body).toEqual({
          statusCode: 403,
          code: 'FORBIDDEN',
          message: 'Forbidden',
        });
        await expect(
          integrationPrisma().humanDecision.findUniqueOrThrow({
            where: { id: decisionId },
          }),
        ).resolves.toMatchObject({ status: 'PENDING', version: 1 });
      });

      it('rejects a tenantless superadmin with a sanitized 403 and writes nothing', async () => {
        const decisionId = await seedDecision(
          pendingDecisionData(world.tenantA),
        );

        const res = await postResolve(
          decisionId,
          positiveBody(),
          world.tokens.superTenantless,
        ).expect(403);

        expect(res.body).toEqual({
          statusCode: 403,
          code: 'FORBIDDEN',
          message: 'Forbidden',
        });
        expect(Object.keys(res.body as object).sort()).toEqual(
          ERROR_ENVELOPE_KEYS,
        );
        await expect(
          integrationPrisma().humanDecision.findUniqueOrThrow({
            where: { id: decisionId },
          }),
        ).resolves.toMatchObject({ status: 'PENDING', version: 1 });
      });
    });

    describe('manager POSITIVE resolve (200 exact FE projection)', () => {
      it('commits version 2 with the immutable reviewer snapshot and returns only the resolved projection', async () => {
        const decisionId = await seedDecision(
          pendingDecisionData(world.tenantA, { id: DECISION_ID }),
        );

        const res = await postResolve(
          decisionId,
          positiveBody({ restockDays: 7 }),
        ).expect(200);
        const body = res.body as Record<string, unknown>;
        const resolution = body.resolution as Record<string, unknown>;

        // Pin the EXACT allowlisted key sets as literals, never derived from
        // the mapper implementation under test.
        expect(Object.keys(body).sort()).toEqual(RESPONSE_KEYS);
        expect(Object.keys(body.snapshot as object).sort()).toEqual(
          SNAPSHOT_RESPONSE_KEYS,
        );
        expect(Object.keys(resolution).sort()).toEqual(
          POSITIVE_RESOLUTION_KEYS,
        );
        expect(Object.keys(resolution.resolvedBy as object).sort()).toEqual(
          RESOLVED_BY_KEYS,
        );

        // The persisted row is the source of truth for the server clock.
        const row = await integrationPrisma().humanDecision.findUniqueOrThrow({
          where: { id: decisionId },
        });
        expect(row.resolvedAt).toBeInstanceOf(Date);
        expect(body).toEqual({
          id: decisionId,
          type: RESTOCK_TYPE,
          title: RESTOCK_TITLE,
          sanitizedSummary: RESTOCK_SANITIZED_SUMMARY,
          createdAt: STABLE_CREATED_AT.toISOString(),
          snapshot: EXPECTED_SNAPSHOT,
          status: 'RESOLVED',
          version: 2,
          resolution: {
            action: POSITIVE_ACTION,
            restockDays: 7,
            resolvedAt: row.resolvedAt?.toISOString(),
            resolvedBy: { id: world.managerAId, displayName: MANAGER_A_NAME },
          },
          allowedActions: [],
        });

        // Immutable persisted resolution: version 2, the server-derived
        // reviewer id + display-name snapshot, and the exact command key.
        expect(row).toMatchObject({
          status: 'RESOLVED',
          version: 2,
          resolutionAction: POSITIVE_ACTION,
          restockDays: 7,
          resolutionRequestId: RESOLUTION_REQUEST_ID,
          resolvedById: world.managerAId,
          resolvedByActorId: world.managerAId,
          resolvedByDisplayName: MANAGER_A_NAME,
        });
        await expect(totalDecisionRows()).resolves.toBe(1);
      });

      it('never surfaces bot-only/authority/PII fields or the resolve request key', async () => {
        const decisionId = await seedDecision(
          pendingDecisionData(world.tenantA),
        );

        const res = await postResolve(decisionId, positiveBody()).expect(200);

        for (const key of FORBIDDEN_KEYS) {
          expect(res.body).not.toHaveProperty(key);
        }
        const serialized = JSON.stringify(res.body);
        expect(serialized).not.toContain(world.tenantA);
        expect(serialized).not.toContain(RESOLUTION_REQUEST_ID);
        expect(serialized).not.toContain(SUBMITTED_CREDENTIAL_ID);
        expect(serialized).not.toContain('houndfe-chatbot');
        expect(res.body).not.toHaveProperty('replayed');
      });
    });

    describe('manager NEGATIVE resolve (200 exact FE projection)', () => {
      it('omits restockDays from both the response and the persisted row', async () => {
        const decisionId = await seedDecision(
          pendingDecisionData(world.tenantA),
        );

        const res = await postResolve(decisionId, negativeBody()).expect(200);
        const body = res.body as Record<string, unknown>;
        const resolution = body.resolution as Record<string, unknown>;

        const row = await integrationPrisma().humanDecision.findUniqueOrThrow({
          where: { id: decisionId },
        });

        expect(Object.keys(body).sort()).toEqual(RESPONSE_KEYS);
        expect(Object.keys(resolution).sort()).toEqual(
          NEGATIVE_RESOLUTION_KEYS,
        );
        // The negative variant OMITS `restockDays` entirely (never null).
        expect(resolution).not.toHaveProperty('restockDays');
        expect(body).toEqual({
          id: decisionId,
          type: RESTOCK_TYPE,
          title: RESTOCK_TITLE,
          sanitizedSummary: RESTOCK_SANITIZED_SUMMARY,
          createdAt: STABLE_CREATED_AT.toISOString(),
          snapshot: EXPECTED_SNAPSHOT,
          status: 'RESOLVED',
          version: 2,
          resolution: {
            action: NEGATIVE_ACTION,
            resolvedAt: row.resolvedAt?.toISOString(),
            resolvedBy: { id: world.managerAId, displayName: MANAGER_A_NAME },
          },
          allowedActions: [],
        });

        expect(row).toMatchObject({
          status: 'RESOLVED',
          version: 2,
          resolutionAction: NEGATIVE_ACTION,
          restockDays: null,
          resolvedByActorId: world.managerAId,
          resolvedByDisplayName: MANAGER_A_NAME,
        });
      });
    });

    describe('bot application outcome stays unapplied until a later ACK slice', () => {
      it('writes only the resolution columns and leaves every outcome/provider column NULL', async () => {
        const decisionId = await seedDecision(
          pendingDecisionData(world.tenantA),
        );

        await postResolve(decisionId, positiveBody()).expect(200);

        const row = await integrationPrisma().humanDecision.findUniqueOrThrow({
          where: { id: decisionId },
        });
        // No automatic apply: the adapter never writes a terminal outcome.
        expect(row.applicationOutcome).toBeNull();
        expect(row.applicationAttemptId).toBeNull();
        expect(row.applicationEvidenceHash).toBeNull();
        expect(row.applicationEvidenceCode).toBeNull();
        expect(row.providerMessageId).toBeNull();
        expect(row.providerAcceptedObservedAt).toBeNull();
        expect(row.applicationAttemptedAt).toBeNull();
        expect(row.ackReceivedAt).toBeNull();
        // The historical bot intake audit is not part of this graph: the route
        // neither reads nor rewrites the credential/source identity.
        expect(row.submittedCredentialId).toBe(SUBMITTED_CREDENTIAL_ID);
        expect(row.source).toBe(RESTOCK_SOURCE);
        expect(row.sourceRequestId).toBeDefined();
      });
    });

    describe('idempotent replay (same key, actor, payload, expectedVersion)', () => {
      it('answers 200 with an identical body and performs no second write', async () => {
        const decisionId = await seedDecision(
          pendingDecisionData(world.tenantA),
        );
        const body = positiveBody({ restockDays: 4 });

        const first = await postResolve(decisionId, body).expect(200);
        const rowAfterFirst =
          await integrationPrisma().humanDecision.findUniqueOrThrow({
            where: { id: decisionId },
          });

        const replay = await postResolve(decisionId, body).expect(200);

        expect(replay.body).toEqual(first.body);
        expect((replay.body as { status: string }).status).toBe('RESOLVED');

        const rowAfterReplay =
          await integrationPrisma().humanDecision.findUniqueOrThrow({
            where: { id: decisionId },
          });
        // No second write: version, resolvedAt and updatedAt are unchanged.
        expect(rowAfterReplay.version).toBe(2);
        expect(rowAfterReplay.resolvedAt?.toISOString()).toBe(
          rowAfterFirst.resolvedAt?.toISOString(),
        );
        expect(rowAfterReplay.updatedAt.toISOString()).toBe(
          rowAfterFirst.updatedAt.toISOString(),
        );
        expect(rowAfterReplay.resolvedByActorId).toBe(world.managerAId);
        await expect(totalDecisionRows()).resolves.toBe(1);
      });
    });

    describe('resolve conflicts (409)', () => {
      it('answers a different key after a resolved decision with ALREADY_RESOLVED', async () => {
        const decisionId = await seedDecision(
          pendingDecisionData(world.tenantA),
        );
        await postResolve(decisionId, positiveBody()).expect(200);

        const res = await postResolve(
          decisionId,
          positiveBody({ resolutionRequestId: RESOLUTION_REQUEST_ID_ALT }),
        ).expect(409);

        expect(res.body).toEqual({
          statusCode: 409,
          code: 'ALREADY_RESOLVED',
          message: 'Human decision was already resolved',
        });
        expect(Object.keys(res.body as object).sort()).toEqual(
          ERROR_ENVELOPE_KEYS,
        );

        // The committed resolution is untouched by the conflict.
        await expect(
          integrationPrisma().humanDecision.findUniqueOrThrow({
            where: { id: decisionId },
          }),
        ).resolves.toMatchObject({
          version: 2,
          resolutionRequestId: RESOLUTION_REQUEST_ID,
          resolvedByActorId: world.managerAId,
        });
      });

      it('answers a same-key changed payload or different actor with IDEMPOTENCY_CONFLICT', async () => {
        const decisionId = await seedDecision(
          pendingDecisionData(world.tenantA),
        );
        await postResolve(decisionId, positiveBody({ restockDays: 3 })).expect(
          200,
        );

        const changedPayload = await postResolve(
          decisionId,
          positiveBody({ restockDays: 5 }),
        ).expect(409);
        const changedActor = await postResolve(
          decisionId,
          positiveBody({ restockDays: 3 }),
          world.tokens.managerA2,
        ).expect(409);

        const expected = {
          statusCode: 409,
          code: 'IDEMPOTENCY_CONFLICT',
          message: 'Request conflicts with a previous submission',
        };
        expect(changedPayload.body).toEqual(expected);
        expect(changedActor.body).toEqual(expected);

        await expect(
          integrationPrisma().humanDecision.findUniqueOrThrow({
            where: { id: decisionId },
          }),
        ).resolves.toMatchObject({
          version: 2,
          restockDays: 3,
          resolvedByActorId: world.managerAId,
        });
      });

      it('lets a well-formed stale expectedVersion reach the write and answers VERSION_CONFLICT', async () => {
        const decisionId = await seedDecision(
          pendingDecisionData(world.tenantA),
        );

        const res = await postResolve(
          decisionId,
          positiveBody({ expectedVersion: 7 }),
        ).expect(409);

        expect(res.body).toEqual({
          statusCode: 409,
          code: 'VERSION_CONFLICT',
          message: 'Human decision was modified by another reviewer',
        });
        await expect(
          integrationPrisma().humanDecision.findUniqueOrThrow({
            where: { id: decisionId },
          }),
        ).resolves.toMatchObject({ status: 'PENDING', version: 1 });
      });
    });

    describe('real PostgreSQL one-winner CAS under concurrent HTTP', () => {
      it('yields exactly one 200 and one 409 ALREADY_RESOLVED for two reviewers', async () => {
        const decisionId = await seedDecision(
          pendingDecisionData(world.tenantA),
        );

        // Real concurrent HTTP against one committed PENDING row. The
        // interleaving is NOT forced (no barrier is reachable through the
        // route), so this asserts the durable OUTCOME: whichever request
        // commits version 2 wins and the other loses the CAS. Jest's
        // per-test timeout keeps a stuck pool from hanging the suite.
        const [first, second] = await Promise.all([
          postResolve(
            decisionId,
            positiveBody({ resolutionRequestId: RESOLUTION_REQUEST_ID }),
            world.tokens.managerA,
          ),
          postResolve(
            decisionId,
            positiveBody({
              resolutionRequestId: RESOLUTION_REQUEST_ID_ALT,
            }),
            world.tokens.managerA2,
          ),
        ]);

        const statuses = [first.status, second.status].sort();
        expect(statuses).toEqual([200, 409]);

        const loser = first.status === 409 ? first : second;
        expect(loser.body).toEqual({
          statusCode: 409,
          code: 'ALREADY_RESOLVED',
          message: 'Human decision was already resolved',
        });

        const row = await integrationPrisma().humanDecision.findUniqueOrThrow({
          where: { id: decisionId },
        });
        expect(row).toMatchObject({ status: 'RESOLVED', version: 2 });
        // Exactly ONE reviewer audit snapshot: the winner's actor, never both.
        expect([world.managerAId, world.managerA2Id]).toContain(
          row.resolvedByActorId,
        );
        await expect(totalDecisionRows()).resolves.toBe(1);
      }, 20_000);

      it('keeps concurrent tenant A/B resolves on their own rows (real ALS)', async () => {
        const decisionA = await seedDecision(
          pendingDecisionData(world.tenantA),
        );
        const decisionB = await seedDecision(
          pendingDecisionData(world.tenantB),
        );

        const [resA, resB] = await Promise.all([
          postResolve(decisionA, positiveBody(), world.tokens.managerA),
          postResolve(decisionB, positiveBody(), world.tokens.managerB),
        ]);

        expect(resA.status).toBe(200);
        expect(resB.status).toBe(200);

        const rowA = await integrationPrisma().humanDecision.findUniqueOrThrow({
          where: { id: decisionA },
        });
        const rowB = await integrationPrisma().humanDecision.findUniqueOrThrow({
          where: { id: decisionB },
        });
        expect(rowA).toMatchObject({
          tenantId: world.tenantA,
          status: 'RESOLVED',
          resolvedByActorId: world.managerAId,
        });
        expect(rowB).toMatchObject({
          tenantId: world.tenantB,
          status: 'RESOLVED',
          resolvedByActorId: world.managerBId,
        });
        // Actor provenance is exact for both tenants, not merely non-A.
        expect(rowB.resolvedByActorId).not.toBe(world.managerAId);

        // Real nestjs-cls service (not a Map shim) and no ambient tenant
        // outside a request.
        const cls = app.get(ClsService);
        expect(cls).toBeInstanceOf(ClsService);
        expect(cls.isActive()).toBe(false);
      }, 20_000);
    });

    describe('sanitized NOT_FOUND for out-of-scope decisions (404)', () => {
      it('returns an indistinguishable 404 for cross-tenant, foreign-source and missing ids', async () => {
        const crossTenantId = await seedDecision(
          pendingDecisionData(world.tenantB),
        );
        const foreignSourceId = await seedDecision(
          pendingDecisionData(world.tenantA, { source: 'other-bot-source' }),
        );
        const missingId = crypto.randomUUID();

        const crossTenant = await postResolve(
          crossTenantId,
          positiveBody(),
        ).expect(404);
        const foreignSource = await postResolve(
          foreignSourceId,
          positiveBody(),
        ).expect(404);
        const missing = await postResolve(missingId, positiveBody()).expect(
          404,
        );

        const expected = {
          statusCode: 404,
          code: 'NOT_FOUND',
          message: 'Not found',
        };
        expect(crossTenant.body).toEqual(expected);
        expect(foreignSource.body).toEqual(expected);
        expect(missing.body).toEqual(expected);
        expect(Object.keys(missing.body as object).sort()).toEqual(
          ERROR_ENVELOPE_KEYS,
        );

        // Non-vacuous: the hidden rows really are committed and untouched.
        await expect(
          integrationPrisma().humanDecision.findUniqueOrThrow({
            where: { id: crossTenantId },
          }),
        ).resolves.toMatchObject({
          tenantId: world.tenantB,
          status: 'PENDING',
        });
        await expect(
          integrationPrisma().humanDecision.findUniqueOrThrow({
            where: { id: foreignSourceId },
          }),
        ).resolves.toMatchObject({
          tenantId: world.tenantA,
          source: 'other-bot-source',
          status: 'PENDING',
        });
      });
    });

    describe('sanitized transport 400 (no input echo, no write)', () => {
      it('rejects a malformed decision id with the exact 3-key envelope', async () => {
        const res = await http()
          .post(`${LIST_URL}/not-a-uuid/resolve`)
          .set('Authorization', `Bearer ${world.tokens.managerA}`)
          .send(positiveBody())
          .expect(400);

        expect(res.body).toEqual({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
        });
        expect(Object.keys(res.body as object).sort()).toEqual(
          ERROR_ENVELOPE_KEYS,
        );
        expect(JSON.stringify(res.body)).not.toContain('not-a-uuid');
        await expect(totalDecisionRows()).resolves.toBe(0);
      });

      it.each([
        'tenantId',
        'actorUserId',
        'actorIsSuperAdmin',
        'outcome',
        'source',
        'audit',
        'evil',
      ])(
        'rejects a body that smuggles a %s key with a value-free 400 and no write',
        async (key) => {
          const decisionId = await seedDecision(
            pendingDecisionData(world.tenantA),
          );
          const spoofValue = `spoof-${key}-sentinel`;

          const res = await postResolve(decisionId, {
            ...positiveBody(),
            [key]: key === 'actorIsSuperAdmin' ? true : spoofValue,
          }).expect(400);

          expect(res.body).toEqual({
            statusCode: 400,
            code: 'VALIDATION_ERROR',
            message: 'Invalid request',
          });
          expect(Object.keys(res.body as object).sort()).toEqual(
            ERROR_ENVELOPE_KEYS,
          );
          const serialized = JSON.stringify(res.body);
          expect(serialized).not.toContain(spoofValue);
          expect(serialized).not.toContain(decisionId);
          expect(res.body).not.toHaveProperty('error');
          expect(res.body).not.toHaveProperty('timestamp');

          // Non-vacuous: the smuggled key never reached a write.
          await expect(
            integrationPrisma().humanDecision.findUniqueOrThrow({
              where: { id: decisionId },
            }),
          ).resolves.toMatchObject({ status: 'PENDING', version: 1 });
        },
      );

      it('rejects the negative variant carrying restockDays with a value-free 400', async () => {
        const decisionId = await seedDecision(
          pendingDecisionData(world.tenantA),
        );

        const res = await postResolve(decisionId, {
          action: NEGATIVE_ACTION,
          restockDays: 5,
          expectedVersion: 1,
          resolutionRequestId: RESOLUTION_REQUEST_ID,
        }).expect(400);

        expect(res.body).toEqual({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
        });
        await expect(
          integrationPrisma().humanDecision.findUniqueOrThrow({
            where: { id: decisionId },
          }),
        ).resolves.toMatchObject({ status: 'PENDING', version: 1 });
      });

      it('sanitizes malformed JSON syntax without echoing the raw body', async () => {
        const decisionId = await seedDecision(
          pendingDecisionData(world.tenantA),
        );
        const malformed = '{"pii":"SENTINEL","decisionId":"SENTINEL_ID"';

        const res = await http()
          .post(resolveUrl(decisionId))
          .set('Authorization', `Bearer ${world.tokens.managerA}`)
          .set('Content-Type', 'application/json')
          .send(malformed)
          .expect(400);

        expect(res.body).toEqual({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
        });
        expect(Object.keys(res.body as object).sort()).toEqual(
          ERROR_ENVELOPE_KEYS,
        );
        const serialized = JSON.stringify(res.body);
        expect(serialized).not.toContain('SENTINEL');
        expect(serialized).not.toContain('pii');
        expect(res.body).not.toHaveProperty('timestamp');

        // The parser failure short-circuits before the controller: no write.
        await expect(
          integrationPrisma().humanDecision.findUniqueOrThrow({
            where: { id: decisionId },
          }),
        ).resolves.toMatchObject({ status: 'PENDING', version: 1 });
      });

      it('keeps the allowlisted CORS origin on a malformed-body 400', async () => {
        const malformed = '{"pii":"SENTINEL"';

        const res = await http()
          .post(resolveUrl())
          .set('Origin', ALLOWED_ORIGIN)
          .set('Authorization', `Bearer ${world.tokens.managerA}`)
          .set('Content-Type', 'application/json')
          .send(malformed)
          .expect('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
          .expect(400);

        expect(res.body).toEqual({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
        });
        expect(JSON.stringify(res.body)).not.toContain('SENTINEL');
      });
    });
  },
);
