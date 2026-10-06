/**
 * HD-03b3 — bot RESTOCK intake HTTP route against REAL PostgreSQL + REAL CLS.
 *
 * Approved design (read-only):
 * `houndfe-chatbot-human-decisions/docs/human-decisions-contract-v1.md`.
 *
 * What this spec proves that the HD-03b2 offline spec could not: the selected
 * HTTP chain runs end to end through the REAL components and a real database —
 *
 *   Supertest → real `HumanDecisionHttpFilter` (controller-scoped) →
 *   real `ServiceAuthGuard` (hashes the bearer token against an in-memory
 *   `IServiceCredentialRepository`) → real nestjs-cls `ClsService` ALS store
 *   opened by `ClsModule.forRoot({ middleware: { mount: true } })` →
 *   real `PrismaRestockIntakeRepository` → real `TenantPrismaService`
 *   (CLS-driven `tenantId` WHERE injection) → real `PrismaService` →
 *   committed `HumanDecision` rows in the dedicated test database.
 *
 * Deliberately NOT booted: the full `AppModule` (or `HumanDecisionsModule` /
 * `ChatbotApiModule`), because their transitive imports pull Inngest / mail /
 * provider / outbox registrars. This spec assembles a minimal Nest
 * `TestingModule` with only the real pieces under test, plus `DatabaseModule`
 * (global Prisma + TenantPrisma providers) and the same global
 * `ValidationPipe`/filters that `main.ts` installs. The global
 * `DomainExceptionFilter`/`PrismaExceptionFilter` are REAL so the scoped
 * filter's precedence over them is exercised, not assumed.
 *
 * Deliberately mocked (and only this): `IServiceCredentialRepository` — the
 * credentials are fixtures, never written to the DB, and the guard still
 * derives `submittedCredentialId` from the token it hashed. No provider, no
 * bot, no network, no listen port (`app.init()` only).
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
 * Scope boundary: this spec proves intake persistence, idempotent replay,
 * conflict, sanitized validation/not-found/guard envelopes and tenant-scoped
 * CLS ALS. It makes NO claim about provider acceptance, device delivery,
 * stock mutation or human resolution.
 *
 * Skip guard: `SKIP_DB_INTEGRATION=1` or an unset `DATABASE_URL` skips the
 * whole suite, matching the other integration specs.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as dotenv from 'dotenv';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ClsModule, ClsService } from 'nestjs-cls';
import request from 'supertest';
import {
  integrationPrisma,
  resetAndSeedBaseline,
  disconnectIntegrationPrisma,
} from '../../../test/integration/reset-db';
import { ServiceCredential } from '../../chatbot-api/domain/service-credential.entity';
import {
  IServiceCredentialRepository,
  SERVICE_CREDENTIAL_REPOSITORY,
} from '../../chatbot-api/domain/service-credential.repository';
import { ServiceAuthGuard } from '../../chatbot-api/presentation/guards/service-auth.guard';
import { DomainExceptionFilter } from '../../shared/filters/domain-exception.filter';
import { PrismaExceptionFilter } from '../../shared/filters/prisma-exception.filter';
import { createListingValidationExceptionFactory } from '../../shared/listing/listing-validation-exception.factory';
import { DatabaseModule } from '../../shared/prisma/prisma.module';
import {
  canonicalizeRestockRequest,
  RESTOCK_SOURCE,
  RESTOCK_TYPE,
} from '../domain/restock-request-canonicalizer';
import { EXPIRATION_INTAKE_REPOSITORY } from '../domain/expiration-intake.repository';
import { PrismaExpirationIntakeRepository } from '../infrastructure/prisma-expiration-intake.repository';
import { RESTOCK_INTAKE_REPOSITORY } from '../domain/restock-intake.repository';
import { PrismaRestockIntakeRepository } from '../infrastructure/prisma-restock-intake.repository';
import { BotRestockIntakeController } from './bot-restock-intake.controller';
import type { BotExpirationIntakeResponse } from './dto/bot-expiration-intake.response';
import type { BotRestockIntakeResponse } from './dto/bot-restock-intake.response';
import { HumanDecisionHttpFilter } from './filters/human-decision-http.filter';

const INTAKE_URL = '/chatbot-api/human-decisions';

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
      `[hd-03b3] refusing isolated-DB run: ${SOURCE_LABELS[source]} DATABASE_URL is unset.`,
    );
  }

  let url: globalThis.URL;
  try {
    url = new globalThis.URL(rawUrl);
  } catch {
    throw new Error(
      `[hd-03b3] refusing isolated-DB run: ${SOURCE_LABELS[source]} DATABASE_URL is not a valid URL.`,
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
      `[hd-03b3] refusing isolated-DB run: ${SOURCE_LABELS[source]} DATABASE_URL does not match the dedicated isolated RESTOCK target.`,
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
      `[hd-03b3] isolated DB target OK: ${EXPECTED_PROTOCOL}//${EXPECTED_HOSTNAME}:${EXPECTED_PORT}/${EXPECTED_DATABASE}`,
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

interface RestockIntakeBody {
  sourceRequestId: string;
  type: 'RESTOCK';
  productId: string;
  productName: string;
  variantId: string | null;
  sku: string | null;
  requestedQuantity: number | null;
  observedStockAtRequest: number | null;
  stockObservedAt: string | null;
  supersedesDecisionId: string | null;
}

interface ErrorEnvelope {
  statusCode: number;
  code: string;
  message: string;
}

const ERROR_ENVELOPE_KEYS = ['code', 'message', 'statusCode'];

function validBody(
  overrides: Partial<RestockIntakeBody> = {},
): RestockIntakeBody {
  return {
    sourceRequestId: crypto.randomUUID(),
    type: 'RESTOCK',
    productId: crypto.randomUUID(),
    productName: 'Cafe de altura',
    variantId: null,
    sku: 'SKU-1',
    requestedQuantity: 3,
    observedStockAtRequest: 5,
    stockObservedAt: '2026-06-01T10:00:00.000Z',
    supersedesDecisionId: null,
    ...overrides,
  };
}

/** Recompute the HD-02a canonical hash exactly as the adapter does. */
function canonicalHashFor(
  tenantId: string,
  submittedCredentialId: string,
  body: RestockIntakeBody,
): string {
  return canonicalizeRestockRequest({
    tenantId,
    sourceRequestId: body.sourceRequestId,
    productId: body.productId,
    productName: body.productName,
    variantId: body.variantId,
    sku: body.sku,
    requestedQuantity: body.requestedQuantity,
    observedStockAtRequest: body.observedStockAtRequest,
    stockObservedAt: body.stockObservedAt,
    supersedesDecisionId: body.supersedesDecisionId,
    submittedCredentialId,
  }).requestHash;
}

async function seedTenant(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await integrationPrisma().tenant.create({
    data: { id, name, slug: `restock-intake-${id}` },
  });
  return id;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Fake in-memory credential store. The guard hashes the bearer token and looks
 * it up here; nothing about credentials is persisted. This is the only mocked
 * collaborator in the chain.
 */
const credentialsByHash = new Map<string, ServiceCredential>();

const credentialRepository: IServiceCredentialRepository = {
  findByHashedKey: (hashedKey) =>
    Promise.resolve(credentialsByHash.get(hashedKey) ?? null),
  touchLastUsedAt: () => Promise.resolve(),
};

function registerCredential(params: {
  tenantId: string;
  token: string;
  scopes?: string[];
}): ServiceCredential {
  const credential = ServiceCredential.fromPersistence({
    id: `cred-${crypto.randomUUID()}`,
    tenantId: params.tenantId,
    name: 'RESTOCK intake bot',
    hashedKey: hashToken(params.token),
    scopes: params.scopes ?? ['human-decisions:create'],
    isActive: true,
    lastUsedAt: null,
    // High limit: the rate limiter is per-app instance state shared across
    // this suite's requests, and rate limiting is proven by unit tests.
    rateLimit: 1000,
    createdAt: new Date(),
    revokedAt: null,
  });
  credentialsByHash.set(credential.hashedKey, credential);
  return credential;
}

async function findDecision(id: string) {
  return integrationPrisma().humanDecision.findUnique({ where: { id } });
}

async function findDecisionOrFail(id: string) {
  const row = await findDecision(id);
  if (!row) {
    throw new Error(`[hd-03b3] expected persisted decision ${id} to exist`);
  }
  return row;
}

function receiptOf(response: { body: unknown }): BotRestockIntakeResponse {
  return response.body as BotRestockIntakeResponse;
}

// ---------------------------------------------------------------------------
// EXPIRATION intake fixtures (HD-EXP-03b)
// ---------------------------------------------------------------------------

interface ExpirationIntakeBody {
  sourceRequestId: string;
  type: 'EXPIRATION';
  productId: string;
  variantId: string | null;
}

/** Exact bot-safe receipt keys; EXPIRATION carries no SKU or stock fields. */
const EXPIRATION_RECEIPT_KEYS = [
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
].sort();

function expirationBody(
  overrides: Partial<ExpirationIntakeBody> = {},
): ExpirationIntakeBody {
  return {
    sourceRequestId: crypto.randomUUID(),
    type: 'EXPIRATION',
    productId: crypto.randomUUID(),
    variantId: null,
    ...overrides,
  };
}

/** Seed a bot-visible catalog product through the existing test DB client. */
async function seedCatalogProduct(params: {
  tenantId: string;
  name: string;
  unit?: 'UNIDAD' | 'CAJA';
  hasVariants?: boolean;
  includeInOnlineCatalog?: boolean;
}): Promise<string> {
  const id = crypto.randomUUID();
  await integrationPrisma().product.create({
    data: {
      id,
      tenantId: params.tenantId,
      name: params.name,
      unit: params.unit ?? 'UNIDAD',
      hasVariants: params.hasVariants ?? false,
      includeInOnlineCatalog: params.includeInOnlineCatalog ?? true,
    },
  });
  return id;
}

/** Seed a catalog variant; `catalogPublishMode` defaults to INHERIT. */
async function seedCatalogVariant(params: {
  tenantId: string;
  productId: string;
  name: string;
  option?: string | null;
  value?: string | null;
  catalogPublishMode?: 'INHERIT' | 'ON' | 'OFF';
}): Promise<string> {
  const id = crypto.randomUUID();
  await integrationPrisma().variant.create({
    data: {
      id,
      tenantId: params.tenantId,
      productId: params.productId,
      name: params.name,
      option: params.option ?? null,
      value: params.value ?? null,
      catalogPublishMode: params.catalogPublishMode ?? 'INHERIT',
    },
  });
  return id;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeIfDb('Bot restock intake HTTP integration (HD-03b3)', () => {
  let app: INestApplication;

  const http = () => request(app.getHttpServer() as import('node:http').Server);

  const post = (body: RestockIntakeBody, token: string) =>
    http()
      .post(INTAKE_URL)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Idempotency-Key', body.sourceRequestId)
      .send(body);

  beforeAll(async () => {
    await resetIsolatedBaseline();

    const moduleRef = await Test.createTestingModule({
      imports: [
        // REAL nestjs-cls with the express middleware mount: this opens the
        // per-request ALS store the guard writes `tenantId` into and the
        // repository reads back. No Map shim anywhere.
        ClsModule.forRoot({
          global: true,
          middleware: { mount: true },
        }),
        // REAL global Prisma + TenantPrisma providers.
        DatabaseModule,
      ],
      controllers: [BotRestockIntakeController],
      providers: [
        HumanDecisionHttpFilter,
        ServiceAuthGuard,
        {
          provide: SERVICE_CREDENTIAL_REPOSITORY,
          useValue: credentialRepository,
        },
        {
          provide: RESTOCK_INTAKE_REPOSITORY,
          useClass: PrismaRestockIntakeRepository,
        },
        {
          provide: EXPIRATION_INTAKE_REPOSITORY,
          useClass: PrismaExpirationIntakeRepository,
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

  afterEach(async () => {
    credentialsByHash.clear();
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
      // port, database name) is distinctive so the test can prove nothing from
      // it is echoed back by the guard.
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
        expect(message).toContain('[hd-03b3]');
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

  describe('create + immutable receipt', () => {
    it('creates a 201 receipt and persists a PENDING/version-1 row scoped to the credential tenant', async () => {
      const tenantId = await seedTenant('Intake Tenant A');
      const credential = registerCredential({
        tenantId,
        token: 'svc_hd03b3_tenant_a',
      });
      const body = validBody();

      const response = await post(body, 'svc_hd03b3_tenant_a').expect(201);
      const receipt = receiptOf(response);

      expect(Object.keys(receipt).sort()).toEqual([
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
      ]);
      expect(receipt.status).toBe('PENDING');
      expect(receipt.version).toBe(1);
      expect(receipt.resolution).toBeNull();
      expect(receipt.applyBefore).toBeNull();
      expect(receipt.type).toBe('RESTOCK');
      expect(receipt.sourceRequestId).toBe(body.sourceRequestId);
      expect(receipt.supersedesDecisionId).toBeNull();
      // Server-derived branch snapshot from the credential tenant.
      expect(receipt.snapshot).toEqual({
        branchId: tenantId,
        branchName: 'Intake Tenant A',
        productId: body.productId,
        productName: 'Cafe de altura',
        variantId: null,
        sku: 'SKU-1',
        requestedQuantity: 3,
        observedStockAtRequest: 5,
        stockObservedAt: '2026-06-01T10:00:00.000Z',
      });

      const serialized = JSON.stringify(receipt);
      expect(serialized).not.toContain(credential.id);
      expect(receipt).not.toHaveProperty('canonicalRequestHash');
      expect(receipt).not.toHaveProperty('submittedCredentialId');
      expect(receipt).not.toHaveProperty('source');

      const row = await findDecisionOrFail(receipt.id);
      expect(row.tenantId).toBe(tenantId);
      expect(row.source).toBe(RESTOCK_SOURCE);
      expect(row.type).toBe(RESTOCK_TYPE);
      expect(row.status).toBe('PENDING');
      expect(row.version).toBe(1);
      // Immutable credential audit + server branch snapshot.
      expect(row.submittedCredentialId).toBe(credential.id);
      expect(row.branchId).toBe(tenantId);
      expect(row.branchName).toBe('Intake Tenant A');
      expect(row.productId).toBe(body.productId);
      expect(row.productName).toBe('Cafe de altura');
      expect(row.sourceRequestId).toBe(body.sourceRequestId);
      // Stable canonical hash (credential excluded from the identity).
      expect(row.canonicalRequestHash).toBe(
        canonicalHashFor(tenantId, credential.id, body),
      );
      expect(row.createdAt.toISOString()).toBe(receipt.createdAt);
    });
  });

  describe('idempotent replay', () => {
    it('returns a 200 deep/byte-equal receipt after credential rotation and mutates no row', async () => {
      const tenantId = await seedTenant('Rotation Tenant');
      const original = registerCredential({
        tenantId,
        token: 'svc_rotation_original',
      });
      const body = validBody();

      const created = await post(body, 'svc_rotation_original').expect(201);
      const createdReceipt = receiptOf(created);
      const before = await findDecisionOrFail(createdReceipt.id);

      // Rotation: a NEW credential for the same tenant replays the identity.
      const rotated = registerCredential({
        tenantId,
        token: 'svc_rotation_new',
      });
      expect(rotated.id).not.toBe(original.id);

      const replayed = await post(body, 'svc_rotation_new').expect(200);

      expect(replayed.body).toEqual(created.body);
      expect(JSON.stringify(replayed.body)).toBe(JSON.stringify(created.body));

      const after = await findDecisionOrFail(createdReceipt.id);
      expect(after.submittedCredentialId).toBe(original.id);
      expect(after.submittedCredentialId).not.toBe(rotated.id);
      expect(after.canonicalRequestHash).toBe(before.canonicalRequestHash);
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      expect(after.status).toBe('PENDING');
      expect(after.version).toBe(1);
      expect(
        await integrationPrisma().humanDecision.count({ where: { tenantId } }),
      ).toBe(1);
    });
  });

  describe('idempotency conflict', () => {
    it('rejects a changed product/stock under the same key with a 409 envelope and no DB mutation', async () => {
      const tenantId = await seedTenant('Conflict Tenant');
      registerCredential({ tenantId, token: 'svc_conflict' });
      const body = validBody();

      const created = await post(body, 'svc_conflict').expect(201);
      const before = await findDecisionOrFail(receiptOf(created).id);

      const changed = validBody({
        sourceRequestId: body.sourceRequestId,
        productId: crypto.randomUUID(),
        requestedQuantity: 9,
      });
      const response = await post(changed, 'svc_conflict').expect(409);
      const envelope = response.body as ErrorEnvelope;

      expect(envelope).toEqual({
        statusCode: 409,
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'Request conflicts with a previous submission',
      });
      expect(Object.keys(envelope).sort()).toEqual(ERROR_ENVELOPE_KEYS);
      expect(JSON.stringify(envelope)).not.toContain('hash');

      const after = await findDecisionOrFail(before.id);
      expect(after.canonicalRequestHash).toBe(before.canonicalRequestHash);
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      expect(after.productId).toBe(body.productId);
      expect(after.requestedQuantity).toBe(3);
      expect(
        await integrationPrisma().humanDecision.count({ where: { tenantId } }),
      ).toBe(1);
    });
  });

  describe('HD-02a semantic validation', () => {
    it('maps an invalid calendar date with paired stock to a sanitized 400 VALIDATION_ERROR with no row', async () => {
      const tenantId = await seedTenant('Validation Tenant');
      registerCredential({ tenantId, token: 'svc_validation' });
      // Structurally valid DTO (string + int) but a non-existent calendar day:
      // only the HD-02a normalizer can reject it.
      const body = validBody({
        observedStockAtRequest: 5,
        stockObservedAt: '2026-02-30T10:00:00.000Z',
      });

      const response = await post(body, 'svc_validation').expect(400);
      const envelope = response.body as ErrorEnvelope;

      expect(envelope).toEqual({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
      });
      expect(Object.keys(envelope).sort()).toEqual(ERROR_ENVELOPE_KEYS);
      expect(JSON.stringify(envelope)).not.toContain('2026-02-30');
      expect(
        await integrationPrisma().humanDecision.count({ where: { tenantId } }),
      ).toBe(0);
    });
  });

  describe('predecessor visibility', () => {
    it('returns the same sanitized 404 for a missing and for a foreign predecessor, persisting no row', async () => {
      const tenantA = await seedTenant('Predecessor Tenant A');
      const tenantB = await seedTenant('Predecessor Tenant B');
      registerCredential({ tenantId: tenantA, token: 'svc_pred_a' });
      registerCredential({ tenantId: tenantB, token: 'svc_pred_b' });

      // A real predecessor owned by tenant B.
      const foreignCreated = await post(validBody(), 'svc_pred_b').expect(201);
      const foreignRow = await findDecisionOrFail(receiptOf(foreignCreated).id);
      expect(foreignRow.tenantId).toBe(tenantB);

      const missing = await post(
        validBody({ supersedesDecisionId: crypto.randomUUID() }),
        'svc_pred_a',
      ).expect(404);

      const foreign = await post(
        validBody({ supersedesDecisionId: foreignRow.id }),
        'svc_pred_a',
      ).expect(404);

      const expected = {
        statusCode: 404,
        code: 'NOT_FOUND',
        message: 'Not found',
      };
      expect(missing.body).toEqual(expected);
      expect(foreign.body).toEqual(expected);
      expect(Object.keys(foreign.body as object).sort()).toEqual(
        ERROR_ENVELOPE_KEYS,
      );

      expect(
        await integrationPrisma().humanDecision.count({
          where: { tenantId: tenantA },
        }),
      ).toBe(0);
      expect(
        await integrationPrisma().humanDecision.count({
          where: { tenantId: tenantB },
        }),
      ).toBe(1);
    });
  });

  describe('tenant scoping via real CLS ALS', () => {
    it('creates a separate row per credential tenant for the same sourceRequestId and rejects a body tenant spoof', async () => {
      const tenantA = await seedTenant('Cls Tenant A');
      const tenantB = await seedTenant('Cls Tenant B');
      const credentialA = registerCredential({
        tenantId: tenantA,
        token: 'svc_cls_a',
      });
      const credentialB = registerCredential({
        tenantId: tenantB,
        token: 'svc_cls_b',
      });
      const body = validBody();

      const responseA = await post(body, 'svc_cls_a').expect(201);
      const responseB = await post(body, 'svc_cls_b').expect(201);
      const receiptA = receiptOf(responseA);
      const receiptB = receiptOf(responseB);

      expect(receiptA.id).not.toBe(receiptB.id);
      expect(receiptA.snapshot.branchId).toBe(tenantA);
      expect(receiptA.snapshot.branchName).toBe('Cls Tenant A');
      expect(receiptB.snapshot.branchId).toBe(tenantB);
      expect(receiptB.snapshot.branchName).toBe('Cls Tenant B');

      const rows = await integrationPrisma().humanDecision.findMany({
        where: { sourceRequestId: body.sourceRequestId },
      });
      expect(rows).toHaveLength(2);
      const byTenant = new Map(rows.map((row) => [row.tenantId, row]));
      expect(byTenant.get(tenantA)?.submittedCredentialId).toBe(credentialA.id);
      expect(byTenant.get(tenantB)?.submittedCredentialId).toBe(credentialB.id);

      // Tenant scoping also hides A's decision from B's predecessor lookup.
      const crossTenant = await post(
        validBody({ supersedesDecisionId: receiptA.id }),
        'svc_cls_b',
      ).expect(404);
      expect(crossTenant.body).toEqual({
        statusCode: 404,
        code: 'NOT_FOUND',
        message: 'Not found',
      });

      // A body-supplied tenant is an unknown field: 400 and no third row.
      const spoofed = await post(
        {
          ...validBody(),
          tenantId: tenantB,
        } as RestockIntakeBody,
        'svc_cls_a',
      ).expect(400);
      const spoofEnvelope = spoofed.body as ErrorEnvelope;
      expect(spoofEnvelope).toEqual({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
      });
      expect(JSON.stringify(spoofEnvelope)).not.toContain(tenantB);

      // Real nestjs-cls service (not a Map shim) and no ambient tenant outside
      // a request.
      const cls = app.get(ClsService);
      expect(cls).toBeInstanceOf(ClsService);
      expect(cls.isActive()).toBe(false);

      expect(await integrationPrisma().humanDecision.count()).toBe(2);
    });
  });

  describe('real guard', () => {
    it('returns 401 for an unknown token and 403 for a credential missing the scope, persisting no row', async () => {
      const tenantId = await seedTenant('Guard Tenant');
      const readOnly = registerCredential({
        tenantId,
        token: 'svc_guard_readonly',
        scopes: ['catalog:read'],
      });
      const body = validBody();

      const unauthorized = await post(body, 'svc_unknown_token').expect(401);
      expect(unauthorized.body).toEqual({
        statusCode: 401,
        code: 'UNAUTHORIZED',
        message: 'Unauthorized',
      });

      const forbidden = await post(body, 'svc_guard_readonly').expect(403);
      expect(forbidden.body).toEqual({
        statusCode: 403,
        code: 'FORBIDDEN',
        message: 'Forbidden',
      });
      expect(JSON.stringify(forbidden.body)).not.toContain(readOnly.id);
      expect(
        await integrationPrisma().humanDecision.count({ where: { tenantId } }),
      ).toBe(0);
    });
  });

  describe('EXPIRATION intake on the shared route (HD-EXP-03b)', () => {
    const expPost = (body: ExpirationIntakeBody, token: string) =>
      http()
        .post(INTAKE_URL)
        .set('Authorization', `Bearer ${token}`)
        .set('X-Idempotency-Key', body.sourceRequestId)
        .send(body);

    it('creates a 201 PENDING/v1 receipt for a simple product with the persisted unit and no SKU', async () => {
      const tenantId = await seedTenant('Exp Simple Tenant');
      const credential = registerCredential({
        tenantId,
        token: 'svc_exp_simple',
      });
      const productId = await seedCatalogProduct({
        tenantId,
        name: 'Ibuprofeno 400 mg',
        unit: 'CAJA',
      });
      const body = expirationBody({ productId });
      const response = await expPost(body, 'svc_exp_simple').expect(201);
      const receipt = response.body as BotExpirationIntakeResponse;

      expect(Object.keys(receipt).sort()).toEqual(EXPIRATION_RECEIPT_KEYS);
      expect(receipt.type).toBe('EXPIRATION');
      expect(receipt.status).toBe('PENDING');
      expect(receipt.version).toBe(1);
      expect(receipt.sourceRequestId).toBe(body.sourceRequestId);
      expect(receipt.supersedesDecisionId).toBeNull();
      expect(receipt.resolution).toBeNull();
      expect(receipt.applyBefore).toBeNull();
      expect(receipt.snapshot).toEqual({
        branchId: tenantId,
        branchName: 'Exp Simple Tenant',
        productId,
        productName: 'Ibuprofeno 400 mg',
        unit: 'CAJA',
        variantId: null,
        variantName: null,
        variantOption: null,
        variantValue: null,
      });
      expect(JSON.stringify(receipt)).not.toContain(credential.id);
      const row = await findDecisionOrFail(receipt.id);
      expect(row).toMatchObject({
        tenantId,
        type: 'EXPIRATION',
        status: 'PENDING',
        version: 1,
        submittedCredentialId: credential.id,
        branchId: tenantId,
        productId,
        productName: 'Ibuprofeno 400 mg',
        productUnit: 'CAJA',
        variantId: null,
        variantName: null,
        variantOption: null,
        variantValue: null,
        sku: null,
      });
    });

    it('creates a 201 variant receipt with unit and variant metadata and no SKU', async () => {
      const tenantId = await seedTenant('Exp Variant Tenant');
      registerCredential({ tenantId, token: 'svc_exp_variant' });
      const productId = await seedCatalogProduct({
        tenantId,
        name: 'Filtro de aceite',
        hasVariants: true,
      });
      const variantId = await seedCatalogVariant({
        tenantId,
        productId,
        name: 'Verde',
        option: 'Color',
        value: 'Verde',
        catalogPublishMode: 'ON',
      });
      const body = expirationBody({ productId, variantId });
      const response = await expPost(body, 'svc_exp_variant').expect(201);
      const receipt = response.body as BotExpirationIntakeResponse;

      expect(receipt.snapshot).toEqual({
        branchId: tenantId,
        branchName: 'Exp Variant Tenant',
        productId,
        productName: 'Filtro de aceite',
        unit: 'UNIDAD',
        variantId,
        variantName: 'Verde',
        variantOption: 'Color',
        variantValue: 'Verde',
      });
      expect(receipt).not.toHaveProperty('sku');
      const row = await findDecisionOrFail(receipt.id);
      expect(row).toMatchObject({
        productUnit: 'UNIDAD',
        variantId,
        variantName: 'Verde',
        variantOption: 'Color',
        variantValue: 'Verde',
        sku: null,
      });
    });

    it('replays an exact request as a 200 unchanged historical receipt after a catalog rename and unpublish', async () => {
      const tenantId = await seedTenant('Exp Replay Tenant');
      registerCredential({ tenantId, token: 'svc_exp_replay' });
      const productId = await seedCatalogProduct({
        tenantId,
        name: 'Original Label',
      });
      const body = expirationBody({ productId });
      const created = await expPost(body, 'svc_exp_replay').expect(201);
      const createdReceipt = created.body as BotExpirationIntakeResponse;
      const before = await findDecisionOrFail(createdReceipt.id);
      // Mutate the live catalog through the existing test DB client: rename the
      // product and remove it from the online catalog, so replay must win
      // BEFORE any current-catalog validation.
      await integrationPrisma().product.update({
        where: { id: productId },
        data: { name: 'Renamed Label', includeInOnlineCatalog: false },
      });
      const replayed = await expPost(body, 'svc_exp_replay').expect(200);
      const replayedReceipt = replayed.body as BotExpirationIntakeResponse;

      expect(replayed.body).toEqual(created.body);
      expect(replayedReceipt.snapshot.productName).toBe('Original Label');
      const after = await findDecisionOrFail(createdReceipt.id);
      expect(after.productName).toBe('Original Label');
      expect(after.productName).toBe(before.productName);
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      expect(
        await integrationPrisma().humanDecision.count({
          where: { tenantId, type: 'EXPIRATION' },
        }),
      ).toBe(1);
    });

    it('rejects a changed payload under the same key with a 409 envelope and no extra row', async () => {
      const tenantId = await seedTenant('Exp Conflict Tenant');
      registerCredential({ tenantId, token: 'svc_exp_conflict' });
      const productId = await seedCatalogProduct({
        tenantId,
        name: 'Conflict A',
      });
      const otherProductId = await seedCatalogProduct({
        tenantId,
        name: 'Conflict B',
      });
      const body = expirationBody({ productId });
      const created = await expPost(body, 'svc_exp_conflict').expect(201);
      const before = await findDecisionOrFail(
        (created.body as BotExpirationIntakeResponse).id,
      );
      const response = await expPost(
        expirationBody({
          sourceRequestId: body.sourceRequestId,
          productId: otherProductId,
        }),
        'svc_exp_conflict',
      ).expect(409);
      const envelope = response.body as ErrorEnvelope;

      expect(envelope).toEqual({
        statusCode: 409,
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'Request conflicts with a previous submission',
      });
      expect(Object.keys(envelope).sort()).toEqual(ERROR_ENVELOPE_KEYS);
      expect(JSON.stringify(envelope)).not.toContain('hash');
      const after = await findDecisionOrFail(before.id);
      expect(after.productId).toBe(productId);
      expect(after.canonicalRequestHash).toBe(before.canonicalRequestHash);
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      expect(
        await integrationPrisma().humanDecision.count({ where: { tenantId } }),
      ).toBe(1);
    });

    it('isolates tenant catalog eligibility: foreign product and cross-tenant variant 404, variant mismatches 400, nothing persisted', async () => {
      const tenantA = await seedTenant('Exp Ownership A');
      const tenantB = await seedTenant('Exp Ownership B');
      registerCredential({ tenantId: tenantA, token: 'svc_exp_own_a' });
      const simpleProductId = await seedCatalogProduct({
        tenantId: tenantA,
        name: 'Owned Simple',
      });
      const variantProductId = await seedCatalogProduct({
        tenantId: tenantA,
        name: 'Owned Variant',
        hasVariants: true,
      });
      // Owned visible variant keeps the variant product eligible for the 400.
      await seedCatalogVariant({
        tenantId: tenantA,
        productId: variantProductId,
        name: 'Owned Visible',
      });
      const foreignProductId = await seedCatalogProduct({
        tenantId: tenantB,
        name: 'Foreign Secret Product',
      });
      // The variant claims tenant A's product but belongs to tenant B: the
      // adapter predicate requires BOTH productId and tenantId, so it is hidden.
      const crossTenantVariantId = await seedCatalogVariant({
        tenantId: tenantB,
        productId: variantProductId,
        name: 'Foreign Variant',
      });

      const foreignProduct = await expPost(
        expirationBody({ productId: foreignProductId }),
        'svc_exp_own_a',
      ).expect(404);
      const crossTenantVariant = await expPost(
        expirationBody({
          productId: variantProductId,
          variantId: crossTenantVariantId,
        }),
        'svc_exp_own_a',
      ).expect(404);
      const variantRequired = await expPost(
        expirationBody({ productId: variantProductId, variantId: null }),
        'svc_exp_own_a',
      ).expect(400);
      const variantNotAllowed = await expPost(
        expirationBody({
          productId: simpleProductId,
          variantId: crypto.randomUUID(),
        }),
        'svc_exp_own_a',
      ).expect(400);

      const notFound = {
        statusCode: 404,
        code: 'NOT_FOUND',
        message: 'Not found',
      };
      expect(foreignProduct.body).toEqual(notFound);
      expect(crossTenantVariant.body).toEqual(notFound);
      expect(JSON.stringify(foreignProduct.body)).not.toContain(tenantB);
      expect(JSON.stringify(foreignProduct.body)).not.toContain(
        'Foreign Secret Product',
      );
      const validation = {
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
      };
      expect(variantRequired.body).toEqual(validation);
      expect(variantNotAllowed.body).toEqual(validation);
      expect(
        await integrationPrisma().humanDecision.count({
          where: { tenantId: tenantA },
        }),
      ).toBe(0);
    });
  });
});
