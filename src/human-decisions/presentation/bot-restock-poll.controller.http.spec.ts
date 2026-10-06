/**
 * HD-05c — HTTP contract for `GET /chatbot-api/human-decisions/:id` (bot poll).
 *
 * In-memory Nest app + Supertest (`app.init()`, NO listen port, NO DB): the
 * REAL `ServiceAuthGuard`, a REAL nestjs-cls ALS store
 * (`ClsModule.forRoot({ middleware: { mount: true } })`), a mocked
 * `ServiceCredential` repository and a mocked `IBotRestockPollRepository`.
 * The REAL global `ValidationPipe` and the REAL global
 * `DomainExceptionFilter`/`PrismaExceptionFilter` are configured exactly like
 * `main.ts`, so the controller-scoped `HumanDecisionHttpFilter` precedence is
 * exercised rather than assumed.
 *
 * The tenant is NOT supplied by the caller: it is pinned by the guard into the
 * real ALS store, and the mocked poll port captures `cls.get('tenantId')` at
 * call time to prove the trusted tenant flows through CLS. No database,
 * provider or network is touched.
 *
 * The existing bot `POST` intake controller is registered in the SAME
 * in-memory graph (with a mocked intake port) to prove both routes coexist on
 * the shared `chatbot-api/human-decisions` prefix without one shadowing the
 * other. `HumanDecisionsModule` is asserted through metadata only and never
 * fully booted.
 */
import {
  INestApplication,
  RequestMethod,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import {
  EXCEPTION_FILTERS_METADATA,
  GUARDS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { ChatbotApiModule } from '../../chatbot-api/chatbot-api.module';
import { ServiceCredential } from '../../chatbot-api/domain/service-credential.entity';
import { SERVICE_CREDENTIAL_REPOSITORY } from '../../chatbot-api/domain/service-credential.repository';
import { REQUIRED_SCOPES_KEY } from '../../chatbot-api/presentation/decorators/required-scopes.decorator';
import { ServiceAuthGuard } from '../../chatbot-api/presentation/guards/service-auth.guard';
import { DomainExceptionFilter } from '../../shared/filters/domain-exception.filter';
import { PrismaExceptionFilter } from '../../shared/filters/prisma-exception.filter';
import { createListingValidationExceptionFactory } from '../../shared/listing/listing-validation-exception.factory';
import { DatabaseModule } from '../../shared/prisma/prisma.module';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import {
  BOT_RESTOCK_POLL_REPOSITORY,
  type BotRestockPollRecord,
  type IBotRestockPollRepository,
} from '../domain/bot-restock-poll.repository';
import {
  HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE,
  HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE,
} from '../domain/human-decision-review-resolve.repository';
import {
  RESTOCK_INTAKE_REPOSITORY,
  type PersistedRestockDecision,
  type RestockIntakeInput,
  type RestockIntakeResult,
} from '../domain/restock-intake.repository';
import { EXPIRATION_TYPE } from '../domain/expiration-intake.request';
import { EXPIRATION_INTAKE_REPOSITORY } from '../domain/expiration-intake.repository';
import { HumanDecisionsModule } from '../human-decisions.module';
import { PrismaBotRestockPollRepository } from '../infrastructure/prisma-bot-restock-poll.repository';
import { PrismaRestockIntakeRepository } from '../infrastructure/prisma-restock-intake.repository';
import { BotRestockIntakeController } from './bot-restock-intake.controller';
import { BotRestockPollController } from './bot-restock-poll.controller';
import { HumanDecisionHttpFilter } from './filters/human-decision-http.filter';

const URL = '/chatbot-api/human-decisions';
const RAW_TOKEN = 'svc_hd_poll_token';
const HASHED_TOKEN = createHash('sha256').update(RAW_TOKEN).digest('hex');

const DECISION_ID = '2b7c1a90-6f3e-4d2a-8b1c-0d9e8f7a6b5c';
const FOREIGN_ID = '99999999-9999-4999-8999-999999999999';
const SOURCE_REQUEST_ID = '3f1c1b7a-9c2e-4d5f-8a6b-1c2d3e4f5a6b';
const PRODUCT_ID = '8f14e45f-ceea-4e42-9f62-1a2b3c4d5e6f';
const CREATED_AT_ISO = '2026-06-01T10:00:05.000Z';
const OBSERVED_AT_ISO = '2026-06-01T10:00:00.000Z';
const RESOLVED_AT_ISO = '2026-06-01T12:00:00.000Z';
const APPLY_BEFORE_ISO = '2026-06-01T13:00:00.000Z';
const RESTOCK_DAYS = 5;

const EXPECTED_TOP_LEVEL_KEYS = [
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

const EXPECTED_SNAPSHOT_KEYS = [
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

const EXPECTED_ERROR_KEYS = ['code', 'message', 'statusCode'];

/** Keys that must NEVER appear on a bot poll projection. */
const FORBIDDEN_KEYS = [
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
  'ackReceivedAt',
  'providerEvidence',
  'customerPhone',
  'pii',
];

interface ErrorEnvelope {
  statusCode: number;
  code: string;
  message: string;
}

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

type FindOneArgs = Parameters<BotRestockPollController['findOne']>;

function makeCredential(
  overrides: CredentialOverrides = {},
): ServiceCredential {
  return ServiceCredential.fromPersistence({
    id: 'cred-hd-poll-1',
    tenantId: 'tenant-1',
    name: 'Human Decisions Poll Bot',
    hashedKey: HASHED_TOKEN,
    scopes: ['human-decisions:read'],
    isActive: true,
    lastUsedAt: null,
    rateLimit: 60,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    revokedAt: null,
    ...overrides,
  });
}

const PENDING_RECORD: BotRestockPollRecord = {
  id: DECISION_ID,
  sourceRequestId: SOURCE_REQUEST_ID,
  type: 'RESTOCK',
  status: 'PENDING',
  version: 1,
  createdAt: new Date(CREATED_AT_ISO),
  snapshot: {
    branchId: 'branch-1',
    branchName: 'Sucursal Centro',
    productId: PRODUCT_ID,
    productName: 'Filtro de aceite',
    variantId: null,
    sku: 'SKU-1',
    requestedQuantity: 3,
    observedStockAtRequest: 5,
    stockObservedAt: new Date(OBSERVED_AT_ISO),
  },
  supersedesDecisionId: null,
  resolutionAction: null,
  restockDays: null,
  resolvedAt: null,
};

const RESOLVED_POSITIVE_RECORD: BotRestockPollRecord = {
  ...PENDING_RECORD,
  status: 'RESOLVED',
  version: 2,
  resolutionAction: HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE,
  restockDays: RESTOCK_DAYS,
  resolvedAt: new Date(RESOLVED_AT_ISO),
};

const RESOLVED_NEGATIVE_RECORD: BotRestockPollRecord = {
  ...PENDING_RECORD,
  status: 'RESOLVED',
  version: 2,
  resolutionAction: HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE,
  restockDays: null,
  resolvedAt: new Date(RESOLVED_AT_ISO),
};

const EXPECTED_SNAPSHOT = {
  branchId: 'branch-1',
  branchName: 'Sucursal Centro',
  productId: PRODUCT_ID,
  productName: 'Filtro de aceite',
  variantId: null,
  sku: 'SKU-1',
  requestedQuantity: 3,
  observedStockAtRequest: 5,
  stockObservedAt: OBSERVED_AT_ISO,
};

const EXPECTED_PENDING = {
  id: DECISION_ID,
  sourceRequestId: SOURCE_REQUEST_ID,
  type: 'RESTOCK',
  status: 'PENDING',
  version: 1,
  createdAt: CREATED_AT_ISO,
  snapshot: EXPECTED_SNAPSHOT,
  supersedesDecisionId: null,
  resolution: null,
  applyBefore: null,
};

const EXPECTED_RESOLVED_POSITIVE = {
  ...EXPECTED_PENDING,
  status: 'RESOLVED',
  version: 2,
  resolution: {
    action: HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE,
    restockDays: RESTOCK_DAYS,
    resolvedAt: RESOLVED_AT_ISO,
  },
  applyBefore: APPLY_BEFORE_ISO,
};

const EXPECTED_RESOLVED_NEGATIVE = {
  ...EXPECTED_PENDING,
  status: 'RESOLVED',
  version: 2,
  resolution: {
    action: HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE,
    resolvedAt: RESOLVED_AT_ISO,
  },
  applyBefore: APPLY_BEFORE_ISO,
};

// --- EXPIRATION dispatch fixtures (built from the shared RESTOCK base). ---
const EXPIRATION_POSITIVE_ACTION = 'PROVIDE_EXPIRATION_TEXT';
const EXPIRATION_NEGATIVE_ACTION = 'REPORT_EXPIRATION_UNAVAILABLE';
const EXPIRATION_UNIT = 'UNIDAD';
const EXPIRATION_TEXT = 'Vence el 2026-05';
const VARIANT_ID = '550e8400-e29b-41d4-a716-446655440000';
// EXPIRATION shares `resolvedAt` but the owner-approved deadline is 24h.
const EXPIRATION_APPLY_BEFORE_ISO = '2026-06-02T12:00:00.000Z';

const EXPIRATION_SNAPSHOT_OVERRIDES = {
  sku: null,
  requestedQuantity: null,
  observedStockAtRequest: null,
  stockObservedAt: null,
  productUnit: EXPIRATION_UNIT,
  variantName: null,
  variantOption: null,
  variantValue: null,
};

const EXPIRATION_PENDING_RECORD: BotRestockPollRecord = {
  ...PENDING_RECORD,
  type: EXPIRATION_TYPE,
  snapshot: { ...PENDING_RECORD.snapshot, ...EXPIRATION_SNAPSHOT_OVERRIDES },
};

const EXPIRATION_VARIANT_RECORD: BotRestockPollRecord = {
  ...EXPIRATION_PENDING_RECORD,
  snapshot: {
    ...EXPIRATION_PENDING_RECORD.snapshot,
    variantId: VARIANT_ID,
    variantName: 'Presentación A',
    variantOption: 'Peso',
    variantValue: '1 kg',
  },
};

const EXPIRATION_RESOLVED_TEXT_RECORD: BotRestockPollRecord = {
  ...EXPIRATION_PENDING_RECORD,
  status: 'RESOLVED',
  version: 2,
  resolutionAction: EXPIRATION_POSITIVE_ACTION,
  expirationText: EXPIRATION_TEXT,
  resolvedAt: new Date(RESOLVED_AT_ISO),
};

const EXPIRATION_RESOLVED_UNAVAILABLE_RECORD: BotRestockPollRecord = {
  ...EXPIRATION_RESOLVED_TEXT_RECORD,
  resolutionAction: EXPIRATION_NEGATIVE_ACTION,
  expirationText: null,
};

const EXPECTED_EXPIRATION_SNAPSHOT_KEYS = [
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

const EXPECTED_EXPIRATION_PENDING = {
  id: DECISION_ID,
  sourceRequestId: SOURCE_REQUEST_ID,
  type: 'EXPIRATION',
  status: 'PENDING',
  version: 1,
  createdAt: CREATED_AT_ISO,
  snapshot: {
    branchId: 'branch-1',
    branchName: 'Sucursal Centro',
    productId: PRODUCT_ID,
    productName: 'Filtro de aceite',
    unit: EXPIRATION_UNIT,
    variantId: null,
    variantName: null,
    variantOption: null,
    variantValue: null,
  },
  supersedesDecisionId: null,
  resolution: null,
  applyBefore: null,
};

const EXPIRATION_RESOLVED_CASES: Array<
  [string, BotRestockPollRecord, Record<string, unknown>]
> = [
  [
    EXPIRATION_POSITIVE_ACTION,
    EXPIRATION_RESOLVED_TEXT_RECORD,
    {
      action: EXPIRATION_POSITIVE_ACTION,
      expirationText: EXPIRATION_TEXT,
      resolvedAt: RESOLVED_AT_ISO,
    },
  ],
  [
    EXPIRATION_NEGATIVE_ACTION,
    EXPIRATION_RESOLVED_UNAVAILABLE_RECORD,
    { action: EXPIRATION_NEGATIVE_ACTION, resolvedAt: RESOLVED_AT_ISO },
  ],
];

const INTAKE_VALID_BODY = {
  sourceRequestId: SOURCE_REQUEST_ID,
  type: 'RESTOCK',
  productId: PRODUCT_ID,
  productName: 'Filtro de aceite',
  variantId: null,
  sku: 'SKU-1',
  requestedQuantity: 3,
  observedStockAtRequest: 5,
  stockObservedAt: OBSERVED_AT_ISO,
  supersedesDecisionId: null,
} as const;

const INTAKE_PERSISTED_ROW: PersistedRestockDecision = {
  id: DECISION_ID,
  source: 'houndfe-chatbot',
  sourceRequestId: SOURCE_REQUEST_ID,
  type: 'RESTOCK',
  canonicalRequestHash: 'hash-v1',
  status: 'PENDING',
  version: 1,
  supersedesDecisionId: null,
  createdAt: new Date(CREATED_AT_ISO),
  snapshot: {
    branchId: 'branch-1',
    branchName: 'Sucursal Centro',
    productId: PRODUCT_ID,
    productName: 'Filtro de aceite',
    variantId: null,
    sku: 'SKU-1',
    requestedQuantity: 3,
    observedStockAtRequest: 5,
    stockObservedAt: new Date(OBSERVED_AT_ISO),
  },
};

describe('Bot restock poll HTTP contract (HD-05c)', () => {
  let app: INestApplication;
  let findById: jest.Mock<Promise<BotRestockPollRecord | null>, [string]>;
  let submit: jest.Mock<Promise<RestockIntakeResult>, [RestockIntakeInput]>;
  let findByHashedKey: jest.Mock<Promise<ServiceCredential | null>, [string]>;
  let touchLastUsedAt: jest.Mock<Promise<void>, [string, (Date | undefined)?]>;
  let credential: ServiceCredential | null;
  let tenantSeenByPort: string | null | undefined;

  const http = () => request(app.getHttpServer() as import('node:http').Server);

  const get = (id: string = DECISION_ID, token: string | null = RAW_TOKEN) => {
    const builder = http().get(`${URL}/${id}`);
    return token ? builder.set('Authorization', `Bearer ${token}`) : builder;
  };

  beforeEach(async () => {
    credential = makeCredential();
    tenantSeenByPort = undefined;
    findById = jest.fn<Promise<BotRestockPollRecord | null>, [string]>(() =>
      Promise.resolve(null),
    );
    submit = jest.fn<Promise<RestockIntakeResult>, [RestockIntakeInput]>();
    findByHashedKey = jest.fn<Promise<ServiceCredential | null>, [string]>(() =>
      Promise.resolve(credential),
    );
    touchLastUsedAt = jest.fn<Promise<void>, [string, (Date | undefined)?]>(
      () => Promise.resolve(),
    );

    const moduleRef = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
      ],
      controllers: [BotRestockPollController, BotRestockIntakeController],
      providers: [
        HumanDecisionHttpFilter,
        ServiceAuthGuard,
        {
          provide: SERVICE_CREDENTIAL_REPOSITORY,
          useValue: { findByHashedKey, touchLastUsedAt },
        },
        {
          // Capture the real ALS tenant the guard pinned, then delegate to the
          // mock. The route itself never touches CLS: the tenant predicate
          // belongs to the (mocked here) tenant-scoped adapter.
          provide: BOT_RESTOCK_POLL_REPOSITORY,
          inject: [ClsService],
          useFactory: (
            clsService: ClsService<TenantClsStore>,
          ): IBotRestockPollRepository => ({
            findById: (id: string): Promise<BotRestockPollRecord | null> => {
              tenantSeenByPort = clsService.get('tenantId');
              return findById(id);
            },
          }),
        },
        {
          provide: RESTOCK_INTAKE_REPOSITORY,
          useValue: { submit },
        },
        {
          provide: EXPIRATION_INTAKE_REPOSITORY,
          useValue: {
            submit: jest
              .fn()
              .mockRejectedValue(new Error('Unexpected expiration intake')),
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
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
    await app.close();
  });

  describe('route metadata and module wiring', () => {
    it('pins the poll handler to GET :id, human-decisions:read, the service guard and the scoped filter', () => {
      const pollHandler = Object.getOwnPropertyDescriptor(
        BotRestockPollController.prototype,
        'findOne',
      )?.value as () => void;

      expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, pollHandler)).toEqual([
        'human-decisions:read',
      ]);
      expect(Reflect.getMetadata(METHOD_METADATA, pollHandler)).toBe(
        RequestMethod.GET,
      );
      expect(Reflect.getMetadata(PATH_METADATA, pollHandler)).toBe(':id');
      expect(Reflect.getMetadata(PATH_METADATA, BotRestockPollController)).toBe(
        'chatbot-api/human-decisions',
      );

      const guards = (Reflect.getMetadata(
        GUARDS_METADATA,
        BotRestockPollController,
      ) ?? []) as unknown[];
      const filters = (Reflect.getMetadata(
        EXCEPTION_FILTERS_METADATA,
        BotRestockPollController,
      ) ?? []) as unknown[];

      expect(guards).toContain(ServiceAuthGuard);
      expect(filters).toContain(HumanDecisionHttpFilter);
    });

    it('registers the poll controller, binds the poll port and leaves the bot POST intake untouched', () => {
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

      expect(controllers).toContain(BotRestockPollController);
      expect(controllers).toContain(BotRestockIntakeController);
      expect(imports).toContain(ChatbotApiModule);
      expect(imports).toContain(DatabaseModule);

      const pollBinding = providers.find(
        (provider) => provider?.provide === BOT_RESTOCK_POLL_REPOSITORY,
      );
      expect(pollBinding?.useClass).toBe(PrismaBotRestockPollRepository);

      const intakeBinding = providers.find(
        (provider) => provider?.provide === RESTOCK_INTAKE_REPOSITORY,
      );
      expect(intakeBinding?.useClass).toBe(PrismaRestockIntakeRepository);

      // The existing bot POST intake contract is byte-for-byte unchanged.
      const intakeHandler = Object.getOwnPropertyDescriptor(
        BotRestockIntakeController.prototype,
        'create',
      )?.value as () => void;
      expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, intakeHandler)).toEqual([
        'human-decisions:create',
      ]);
      expect(Reflect.getMetadata(METHOD_METADATA, intakeHandler)).toBe(
        RequestMethod.POST,
      );
      expect(Reflect.getMetadata(PATH_METADATA, intakeHandler)).toBe('/');
    });
  });

  describe('success path (exact current-state projection)', () => {
    it('returns the exact PENDING body with the current version and a no-store cache header', async () => {
      findById.mockResolvedValue(PENDING_RECORD);

      const res = await get().expect(200);
      const body = res.body as Record<string, unknown>;

      expect(body).toEqual(EXPECTED_PENDING);
      expect(Object.keys(body).sort()).toEqual(EXPECTED_TOP_LEVEL_KEYS);
      expect(Object.keys(body.snapshot as object).sort()).toEqual(
        EXPECTED_SNAPSHOT_KEYS,
      );
      expect(body.resolution).toBeNull();
      expect(body.applyBefore).toBeNull();
      expect(res.headers['cache-control']).toBe('no-store');

      expect(findById).toHaveBeenCalledTimes(1);
      expect(findById).toHaveBeenCalledWith(DECISION_ID);
    });

    it('returns the exact RESOLVED positive body with applyBefore = resolvedAt + 1h (UTC ISO)', async () => {
      findById.mockResolvedValue(RESOLVED_POSITIVE_RECORD);

      const res = await get().expect(200);
      const body = res.body as Record<string, unknown>;

      expect(body).toEqual(EXPECTED_RESOLVED_POSITIVE);
      expect(Object.keys(body).sort()).toEqual(EXPECTED_TOP_LEVEL_KEYS);
      expect(body.applyBefore).toBe(APPLY_BEFORE_ISO);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('returns the exact RESOLVED negative body and OMITS restockDays entirely', async () => {
      findById.mockResolvedValue(RESOLVED_NEGATIVE_RECORD);

      const res = await get().expect(200);
      const body = res.body as Record<string, unknown>;
      const resolution = body.resolution as Record<string, unknown>;

      expect(body).toEqual(EXPECTED_RESOLVED_NEGATIVE);
      expect(resolution).not.toHaveProperty('restockDays');
      expect(Object.keys(resolution).sort()).toEqual(['action', 'resolvedAt']);
    });

    it('never leaks reviewer, authority, provider or PII fields', async () => {
      findById.mockResolvedValue(RESOLVED_POSITIVE_RECORD);

      const res = await get().expect(200);
      const body = res.body as Record<string, unknown>;
      const snapshot = body.snapshot as Record<string, unknown>;
      const resolution = body.resolution as Record<string, unknown>;

      for (const key of FORBIDDEN_KEYS) {
        expect(body).not.toHaveProperty(key);
        expect(snapshot).not.toHaveProperty(key);
        expect(resolution).not.toHaveProperty(key);
      }

      // The response is the CURRENT state, never the immutable POST receipt.
      expect(body).not.toHaveProperty('canonicalRequestHash');
      expect(body).not.toHaveProperty('submittedCredentialId');
      expect(body).not.toHaveProperty('applicationOutcome');
    });
  });

  describe('EXPIRATION dispatch (mock port; production adapter still RESTOCK-only)', () => {
    it('returns the exact EXPIRATION PENDING body with unit and variant keys', async () => {
      findById.mockResolvedValue(EXPIRATION_PENDING_RECORD);

      const res = await get().expect(200);
      const body = res.body as Record<string, unknown>;

      expect(body).toEqual(EXPECTED_EXPIRATION_PENDING);
      expect(Object.keys(body).sort()).toEqual(EXPECTED_TOP_LEVEL_KEYS);
      expect(Object.keys(body.snapshot as object).sort()).toEqual(
        EXPECTED_EXPIRATION_SNAPSHOT_KEYS,
      );
      expect(res.headers['cache-control']).toBe('no-store');
      expect(findById).toHaveBeenCalledWith(DECISION_ID);
    });

    it('projects the variant identity when variantId is set', async () => {
      findById.mockResolvedValue(EXPIRATION_VARIANT_RECORD);

      const res = await get().expect(200);
      const snapshot = (res.body as Record<string, unknown>).snapshot as Record<
        string,
        unknown
      >;

      expect(snapshot.variantId).toBe(VARIANT_ID);
      expect(snapshot.variantName).toBe('Presentación A');
      expect(snapshot.variantOption).toBe('Peso');
      expect(snapshot.variantValue).toBe('1 kg');
      expect(Object.keys(snapshot).sort()).toEqual(
        EXPECTED_EXPIRATION_SNAPSHOT_KEYS,
      );
    });

    it.each(EXPIRATION_RESOLVED_CASES)(
      'returns the exact RESOLVED %s body with the 24h applyBefore',
      async (_action, record, expectedResolution) => {
        findById.mockResolvedValue(record);

        const res = await get().expect(200);
        const body = res.body as Record<string, unknown>;

        expect(body.status).toBe('RESOLVED');
        expect(body.version).toBe(2);
        expect(body.type).toBe('EXPIRATION');
        expect(body.resolution).toEqual(expectedResolution);
        expect(body.applyBefore).toBe(EXPIRATION_APPLY_BEFORE_ISO);
        expect(res.headers['cache-control']).toBe('no-store');
      },
    );

    it('omits expirationText entirely for the unavailable action', async () => {
      findById.mockResolvedValue(EXPIRATION_RESOLVED_UNAVAILABLE_RECORD);

      const res = await get().expect(200);
      const resolution = (res.body as Record<string, unknown>)
        .resolution as Record<string, unknown>;

      expect(resolution).not.toHaveProperty('expirationText');
      expect(Object.keys(resolution).sort()).toEqual(['action', 'resolvedAt']);
    });

    it('never leaks reviewer, authority, provider or PII fields for EXPIRATION', async () => {
      findById.mockResolvedValue(EXPIRATION_RESOLVED_TEXT_RECORD);

      const res = await get().expect(200);
      const body = res.body as Record<string, unknown>;
      const snapshot = body.snapshot as Record<string, unknown>;
      const resolution = body.resolution as Record<string, unknown>;

      for (const key of FORBIDDEN_KEYS) {
        expect(body).not.toHaveProperty(key);
        expect(snapshot).not.toHaveProperty(key);
        expect(resolution).not.toHaveProperty(key);
      }
      // EXPIRATION carries no RESTOCK-only snapshot/resolution field either.
      expect(snapshot).not.toHaveProperty('sku');
      expect(resolution).not.toHaveProperty('restockDays');
    });

    it('fails closed with a sanitized 500 for an unsupported persisted type', async () => {
      findById.mockResolvedValue({ ...PENDING_RECORD, type: 'SHIPPING' });

      const res = await get().expect(500);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      });
      expect(JSON.stringify(body)).not.toContain('SHIPPING');
    });
  });

  describe('tenant scope comes from CLS, never from the caller', () => {
    it('pins the credential tenant into the real ALS store the adapter would read', async () => {
      findById.mockResolvedValue(PENDING_RECORD);

      await get().expect(200);

      expect(tenantSeenByPort).toBe('tenant-1');
    });

    it('ignores caller-supplied tenant/source query params and forwards only the path id', async () => {
      findById.mockResolvedValue(PENDING_RECORD);

      const res = await http()
        .get(`${URL}/${DECISION_ID}?tenantId=evil-tenant&source=evil-source`)
        .set('Authorization', `Bearer ${RAW_TOKEN}`)
        .expect(200);

      expect(res.body).toEqual(EXPECTED_PENDING);
      expect(tenantSeenByPort).toBe('tenant-1');
      expect(findById).toHaveBeenCalledTimes(1);
      expect(findById).toHaveBeenCalledWith(DECISION_ID);
    });
  });

  describe('authentication and authorization', () => {
    it('returns 401 for an unknown credential and never touches the port', async () => {
      credential = null;

      const res = await get().expect(401);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 401,
        code: 'UNAUTHORIZED',
        message: 'Unauthorized',
      });
      expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
      expect(findById).not.toHaveBeenCalled();
    });

    it.each([
      ['an inactive credential', () => makeCredential({ isActive: false })],
      [
        'a revoked credential',
        () =>
          makeCredential({ revokedAt: new Date('2026-06-02T00:00:00.000Z') }),
      ],
    ])('returns 401 for %s', async (_label, factory) => {
      credential = factory();

      await get().expect(401);
      expect(findById).not.toHaveBeenCalled();
    });

    it('returns 401 when the bearer token is missing', async () => {
      const res = await get(DECISION_ID, null).expect(401);

      expect((res.body as ErrorEnvelope).code).toBe('UNAUTHORIZED');
      expect(findById).not.toHaveBeenCalled();
    });

    it('fails closed when the guard-populated credential is absent', async () => {
      const controller = app.get(BotRestockPollController);

      await expect(
        controller.findOne(
          DECISION_ID,
          { serviceCredential: undefined } as unknown as FindOneArgs[1],
          { setHeader: jest.fn() } as unknown as FindOneArgs[2],
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(findById).not.toHaveBeenCalled();
    });

    it('returns 403 when a create-only credential lacks human-decisions:read', async () => {
      credential = makeCredential({ scopes: ['human-decisions:create'] });

      const res = await get().expect(403);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 403,
        code: 'FORBIDDEN',
        message: 'Forbidden',
      });
      expect(findById).not.toHaveBeenCalled();
    });

    it('returns 403 when the branch header is out of scope', async () => {
      const res = await http()
        .get(`${URL}/${DECISION_ID}`)
        .set('Authorization', `Bearer ${RAW_TOKEN}`)
        .set('x-branch-id', 'another-tenant')
        .expect(403);

      expect((res.body as ErrorEnvelope).code).toBe('FORBIDDEN');
      expect(findById).not.toHaveBeenCalled();
    });

    it('preserves Retry-After on a 429 RATE_LIMITED rate-limit rejection', async () => {
      credential = makeCredential({ rateLimit: 1 });
      findById.mockResolvedValue(PENDING_RECORD);

      await get().expect(200);
      const limited = await get().expect(429);
      const body = limited.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 429,
        code: 'RATE_LIMITED',
        message: 'Too many requests',
      });
      expect(limited.headers['retry-after']).toBeDefined();
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    });
  });

  describe('not found and validation', () => {
    it('returns an identical sanitized 404 whether the id is missing or resolved null by the tenant-scoped port', async () => {
      findById.mockResolvedValue(null);

      const missing = await get(DECISION_ID).expect(404);
      const foreign = await get(FOREIGN_ID).expect(404);

      expect(missing.body).toEqual(foreign.body);
      expect(missing.body).toEqual({
        statusCode: 404,
        code: 'NOT_FOUND',
        message: 'Not found',
      });
      expect(Object.keys(missing.body as object).sort()).toEqual(
        EXPECTED_ERROR_KEYS,
      );
      expect(findById).toHaveBeenNthCalledWith(1, DECISION_ID);
      expect(findById).toHaveBeenNthCalledWith(2, FOREIGN_ID);

      // The handler sets `no-store` BEFORE the port read, so a handler-level
      // miss (404) still carries it, unlike early guard/pipe rejections.
      expect(missing.headers['cache-control']).toBe('no-store');
      expect(foreign.headers['cache-control']).toBe('no-store');
    });

    it('returns a sanitized 400 for a non-UUID id before the port', async () => {
      const res = await get('not-a-uuid').expect(400);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
      });
      expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
      expect(JSON.stringify(body)).not.toContain('not-a-uuid');
      expect(findById).not.toHaveBeenCalled();
    });

    it.each([
      ['the nil UUID', '00000000-0000-0000-0000-000000000000'],
      ['an uppercase canonical UUID', DECISION_ID.toUpperCase()],
      ['a whitespace-padded UUID', ` ${DECISION_ID} `],
    ])(
      'rejects %s with a route-local sanitized 400 before the port',
      async (_label, id) => {
        // Nest 11 `ParseUUIDPipe` (`uuidRegExps.all`) is case-insensitive and
        // version-agnostic, so the nil/uppercase values pass the pipe and MUST
        // be re-checked canonically here; the padded value is rejected by the
        // pipe itself. Both paths collapse to the same sanitized 400.
        const res = await get(id).expect(400);
        const body = res.body as ErrorEnvelope;

        expect(body).toEqual({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
        });
        expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
        expect(JSON.stringify(body)).not.toContain('Invalid human decision');
        expect(findById).not.toHaveBeenCalled();
      },
    );

    it('sanitizes an unexpected repository failure to a 500 without leaking it', async () => {
      findById.mockRejectedValue(new Error('pg password leaked: hunter2'));

      const res = await get().expect(500);
      const body = res.body as Record<string, unknown>;

      expect(body).toEqual({
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      });
      expect(JSON.stringify(body)).not.toContain('hunter2');
      expect(body).not.toHaveProperty('timestamp');
      expect(body).not.toHaveProperty('error');
    });
  });

  describe('coexistence with the existing bot POST intake on the shared prefix', () => {
    it('serves both POST / and GET /:id from the same in-memory graph', async () => {
      credential = makeCredential({
        scopes: ['human-decisions:read', 'human-decisions:create'],
      });
      submit.mockResolvedValue({
        status: 'created',
        request: INTAKE_PERSISTED_ROW,
      });
      findById.mockResolvedValue(PENDING_RECORD);

      const created = await http()
        .post(URL)
        .set('Authorization', `Bearer ${RAW_TOKEN}`)
        .set('x-idempotency-key', SOURCE_REQUEST_ID)
        .send(INTAKE_VALID_BODY as object)
        .expect(201);

      expect((created.body as { status: string }).status).toBe('PENDING');
      expect(submit).toHaveBeenCalledTimes(1);

      const polled = await get().expect(200);
      expect(polled.body).toEqual(EXPECTED_PENDING);
      expect(findById).toHaveBeenCalledTimes(1);
    });
  });
});
