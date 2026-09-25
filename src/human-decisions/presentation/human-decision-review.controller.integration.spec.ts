/**
 * HD-04d1b — guarded HUMAN reviewer READ routes against REAL PostgreSQL +
 * REAL nestjs-cls AsyncLocalStorage.
 *
 * Approved design (read-only):
 * `houndfe-chatbot-human-decisions/docs/human-decisions-contract-v1.md`.
 *
 * What this spec proves that the HD-04d1 offline spec could not: the selected
 * HTTP chain runs end to end through the REAL components and a real database —
 *
 *   Supertest → real `HumanDecisionHttpFilter` (controller-scoped) →
 *   real `JwtStrategy` + real `JwtAuthGuard` (test-only secret) →
 *   real `TenantContextGuard` → real `HumanDecisionActiveReviewerGuard`
 *   (current-account admission) → real `PermissionsGuard` + real
 *   `CaslAbilityFactory` reading the ACTUAL `RolePermission` grants from
 *   PostgreSQL → real nestjs-cls `ClsService` ALS store opened by
 *   `ClsModule.forRoot({ middleware: { mount: true } })` →
 *   real `PrismaHumanDecisionReviewReadRepository` → real
 *   `TenantPrismaService` (CLS-driven `tenantId` WHERE injection) → real
 *   `PrismaService` → committed `HumanDecision` rows in the dedicated test
 *   database.
 *
 * Deliberately NOT booted: the full `AppModule` (or `HumanDecisionsModule` /
 * `ChatbotApiModule`), because their transitive imports pull Inngest / mail /
 * provider / outbox registrars. This spec assembles a minimal Nest
 * `TestingModule` with only the real pieces under test, plus `DatabaseModule`
 * (global Prisma + TenantPrisma providers) and the same global
 * `ValidationPipe`/filters that `main.ts` installs. Module wiring
 * (`HumanDecisionsModule` imports `AuthModule` and binds the read port to the
 * Prisma adapter) is asserted via controller/module METADATA, never by booting
 * the full graph. The global `DomainExceptionFilter`/`PrismaExceptionFilter`
 * are REAL so the scoped filter's precedence over them is exercised, not
 * assumed.
 *
 * Deliberately mocked (and only this): nothing in the request/authorization
 * path. There is NO mocked user, ability or read port. The ONLY non-production
 * substitutions are the test-only `ConfigService` (pinned `JWT_SECRET`) and the
 * JWT signing helper used to mint principal tokens. No provider, no bot, no
 * network, no listen port (`app.init()` only).
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
 * pre-Jest destination precheck (see the HD-04d1b task record for the exact
 * command).
 *
 * Scope boundary: this spec proves the read routes over real PostgreSQL, real
 * RBAC grants and real CLS ALS request isolation. It makes NO claim about the
 * full application graph, provider delivery, resolution writes or the bot
 * intake route.
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
import {
  RESTOCK_SOURCE,
  RESTOCK_TYPE,
} from '../domain/restock-request-canonicalizer';
import { HumanDecisionsModule } from '../human-decisions.module';
import { PrismaHumanDecisionReviewReadRepository } from '../infrastructure/prisma-human-decision-review-read.repository';
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
      `[hd-04d1b] refusing isolated-DB run: ${SOURCE_LABELS[source]} DATABASE_URL is unset.`,
    );
  }

  let url: globalThis.URL;
  try {
    url = new globalThis.URL(rawUrl);
  } catch {
    throw new Error(
      `[hd-04d1b] refusing isolated-DB run: ${SOURCE_LABELS[source]} DATABASE_URL is not a valid URL.`,
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
      `[hd-04d1b] refusing isolated-DB run: ${SOURCE_LABELS[source]} DATABASE_URL does not match the dedicated isolated RESTOCK target.`,
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
      `[hd-04d1b] isolated DB target OK: ${EXPECTED_PROTOCOL}//${EXPECTED_HOSTNAME}:${EXPECTED_PORT}/${EXPECTED_DATABASE}`,
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
// Fixtures and helpers
// ---------------------------------------------------------------------------

const TEST_SECRET = 'hd-04d1b-test-secret-not-a-production-key';

const jwtService = new JwtService({
  secret: TEST_SECRET,
  signOptions: { expiresIn: '1h' },
});

const PENDING_ACTIONS = [
  'PROVIDE_RESTOCK_ESTIMATE',
  'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
];

const ERROR_ENVELOPE_KEYS = ['code', 'message', 'statusCode'];

/** Keys that must NEVER appear on a human reviewer read projection. */
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
  'ackReceivedAt',
  'pii',
  'customerPhone',
];

/**
 * Exact reviewer projection key sets, pinned as literals so the assertions
 * never derive the allowlist from the mapper implementation under test. The
 * same top-level set applies to PENDING and RESOLVED decisions (both add only
 * `status`/`version`/`resolution`/`allowedActions` to the shared base).
 */
const PENDING_RESPONSE_KEYS = [
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

interface ErrorEnvelope {
  statusCode: number;
  code: string;
  message: string;
}

interface ListBody {
  data: Array<Record<string, unknown>>;
  pagination: {
    pageIndex: number;
    pageSize: number;
    totalCount: number;
    pageCount: number;
  };
}

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
    data: { id, name, slug: `hd04d1b-${id}` },
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
 * snapshot. `branchId` is deliberately distinct from the tenant id so the
 * reviewer projection cannot be mistaken for a tenant-id leak.
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
    submittedCredentialId: 'cred-hd04d1b',
    branchId: 'branch-centro',
    branchName: 'Sucursal Centro',
    productId: crypto.randomUUID(),
    productName: 'Cafe de Altura',
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

const REVIEWER_ACTOR_ID = 'reviewer-hd04d1b';
const REVIEWER_DISPLAY_NAME = 'Ada Lovelace';
const RESOLVED_AT = new Date('2026-03-02T09:15:00.000Z');

/** Stable, deterministic projection fixture values (no random UUIDs). */
const DECISION_ID = '2b7c1a90-6f3e-4d2a-8b1c-0d9e8f7a6b5c';
const STABLE_PRODUCT_ID = '8f14e45f-ceea-4e42-9f62-1a2b3c4d5e6f';
const STABLE_VARIANT_ID = '550e8400-e29b-41d4-a716-446655440000';
const STABLE_CREATED_AT = new Date('2026-04-01T10:00:00.000Z');
const STABLE_OBSERVED_AT = new Date('2026-03-31T23:30:00.000Z');

/** Stable PENDING fixture overrides shared by the exact-key list/detail tests. */
function stablePendingOverrides(): Partial<Prisma.HumanDecisionUncheckedCreateInput> {
  return {
    createdAt: STABLE_CREATED_AT,
    branchId: 'branch-stable',
    branchName: 'Sucursal Estable',
    productId: STABLE_PRODUCT_ID,
    productName: 'Filtro de aceite',
    variantId: STABLE_VARIANT_ID,
    sku: 'SKU-STABLE',
    requestedQuantity: 3,
    observedStockAtRequest: 2,
    stockObservedAt: STABLE_OBSERVED_AT,
  };
}

/** Salient values expected on the stable PENDING `snapshot` projection. */
const EXPECTED_STABLE_SNAPSHOT = {
  branchId: 'branch-stable',
  branchName: 'Sucursal Estable',
  productId: STABLE_PRODUCT_ID,
  productName: 'Filtro de aceite',
  variantId: STABLE_VARIANT_ID,
  sku: 'SKU-STABLE',
  requestedQuantity: 3,
  observedStockAtRequest: 2,
  stockObservedAt: STABLE_OBSERVED_AT.toISOString(),
};

const RESTOCK_TITLE = 'Solicitud de reposición de stock';
const RESTOCK_SANITIZED_SUMMARY =
  'El chatbot solicitó una estimación de reposición de stock para un producto.';

/**
 * Valid `RESOLVED` fixture satisfying the HD-01 SQL CHECKs: `version = 2`, a
 * non-null resolution action, `resolutionRequestId`, `resolvedAt` and BOTH
 * immutable reviewer snapshots.
 */
function resolvedDecisionData(
  tenantId: string,
  overrides: Partial<Prisma.HumanDecisionUncheckedCreateInput> = {},
): Prisma.HumanDecisionUncheckedCreateInput {
  return {
    ...pendingDecisionData(tenantId),
    status: 'RESOLVED',
    version: 2,
    resolutionAction: 'PROVIDE_RESTOCK_ESTIMATE',
    restockDays: 7,
    resolutionRequestId: crypto.randomUUID(),
    resolvedAt: RESOLVED_AT,
    resolvedByActorId: REVIEWER_ACTOR_ID,
    resolvedByDisplayName: REVIEWER_DISPLAY_NAME,
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

// ---------------------------------------------------------------------------
// Real RBAC world (real Permission/Role/RolePermission/User/Membership rows)
// ---------------------------------------------------------------------------

interface ReviewerWorld {
  tenantA: string;
  tenantB: string;
  resolverA: string;
  inactiveAUserId: string;
  deletedAUserId: string;
  tokens: {
    managerA: string;
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
 * neither. The inactive manager and the deleted-account token prove the
 * current-account admission guard against committed state.
 */
async function seedReviewerWorld(): Promise<ReviewerWorld> {
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

  const managerA = await seedMember({
    tenantId: tenantA,
    roleId: managerARole.id,
    email: 'manager.a@hd04d1b.test',
    name: 'Manager A',
  });
  const cashierA = await seedMember({
    tenantId: tenantA,
    roleId: cashierARole.id,
    email: 'cashier.a@hd04d1b.test',
    name: 'Cashier A',
  });
  const noReadA = await seedMember({
    tenantId: tenantA,
    roleId: noReadARole.id,
    email: 'noread.a@hd04d1b.test',
    name: 'No Read A',
  });
  const inactiveA = await seedMember({
    tenantId: tenantA,
    roleId: managerARole.id,
    email: 'inactive.a@hd04d1b.test',
    name: 'Inactive A',
    isActive: false,
  });
  const managerB = await seedMember({
    tenantId: tenantB,
    roleId: managerBRole.id,
    email: 'manager.b@hd04d1b.test',
    name: 'Manager B',
  });

  // A real User referenced by `resolvedById`; the reviewer snapshot columns are
  // what survive its deletion (FK onDelete: SetNull).
  const resolverA = crypto.randomUUID();
  await integrationPrisma().user.create({
    data: {
      id: resolverA,
      email: 'resolver.a@hd04d1b.test',
      name: REVIEWER_DISPLAY_NAME,
      hashedPassword: 'not-a-real-hash',
      isActive: true,
    },
  });

  // No User row is ever created for this subject; captured so the deleted-token
  // test can prove the subject is genuinely absent (distinct from the
  // deactivated account, which DOES exist with isActive=false).
  const deletedAUserId = crypto.randomUUID();

  return {
    tenantA,
    tenantB,
    resolverA,
    inactiveAUserId: inactiveA,
    deletedAUserId,
    tokens: {
      managerA: signToken({
        sub: managerA,
        email: 'manager.a@hd04d1b.test',
        tenantId: tenantA,
        tenantSlug: 'centro-a',
        isSuperAdmin: false,
      }),
      cashierA: signToken({
        sub: cashierA,
        email: 'cashier.a@hd04d1b.test',
        tenantId: tenantA,
        tenantSlug: 'centro-a',
        isSuperAdmin: false,
      }),
      noReadA: signToken({
        sub: noReadA,
        email: 'noread.a@hd04d1b.test',
        tenantId: tenantA,
        tenantSlug: 'centro-a',
        isSuperAdmin: false,
      }),
      inactiveA: signToken({
        sub: inactiveA,
        email: 'inactive.a@hd04d1b.test',
        tenantId: tenantA,
        tenantSlug: 'centro-a',
        isSuperAdmin: false,
      }),
      // No User row exists for this subject.
      deletedA: signToken({
        sub: deletedAUserId,
        email: 'deleted.a@hd04d1b.test',
        tenantId: tenantA,
        tenantSlug: 'centro-a',
        isSuperAdmin: false,
      }),
      managerB: signToken({
        sub: managerB,
        email: 'manager.b@hd04d1b.test',
        tenantId: tenantB,
        tenantSlug: 'centro-b',
        isSuperAdmin: false,
      }),
      // Tenantless global superadmin: passes TenantContextGuard but must be
      // stopped before the tenant-scoped read.
      superTenantless: signToken({
        sub: crypto.randomUUID(),
        email: 'super@hd04d1b.test',
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
  'Human decision review HTTP integration (HD-04d1b PostgreSQL + real ALS)',
  () => {
    let app: INestApplication;
    let world: ReviewerWorld;

    const http = () =>
      request(app.getHttpServer() as import('node:http').Server);

    const getList = (query: string, token: string) =>
      http().get(`${LIST_URL}${query}`).set('Authorization', `Bearer ${token}`);

    const getDetail = (id: string, token: string) =>
      http().get(`${LIST_URL}/${id}`).set('Authorization', `Bearer ${token}`);

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
          // and the read adapter reads back. No Map shim anywhere.
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
            // REAL adapter against the dedicated DB.
            provide: HUMAN_DECISION_REVIEW_READ_REPOSITORY,
            useClass: PrismaHumanDecisionReviewReadRepository,
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
    });

    beforeEach(async () => {
      world = await seedReviewerWorld();
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
          expect(message).toContain('[hd-04d1b]');
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
      it('imports AuthModule and binds the read port to the Prisma adapter', () => {
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

        const binding = providers.find(
          (provider) =>
            provider?.provide === HUMAN_DECISION_REVIEW_READ_REPOSITORY,
        );
        expect(binding?.useClass).toBe(PrismaHumanDecisionReviewReadRepository);
      });
    });

    describe('authentication (401)', () => {
      it('rejects a missing bearer token with a sanitized 401', async () => {
        const res = await http().get(`${LIST_URL}?status=PENDING`).expect(401);

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
          .get(`${LIST_URL}?status=PENDING`)
          .set('Authorization', 'Bearer not-a-valid-jwt')
          .expect(401);

        expect(res.body).toEqual({
          statusCode: 401,
          code: 'UNAUTHORIZED',
          message: 'Unauthorized',
        });
      });

      it('rejects a valid JWT for a deactivated User on list AND detail', async () => {
        // Prove the committed account state BEFORE the request: a real User row
        // with isActive=false and an ACTIVE tenant membership. The rejection is
        // therefore the admission guard reading real PostgreSQL state, not a
        // missing row or a missing grant.
        const account = await integrationPrisma().user.findUnique({
          where: { id: world.inactiveAUserId },
          select: { isActive: true },
        });
        expect(account).toEqual({ isActive: false });
        const membership = await integrationPrisma().tenantMembership.findFirst(
          {
            where: { userId: world.inactiveAUserId },
          },
        );
        expect(membership).not.toBeNull();
        expect(membership?.tenantId).toBe(world.tenantA);

        const listRes = await getList(
          '?status=PENDING',
          world.tokens.inactiveA,
        ).expect(401);
        const detailRes = await getDetail(
          crypto.randomUUID(),
          world.tokens.inactiveA,
        ).expect(401);

        const expected = {
          statusCode: 401,
          code: 'UNAUTHORIZED',
          message: 'Unauthorized',
        };
        expect(listRes.body).toEqual(expected);
        expect(detailRes.body).toEqual(expected);
      });

      it('rejects a valid JWT for a deleted (absent) User with a sanitized 401', async () => {
        // Distinct from the deactivated case above: this subject has NO User row
        // at all, so the same 401 comes from the absent account.
        await expect(
          integrationPrisma().user.findUnique({
            where: { id: world.deletedAUserId },
          }),
        ).resolves.toBeNull();

        const res = await getList(
          '?status=PENDING',
          world.tokens.deletedA,
        ).expect(401);

        expect(res.body).toEqual({
          statusCode: 401,
          code: 'UNAUTHORIZED',
          message: 'Unauthorized',
        });
      });
    });

    describe('authorization (403)', () => {
      it('rejects a reviewer whose role lacks read:HumanDecision on list AND detail', async () => {
        const pendingId = await seedDecision(
          pendingDecisionData(world.tenantA),
        );

        const listRes = await getList(
          '?status=PENDING',
          world.tokens.noReadA,
        ).expect(403);
        const detailRes = await getDetail(
          pendingId,
          world.tokens.noReadA,
        ).expect(403);

        const expected = {
          statusCode: 403,
          code: 'FORBIDDEN',
          message: 'Forbidden',
        };
        expect(listRes.body).toEqual(expected);
        expect(detailRes.body).toEqual(expected);
      });

      it('rejects a tenantless superadmin before the tenant-scoped read', async () => {
        const res = await getList(
          '?status=PENDING',
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
        expect(res.body).not.toHaveProperty('data');
      });
    });

    describe('list contract over committed rows (GET /human-decisions)', () => {
      it('returns the exact { data, pagination } envelope and derives manager vs cashier actions', async () => {
        const pendingId = await seedDecision(
          pendingDecisionData(world.tenantA, {
            ...stablePendingOverrides(),
            id: DECISION_ID,
          }),
        );

        const managerRes = await getList(
          '?status=PENDING',
          world.tokens.managerA,
        ).expect(200);
        const managerBody = managerRes.body as ListBody;

        expect(Object.keys(managerBody).sort()).toEqual(['data', 'pagination']);
        expect(managerBody.pagination).toEqual({
          pageIndex: 0,
          pageSize: 20,
          totalCount: 1,
          pageCount: 1,
        });
        expect(managerBody.data).toHaveLength(1);

        // Pin the EXACT allowlisted top-level keys and nested `snapshot` keys of
        // a PENDING list item, then the salient values of the stable fixture.
        const item = managerBody.data[0];
        expect(Object.keys(item).sort()).toEqual(PENDING_RESPONSE_KEYS);
        expect(Object.keys(item.snapshot as object).sort()).toEqual(
          SNAPSHOT_RESPONSE_KEYS,
        );
        expect(item).toEqual({
          id: pendingId,
          type: RESTOCK_TYPE,
          title: RESTOCK_TITLE,
          sanitizedSummary: RESTOCK_SANITIZED_SUMMARY,
          createdAt: STABLE_CREATED_AT.toISOString(),
          snapshot: EXPECTED_STABLE_SNAPSHOT,
          status: 'PENDING',
          version: 1,
          resolution: null,
          allowedActions: PENDING_ACTIONS,
        });

        const cashierRes = await getList(
          '?status=PENDING',
          world.tokens.cashierA,
        ).expect(200);
        const cashierBody = cashierRes.body as ListBody;
        expect(cashierBody.data[0].allowedActions).toEqual([]);
      });

      it('lists only RESTOCK PENDING rows while the same tenant stores RESOLVED and foreign-source rows', async () => {
        const pendingId = await seedDecision(
          pendingDecisionData(world.tenantA),
        );
        const foreignSourceId = await seedDecision(
          pendingDecisionData(world.tenantA, { source: 'other-bot-source' }),
        );
        await seedDecision(resolvedDecisionData(world.tenantA));
        await seedDecision(
          resolvedDecisionData(world.tenantA, {
            resolutionAction: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
            restockDays: null,
          }),
        );

        const res = await getList(
          '?status=PENDING',
          world.tokens.managerA,
        ).expect(200);
        const body = res.body as ListBody;

        expect(body.data.map((item) => item.id)).toEqual([pendingId]);
        expect(body.data.every((item) => item.status === 'PENDING')).toBe(true);
        expect(body.pagination.totalCount).toBe(1);
        // Non-vacuous: the foreign-source PENDING decoy and both RESOLVED rows
        // really are committed in tenant A, so the narrow page is the pinned
        // RESTOCK predicate, not a missing-row artifact.
        await expect(
          integrationPrisma().humanDecision.count({
            where: { tenantId: world.tenantA },
          }),
        ).resolves.toBe(4);
        await expect(
          integrationPrisma().humanDecision.findUnique({
            where: { id: foreignSourceId },
          }),
        ).resolves.toMatchObject({
          tenantId: world.tenantA,
          source: 'other-bot-source',
          status: 'PENDING',
        });
      });

      it('orders by createdAt then id across more than one page and reports the FE shape', async () => {
        const totalA = 28;
        const tieCount = 5;
        const base = new Date('2026-03-01T00:00:00.000Z');

        const rows: Array<{ id: string; createdAt: Date }> = [];
        for (let index = 0; index < totalA; index += 1) {
          rows.push({
            id: crypto.randomUUID(),
            createdAt:
              index < tieCount
                ? base
                : new Date(base.getTime() + (index - tieCount + 1) * 60_000),
          });
        }
        await integrationPrisma().humanDecision.createMany({
          data: rows.map((row) =>
            pendingDecisionData(world.tenantA, {
              id: row.id,
              createdAt: row.createdAt,
            }),
          ),
        });
        // Decoy rows in the OTHER tenant must never enter tenant A's counts.
        await integrationPrisma().humanDecision.createMany({
          data: Array.from({ length: 3 }, () =>
            pendingDecisionData(world.tenantB, { createdAt: base }),
          ),
        });

        const expectedIds = [...rows]
          .sort(
            (left, right) =>
              left.createdAt.getTime() - right.createdAt.getTime() ||
              (left.id < right.id ? -1 : 1),
          )
          .map((row) => row.id);

        const firstRes = await getList(
          '?status=PENDING&page=1&limit=20',
          world.tokens.managerA,
        ).expect(200);
        const firstBody = firstRes.body as ListBody;
        const secondRes = await getList(
          '?status=PENDING&page=2&limit=20',
          world.tokens.managerA,
        ).expect(200);
        const secondBody = secondRes.body as ListBody;

        expect(firstBody.pagination).toEqual({
          pageIndex: 0,
          pageSize: 20,
          totalCount: totalA,
          pageCount: 2,
        });
        expect(firstBody.data.map((item) => item.id)).toEqual(
          expectedIds.slice(0, 20),
        );
        expect(secondBody.pagination).toEqual({
          pageIndex: 1,
          pageSize: 20,
          totalCount: totalA,
          pageCount: 2,
        });
        expect(secondBody.data.map((item) => item.id)).toEqual(
          expectedIds.slice(20),
        );
      });
    });

    describe('case-insensitive literal productName search', () => {
      it('matches case-insensitively and stays inside the calling tenant', async () => {
        const matchId = await seedDecision(
          pendingDecisionData(world.tenantA, {
            productName: 'Cafe de Altura',
          }),
        );
        // Identically named row in the OTHER tenant, to prove tenant scoping.
        await seedDecision(
          pendingDecisionData(world.tenantB, {
            productName: 'Cafe de Altura',
          }),
        );

        const lower = await getList(
          '?status=PENDING&search=cafe%20de%20altura',
          world.tokens.managerA,
        ).expect(200);
        const upper = await getList(
          '?status=PENDING&search=CAFE%20DE%20ALTURA',
          world.tokens.managerA,
        ).expect(200);

        expect((lower.body as ListBody).data.map((item) => item.id)).toEqual([
          matchId,
        ]);
        expect((upper.body as ListBody).data.map((item) => item.id)).toEqual([
          matchId,
        ]);
        await expect(
          integrationPrisma().humanDecision.count({
            where: { productName: 'Cafe de Altura' },
          }),
        ).resolves.toBe(2);
      });

      it('treats %, _ and \\ as literal characters instead of LIKE patterns', async () => {
        const percentId = await seedDecision(
          pendingDecisionData(world.tenantA, {
            productName: 'Cafe 100% puro',
          }),
        );
        const underscoreId = await seedDecision(
          pendingDecisionData(world.tenantA, {
            productName: 'Cafe_Especial',
          }),
        );
        const backslashId = await seedDecision(
          pendingDecisionData(world.tenantA, {
            productName: 'Cafe\\Importado',
          }),
        );
        // Decoys an unescaped pattern would match.
        await seedDecision(
          pendingDecisionData(world.tenantA, {
            productName: 'Cafe 100x puro',
          }),
        );
        await seedDecision(
          pendingDecisionData(world.tenantA, {
            productName: 'CafeXEspecial',
          }),
        );
        await seedDecision(
          pendingDecisionData(world.tenantA, {
            productName: 'CafeImportado',
          }),
        );

        const percent = await getList(
          `?status=PENDING&search=${encodeURIComponent('100%')}`,
          world.tokens.managerA,
        ).expect(200);
        const underscore = await getList(
          `?status=PENDING&search=${encodeURIComponent('Cafe_')}`,
          world.tokens.managerA,
        ).expect(200);
        const backslash = await getList(
          `?status=PENDING&search=${encodeURIComponent('Cafe\\Importado')}`,
          world.tokens.managerA,
        ).expect(200);

        expect((percent.body as ListBody).data.map((item) => item.id)).toEqual([
          percentId,
        ]);
        expect(
          (underscore.body as ListBody).data.map((item) => item.id),
        ).toEqual([underscoreId]);
        expect(
          (backslash.body as ListBody).data.map((item) => item.id),
        ).toEqual([backslashId]);
      });
    });

    describe('detail contract (GET /human-decisions/:id)', () => {
      it('returns the exact PENDING detail projection with nested snapshot keys', async () => {
        const decisionId = await seedDecision(
          pendingDecisionData(world.tenantA, {
            ...stablePendingOverrides(),
            id: DECISION_ID,
          }),
        );

        const res = await getDetail(decisionId, world.tokens.managerA).expect(
          200,
        );
        const body = res.body as Record<string, unknown>;

        expect(Object.keys(body).sort()).toEqual(PENDING_RESPONSE_KEYS);
        expect(Object.keys(body.snapshot as object).sort()).toEqual(
          SNAPSHOT_RESPONSE_KEYS,
        );
        expect(body).toEqual({
          id: decisionId,
          type: RESTOCK_TYPE,
          title: RESTOCK_TITLE,
          sanitizedSummary: RESTOCK_SANITIZED_SUMMARY,
          createdAt: STABLE_CREATED_AT.toISOString(),
          snapshot: EXPECTED_STABLE_SNAPSHOT,
          status: 'PENDING',
          version: 1,
          resolution: null,
          allowedActions: PENDING_ACTIONS,
        });
      });

      it('keeps the durable RESOLVED reviewer snapshot after the reviewer FK is deleted', async () => {
        const resolvedId = await seedDecision(
          resolvedDecisionData(world.tenantA, {
            resolvedById: world.resolverA,
          }),
        );
        // Deleting the User nulls `resolvedById`; only the immutable snapshots
        // can still answer `resolvedBy`.
        await integrationPrisma().user.delete({
          where: { id: world.resolverA },
        });

        const res = await getDetail(resolvedId, world.tokens.managerA).expect(
          200,
        );
        const body = res.body as Record<string, unknown>;
        const resolution = body.resolution as Record<string, unknown>;

        expect(Object.keys(body).sort()).toEqual(PENDING_RESPONSE_KEYS);
        expect(Object.keys(resolution).sort()).toEqual(
          POSITIVE_RESOLUTION_KEYS,
        );
        expect(Object.keys(resolution.resolvedBy as object).sort()).toEqual(
          RESOLVED_BY_KEYS,
        );
        expect(body.status).toBe('RESOLVED');
        expect(body.version).toBe(2);
        expect(body.allowedActions).toEqual([]);
        expect(resolution).toEqual({
          action: 'PROVIDE_RESTOCK_ESTIMATE',
          restockDays: 7,
          resolvedAt: RESOLVED_AT.toISOString(),
          resolvedBy: {
            id: REVIEWER_ACTOR_ID,
            displayName: REVIEWER_DISPLAY_NAME,
          },
        });
      });

      it('returns the exact RESOLVED negative projection and omits restockDays', async () => {
        const decisionId = await seedDecision(
          resolvedDecisionData(world.tenantA, {
            resolutionAction: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
            restockDays: null,
          }),
        );

        const res = await getDetail(decisionId, world.tokens.managerA).expect(
          200,
        );
        const body = res.body as Record<string, unknown>;
        const resolution = body.resolution as Record<string, unknown>;

        expect(Object.keys(body).sort()).toEqual(PENDING_RESPONSE_KEYS);
        expect(Object.keys(resolution).sort()).toEqual(
          NEGATIVE_RESOLUTION_KEYS,
        );
        expect(Object.keys(resolution.resolvedBy as object).sort()).toEqual(
          RESOLVED_BY_KEYS,
        );
        // The negative variant OMITS `restockDays` entirely (never null).
        expect(resolution).not.toHaveProperty('restockDays');
        expect(resolution).toEqual({
          action: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
          resolvedAt: RESOLVED_AT.toISOString(),
          resolvedBy: {
            id: REVIEWER_ACTOR_ID,
            displayName: REVIEWER_DISPLAY_NAME,
          },
        });
        expect(body.status).toBe('RESOLVED');
        expect(body.version).toBe(2);
        expect(body.allowedActions).toEqual([]);
      });

      it('returns an indistinguishable 404 for cross-tenant, foreign-source and missing ids', async () => {
        const crossTenantId = await seedDecision(
          pendingDecisionData(world.tenantB),
        );
        const foreignSourceId = await seedDecision(
          pendingDecisionData(world.tenantA, { source: 'other-bot-source' }),
        );
        const missingId = crypto.randomUUID();

        const crossTenant = await getDetail(
          crossTenantId,
          world.tokens.managerA,
        ).expect(404);
        const foreignSource = await getDetail(
          foreignSourceId,
          world.tokens.managerA,
        ).expect(404);
        const missing = await getDetail(
          missingId,
          world.tokens.managerA,
        ).expect(404);

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

        // Non-vacuous: the hidden rows really are committed in the one DB.
        await expect(
          integrationPrisma().humanDecision.findUnique({
            where: { id: crossTenantId },
          }),
        ).resolves.toMatchObject({ tenantId: world.tenantB });
        await expect(
          integrationPrisma().humanDecision.findUnique({
            where: { id: foreignSourceId },
          }),
        ).resolves.toMatchObject({ source: 'other-bot-source' });
      });
    });

    describe('list query constraints (sanitized 400)', () => {
      it.each([
        ['a missing status', ''],
        ['a non-PENDING status', '?status=RESOLVED'],
        ['an unwhitelisted limit', '?status=PENDING&limit=999'],
        ['a non-numeric page', '?status=PENDING&page=abc'],
        ['an unknown sort field', '?status=PENDING&sortBy=updatedAt'],
        ['a descending sort', '?status=PENDING&sortOrder=desc'],
        ['an explicit blank search', '?status=PENDING&search='],
        [
          'a client tenant override',
          '?status=PENDING&tenantId=tenant-sentinel',
        ],
        ['an unknown extra key', '?status=PENDING&evil=1'],
      ])(
        'rejects %s with the exact 3-key envelope and no value leak',
        async (_label, query) => {
          const res = await getList(query, world.tokens.managerA).expect(400);
          const body = res.body as ErrorEnvelope;

          expect(body).toEqual({
            statusCode: 400,
            code: 'VALIDATION_ERROR',
            message: 'Invalid request',
          });
          expect(Object.keys(body).sort()).toEqual(ERROR_ENVELOPE_KEYS);
          const serialized = JSON.stringify(body);
          expect(serialized).not.toContain('evil');
          expect(serialized).not.toContain('tenant-sentinel');
          expect(serialized).not.toContain('updatedAt');
          expect(body).not.toHaveProperty('error');
          expect(body).not.toHaveProperty('timestamp');
        },
      );
    });

    describe('no authority / bot-only / PII leakage', () => {
      it('never leaks excluded columns on either the list or the detail projection', async () => {
        const sourceRequestId = 'bot-request-sentinel';
        const canonicalRequestHash = 'canonical-hash-sentinel';
        const credentialId = 'credential-sentinel';
        const decisionId = await seedDecision(
          pendingDecisionData(world.tenantA, {
            sourceRequestId,
            canonicalRequestHash,
            submittedCredentialId: credentialId,
          }),
        );

        const listRes = await getList(
          '?status=PENDING',
          world.tokens.managerA,
        ).expect(200);
        const detailRes = await getDetail(
          decisionId,
          world.tokens.managerA,
        ).expect(200);
        const listItem = (listRes.body as ListBody).data[0];

        for (const key of FORBIDDEN_KEYS) {
          expect(listItem).not.toHaveProperty(key);
          expect(detailRes.body).not.toHaveProperty(key);
        }

        const serialized =
          JSON.stringify(listRes.body) + JSON.stringify(detailRes.body);
        expect(serialized).not.toContain(sourceRequestId);
        expect(serialized).not.toContain(canonicalRequestHash);
        expect(serialized).not.toContain(credentialId);
        // The tenant id is a committed value on the row, never projected.
        expect(serialized).not.toContain(world.tenantA);
        expect(serialized).not.toContain('houndfe-chatbot');
      });
    });

    describe('no POST resolve route', () => {
      it('exposes no resolve route on the human-decisions controller', async () => {
        const decisionId = await seedDecision(
          pendingDecisionData(world.tenantA),
        );

        await http()
          .post(LIST_URL)
          .set('Authorization', `Bearer ${world.tokens.managerA}`)
          .send({ action: 'PROVIDE_RESTOCK_ESTIMATE', restockDays: 3 })
          .expect(404);

        await http()
          .post(`${LIST_URL}/${decisionId}/resolve`)
          .set('Authorization', `Bearer ${world.tokens.managerA}`)
          .send({ action: 'PROVIDE_RESTOCK_ESTIMATE', restockDays: 3 })
          .expect(404);

        await expect(
          integrationPrisma().humanDecision.findUnique({
            where: { id: decisionId },
          }),
        ).resolves.toMatchObject({ status: 'PENDING', version: 1 });
      });
    });

    describe('tenant isolation through real CLS ALS under concurrency', () => {
      it('keeps concurrent tenant A/B HTTP reads on their own rows', async () => {
        const a1 = await seedDecision(
          pendingDecisionData(world.tenantA, {
            productName: 'Tenant A Uno',
          }),
        );
        const a2 = await seedDecision(
          pendingDecisionData(world.tenantA, {
            productName: 'Tenant A Dos',
          }),
        );
        const b1 = await seedDecision(
          pendingDecisionData(world.tenantB, {
            productName: 'Tenant B Uno',
          }),
        );
        const b2 = await seedDecision(
          pendingDecisionData(world.tenantB, {
            productName: 'Tenant B Dos',
          }),
        );

        const [resA, resB] = await Promise.all([
          getList('?status=PENDING&limit=20', world.tokens.managerA).expect(
            200,
          ),
          getList('?status=PENDING&limit=20', world.tokens.managerB).expect(
            200,
          ),
        ]);

        const idsA = (resA.body as ListBody).data.map((item) => item.id);
        const idsB = (resB.body as ListBody).data.map((item) => item.id);

        expect(idsA.sort()).toEqual([a1, a2].sort());
        expect(idsB.sort()).toEqual([b1, b2].sort());
        expect(idsA.filter((id) => idsB.includes(id))).toEqual([]);
        expect((resA.body as ListBody).pagination.totalCount).toBe(2);
        expect((resB.body as ListBody).pagination.totalCount).toBe(2);

        // Real nestjs-cls service (not a Map shim) and no ambient tenant outside
        // a request.
        const cls = app.get(ClsService);
        expect(cls).toBeInstanceOf(ClsService);
        expect(cls.isActive()).toBe(false);
      });
    });
  },
);
