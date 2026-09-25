/**
 * HD-05c2a — HTTP contract for
 * `POST /chatbot-api/human-decisions/:id/application-outcome` (bot terminal
 * ACK).
 *
 * In-memory Nest app + Supertest (`app.init()`, NO listen port, NO DB): the
 * REAL `ServiceAuthGuard`, a REAL nestjs-cls ALS store
 * (`ClsModule.forRoot({ middleware: { mount: true } })`), a mocked
 * `ServiceCredential` repository and a mocked
 * `IBotApplicationOutcomeRepository`. The REAL global `ValidationPipe` and the
 * REAL global `DomainExceptionFilter`/`PrismaExceptionFilter` are configured
 * exactly like `main.ts`, so the controller-scoped `HumanDecisionHttpFilter`
 * precedence is exercised rather than assumed.
 *
 * The tenant is NOT supplied by the caller: it is pinned by the guard into the
 * real ALS store, and the mocked ACK port captures `cls.get('tenantId')` at
 * call time to prove the trusted tenant flows through CLS. No database,
 * provider or network is touched.
 *
 * The sibling bot `POST` intake and `GET` poll controllers are registered in
 * the SAME in-memory graph (with mocked ports) to prove all three bot routes
 * coexist on the shared `chatbot-api/human-decisions` prefix. The route-scoped
 * ACK body parser (`installBotApplicationOutcomeBodyParser`) is installed
 * AFTER `enableCors` and BEFORE `init`, mirroring `main.ts`, and its method+path
 * gate is proven to leave the sibling routes on Nest's default parsers.
 * `HumanDecisionsModule` is asserted through metadata only and never fully
 * booted; the full `AppModule`/DB are deliberately NOT exercised.
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
  HTTP_CODE_METADATA,
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
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import { createListingValidationExceptionFactory } from '../../shared/listing/listing-validation-exception.factory';
import { DatabaseModule } from '../../shared/prisma/prisma.module';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import {
  DELIVERY_UNKNOWN,
  INVALID_OUTCOME_REQUEST_CODE,
  PROVIDER_ACCEPTED,
  PROVIDER_ACCEPTED_LATE,
  STALE,
} from '../domain/bot-application-outcome.request';
import {
  BOT_APPLICATION_OUTCOME_REPOSITORY,
  BotApplicationOutcomeError,
  type BotApplicationOutcomeResult,
  type IBotApplicationOutcomeRepository,
  type RecordBotApplicationOutcomeCommand,
} from '../domain/bot-application-outcome.repository';
import {
  BOT_RESTOCK_POLL_REPOSITORY,
  type BotRestockPollRecord,
  type IBotRestockPollRepository,
} from '../domain/bot-restock-poll.repository';
import {
  RESTOCK_INTAKE_REPOSITORY,
  type PersistedRestockDecision,
  type RestockIntakeInput,
  type RestockIntakeResult,
} from '../domain/restock-intake.repository';
import { HumanDecisionsModule } from '../human-decisions.module';
import { PrismaBotApplicationOutcomeRepository } from '../infrastructure/prisma-bot-application-outcome.repository';
import { PrismaBotRestockPollRepository } from '../infrastructure/prisma-bot-restock-poll.repository';
import { PrismaRestockIntakeRepository } from '../infrastructure/prisma-restock-intake.repository';
import { BotApplicationOutcomeController } from './bot-application-outcome.controller';
import { BotRestockIntakeController } from './bot-restock-intake.controller';
import { BotRestockPollController } from './bot-restock-poll.controller';
import { installBotApplicationOutcomeBodyParser } from './filters/human-decision-body-parser';
import { HumanDecisionHttpFilter } from './filters/human-decision-http.filter';

const URL = '/chatbot-api/human-decisions';
const ACK_SUFFIX = 'application-outcome';
const RAW_TOKEN = 'svc_hd_ack_token';
const HASHED_TOKEN = createHash('sha256').update(RAW_TOKEN).digest('hex');
const ALLOWED_ORIGIN = 'https://sistem.houndfe.com';

const DECISION_ID = '2b7c1a90-6f3e-4d2a-8b1c-0d9e8f7a6b5c';
const FOREIGN_ID = '99999999-9999-4999-8999-999999999999';
const SOURCE_REQUEST_ID = '3f1c1b7a-9c2e-4d5f-8a6b-1c2d3e4f5a6b';
const ATTEMPT_ID = '4a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const PRODUCT_ID = '8f14e45f-ceea-4e42-9f62-1a2b3c4d5e6f';
const ATTEMPTED_AT = '2026-06-15T12:00:00.000Z';
const OBSERVED_AT = '2026-06-15T12:30:00.000Z';
const ACK_RECEIVED_AT = new Date('2026-06-15T13:00:00.000Z');
const PROVIDER_MESSAGE_ID = 'wamid.HBgLNTQ5MTEwMDAwMDAw';

/** The exact five-key bot-safe ACK body. */
const EXPECTED_RESPONSE = {
  id: DECISION_ID,
  version: 2,
  attemptId: ATTEMPT_ID,
  outcome: PROVIDER_ACCEPTED,
  ackReceivedAt: '2026-06-15T13:00:00.000Z',
};

const EXPECTED_TOP_LEVEL_KEYS = [
  'ackReceivedAt',
  'attemptId',
  'id',
  'outcome',
  'version',
];

/** Keys that must NEVER appear on a bot ACK projection. */
const FORBIDDEN_RESPONSE_KEYS = [
  'tenantId',
  'source',
  'type',
  'submittedCredentialId',
  'canonicalRequestHash',
  'applicationEvidenceHash',
  'providerMessageId',
  'providerAcceptedObservedAt',
  'attemptedAt',
  'expectedResolutionVersion',
  'acknowledgment',
  'status',
  'resolvedAt',
  'needsReconciliation',
  'customerPhone',
  'resolvedBy',
];

const EXPECTED_ERROR_KEYS = ['code', 'message', 'statusCode'];

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

function makeCredential(
  overrides: CredentialOverrides = {},
): ServiceCredential {
  return ServiceCredential.fromPersistence({
    id: 'cred-hd-ack-1',
    tenantId: 'tenant-1',
    name: 'Human Decisions ACK Bot',
    hashedKey: HASHED_TOKEN,
    scopes: ['human-decisions:ack'],
    isActive: true,
    lastUsedAt: null,
    rateLimit: 60,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    revokedAt: null,
    ...overrides,
  });
}

// --- Request variants (exact discriminated union) ---------------------------

const PROVIDER_ACCEPTED_BODY = {
  attemptId: ATTEMPT_ID,
  expectedResolutionVersion: 2,
  outcome: PROVIDER_ACCEPTED,
  attemptedAt: ATTEMPTED_AT,
  providerMessageId: PROVIDER_MESSAGE_ID,
  providerAcceptedObservedAt: OBSERVED_AT,
} as const;

const PROVIDER_ACCEPTED_LATE_BODY = {
  ...PROVIDER_ACCEPTED_BODY,
  outcome: PROVIDER_ACCEPTED_LATE,
} as const;

const DELIVERY_UNKNOWN_BODY = {
  attemptId: ATTEMPT_ID,
  expectedResolutionVersion: 2,
  outcome: DELIVERY_UNKNOWN,
  attemptedAt: ATTEMPTED_AT,
  providerMessageId: PROVIDER_MESSAGE_ID,
} as const;

const STALE_BODY = {
  attemptId: ATTEMPT_ID,
  expectedResolutionVersion: 2,
  outcome: STALE,
} as const;

const ACK_RESULT: BotApplicationOutcomeResult = {
  status: 'recorded',
  acknowledgment: {
    id: DECISION_ID,
    version: 2,
    attemptId: ATTEMPT_ID,
    outcome: PROVIDER_ACCEPTED,
    ackReceivedAt: ACK_RECEIVED_AT,
  },
};

const PENDING_POLL_RECORD: BotRestockPollRecord = {
  id: DECISION_ID,
  sourceRequestId: SOURCE_REQUEST_ID,
  type: 'RESTOCK',
  status: 'PENDING',
  version: 1,
  createdAt: new Date('2026-06-01T10:00:05.000Z'),
  snapshot: {
    branchId: 'branch-1',
    branchName: 'Sucursal Centro',
    productId: PRODUCT_ID,
    productName: 'Filtro de aceite',
    variantId: null,
    sku: 'SKU-1',
    requestedQuantity: 3,
    observedStockAtRequest: 5,
    stockObservedAt: new Date('2026-06-01T10:00:00.000Z'),
  },
  supersedesDecisionId: null,
  resolutionAction: null,
  restockDays: null,
  resolvedAt: null,
};

const INTAKE_PERSISTED_ROW: PersistedRestockDecision = {
  id: DECISION_ID,
  source: 'houndfe-chatbot',
  sourceRequestId: SOURCE_REQUEST_ID,
  type: 'RESTOCK',
  canonicalRequestHash: 'hash-v1',
  status: 'PENDING',
  version: 1,
  supersedesDecisionId: null,
  createdAt: new Date('2026-06-01T10:00:05.000Z'),
  snapshot: {
    branchId: 'branch-1',
    branchName: 'Sucursal Centro',
    productId: PRODUCT_ID,
    productName: 'Filtro de aceite',
    variantId: null,
    sku: 'SKU-1',
    requestedQuantity: 3,
    observedStockAtRequest: 5,
    stockObservedAt: new Date('2026-06-01T10:00:00.000Z'),
  },
};

const INTAKE_VALID_BODY = {
  sourceRequestId: SOURCE_REQUEST_ID,
  type: 'RESTOCK',
  productId: PRODUCT_ID,
  productName: 'Filtro de aceite',
  variantId: null,
  sku: 'SKU-1',
  requestedQuantity: 3,
  observedStockAtRequest: 5,
  stockObservedAt: '2026-06-01T10:00:00.000Z',
  supersedesDecisionId: null,
} as const;

const FIXED_VALIDATION_400 = {
  statusCode: 400,
  code: 'VALIDATION_ERROR',
  message: 'Invalid request',
};

describe('Bot application outcome HTTP contract (HD-05c2a)', () => {
  let app: INestApplication;
  let record: jest.Mock<
    Promise<BotApplicationOutcomeResult>,
    [RecordBotApplicationOutcomeCommand]
  >;
  let findById: jest.Mock<Promise<BotRestockPollRecord | null>, [string]>;
  let submit: jest.Mock<Promise<RestockIntakeResult>, [RestockIntakeInput]>;
  let findByHashedKey: jest.Mock<Promise<ServiceCredential | null>, [string]>;
  let touchLastUsedAt: jest.Mock<Promise<void>, [string, (Date | undefined)?]>;
  let credential: ServiceCredential | null;
  let tenantSeenByPort: string | null | undefined;

  const http = () => request(app.getHttpServer() as import('node:http').Server);

  const ackUrl = (id: string = DECISION_ID) => `${URL}/${id}/${ACK_SUFFIX}`;

  const postAck = (
    body: unknown = PROVIDER_ACCEPTED_BODY,
    {
      id = DECISION_ID,
      token = RAW_TOKEN as string | null,
      raw,
      contentType,
    }: {
      id?: string;
      token?: string | null;
      raw?: string;
      contentType?: string;
    } = {},
  ) => {
    const builder = http().post(ackUrl(id));
    if (token) {
      builder.set('Authorization', `Bearer ${token}`);
    }
    if (raw !== undefined) {
      return builder
        .set('Content-Type', contentType ?? 'application/json')
        .send(raw);
    }
    return builder.send(body as object);
  };

  beforeEach(async () => {
    credential = makeCredential();
    tenantSeenByPort = undefined;
    record = jest.fn<
      Promise<BotApplicationOutcomeResult>,
      [RecordBotApplicationOutcomeCommand]
    >(() => Promise.resolve(ACK_RESULT));
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
      controllers: [
        BotApplicationOutcomeController,
        BotRestockIntakeController,
        BotRestockPollController,
      ],
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
          provide: BOT_APPLICATION_OUTCOME_REPOSITORY,
          inject: [ClsService],
          useFactory: (
            clsService: ClsService<TenantClsStore>,
          ): IBotApplicationOutcomeRepository => ({
            record: (command) => {
              tenantSeenByPort = clsService.get('tenantId');
              return record(command);
            },
          }),
        },
        {
          provide: BOT_RESTOCK_POLL_REPOSITORY,
          useFactory: (): IBotRestockPollRepository => ({
            findById: (id: string) => findById(id),
          }),
        },
        {
          provide: RESTOCK_INTAKE_REPOSITORY,
          useValue: { submit },
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
    // Mirror `main.ts` order: CORS FIRST, then the route-scoped sanitizing
    // parser, both BEFORE init, so a malformed-body short-circuit still carries
    // the allowlisted origin.
    app.enableCors({ origin: ALLOWED_ORIGIN, credentials: true });
    installBotApplicationOutcomeBodyParser(app);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('route metadata and module wiring', () => {
    it('pins the ACK handler to POST :id/application-outcome, human-decisions:ack, 200, the service guard and the scoped filter', () => {
      const handler = Object.getOwnPropertyDescriptor(
        BotApplicationOutcomeController.prototype,
        'create',
      )?.value as () => void;

      expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, handler)).toEqual([
        'human-decisions:ack',
      ]);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
        RequestMethod.POST,
      );
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
        ':id/application-outcome',
      );
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
      expect(
        Reflect.getMetadata(PATH_METADATA, BotApplicationOutcomeController),
      ).toBe('chatbot-api/human-decisions');

      const guards = (Reflect.getMetadata(
        GUARDS_METADATA,
        BotApplicationOutcomeController,
      ) ?? []) as unknown[];
      const filters = (Reflect.getMetadata(
        EXCEPTION_FILTERS_METADATA,
        BotApplicationOutcomeController,
      ) ?? []) as unknown[];

      expect(guards).toContain(ServiceAuthGuard);
      expect(filters).toContain(HumanDecisionHttpFilter);
    });

    it('registers the ACK controller and binding without disturbing the poll/intake bindings', () => {
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

      expect(controllers).toContain(BotApplicationOutcomeController);
      expect(controllers).toContain(BotRestockPollController);
      expect(controllers).toContain(BotRestockIntakeController);
      expect(imports).toContain(ChatbotApiModule);
      expect(imports).toContain(DatabaseModule);

      const ackBinding = providers.find(
        (provider) => provider?.provide === BOT_APPLICATION_OUTCOME_REPOSITORY,
      );
      expect(ackBinding?.useClass).toBe(PrismaBotApplicationOutcomeRepository);

      const pollBinding = providers.find(
        (provider) => provider?.provide === BOT_RESTOCK_POLL_REPOSITORY,
      );
      expect(pollBinding?.useClass).toBe(PrismaBotRestockPollRepository);

      const intakeBinding = providers.find(
        (provider) => provider?.provide === RESTOCK_INTAKE_REPOSITORY,
      );
      expect(intakeBinding?.useClass).toBe(PrismaRestockIntakeRepository);
    });
  });

  describe('success path (200 first AND exact replay)', () => {
    it('records once and returns the exact five-key body with a no-store header', async () => {
      const res = await postAck().expect(200);
      const body = res.body as Record<string, unknown>;

      expect(body).toEqual(EXPECTED_RESPONSE);
      expect(Object.keys(body).sort()).toEqual(EXPECTED_TOP_LEVEL_KEYS);
      expect(res.headers['cache-control']).toBe('no-store');

      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0][0]).toEqual({
        decisionId: DECISION_ID,
        request: PROVIDER_ACCEPTED_BODY,
      });
    });

    it('replays an exact second request with an identical body and one port call each', async () => {
      record
        .mockResolvedValueOnce(ACK_RESULT)
        .mockResolvedValueOnce({ ...ACK_RESULT, status: 'replayed' });

      const first = await postAck().expect(200);
      const second = await postAck().expect(200);

      expect(second.body).toEqual(first.body);
      expect(second.body).toEqual(EXPECTED_RESPONSE);
      expect(first.headers['cache-control']).toBe('no-store');
      expect(second.headers['cache-control']).toBe('no-store');
      // The route never performs a second mutation itself: one port call per
      // request, and the replay result is projected identically.
      expect(record).toHaveBeenCalledTimes(2);
      expect(record.mock.calls[1][0]).toEqual(record.mock.calls[0][0]);
    });

    it('never leaks evidence, provider, authority or PII fields', async () => {
      const res = await postAck().expect(200);
      const body = res.body as Record<string, unknown>;

      for (const key of FORBIDDEN_RESPONSE_KEYS) {
        expect(body).not.toHaveProperty(key);
      }
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(PROVIDER_MESSAGE_ID);
      expect(serialized).not.toContain('tenant-1');
      expect(serialized).not.toContain('cred-hd-ack-1');
    });
  });

  describe('exact request parser from an unknown body (no DTO whitelist)', () => {
    it.each([
      ['PROVIDER_ACCEPTED', PROVIDER_ACCEPTED_BODY, PROVIDER_ACCEPTED],
      [
        'PROVIDER_ACCEPTED_LATE',
        PROVIDER_ACCEPTED_LATE_BODY,
        PROVIDER_ACCEPTED_LATE,
      ],
      ['DELIVERY_UNKNOWN', DELIVERY_UNKNOWN_BODY, DELIVERY_UNKNOWN],
      ['STALE', STALE_BODY, STALE],
    ])(
      'forwards the exact parsed %s variant to the port as {decisionId,request}',
      async (_label, variant, outcome) => {
        await postAck(variant).expect(200);

        expect(record).toHaveBeenCalledTimes(1);
        const command = record.mock.calls[0][0];
        expect(command).toEqual({ decisionId: DECISION_ID, request: variant });
        expect(Object.keys(command).sort()).toEqual(['decisionId', 'request']);
        expect(command.request.outcome).toBe(outcome);
      },
    );

    it('preserves an unknown/authority key instead of whitelisting it away', async () => {
      const body = {
        ...PROVIDER_ACCEPTED_BODY,
        decisionId: DECISION_ID,
      };

      const res = await postAck(body).expect(400);

      expect(res.body).toEqual(FIXED_VALIDATION_400);
      expect(record).not.toHaveBeenCalled();
      expect(JSON.stringify(res.body)).not.toContain(DECISION_ID);
    });

    it('rejects a forbidden evidenceCode even as null without echoing it', async () => {
      const sentinel = 'SENTINEL-EVIDENCE-CODE';
      const body = { ...STALE_BODY, evidenceCode: null };
      const res = await postAck({ ...body, sentinel }).expect(400);

      expect(res.body).toEqual(FIXED_VALIDATION_400);
      expect(record).not.toHaveBeenCalled();
      expect(JSON.stringify(res.body)).not.toContain(sentinel);
    });

    it.each([
      [
        'PROVIDER_ACCEPTED_LATE with an extra field',
        { ...PROVIDER_ACCEPTED_LATE_BODY, ackReceivedAt: ATTEMPTED_AT },
      ],
      [
        'DELIVERY_UNKNOWN with a forbidden providerAcceptedObservedAt:null',
        { ...DELIVERY_UNKNOWN_BODY, providerAcceptedObservedAt: null },
      ],
      [
        'STALE with a forbidden attemptedAt',
        { ...STALE_BODY, attemptedAt: ATTEMPTED_AT },
      ],
      [
        'a stale expectedResolutionVersion shape',
        { ...STALE_BODY, expectedResolutionVersion: '2' },
      ],
    ])(
      'rejects %s with a sanitized 400 and no port call',
      async (_label, body) => {
        const res = await postAck(body).expect(400);

        expect(res.body).toEqual(FIXED_VALIDATION_400);
        expect(record).not.toHaveBeenCalled();
        expect(JSON.stringify(res.body)).not.toContain(
          INVALID_OUTCOME_REQUEST_CODE,
        );
      },
    );

    it('maps the port out-of-window InvalidArgumentError to a sanitized 400 with no leakage', async () => {
      const sentinel = 'SENTINEL-OUT-OF-WINDOW-7c41e9d2';
      record.mockRejectedValue(
        new InvalidArgumentError(
          `bot application outcome outside window ${sentinel}`,
          'INVALID_OUTCOME_WINDOW',
        ),
      );

      const res = await postAck().expect(400);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual(FIXED_VALIDATION_400);
      expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
      expect(JSON.stringify(body)).not.toContain(sentinel);
      expect(JSON.stringify(body)).not.toContain('INVALID_OUTCOME_WINDOW');
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  describe('tenant scope comes from CLS, never from the caller', () => {
    it('pins the credential tenant into the real ALS store the adapter would read', async () => {
      await postAck().expect(200);

      expect(tenantSeenByPort).toBe('tenant-1');
    });

    it('ignores caller-supplied tenant/source query params and forwards only decisionId+request', async () => {
      const res = await http()
        .post(`${ackUrl()}?tenantId=evil-tenant&source=evil-source`)
        .set('Authorization', `Bearer ${RAW_TOKEN}`)
        .send(PROVIDER_ACCEPTED_BODY as object)
        .expect(200);

      expect(res.body).toEqual(EXPECTED_RESPONSE);
      expect(tenantSeenByPort).toBe('tenant-1');
      const command = record.mock.calls[0][0] as unknown as Record<
        string,
        unknown
      >;
      expect(command).not.toHaveProperty('tenantId');
      expect(command).not.toHaveProperty('source');
      expect(command).not.toHaveProperty('type');
      expect(command).not.toHaveProperty('submittedCredentialId');
    });
  });

  describe('authentication and authorization', () => {
    it('returns 401 for an unknown credential and never touches the port', async () => {
      credential = null;

      const res = await postAck().expect(401);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 401,
        code: 'UNAUTHORIZED',
        message: 'Unauthorized',
      });
      expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
      expect(record).not.toHaveBeenCalled();
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

      await postAck().expect(401);
      expect(record).not.toHaveBeenCalled();
    });

    it('returns 401 when the bearer token is missing', async () => {
      const res = await postAck(PROVIDER_ACCEPTED_BODY, { token: null }).expect(
        401,
      );

      expect((res.body as ErrorEnvelope).code).toBe('UNAUTHORIZED');
      expect(record).not.toHaveBeenCalled();
    });

    it('fails closed when the guard-populated credential is absent', async () => {
      const controller = app.get(BotApplicationOutcomeController);

      await expect(
        controller.create(
          DECISION_ID,
          PROVIDER_ACCEPTED_BODY,
          { serviceCredential: undefined } as unknown as Parameters<
            BotApplicationOutcomeController['create']
          >[2],
          { setHeader: jest.fn() } as unknown as Parameters<
            BotApplicationOutcomeController['create']
          >[3],
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(record).not.toHaveBeenCalled();
    });

    it('returns 403 when a create-only credential lacks human-decisions:ack', async () => {
      credential = makeCredential({ scopes: ['human-decisions:create'] });

      const res = await postAck().expect(403);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 403,
        code: 'FORBIDDEN',
        message: 'Forbidden',
      });
      expect(record).not.toHaveBeenCalled();
    });

    it('returns 403 when the branch header is out of scope', async () => {
      const res = await http()
        .post(ackUrl())
        .set('Authorization', `Bearer ${RAW_TOKEN}`)
        .set('x-branch-id', 'another-tenant')
        .send(PROVIDER_ACCEPTED_BODY as object)
        .expect(403);

      expect((res.body as ErrorEnvelope).code).toBe('FORBIDDEN');
      expect(record).not.toHaveBeenCalled();
    });

    it('preserves Retry-After on a 429 RATE_LIMITED rate-limit rejection', async () => {
      credential = makeCredential({ rateLimit: 1 });

      await postAck().expect(200);
      const limited = await postAck().expect(429);
      const body = limited.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 429,
        code: 'RATE_LIMITED',
        message: 'Too many requests',
      });
      expect(limited.headers['retry-after']).toBeDefined();
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      // The second (limited) request never reached the port.
      expect(record).toHaveBeenCalledTimes(1);
    });
  });

  describe('port error mapping (exact code, no leakage)', () => {
    it.each([
      ['NOT_FOUND', 404, 'NOT_FOUND', 'Not found'],
      [
        'VERSION_CONFLICT',
        409,
        'VERSION_CONFLICT',
        'Human decision was modified by another reviewer',
      ],
      [
        'IDEMPOTENCY_CONFLICT',
        409,
        'IDEMPOTENCY_CONFLICT',
        'Request conflicts with a previous submission',
      ],
      [
        'OUTCOME_ALREADY_RECORDED',
        409,
        'OUTCOME_ALREADY_RECORDED',
        'A terminal application outcome is already recorded',
      ],
    ] as const)(
      'maps ACK port %s to %s %s without echoing the message',
      async (errorCode, statusCode, code, message) => {
        const sentinel = `SENTINEL-${errorCode}-7c41e9d2`;
        record.mockRejectedValue(
          new BotApplicationOutcomeError(errorCode, `leaked ${sentinel}`),
        );

        const res = await postAck().expect(statusCode);
        const body = res.body as ErrorEnvelope;

        expect(body).toEqual({ statusCode, code, message });
        expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
        expect(JSON.stringify(body)).not.toContain(sentinel);
        expect(body).not.toHaveProperty('timestamp');
        expect(body).not.toHaveProperty('error');
        // A handler-level port error still carries the no-store header.
        expect(res.headers['cache-control']).toBe('no-store');
      },
    );

    it('maps an unrelated repository failure to a fixed 500 without leaking', async () => {
      record.mockRejectedValue(new Error('pg password leaked: hunter2'));

      const res = await postAck().expect(500);
      const body = res.body as Record<string, unknown>;

      expect(body).toEqual({
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      });
      expect(JSON.stringify(body)).not.toContain('hunter2');
      expect(body).not.toHaveProperty('timestamp');
    });
  });

  describe('canonical decision id (400 before the port)', () => {
    it('returns a sanitized 400 for a non-UUID id before the port', async () => {
      const res = await postAck(PROVIDER_ACCEPTED_BODY, {
        id: 'not-a-uuid',
      }).expect(400);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual(FIXED_VALIDATION_400);
      expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
      expect(JSON.stringify(body)).not.toContain('not-a-uuid');
      expect(record).not.toHaveBeenCalled();
    });

    it.each([
      ['the nil UUID', '00000000-0000-0000-0000-000000000000'],
      ['an uppercase canonical UUID', DECISION_ID.toUpperCase()],
      ['a whitespace-padded UUID', ` ${DECISION_ID} `],
      ['a foreign-shaped valid UUID', FOREIGN_ID],
    ])(
      'rejects %s with a route-local sanitized 400 before the port (except a valid foreign id)',
      async (_label, id) => {
        // The nil/uppercase/padded cases must never reach the port. A valid but
        // foreign UUID is a legitimate 404 from the tenant-scoped port, so it is
        // asserted separately below.
        if (id === FOREIGN_ID) {
          record.mockRejectedValue(
            new BotApplicationOutcomeError('NOT_FOUND', 'missing'),
          );
          await postAck(PROVIDER_ACCEPTED_BODY, { id }).expect(404);
          return;
        }

        const res = await postAck(PROVIDER_ACCEPTED_BODY, { id }).expect(400);
        const body = res.body as ErrorEnvelope;

        expect(body).toEqual(FIXED_VALIDATION_400);
        expect(record).not.toHaveBeenCalled();
        expect(JSON.stringify(body)).not.toContain('Invalid human decision');
      },
    );

    it('does not set no-store on the early canonical-id 400 (no early caching claim)', async () => {
      const res = await postAck(PROVIDER_ACCEPTED_BODY, {
        id: 'not-a-uuid',
      }).expect(400);

      expect(res.headers['cache-control']).toBeUndefined();
    });
  });

  describe('route-scoped sanitizing parser (exact method+path)', () => {
    it('keeps the Nest default global body parsers mounted alongside the scoped ones', () => {
      const instance = app.getHttpAdapter().getInstance() as {
        router: { stack: Array<{ handle?: { name?: string } }> };
      };
      const parserNames = instance.router.stack
        .map((layer) => layer.handle?.name)
        .filter((name) => name === 'jsonParser' || name === 'urlencodedParser');

      expect(parserNames).toEqual(['jsonParser', 'urlencodedParser']);
    });

    it('sanitizes malformed JSON syntax on the ACK route without echoing the raw body', async () => {
      const malformed = '{"pii":"SENTINEL","attemptId":"SENTINEL_ID"';

      const res = await postAck(undefined, { raw: malformed }).expect(400);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual(FIXED_VALIDATION_400);
      expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
      expect(JSON.stringify(body)).not.toContain('SENTINEL');
      expect(record).not.toHaveBeenCalled();
    });

    it.each([
      ['a bare null', 'null'],
      ['a bare string', '"PROVIDER_ACCEPTED"'],
      ['a bare number', '7'],
      ['a bare boolean', 'true'],
    ])(
      'accepts a JSON %s primitive at the transport and rejects it with the sanitized 400 before the port',
      async (_label, rawJson) => {
        const res = await postAck(undefined, { raw: rawJson }).expect(400);

        expect(res.body).toEqual(FIXED_VALIDATION_400);
        expect(record).not.toHaveBeenCalled();
      },
    );

    it('preserves 413 for an oversized ACK body with a fixed value-free envelope', async () => {
      const padding = 'a'.repeat(110 * 1024);
      const res = await postAck(undefined, {
        raw: `{"attemptId":"${ATTEMPT_ID}","padding":"${padding}"}`,
      }).expect(413);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 413,
        code: 'REQUEST_ERROR',
        message: 'Request failed',
      });
      expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
      expect(JSON.stringify(body)).not.toContain(padding.slice(0, 32));
      expect(record).not.toHaveBeenCalled();
    });

    it('sanitizes a malformed urlencoded form body with the fixed 400 before the port', async () => {
      const deeplyNestedForm = `a${'[b]'.repeat(40)}=SENTINEL`;
      const res = await postAck(undefined, {
        raw: deeplyNestedForm,
        contentType: 'application/x-www-form-urlencoded',
      }).expect(400);

      expect(res.body).toEqual(FIXED_VALIDATION_400);
      expect(JSON.stringify(res.body)).not.toContain('SENTINEL');
      expect(record).not.toHaveBeenCalled();
    });

    it('keeps the allowlisted CORS origin on a malformed-body 400 and 413', async () => {
      const malformed = await http()
        .post(ackUrl())
        .set('Origin', ALLOWED_ORIGIN)
        .set('Content-Type', 'application/json')
        .send('{"pii":"SENTINEL"')
        .expect('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
        .expect(400);
      expect(malformed.body).toEqual(FIXED_VALIDATION_400);

      const padding = 'a'.repeat(110 * 1024);
      const oversized = await http()
        .post(ackUrl())
        .set('Origin', ALLOWED_ORIGIN)
        .set('Content-Type', 'application/json')
        .send(`{"padding":"${padding}"}`)
        .expect('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
        .expect(413);
      expect((oversized.body as ErrorEnvelope).code).toBe('REQUEST_ERROR');
    });

    it('leaves sibling bot routes on Nest default parsing (exact method+path gate)', async () => {
      // A malformed body on a NON-ACK sibling path must NOT be answered by the
      // ACK parser's fixed envelope: the gate skipped the request entirely, so
      // Nest's default handling applies. The intake POST with a valid body must
      // still parse and reach its mocked port (201).
      credential = makeCredential({
        scopes: [
          'human-decisions:ack',
          'human-decisions:create',
          'human-decisions:read',
        ],
      });
      submit.mockResolvedValue({
        status: 'created',
        request: INTAKE_PERSISTED_ROW,
      });

      const validIntake = await http()
        .post(URL)
        .set('Authorization', `Bearer ${RAW_TOKEN}`)
        .set('x-idempotency-key', SOURCE_REQUEST_ID)
        .send(INTAKE_VALID_BODY as object)
        .expect(201);
      expect((validIntake.body as { type: string }).type).toBe('RESTOCK');
      expect(submit).toHaveBeenCalledTimes(1);

      // A POST to the ACK-path prefix but a DIFFERENT terminal segment is not
      // the ACK route; the scoped parser must not sanitize it.
      const offPath = await http()
        .post(`${URL}/${DECISION_ID}/application-outcome-typo`)
        .set('Origin', ALLOWED_ORIGIN)
        .set('Content-Type', 'application/json')
        .send('{"pii":"SENTINEL"');
      expect(offPath.body).not.toEqual(FIXED_VALIDATION_400);
    });

    describe('Express-equivalent URL variants stay sanitized (case + trailing slash)', () => {
      // Express defaults (`case sensitive routing`=false, `strict routing`=false,
      // both untouched by Nest) make the ACK route reachable through case
      // variants and a trailing `/`. The scoped pre-parser gate MUST agree with
      // that routing: otherwise a malformed body on an equivalent URL bypasses
      // it and reaches Nest's default parser, which can echo a raw body snippet
      // before any controller-scoped filter can run.
      const MALFORMED_JSON = '{"pii":"SENTINEL","attemptId":"SENTINEL_ID"';

      const URL_VARIANTS: Array<[string, string]> = [
        ['a trailing slash', `${URL}/${DECISION_ID}/${ACK_SUFFIX}/`],
        [
          'a fully uppercase path',
          `/CHATBOT-API/HUMAN-DECISIONS/${DECISION_ID}/APPLICATION-OUTCOME`,
        ],
        [
          'a mixed-case prefix',
          `/Chatbot-Api/Human-Decisions/${DECISION_ID}/${ACK_SUFFIX}`,
        ],
        [
          'a mixed-case prefix plus uppercase suffix and trailing slash',
          `/Chatbot-Api/Human-Decisions/${DECISION_ID}/APPLICATION-OUTCOME/`,
        ],
      ];

      it.each(URL_VARIANTS)(
        'resolves the ACK route for a valid body with %s (real routing equivalence)',
        async (_label, path) => {
          record.mockClear();

          const res = await http()
            .post(path)
            .set('Authorization', `Bearer ${RAW_TOKEN}`)
            .send(PROVIDER_ACCEPTED_BODY as object)
            .expect(200);

          expect(res.body).toEqual(EXPECTED_RESPONSE);
          expect(record).toHaveBeenCalledTimes(1);
        },
      );

      it.each(URL_VARIANTS)(
        'sanitizes malformed JSON with %s, keeps CORS and never reaches the port',
        async (_label, path) => {
          record.mockClear();

          const res = await http()
            .post(path)
            .set('Origin', ALLOWED_ORIGIN)
            .set('Authorization', `Bearer ${RAW_TOKEN}`)
            .set('Content-Type', 'application/json')
            .send(MALFORMED_JSON)
            .expect('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
            .expect(400);

          expect(res.body).toEqual(FIXED_VALIDATION_400);
          expect(Object.keys(res.body as object).sort()).toEqual(
            EXPECTED_ERROR_KEYS,
          );
          expect(JSON.stringify(res.body)).not.toContain('SENTINEL');
          expect(record).not.toHaveBeenCalled();
        },
      );

      it('keeps a malformed sibling suffix on Nest default handling (negative control)', async () => {
        record.mockClear();

        const res = await http()
          .post(`${URL}/${DECISION_ID}/application-outcome-typo`)
          .set('Origin', ALLOWED_ORIGIN)
          .set('Authorization', `Bearer ${RAW_TOKEN}`)
          .set('Content-Type', 'application/json')
          .send(MALFORMED_JSON);

        expect(res.body).not.toEqual(FIXED_VALIDATION_400);
        expect(record).not.toHaveBeenCalled();
      });

      it('sanitizes a malformed ACK body that carries an encoded query string (positive control)', async () => {
        record.mockClear();

        const res = await http()
          .post(
            `${URL}/${DECISION_ID}/${ACK_SUFFIX}?redirect=${encodeURIComponent(
              'https://evil.example/',
            )}`,
          )
          .set('Origin', ALLOWED_ORIGIN)
          .set('Authorization', `Bearer ${RAW_TOKEN}`)
          .set('Content-Type', 'application/json')
          .send(MALFORMED_JSON)
          .expect('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
          .expect(400);

        expect(res.body).toEqual(FIXED_VALIDATION_400);
        expect(JSON.stringify(res.body)).not.toContain('SENTINEL');
        expect(record).not.toHaveBeenCalled();
      });

      it('does not sanitize a malformed request on a sibling path with an encoded query (negative control)', async () => {
        record.mockClear();

        const res = await http()
          .post(
            `${URL}/${DECISION_ID}/application-outcome-typo?redirect=${encodeURIComponent(
              'https://evil.example/',
            )}`,
          )
          .set('Origin', ALLOWED_ORIGIN)
          .set('Authorization', `Bearer ${RAW_TOKEN}`)
          .set('Content-Type', 'application/json')
          .send(MALFORMED_JSON);

        expect(res.body).not.toEqual(FIXED_VALIDATION_400);
        expect(record).not.toHaveBeenCalled();
      });
    });
  });

  describe('coexistence with the bot POST intake and GET poll on the shared prefix', () => {
    it('serves POST /, GET /:id and POST /:id/application-outcome from one graph', async () => {
      credential = makeCredential({
        scopes: [
          'human-decisions:ack',
          'human-decisions:create',
          'human-decisions:read',
        ],
      });
      submit.mockResolvedValue({
        status: 'created',
        request: INTAKE_PERSISTED_ROW,
      });
      findById.mockResolvedValue(PENDING_POLL_RECORD);

      const created = await http()
        .post(URL)
        .set('Authorization', `Bearer ${RAW_TOKEN}`)
        .set('x-idempotency-key', SOURCE_REQUEST_ID)
        .send(INTAKE_VALID_BODY as object)
        .expect(201);
      expect((created.body as { status: string }).status).toBe('PENDING');

      const polled = await http()
        .get(`${URL}/${DECISION_ID}`)
        .set('Authorization', `Bearer ${RAW_TOKEN}`)
        .expect(200);
      expect((polled.body as { id: string }).id).toBe(DECISION_ID);

      const acked = await postAck().expect(200);
      expect(acked.body).toEqual(EXPECTED_RESPONSE);

      expect(submit).toHaveBeenCalledTimes(1);
      expect(findById).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledTimes(1);
    });
  });
});
