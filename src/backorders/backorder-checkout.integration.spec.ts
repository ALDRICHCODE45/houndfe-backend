/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment -- supertest bodies and JSON payloads are untyped */
/**
 * restock-backorder / T3 — confirm a reserved backorder through the normal bot
 * checkout (`sale.items[i].backorderId`, contract v1 §7) against REAL
 * PostgreSQL.
 *
 * Boots the real `BackordersModule` graph (which pulls `ChatbotApiModule`, so
 * `POST /chatbot-api/checkouts` is the production route) with only the bot
 * credential repository replaced. The sweep is driven with `tick(now)` and a
 * fake clock; the checkout always uses the real clock. Cleanup deletes only
 * what it created.
 *
 * Proves:
 *   - happy path: sale at finalPriceCents, the reservation consumed with NO
 *     allocation to another backorder in between, sellable stock net zero,
 *     backorder CONFIRMED (saleId, confirmedAt, version + 1);
 *   - every error (404, NOT_RESERVED, EXPIRED, MISMATCH {field}, price);
 *   - the price-guard bypass belongs to a valid reservation only;
 *   - an expired lot: swapped, or lost (the feed item survives the failed checkout);
 *   - concurrency: checkout vs sweep expiry / bot cancel / allocator / a second
 *     checkout: exactly one wins, no double charge, no deadlock;
 *   - replay idempotency with backorderId; requests WITHOUT it are unchanged;
 *   - mixed carts, the pay-in-store hold, and stock returning to the queue when
 *     that sale is cancelled or its hold expires.
 */
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { createHash, randomUUID } from 'node:crypto';
import { ClsModule, ClsService } from 'nestjs-cls';
import request from 'supertest';
import {
  canonicalShipping,
  classifyBotShipping,
} from '../chatbot-api/application/bot-shipping';
import { computeCheckoutRequestHash } from '../chatbot-api/application/checkout.service';
import { SERVICE_CREDENTIAL_REPOSITORY } from '../chatbot-api/domain/service-credential.repository';
import { BOT_AUDIT_LOG_REPOSITORY } from '../chatbot-api/infrastructure/prisma-bot-audit-log.repository';
import { CheckoutRequestDto } from '../chatbot-api/presentation/dto/checkout.request';
import {
  BotCredentials,
  disconnectWorldPrisma,
  worldPrisma,
} from '../delivery-zones/test-support/delivery-zone-world';
import { StockJournalWriter } from '../inventory/infrastructure/stock-journal.writer';
import { SalesService } from '../sales/sales.service';
import { DomainExceptionFilter } from '../shared/filters/domain-exception.filter';
import { PrismaExceptionFilter } from '../shared/filters/prisma-exception.filter';
import { createAppValidationPipe } from '../shared/listing/app-validation.pipe';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
import { BackordersStaffService } from './application/backorders-staff.service';
import { BackordersModule } from './backorders.module';
import { BackorderError } from './domain/backorder-error';
import { BACKORDER_SCOPES } from './domain/backorder-scopes';
import { BackorderSweepScheduler } from './infrastructure/backorder-sweep.scheduler';

const SKIP =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const d = SKIP ? describe.skip : describe;

const DAY = 86_400_000;
const HOUR = 3_600_000;
const RESOLVED_AT = new Date(Date.now() - DAY);
const SYSTEM = { id: null, displayName: 'Sistema' };
const SCOPES = [
  BACKORDER_SCOPES.create,
  BACKORDER_SCOPES.read,
  BACKORDER_SCOPES.cancel,
  'customers:write',
  'sales:create',
  'sales:write',
];
const PRODUCT_NAME = 'Croquetas Adulto 18 kg';

d('backorder checkout — sale.items[i].backorderId (PostgreSQL)', () => {
  const prisma = worldPrisma();
  const credentials = new BotCredentials();
  const tenantIds: string[] = [];
  const userIds: string[] = [];
  const createdPriceListIds: string[] = [];
  let app: INestApplication;
  let publicListId: string;
  let cls: ClsService<TenantClsStore>;
  let tenantPrisma: TenantPrismaService;
  let writer: StockJournalWriter;
  let sweep: BackorderSweepScheduler;
  let sales: SalesService;
  let staffBackorders: BackordersStaffService;

  beforeAll(async () => {
    const existingDefault = await prisma.globalPriceList.findFirst({
      where: { isDefault: true },
    });
    if (existingDefault) {
      publicListId = existingDefault.id;
    } else {
      const created = await prisma.globalPriceList.create({
        data: { name: `PUBLICO-bo-checkout-${randomUUID()}`, isDefault: true },
      });
      createdPriceListIds.push(created.id);
      publicListId = created.id;
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              PROMOTIONS_BUSINESS_TIMEZONE: 'America/Mexico_City',
              JWT_SECRET: 'backorder-checkout-test-secret',
              JWT_REFRESH_SECRET: 'backorder-checkout-test-refresh',
              SPACES_BUCKET: 'unused',
              SPACES_ENDPOINT: 'https://unused.invalid',
              SPACES_REGION: 'unused',
              SPACES_ACCESS_KEY_ID: 'unused',
              SPACES_SECRET_ACCESS_KEY: 'unused',
              SPACES_PUBLIC_BASE_URL: 'https://unused.invalid',
              SPACES_UPLOAD_MAX_MB: '5',
            }),
          ],
        }),
        EventEmitterModule.forRoot(),
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        DatabaseModule,
        BackordersModule,
      ],
    })
      .overrideProvider(SERVICE_CREDENTIAL_REPOSITORY)
      .useValue(credentials.repository)
      // The audit rows reference a persisted credential; the in-memory one has none.
      .overrideProvider(BOT_AUDIT_LOG_REPOSITORY)
      .useValue({ append: () => Promise.resolve() })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createAppValidationPipe());
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new PrismaExceptionFilter(),
    );
    await app.init();
    const get = <T>(token: new (...args: never[]) => T): T =>
      moduleRef.get(token, { strict: false });
    cls = moduleRef.get(ClsService, { strict: false });
    tenantPrisma = get(TenantPrismaService);
    writer = get(StockJournalWriter);
    sweep = get(BackorderSweepScheduler);
    sales = get(SalesService);
    staffBackorders = get(BackordersStaffService);
  });

  /**
   * The sweep is cross-tenant: with a fake clock in the future it would also
   * expire the reservations of every earlier test, so each test removes its own
   * tenants (cascade).
   */
  async function dropTenants(): Promise<void> {
    if (tenantIds.length === 0) return;
    const ids = tenantIds.splice(0);
    await prisma.outboxEvent.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.backorder.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
  }

  afterEach(dropTenants);

  afterAll(async () => {
    await app?.close();
    await dropTenants();
    if (userIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    if (createdPriceListIds.length > 0) {
      await prisma.globalPriceList.deleteMany({
        where: { id: { in: createdPriceListIds } },
      });
    }
    await disconnectWorldPrisma();
  });

  // ---------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------

  interface World {
    tenantId: string;
    token: string;
    /** The backorder product: list price 1000. */
    productId: string;
    /** An ordinary product: list price 500, stock 10. */
    otherProductId: string;
    decisionId: string;
    staffId: string;
    customers: string[];
  }

  const phoneOf = (n: number) => ({
    phoneCountryCode: '52',
    phone: `55123499${String(n).padStart(2, '0')}`,
  });

  async function world(
    options: { quantity?: number; lots?: boolean } = {},
  ): Promise<World> {
    const tenantId = randomUUID();
    tenantIds.push(tenantId);
    await prisma.tenant.create({
      data: {
        id: tenantId,
        name: `Sucursal ${tenantId.slice(0, 6)}`,
        slug: `bc-${tenantId}`,
      },
    });
    const productId = randomUUID();
    const otherProductId = randomUUID();
    await prisma.product.create({
      data: {
        id: productId,
        tenantId,
        name: PRODUCT_NAME,
        useStock: true,
        quantity: options.quantity ?? 0,
        useLotsAndExpirations: options.lots ?? false,
      },
    });
    await prisma.product.create({
      data: {
        id: otherProductId,
        tenantId,
        name: 'Collar',
        useStock: true,
        quantity: 10,
      },
    });
    for (const [id, priceCents] of [
      [productId, 1000],
      [otherProductId, 500],
    ] as const) {
      await prisma.priceList.create({
        data: {
          tenantId,
          productId: id,
          globalPriceListId: publicListId,
          priceCents,
        },
      });
    }
    const customers: string[] = [];
    for (let n = 1; n <= 8; n++) {
      const id = randomUUID();
      await prisma.customer.create({
        data: { id, tenantId, firstName: `Cliente${n}`, ...phoneOf(n) },
      });
      customers.push(id);
    }
    const decision = await prisma.humanDecision.create({
      data: {
        tenantId,
        source: 'houndfe-chatbot',
        sourceRequestId: randomUUID(),
        type: 'RESTOCK',
        canonicalRequestHash: 'h'.repeat(64),
        submittedCredentialId: 'cred',
        branchId: tenantId,
        branchName: 'Centro',
        productId,
        productName: 'Croquetas',
        variantId: null,
        status: 'RESOLVED',
        version: 2,
        resolutionAction: 'PROVIDE_RESTOCK_ESTIMATE',
        restockDays: 7,
        resolutionRequestId: randomUUID(),
        resolvedAt: RESOLVED_AT,
        resolvedByActorId: 'actor',
        resolvedByDisplayName: 'Gerente',
      },
    });
    return {
      tenantId,
      token: credentials.register(tenantId, SCOPES),
      productId,
      otherProductId,
      decisionId: decision.id,
      staffId: await staffUser(tenantId),
      customers,
    };
  }

  /** The cashier of the bot sales: a member of the tenant. */
  async function staffUser(tenantId: string): Promise<string> {
    const userId = randomUUID();
    userIds.push(userId);
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@bo-checkout.invalid`,
        name: 'Ana Pérez',
        hashedPassword: 'not-a-login-hash',
        isActive: true,
      },
    });
    const role = await prisma.role.create({
      data: { tenantId, name: `Cashier ${userId}` },
    });
    await prisma.tenantMembership.create({
      data: { tenantId, userId, roleId: role.id },
    });
    return userId;
  }

  /** WAITING backorders in queue order (scheduledAt strictly increasing). */
  async function waiting(
    w: World,
    specs: Array<{
      quantity: number;
      referencePriceCents?: number;
      customer?: number;
    }>,
  ) {
    const base = Date.now() - 10 * HOUR;
    const rows: Array<Awaited<ReturnType<typeof prisma.backorder.create>>> = [];
    for (const [i, spec] of specs.entries()) {
      rows.push(
        await prisma.backorder.create({
          data: {
            tenantId: w.tenantId,
            folio: `BO-${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
            customerId: w.customers[spec.customer ?? i],
            productId: w.productId,
            variantId: null,
            quantity: spec.quantity,
            referencePriceCents: spec.referencePriceCents ?? 1000,
            scheduledAt: new Date(base + i * 1000),
            estimatedArrivalDays: 7,
            estimatedAt: new Date(Date.now() + 7 * DAY),
            sourceDecisionId: w.decisionId,
            idempotencyKey: randomUUID(),
            requestHash: 'a'.repeat(64),
          },
        }),
      );
    }
    return rows;
  }

  const inTenant = <T>(w: World, work: () => T): T =>
    cls.runWith(
      { tenantId: w.tenantId, userId: w.staffId, isSuperAdmin: false },
      work,
    );
  const inTx = <T>(w: World, work: () => Promise<T>): Promise<T> =>
    inTenant(w, () => tenantPrisma.runInTransaction(work));

  /** An arrival on the untracked bucket: the allocator runs in the same tx. */
  const arrive = (w: World, delta: number) =>
    inTx(w, () =>
      writer.apply(
        [
          {
            bucket: { kind: 'PRODUCT_UNTRACKED', productId: w.productId },
            delta,
          },
        ],
        {
          type: 'ADJUSTMENT',
          groupType: 'ADJUSTMENT',
          groupId: randomUUID(),
          actor: SYSTEM,
        },
      ),
    );

  const dateOnly = (offsetDays: number) => {
    const t = new Date();
    return new Date(
      Date.UTC(
        t.getUTCFullYear(),
        t.getUTCMonth(),
        t.getUTCDate() + offsetDays,
      ),
    );
  };
  const lot = (w: World, lotNumber: string, expiresInDays: number) =>
    prisma.lot.create({
      data: {
        tenantId: w.tenantId,
        productId: w.productId,
        lotNumber,
        quantity: 0,
        expirationDate: dateOnly(expiresInDays),
      },
    });
  const arriveInLot = (w: World, lotId: string, delta: number) =>
    inTx(w, () =>
      writer.apply(
        [{ bucket: { kind: 'LOT', productId: w.productId, lotId }, delta }],
        {
          type: 'ADJUSTMENT',
          groupType: 'ADJUSTMENT',
          groupId: randomUUID(),
          actor: SYSTEM,
        },
      ),
    );

  /** A RESERVED backorder: waiting + the arrival that reserves it (real flow). */
  async function reserved(
    w: World,
    quantity: number,
    referencePriceCents = 1000,
    customer = 0,
  ) {
    const [row] = await waiting(w, [
      { quantity, referencePriceCents, customer },
    ]);
    await arrive(w, quantity);
    const current = await backorder(row.id);
    expect(current.status).toBe('RESERVED');
    return current;
  }

  const backorder = (id: string) =>
    prisma.backorder.findUniqueOrThrow({ where: { id } });
  const quantityOf = async (productId: string) =>
    (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
      .quantity;
  const salesOf = (w: World) =>
    prisma.sale.findMany({
      where: { tenantId: w.tenantId },
      include: { items: true },
    });
  const movements = (w: World, productId = w.productId) =>
    prisma.stockMovement.findMany({
      where: { tenantId: w.tenantId, productId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  const sum = (rows: Array<{ type: string; delta: number }>, type: string) =>
    rows.filter((r) => r.type === type).reduce((s, r) => s + r.delta, 0);
  const count = (rows: Array<{ type: string }>, type: string) =>
    rows.filter((r) => r.type === type).length;
  const feed = (w: World, type: string, backorderId?: string) =>
    prisma.chatbotFeedItem.findMany({
      where: {
        tenantId: w.tenantId,
        type,
        ...(backorderId ? { backorderId } : { backorderId: { not: null } }),
      },
    });
  const receipts = (w: World) =>
    prisma.saleIdempotency.findMany({ where: { tenantId: w.tenantId } });
  const deadlocks = (results: PromiseSettledResult<unknown>[]) =>
    results.filter(
      (r) =>
        r.status === 'rejected' &&
        /deadlock|40P01/i.test(
          String((r.reason as Error)?.message ?? r.reason),
        ),
    );

  interface Line {
    productId?: string;
    variantId?: string;
    quantity: number;
    unitPriceCents: number;
    backorderId?: string;
  }
  const line = (w: World, l: Line) => ({
    productId: l.productId ?? w.productId,
    productName: l.productId === w.otherProductId ? 'Collar' : PRODUCT_NAME,
    ...(l.variantId !== undefined ? { variantId: l.variantId } : {}),
    quantity: l.quantity,
    unitPriceCents: l.unitPriceCents,
    ...(l.backorderId !== undefined ? { backorderId: l.backorderId } : {}),
  });
  const checkoutBody = (
    w: World,
    lines: Line[],
    expectedTotalCents: number,
    customer = 0,
  ) => ({
    ...phoneOf(customer + 1),
    customer: { mode: 'existing', customerId: w.customers[customer] },
    sale: {
      cashierUserId: w.staffId,
      items: lines.map((l) => line(w, l)),
      expectedTotalCents,
      shipping: { mode: 'pickup' },
    },
  });
  const post = (w: World, key: string, body: object) =>
    request(app.getHttpServer())
      .post('/chatbot-api/checkouts')
      .set('Authorization', `Bearer ${w.token}`)
      .set('X-Idempotency-Key', key)
      .send(body);
  /** The checkout of a backorder at its frozen price (customer = the backorder's). */
  const confirm = (
    w: World,
    b: { id: string; quantity: number; finalPriceCents: number | null },
    key = randomUUID(),
    customer = 0,
  ) =>
    post(
      w,
      key,
      checkoutBody(
        w,
        [
          {
            quantity: b.quantity,
            unitPriceCents: b.finalPriceCents ?? 0,
            backorderId: b.id,
          },
        ],
        b.quantity * (b.finalPriceCents ?? 0),
        customer,
      ),
    );
  const cancel = (w: World, id: string) =>
    request(app.getHttpServer())
      .post(`/chatbot-api/backorders/${id}/cancel`)
      .set('Authorization', `Bearer ${w.token}`)
      .send({});
  const expectError = (
    res: request.Response,
    status: number,
    code: string,
    detail: Record<string, unknown> = {},
  ) => {
    expect(res.status).toBe(status);
    expect(res.body).toEqual({
      statusCode: status,
      error: code,
      message: code,
      ...detail,
    });
  };
  /** Nothing was sold or charged by a refused checkout. */
  const expectUntouched = async (w: World, quantityBefore: number) => {
    expect(await salesOf(w)).toEqual([]);
    expect(await receipts(w)).toEqual([]);
    expect(await quantityOf(w.productId)).toBe(quantityBefore);
    expect(count(await movements(w), 'SALE')).toBe(0);
    expect(count(await movements(w), 'BACKORDER_RELEASE')).toBe(0);
  };

  // ---------------------------------------------------------------------------
  // Happy path (§7.1–7.4)
  // ---------------------------------------------------------------------------

  describe('happy path', () => {
    it('sells the reserved units at finalPriceCents, consumes the reservation without allocating it to the next backorder, and confirms the backorder', async () => {
      const w = await world();
      // Reference 800 < list 1000 => final 800; a second one waits.
      const [a, b] = await waiting(w, [
        { quantity: 2, referencePriceCents: 800 },
        { quantity: 2 }, // would fit the released units if they were re-allocated
      ]);
      await arrive(w, 2);
      const before = await backorder(a.id);
      expect(before).toMatchObject({
        status: 'RESERVED',
        finalPriceCents: 800,
      });
      expect((await backorder(b.id)).status).toBe('WAITING');
      expect(await quantityOf(w.productId)).toBe(0);

      const res = await confirm(w, before);

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        status: 'created',
        customer: { customerId: w.customers[0], resolution: 'existing' },
        sale: {
          paymentStatus: 'CREDIT',
          channel: 'ONLINE',
          totalCents: 1600,
          discountCents: 0,
          debtCents: 1600,
        },
      });
      const [sale] = await salesOf(w);
      expect(sale).toMatchObject({
        id: res.body.sale.saleId,
        status: 'CONFIRMED',
        totalCents: 1600,
        customerId: w.customers[0],
      });
      expect(sale.items).toHaveLength(1);
      expect(sale.items[0]).toMatchObject({
        productId: w.productId,
        quantity: 2,
        unitPriceCents: 800,
        priceSource: 'CUSTOM',
        customPriceCents: 800,
        discountType: null,
        promotionId: null,
      });

      const after = await backorder(a.id);
      expect(after).toMatchObject({
        status: 'CONFIRMED',
        saleId: sale.id,
        version: before.version + 1,
      });
      expect(after.confirmedAt).toBeInstanceOf(Date);
      // Net zero on the sellable stock, and the next backorder was NOT served
      // with the released units.
      expect(await quantityOf(w.productId)).toBe(0);
      expect((await backorder(b.id)).status).toBe('WAITING');
      const rows = await movements(w);
      expect(count(rows, 'BACKORDER_RESERVE')).toBe(1);
      expect(sum(rows, 'BACKORDER_RELEASE')).toBe(2);
      expect(sum(rows, 'SALE')).toBe(-2);
      expect(rows.filter((r) => r.groupId === sale.id)).toHaveLength(1);
      expect(rows.filter((r) => r.groupId === b.id).map((r) => r.type)).toEqual(
        [],
      );
      // The sellable stock never changed for anybody else: reserve, release and sale cancel out.
      expect(rows.reduce((total, r) => total + r.delta, 0)).toBe(0);
      expect(rows.map((r) => r.type).sort()).toEqual(
        ['ADJUSTMENT', 'BACKORDER_RELEASE', 'BACKORDER_RESERVE', 'SALE'].sort(),
      );
      // Receipt stored with the sale.
      const [receipt] = await receipts(w);
      expect(receipt).toMatchObject({ status: 'SUCCEEDED', saleId: sale.id });
    });

    it('an already confirmed backorder cannot be sold twice (a second key answers BACKORDER_NOT_RESERVED {CONFIRMED})', async () => {
      const w = await world();
      const a = await reserved(w, 2);
      expect((await confirm(w, a)).status).toBe(201);

      const second = await confirm(w, a);

      expectError(second, 409, 'BACKORDER_NOT_RESERVED', {
        status: 'CONFIRMED',
      });
      expect(await salesOf(w)).toHaveLength(1);
      expect(sum(await movements(w), 'SALE')).toBe(-2);
    });

    it('mixed cart: the backorder line keeps its frozen price, the ordinary line its list price, both are charged', async () => {
      const w = await world();
      const a = await reserved(w, 2, 800); // final 800
      const stockBefore = await quantityOf(w.otherProductId);

      const res = await post(
        w,
        randomUUID(),
        checkoutBody(
          w,
          [
            { productId: w.otherProductId, quantity: 3, unitPriceCents: 500 },
            { quantity: 2, unitPriceCents: 800, backorderId: a.id },
          ],
          3 * 500 + 2 * 800,
        ),
      );

      expect(res.status).toBe(201);
      expect(res.body.sale.totalCents).toBe(3100);
      const [sale] = await salesOf(w);
      expect(sale.items).toHaveLength(2);
      expect(
        sale.items.find((i) => i.productId === w.otherProductId),
      ).toMatchObject({ unitPriceCents: 500, priceSource: 'PRICE_LIST' });
      expect(sale.items.find((i) => i.productId === w.productId)).toMatchObject(
        { unitPriceCents: 800, priceSource: 'CUSTOM' },
      );
      expect(await quantityOf(w.otherProductId)).toBe(stockBefore - 3);
      expect(await quantityOf(w.productId)).toBe(0);
      expect((await backorder(a.id)).status).toBe('CONFIRMED');
    });

    it('a mixed cart whose expectedTotalCents ignores the backorder line is a PROMO_RE_QUOTE and changes nothing', async () => {
      const w = await world();
      const a = await reserved(w, 2, 800);

      const res = await post(
        w,
        randomUUID(),
        checkoutBody(
          w,
          [
            { productId: w.otherProductId, quantity: 3, unitPriceCents: 500 },
            { quantity: 2, unitPriceCents: 800, backorderId: a.id },
          ],
          3 * 500,
        ),
      );

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('PROMO_RE_QUOTE');
      expect((await backorder(a.id)).status).toBe('RESERVED');
      expect(await salesOf(w)).toEqual([]);
      expect(await quantityOf(w.otherProductId)).toBe(10);
    });

    it('an active automatic promotion is NOT applied again to the backorder line (owner Q3), only to the ordinary lines beside it', async () => {
      const w = await world();
      const a = await reserved(w, 2, 800); // final 800, frozen before the promotion
      await prisma.promotion.create({
        data: {
          tenantId: w.tenantId,
          title: 'Diez por ciento',
          type: 'ORDER_DISCOUNT',
          method: 'AUTOMATIC',
          botEligible: true,
          discountType: 'PERCENTAGE',
          discountValue: 10,
        },
      });

      // Backorder line alone: no promotion at all.
      const alone = await confirm(w, a);
      expect(alone.status).toBe(201);
      expect(alone.body.sale.totalCents).toBe(1600);
      expect(alone.body.sale.discountCents).toBe(0);

      // Beside an ordinary line: 10 % off the ordinary 1500 only (base excludes the backorder line).
      const b = await reserved(w, 2, 800, 1);
      const mixed = await post(
        w,
        randomUUID(),
        checkoutBody(
          w,
          [
            { productId: w.otherProductId, quantity: 3, unitPriceCents: 500 },
            { quantity: 2, unitPriceCents: 800, backorderId: b.id },
          ],
          1350 + 1600,
          1,
        ),
      );
      expect(mixed.status).toBe(201);
      expect(mixed.body.sale).toMatchObject({
        totalCents: 2950,
        discountCents: 150,
      });
      const backorderLine = (await salesOf(w))
        .flatMap((sale) => sale.items)
        .filter((item) => item.unitPriceCents === 800);
      expect(backorderLine).toHaveLength(2);
      for (const item of backorderLine) {
        expect(item).toMatchObject({ discountType: null, promotionId: null });
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Errors (§7.1, §7.2, §7.3)
  // ---------------------------------------------------------------------------

  describe('errors', () => {
    it('404 BACKORDER_NOT_FOUND for an unknown id and for another sucursal’s backorder', async () => {
      const w = await world();
      const other = await world();
      const foreign = await reserved(other, 2);
      await reserved(w, 2);

      expectError(
        await confirm(w, {
          id: randomUUID(),
          quantity: 2,
          finalPriceCents: 1000,
        }),
        404,
        'BACKORDER_NOT_FOUND',
      );
      expectError(await confirm(w, foreign), 404, 'BACKORDER_NOT_FOUND');
      expect((await backorder(foreign.id)).status).toBe('RESERVED');
      await expectUntouched(w, 0);
    });

    it.each([['WAITING'], ['CANCELLED'], ['EXPIRED']] as const)(
      '409 BACKORDER_NOT_RESERVED {status: %s}',
      async (status) => {
        const w = await world();
        const [a] = await waiting(w, [{ quantity: 2 }]);
        if (status !== 'WAITING') {
          await prisma.backorder.update({
            where: { id: a.id },
            data:
              status === 'CANCELLED'
                ? {
                    status,
                    cancelledAt: new Date(),
                    cancelledByKind: 'CUSTOMER',
                  }
                : { status, expiredAt: new Date() },
          });
        }

        const res = await confirm(w, { ...a, finalPriceCents: 1000 });

        expectError(res, 409, 'BACKORDER_NOT_RESERVED', { status });
        await expectUntouched(w, 0);
      },
    );

    it('409 BACKORDER_RESERVATION_EXPIRED once reservedUntil passed, even before the sweep ran; nothing changes', async () => {
      const w = await world();
      const a = await reserved(w, 2);
      await prisma.backorder.update({
        where: { id: a.id },
        data: { reservedUntil: new Date(Date.now() - 1000) },
      });

      const res = await confirm(w, a);

      expectError(res, 409, 'BACKORDER_RESERVATION_EXPIRED');
      const row = await backorder(a.id);
      expect(row.status).toBe('RESERVED'); // the sweep expires it, not the checkout
      expect(row.version).toBe(a.version);
      await expectUntouched(w, 0);
    });

    it.each([['customerId'], ['productId'], ['quantity']] as const)(
      '409 BACKORDER_MISMATCH {field: %s}',
      async (field) => {
        const w = await world();
        const a = await reserved(w, 2);
        const lineFor = (l: Partial<Line>) => ({
          quantity: 2,
          unitPriceCents: 1000,
          backorderId: a.id,
          ...l,
        });
        const body =
          field === 'customerId'
            ? checkoutBody(w, [lineFor({})], 2000, 1) // customer #2 sends customer #1's backorder
            : field === 'productId'
              ? checkoutBody(
                  w,
                  [
                    lineFor({
                      productId: w.otherProductId,
                      unitPriceCents: 500,
                    }),
                  ],
                  1000,
                )
              : checkoutBody(w, [lineFor({ quantity: 1 })], 1000);

        const res = await post(w, randomUUID(), body);

        expectError(res, 409, 'BACKORDER_MISMATCH', { field });
        expect((await backorder(a.id)).status).toBe('RESERVED');
        await expectUntouched(w, 0);
      },
    );

    it('409 BACKORDER_MISMATCH {variantId} when the line names a variant the backorder does not have', async () => {
      const w = await world();
      const a = await reserved(w, 2);
      const variantId = randomUUID();
      await prisma.product.update({
        where: { id: w.productId },
        data: { hasVariants: true },
      });
      await prisma.variant.create({
        data: {
          id: variantId,
          tenantId: w.tenantId,
          productId: w.productId,
          name: '3 kg',
          quantity: 5,
        },
      });

      const res = await post(
        w,
        randomUUID(),
        checkoutBody(
          w,
          [{ quantity: 2, unitPriceCents: 1000, backorderId: a.id, variantId }],
          2000,
        ),
      );

      expectError(res, 409, 'BACKORDER_MISMATCH', { field: 'variantId' });
      expect((await backorder(a.id)).status).toBe('RESERVED');
    });

    it('409 PRICE_OUT_OF_DATE {currentPriceCents} when unitPriceCents is not finalPriceCents — also when it is the list price', async () => {
      const w = await world();
      const a = await reserved(w, 2, 800); // final 800, list 1000

      for (const unitPriceCents of [1000, 799, 801, 0]) {
        const res = await post(
          w,
          randomUUID(),
          checkoutBody(
            w,
            [{ quantity: 2, unitPriceCents, backorderId: a.id }],
            2 * unitPriceCents,
          ),
        );
        expectError(res, 409, 'PRICE_OUT_OF_DATE', { currentPriceCents: 800 });
      }
      expect((await backorder(a.id)).status).toBe('RESERVED');
      await expectUntouched(w, 0);
    });

    it('the frozen price opens NOTHING without a valid reservation: the same price without backorderId is PRICE_OUT_OF_DATE', async () => {
      const w = await world({ quantity: 5 });

      const res = await post(
        w,
        randomUUID(),
        checkoutBody(w, [{ quantity: 2, unitPriceCents: 800 }], 1600),
      );

      expectError(res, 409, 'PRICE_OUT_OF_DATE');
      await expectUntouched(w, 5);
    });

    it('the bypass is per line: an ordinary line beside a valid backorder line still needs the list price', async () => {
      const w = await world();
      const a = await reserved(w, 2, 800);

      const res = await post(
        w,
        randomUUID(),
        checkoutBody(
          w,
          [
            { productId: w.otherProductId, quantity: 1, unitPriceCents: 400 },
            { quantity: 2, unitPriceCents: 800, backorderId: a.id },
          ],
          400 + 1600,
        ),
      );

      expectError(res, 409, 'PRICE_OUT_OF_DATE');
      expect((await backorder(a.id)).status).toBe('RESERVED');
      expect(await salesOf(w)).toEqual([]);
    });

    it('400 INVALID_CHECKOUT_REQUEST for a malformed backorderId and for the same backorder twice in one cart', async () => {
      const w = await world();
      const a = await reserved(w, 2);

      for (const items of [
        [{ quantity: 2, unitPriceCents: 1000, backorderId: 'nope' }],
        [
          { quantity: 1, unitPriceCents: 1000, backorderId: a.id },
          { quantity: 1, unitPriceCents: 1000, backorderId: a.id },
        ],
      ]) {
        const res = await post(w, randomUUID(), checkoutBody(w, items, 2000));
        expectError(res, 400, 'INVALID_CHECKOUT_REQUEST');
      }
      expect((await backorder(a.id)).status).toBe('RESERVED');
    });

    it('409 BACKORDER_RESERVATION_UNAVAILABLE (and an error log) when a RESERVED backorder holds nothing in the journal; nothing changes', async () => {
      const w = await world({ quantity: 5 });
      const [a] = await waiting(w, [{ quantity: 2 }]);
      await prisma.backorder.update({
        where: { id: a.id },
        data: {
          status: 'RESERVED',
          reservedAt: new Date(),
          reservedUntil: new Date(Date.now() + HOUR),
          reminderAt: new Date(Date.now() + HOUR / 2),
          currentPriceCents: 1000,
          finalPriceCents: 1000,
        },
      });

      const res = await confirm(w, { ...a, finalPriceCents: 1000 });

      expectError(res, 409, 'BACKORDER_RESERVATION_UNAVAILABLE');
      expect((await backorder(a.id)).status).toBe('RESERVED');
      await expectUntouched(w, 5);
    });

    it('a refused checkout leaves its key retryable', async () => {
      const w = await world();
      const a = await reserved(w, 2, 800);
      const key = randomUUID();

      expect(
        (
          await post(
            w,
            key,
            checkoutBody(
              w,
              [{ quantity: 2, unitPriceCents: 1000, backorderId: a.id }],
              2000,
            ),
          )
        ).status,
      ).toBe(409);
      const retry = await confirm(w, a, key);

      expect(retry.status).toBe(201);
      expect((await backorder(a.id)).status).toBe('CONFIRMED');
    });
  });

  // ---------------------------------------------------------------------------
  // Expired lots (Q6)
  // ---------------------------------------------------------------------------

  describe('a reserved lot that expired (owner Q6)', () => {
    it('is swapped for a valid lot: the sale takes the valid lot, never the expired one', async () => {
      const w = await world({ lots: true });
      const lotA = await lot(w, 'A', 2);
      const lotB = await lot(w, 'B', 60);
      const [a] = await waiting(w, [{ quantity: 4 }]);
      await arriveInLot(w, lotA.id, 4); // reserved from lot A
      await arriveInLot(w, lotB.id, 10);
      const reservedRow = await backorder(a.id);
      expect(reservedRow.status).toBe('RESERVED');
      await prisma.lot.update({
        where: { id: lotA.id },
        data: { expirationDate: dateOnly(-3) }, // A expired after the reservation
      });

      const res = await confirm(w, reservedRow);

      expect(res.status).toBe(201);
      expect((await backorder(a.id)).status).toBe('CONFIRMED');
      const rows = await movements(w);
      const saleRows = rows.filter((r) => r.type === 'SALE');
      expect(saleRows.map((r) => [r.lotId, r.delta])).toEqual([[lotB.id, -4]]);
      // The expired lot got its 4 units back and keeps them (unsellable).
      expect(
        (await prisma.lot.findUniqueOrThrow({ where: { id: lotA.id } }))
          .quantity,
      ).toBe(4);
      expect(
        (await prisma.lot.findUniqueOrThrow({ where: { id: lotB.id } }))
          .quantity,
      ).toBe(6);
      // A silent swap: no feed item.
      expect(await feed(w, 'backorder.reservation_lost')).toEqual([]);
    });

    it('is LOST when no valid lot covers it: 409 BACKORDER_RESERVATION_LOST, the backorder is back to WAITING with its place, and backorder.reservation_lost SURVIVES the failed checkout', async () => {
      const w = await world({ lots: true });
      const lotA = await lot(w, 'A', 2);
      const lotB = await lot(w, 'B', 60);
      const [a] = await waiting(w, [{ quantity: 4 }]);
      await arriveInLot(w, lotA.id, 4);
      await arriveInLot(w, lotB.id, 1); // not enough to swap
      const reservedRow = await backorder(a.id);
      await prisma.lot.update({
        where: { id: lotA.id },
        data: { expirationDate: dateOnly(-3) },
      });
      const key = randomUUID();

      const res = await confirm(w, reservedRow, key);

      expectError(res, 409, 'BACKORDER_RESERVATION_LOST');
      const lost = await backorder(a.id);
      expect(lost).toMatchObject({
        status: 'WAITING',
        reservedUntil: null,
        reservationStage: 0,
        version: reservedRow.version + 1,
      });
      expect(lost.scheduledAt).toEqual(reservedRow.scheduledAt);
      // The checkout rolled back (no sale, no receipt, no SALE row) but the
      // transition and its feed item were committed on their own.
      expect(await salesOf(w)).toEqual([]);
      expect(await receipts(w)).toEqual([]);
      expect(count(await movements(w), 'SALE')).toBe(0);
      const items = await feed(w, 'backorder.reservation_lost', a.id);
      expect(items).toHaveLength(1);
      expect(items[0].payload).toMatchObject({
        backorderId: a.id,
        reason: 'LOT_EXPIRED',
        queuePosition: 1,
        version: lost.version,
      });
      // The expired units are back in the (expired) lot A.
      expect(
        (await prisma.lot.findUniqueOrThrow({ where: { id: lotA.id } }))
          .quantity,
      ).toBe(4);

      // Retrying (even with the same key) is a plain NOT_RESERVED; no second item.
      expectError(
        await confirm(w, reservedRow, key),
        409,
        'BACKORDER_NOT_RESERVED',
        {
          status: 'WAITING',
        },
      );
      expect(await feed(w, 'backorder.reservation_lost', a.id)).toHaveLength(1);
    });

    it('a lost reservation of a mixed cart leaves the ordinary line unsold too (nothing is charged)', async () => {
      const w = await world({ lots: true });
      const lotA = await lot(w, 'A', 2);
      const [a] = await waiting(w, [{ quantity: 4 }]);
      await arriveInLot(w, lotA.id, 4);
      await prisma.lot.update({
        where: { id: lotA.id },
        data: { expirationDate: dateOnly(-3) },
      });

      const res = await post(
        w,
        randomUUID(),
        checkoutBody(
          w,
          [
            { productId: w.otherProductId, quantity: 2, unitPriceCents: 500 },
            { quantity: 4, unitPriceCents: 1000, backorderId: a.id },
          ],
          1000 + 4000,
        ),
      );

      expectError(res, 409, 'BACKORDER_RESERVATION_LOST');
      expect(await salesOf(w)).toEqual([]);
      expect(await quantityOf(w.otherProductId)).toBe(10);
      expect(await feed(w, 'backorder.reservation_lost', a.id)).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Concurrency (item 4)
  // ---------------------------------------------------------------------------

  describe('concurrency', () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const FAR = () => new Date(Date.now() + 25 * HOUR);

    /** The exactly-one-wins invariant of a checkout racing a release path. */
    async function expectOneWinner(
      w: World,
      a: { id: string; quantity: number },
      checkoutStatus: number,
      other: 'EXPIRED' | 'CANCELLED',
    ) {
      const row = await backorder(a.id);
      const rows = await movements(w);
      const saleCount = (await salesOf(w)).length;
      if (checkoutStatus === 201) {
        expect(row.status).toBe('CONFIRMED');
        expect(saleCount).toBe(1);
        expect(sum(rows, 'SALE')).toBe(-a.quantity);
        // Consumed: nothing returned to the shelf, nothing double charged.
        expect(await quantityOf(w.productId)).toBe(0);
        expect(sum(rows, 'BACKORDER_RELEASE')).toBe(a.quantity);
        expect(await feed(w, 'backorder.reservation_expired', a.id)).toEqual(
          [],
        );
        return 'checkout' as const;
      }
      expect(checkoutStatus).toBe(409);
      expect(row.status).toBe(other);
      expect(saleCount).toBe(0);
      expect(count(rows, 'SALE')).toBe(0);
      // Released exactly once, units back on the shelf.
      expect(sum(rows, 'BACKORDER_RELEASE')).toBe(a.quantity);
      expect(count(rows, 'BACKORDER_RELEASE')).toBe(1);
      expect(await quantityOf(w.productId)).toBe(a.quantity);
      return 'other' as const;
    }

    it('checkout vs the sweep expiring the same reservation: exactly one wins, no double charge, no deadlock (several interleavings)', async () => {
      const wins = { checkout: 0, other: 0 };
      for (const delay of [0, 0, 2, 5, 9, 14, 20, 30, 45, 60]) {
        const w = await world();
        const a = await reserved(w, 2);

        const results = await Promise.allSettled([
          confirm(w, a).then((r) => r),
          sleep(delay).then(() => sweep.tick(FAR())),
        ]);

        expect(deadlocks(results)).toEqual([]);
        expect(results.map((r) => r.status)).toEqual([
          'fulfilled',
          'fulfilled',
        ]);
        const checkout = (
          results[0] as PromiseFulfilledResult<request.Response>
        ).value;
        if (checkout.status === 409) {
          expect(checkout.body.error).toBe('BACKORDER_NOT_RESERVED');
          expect(checkout.body.status).toBe('EXPIRED');
        }
        wins[await expectOneWinner(w, a, checkout.status, 'EXPIRED')] += 1;
        await dropTenants();
      }
      expect(wins.checkout + wins.other).toBe(10);
    });

    it('sweep first: the checkout is refused with NOT_RESERVED {EXPIRED}; checkout first: the sweep leaves the CONFIRMED backorder alone', async () => {
      const first = await world();
      const a = await reserved(first, 2);
      await sweep.tick(FAR());
      expectError(await confirm(first, a), 409, 'BACKORDER_NOT_RESERVED', {
        status: 'EXPIRED',
      });
      expect(await expectOneWinner(first, a, 409, 'EXPIRED')).toBe('other');
      await dropTenants();

      const second = await world();
      const b = await reserved(second, 2);
      expect((await confirm(second, b)).status).toBe(201);
      await sweep.tick(FAR());
      expect(await expectOneWinner(second, b, 201, 'EXPIRED')).toBe('checkout');
    });

    it('checkout vs the bot cancelling the same reservation: exactly one wins, no double charge, no deadlock (several interleavings)', async () => {
      for (const delay of [0, 0, 2, 5, 9, 14, 20, 30, 45, 60]) {
        const w = await world();
        const a = await reserved(w, 2);

        const results = await Promise.allSettled([
          confirm(w, a),
          sleep(delay).then(() => cancel(w, a.id)),
        ]);

        expect(deadlocks(results)).toEqual([]);
        const checkout = (
          results[0] as PromiseFulfilledResult<request.Response>
        ).value;
        const cancelled = (
          results[1] as PromiseFulfilledResult<request.Response>
        ).value;
        if (checkout.status === 201) {
          expectError(cancelled, 409, 'BACKORDER_NOT_CANCELLABLE', {
            status: 'CONFIRMED',
          });
        } else {
          expectError(checkout, 409, 'BACKORDER_NOT_RESERVED', {
            status: 'CANCELLED',
          });
          expect(cancelled.status).toBe(200);
        }
        await expectOneWinner(w, a, checkout.status, 'CANCELLED');
        await dropTenants();
      }
    });

    /**
     * POS cancel (`POST /backorders/:id/cancel`) through the real service with
     * the version the POS saw. A domain refusal is a value (never a throw), any
     * other failure (a deadlock, a 500) rejects.
     */
    const staffCancel = (w: World, b: { id: string; version: number }) =>
      inTenant(w, () =>
        staffBackorders.cancel(
          b.id,
          { reason: 'sin stock', version: b.version },
          w.staffId,
        ),
      ).then(
        () => ({ status: 200 as const, code: null, details: {} }),
        (error: unknown) => {
          if (error instanceof BackorderError) {
            return {
              status: error.status,
              code: error.code,
              details: error.details,
            };
          }
          throw error;
        },
      );

    const staffCancelCount = async (w: World, id: string) =>
      (await feed(w, 'backorder.cancelled_by_staff', id)).length;

    it('staff cancel vs the sweep expiring the same reservation: exactly one wins, one release, loser answers NOT_CANCELLABLE {EXPIRED} (several interleavings)', async () => {
      const wins = { staff: 0, sweep: 0 };
      for (const [round, delay] of [
        0, 0, 2, 5, 9, 14, 20, 30, 45, 60, 0, 2, 5, 9, 14, 20,
      ].entries()) {
        const w = await world();
        const a = await reserved(w, 2);
        // Even rounds start the staff cancel first, odd rounds the sweep.
        const staffFirst = round % 2 === 0;

        const results = await Promise.allSettled([
          sleep(staffFirst ? 0 : delay).then(() => staffCancel(w, a)),
          sleep(staffFirst ? delay : 0).then(() => sweep.tick(FAR())),
        ]);

        expect(deadlocks(results)).toEqual([]);
        expect(results.map((r) => r.status)).toEqual([
          'fulfilled',
          'fulfilled',
        ]);
        const staff = (
          results[0] as PromiseFulfilledResult<{
            status: number;
            code: string | null;
            details: object;
          }>
        ).value;
        const final = await backorder(a.id);
        const rows = await movements(w);
        // Exactly one release, units back on the shelf once, no sale.
        expect(count(rows, 'BACKORDER_RELEASE')).toBe(1);
        expect(sum(rows, 'BACKORDER_RELEASE')).toBe(a.quantity);
        expect(await quantityOf(w.productId)).toBe(a.quantity);
        expect(count(rows, 'SALE')).toBe(0);
        if (staff.status === 200) {
          wins.staff += 1;
          expect(final).toMatchObject({
            status: 'CANCELLED',
            cancelledByKind: 'STAFF',
            cancelledByUserId: w.staffId,
            version: a.version + 1,
          });
          expect(await staffCancelCount(w, a.id)).toBe(1);
          expect(await feed(w, 'backorder.reservation_expired', a.id)).toEqual(
            [],
          );
        } else {
          wins.sweep += 1;
          // Status before version: the sweep bumped the version, yet the answer
          // is NOT_CANCELLABLE, never VERSION_CONFLICT.
          expect(staff).toEqual({
            status: 409,
            code: 'BACKORDER_NOT_CANCELLABLE',
            details: { status: 'EXPIRED' },
          });
          expect(final.status).toBe('EXPIRED');
          expect(await staffCancelCount(w, a.id)).toBe(0);
          expect(
            await feed(w, 'backorder.reservation_expired', a.id),
          ).toHaveLength(1);
        }
        await dropTenants();
      }
      expect(wins.staff + wins.sweep).toBe(16);
      console.log(`staff cancel vs sweep outcomes: ${JSON.stringify(wins)}`);
    });

    it('staff cancel vs the bot checkout of the same reservation: exactly one wins, no double release or charge, no deadlock (several interleavings)', async () => {
      const wins = { checkout: 0, staff: 0 };
      for (const delay of [0, 0, 2, 5, 9, 14, 20, 30, 45, 60]) {
        const w = await world();
        const a = await reserved(w, 2);

        const results = await Promise.allSettled([
          confirm(w, a),
          sleep(delay).then(() => staffCancel(w, a)),
        ]);

        expect(deadlocks(results)).toEqual([]);
        expect(results.map((r) => r.status)).toEqual([
          'fulfilled',
          'fulfilled',
        ]);
        const checkout = (
          results[0] as PromiseFulfilledResult<request.Response>
        ).value;
        const staff = (
          results[1] as PromiseFulfilledResult<{
            status: number;
            code: string | null;
            details: object;
          }>
        ).value;
        if (checkout.status === 201) {
          expect(staff).toEqual({
            status: 409,
            code: 'BACKORDER_NOT_CANCELLABLE',
            details: { status: 'CONFIRMED' },
          });
          expect(await staffCancelCount(w, a.id)).toBe(0);
        } else {
          expectError(checkout, 409, 'BACKORDER_NOT_RESERVED', {
            status: 'CANCELLED',
          });
          expect(staff.status).toBe(200);
          expect(await staffCancelCount(w, a.id)).toBe(1);
        }
        await expectOneWinner(w, a, checkout.status, 'CANCELLED');
        wins[checkout.status === 201 ? 'checkout' : 'staff'] += 1;
        await dropTenants();
      }
      expect(wins.checkout + wins.staff).toBe(10);
      console.log(`staff cancel vs checkout outcomes: ${JSON.stringify(wins)}`);
    });

    it('two checkouts of the same backorder (different keys): one sale, one CONFIRMED, one NOT_RESERVED', async () => {
      for (const delay of [0, 3, 8]) {
        const w = await world();
        const a = await reserved(w, 2);

        const results = await Promise.allSettled([
          confirm(w, a),
          sleep(delay).then(() => confirm(w, a)),
        ]);

        expect(deadlocks(results)).toEqual([]);
        const statuses = results
          .map(
            (r) => (r as PromiseFulfilledResult<request.Response>).value.status,
          )
          .sort();
        expect(statuses).toEqual([201, 409]);
        expect(await salesOf(w)).toHaveLength(1);
        expect(sum(await movements(w), 'SALE')).toBe(-2);
        expect((await backorder(a.id)).status).toBe('CONFIRMED');
        await dropTenants();
      }
    });

    it('checkout vs an arrival that reserves the next backorder: both commit, units conserved, nobody double-reserved', async () => {
      for (const delay of [0, 2, 6, 12]) {
        const w = await world();
        const [a, b] = await waiting(w, [{ quantity: 2 }, { quantity: 3 }]);
        await arrive(w, 2); // a RESERVED
        const reservedA = await backorder(a.id);

        const results = await Promise.allSettled([
          confirm(w, reservedA),
          sleep(delay).then(() => arrive(w, 3)),
        ]);

        expect(deadlocks(results)).toEqual([]);
        expect(results.map((r) => r.status)).toEqual([
          'fulfilled',
          'fulfilled',
        ]);
        expect(
          (results[0] as PromiseFulfilledResult<request.Response>).value.status,
        ).toBe(201);
        expect((await backorder(a.id)).status).toBe('CONFIRMED');
        expect((await backorder(b.id)).status).toBe('RESERVED');
        expect(await quantityOf(w.productId)).toBe(0);
        const rows = await movements(w);
        expect(sum(rows, 'SALE')).toBe(-2);
        expect(sum(rows, 'BACKORDER_RESERVE')).toBe(-5);
        expect(sum(rows, 'BACKORDER_RELEASE')).toBe(2);
        await dropTenants();
      }
    });

    it('the reservation is never sold to anybody else, and the backorder still confirms after the shelf was sold out', async () => {
      // NOTE: two bot checkouts of the same product racing each other can
      // deadlock on baseline code too (the sale lines take FOR KEY SHARE on the
      // product row before the charge asks for FOR UPDATE); that pre-existing
      // behaviour is outside T3, so this proof is sequential.
      const w = await world({ quantity: 3 });
      const [a] = await waiting(w, [{ quantity: 2 }]);
      await arrive(w, 2); // 5 units, 2 reserved, 3 sellable
      const reservedA = await backorder(a.id);
      expect(await quantityOf(w.productId)).toBe(3);

      expectError(
        await post(
          w,
          randomUUID(),
          checkoutBody(w, [{ quantity: 4, unitPriceCents: 1000 }], 4000, 1),
        ),
        409,
        'STOCK_INSUFFICIENT_AT_CONFIRM',
      );
      expect(
        (
          await post(
            w,
            randomUUID(),
            checkoutBody(w, [{ quantity: 3, unitPriceCents: 1000 }], 3000, 1),
          )
        ).status,
      ).toBe(201);
      expect(await quantityOf(w.productId)).toBe(0);

      expect((await confirm(w, reservedA)).status).toBe(201);
      expect(await quantityOf(w.productId)).toBe(0);
      expect(sum(await movements(w), 'SALE')).toBe(-5);
      expect((await backorder(a.id)).status).toBe('CONFIRMED');
    });
  });

  // ---------------------------------------------------------------------------
  // Idempotency (§7, request hash)
  // ---------------------------------------------------------------------------

  describe('idempotency', () => {
    it('replays the same key + body: same response, one sale, one backorder transition, no second charge', async () => {
      const w = await world();
      const a = await reserved(w, 2, 800);
      const key = randomUUID();

      const first = await confirm(w, a, key);
      const confirmed = await backorder(a.id);
      const replay = await confirm(w, a, key);

      expect(first.status).toBe(201);
      expect(replay.status).toBe(201);
      expect(replay.body).toEqual(first.body);
      expect(await salesOf(w)).toHaveLength(1);
      expect(await backorder(a.id)).toEqual(confirmed);
      expect(sum(await movements(w), 'SALE')).toBe(-2);
      // The replay is served although the backorder is no longer RESERVED.
      const status = await request(app.getHttpServer())
        .get('/chatbot-api/checkouts/status')
        .set('Authorization', `Bearer ${w.token}`)
        .set('X-Idempotency-Key', key);
      expect(status.body).toMatchObject({ status: 'succeeded' });
    });

    it('the same key with a different backorderId, or with none, is IDEMPOTENCY_KEY_CONFLICT', async () => {
      const w = await world();
      const [a, b] = await waiting(w, [{ quantity: 2 }, { quantity: 2 }]);
      await arrive(w, 4);
      const key = randomUUID();
      expect((await confirm(w, await backorder(a.id), key)).status).toBe(201);

      const otherBackorder = await post(
        w,
        key,
        checkoutBody(
          w,
          [{ quantity: 2, unitPriceCents: 1000, backorderId: b.id }],
          2000,
        ),
      );
      const withoutBackorder = await post(
        w,
        key,
        checkoutBody(w, [{ quantity: 2, unitPriceCents: 1000 }], 2000),
      );

      expectError(otherBackorder, 409, 'IDEMPOTENCY_KEY_CONFLICT');
      expectError(withoutBackorder, 409, 'IDEMPOTENCY_KEY_CONFLICT');
      expect((await backorder(b.id)).status).toBe('RESERVED');
    });

    it('stores a request hash that includes backorderId when present', async () => {
      const w = await world();
      const a = await reserved(w, 2, 800);
      await confirm(w, a);

      const [receipt] = await receipts(w);
      const lines = [{ quantity: 2, unitPriceCents: 800 }];
      const hashOf = (items: Line[]) =>
        computeCheckoutRequestHash(
          plainToInstance(CheckoutRequestDto, checkoutBody(w, items, 1600)),
        );
      expect(receipt.requestHash).toBe(
        hashOf([{ ...lines[0], backorderId: a.id }]),
      );
      expect(receipt.requestHash).not.toBe(hashOf(lines));
    });
  });

  // ---------------------------------------------------------------------------
  // Requests WITHOUT backorderId are unchanged
  // ---------------------------------------------------------------------------

  describe('a checkout without backorderId behaves exactly as before', () => {
    it('201 with the same body shape, list-price guard, stock charge and receipt; reservations are still enforced', async () => {
      const w = await world({ quantity: 5 });
      await waiting(w, [{ quantity: 2, customer: 1 }]);
      await arrive(w, 2); // reserves 2 for customer #2; shelf stays 5
      const shelf = await quantityOf(w.productId);
      expect(shelf).toBe(5);

      const ok = await post(
        w,
        randomUUID(),
        checkoutBody(w, [{ quantity: 2, unitPriceCents: 1000 }], 2000),
      );
      expect(ok.status).toBe(201);
      expect(Object.keys(ok.body).sort()).toEqual(
        ['address', 'customer', 'pickupLocation', 'sale', 'status'].sort(),
      );
      expect(Object.keys(ok.body.sale).sort()).toEqual(
        [
          'channel',
          'confirmedAt',
          'debtCents',
          'deliveryStatus',
          'discountCents',
          'folio',
          'fulfillmentMode',
          'paidCents',
          'paymentStatus',
          'saleId',
          'totalCents',
        ].sort(),
      );
      const [sale] = await salesOf(w);
      expect(sale.items[0]).toMatchObject({
        unitPriceCents: 1000,
        priceSource: 'PRICE_LIST',
      });
      expect(await quantityOf(w.productId)).toBe(3);

      const stale = await post(
        w,
        randomUUID(),
        checkoutBody(w, [{ quantity: 1, unitPriceCents: 999 }], 999),
      );
      expectError(stale, 409, 'PRICE_OUT_OF_DATE');

      const tooMany = await post(
        w,
        randomUUID(),
        checkoutBody(w, [{ quantity: 4, unitPriceCents: 1000 }], 4000),
      );
      expectError(tooMany, 409, 'STOCK_INSUFFICIENT_AT_CONFIRM');
    });

    it('stores the request hash of a request without backorderId exactly as the pre-T3 canonical form', async () => {
      const w = await world({ quantity: 5 });
      const res = await post(
        w,
        randomUUID(),
        checkoutBody(w, [{ quantity: 1, unitPriceCents: 1000 }], 1000),
      );
      expect(res.status).toBe(201);

      const [receipt] = await receipts(w);
      // The frozen pre-T3 serialization (no backorderId member), byte for byte.
      const canonical = JSON.stringify({
        phoneCountryCode: '52',
        phone: phoneOf(1).phone,
        customer: { mode: 'existing', customerId: w.customers[0] },
        deliveryAddress: null,
        sale: {
          cashierUserId: w.staffId,
          items: [
            {
              productId: w.productId,
              variantId: null,
              productName: PRODUCT_NAME,
              variantName: null,
              quantity: 1,
              unitPriceCents: 1000,
            },
          ],
          expectedTotalCents: 1000,
          shipping: canonicalShipping(classifyBotShipping({ mode: 'pickup' })),
        },
      });
      expect(receipt.requestHash).toBe(
        createHash('sha256').update(canonical).digest('hex'),
      );
    });

    it('the legacy POST /chatbot-api/sales does not accept backorderId (400) and still sells as before', async () => {
      const w = await world({ quantity: 5 });
      const legacy = (items: object[]) =>
        request(app.getHttpServer())
          .post('/chatbot-api/sales')
          .set('Authorization', `Bearer ${w.token}`)
          .set('X-Idempotency-Key', randomUUID())
          .send({
            cashierUserId: w.staffId,
            customerId: w.customers[0],
            items,
          });
      const a = await reserved(w, 2);

      const refused = await legacy([
        {
          productId: w.productId,
          productName: PRODUCT_NAME,
          quantity: 2,
          unitPriceCents: 1000,
          backorderId: a.id,
        },
      ]);
      expect(refused.status).toBe(400);
      expect((await backorder(a.id)).status).toBe('RESERVED');

      const ok = await legacy([
        {
          productId: w.productId,
          productName: PRODUCT_NAME,
          quantity: 1,
          unitPriceCents: 1000,
        },
      ]);
      expect(ok.status).toBe(201);
    });
  });

  // ---------------------------------------------------------------------------
  // The pay-in-store hold, and the stock coming back (§7, last paragraph)
  // ---------------------------------------------------------------------------

  describe('the sale of a backorder behaves like any bot sale afterwards', () => {
    async function confirmedSale(w: World) {
      const [a, b] = await waiting(w, [{ quantity: 2 }, { quantity: 2 }]);
      await arrive(w, 2); // a RESERVED, b WAITING
      const reservedA = await backorder(a.id);
      const res = await confirm(w, reservedA);
      expect(res.status).toBe(201);
      expect((await backorder(b.id)).status).toBe('WAITING');
      return { a, b, saleId: res.body.sale.saleId as string };
    }

    it('cancelling the sale returns its units through reverseSale and the next WAITING backorder is reserved', async () => {
      const w = await world();
      const { a, b, saleId } = await confirmedSale(w);

      await inTenant(w, () =>
        sales.cancelSale(saleId, w.staffId, { reason: 'OTHER' }),
      );

      expect(
        (await prisma.sale.findUniqueOrThrow({ where: { id: saleId } })).status,
      ).toBe('CANCELED');
      expect((await backorder(b.id)).status).toBe('RESERVED');
      // The confirmed backorder stays confirmed (terminal).
      expect((await backorder(a.id)).status).toBe('CONFIRMED');
      expect(await quantityOf(w.productId)).toBe(0);
      const rows = await movements(w);
      expect(sum(rows, 'SALE_CANCELLATION')).toBe(2);
      expect(
        rows.filter(
          (r) => r.groupId === b.id && r.type === 'BACKORDER_RESERVE',
        ),
      ).toHaveLength(1);
    });

    it('a pickup sale of a backorder takes the pay-in-store hold unchanged, and when the hold lapses the stock feeds the next WAITING backorder', async () => {
      const w = await world();
      const { b, saleId } = await confirmedSale(w);

      const hold = await request(app.getHttpServer())
        .patch(`/chatbot-api/sales/${saleId}/payment-intent`)
        .set('Authorization', `Bearer ${w.token}`)
        .send({ method: 'IN_STORE' });
      expect(hold.status).toBe(200);
      expect(hold.body).toMatchObject({ saleId, paymentIntent: 'IN_STORE' });

      await inTx(w, () => sales.expireHeldSale(saleId));

      expect(
        (await prisma.sale.findUniqueOrThrow({ where: { id: saleId } }))
          .cancelReason,
      ).toBe('HOLD_EXPIRED');
      expect((await backorder(b.id)).status).toBe('RESERVED');
      expect(await quantityOf(w.productId)).toBe(0);
    });
  });
});
