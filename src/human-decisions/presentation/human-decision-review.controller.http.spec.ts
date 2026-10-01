/**
 * HD-04d1 — HTTP contract for the guarded HUMAN reviewer READ routes.
 *
 *   GET /human-decisions        (list; tenant-scoped PENDING queue)
 *   GET /human-decisions/:id    (detail; PENDING | RESOLVED)
 *
 * In-memory Nest app + Supertest (`app.init()`, NO listen port, NO DB): the
 * REAL `JwtStrategy` + `JwtAuthGuard`, REAL `TenantContextGuard`, REAL
 * `PermissionsGuard`, a REAL nestjs-cls ALS store and the REAL controller
 * scoped `HumanDecisionHttpFilter` over a MOCKED read port. The global
 * `ValidationPipe`/`DomainExceptionFilter`/`PrismaExceptionFilter` mirror
 * `main.ts` so the scoped filter's precedence is exercised, not assumed.
 *
 * Three data/authorization seams are mocked: `PrismaService.user.findUnique`
 * (active-user lookup), `CaslAbilityFactory.createForUser` (returns real CASL
 * abilities, but does not query stored role grants), and the read port. JWT,
 * ALS propagation, guard order and scoped filtering are real here; actual
 * User/role persistence, Prisma tenant scoping, ILIKE and the CLS extension
 * require the dedicated DB/ALS spec in HD-04d2. A tenantless superadmin is
 * denied by the route-specific active-reviewer guard before the read port.
 *
 * Deliberately NOT booted: `HumanDecisionsModule`/`AppModule` (transitive
 * Inngest/mail/provider registrars). Module wiring is asserted via metadata.
 */
import {
  ForbiddenException,
  INestApplication,
  RequestMethod,
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
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import { ClsModule, ClsService } from 'nestjs-cls';
import request from 'supertest';
import { AuthModule } from '../../auth/auth.module';
import { CaslAbilityFactory } from '../../auth/authorization/casl-ability.factory';
import { PERMISSIONS_KEY } from '../../auth/authorization/decorators/require-permissions.decorator';
import type {
  AppAbility,
  AppActions,
  AppSubjects,
} from '../../auth/authorization/domain/permission';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { JwtStrategy } from '../../auth/infrastructure/strategies/jwt.strategy';
import { SERVICE_CREDENTIAL_REPOSITORY } from '../../chatbot-api/domain/service-credential.repository';
import { ChatbotApiModule } from '../../chatbot-api/chatbot-api.module';
import { ServiceAuthGuard } from '../../chatbot-api/presentation/guards/service-auth.guard';
import { DomainExceptionFilter } from '../../shared/filters/domain-exception.filter';
import { PrismaExceptionFilter } from '../../shared/filters/prisma-exception.filter';
import { createListingValidationExceptionFactory } from '../../shared/listing/listing-validation-exception.factory';
import { DatabaseModule } from '../../shared/prisma/prisma.module';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import {
  HUMAN_DECISION_REVIEW_READ_REPOSITORY,
  HumanDecisionReviewReadError,
  type HumanDecisionReviewListQuery,
  type HumanDecisionReviewPage,
  type HumanDecisionReviewRecord,
} from '../domain/human-decision-review-read.repository';
import { HUMAN_DECISION_REVIEW_RESOLVE_REPOSITORY } from '../domain/human-decision-review-resolve.repository';
import { RESTOCK_INTAKE_REPOSITORY } from '../domain/restock-intake.repository';
import { HumanDecisionsModule } from '../human-decisions.module';
import { PrismaHumanDecisionReviewReadRepository } from '../infrastructure/prisma-human-decision-review-read.repository';
import { PrismaHumanDecisionReviewResolveRepository } from '../infrastructure/prisma-human-decision-review-resolve.repository';
import { PrismaRestockIntakeRepository } from '../infrastructure/prisma-restock-intake.repository';
import { BotRestockIntakeController } from './bot-restock-intake.controller';
import { installHumanDecisionBodyParser } from './filters/human-decision-body-parser';
import { HumanDecisionHttpFilter } from './filters/human-decision-http.filter';
import { HumanDecisionActiveReviewerGuard } from './guards/human-decision-active-reviewer.guard';
import { HumanDecisionReviewController } from './human-decision-review.controller';

const TEST_SECRET = 'hd-04d1-test-secret-not-a-production-key';
const LIST_URL = '/human-decisions';

const DECISION_ID = '2b7c1a90-6f3e-4d2a-8b1c-0d9e8f7a6b5c';
const PRODUCT_ID = '8f14e45f-ceea-4e42-9f62-1a2b3c4d5e6f';
const VARIANT_ID = '550e8400-e29b-41d4-a716-446655440000';

const EXPECTED_ERROR_KEYS = ['code', 'message', 'statusCode'];

const PENDING_ACTIONS = [
  'PROVIDE_RESTOCK_ESTIMATE',
  'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
];

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
  'canResolve',
  'pii',
  'customerPhone',
];

// ---------------------------------------------------------------------------
// Principal fixtures + real CASL abilities
// ---------------------------------------------------------------------------

type PermissionTuple = [AppActions, AppSubjects];

const READER_ID = 'user-reader';
const MANAGER_ID = 'user-manager';
const NO_READ_ID = 'user-no-read';
const SUPER_ID = 'user-super-admin';
const INACTIVE_ID = 'user-inactive';
const DELETED_ID = 'user-deleted';

const PERMISSIONS: Record<string, PermissionTuple[]> = {
  [READER_ID]: [['read', 'HumanDecision']],
  [MANAGER_ID]: [
    ['read', 'HumanDecision'],
    ['update', 'HumanDecision'],
  ],
  [NO_READ_ID]: [['read', 'Sale']],
  [SUPER_ID]: [['manage', 'all']],
  [INACTIVE_ID]: [['read', 'HumanDecision']],
  [DELETED_ID]: [['read', 'HumanDecision']],
};

interface UserFixture {
  sub: string;
  email: string;
  tenantId: string | null;
  tenantSlug: string | null;
  isSuperAdmin: boolean;
}

const USERS: Record<string, UserFixture> = {
  reader: {
    sub: READER_ID,
    email: 'reader@houndfe.test',
    tenantId: 'tenant-1',
    tenantSlug: 'centro',
    isSuperAdmin: false,
  },
  manager: {
    sub: MANAGER_ID,
    email: 'manager@houndfe.test',
    tenantId: 'tenant-1',
    tenantSlug: 'centro',
    isSuperAdmin: false,
  },
  noRead: {
    sub: NO_READ_ID,
    email: 'no-read@houndfe.test',
    tenantId: 'tenant-1',
    tenantSlug: 'centro',
    isSuperAdmin: false,
  },
  super: {
    sub: SUPER_ID,
    email: 'super@houndfe.test',
    tenantId: null,
    tenantSlug: null,
    isSuperAdmin: true,
  },
  superWithTenant: {
    sub: SUPER_ID,
    email: 'super@houndfe.test',
    tenantId: 'tenant-1',
    tenantSlug: 'centro',
    isSuperAdmin: true,
  },
  inactive: {
    sub: INACTIVE_ID,
    email: 'inactive@houndfe.test',
    tenantId: 'tenant-1',
    tenantSlug: 'centro',
    isSuperAdmin: false,
  },
  deleted: {
    sub: DELETED_ID,
    email: 'deleted@houndfe.test',
    tenantId: 'tenant-1',
    tenantSlug: 'centro',
    isSuperAdmin: false,
  },
};

const jwtService = new JwtService({
  secret: TEST_SECRET,
  signOptions: { expiresIn: '1h' },
});

const TOKENS: Record<keyof typeof USERS, string> = {
  reader: jwtService.sign(USERS.reader),
  manager: jwtService.sign(USERS.manager),
  noRead: jwtService.sign(USERS.noRead),
  super: jwtService.sign(USERS.super),
  superWithTenant: jwtService.sign(USERS.superWithTenant),
  inactive: jwtService.sign(USERS.inactive),
  deleted: jwtService.sign(USERS.deleted),
};

/**
 * Current-account state read by the active-reviewer guard: `true` active,
 * `false` deactivated, `null` deleted/absent. Only `isActive` is ever returned.
 */
const ACTIVE_STATES: Record<string, boolean | null> = {
  [READER_ID]: true,
  [MANAGER_ID]: true,
  [NO_READ_ID]: true,
  [SUPER_ID]: true,
  [INACTIVE_ID]: false,
  [DELETED_ID]: null,
};

/** Build a REAL CASL ability from the granted tuples. */
function buildAbility(permissions: PermissionTuple[]): AppAbility {
  const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
  for (const [action, subject] of permissions) {
    can(action, subject);
  }
  return build();
}

// ---------------------------------------------------------------------------
// Persisted-row fixtures (all mapper invariants satisfied)
// ---------------------------------------------------------------------------

function utcDate(iso: string): Date {
  return new Date(iso);
}

const PENDING_ROW: HumanDecisionReviewRecord = {
  id: DECISION_ID,
  type: 'RESTOCK',
  status: 'PENDING',
  version: 1,
  createdAt: utcDate('2026-02-01T10:00:00.000Z'),
  branchId: 'branch-1',
  branchName: 'Sucursal Centro',
  productId: PRODUCT_ID,
  productName: 'Filtro de aceite',
  variantId: VARIANT_ID,
  sku: 'SKU-1',
  requestedQuantity: 3,
  observedStockAtRequest: 0,
  stockObservedAt: utcDate('2026-01-31T23:30:00.000Z'),
  resolutionAction: null,
  restockDays: null,
  resolvedAt: null,
  resolvedByActorId: null,
  resolvedByDisplayName: null,
};

const RESOLVED_POSITIVE_ROW: HumanDecisionReviewRecord = {
  ...PENDING_ROW,
  status: 'RESOLVED',
  version: 2,
  resolutionAction: 'PROVIDE_RESTOCK_ESTIMATE',
  restockDays: 7,
  resolvedAt: utcDate('2026-02-02T09:15:00.000Z'),
  resolvedByActorId: 'reviewer-1',
  resolvedByDisplayName: 'Ada Lovelace',
};

const RESOLVED_NEGATIVE_ROW: HumanDecisionReviewRecord = {
  ...PENDING_ROW,
  status: 'RESOLVED',
  version: 2,
  resolutionAction: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
  restockDays: null,
  resolvedAt: utcDate('2026-02-02T09:15:00.000Z'),
  resolvedByActorId: 'reviewer-1',
  resolvedByDisplayName: 'Ada Lovelace',
};

const EXPIRATION_PRODUCT_ID = '1b2c3d4e-5f60-4712-8a9b-0c1d2e3f4a5b';
const EXPIRATION_UNIT = 'UNIDAD';
const EXPIRATION_PENDING_ACTIONS = [
  'PROVIDE_EXPIRATION_TEXT',
  'REPORT_EXPIRATION_UNAVAILABLE',
];

/** EXPIRATION simple-product PENDING row: no SKU/stock keys, valid unit. */
const EXPIRATION_PENDING_ROW: HumanDecisionReviewRecord = {
  ...PENDING_ROW,
  type: 'EXPIRATION',
  productId: EXPIRATION_PRODUCT_ID,
  productName: 'Yogur natural',
  variantId: null,
  sku: null,
  requestedQuantity: null,
  observedStockAtRequest: null,
  stockObservedAt: null,
  productUnit: EXPIRATION_UNIT,
  variantName: null,
  variantOption: null,
  variantValue: null,
};

const EXPECTED_EXPIRATION_PENDING_PROJECTION = {
  id: DECISION_ID,
  type: 'EXPIRATION',
  title: 'Consulta de vencimiento',
  sanitizedSummary:
    'El chatbot solicitó información de vencimiento de un producto.',
  createdAt: '2026-02-01T10:00:00.000Z',
  snapshot: {
    branchId: 'branch-1',
    branchName: 'Sucursal Centro',
    productId: EXPIRATION_PRODUCT_ID,
    productName: 'Yogur natural',
    unit: EXPIRATION_UNIT,
    variantId: null,
    variantName: null,
    variantOption: null,
    variantValue: null,
  },
  status: 'PENDING',
  version: 1,
  resolution: null,
};

const EXPIRATION_SNAPSHOT_KEYS = [
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

const DEFAULT_PAGE: HumanDecisionReviewPage = {
  items: [PENDING_ROW],
  pageIndex0: 0,
  pageSize: 20,
  totalCount: 1,
  pageCount: 1,
};

const EXPECTED_PENDING_PROJECTION = {
  id: DECISION_ID,
  type: 'RESTOCK',
  title: 'Solicitud de reposición de stock',
  sanitizedSummary:
    'El chatbot solicitó una estimación de reposición de stock para un producto.',
  createdAt: '2026-02-01T10:00:00.000Z',
  snapshot: {
    branchId: 'branch-1',
    branchName: 'Sucursal Centro',
    productId: PRODUCT_ID,
    productName: 'Filtro de aceite',
    variantId: VARIANT_ID,
    sku: 'SKU-1',
    requestedQuantity: 3,
    observedStockAtRequest: 0,
    stockObservedAt: '2026-01-31T23:30:00.000Z',
  },
  status: 'PENDING',
  version: 1,
  resolution: null,
};

interface ErrorEnvelope {
  statusCode: number;
  code: string;
  message: string;
}

type ListArgs = Parameters<HumanDecisionReviewController['list']>;

describe('Human decision review HTTP contract (HD-04d1)', () => {
  let app: INestApplication;
  let cls: ClsService;
  let listPage: HumanDecisionReviewPage;
  let detailRecord: HumanDecisionReviewRecord | null;
  let listPending: jest.Mock<
    Promise<HumanDecisionReviewPage>,
    [HumanDecisionReviewListQuery]
  >;
  let listResolved: typeof listPending;
  let listAll: typeof listPending;
  let findById: jest.Mock<Promise<HumanDecisionReviewRecord | null>, [string]>;
  let createForUser: jest.Mock<Promise<AppAbility>, [string]>;
  let findUnique: jest.Mock<
    Promise<{ isActive: boolean } | null>,
    [{ where: { id: string }; select: { isActive: true } }]
  >;

  const http = () => request(app.getHttpServer() as import('node:http').Server);

  const list = (
    query = '?status=PENDING',
    token: string | null = TOKENS.reader,
  ) => {
    const builder = http().get(`${LIST_URL}${query}`);
    return token ? builder.set('Authorization', `Bearer ${token}`) : builder;
  };

  const detail = (id: string, token: string | null = TOKENS.reader) => {
    const builder = http().get(`${LIST_URL}/${id}`);
    return token ? builder.set('Authorization', `Bearer ${token}`) : builder;
  };

  beforeEach(async () => {
    listPage = DEFAULT_PAGE;
    detailRecord = PENDING_ROW;
    listPending = jest.fn<
      Promise<HumanDecisionReviewPage>,
      [HumanDecisionReviewListQuery]
    >();
    listResolved = jest.fn<
      Promise<HumanDecisionReviewPage>,
      [HumanDecisionReviewListQuery]
    >(() => Promise.resolve(listPage));
    listAll = jest.fn<
      Promise<HumanDecisionReviewPage>,
      [HumanDecisionReviewListQuery]
    >(() => Promise.resolve(listPage));
    findById = jest.fn<Promise<HumanDecisionReviewRecord | null>, [string]>();
    createForUser = jest.fn<Promise<AppAbility>, [string]>((userId: string) =>
      Promise.resolve(buildAbility(PERMISSIONS[userId] ?? [])),
    );
    findUnique = jest.fn<
      Promise<{ isActive: boolean } | null>,
      [{ where: { id: string }; select: { isActive: true } }]
    >((args) => {
      const state = ACTIVE_STATES[args.where.id];
      if (state === undefined || state === null) {
        return Promise.resolve(null);
      }
      return Promise.resolve({ isActive: state });
    });

    const moduleRef = await Test.createTestingModule({
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
      ],
      controllers: [HumanDecisionReviewController],
      providers: [
        HumanDecisionHttpFilter,
        JwtStrategy,
        JwtAuthGuard,
        TenantContextGuard,
        PermissionsGuard,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn(() => TEST_SECRET),
            get: jest.fn(() => TEST_SECRET),
          },
        },
        {
          provide: CaslAbilityFactory,
          useValue: { createForUser },
        },
        {
          provide: PrismaService,
          useValue: { user: { findUnique } },
        },
        {
          provide: HUMAN_DECISION_REVIEW_READ_REPOSITORY,
          useValue: { listPending, listResolved, listAll, findById },
        },
        {
          provide: HUMAN_DECISION_REVIEW_RESOLVE_REPOSITORY,
          useValue: { resolve: jest.fn() },
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
    // Mirror `main.ts`: sanitize malformed/primitive `/human-decisions` bodies
    // BEFORE Nest's default parser mounts them.
    installHumanDecisionBodyParser(app);
    await app.init();

    // Only boundary mocked: the read port. Its tenant resolution mirrors the
    // real adapter (`getTenantId()` throws without a CLS tenant) so the REAL
    // ALS + guard pipeline is still exercised.
    cls = app.get(ClsService);
    listPending.mockImplementation(() =>
      cls.get('tenantId')
        ? Promise.resolve(listPage)
        : Promise.reject(new HumanDecisionReviewReadError()),
    );
    findById.mockImplementation(() =>
      cls.get('tenantId')
        ? Promise.resolve(detailRecord)
        : Promise.reject(new HumanDecisionReviewReadError()),
    );
  });

  afterEach(async () => {
    await app.close();
  });

  describe('guard metadata and module wiring', () => {
    it('guards the controller with JwtAuthGuard, TenantContextGuard, HumanDecisionActiveReviewerGuard, PermissionsGuard in that order and the scoped filter', () => {
      const guards = (Reflect.getMetadata(
        GUARDS_METADATA,
        HumanDecisionReviewController,
      ) ?? []) as unknown[];
      const filters = (Reflect.getMetadata(
        EXCEPTION_FILTERS_METADATA,
        HumanDecisionReviewController,
      ) ?? []) as unknown[];

      expect(guards).toEqual([
        JwtAuthGuard,
        TenantContextGuard,
        HumanDecisionActiveReviewerGuard,
        PermissionsGuard,
      ]);
      expect(filters).toContain(HumanDecisionHttpFilter);
    });

    it('requires read:HumanDecision on both read handlers', () => {
      const listHandler = Object.getOwnPropertyDescriptor(
        HumanDecisionReviewController.prototype,
        'list',
      )?.value as () => void;
      const detailHandler = Object.getOwnPropertyDescriptor(
        HumanDecisionReviewController.prototype,
        'detail',
      )?.value as () => void;

      expect(Reflect.getMetadata(PERMISSIONS_KEY, listHandler)).toEqual([
        ['read', 'HumanDecision'],
      ]);
      expect(Reflect.getMetadata(PERMISSIONS_KEY, detailHandler)).toEqual([
        ['read', 'HumanDecision'],
      ]);
    });

    it('registers both controllers, imports AuthModule and binds the read AND resolve ports to their Prisma adapters', () => {
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

      expect(controllers).toContain(BotRestockIntakeController);
      expect(controllers).toContain(HumanDecisionReviewController);
      expect(imports).toContain(ChatbotApiModule);
      expect(imports).toContain(DatabaseModule);
      expect(imports).toContain(AuthModule);

      // Bot route/guard binding preserved.
      const chatbotExports = (Reflect.getMetadata(
        MODULE_METADATA.EXPORTS,
        ChatbotApiModule,
      ) ?? []) as unknown[];
      expect(chatbotExports).toContain(ServiceAuthGuard);
      expect(chatbotExports).toContain(SERVICE_CREDENTIAL_REPOSITORY);

      const intakeBinding = providers.find(
        (provider) => provider?.provide === RESTOCK_INTAKE_REPOSITORY,
      );
      expect(intakeBinding?.useClass).toBe(PrismaRestockIntakeRepository);

      const readBinding = providers.find(
        (provider) =>
          provider?.provide === HUMAN_DECISION_REVIEW_READ_REPOSITORY,
      );
      expect(readBinding?.useClass).toBe(
        PrismaHumanDecisionReviewReadRepository,
      );

      // HD-04d2a binds the resolve port to its real Prisma adapter.
      const resolveBinding = providers.find(
        (provider) =>
          provider?.provide === HUMAN_DECISION_REVIEW_RESOLVE_REPOSITORY,
      );
      expect(resolveBinding?.useClass).toBe(
        PrismaHumanDecisionReviewResolveRepository,
      );
    });

    it('requires update:HumanDecision and POST 200 on the resolve handler', () => {
      const resolveHandler = Object.getOwnPropertyDescriptor(
        HumanDecisionReviewController.prototype,
        'resolve',
      )?.value as () => void;

      expect(Reflect.getMetadata(PERMISSIONS_KEY, resolveHandler)).toEqual([
        ['update', 'HumanDecision'],
      ]);
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, resolveHandler)).toBe(200);
      expect(Reflect.getMetadata(METHOD_METADATA, resolveHandler)).toBe(
        RequestMethod.POST,
      );
      expect(Reflect.getMetadata(PATH_METADATA, resolveHandler)).toBe(
        ':id/resolve',
      );
    });
  });

  describe('authentication (401)', () => {
    it.each([
      ['a missing bearer token', null],
      ['an invalid token', 'not-a-valid-jwt'],
    ])(
      'rejects %s with a sanitized 401 and never touches the read port',
      async (_label, token) => {
        const res = await list('?status=PENDING', token).expect(401);
        const body = res.body as ErrorEnvelope;

        expect(body).toEqual({
          statusCode: 401,
          code: 'UNAUTHORIZED',
          message: 'Unauthorized',
        });
        expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
        expect(listPending).not.toHaveBeenCalled();
        expect(findById).not.toHaveBeenCalled();
        expect(findUnique).not.toHaveBeenCalled();
      },
    );

    it('rejects a valid token on the detail route only when the signature is broken', async () => {
      const res = await detail(DECISION_ID, 'broken.token.value').expect(401);
      expect((res.body as ErrorEnvelope).code).toBe('UNAUTHORIZED');
      expect(findById).not.toHaveBeenCalled();
      expect(findUnique).not.toHaveBeenCalled();
    });
  });

  describe('active reviewer admission (revoked account)', () => {
    it.each([
      { label: 'an inactive', token: TOKENS.inactive, userId: INACTIVE_ID },
      { label: 'a deleted', token: TOKENS.deleted, userId: DELETED_ID },
    ])(
      'rejects $label reviewer JWT on list AND detail with a sanitized 401 before the read port',
      async ({ token, userId }) => {
        const listRes = await list('?status=PENDING', token).expect(401);
        const listBody = listRes.body as ErrorEnvelope;

        expect(listBody).toEqual({
          statusCode: 401,
          code: 'UNAUTHORIZED',
          message: 'Unauthorized',
        });
        expect(Object.keys(listBody).sort()).toEqual(EXPECTED_ERROR_KEYS);

        const detailRes = await detail(DECISION_ID, token).expect(401);
        expect(detailRes.body).toEqual({
          statusCode: 401,
          code: 'UNAUTHORIZED',
          message: 'Unauthorized',
        });

        expect(findUnique).toHaveBeenCalledTimes(2);
        expect(findUnique).toHaveBeenCalledWith({
          where: { id: userId },
          select: { isActive: true },
        });
        expect(listPending).not.toHaveBeenCalled();
        expect(findById).not.toHaveBeenCalled();
        expect(JSON.stringify(listBody)).not.toContain(userId);
      },
    );

    it('lets an active reviewer through and reads only isActive', async () => {
      const res = await list('?status=PENDING', TOKENS.reader).expect(200);

      expect(findUnique).toHaveBeenCalledWith({
        where: { id: READER_ID },
        select: { isActive: true },
      });
      expect(listPending).toHaveBeenCalledTimes(1);
      expect((res.body as { data: unknown[] }).data).toHaveLength(1);
    });
  });

  describe('authorization (403)', () => {
    it.each([
      ['list', () => list('?status=PENDING', TOKENS.noRead)],
      ['detail', () => detail(DECISION_ID, TOKENS.noRead)],
    ])(
      'rejects %s without read:HumanDecision with a sanitized 403',
      async (_label, call) => {
        const res = await call().expect(403);
        const body = res.body as ErrorEnvelope;

        expect(body).toEqual({
          statusCode: 403,
          code: 'FORBIDDEN',
          message: 'Forbidden',
        });
        expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
        expect(listPending).not.toHaveBeenCalled();
        expect(findById).not.toHaveBeenCalled();
      },
    );

    it('fails closed when PermissionsGuard did not attach request.ability', async () => {
      const controller = app.get(HumanDecisionReviewController);

      await expect(
        controller.list(
          { page: 1, limit: 20 } as ListArgs[0],
          {
            user: { tenantId: 'tenant-1' },
          } as unknown as ListArgs[1],
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(listPending).not.toHaveBeenCalled();
    });
  });

  describe('list contract (GET /human-decisions)', () => {
    it('returns the exact { data, pagination } envelope for a read-only reviewer', async () => {
      const res = await list().expect(200);
      const body = res.body as Record<string, unknown>;

      expect(Object.keys(body).sort()).toEqual(['data', 'pagination']);
      expect(body.pagination).toEqual({
        pageIndex: 0,
        pageSize: 20,
        totalCount: 1,
        pageCount: 1,
      });
      expect(body.pagination as object).toEqual({
        pageIndex: 0,
        pageSize: 20,
        totalCount: 1,
        pageCount: 1,
      });

      const data = body.data as Array<Record<string, unknown>>;
      expect(data).toHaveLength(1);
      expect(data[0]).toEqual({
        ...EXPECTED_PENDING_PROJECTION,
        allowedActions: [],
      });
      expect(Object.keys(data[0]).sort()).toEqual([
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
      ]);

      expect(listPending).toHaveBeenCalledTimes(1);
      expect(listPending.mock.calls[0][0]).toEqual({
        page: 1,
        limit: 20,
        search: undefined,
      });
      expect(findUnique).toHaveBeenCalledWith({
        where: { id: READER_ID },
        select: { isActive: true },
      });
    });

    it('derives the exact two ordered actions for a manager', async () => {
      const res = await list('?status=PENDING', TOKENS.manager).expect(200);
      const body = res.body as { data: Array<Record<string, unknown>> };

      expect(body.data[0].allowedActions).toEqual(PENDING_ACTIONS);
    });

    it('forwards ONLY page/limit/search and maps pageIndex0 -> pageIndex', async () => {
      listPage = {
        items: [PENDING_ROW],
        pageIndex0: 2,
        pageSize: 50,
        totalCount: 101,
        pageCount: 3,
      };

      const res = await list(
        '?status=PENDING&page=3&limit=50&sortBy=createdAt&sortOrder=asc&search=Filtro',
      ).expect(200);

      expect(listPending).toHaveBeenCalledTimes(1);
      expect(listPending.mock.calls[0][0]).toEqual({
        page: 3,
        limit: 50,
        search: 'Filtro',
      });
      const body = res.body as { pagination: Record<string, unknown> };
      expect(body.pagination).toEqual({
        pageIndex: 2,
        pageSize: 50,
        totalCount: 101,
        pageCount: 3,
      });
    });

    it('forwards the raw search term without escaping LIKE wildcards', async () => {
      await list('?status=PENDING&search=%25_foo').expect(200);

      expect(listPending.mock.calls[0][0]).toEqual({
        page: 1,
        limit: 20,
        search: '%_foo',
      });
    });

    it('never leaks bot-only/authority/PII fields', async () => {
      const res = await list('?status=PENDING', TOKENS.manager).expect(200);
      const serialized = JSON.stringify(res.body);

      for (const key of FORBIDDEN_KEYS) {
        expect(res.body).not.toHaveProperty(key);
      }
      expect(serialized).not.toContain('houndfe-chatbot');
      expect(serialized).not.toContain('canonicalRequestHash');
      expect(serialized).not.toContain('tenant-1');
    });

    it('fails closed with a sanitized 500 when the port returns a non-PENDING row', async () => {
      listPage = {
        items: [RESOLVED_POSITIVE_ROW],
        pageIndex0: 0,
        pageSize: 20,
        totalCount: 1,
        pageCount: 1,
      };

      const res = await list().expect(500);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      });
      expect(JSON.stringify(body)).not.toContain('RESOLVED');
      expect(body).not.toHaveProperty('data');
    });
  });

  describe('combined list', () => {
    it.each([TOKENS.reader, TOKENS.manager])(
      'returns a safe mixed global page for reviewer %#',
      async (token) => {
        listPage = {
          items: [PENDING_ROW, RESOLVED_POSITIVE_ROW, RESOLVED_NEGATIVE_ROW],
          pageIndex0: 1,
          pageSize: 20,
          totalCount: 23,
          pageCount: 2,
        };
        const res = await list(
          '?status=ALL&page=2&search=Filtro',
          token,
        ).expect(200);
        const expected: unknown[] = [];
        for (const row of listPage.items) {
          detailRecord = row;
          const result = await detail(DECISION_ID, token).expect(200);
          expected.push(result.body as unknown);
        }
        expect(res.body).toEqual({
          data: expected,
          pagination: {
            pageIndex: 1,
            pageSize: 20,
            totalCount: 23,
            pageCount: 2,
          },
        });
        expect(listAll).toHaveBeenCalledWith({
          page: 2,
          limit: 20,
          search: 'Filtro',
        });
        expect(listPending).not.toHaveBeenCalled();
        expect(listResolved).not.toHaveBeenCalled();
      },
    );
    it.each([
      'sortBy=',
      'sortBy=createdAt',
      'sortOrder=desc',
      'sortOrder=asc&sortOrder=desc',
    ])('rejects explicit ALL sort %s', async (sort) => {
      await list(`?status=ALL&${sort}`).expect(400);
      expect(listAll).not.toHaveBeenCalled();
    });
    it('rejects a persisted ALL row instead of widening the row union', async () => {
      listPage = {
        ...DEFAULT_PAGE,
        items: [{ ...PENDING_ROW, status: 'ALL' }],
      };
      const res = await list('?status=ALL').expect(500);
      expect(res.body).toEqual({
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      });
    });
  });

  describe('recent resolved list', () => {
    it.each([TOKENS.reader, TOKENS.manager])(
      'returns both safe resolutions without actions for reviewer %#',
      async (token) => {
        listPage = {
          ...DEFAULT_PAGE,
          items: [RESOLVED_POSITIVE_ROW, RESOLVED_NEGATIVE_ROW],
          totalCount: 2,
        };
        const res = await list('?status=RESOLVED', token).expect(200);
        const expected = (row: HumanDecisionReviewRecord) => ({
          ...EXPECTED_PENDING_PROJECTION,
          status: 'RESOLVED',
          version: 2,
          allowedActions: [],
          resolution: {
            action: row.resolutionAction,
            ...(row.restockDays === null
              ? {}
              : { restockDays: row.restockDays }),
            resolvedAt: '2026-02-02T09:15:00.000Z',
            resolvedBy: { id: 'reviewer-1', displayName: 'Ada Lovelace' },
          },
        });
        expect(res.body).toEqual({
          data: [
            expected(RESOLVED_POSITIVE_ROW),
            expected(RESOLVED_NEGATIVE_ROW),
          ],
          pagination: {
            pageIndex: 0,
            pageSize: 20,
            totalCount: 2,
            pageCount: 1,
          },
        });
        expect(listResolved).toHaveBeenCalledWith({
          page: 1,
          limit: 20,
          search: undefined,
        });
        expect(listPending).not.toHaveBeenCalled();
      },
    );

    it('keeps paging independent and forwards normalized literal search only', async () => {
      listPage = {
        items: [],
        pageIndex0: 1,
        pageSize: 50,
        totalCount: 51,
        pageCount: 2,
      };
      const res = await list(
        '?status=RESOLVED&page=2&limit=50&sortBy=resolvedAt&sortOrder=desc&search=%20Cafe%25_%20',
      ).expect(200);
      expect(res.body).toEqual({
        data: [],
        pagination: {
          pageIndex: 1,
          pageSize: 50,
          totalCount: 51,
          pageCount: 2,
        },
      });
      expect(listResolved).toHaveBeenCalledWith({
        page: 2,
        limit: 50,
        search: 'Cafe%_',
      });
      listPage = DEFAULT_PAGE;
      await list().expect(200);
      expect(listPending).toHaveBeenCalledWith({
        page: 1,
        limit: 20,
        search: undefined,
      });
    });

    it('fails closed when a resolved query returns a pending row', async () => {
      const res = await list('?status=RESOLVED').expect(500);
      expect(res.body).toEqual({
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      });
    });
  });

  describe('list query constraints (sanitized 400)', () => {
    it.each([
      ['a missing status', ''],
      ['an invalid status', '?status=CLOSED'],
      ['a conflicting resolved field', '?status=RESOLVED&sortBy=createdAt'],
      ['a conflicting resolved direction', '?status=RESOLVED&sortOrder=asc'],
      ['a client date window', '?status=RESOLVED&from=2026-01-01'],
      ['an unknown status', '?status=UNKNOWN'],
      ['an unwhitelisted limit', '?status=PENDING&limit=999'],
      ['a non-numeric page', '?status=PENDING&page=abc'],
      ['a float page', '?status=PENDING&page=1.5'],
      ['an exponent page', '?status=PENDING&page=1e0'],
      ['a negative page', '?status=PENDING&page=-1'],
      ['a zero page', '?status=PENDING&page=0'],
      ['an unknown sort field', '?status=PENDING&sortBy=updatedAt'],
      ['a descending sort', '?status=PENDING&sortOrder=desc'],
      ['an explicit blank search', '?status=PENDING&search='],
      ['a client tenant override', '?status=PENDING&tenantId=evil-tenant'],
      ['an unknown extra key', '?status=PENDING&evil=1'],
    ])(
      'rejects %s with the exact 3-key envelope and no value leak',
      async (_label, query) => {
        const res = await list(query).expect(400);
        const body = res.body as ErrorEnvelope;

        expect(body).toEqual({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
        });
        expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
        const serialized = JSON.stringify(body);
        expect(serialized).not.toContain('evil');
        expect(serialized).not.toContain('updatedAt');
        expect(body).not.toHaveProperty('error');
        expect(body).not.toHaveProperty('timestamp');
        expect(listPending).not.toHaveBeenCalled();
      },
    );

    it('never echoes a PII-bearing rejected term', async () => {
      const res = await list(
        '?status=PENDING&tenantId=customer-5491100000000',
      ).expect(400);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
      });
      expect(JSON.stringify(body)).not.toContain('5491100000000');
    });
  });

  describe('detail contract (GET /human-decisions/:id)', () => {
    it('returns the exact PENDING projection with capability actions', async () => {
      detailRecord = PENDING_ROW;

      const res = await detail(DECISION_ID, TOKENS.manager).expect(200);

      expect(res.body).toEqual({
        ...EXPECTED_PENDING_PROJECTION,
        allowedActions: PENDING_ACTIONS,
      });
      expect(findById).toHaveBeenCalledTimes(1);
      expect(findById.mock.calls[0][0]).toBe(DECISION_ID);
    });

    it('returns the durable RESOLVED positive snapshot', async () => {
      detailRecord = RESOLVED_POSITIVE_ROW;

      const res = await detail(DECISION_ID, TOKENS.reader).expect(200);
      const body = res.body as Record<string, unknown>;

      expect(body.status).toBe('RESOLVED');
      expect(body.version).toBe(2);
      expect(body.allowedActions).toEqual([]);
      expect(body.resolution).toEqual({
        action: 'PROVIDE_RESTOCK_ESTIMATE',
        restockDays: 7,
        resolvedAt: '2026-02-02T09:15:00.000Z',
        resolvedBy: { id: 'reviewer-1', displayName: 'Ada Lovelace' },
      });
    });

    it('omits restockDays entirely for the negative action and never reports a negative days value', async () => {
      detailRecord = RESOLVED_NEGATIVE_ROW;

      const res = await detail(DECISION_ID, TOKENS.manager).expect(200);
      const body = res.body as {
        resolution: Record<string, unknown>;
        allowedActions: unknown;
      };
      const resolution = body.resolution;

      expect(resolution).toEqual({
        action: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
        resolvedAt: '2026-02-02T09:15:00.000Z',
        resolvedBy: { id: 'reviewer-1', displayName: 'Ada Lovelace' },
      });
      expect(resolution).not.toHaveProperty('restockDays');
      expect(Object.keys(resolution).sort()).toEqual([
        'action',
        'resolvedAt',
        'resolvedBy',
      ]);
      expect(body.allowedActions).toEqual([]);
    });

    it('returns a sanitized 404 for a missing OR cross-tenant id', async () => {
      detailRecord = null;

      const res = await detail(DECISION_ID).expect(404);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 404,
        code: 'NOT_FOUND',
        message: 'Not found',
      });
      expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
      expect(JSON.stringify(body)).not.toContain(DECISION_ID);
    });

    it('rejects a malformed id with a sanitized 400 before the read port', async () => {
      const res = await detail('5491100000000').expect(400);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
      });
      expect(JSON.stringify(body)).not.toContain('5491100000000');
      expect(findById).not.toHaveBeenCalled();
    });

    it('sanitizes a read-port failure to a 500 with no upstream message', async () => {
      findById.mockRejectedValueOnce(new Error('pg password leaked: hunter2'));

      const res = await detail(DECISION_ID).expect(500);
      const body = res.body as Record<string, unknown>;

      expect(body).toEqual({
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      });
      expect(JSON.stringify(body)).not.toContain('hunter2');
      expect(body).not.toHaveProperty('timestamp');
    });

    it('never leaks bot-only/authority fields on the detail projection', async () => {
      detailRecord = RESOLVED_POSITIVE_ROW;

      const res = await detail(DECISION_ID).expect(200);
      const serialized = JSON.stringify(res.body);

      for (const key of FORBIDDEN_KEYS) {
        expect(res.body).not.toHaveProperty(key);
      }
      expect(serialized).not.toContain('houndfe-chatbot');
      expect(serialized).not.toContain('canonicalRequestHash');
      expect(serialized).not.toContain('tenant-1');
    });

    it('returns the exact EXPIRATION PENDING projection through the real guard pipeline', async () => {
      detailRecord = EXPIRATION_PENDING_ROW;

      const res = await detail(DECISION_ID, TOKENS.manager).expect(200);
      const body = res.body as { snapshot: Record<string, unknown> };

      expect(res.body).toEqual({
        ...EXPECTED_EXPIRATION_PENDING_PROJECTION,
        allowedActions: EXPIRATION_PENDING_ACTIONS,
      });
      expect(Object.keys(body.snapshot).sort()).toEqual(
        EXPIRATION_SNAPSHOT_KEYS,
      );
      // No RESTOCK key bleeds into the EXPIRATION snapshot and no server column
      // (productUnit / tenantId / source) is ever renamed onto the wire.
      expect(body.snapshot).not.toHaveProperty('sku');
      expect(body.snapshot).not.toHaveProperty('productUnit');
      for (const key of FORBIDDEN_KEYS) {
        expect(res.body).not.toHaveProperty(key);
      }
      expect(findUnique).toHaveBeenCalledWith({
        where: { id: MANAGER_ID },
        select: { isActive: true },
      });
      expect(findById).toHaveBeenCalledTimes(1);
      expect(findById.mock.calls[0][0]).toBe(DECISION_ID);
    });

    it('lists a mixed RESTOCK + EXPIRATION page through the ALL policy without widening either projection', async () => {
      listPage = {
        items: [PENDING_ROW, EXPIRATION_PENDING_ROW],
        pageIndex0: 0,
        pageSize: 20,
        totalCount: 2,
        pageCount: 1,
      };

      const res = await list('?status=ALL', TOKENS.reader).expect(200);
      const data = (res.body as { data: Array<Record<string, unknown>> }).data;

      expect(data).toHaveLength(2);
      expect(data[0]).toMatchObject({ type: 'RESTOCK' });
      expect(data[1]).toMatchObject({
        type: 'EXPIRATION',
        allowedActions: [],
      });
      expect(listAll).toHaveBeenCalledWith({
        page: 1,
        limit: 20,
        search: undefined,
      });
      expect(listPending).not.toHaveBeenCalled();
      expect(listResolved).not.toHaveBeenCalled();
      for (const key of FORBIDDEN_KEYS) {
        expect(data[1]).not.toHaveProperty(key);
      }
      expect(JSON.stringify(res.body)).not.toContain('tenant-1');
    });
  });

  describe('malformed body parser is route-scoped and sanitized', () => {
    it('keeps the Nest default global body parsers mounted alongside the scoped ones', () => {
      // Guards the regression this helper could introduce: an unrenamed
      // route-scoped parser would make Nest's `isMiddlewareApplied` skip the
      // global defaults, silently disabling body parsing for every other
      // route. Both global parsers must still be present.
      const instance = app.getHttpAdapter().getInstance() as {
        router: { stack: Array<{ handle?: { name?: string } }> };
      };
      const parserNames = instance.router.stack
        .map((layer) => layer.handle?.name)
        .filter((name) => name === 'jsonParser' || name === 'urlencodedParser');

      expect(parserNames).toEqual(['jsonParser', 'urlencodedParser']);
    });

    it('answers a malformed JSON body on the GET list route with the fixed 400 envelope before the read port', async () => {
      const res = await http()
        .get(LIST_URL)
        .set('Authorization', `Bearer ${TOKENS.reader}`)
        .set('Content-Type', 'application/json')
        .send('{"status":"SENTINEL"')
        .expect(400);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
      });
      expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
      expect(JSON.stringify(body)).not.toContain('SENTINEL');
      expect(listPending).not.toHaveBeenCalled();
      expect(findById).not.toHaveBeenCalled();
    });
  });

  describe('tenantless authenticated superadmin fails closed with 403', () => {
    it('rejects a tenantless superadmin on list with the exact 403 envelope before the read port', async () => {
      // PermissionsGuard grants manage:all, so only the controller tenant gate
      // can stop the request from reaching the (real) tenant-scoped read port.
      const res = await list('?status=PENDING', TOKENS.super).expect(403);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 403,
        code: 'FORBIDDEN',
        message: 'Forbidden',
      });
      expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
      // The guard rejects the tenantless principal BEFORE any DB lookup, the
      // CASL build or the read port.
      expect(findUnique).not.toHaveBeenCalled();
      expect(createForUser).not.toHaveBeenCalled();
      expect(listPending).not.toHaveBeenCalled();
      expect(body).not.toHaveProperty('data');
      expect(JSON.stringify(body)).not.toContain('tenant-1');
    });

    it('rejects a tenantless superadmin on detail with the exact 403 envelope before the read port', async () => {
      const res = await detail(DECISION_ID, TOKENS.super).expect(403);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 403,
        code: 'FORBIDDEN',
        message: 'Forbidden',
      });
      expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
      expect(findUnique).not.toHaveBeenCalled();
      expect(createForUser).not.toHaveBeenCalled();
      expect(findById).not.toHaveBeenCalled();
      expect(JSON.stringify(body)).not.toContain(DECISION_ID);
    });

    it('keeps a tenant-bearing superadmin token unaffected', async () => {
      const res = await list('?status=PENDING', TOKENS.superWithTenant).expect(
        200,
      );

      expect(listPending).toHaveBeenCalledTimes(1);
      const body = res.body as { data: Array<Record<string, unknown>> };
      expect(body.data[0]).toEqual({
        ...EXPECTED_PENDING_PROJECTION,
        allowedActions: PENDING_ACTIONS,
      });
    });
  });
});
