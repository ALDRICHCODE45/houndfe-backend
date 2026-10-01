/**
 * HD-04d2a — HTTP contract for the guarded HUMAN reviewer WRITE route.
 *
 *   POST /human-decisions/:id/resolve
 *
 * In-memory Nest app + Supertest (`app.init()`, NO listen port, NO DB): the
 * REAL `JwtStrategy` + `JwtAuthGuard`, REAL `TenantContextGuard`, REAL
 * `HumanDecisionActiveReviewerGuard`, REAL `PermissionsGuard`, a REAL
 * nestjs-cls ALS store and the REAL controller-scoped `HumanDecisionHttpFilter`
 * over MOCKED read/resolve ports. The global
 * `ValidationPipe`/`DomainExceptionFilter`/`PrismaExceptionFilter` mirror
 * `main.ts` so the scoped filter's precedence is exercised, not assumed.
 *
 * Three data/authorization seams are mocked: `PrismaService.user.findUnique`
 * (active-account admission), `CaslAbilityFactory.createForUser` (returns real
 * CASL abilities, but does not query stored role grants), and the resolve port
 * (the actual CAS is HD-04c3/HD-04d2b territory). JWT verification, the ALS
 * request scope, guard ORDER, the exact pure body parser and the scoped filter
 * are REAL here.
 *
 * WHY THIS SPEC EXISTS (the wiring risk): the HD-04c2 resolve adapter TRUSTS
 * `actorUserId`/`actorIsSuperAdmin`; it is only a privilege boundary once the
 * route derives those exclusively from the verified JWT and runs the exact
 * HD-04c1 parser on the untrusted body. This spec proves that seam at the
 * transport level: a spoofed body never reaches the port, the command actor is
 * the JWT subject, the negative command OMITS `restockDays`, and BOTH a first
 * resolve and an idempotent replay answer `200` with the same immutable
 * projection and no extra write.
 *
 * Deliberately NOT proven here (HD-04d2b): real PostgreSQL one-winner CAS, the
 * real tenant-scoping extension and real role-grant persistence.
 *
 * Deliberately NOT booted: `HumanDecisionsModule`/`AppModule` (transitive
 * Inngest/mail/provider registrars). Module wiring is asserted via metadata.
 */
import {
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
import { ChatbotApiModule } from '../../chatbot-api/chatbot-api.module';
import { DomainExceptionFilter } from '../../shared/filters/domain-exception.filter';
import { PrismaExceptionFilter } from '../../shared/filters/prisma-exception.filter';
import { createListingValidationExceptionFactory } from '../../shared/listing/listing-validation-exception.factory';
import { DatabaseModule } from '../../shared/prisma/prisma.module';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import {
  HUMAN_DECISION_REVIEW_READ_REPOSITORY,
  type HumanDecisionReviewRecord,
} from '../domain/human-decision-review-read.repository';
import {
  HUMAN_DECISION_REVIEW_RESOLVE_REPOSITORY,
  HumanDecisionReviewResolveError,
  type HumanDecisionReviewResolveResult,
  type ResolveHumanDecisionCommand,
} from '../domain/human-decision-review-resolve.repository';
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

const TEST_SECRET = 'hd-04d2a-test-secret-not-a-production-key';
const URL = '/human-decisions';

/** Allowlisted browser FE origin wired into the test app's CORS config. */
const ALLOWED_ORIGIN = 'https://allowed.hd04d2a.test';

const DECISION_ID = '2b7c1a90-6f3e-4d2a-8b1c-0d9e8f7a6b5c';
const RESOLUTION_REQUEST_ID = '3f1c1b7a-9c2e-4d5f-8a6b-1c2d3e4f5a6b';
const PRODUCT_ID = '8f14e45f-ceea-4e42-9f62-1a2b3c4d5e6f';
const VARIANT_ID = '550e8400-e29b-41d4-a716-446655440000';

const EXPECTED_ERROR_KEYS = ['code', 'message', 'statusCode'];

const POSITIVE_ACTION = 'PROVIDE_RESTOCK_ESTIMATE';
const NEGATIVE_ACTION = 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE';

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
  'ackReceivedAt',
  'pii',
  'customerPhone',
];

/** Well-formed positive body (exact key set). */
const VALID_POSITIVE_BODY = {
  action: POSITIVE_ACTION,
  restockDays: 7,
  expectedVersion: 1,
  resolutionRequestId: RESOLUTION_REQUEST_ID,
} as const;

/** Well-formed negative body; `restockDays` is deliberately ABSENT. */
const VALID_NEGATIVE_BODY = {
  action: NEGATIVE_ACTION,
  expectedVersion: 1,
  resolutionRequestId: RESOLUTION_REQUEST_ID,
} as const;

const EXP_POSITIVE_ACTION = 'PROVIDE_EXPIRATION_TEXT';
const EXP_NEGATIVE_ACTION = 'REPORT_EXPIRATION_UNAVAILABLE';
const EXPIRATION_UNIT = 'UNIDAD';

/** Well-formed EXP positive body; `expirationText` is deliberately untrimmed. */
const VALID_EXP_POSITIVE_BODY = {
  action: EXP_POSITIVE_ACTION,
  expirationText: '  Vence   el 2026-05  ',
  expectedVersion: 1,
  resolutionRequestId: RESOLUTION_REQUEST_ID,
} as const;

/** Text the EXP parser must normalize the untrimmed body to. */
const NORMALIZED_EXPIRATION_TEXT = 'Vence el 2026-05';

/** Well-formed EXP negative body; `expirationText` is deliberately ABSENT. */
const VALID_EXP_NEGATIVE_BODY = {
  action: EXP_NEGATIVE_ACTION,
  expectedVersion: 1,
  resolutionRequestId: RESOLUTION_REQUEST_ID,
} as const;

/** Exact EXPIRATION projection top-level keys. */
const EXPECTED_EXP_TOP_LEVEL_KEYS = [
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

/** RESTOCK-only keys that must NEVER appear on an EXPIRATION resolve projection. */
const EXP_FORBIDDEN_KEYS = [
  'restockDays',
  'sku',
  'requestedQuantity',
  'observedStockAtRequest',
  'stockObservedAt',
  'productUnit',
];

// ---------------------------------------------------------------------------
// Principal fixtures + real CASL abilities
// ---------------------------------------------------------------------------

type PermissionTuple = [AppActions, AppSubjects];

const READER_ID = 'user-reader';
const MANAGER_ID = 'user-manager';
const NO_UPDATE_ID = 'user-no-update';
const SUPER_ID = 'user-super-admin';
const INACTIVE_ID = 'user-inactive';
const DELETED_ID = 'user-deleted';

const PERMISSIONS: Record<string, PermissionTuple[]> = {
  [READER_ID]: [['read', 'HumanDecision']],
  [MANAGER_ID]: [
    ['read', 'HumanDecision'],
    ['update', 'HumanDecision'],
  ],
  [NO_UPDATE_ID]: [['read', 'HumanDecision']],
  [SUPER_ID]: [['manage', 'all']],
  [INACTIVE_ID]: [
    ['read', 'HumanDecision'],
    ['update', 'HumanDecision'],
  ],
  [DELETED_ID]: [
    ['read', 'HumanDecision'],
    ['update', 'HumanDecision'],
  ],
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
  noUpdate: {
    sub: NO_UPDATE_ID,
    email: 'no-update@houndfe.test',
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
  noUpdate: jwtService.sign(USERS.noUpdate),
  super: jwtService.sign(USERS.super),
  superWithTenant: jwtService.sign(USERS.superWithTenant),
  inactive: jwtService.sign(USERS.inactive),
  deleted: jwtService.sign(USERS.deleted),
};

/**
 * Current-account state read by the active-reviewer guard: `true` active,
 * `false` deactivated, `null`/absent deleted. Only `isActive` is returned.
 */
const ACTIVE_STATES: Record<string, boolean | null> = {
  [READER_ID]: true,
  [MANAGER_ID]: true,
  [NO_UPDATE_ID]: true,
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

/** Simple-product EXPIRATION row (variant columns intentionally null). */
const EXP_PENDING_ROW: HumanDecisionReviewRecord = {
  ...PENDING_ROW,
  type: 'EXPIRATION',
  productUnit: EXPIRATION_UNIT,
  variantId: null,
  variantName: null,
  variantOption: null,
  variantValue: null,
  expirationText: null,
};

const RESOLVED_EXP_POSITIVE_ROW: HumanDecisionReviewRecord = {
  ...EXP_PENDING_ROW,
  status: 'RESOLVED',
  version: 2,
  resolutionAction: EXP_POSITIVE_ACTION,
  expirationText: NORMALIZED_EXPIRATION_TEXT,
  resolvedAt: utcDate('2026-02-02T09:15:00.000Z'),
  resolvedByActorId: 'reviewer-1',
  resolvedByDisplayName: 'Ada Lovelace',
};

const RESOLVED_EXP_NEGATIVE_ROW: HumanDecisionReviewRecord = {
  ...EXP_PENDING_ROW,
  status: 'RESOLVED',
  version: 2,
  resolutionAction: EXP_NEGATIVE_ACTION,
  expirationText: null,
  resolvedAt: utcDate('2026-02-02T09:15:00.000Z'),
  resolvedByActorId: 'reviewer-1',
  resolvedByDisplayName: 'Ada Lovelace',
};

/** Exact resolved projection, pinned as a literal (not derived from the mapper). */
const EXPECTED_RESOLVED_POSITIVE = {
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
  status: 'RESOLVED',
  version: 2,
  resolution: {
    action: 'PROVIDE_RESTOCK_ESTIMATE',
    restockDays: 7,
    resolvedAt: '2026-02-02T09:15:00.000Z',
    resolvedBy: { id: 'reviewer-1', displayName: 'Ada Lovelace' },
  },
  allowedActions: [],
};

const EXPECTED_RESOLVED_NEGATIVE = {
  ...EXPECTED_RESOLVED_POSITIVE,
  resolution: {
    action: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
    resolvedAt: '2026-02-02T09:15:00.000Z',
    resolvedBy: { id: 'reviewer-1', displayName: 'Ada Lovelace' },
  },
};

const EXPECTED_EXP_RESOLVED_POSITIVE = {
  id: DECISION_ID,
  type: 'EXPIRATION',
  title: 'Consulta de vencimiento',
  sanitizedSummary:
    'El chatbot solicitó información de vencimiento de un producto.',
  createdAt: '2026-02-01T10:00:00.000Z',
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
  status: 'RESOLVED',
  version: 2,
  resolution: {
    action: EXP_POSITIVE_ACTION,
    expirationText: NORMALIZED_EXPIRATION_TEXT,
    resolvedAt: '2026-02-02T09:15:00.000Z',
    resolvedBy: { id: 'reviewer-1', displayName: 'Ada Lovelace' },
  },
  allowedActions: [],
};

const EXPECTED_EXP_RESOLVED_NEGATIVE = {
  ...EXPECTED_EXP_RESOLVED_POSITIVE,
  resolution: {
    action: EXP_NEGATIVE_ACTION,
    resolvedAt: '2026-02-02T09:15:00.000Z',
    resolvedBy: { id: 'reviewer-1', displayName: 'Ada Lovelace' },
  },
};

interface ErrorEnvelope {
  statusCode: number;
  code: string;
  message: string;
}

describe('Human decision resolve HTTP contract (HD-04d2a)', () => {
  let app: INestApplication;
  let createForUser: jest.Mock<
    Promise<AppAbility>,
    [string, { tenantId: string | null; isSuperAdmin: boolean }]
  >;
  let findUnique: jest.Mock<
    Promise<{ isActive: boolean } | null>,
    [{ where: { id: string }; select: { isActive: true } }]
  >;
  let resolveMock: jest.Mock<
    Promise<HumanDecisionReviewResolveResult>,
    [ResolveHumanDecisionCommand]
  >;

  const http = () => request(app.getHttpServer() as import('node:http').Server);

  const resolveUrl = (id: string = DECISION_ID) => `${URL}/${id}/resolve`;

  const postResolve = (
    body: unknown,
    id: string = DECISION_ID,
    token: string | null = TOKENS.manager,
  ) => {
    const builder = http().post(resolveUrl(id));
    return token
      ? builder.set('Authorization', `Bearer ${token}`).send(body as object)
      : builder.send(body as object);
  };

  beforeEach(async () => {
    createForUser = jest.fn<
      Promise<AppAbility>,
      [string, { tenantId: string | null; isSuperAdmin: boolean }]
    >((userId: string) =>
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
    resolveMock = jest.fn<
      Promise<HumanDecisionReviewResolveResult>,
      [ResolveHumanDecisionCommand]
    >();

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
          useValue: { listPending: jest.fn(), findById: jest.fn() },
        },
        {
          provide: HUMAN_DECISION_REVIEW_RESOLVE_REPOSITORY,
          useValue: { resolve: resolveMock },
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
    // Mirror `main.ts`: register CORS BEFORE the route-scoped sanitizing parser
    // so a malformed-body short-circuit still carries the allowlist header.
    app.enableCors({ origin: ALLOWED_ORIGIN, credentials: true });
    installHumanDecisionBodyParser(app);
    await app.init();
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

    it('pins the resolve handler to update:HumanDecision, POST :id/resolve and explicit 200', () => {
      const resolveHandler = Object.getOwnPropertyDescriptor(
        HumanDecisionReviewController.prototype,
        'resolve',
      )?.value as () => void;

      expect(Reflect.getMetadata(PERMISSIONS_KEY, resolveHandler)).toEqual([
        ['update', 'HumanDecision'],
      ]);
      expect(Reflect.getMetadata(METHOD_METADATA, resolveHandler)).toBe(
        RequestMethod.POST,
      );
      expect(Reflect.getMetadata(PATH_METADATA, resolveHandler)).toBe(
        ':id/resolve',
      );
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, resolveHandler)).toBe(200);
    });

    it('registers both controllers and binds the read AND resolve ports to their Prisma adapters', () => {
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
    it('rejects a missing bearer token with a sanitized 401 before the port', async () => {
      const res = await postResolve(
        VALID_POSITIVE_BODY,
        DECISION_ID,
        null,
      ).expect(401);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 401,
        code: 'UNAUTHORIZED',
        message: 'Unauthorized',
      });
      expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
      expect(resolveMock).not.toHaveBeenCalled();
      expect(findUnique).not.toHaveBeenCalled();
    });

    it('rejects an invalid bearer token with a sanitized 401 before the port', async () => {
      const res = await postResolve(
        VALID_POSITIVE_BODY,
        DECISION_ID,
        'not-a-valid-jwt',
      ).expect(401);

      expect(res.body).toEqual({
        statusCode: 401,
        code: 'UNAUTHORIZED',
        message: 'Unauthorized',
      });
      expect(resolveMock).not.toHaveBeenCalled();
    });

    it.each([
      { label: 'an inactive', token: TOKENS.inactive, userId: INACTIVE_ID },
      { label: 'a deleted', token: TOKENS.deleted, userId: DELETED_ID },
    ])(
      'rejects $label reviewer JWT with a sanitized 401 before the port',
      async ({ token, userId }) => {
        const res = await postResolve(
          VALID_POSITIVE_BODY,
          DECISION_ID,
          token,
        ).expect(401);
        const body = res.body as ErrorEnvelope;

        expect(body).toEqual({
          statusCode: 401,
          code: 'UNAUTHORIZED',
          message: 'Unauthorized',
        });
        expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
        expect(findUnique).toHaveBeenCalledWith({
          where: { id: userId },
          select: { isActive: true },
        });
        expect(resolveMock).not.toHaveBeenCalled();
        expect(JSON.stringify(body)).not.toContain(userId);
      },
    );
  });

  describe('authorization (403)', () => {
    it('rejects a read-only reviewer WITHOUT update:HumanDecision before the port', async () => {
      const res = await postResolve(
        VALID_POSITIVE_BODY,
        DECISION_ID,
        TOKENS.reader,
      ).expect(403);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 403,
        code: 'FORBIDDEN',
        message: 'Forbidden',
      });
      expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
      // The guard rejects before CASL/port work for this route.
      expect(resolveMock).not.toHaveBeenCalled();
      expect(JSON.stringify(body)).not.toContain(DECISION_ID);
    });

    it('rejects a tenantless superadmin with a sanitized 403 before the port', async () => {
      // PermissionsGuard grants manage:all, so only the route guard's tenant
      // gate can stop the request from reaching the resolve port.
      const res = await postResolve(
        VALID_POSITIVE_BODY,
        DECISION_ID,
        TOKENS.super,
      ).expect(403);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 403,
        code: 'FORBIDDEN',
        message: 'Forbidden',
      });
      expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
      expect(findUnique).not.toHaveBeenCalled();
      expect(createForUser).not.toHaveBeenCalled();
      expect(resolveMock).not.toHaveBeenCalled();
      expect(JSON.stringify(body)).not.toContain('tenant-1');
    });
  });

  describe('resolve contract (positive / negative, resolved / replay)', () => {
    it('resolves a positive estimate with 200, the exact resolved projection and the JWT-derived command', async () => {
      resolveMock.mockResolvedValueOnce({
        status: 'resolved',
        decision: RESOLVED_POSITIVE_ROW,
      });

      const res = await postResolve(VALID_POSITIVE_BODY).expect(200);

      expect(res.body).toEqual(EXPECTED_RESOLVED_POSITIVE);
      expect(resolveMock).toHaveBeenCalledTimes(1);
      expect(resolveMock.mock.calls[0][0]).toEqual({
        decisionId: DECISION_ID,
        expectedVersion: 1,
        resolutionRequestId: RESOLUTION_REQUEST_ID,
        action: POSITIVE_ACTION,
        restockDays: 7,
        actorUserId: MANAGER_ID,
        actorIsSuperAdmin: false,
      });
      expect(resolveMock.mock.calls[0][0]).not.toHaveProperty('tenantId');
    });

    it('resolves a negative estimate with 200 and a command that OMITS restockDays', async () => {
      resolveMock.mockResolvedValueOnce({
        status: 'resolved',
        decision: RESOLVED_NEGATIVE_ROW,
      });

      const res = await postResolve(VALID_NEGATIVE_BODY).expect(200);

      expect(res.body).toEqual(EXPECTED_RESOLVED_NEGATIVE);
      const resolution = (res.body as { resolution: object }).resolution;
      expect(resolution).not.toHaveProperty('restockDays');

      const command = resolveMock.mock.calls[0][0];
      expect(command).toEqual({
        decisionId: DECISION_ID,
        expectedVersion: 1,
        resolutionRequestId: RESOLUTION_REQUEST_ID,
        action: NEGATIVE_ACTION,
        actorUserId: MANAGER_ID,
        actorIsSuperAdmin: false,
      });
      expect(command).not.toHaveProperty('restockDays');
      expect(Object.keys(command).sort()).toEqual([
        'action',
        'actorIsSuperAdmin',
        'actorUserId',
        'decisionId',
        'expectedVersion',
        'resolutionRequestId',
      ]);
    });

    it('takes actorIsSuperAdmin from the verified JWT, never from the body', async () => {
      resolveMock.mockResolvedValueOnce({
        status: 'resolved',
        decision: RESOLVED_POSITIVE_ROW,
      });

      await postResolve(
        VALID_POSITIVE_BODY,
        DECISION_ID,
        TOKENS.superWithTenant,
      ).expect(200);

      expect(resolveMock.mock.calls[0][0]).toMatchObject({
        actorUserId: SUPER_ID,
        actorIsSuperAdmin: true,
      });
    });

    it('answers an idempotent replay with 200 and the SAME immutable projection', async () => {
      resolveMock.mockResolvedValueOnce({
        status: 'replayed',
        decision: RESOLVED_POSITIVE_ROW,
      });

      const res = await postResolve(VALID_POSITIVE_BODY).expect(200);

      expect(res.body).toEqual(EXPECTED_RESOLVED_POSITIVE);
      // The adapter `resolved`/`replayed` status is never surfaced; exactly one
      // port call and no controller-side write. The projection `status` is the
      // decision lifecycle value (`RESOLVED`), not the adapter result status.
      expect(resolveMock).toHaveBeenCalledTimes(1);
      expect((res.body as { status: string }).status).toBe('RESOLVED');
      expect(res.body).not.toHaveProperty('replayed');
      expect(JSON.stringify(res.body)).not.toContain('replayed');
    });

    it('never leaks bot-only/authority/PII fields on the resolve projection', async () => {
      resolveMock.mockResolvedValueOnce({
        status: 'resolved',
        decision: RESOLVED_POSITIVE_ROW,
      });

      const res = await postResolve(VALID_POSITIVE_BODY).expect(200);
      const serialized = JSON.stringify(res.body);

      for (const key of FORBIDDEN_KEYS) {
        expect(res.body).not.toHaveProperty(key);
      }
      expect(serialized).not.toContain('houndfe-chatbot');
      expect(serialized).not.toContain('canonicalRequestHash');
      expect(serialized).not.toContain('tenant-1');
    });
  });

  describe('resolve contract (EXPIRATION dispatch)', () => {
    it('resolves PROVIDE_EXPIRATION_TEXT with 200, normalized text and the JWT-derived command', async () => {
      resolveMock.mockResolvedValueOnce({
        status: 'resolved',
        decision: RESOLVED_EXP_POSITIVE_ROW,
      });

      const res = await postResolve(VALID_EXP_POSITIVE_BODY).expect(200);

      expect(res.body).toEqual(EXPECTED_EXP_RESOLVED_POSITIVE);
      expect(Object.keys(res.body as Record<string, unknown>).sort()).toEqual(
        EXPECTED_EXP_TOP_LEVEL_KEYS,
      );
      for (const key of [...FORBIDDEN_KEYS, ...EXP_FORBIDDEN_KEYS]) {
        expect(res.body).not.toHaveProperty(key);
      }

      const command = resolveMock.mock.calls[0][0];
      expect(command).toEqual({
        decisionId: DECISION_ID,
        expectedVersion: 1,
        resolutionRequestId: RESOLUTION_REQUEST_ID,
        action: EXP_POSITIVE_ACTION,
        expirationText: NORMALIZED_EXPIRATION_TEXT,
        actorUserId: MANAGER_ID,
        actorIsSuperAdmin: false,
      });
      expect(command).not.toHaveProperty('tenantId');
      expect(command).not.toHaveProperty('restockDays');
    });

    it('resolves REPORT_EXPIRATION_UNAVAILABLE with 200 and a command that OMITS expirationText', async () => {
      resolveMock.mockResolvedValueOnce({
        status: 'resolved',
        decision: RESOLVED_EXP_NEGATIVE_ROW,
      });

      const res = await postResolve(VALID_EXP_NEGATIVE_BODY).expect(200);

      expect(res.body).toEqual(EXPECTED_EXP_RESOLVED_NEGATIVE);
      const resolution = (res.body as { resolution: object }).resolution;
      expect(resolution).not.toHaveProperty('expirationText');

      const command = resolveMock.mock.calls[0][0];
      expect(command).toEqual({
        decisionId: DECISION_ID,
        expectedVersion: 1,
        resolutionRequestId: RESOLUTION_REQUEST_ID,
        action: EXP_NEGATIVE_ACTION,
        actorUserId: MANAGER_ID,
        actorIsSuperAdmin: false,
      });
      expect(command).not.toHaveProperty('expirationText');
    });

    it('maps an EXPIRATION VERSION_CONFLICT to 409 without echoing the version', async () => {
      resolveMock.mockRejectedValueOnce(
        new HumanDecisionReviewResolveError(
          'VERSION_CONFLICT',
          'value-free server message',
        ),
      );

      const res = await postResolve({
        ...VALID_EXP_POSITIVE_BODY,
        expectedVersion: 7,
      }).expect(409);

      expect(res.body).toEqual({
        statusCode: 409,
        code: 'VERSION_CONFLICT',
        message: 'Human decision was modified by another reviewer',
      });
      expect(resolveMock).toHaveBeenCalledTimes(1);
      expect(resolveMock.mock.calls[0][0].expectedVersion).toBe(7);
    });

    it('rejects a spoofed EXPIRATION actor key with a value-free 400 before the port', async () => {
      const spoofValue = 'spoof-exp-sentinel';
      const res = await postResolve({
        ...VALID_EXP_POSITIVE_BODY,
        actorUserId: spoofValue,
      }).expect(400);

      expect(res.body).toEqual({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
      });
      expect(JSON.stringify(res.body)).not.toContain(spoofValue);
      expect(resolveMock).not.toHaveBeenCalled();
    });

    it.each([
      ['a control character', 'line\nbreak'],
      ['an over-limit value', 'a'.repeat(501)],
    ])(
      'rejects an EXP expirationText with %s as a value-free 400 before the port',
      async (_label, expirationText) => {
        const res = await postResolve({
          ...VALID_EXP_POSITIVE_BODY,
          expirationText,
        }).expect(400);

        expect(res.body).toEqual({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
        });
        expect(resolveMock).not.toHaveBeenCalled();
      },
    );

    it('rejects cross-type keys (restockDays on EXP, expirationText on RESTOCK)', async () => {
      await postResolve({
        ...VALID_EXP_POSITIVE_BODY,
        restockDays: 7,
      }).expect(400);
      await postResolve({
        ...VALID_POSITIVE_BODY,
        expirationText: NORMALIZED_EXPIRATION_TEXT,
      }).expect(400);

      expect(resolveMock).not.toHaveBeenCalled();
    });

    it('rejects an EXPIRATION resolve without a bearer token before the port', async () => {
      const res = await postResolve(
        VALID_EXP_POSITIVE_BODY,
        DECISION_ID,
        null,
      ).expect(401);

      expect(res.body).toEqual({
        statusCode: 401,
        code: 'UNAUTHORIZED',
        message: 'Unauthorized',
      });
      expect(resolveMock).not.toHaveBeenCalled();
    });
  });

  describe('transport validation (sanitized 400 before the port)', () => {
    it('rejects a malformed decision id with 400 before the port', async () => {
      const res = await postResolve(
        VALID_POSITIVE_BODY,
        '5491100000000',
      ).expect(400);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
      });
      expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
      expect(JSON.stringify(body)).not.toContain('5491100000000');
      expect(resolveMock).not.toHaveBeenCalled();
    });

    it.each([
      'tenantId',
      'actorUserId',
      'actorIsSuperAdmin',
      'audit',
      'outcome',
      'source',
    ])(
      'rejects a body that smuggles a %s key with a value-free 400',
      async (key) => {
        const spoofValue = `spoof-${key}-sentinel`;
        const res = await postResolve({
          ...VALID_POSITIVE_BODY,
          [key]: key === 'actorIsSuperAdmin' ? true : spoofValue,
        }).expect(400);
        const body = res.body as ErrorEnvelope;

        expect(body).toEqual({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
        });
        expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
        expect(body).not.toHaveProperty('error');
        expect(body).not.toHaveProperty('timestamp');
        expect(JSON.stringify(body)).not.toContain(spoofValue);
        expect(resolveMock).not.toHaveBeenCalled();
      },
    );

    it('rejects the negative variant carrying restockDays with a value-free 400', async () => {
      const res = await postResolve({
        action: NEGATIVE_ACTION,
        restockDays: 5,
        expectedVersion: 1,
        resolutionRequestId: RESOLUTION_REQUEST_ID,
      }).expect(400);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
      });
      expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
      expect(resolveMock).not.toHaveBeenCalled();
    });

    it('never reflects the rejected query/body/id in an error envelope', async () => {
      const res = await http()
        .post(`${resolveUrl()}?tenantId=evil-tenant&actorUserId=attacker`)
        .set('Authorization', `Bearer ${TOKENS.manager}`)
        .send({ action: POSITIVE_ACTION, restockDays: 0, expectedVersion: 1 })
        .expect(400);
      const body = res.body as ErrorEnvelope;
      const serialized = JSON.stringify(body);

      expect(serialized).not.toContain('evil-tenant');
      expect(serialized).not.toContain('attacker');
      expect(serialized).not.toContain(DECISION_ID);
      expect(resolveMock).not.toHaveBeenCalled();
    });

    it('rejects a JSON array body with the exact 400 envelope before the port', async () => {
      const res = await http()
        .post(resolveUrl())
        .set('Authorization', `Bearer ${TOKENS.manager}`)
        .set('Content-Type', 'application/json')
        .send('[]')
        .expect(400);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
      });
      expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
      expect(resolveMock).not.toHaveBeenCalled();
    });

    it.each([
      ['a bare null', 'null'],
      ['a bare string', `"${POSITIVE_ACTION}"`],
      ['a bare number', '7'],
      ['a bare boolean', 'true'],
    ])(
      'rejects a JSON %s primitive body with the exact sanitized 400 before the port',
      async (_label, rawJson) => {
        // The route-scoped `strict:false` parser ACCEPTS the primitive, so the
        // request reaches the route and the exact pure parser collapses it to
        // the controller-scoped envelope (no Nest default body-parser leak).
        const res = await http()
          .post(resolveUrl())
          .set('Authorization', `Bearer ${TOKENS.manager}`)
          .set('Content-Type', 'application/json')
          .send(rawJson)
          .expect(400);
        const body = res.body as ErrorEnvelope;

        expect(body).toEqual({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
        });
        expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
        const serialized = JSON.stringify(body);
        expect(serialized).not.toContain(POSITIVE_ACTION);
        expect(serialized).not.toContain(DECISION_ID);
        expect(resolveMock).not.toHaveBeenCalled();
      },
    );

    it('sanitizes a malformed JSON syntax body without echoing the raw body or the pre-router message', async () => {
      const malformed = '{"pii":"SENTINEL","decisionId":"SENTINEL_ID"';
      const res = await http()
        .post(resolveUrl())
        .set('Authorization', `Bearer ${TOKENS.manager}`)
        .set('Content-Type', 'application/json')
        .send(malformed)
        .expect(400);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
      });
      expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain('SENTINEL');
      expect(serialized).not.toContain(DECISION_ID);
      expect(body).not.toHaveProperty('error');
      expect(body).not.toHaveProperty('timestamp');
      expect(resolveMock).not.toHaveBeenCalled();
    });

    it('sanitizes suspicious malformed nested JSON with the fixed value-free envelope', async () => {
      const malformed =
        '{"actorUserId":{"$ne":"SENTINEL"},"action":"SENTINEL_ACTION"';
      const res = await http()
        .post(resolveUrl())
        .set('Authorization', `Bearer ${TOKENS.manager}`)
        .set('Content-Type', 'application/json')
        .send(malformed)
        .expect(400);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
      });
      expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain('SENTINEL');
      expect(serialized).not.toContain('actorUserId');
      expect(serialized).not.toContain('$ne');
      expect(resolveMock).not.toHaveBeenCalled();
    });

    it('sanitizes a malformed urlencoded form body with the fixed 400 before the port', async () => {
      // `extended:true` uses qs `strictDepth`; nesting past the default depth
      // raises `querystring.parse.rangeError` (400) from the URL-encoded
      // parser itself. The scoped error handler must sanitize it.
      const deeplyNestedForm = `a${'[b]'.repeat(40)}=SENTINEL`;
      const res = await http()
        .post(resolveUrl())
        .set('Authorization', `Bearer ${TOKENS.manager}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(deeplyNestedForm)
        .expect(400);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
      });
      expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
      expect(JSON.stringify(body)).not.toContain('SENTINEL');
      expect(resolveMock).not.toHaveBeenCalled();
    });

    it('rejects a parsed urlencoded resolve body with a smuggled key with the fixed 400 before the port', async () => {
      const res = await http()
        .post(resolveUrl())
        .set('Authorization', `Bearer ${TOKENS.manager}`)
        .type('form')
        .send({
          action: POSITIVE_ACTION,
          restockDays: '7',
          expectedVersion: '1',
          resolutionRequestId: RESOLUTION_REQUEST_ID,
          actorUserId: 'SENTINEL_ACTOR',
        })
        .expect(400);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
      });
      expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain('SENTINEL_ACTOR');
      expect(serialized).not.toContain(RESOLUTION_REQUEST_ID);
      expect(resolveMock).not.toHaveBeenCalled();
    });

    it('preserves 413 for an oversized body with a fixed value-free envelope', async () => {
      const padding = 'a'.repeat(110 * 1024);
      const res = await http()
        .post(resolveUrl())
        .set('Authorization', `Bearer ${TOKENS.manager}`)
        .set('Content-Type', 'application/json')
        .send(`{"action":"${POSITIVE_ACTION}","padding":"${padding}"}`)
        .expect(413);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 413,
        code: 'REQUEST_ERROR',
        message: 'Request failed',
      });
      expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(padding.slice(0, 32));
      expect(serialized).not.toContain(POSITIVE_ACTION);
      expect(resolveMock).not.toHaveBeenCalled();
    });
  });

  describe('malformed-body short-circuit keeps the allowlisted CORS header', () => {
    // MEDIUM: registering the route-scoped sanitizing parser BEFORE CORS left
    // the fixed 400/413 response without `Access-Control-Allow-Origin`, so an
    // allowlisted browser FE saw an opaque network error instead of the
    // sanitized envelope. These cases pin the header on parser failures.
    it('keeps the allowlisted origin on a malformed JSON syntax 400', async () => {
      const res = await http()
        .post(resolveUrl())
        .set('Origin', ALLOWED_ORIGIN)
        .set('Authorization', `Bearer ${TOKENS.manager}`)
        .set('Content-Type', 'application/json')
        .send('{"pii":"SENTINEL"')
        .expect('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
        .expect(400);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
      });
      expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
      expect(JSON.stringify(body)).not.toContain('SENTINEL');
      expect(resolveMock).not.toHaveBeenCalled();
    });

    it('keeps the allowlisted origin on a malformed urlencoded 400', async () => {
      const deeplyNestedForm = `a${'[b]'.repeat(40)}=SENTINEL`;
      const res = await http()
        .post(resolveUrl())
        .set('Origin', ALLOWED_ORIGIN)
        .set('Authorization', `Bearer ${TOKENS.manager}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(deeplyNestedForm)
        .expect('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
        .expect(400);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
      });
      expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
      expect(JSON.stringify(body)).not.toContain('SENTINEL');
      expect(resolveMock).not.toHaveBeenCalled();
    });

    it('keeps the allowlisted origin on an oversized-body 413', async () => {
      const padding = 'a'.repeat(110 * 1024);
      const res = await http()
        .post(resolveUrl())
        .set('Origin', ALLOWED_ORIGIN)
        .set('Authorization', `Bearer ${TOKENS.manager}`)
        .set('Content-Type', 'application/json')
        .send(`{"action":"${POSITIVE_ACTION}","padding":"${padding}"}`)
        .expect('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
        .expect(413);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 413,
        code: 'REQUEST_ERROR',
        message: 'Request failed',
      });
      expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
      expect(JSON.stringify(body)).not.toContain(POSITIVE_ACTION);
      expect(resolveMock).not.toHaveBeenCalled();
    });
  });

  describe('port failures map to stable, value-free envelopes (409/404/500)', () => {
    it('lets a well-formed stale expectedVersion reach the port and maps VERSION_CONFLICT to 409', async () => {
      resolveMock.mockRejectedValueOnce(
        new HumanDecisionReviewResolveError(
          'VERSION_CONFLICT',
          'value-free server message',
        ),
      );

      const res = await postResolve({
        ...VALID_POSITIVE_BODY,
        expectedVersion: 7,
      }).expect(409);
      const body = res.body as ErrorEnvelope;

      expect(body).toEqual({
        statusCode: 409,
        code: 'VERSION_CONFLICT',
        message: 'Human decision was modified by another reviewer',
      });
      expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
      // The stale version reached the port rather than being misread as 400.
      expect(resolveMock).toHaveBeenCalledTimes(1);
      expect(resolveMock.mock.calls[0][0].expectedVersion).toBe(7);
    });

    it.each([
      ['NOT_FOUND', 404, 'NOT_FOUND', 'Not found'],
      ['UNAUTHORIZED', 401, 'UNAUTHORIZED', 'Unauthorized'],
      ['FORBIDDEN', 403, 'FORBIDDEN', 'Forbidden'],
      [
        'IDEMPOTENCY_CONFLICT',
        409,
        'IDEMPOTENCY_CONFLICT',
        'Request conflicts with a previous submission',
      ],
      [
        'ALREADY_RESOLVED',
        409,
        'ALREADY_RESOLVED',
        'Human decision was already resolved',
      ],
    ] as const)(
      'maps a %s resolve failure to %i %s with its fixed message',
      async (code, status, expectedCode, message) => {
        resolveMock.mockRejectedValueOnce(
          new HumanDecisionReviewResolveError(code, 'leaky upstream detail'),
        );

        const res = await postResolve(VALID_POSITIVE_BODY).expect(status);
        const body = res.body as ErrorEnvelope;

        expect(body).toEqual({
          statusCode: status,
          code: expectedCode,
          message,
        });
        expect(Object.keys(body).sort()).toEqual(EXPECTED_ERROR_KEYS);
        expect(JSON.stringify(body)).not.toContain('leaky upstream detail');
        expect(JSON.stringify(body)).not.toContain(RESOLUTION_REQUEST_ID);
      },
    );

    it('collapses an unexpected port failure to a safe 500 with no upstream message', async () => {
      resolveMock.mockRejectedValueOnce(
        new Error('pg password leaked: hunter2'),
      );

      const res = await postResolve(VALID_POSITIVE_BODY).expect(500);
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

  describe('real CLS context is exercised on the write route', () => {
    it('lets an active manager through and reads only isActive for admission', async () => {
      resolveMock.mockResolvedValueOnce({
        status: 'resolved',
        decision: RESOLVED_POSITIVE_ROW,
      });

      await postResolve(VALID_POSITIVE_BODY).expect(200);

      expect(findUnique).toHaveBeenCalledWith({
        where: { id: MANAGER_ID },
        select: { isActive: true },
      });
      const cls = app.get(ClsService);
      expect(cls).toBeInstanceOf(ClsService);
      expect(cls.isActive()).toBe(false);
    });
  });
});
