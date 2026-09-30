/**
 * HD-03b2 — HTTP contract for `POST /chatbot-api/human-decisions`.
 *
 * In-memory Nest app + Supertest (`app.init()`, NO listening port): the REAL
 * `ServiceAuthGuard` (fake credential repository + fake CLS slot) and the REAL
 * global `ValidationPipe` configured exactly like `main.ts` run against a
 * mocked `IRestockIntakeRepository`, so no DB, provider or network is needed.
 * The controller-scoped `HumanDecisionHttpFilter` must win over the REAL
 * global `DomainExceptionFilter`/`PrismaExceptionFilter`.
 */
import {
  BadRequestException,
  INestApplication,
  UnauthorizedException,
} from '@nestjs/common';
import {
  EXCEPTION_FILTERS_METADATA,
  GUARDS_METADATA,
  MODULE_METADATA,
} from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { ClsService } from 'nestjs-cls';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { ServiceCredential } from '../../chatbot-api/domain/service-credential.entity';
import { SERVICE_CREDENTIAL_REPOSITORY } from '../../chatbot-api/domain/service-credential.repository';
import { ChatbotApiModule } from '../../chatbot-api/chatbot-api.module';
import { REQUIRED_SCOPES_KEY } from '../../chatbot-api/presentation/decorators/required-scopes.decorator';
import { ServiceAuthGuard } from '../../chatbot-api/presentation/guards/service-auth.guard';
import { DomainExceptionFilter } from '../../shared/filters/domain-exception.filter';
import { PrismaExceptionFilter } from '../../shared/filters/prisma-exception.filter';
import { createAppValidationPipe } from '../../shared/listing/app-validation.pipe';
import { EXPIRATION_TYPE } from '../domain/expiration-intake.request';
import {
  EXPIRATION_INTAKE_REPOSITORY,
  ExpirationIntakeError,
  type ExpirationIntakeInput,
  type ExpirationIntakeResult,
  type PersistedExpirationDecision,
} from '../domain/expiration-intake.repository';
import {
  RESTOCK_INTAKE_REPOSITORY,
  RestockIntakeError,
  type PersistedRestockDecision,
  type RestockIntakeInput,
  type RestockIntakeResult,
} from '../domain/restock-intake.repository';
import { HumanDecisionsModule } from '../human-decisions.module';
import { PrismaExpirationIntakeRepository } from '../infrastructure/prisma-expiration-intake.repository';
import { PrismaRestockIntakeRepository } from '../infrastructure/prisma-restock-intake.repository';
import { BotRestockIntakeController } from './bot-restock-intake.controller';
import type { BotRestockIntakeResponse } from './dto/bot-restock-intake.response';
import { HumanDecisionHttpFilter } from './filters/human-decision-http.filter';

const URL = '/chatbot-api/human-decisions';
const RAW_TOKEN = 'svc_hd_intake_token';
const HASHED_TOKEN = createHash('sha256').update(RAW_TOKEN).digest('hex');

const VALID_BODY = {
  sourceRequestId: '11111111-1111-4111-8111-111111111111',
  type: 'RESTOCK',
  productId: '22222222-2222-4222-8222-222222222222',
  productName: 'Filtro de aceite',
  variantId: null,
  sku: 'SKU-1',
  requestedQuantity: 3,
  observedStockAtRequest: 5,
  stockObservedAt: '2026-06-01T10:00:00.000Z',
  supersedesDecisionId: null,
} as const;

const DECISION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const PENDING_ROW: PersistedRestockDecision = {
  id: DECISION_ID,
  source: 'houndfe-chatbot',
  sourceRequestId: VALID_BODY.sourceRequestId,
  type: 'RESTOCK',
  canonicalRequestHash: 'hash-v1',
  status: 'PENDING',
  version: 1,
  supersedesDecisionId: null,
  createdAt: new Date('2026-06-01T10:00:05.000Z'),
  snapshot: {
    branchId: 'tenant-1',
    branchName: 'Sucursal Centro',
    productId: VALID_BODY.productId,
    productName: 'Filtro de aceite',
    variantId: null,
    sku: 'SKU-1',
    requestedQuantity: 3,
    observedStockAtRequest: 5,
    stockObservedAt: new Date('2026-06-01T10:00:00.000Z'),
  },
};

/** Same immutable columns, but the row has since been RESOLVED (version 2). */
const RESOLVED_ROW: PersistedRestockDecision = {
  ...PENDING_ROW,
  canonicalRequestHash: 'hash-v2',
  status: 'RESOLVED',
  version: 2,
};

const EXPECTED_RECEIPT: BotRestockIntakeResponse = {
  id: DECISION_ID,
  sourceRequestId: VALID_BODY.sourceRequestId,
  type: 'RESTOCK',
  status: 'PENDING',
  version: 1,
  createdAt: '2026-06-01T10:00:05.000Z',
  snapshot: {
    branchId: 'tenant-1',
    branchName: 'Sucursal Centro',
    productId: VALID_BODY.productId,
    productName: 'Filtro de aceite',
    variantId: null,
    sku: 'SKU-1',
    requestedQuantity: 3,
    observedStockAtRequest: 5,
    stockObservedAt: '2026-06-01T10:00:00.000Z',
  },
  supersedesDecisionId: null,
  resolution: null,
  applyBefore: null,
};

const EXPECTED_ERROR_KEYS = ['code', 'message', 'statusCode'];

// ---------------------------------------------------------------------------
// HD-EXP-03 EXPIRATION intake fixtures (same route, EXPIRATION discriminant).
// ---------------------------------------------------------------------------

const EXP_DECISION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EXP_VARIANT_BODY = {
  sourceRequestId: VALID_BODY.sourceRequestId,
  type: EXPIRATION_TYPE,
  productId: VALID_BODY.productId,
  variantId: '33333333-3333-4333-8333-333333333333',
} as const;

const EXP_SIMPLE_BODY = {
  sourceRequestId: VALID_BODY.sourceRequestId,
  type: EXPIRATION_TYPE,
  productId: VALID_BODY.productId,
  variantId: null,
} as const;

const EXP_PENDING_ROW: PersistedExpirationDecision = {
  id: EXP_DECISION_ID,
  source: 'houndfe-chatbot',
  sourceRequestId: EXP_SIMPLE_BODY.sourceRequestId,
  type: EXPIRATION_TYPE,
  canonicalRequestHash: 'exp-hash-v1',
  status: 'PENDING',
  version: 1,
  createdAt: new Date('2026-06-01T10:00:05.000Z'),
  snapshot: {
    branchId: 'tenant-1',
    branchName: 'Sucursal Centro',
    productId: EXP_SIMPLE_BODY.productId,
    productName: 'Filtro de aceite',
    productUnit: 'UNIT',
    variantId: null,
    variantName: null,
    variantOption: null,
    variantValue: null,
  },
};

const EXP_VARIANT_ROW: PersistedExpirationDecision = {
  ...EXP_PENDING_ROW,
  snapshot: {
    ...EXP_PENDING_ROW.snapshot,
    variantId: EXP_VARIANT_BODY.variantId,
    variantName: 'Verde',
    variantOption: 'Color',
    variantValue: 'Verde',
  },
};

/** Same immutable columns, but the row has since been RESOLVED (version 2). */
const EXP_RESOLVED_ROW: PersistedExpirationDecision = {
  ...EXP_PENDING_ROW,
  canonicalRequestHash: 'exp-hash-v2',
  status: 'RESOLVED',
  version: 2,
};

const EXP_EXPECTED_RECEIPT = {
  id: EXP_DECISION_ID,
  sourceRequestId: EXP_SIMPLE_BODY.sourceRequestId,
  type: EXPIRATION_TYPE,
  status: 'PENDING',
  version: 1,
  createdAt: '2026-06-01T10:00:05.000Z',
  snapshot: {
    branchId: 'tenant-1',
    branchName: 'Sucursal Centro',
    productId: EXP_SIMPLE_BODY.productId,
    productName: 'Filtro de aceite',
    unit: 'UNIT',
    variantId: null,
    variantName: null,
    variantOption: null,
    variantValue: null,
  },
  supersedesDecisionId: null,
  resolution: null,
  applyBefore: null,
};

const EXP_RECEIPT_KEYS = [
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

const EXP_SNAPSHOT_KEYS = [
  'branchId',
  'branchName',
  'productId',
  'productName',
  'unit',
  'variantId',
  'variantName',
  'variantOption',
  'variantValue',
];

const EXPECTED_EXP_DELEGATED_KEYS = [
  'productId',
  'sourceRequestId',
  'submittedCredentialId',
  'type',
  'variantId',
];

interface ErrorEnvelope {
  statusCode: number;
  code: string;
  message: string;
}

type CreateArgs = Parameters<BotRestockIntakeController['create']>;

type CredentialOverrides = Partial<{
  id: string;
  tenantId: string;
  name: string;
  hashedKey: string;
  scopes: string[];
  isActive: boolean;
  lastUsedAt: Date | null;
  rateLimit: number;
  createdAt: Date;
  revokedAt: Date | null;
}>;

function makeCredential(
  overrides: CredentialOverrides = {},
): ServiceCredential {
  return ServiceCredential.fromPersistence({
    id: 'cred-hd-1',
    tenantId: 'tenant-1',
    name: 'Human Decisions Bot',
    hashedKey: HASHED_TOKEN,
    scopes: ['human-decisions:create'],
    isActive: true,
    lastUsedAt: null,
    rateLimit: 60,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    revokedAt: null,
    ...overrides,
  });
}

describe('Bot restock intake HTTP contract (HD-03b2)', () => {
  let app: INestApplication;
  let submit: jest.Mock<Promise<RestockIntakeResult>, [RestockIntakeInput]>;
  let expirationSubmit: jest.Mock<
    Promise<ExpirationIntakeResult>,
    [ExpirationIntakeInput]
  >;
  let findByHashedKey: jest.Mock<Promise<ServiceCredential | null>, [string]>;
  let touchLastUsedAt: jest.Mock<Promise<void>, [string, (Date | undefined)?]>;
  let clsSet: jest.Mock<void, [string, unknown]>;
  let credential: ServiceCredential | null;
  let clsStore: Record<string, unknown>;

  const http = () => request(app.getHttpServer() as import('node:http').Server);
  const post = (body: unknown = VALID_BODY, token = RAW_TOKEN) =>
    http()
      .post(URL)
      .set('Authorization', `Bearer ${token}`)
      .set('x-idempotency-key', VALID_BODY.sourceRequestId)
      .send(body as object);

  beforeEach(async () => {
    credential = makeCredential();
    clsStore = {};
    clsSet = jest.fn<void, [string, unknown]>((key, value) => {
      clsStore[key] = value;
    });
    submit = jest.fn<Promise<RestockIntakeResult>, [RestockIntakeInput]>();
    expirationSubmit = jest.fn<
      Promise<ExpirationIntakeResult>,
      [ExpirationIntakeInput]
    >();
    findByHashedKey = jest.fn<Promise<ServiceCredential | null>, [string]>(() =>
      Promise.resolve(credential),
    );
    touchLastUsedAt = jest.fn<Promise<void>, [string, (Date | undefined)?]>(
      () => Promise.resolve(),
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [BotRestockIntakeController],
      providers: [
        HumanDecisionHttpFilter,
        ServiceAuthGuard,
        {
          provide: SERVICE_CREDENTIAL_REPOSITORY,
          useValue: { findByHashedKey, touchLastUsedAt },
        },
        {
          provide: ClsService,
          useValue: {
            set: clsSet,
            get: jest.fn((key: string) => clsStore[key]),
          },
        },
        {
          provide: RESTOCK_INTAKE_REPOSITORY,
          useValue: { submit },
        },
        {
          provide: EXPIRATION_INTAKE_REPOSITORY,
          useValue: { submit: expirationSubmit },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    // The SAME production pipe factory `main.ts` installs, so the RESTOCK
    // re-validation performed inside the controller matches global behavior.
    app.useGlobalPipes(createAppValidationPipe());
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new PrismaExceptionFilter(),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('guard metadata and wiring', () => {
    it('binds the create handler to human-decisions:create, the service guard and the scoped filter', () => {
      const createHandler = Object.getOwnPropertyDescriptor(
        BotRestockIntakeController.prototype,
        'create',
      )?.value as () => void;

      expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, createHandler)).toEqual([
        'human-decisions:create',
      ]);

      const guards = (Reflect.getMetadata(
        GUARDS_METADATA,
        BotRestockIntakeController,
      ) ?? []) as unknown[];
      const filters = (Reflect.getMetadata(
        EXCEPTION_FILTERS_METADATA,
        BotRestockIntakeController,
      ) ?? []) as unknown[];

      expect(guards).toContain(ServiceAuthGuard);
      expect(filters).toContain(HumanDecisionHttpFilter);
    });

    it('declares the module controller, the intake port binding and the exported guard dependency', () => {
      const controllers = (Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        HumanDecisionsModule,
      ) ?? []) as unknown[];
      const imports = (Reflect.getMetadata(
        MODULE_METADATA.IMPORTS,
        HumanDecisionsModule,
      ) ?? []) as unknown[];
      const providers = (Reflect.getMetadata(
        MODULE_METADATA.PROVIDERS,
        HumanDecisionsModule,
      ) ?? []) as Array<{ provide?: unknown; useClass?: unknown }>;
      const chatbotExports = (Reflect.getMetadata(
        MODULE_METADATA.EXPORTS,
        ChatbotApiModule,
      ) ?? []) as unknown[];

      expect(controllers).toContain(BotRestockIntakeController);
      expect(imports).toContain(ChatbotApiModule);
      expect(chatbotExports).toContain(ServiceAuthGuard);
      expect(chatbotExports).toContain(SERVICE_CREDENTIAL_REPOSITORY);

      const binding = providers.find(
        (provider) => provider?.provide === RESTOCK_INTAKE_REPOSITORY,
      );
      expect(binding?.useClass).toBe(PrismaRestockIntakeRepository);

      // HD-EXP-03: the EXPIRATION port is bound to its Prisma adapter and the
      // shared route controller stays declared exactly ONCE (no duplicate
      // route, no second POST handler).
      const expirationBinding = providers.find(
        (provider) => provider?.provide === EXPIRATION_INTAKE_REPOSITORY,
      );
      expect(expirationBinding?.useClass).toBe(
        PrismaExpirationIntakeRepository,
      );
      expect(
        controllers.filter((entry) => entry === BotRestockIntakeController),
      ).toHaveLength(1);
    });
  });

  describe('success path (201 create / 200 exact replay)', () => {
    it('creates with 201, delegates only the allowlisted fields and audits the server credential', async () => {
      submit.mockResolvedValue({ status: 'created', request: PENDING_ROW });

      const res = await post().expect(201);
      const body = res.body as BotRestockIntakeResponse;

      expect(body).toEqual(EXPECTED_RECEIPT);
      expect(Object.keys(body).sort()).toEqual([
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

      expect(submit).toHaveBeenCalledTimes(1);
      const delegated = submit.mock.calls[0][0];
      expect(delegated).toEqual({
        sourceRequestId: VALID_BODY.sourceRequestId,
        productId: VALID_BODY.productId,
        productName: VALID_BODY.productName,
        variantId: null,
        sku: 'SKU-1',
        requestedQuantity: 3,
        observedStockAtRequest: 5,
        stockObservedAt: '2026-06-01T10:00:00.000Z',
        supersedesDecisionId: null,
        submittedCredentialId: 'cred-hd-1',
      });
      expect(Object.keys(delegated).sort()).toEqual([
        'observedStockAtRequest',
        'productId',
        'productName',
        'requestedQuantity',
        'sku',
        'sourceRequestId',
        'stockObservedAt',
        'submittedCredentialId',
        'supersedesDecisionId',
        'variantId',
      ]);
    });

    it('takes tenant from the credential (CLS), never from the delegated body', async () => {
      submit.mockResolvedValue({ status: 'created', request: PENDING_ROW });

      await post().expect(201);

      expect(clsSet).toHaveBeenCalledWith('tenantId', 'tenant-1');
      const delegated = submit.mock.calls[0][0] as unknown as Record<
        string,
        unknown
      >;
      expect(delegated).not.toHaveProperty('tenantId');
      expect(delegated).not.toHaveProperty('source');
      expect(delegated).not.toHaveProperty('type');
      expect(delegated).not.toHaveProperty('branchId');
      expect(delegated).not.toHaveProperty('branchName');
    });

    it('replays a RESOLVED/version-2 row as an identical PENDING/version-1 receipt with HTTP 200', async () => {
      submit.mockResolvedValueOnce({ status: 'created', request: PENDING_ROW });
      const created = await post().expect(201);

      submit.mockResolvedValueOnce({
        status: 'replayed',
        request: RESOLVED_ROW,
      });
      const replayed = await post().expect(200);
      const body = replayed.body as BotRestockIntakeResponse;

      expect(replayed.body).toEqual(created.body);
      expect(body).toEqual(EXPECTED_RECEIPT);
      expect(body.status).toBe('PENDING');
      expect(body.version).toBe(1);
      expect(body.resolution).toBeNull();
      expect(body.applyBefore).toBeNull();
    });

    it('never leaks credential, hash, source, tenant or PII in the receipt', async () => {
      submit.mockResolvedValue({ status: 'created', request: PENDING_ROW });

      const res = await post().expect(201);
      const body = res.body as Record<string, unknown>;
      const serialized = JSON.stringify(body);

      expect(serialized).not.toContain('cred-hd-1');
      expect(serialized).not.toContain('hash-v1');
      expect(body).not.toHaveProperty('canonicalRequestHash');
      expect(body).not.toHaveProperty('submittedCredentialId');
      expect(body).not.toHaveProperty('source');
      expect(body).not.toHaveProperty('tenantId');
      expect(body).not.toHaveProperty('allowedActions');
    });
  });

  describe('idempotency header vs body sourceRequestId (before the repository)', () => {
    it.each([
      ['a missing header', undefined],
      ['a non-UUID header', 'not-a-uuid'],
      [
        'a UUID that differs from sourceRequestId',
        '99999999-9999-4999-8999-999999999999',
      ],
    ])(
      'rejects %s with a sanitized 400 VALIDATION_ERROR',
      async (_label, key) => {
        const builder = http()
          .post(URL)
          .set('Authorization', `Bearer ${RAW_TOKEN}`);
        if (key !== undefined) {
          builder.set('x-idempotency-key', key);
        }

        const res = await builder.send(VALID_BODY as object).expect(400);
        const body = res.body as ErrorEnvelope;

        expect(body).toEqual({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
        });
        expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
        expect(submit).not.toHaveBeenCalled();
      },
    );
  });

  describe('body validation through the real global ValidationPipe', () => {
    it.each([
      ['missing type', { ...VALID_BODY, type: undefined }],
      ['wrong type discriminant', { ...VALID_BODY, type: 'SALE' }],
      ['a body-supplied tenantId', { ...VALID_BODY, tenantId: 'evil-tenant' }],
      ['a body-supplied source', { ...VALID_BODY, source: 'evil-source' }],
      ['a body-supplied branchId', { ...VALID_BODY, branchId: 'evil-branch' }],
      [
        'a body-supplied submittedCredentialId',
        { ...VALID_BODY, submittedCredentialId: 'evil-cred' },
      ],
      [
        'a body-supplied customer field',
        { ...VALID_BODY, customerPhone: '+5491100000000' },
      ],
    ])(
      'rejects %s with the exact 3-key envelope and no value leak',
      async (_label, body) => {
        const res = await post(body).expect(400);
        const envelope = res.body as ErrorEnvelope;

        expect(envelope).toEqual({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
        });
        expect(Object.keys(envelope).sort()).toEqual(EXPECTED_ERROR_KEYS);
        const serialized = JSON.stringify(envelope);
        expect(serialized).not.toContain('evil-tenant');
        expect(serialized).not.toContain('evil-source');
        expect(serialized).not.toContain('evil-branch');
        expect(serialized).not.toContain('evil-cred');
        expect(serialized).not.toContain('+5491100000000');
        expect(envelope).not.toHaveProperty('error');
        expect(envelope).not.toHaveProperty('timestamp');
        expect(submit).not.toHaveBeenCalled();
      },
    );
  });

  describe('authentication and authorization', () => {
    it('returns 401 for an unknown credential and never touches the repository', async () => {
      credential = null;

      const res = await post().expect(401);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 401,
        code: 'UNAUTHORIZED',
        message: 'Unauthorized',
      });
      expect(submit).not.toHaveBeenCalled();
    });

    it('returns 401 for an inactive credential', async () => {
      credential = makeCredential({ isActive: false });

      await post().expect(401);
      expect(submit).not.toHaveBeenCalled();
    });

    it('returns 401 for a revoked credential', async () => {
      credential = makeCredential({
        revokedAt: new Date('2026-06-02T00:00:00.000Z'),
      });

      await post().expect(401);
      expect(submit).not.toHaveBeenCalled();
    });

    it('returns 401 when the bearer token is missing', async () => {
      const res = await http()
        .post(URL)
        .set('x-idempotency-key', VALID_BODY.sourceRequestId)
        .send(VALID_BODY as object)
        .expect(401);

      expect((res.body as ErrorEnvelope).code).toBe('UNAUTHORIZED');
      expect(submit).not.toHaveBeenCalled();
    });

    it('fails closed when the guard-populated credential is absent', async () => {
      const controller = app.get(BotRestockIntakeController);

      await expect(
        controller.create(
          VALID_BODY,
          VALID_BODY.sourceRequestId,
          { serviceCredential: undefined } as unknown as CreateArgs[2],
          { status: jest.fn() } as unknown as CreateArgs[3],
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(submit).not.toHaveBeenCalled();
    });

    // Node's HTTP parser trims optional whitespace around header values, so a
    // Supertest request cannot faithfully deliver a padded header. Invoke the
    // handler directly with an explicit padded string to prove the contract's
    // exact-equality requirement (no trimming is allowed).
    it('rejects a raw header padded with whitespace without calling the repository', async () => {
      const controller = app.get(BotRestockIntakeController);

      await expect(
        controller.create(
          VALID_BODY,
          `  ${VALID_BODY.sourceRequestId}\t`,
          {
            serviceCredential: { id: 'cred-hd-1' },
          } as unknown as CreateArgs[2],
          { status: jest.fn() } as unknown as CreateArgs[3],
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(submit).not.toHaveBeenCalled();
    });

    it('returns 403 when the credential lacks human-decisions:create', async () => {
      credential = makeCredential({ scopes: ['catalog:read'] });

      const res = await post().expect(403);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 403,
        code: 'FORBIDDEN',
        message: 'Forbidden',
      });
      expect(submit).not.toHaveBeenCalled();
    });

    it('returns 403 when the branch header is out of scope', async () => {
      const res = await http()
        .post(URL)
        .set('Authorization', `Bearer ${RAW_TOKEN}`)
        .set('x-idempotency-key', VALID_BODY.sourceRequestId)
        .set('x-branch-id', 'another-tenant')
        .send(VALID_BODY as object)
        .expect(403);

      expect((res.body as ErrorEnvelope).code).toBe('FORBIDDEN');
      expect(submit).not.toHaveBeenCalled();
    });
  });

  describe('repository failures are mapped by the scoped filter', () => {
    it('preserves Retry-After on a 429 RATE_LIMITED rate-limit rejection', async () => {
      credential = makeCredential({ rateLimit: 1 });
      submit.mockResolvedValue({ status: 'created', request: PENDING_ROW });

      await post().expect(201);
      const limited = await post().expect(429);
      const body = limited.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 429,
        code: 'RATE_LIMITED',
        message: 'Too many requests',
      });
      expect(limited.headers['retry-after']).toBeDefined();
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('maps IDEMPOTENCY_CONFLICT to a sanitized 409 and does not echo the message', async () => {
      submit.mockRejectedValue(
        new RestockIntakeError('IDEMPOTENCY_CONFLICT', 'hash mismatch for row'),
      );

      const res = await post().expect(409);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 409,
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'Request conflicts with a previous submission',
      });
      expect(JSON.stringify(body)).not.toContain('hash mismatch');
    });

    it('maps a foreign/missing predecessor NOT_FOUND to a sanitized 404', async () => {
      submit.mockRejectedValue(
        new RestockIntakeError('NOT_FOUND', 'predecessor of tenant x missing'),
      );

      const res = await post().expect(404);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 404,
        code: 'NOT_FOUND',
        message: 'Not found',
      });
      expect(JSON.stringify(body)).not.toContain('predecessor');
    });

    it('sanitizes an unexpected error to a 500 rather than a false replay', async () => {
      submit.mockRejectedValue(new Error('pg password leaked: hunter2'));

      const res = await post().expect(500);
      const body = res.body as Record<string, unknown>;

      expect(body).toEqual({
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      });
      expect(body).not.toHaveProperty('timestamp');
      expect(body).not.toHaveProperty('error');
      expect(JSON.stringify(body)).not.toContain('hunter2');
    });

    it('keeps a nested ambient-transaction Error as a 500, never a replay', async () => {
      submit.mockRejectedValue(
        new Error(
          'PrismaRestockIntakeRepository.submit must be called outside an ambient transaction',
        ),
      );

      const res = await post().expect(500);
      const body = res.body as Record<string, unknown>;

      expect(body.code).toBe('INTERNAL_ERROR');
      expect(body.statusCode).toBe(500);
      expect(JSON.stringify(body)).not.toContain('ambient transaction');
      expect(body).not.toHaveProperty('status');
      expect(body).not.toHaveProperty('version');
    });
  });

  describe('EXPIRATION intake on the shared route (HD-EXP-03)', () => {
    const expPost = (
      body: unknown = EXP_SIMPLE_BODY,
      key: string | null = EXP_SIMPLE_BODY.sourceRequestId,
      token = RAW_TOKEN,
    ) => {
      const builder = http().post(URL).set('Authorization', `Bearer ${token}`);
      if (key !== null) {
        builder.set('x-idempotency-key', key);
      }
      return builder.send(body as object);
    };

    it('creates with 201, delegates only the four wire keys plus the audit credential and never touches the RESTOCK port', async () => {
      expirationSubmit.mockResolvedValue({
        status: 'created',
        request: EXP_PENDING_ROW,
      });

      const res = await expPost().expect(201);

      expect(res.body).toEqual(EXP_EXPECTED_RECEIPT);
      expect(Object.keys(res.body as object).sort()).toEqual(EXP_RECEIPT_KEYS);
      expect(
        Object.keys((res.body as { snapshot: object }).snapshot).sort(),
      ).toEqual(EXP_SNAPSHOT_KEYS);

      expect(expirationSubmit).toHaveBeenCalledTimes(1);
      const delegated = expirationSubmit.mock.calls[0][0];
      expect(delegated).toEqual({
        sourceRequestId: EXP_SIMPLE_BODY.sourceRequestId,
        type: EXPIRATION_TYPE,
        productId: EXP_SIMPLE_BODY.productId,
        variantId: null,
        submittedCredentialId: 'cred-hd-1',
      });
      expect(Object.keys(delegated).sort()).toEqual(
        EXPECTED_EXP_DELEGATED_KEYS,
      );
      expect(delegated).not.toHaveProperty('tenantId');
      expect(delegated).not.toHaveProperty('source');
      expect(delegated).not.toHaveProperty('branchId');
      expect(delegated).not.toHaveProperty('originalSourceRequestId');
      expect(submit).not.toHaveBeenCalled();
    });

    it('projects a variant product with unit and variant metadata', async () => {
      expirationSubmit.mockResolvedValue({
        status: 'created',
        request: EXP_VARIANT_ROW,
      });

      const res = await expPost(EXP_VARIANT_BODY).expect(201);
      const body = res.body as { snapshot: Record<string, unknown> };

      expect(body.snapshot).toEqual({
        branchId: 'tenant-1',
        branchName: 'Sucursal Centro',
        productId: EXP_VARIANT_BODY.productId,
        productName: 'Filtro de aceite',
        unit: 'UNIT',
        variantId: EXP_VARIANT_BODY.variantId,
        variantName: 'Verde',
        variantOption: 'Color',
        variantValue: 'Verde',
      });
      expect(Object.keys(body.snapshot).sort()).toEqual(EXP_SNAPSHOT_KEYS);
      expect(expirationSubmit.mock.calls[0][0].variantId).toBe(
        EXP_VARIANT_BODY.variantId,
      );
    });

    it('replays a RESOLVED/version-2 row as an identical historical PENDING/version-1 receipt with HTTP 200', async () => {
      expirationSubmit.mockResolvedValueOnce({
        status: 'created',
        request: EXP_PENDING_ROW,
      });
      const created = await expPost().expect(201);

      expirationSubmit.mockResolvedValueOnce({
        status: 'replayed',
        request: EXP_RESOLVED_ROW,
      });
      const replayed = await expPost().expect(200);

      expect(replayed.body).toEqual(created.body);
      expect(replayed.body).toEqual(EXP_EXPECTED_RECEIPT);
    });

    it('never leaks hash, source, tenant, credential or audit fields in the receipt', async () => {
      expirationSubmit.mockResolvedValue({
        status: 'created',
        request: EXP_PENDING_ROW,
      });

      const res = await expPost().expect(201);
      const serialized = JSON.stringify(res.body);

      expect(serialized).not.toContain('exp-hash-v1');
      expect(serialized).not.toContain('cred-hd-1');
      expect(serialized).not.toContain('houndfe-chatbot');
      expect(res.body).not.toHaveProperty('canonicalRequestHash');
      expect(res.body).not.toHaveProperty('submittedCredentialId');
      expect(res.body).not.toHaveProperty('source');
      expect(res.body).not.toHaveProperty('tenantId');
      expect(res.body).not.toHaveProperty('sku');
    });

    it('canonicalizes the delegated identity while matching the RAW header literally', async () => {
      const rawUpper = '3F1C1B7A-9C2E-4D5F-8A6B-1C2D3E4F5A6B';
      const upperBody = {
        sourceRequestId: rawUpper,
        type: EXPIRATION_TYPE,
        productId: '8F14E45F-CEEA-4E42-9F62-1A2B3C4D5E6F',
        variantId: '550E8400-E29B-41D4-A716-446655440000',
      };
      expirationSubmit.mockResolvedValue({
        status: 'created',
        request: EXP_PENDING_ROW,
      });

      await expPost(upperBody, rawUpper).expect(201);

      expect(expirationSubmit.mock.calls[0][0]).toEqual({
        sourceRequestId: rawUpper.toLowerCase(),
        type: EXPIRATION_TYPE,
        productId: '8f14e45f-ceea-4e42-9f62-1a2b3c4d5e6f',
        variantId: '550e8400-e29b-41d4-a716-446655440000',
        submittedCredentialId: 'cred-hd-1',
      });
    });

    it.each([
      [
        'a lowercase header that only matches after canonicalization',
        '3f1c1b7a-9c2e-4d5f-8a6b-1c2d3e4f5a6b',
        '3F1C1B7A-9C2E-4D5F-8A6B-1C2D3E4F5A6B',
      ],
      [
        'a header that differs from sourceRequestId',
        '99999999-9999-4999-8999-999999999999',
        undefined,
      ],
      ['a non-UUID header', 'not-a-uuid', undefined],
      ['a missing header', null, undefined],
    ])(
      'rejects %s with a sanitized 400 VALIDATION_ERROR before the repository',
      async (_label, key, bodySourceRequestId) => {
        const body = bodySourceRequestId
          ? { ...EXP_SIMPLE_BODY, sourceRequestId: bodySourceRequestId }
          : EXP_SIMPLE_BODY;

        const res = await expPost(body, key).expect(400);

        expect(res.body).toEqual({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
        });
        expect(Object.keys(res.body as object).sort()).toEqual(
          EXPECTED_ERROR_KEYS,
        );
        expect(expirationSubmit).not.toHaveBeenCalled();
      },
    );

    it.each([
      [
        'a missing required key',
        { ...EXP_SIMPLE_BODY, productId: undefined },
        'productId',
      ],
      [
        'a missing variantId key',
        { ...EXP_SIMPLE_BODY, variantId: undefined },
        'variantId',
      ],
      [
        'a non-UUID variantId',
        { ...EXP_SIMPLE_BODY, variantId: 'not-a-uuid' },
        'not-a-uuid',
      ],
      [
        'an extra metadata key',
        { ...EXP_SIMPLE_BODY, metadata: 'SECRET' },
        'SECRET',
      ],
      [
        'a body-supplied tenantId',
        { ...EXP_SIMPLE_BODY, tenantId: 'evil-tenant' },
        'evil-tenant',
      ],
      [
        'a non-UUID productId',
        { ...EXP_SIMPLE_BODY, productId: 'not-a-uuid' },
        'not-a-uuid',
      ],
      [
        'a non-EXPIRATION discriminant',
        { ...EXP_SIMPLE_BODY, type: 'expiration' },
        'expiration',
      ],
    ])(
      'rejects %s with the exact 3-key envelope and no value leak',
      async (_label, body, sentinel) => {
        const res = await expPost(body as object).expect(400);

        expect(res.body).toEqual({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
        });
        expect(Object.keys(res.body as object).sort()).toEqual(
          EXPECTED_ERROR_KEYS,
        );
        if (typeof sentinel === 'string') {
          expect(JSON.stringify(res.body)).not.toContain(sentinel);
        }
        expect(expirationSubmit).not.toHaveBeenCalled();
        expect(submit).not.toHaveBeenCalled();
      },
    );

    it('returns 401 for an unknown credential and never touches the repository', async () => {
      credential = null;

      const res = await expPost().expect(401);

      expect(res.body).toEqual({
        statusCode: 401,
        code: 'UNAUTHORIZED',
        message: 'Unauthorized',
      });
      expect(expirationSubmit).not.toHaveBeenCalled();
    });

    it('returns 401 when the bearer token is missing', async () => {
      const res = await http()
        .post(URL)
        .set('x-idempotency-key', EXP_SIMPLE_BODY.sourceRequestId)
        .send(EXP_SIMPLE_BODY as object)
        .expect(401);

      expect((res.body as ErrorEnvelope).code).toBe('UNAUTHORIZED');
      expect(expirationSubmit).not.toHaveBeenCalled();
    });

    it.each([
      ['VALIDATION_ERROR', 400],
      ['NOT_FOUND', 404],
      ['IDEMPOTENCY_CONFLICT', 409],
    ] as const)(
      'maps ExpirationIntakeError %s to a sanitized %i without echoing the message',
      async (code, status) => {
        expirationSubmit.mockRejectedValue(
          new ExpirationIntakeError(code, `raw ${code} detail`),
        );

        const res = await expPost().expect(status);

        expect(res.body).toEqual({
          statusCode: status,
          code,
          message: expect.any(String) as unknown as string,
        });
        expect(Object.keys(res.body as object).sort()).toEqual(
          EXPECTED_ERROR_KEYS,
        );
        expect(JSON.stringify(res.body)).not.toContain('raw');
      },
    );

    it('sanitizes an unexpected repository error to a 500 rather than a false replay', async () => {
      expirationSubmit.mockRejectedValue(
        new Error('PrismaExpirationIntakeRepository leaked: hunter3'),
      );

      const res = await expPost().expect(500);

      expect(res.body).toEqual({
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      });
      expect(JSON.stringify(res.body)).not.toContain('hunter3');
    });
  });
});
