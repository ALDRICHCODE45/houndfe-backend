/**
 * PdfGenerationController — HTTP integration tests (WU5).
 *
 * What we verify through the real HTTP boundary (supertest +
 * Test.createNestApplication):
 *
 *   1. `GET /sales/{confirmedId}/pdf?format=receipt-a4`     → 200, PDF body.
 *   2. `GET /sales/{confirmedId}/pdf?format=receipt-ticket` → 200, PDF body.
 *   3. `GET /sales/{confirmedId}/pdf?format=invalid`        → 400 INVALID_FORMAT.
 *   4. `GET /sales/{draftId}/pdf`                           → 404 (the underlying
 *      `prisma-sale.repository.findOneWithRelations` already filters on
 *      `status: 'CONFIRMED'` so DRAFT sales never surface — neither as 400
 *      nor as 200, just 404. The service's defensive `BadRequestException`
 *      for non-CONFIRMED statuses is still covered by the unit spec at
 *      `pdf-generation.service.spec.ts`.)
 *   5. `GET /sales/{nonexistentId}/pdf`                      → 404.
 *   6. `GET /sales/{otherTenantConfirmedId}/pdf` (cross-tenant attempt) → 404.
 *   7. Request without an `Authorization` header             → 401.
 *
 * What this spec DOES exercise (real):
 *   - PdfGenerationController: route resolution, query parsing,
 *     format validation, header set, stream send.
 *   - PdfGenerationService.generateSalePdf: status guard + format
 *     resolution + render orchestration.
 *   - SalesService.getSaleDetail: tenant-scoped + CONFIRMED-filtered
 *     read against a REAL Postgres test DB.
 *   - PrismaSaleRepository.findOneWithRelations: SQL WHERE clause on
 *     `(id, tenantId, status: 'CONFIRMED')`.
 *   - JwtAuthGuard + TenantContextGuard + PermissionsGuard: replaced
 *     with `TestJwtAuthGuard` / `TestTenantContextGuard` /
 *     `TestPermissionsGuard` so we control the authenticated user
 *     without going through real JWT signing.
 *
 * What this spec DOES NOT exercise (mocked / stubbed):
 *   - `@react-pdf/renderer`'s real Yoga layout engine. Jest would
 *     have to load the ESM-only WASM module — we stub it at the
 *     module boundary so the controller test path can assert the
 *     bytes-on-the-wire shape without booting the renderer.
 *     The renderer itself is unit-tested under
 *     `pdf-generation/templates/receipt/receipt-{a4,ticket}.document.spec.tsx`.
 *   - ProductsService / EventEmitter2 / OutboxWriterService /
 *     sale-comments repo / POS-promo engine port: stubbed because
 *     `getSaleDetail` does not touch them. Real wiring for those is
 *     covered by `sales.service.spec.ts` and the sales controller spec.
 *
 * Why not boot the full SalesModule?
 *   SalesModule depends on ~10 transitive modules (ProductsModule,
 *   PromotionsModule, OutboxModule, AuthModule, SaleCommentsModule,
 *   …) that pull in their own infrastructure and would require a
 *   `Test.createTestingModule({ imports: [SalesModule, TenantsModule,
 *   PdfGenerationModule, …] })` graph that's larger than the
 *   scenario under test. This spec exercises the exact same
 *   `PdfGenerationService → SalesService.getSaleDetail → PrismaSaleRepo
 *   .findOneWithRelations → tenant-scoped Postgres` chain that
 *   production uses, just with stubs for the sibling collaborators
 *   `getSaleDetail` doesn't read. The chain under test is end-to-end.
 *
 * Test-DB isolation
 *   - `jest.integration.config.js` → only this file is matched
 *   - `test/integration/setup/load-env.ts` → sets `DATABASE_URL`
 *   - `test/integration/setup/global-setup.ts` → applies migrations
 *     and seeds the baseline tenant
 *   - `SKIP_DB_INTEGRATION=1` short-circuits the suite to `describe.skip`
 *     so unit-test runs (which never have a DB) don't crash.
 *   - `afterEach` calls `resetAndSeedBaseline()` so a mid-test failure
 *     can't leak `sales` / `users` / `products` rows into the next spec.
 */
import {
  ForbiddenException,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
  type CanActivate,
  type ExecutionContext,
  type Type,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import request from 'supertest';
import { Readable } from 'node:stream';
import type {
  AppActions,
  AppSubjects,
} from '../auth/authorization/domain/permission';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import { PrismaService } from '../shared/prisma/prisma.service';
import { OutboxWriterService } from '../shared/outbox/outbox-writer.service';
import { ProductsService } from '../products/products.service';
import { SalesService } from '../sales/sales.service';
import { PrismaSaleRepository } from '../sales/infrastructure/prisma-sale.repository';
import {
  ISaleCommentRepository,
  SALE_COMMENT_REPOSITORY,
} from '../sales/comments/domain/sale-comment.repository';
import {
  ISaleRepository,
  SALE_REPOSITORY,
} from '../sales/domain/sale.repository';
import {
  POS_EVALUATE_PROMOTIONS_USE_CASE,
  type IPosEvaluatePromotionsUseCase,
} from '../promotions/application/ports/pos-evaluate-promotions.port';
import {
  resetAndSeedBaseline,
  disconnectIntegrationPrisma,
  BASELINE_TENANT_ID,
} from '../../test/integration/reset-db';
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
import { PdfGenerationController } from './pdf-generation.controller';
import { PdfGenerationService } from './pdf-generation.service';

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;

const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;

// Mock @react-pdf/renderer at the module boundary so we don't have to
// boot the real Yoga WASM engine. The renderer is unit-tested in
// `pdf-generation/templates/receipt/receipt-*.document.spec.tsx` —
// this integration spec only cares that the HTTP boundary streams a
// PDF-shaped body and the right headers.
jest.mock('@react-pdf/renderer', () => {
  const real = jest.requireActual('@react-pdf/renderer');
  return {
    ...real,
    renderToStream: jest.fn(),
    Font: {
      ...real.Font,
      register: jest.fn(),
      registerHyphenationCallback: jest.fn(),
    },
  };
});

type TestRequest = {
  headers: Record<string, string | undefined>;
  user?: AuthenticatedUser & { permissions: string[] };
};

type SupertestApp = Parameters<typeof request>[0];

type SeededFixture = {
  confirmedSaleId: string;
  draftSaleId: string;
  otherTenantConfirmedSaleId: string;
  otherTenantId: string;
};

const TENANT_A_ID = BASELINE_TENANT_ID; // '00000000-0000-0000-0000-000000000001'
const TENANT_B_ID = '00000000-0000-0000-0000-000000000002';

const USER_A_ID = '11111111-1111-4111-8111-111111111111';
const USER_B_ID = '22222222-2222-4222-8222-222222222222';
const PRODUCT_ID = '33333333-3333-4333-8333-333333333333';

class TestJwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<TestRequest>();
    const auth = request.headers.authorization;
    if (!auth) {
      throw new UnauthorizedException('Unauthorized');
    }

    // Token format: `Bearer <tenant>:<user>` — we use the tenant
    // segment to drive tenant isolation tests. A token with no
    // tenant segment defaults to TENANT_A.
    const token = auth.replace('Bearer ', '');
    const [tenantSegment, userSegment] = token.split(':');

    let tenantId = TENANT_A_ID;
    let userId = USER_A_ID;
    if (tenantSegment === 'tenant-b') {
      tenantId = TENANT_B_ID;
      userId = USER_B_ID;
    } else if (tenantSegment === 'tenant-a') {
      tenantId = TENANT_A_ID;
      userId = USER_A_ID;
    }
    if (userSegment) {
      userId = userSegment;
    }

    request.user = {
      userId,
      email: `${userId}@example.com`,
      tenantId,
      tenantSlug: tenantId === TENANT_A_ID ? 'a' : 'b',
      isSuperAdmin: false,
      permissions: ['read:Sale'],
    };
    return true;
  }
}

class TestTenantContextGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<TestRequest>();
    const user = request.user;
    if (!user?.tenantId) {
      throw new UnauthorizedException('Tenant context required');
    }
    // We do NOT call cls.set here — the real TenantContextGuard
    // is replaced by this guard in the test, and we set the CLS
    // slot inside a per-request `cls.run()` block via the test
    // helper. Keeping this guard a pure pass-through lets the test
    // control CLS scope explicitly without fighting Nest's request
    // lifecycle.
    return true;
  }
}

class TestPermissionsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<TestRequest>();
    const permissions = request.user?.permissions ?? [];
    const requiredPermissions = (Reflect.getMetadata(
      'required_permissions',
      context.getHandler(),
    ) ??
      Reflect.getMetadata('required_permissions', context.getClass()) ??
      []) as Array<[AppActions, AppSubjects]>;

    for (const [action, subject] of requiredPermissions) {
      if (!permissions.includes(`${action}:${subject}`)) {
        throw new ForbiddenException('Insufficient permissions');
      }
    }
    return true;
  }
}

async function seedFixtures(prisma: PrismaService): Promise<SeededFixture> {
  // Baseline tenant (0000…0001) is created by globalSetup. Add the
  // second tenant + the product + the three sales we need.
  await prisma.tenant.upsert({
    where: { id: TENANT_B_ID },
    update: {},
    create: {
      id: TENANT_B_ID,
      name: 'Integration Tenant B',
      slug: 'integration-tenant-b',
      isActive: true,
    },
  });

  await prisma.user.createMany({
    data: [
      {
        id: USER_A_ID,
        email: 'user-a@example.com',
        hashedPassword: 'x',
        name: 'User A',
        isActive: true,
      },
      {
        id: USER_B_ID,
        email: 'user-b@example.com',
        hashedPassword: 'x',
        name: 'User B',
        isActive: true,
      },
    ],
  });

  await prisma.product.create({
    data: {
      id: PRODUCT_ID,
      name: 'Camisa Polo Test',
      type: 'PRODUCT',
      unit: 'UNIDAD',
      tenantId: TENANT_A_ID,
      sku: 'TEST-CAM-001',
      sellInPos: true,
      includeInOnlineCatalog: true,
      requiresPrescription: false,
      chargeProductTaxes: true,
      ivaRate: 'IVA_16',
      iepsRate: 'NO_APLICA',
      purchaseCostMode: 'NET',
      purchaseNetCostCents: 0,
      purchaseGrossCostCents: 0,
      useStock: true,
      useLotsAndExpirations: false,
      quantity: 100,
      minQuantity: 0,
      hasVariants: false,
    },
  });

  const confirmedSaleId = '44444444-4444-4444-8444-444444444444';
  const draftSaleId = '55555555-5555-4555-8555-555555555555';
  const otherTenantSaleId = '66666666-6666-4666-8666-666666666666';

  await prisma.sale.create({
    data: {
      id: confirmedSaleId,
      tenantId: TENANT_A_ID,
      userId: USER_A_ID,
      status: 'CONFIRMED',
      channel: 'POS',
      register: 'POS-01',
      subtotalCents: 10000,
      discountCents: 0,
      totalCents: 10000,
      paidCents: 10000,
      debtCents: 0,
      changeDueCents: 0,
      paymentStatus: 'PAID',
      deliveryStatus: 'NOT_APPLICABLE',
      confirmedAt: new Date('2026-07-20T15:00:00.000Z'),
      folio: 'A-0001',
    },
  });

  await prisma.saleItem.create({
    data: {
      id: '77777777-7777-4777-8777-777777777771',
      tenantId: TENANT_A_ID,
      saleId: confirmedSaleId,
      productId: PRODUCT_ID,
      productName: 'Camisa Polo Test',
      quantity: 2,
      unitPriceCents: 5000,
      unitPriceCurrency: 'MXN',
    },
  });

  await prisma.salePayment.create({
    data: {
      id: '88888888-8888-4888-8888-888888888881',
      tenantId: TENANT_A_ID,
      saleId: confirmedSaleId,
      method: 'CASH',
      amountCents: 10000,
      reference: null,
    },
  });

  await prisma.sale.create({
    data: {
      id: draftSaleId,
      tenantId: TENANT_A_ID,
      userId: USER_A_ID,
      status: 'DRAFT',
      channel: 'POS',
      register: 'POS-01',
      subtotalCents: 5000,
      discountCents: 0,
      totalCents: 5000,
      paidCents: 0,
      debtCents: 5000,
      changeDueCents: 0,
      paymentStatus: null,
      deliveryStatus: 'NOT_APPLICABLE',
      folio: null,
    },
  });

  await prisma.sale.create({
    data: {
      id: otherTenantSaleId,
      tenantId: TENANT_B_ID,
      userId: USER_B_ID,
      status: 'CONFIRMED',
      channel: 'POS',
      register: 'POS-01',
      subtotalCents: 5000,
      discountCents: 0,
      totalCents: 5000,
      paidCents: 5000,
      debtCents: 0,
      changeDueCents: 0,
      paymentStatus: 'PAID',
      deliveryStatus: 'NOT_APPLICABLE',
      confirmedAt: new Date('2026-07-20T15:00:00.000Z'),
      folio: 'B-0001',
    },
  });

  return {
    confirmedSaleId,
    draftSaleId,
    otherTenantConfirmedSaleId: otherTenantSaleId,
    otherTenantId: TENANT_B_ID,
  };
}

describeIfDb('PdfGenerationController HTTP integration (WU5)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cls: ClsService<TenantClsStore>;
  let fixtures: SeededFixture;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await disconnectIntegrationPrisma();
  });

  beforeEach(async () => {
    // Wipe + reseed baseline BEFORE every test so the suite is
    // self-isolating: a failure in test N cannot leak rows into
    // test N+1. We then create the additional tenants / users /
    // products / sales that this spec needs.
    await resetAndSeedBaseline();
    fixtures = await seedFixtures(prisma);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const renderer = require('@react-pdf/renderer');
    renderer.renderToStream.mockImplementation(() =>
      Readable.from([Buffer.from('%PDF-1.4\n% WU5 fake PDF\n%%EOF\n')]),
    );
    renderer.Font.register.mockReturnValue(undefined);
    renderer.Font.registerHyphenationCallback.mockReturnValue(undefined);

    const tenantPrismaProvider = {
      provide: TenantPrismaService,
      useFactory: (prismaSvc: PrismaService, clsSvc: ClsService<TenantClsStore>) =>
        new TenantPrismaService(prismaSvc, clsSvc),
      inject: [PrismaService, ClsService],
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        // Real ClsModule + middleware so the per-request async context
        // is maintained between the (overridden) TenantContextGuard
        // and the TenantPrismaService.getClient() call inside the
        // PrismaSaleRepository.
        ClsModule.forRoot({
          global: true,
          middleware: { mount: true },
        }),
      ],
      controllers: [PdfGenerationController],
      providers: [
        PrismaService,
        tenantPrismaProvider,
        PrismaSaleRepository,
        // Bind the Symbol token used by `@Inject(SALE_REPOSITORY)`
        // on SalesService's constructor. Without this, Nest can't
        // resolve the symbol-to-class mapping and the module compile
        // throws `Symbol(ISaleRepository)` not found.
        {
          provide: SALE_REPOSITORY,
          useExisting: PrismaSaleRepository,
        },
        // Stubbed siblings of SalesService — getSaleDetail does not
        // touch any of these, but the constructor requires them.
        { provide: ProductsService, useValue: {} as ProductsService },
        {
          provide: EventEmitter2,
          useValue: { emit: jest.fn() } as unknown as EventEmitter2,
        },
        {
          provide: OutboxWriterService,
          useValue: {
            publish: jest.fn().mockResolvedValue(undefined),
          } as unknown as OutboxWriterService,
        },
        {
          provide: SALE_COMMENT_REPOSITORY,
          useValue: {
            findActiveBySale: async () => [],
          } as Pick<ISaleCommentRepository, 'findActiveBySale'>,
        },
        {
          provide: POS_EVALUATE_PROMOTIONS_USE_CASE,
          useValue: {} as IPosEvaluatePromotionsUseCase,
        },
        SalesService,
        PdfGenerationService,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(TestJwtAuthGuard as Type<CanActivate>)
      .overrideGuard(TenantContextGuard)
      .useClass(TestTenantContextGuard as Type<CanActivate>)
      .overrideGuard(PermissionsGuard)
      .useClass(TestPermissionsGuard as Type<CanActivate>)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );

    // Re-create the Nest request-scoped CLS for every request by
    // wrapping the Nest app in a per-request `cls.run()`. This is
    // what nestjs-cls's `mount: true` middleware is supposed to do
    // automatically, but because we override TenantContextGuard we
    // don't read from CLS in any guard. The tenantPrisma factory
    // still calls `cls.get('tenantId')` — so we have to seed CLS
    // BEFORE the request reaches the controller. The middleware
    // already sets up a CLS scope per request; we just need to
    // stamp `tenantId` into it before each supertest call.
    //
    // The cleanest way: use cls.run() inside the supertest callback
    // via an interceptor. For simplicity here we use a `beforeEach`
    // middleware via app.use() that runs after the ClsModule
    // middleware and stamps the tenantId from the Authorization
    // header BEFORE the controller is invoked.
    //
    // The interceptor approach below runs INSIDE the per-request CLS
    // scope (the ClsModule middleware opens one), reads the
    // Authorization header, and sets tenantId / isSuperAdmin on CLS.
    const expressApp = app.getHttpAdapter().getInstance() as {
      use: (
        handler: (req: unknown, res: unknown, next: () => void) => void,
      ) => void;
    };
    expressApp.use((req: any, _res: unknown, next: () => void) => {
      cls.run(() => {
        const auth = req.headers?.authorization as string | undefined;
        let tenantId: string | null = null;
        let isSuperAdmin = false;
        let userId: string | null = null;
        if (auth) {
          const token = auth.replace('Bearer ', '');
          const [tenantSegment] = token.split(':');
          if (tenantSegment === 'tenant-b') {
            tenantId = TENANT_B_ID;
            userId = USER_B_ID;
          } else if (tenantSegment === 'tenant-a' || tenantSegment === '') {
            tenantId = TENANT_A_ID;
            userId = USER_A_ID;
          }
        }
        cls.set('tenantId', tenantId);
        cls.set('isSuperAdmin', isSuperAdmin);
        cls.set('userId', userId);
        next();
      });
    });

    await app.init();
    cls = app.get(ClsService);
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
    jest.clearAllMocks();
  });

  // ── Happy path ─────────────────────────────────────────────────────

  it('streams a PDF body with Content-Type application/pdf for ?format=receipt-a4', async () => {
    const response = await request(app.getHttpServer() as SupertestApp)
      .get(`/sales/${fixtures.confirmedSaleId}/pdf?format=receipt-a4`)
      .set('Authorization', 'Bearer tenant-a');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/application\/pdf/);
    expect(response.headers['content-disposition']).toMatch(
      /^attachment; filename="recibo-.+\.pdf"$/,
    );

    // Body is the streamed PDF — supertest concatenates the
    // readable chunks into a single Buffer.
    const body = response.body as Buffer;
    expect(body).toBeInstanceOf(Buffer);
    expect(body.length).toBeGreaterThan(0);
    expect(body.subarray(0, 5).toString('utf8')).toBe('%PDF-');
  });

  it('streams a PDF body for ?format=receipt-ticket', async () => {
    const response = await request(app.getHttpServer() as SupertestApp)
      .get(`/sales/${fixtures.confirmedSaleId}/pdf?format=receipt-ticket`)
      .set('Authorization', 'Bearer tenant-a');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/application\/pdf/);

    const body = response.body as Buffer;
    expect(body.subarray(0, 5).toString('utf8')).toBe('%PDF-');
  });

  it('uses the folio (not the URL id) in the Content-Disposition filename', async () => {
    const response = await request(app.getHttpServer() as SupertestApp)
      .get(`/sales/${fixtures.confirmedSaleId}/pdf?format=receipt-a4`)
      .set('Authorization', 'Bearer tenant-a');

    expect(response.status).toBe(200);
    // Folio for the seeded confirmed sale is `A-0001` — the filename
    // must reflect that, not the URL id `4444…4444`.
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="recibo-A-0001.pdf"',
    );
  });

  // ── Format validation ──────────────────────────────────────────────

  it('returns 400 INVALID_FORMAT for ?format=invalid', async () => {
    const response = await request(app.getHttpServer() as SupertestApp)
      .get(`/sales/${fixtures.confirmedSaleId}/pdf?format=invalid`)
      .set('Authorization', 'Bearer tenant-a');

    expect(response.status).toBe(400);
    // Nest's exception filter returns a JSON body; the spec code
    // is in the message field per the controller's contract.
    const body = response.body as { message?: string };
    expect(body.message).toBe('INVALID_FORMAT');
  });

  // ── Status / lookup errors ─────────────────────────────────────────

  it('returns 404 for a DRAFT sale (DB filters CONFIRMED at SQL layer)', async () => {
    const response = await request(app.getHttpServer() as SupertestApp)
      .get(`/sales/${fixtures.draftSaleId}/pdf`)
      .set('Authorization', 'Bearer tenant-a');

    // The repo's WHERE clause already filters `status: 'CONFIRMED'`,
    // so a DRAFT sale is indistinguishable from "not found" at the
    // SQL layer. Both collapse to a 404. The unit spec at
    // `pdf-generation.service.spec.ts` covers the in-service defensive
    // `BadRequestException('SALE_NOT_CONFIRMED')` branch for the case
    // where the upstream CONFIRMED filter is loosened.
    expect(response.status).toBe(404);
  });

  it('returns 404 for a sale id that does not exist', async () => {
    const ghostId = '99999999-9999-4999-8999-999999999999';
    const response = await request(app.getHttpServer() as SupertestApp)
      .get(`/sales/${ghostId}/pdf`)
      .set('Authorization', 'Bearer tenant-a');

    expect(response.status).toBe(404);
  });

  // ── Tenant isolation ───────────────────────────────────────────────

  it('returns 404 for a CONFIRMED sale that belongs to another tenant', async () => {
    // Authenticated as tenant A, requesting a sale that belongs to
    // tenant B. The repo's WHERE clause includes `tenantId`, so the
    // row is invisible to tenant A's query. Same outcome as a
    // genuinely missing id: 404. We MUST NOT leak the existence of
    // the cross-tenant sale.
    const response = await request(app.getHttpServer() as SupertestApp)
      .get(`/sales/${fixtures.otherTenantConfirmedSaleId}/pdf`)
      .set('Authorization', 'Bearer tenant-a');

    expect(response.status).toBe(404);
  });

  // ── Auth ───────────────────────────────────────────────────────────

  it('returns 401 without an Authorization header', async () => {
    const response = await request(app.getHttpServer() as SupertestApp).get(
      `/sales/${fixtures.confirmedSaleId}/pdf`,
    );

    expect(response.status).toBe(401);
  });

  // ── Tenant A can read its own sale (sanity check on the isolation
  //    test — confirms the cross-tenant 404 above is real, not a bug
  //    where the auth path blocks ALL requests) ───────────────────────

  it('sanity check — same-tenant CONFIRMED sale for tenant B is reachable as tenant B', async () => {
    const response = await request(app.getHttpServer() as SupertestApp)
      .get(`/sales/${fixtures.otherTenantConfirmedSaleId}/pdf?format=receipt-a4`)
      .set('Authorization', 'Bearer tenant-b');

    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="recibo-B-0001.pdf"',
    );
  });
});