/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- supertest bodies are untyped JSON */
/**
 * restock-backorder / T2a — reserve / release / allocate against REAL
 * PostgreSQL (contract v1 §3, §4; owner Q1 Q2 Q6, D1 D2 D4).
 *
 * Boots the REAL `BackordersModule` graph (journal writer, sale stock, sales
 * service with the real bot price preview, inventory commands, allocator) with
 * only the bot credential repository replaced. Cleanup deletes only the
 * tenants/users it created.
 *
 * Proves what no unit test can: the allocation runs in the SAME transaction as
 * every stock increase (adjustment, sale cancel, HOLD_EXPIRED, release), the
 * reserved units are out of `quantity` for the counter sale, the lock order
 * holds under concurrency (no oversell, no negative stock, no deadlock), a
 * cancelled RESERVED backorder serves the next one, and the expired-lot swap /
 * back-to-WAITING primitive.
 */
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { ClsModule, ClsService } from 'nestjs-cls';
import request from 'supertest';
import { SERVICE_CREDENTIAL_REPOSITORY } from '../chatbot-api/domain/service-credential.repository';
import {
  BotCredentials,
  disconnectWorldPrisma,
  worldPrisma,
} from '../delivery-zones/test-support/delivery-zone-world';
import { InventoryCommands } from '../inventory/http/inventory-commands';
import { StockJournalWriter } from '../inventory/infrastructure/stock-journal.writer';
import { ProductStockJournal } from '../products/infrastructure/product-stock-journal';
import { SaleStockService } from '../sales/sale-stock.service';
import { SalesService } from '../sales/sales.service';
import { DomainExceptionFilter } from '../shared/filters/domain-exception.filter';
import { PrismaExceptionFilter } from '../shared/filters/prisma-exception.filter';
import { createAppValidationPipe } from '../shared/listing/app-validation.pipe';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
import { BackorderReservationService } from './application/backorder-reservation.service';
import { BackordersModule } from './backorders.module';
import { BACKORDER_SCOPES } from './domain/backorder-scopes';

const SKIP =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const d = SKIP ? describe.skip : describe;

const DAY = 86_400_000;
const HOUR = 3_600_000;
const RESOLVED_AT = new Date(Date.now() - DAY);
const ALL_SCOPES = [
  BACKORDER_SCOPES.create,
  BACKORDER_SCOPES.read,
  BACKORDER_SCOPES.cancel,
];
const SYSTEM = { id: null, displayName: 'Sistema' };

d('restock backorders — reserve, release, allocate (PostgreSQL)', () => {
  const prisma = worldPrisma();
  const credentials = new BotCredentials();
  const tenantIds: string[] = [];
  const createdPriceListIds: string[] = [];
  const userIds: string[] = [];
  let app: INestApplication;
  let publicListId: string;
  let cls: ClsService<TenantClsStore>;
  let tenantPrisma: TenantPrismaService;
  let commands: InventoryCommands;
  let writer: StockJournalWriter;
  let saleStock: SaleStockService;
  let sales: SalesService;
  let reservations: BackorderReservationService;
  let productJournal: ProductStockJournal;

  beforeAll(async () => {
    const existingDefault = await prisma.globalPriceList.findFirst({
      where: { isDefault: true },
    });
    if (existingDefault) {
      publicListId = existingDefault.id;
    } else {
      const created = await prisma.globalPriceList.create({
        data: { name: `PUBLICO-alloc-${randomUUID()}`, isDefault: true },
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
              JWT_SECRET: 'backorder-alloc-test-secret',
              JWT_REFRESH_SECRET: 'backorder-alloc-test-refresh',
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
    commands = get(InventoryCommands);
    writer = get(StockJournalWriter);
    saleStock = get(SaleStockService);
    sales = get(SalesService);
    reservations = get(BackorderReservationService);
    productJournal = get(ProductStockJournal);
  });

  afterAll(async () => {
    await app?.close();
    if (tenantIds.length > 0) {
      await prisma.promotion.deleteMany({
        where: { tenantId: { in: tenantIds } },
      });
      await prisma.outboxEvent.deleteMany({
        where: { tenantId: { in: tenantIds } },
      });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
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
    productId: string;
    decisionId: string;
    staffId: string;
    customers: string[];
  }

  const phoneOf = (n: number) => ({
    phoneCountryCode: '52',
    phone: `55123488${String(n).padStart(2, '0')}`,
  });

  /** A sucursal with a priced product (PUBLICO), 8 customers, an answered RESTOCK decision and a staff user. */
  async function world(
    options: {
      quantity?: number;
      priceCents?: number | null;
      lots?: boolean;
    } = {},
  ): Promise<World> {
    const tenantId = randomUUID();
    tenantIds.push(tenantId);
    await prisma.tenant.create({
      data: {
        id: tenantId,
        name: `Sucursal ${tenantId.slice(0, 6)}`,
        slug: `al-${tenantId}`,
      },
    });
    const productId = randomUUID();
    await prisma.product.create({
      data: {
        id: productId,
        tenantId,
        name: 'Croquetas Adulto 18 kg',
        useStock: true,
        quantity: options.quantity ?? 0,
        useLotsAndExpirations: options.lots ?? false,
      },
    });
    if (options.priceCents !== null) {
      await prisma.priceList.create({
        data: {
          tenantId,
          productId,
          globalPriceListId: publicListId,
          priceCents: options.priceCents ?? 1000,
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
    const staffId = await staffUser(tenantId);
    return {
      tenantId,
      token: credentials.register(tenantId, ALL_SCOPES),
      productId,
      decisionId: decision.id,
      staffId,
      customers,
    };
  }

  /** A POS user with the inventory grants, member of the tenant. */
  async function staffUser(tenantId: string): Promise<string> {
    const userId = randomUUID();
    userIds.push(userId);
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@alloc.invalid`,
        name: 'Ana Pérez',
        hashedPassword: 'not-a-login-hash',
        isActive: true,
      },
    });
    const role = await prisma.role.create({
      data: { tenantId, name: `Inventory ${userId}` },
    });
    for (const [subject, action] of [
      ['InventoryJournal', 'read'],
      ['InventoryAdjustment', 'create'],
    ]) {
      const permission = await prisma.permission.upsert({
        where: { subject_action: { subject, action } },
        update: {},
        create: { subject, action },
      });
      await prisma.rolePermission.create({
        data: { roleId: role.id, permissionId: permission.id },
      });
    }
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
      variantId?: string | null;
    }>,
    productId = w.productId,
    customerOffset = 0,
  ) {
    const base = Date.now() - 10 * HOUR;
    const rows: Array<Awaited<ReturnType<typeof prisma.backorder.create>>> = [];
    for (const [i, spec] of specs.entries()) {
      rows.push(
        await prisma.backorder.create({
          data: {
            tenantId: w.tenantId,
            folio: `BO-${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
            customerId: w.customers[customerOffset + i],
            productId,
            variantId: spec.variantId ?? null,
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

  const inTenant = <T>(w: World, work: () => T, userId?: string): T =>
    cls.runWith(
      {
        tenantId: w.tenantId,
        userId: userId ?? w.staffId,
        isSuperAdmin: false,
      },
      work,
    );

  /** Inside one ambient transaction, like every real caller. */
  const inTx = <T>(w: World, work: () => Promise<T>): Promise<T> =>
    inTenant(w, () => tenantPrisma.runInTransaction(work));

  async function adjust(
    w: World,
    delta: number,
    target: { productId?: string; variantId?: string; lotId?: string } = {},
  ) {
    const product = await prisma.product.findUniqueOrThrow({
      where: { id: w.productId },
    });
    const bucketVersion = target.variantId
      ? (
          await prisma.variant.findUniqueOrThrow({
            where: { id: target.variantId },
          })
        ).stockVersion
      : target.lotId
        ? (
            await prisma.lot.findUniqueOrThrow({
              where: { id: target.lotId },
            })
          ).stockVersion
        : product.stockVersion;
    return inTenant(w, () =>
      commands.adjust(randomUUID(), {
        target: { productId: w.productId, ...target },
        expectedVersion: bucketVersion,
        delta,
        reason: 'OTHER',
        note: 'Llegó la reposición',
      }),
    );
  }

  /** A confirmed POS sale of `quantity` units whose stock was charged through the journal. */
  async function confirmedSale(w: World, quantity: number): Promise<string> {
    const sale = await prisma.sale.create({
      data: {
        tenantId: w.tenantId,
        userId: w.staffId,
        status: 'CONFIRMED',
        channel: 'POS',
        deliveryStatus: 'PENDING',
        paymentStatus: 'CREDIT',
        folio: `V-${randomUUID().slice(0, 8)}`,
        confirmedAt: new Date(),
        subtotalCents: 1000 * quantity,
        totalCents: 1000 * quantity,
        debtCents: 1000 * quantity,
        items: {
          create: {
            tenantId: w.tenantId,
            productId: w.productId,
            productName: 'Croquetas Adulto 18 kg',
            quantity,
            unitPriceCents: 1000,
          },
        },
      },
    });
    await inTx(w, () =>
      saleStock.charge({
        saleId: sale.id,
        items: [{ productId: w.productId, quantity }],
        actor: { kind: 'system', userId: 'system' },
      }),
    );
    return sale.id;
  }

  const quantityOf = async (productId: string) =>
    (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
      .quantity;
  const backorder = (id: string) =>
    prisma.backorder.findUniqueOrThrow({ where: { id } });
  const statuses = async (ids: string[]) =>
    Promise.all(ids.map(async (id) => (await backorder(id)).status));
  const journal = (w: World, groupId?: string) =>
    prisma.stockMovement.findMany({
      where: { tenantId: w.tenantId, ...(groupId ? { groupId } : {}) },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

  const deadlocks = (results: PromiseSettledResult<unknown>[]) =>
    results.filter(
      (r) =>
        r.status === 'rejected' &&
        /deadlock|40P01/i.test(
          String((r.reason as Error)?.message ?? r.reason),
        ),
    );

  // ---------------------------------------------------------------------------
  // D4: allocation after every stock increase
  // ---------------------------------------------------------------------------

  describe('positive inventory adjustment (D4, §4)', () => {
    it('reserves the queue FIFO in the same transaction, journals BACKORDER_RESERVE and prices each at min(reference, current)', async () => {
      const w = await world({ priceCents: 1000 });
      const [a, b, c] = await waiting(w, [
        { quantity: 2, referencePriceCents: 1500 },
        { quantity: 3, referencePriceCents: 800 },
        { quantity: 1 },
      ]);

      const result = await adjust(w, 5);

      expect(result.statusCode).toBe(201);
      // The response keeps describing the adjustment; the stock it reports is
      // the one AFTER the reservations (same transaction).
      expect(result.body.movement).toMatchObject({
        type: 'ADJUSTMENT',
        delta: 5,
      });
      expect(result.body.stock.product.quantity).toBe(0);
      expect(await statuses([a.id, b.id, c.id])).toEqual([
        'RESERVED',
        'RESERVED',
        'WAITING',
      ]);
      expect(await quantityOf(w.productId)).toBe(0);

      const rows = await journal(w);
      expect(
        rows.map((m) => [
          m.type,
          m.groupType,
          m.delta,
          m.groupId === a.id ? 'a' : m.groupId === b.id ? 'b' : 'x',
        ]),
      ).toEqual([
        ['ADJUSTMENT', 'ADJUSTMENT', 5, 'x'],
        ['BACKORDER_RESERVE', 'BACKORDER', -2, 'a'],
        ['BACKORDER_RESERVE', 'BACKORDER', -3, 'b'],
      ]);
      // The kardex order (createdAt, id) is the journal order.
      expect(new Set(rows.map((m) => m.createdAt.getTime())).size).toBe(
        rows.length,
      );
      expect(rows.map((m) => m.productBalanceAfter)).toEqual([5, 3, 0]);

      const reservedA = await backorder(a.id);
      expect(reservedA).toMatchObject({
        status: 'RESERVED',
        reservationStage: 0,
        currentPriceCents: 1000,
        finalPriceCents: 1000, // min(1500, 1000)
        passedOverCount: 0,
        version: 2,
      });
      expect(
        reservedA.reservedUntil!.getTime() - reservedA.reservedAt!.getTime(),
      ).toBe(24 * HOUR);
      expect(
        reservedA.reservedUntil!.getTime() - reservedA.reminderAt!.getTime(),
      ).toBe(3 * HOUR);
      expect(reservedA.scheduledAt).toEqual(a.scheduledAt);
      expect(await backorder(b.id)).toMatchObject({
        currentPriceCents: 1000,
        finalPriceCents: 800, // min(800, 1000): a higher price never raises it
      });
    });

    it('rolls the reservations back with the stock write when the surrounding transaction fails (same transaction)', async () => {
      const w = await world();
      const [a] = await waiting(w, [{ quantity: 2 }]);
      await expect(
        inTx(w, async () => {
          await writer.apply(
            [
              {
                bucket: { kind: 'PRODUCT_UNTRACKED', productId: w.productId },
                delta: 5,
              },
            ],
            {
              type: 'ADJUSTMENT',
              groupType: 'ADJUSTMENT',
              groupId: 'g',
              actor: SYSTEM,
            },
          );
          // Inside the transaction the reservation already happened…
          const inside = await tenantPrisma
            .getClient()
            .backorder.findUniqueOrThrow({ where: { id: a.id } });
          expect(inside.status).toBe('RESERVED');
          throw new Error('caller failed after the stock write');
        }),
      ).rejects.toThrow('caller failed');
      // …and vanished with it.
      expect(await quantityOf(w.productId)).toBe(0);
      expect((await backorder(a.id)).status).toBe('WAITING');
      expect(await journal(w)).toEqual([]);
    });

    it('walks the whole queue without partial reservations; the head keeps its place and is flagged passedOverCount (Q1)', async () => {
      const w = await world();
      const [a, b, c] = await waiting(w, [
        { quantity: 2 },
        { quantity: 3 },
        { quantity: 1 },
      ]);
      await adjust(w, 3);
      // a(2) fits, b(3) no longer fits (1 left), c(1) fits behind the miss.
      expect(await statuses([a.id, b.id, c.id])).toEqual([
        'RESERVED',
        'WAITING',
        'RESERVED',
      ]);
      expect((await backorder(b.id)).passedOverCount).toBe(1);
      expect((await backorder(a.id)).passedOverCount).toBe(0);
      expect(await quantityOf(w.productId)).toBe(0);

      // The head is evaluated first on the next arrival and is no longer passed over.
      await adjust(w, 3);
      expect((await backorder(b.id)).status).toBe('RESERVED');
      expect((await backorder(b.id)).passedOverCount).toBe(1);
      expect(await quantityOf(w.productId)).toBe(0);
    });

    it('applies the automatic promotion when it gives a lower price (Q2/Q3) and keeps the lower of the two', async () => {
      const w = await world({ priceCents: 1000 });
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
      const [a, b] = await waiting(w, [
        { quantity: 2, referencePriceCents: 1000 },
        { quantity: 1, referencePriceCents: 850 },
      ]);
      await adjust(w, 3);
      // 10 % off a 1000 line: 900 per unit; the second customer's reference 850 is lower.
      expect(await backorder(a.id)).toMatchObject({
        currentPriceCents: 900,
        finalPriceCents: 900,
      });
      expect(await backorder(b.id)).toMatchObject({
        currentPriceCents: 900,
        finalPriceCents: 850,
      });
    });

    it('keeps a backorder WAITING (no reservation, no stock taken) when its price cannot be computed', async () => {
      const w = await world({ priceCents: null }); // no catalog price at all
      const [a] = await waiting(w, [{ quantity: 2 }]);
      const result = await adjust(w, 5);
      expect(result.statusCode).toBe(201);
      expect(await statuses([a.id])).toEqual(['WAITING']);
      expect(await quantityOf(w.productId)).toBe(5);
      expect(
        (await journal(w)).filter((m) => m.type === 'BACKORDER_RESERVE'),
      ).toEqual([]);
    });

    it('reserves a variant queue from the variant bucket only', async () => {
      const w = await world();
      await prisma.product.update({
        where: { id: w.productId },
        data: { hasVariants: true },
      });
      const variant = await prisma.variant.create({
        data: {
          productId: w.productId,
          tenantId: w.tenantId,
          name: 'Grande',
          quantity: 0,
        },
      });
      const other = await prisma.variant.create({
        data: {
          productId: w.productId,
          tenantId: w.tenantId,
          name: 'Chica',
          quantity: 0,
        },
      });
      const list = await prisma.priceList.findFirstOrThrow({
        where: { tenantId: w.tenantId, productId: w.productId },
      });
      await prisma.variantPrice.create({
        data: {
          tenantId: w.tenantId,
          variantId: variant.id,
          priceListId: list.id,
          priceCents: 1000,
        },
      });
      const [a] = await waiting(w, [{ quantity: 2, variantId: variant.id }]);
      // Stock of ANOTHER variant must not feed this queue.
      await adjust(w, 5, { variantId: other.id });
      expect((await backorder(a.id)).status).toBe('WAITING');

      await adjust(w, 3, { variantId: variant.id });
      expect((await backorder(a.id)).status).toBe('RESERVED');
      expect(
        (await prisma.variant.findUniqueOrThrow({ where: { id: variant.id } }))
          .quantity,
      ).toBe(1);
      expect(
        (await prisma.variant.findUniqueOrThrow({ where: { id: other.id } }))
          .quantity,
      ).toBe(5);
    });
  });

  describe('initial stock (D4, §4)', () => {
    it('stock a lot is created with (INITIAL) is allocated to the waiting queue in the same transaction', async () => {
      const w = await world({ lots: true });
      const [a] = await waiting(w, [{ quantity: 3 }]);
      // What `ProductsService.createLot` does: an empty lot, then its INITIAL stock.
      const lot = await prisma.lot.create({
        data: {
          tenantId: w.tenantId,
          productId: w.productId,
          lotNumber: 'NUEVO',
          quantity: 0,
          expirationDate: new Date(Date.now() + 90 * DAY),
        },
      });
      await inTx(w, () =>
        productJournal.recordInitial(w.productId, [
          {
            bucket: { kind: 'LOT', productId: w.productId, lotId: lot.id },
            delta: 5,
          },
        ]),
      );
      expect((await backorder(a.id)).status).toBe('RESERVED');
      expect(await quantityOf(w.productId)).toBe(2);
      expect(
        (await prisma.lot.findUniqueOrThrow({ where: { id: lot.id } }))
          .quantity,
      ).toBe(2);
      expect((await journal(w)).map((m) => `${m.type}:${m.delta}`)).toEqual([
        'INITIAL:5',
        'BACKORDER_RESERVE:-3',
      ]);
    });
  });

  describe('paths without backorders are unchanged', () => {
    it('adjustment and sale reversal write exactly what they always wrote', async () => {
      const w = await world({ quantity: 10 });
      const result = await adjust(w, 4);
      expect(result.body.stock.product.quantity).toBe(14);
      expect((await journal(w)).map((m) => m.type)).toEqual(['ADJUSTMENT']);

      const saleId = await confirmedSale(w, 3);
      const outcome = await inTx(w, () =>
        saleStock.reverse({
          saleId,
          actor: { kind: 'system', userId: 'system' },
        }),
      );
      if (outcome.status !== 'REVERSED') throw new Error(outcome.status);
      expect(outcome.movements.map((m) => m.type)).toEqual([
        'SALE_CANCELLATION',
      ]);
      expect(await quantityOf(w.productId)).toBe(14);
      expect((await journal(w)).some((m) => m.groupType === 'BACKORDER')).toBe(
        false,
      );
    });

    it('a WAITING backorder of ANOTHER product does not disturb the stock path', async () => {
      const w = await world({ quantity: 0 });
      const otherId = randomUUID();
      await prisma.product.create({
        data: {
          id: otherId,
          tenantId: w.tenantId,
          name: 'Otro',
          useStock: true,
          quantity: 0,
        },
      });
      await prisma.priceList.create({
        data: {
          tenantId: w.tenantId,
          productId: otherId,
          globalPriceListId: publicListId,
          priceCents: 1000,
        },
      });
      const [a] = await waiting(w, [{ quantity: 1 }], otherId);
      await adjust(w, 5);
      expect((await backorder(a.id)).status).toBe('WAITING');
      expect(await quantityOf(w.productId)).toBe(5);
    });
  });

  describe('counter sale vs reservation (§4)', () => {
    it('a counter sale confirm cannot take reserved units: STOCK_INSUFFICIENT_AT_CONFIRM (the STOCK_RESERVED mapping is T5)', async () => {
      const w = await world();
      const [a] = await waiting(w, [{ quantity: 3 }]);
      await adjust(w, 4); // a reserves 3, one unit stays sellable
      expect((await backorder(a.id)).status).toBe('RESERVED');
      expect(await quantityOf(w.productId)).toBe(1);

      await expect(
        inTx(w, () =>
          saleStock.charge({
            saleId: randomUUID(),
            items: [{ productId: w.productId, quantity: 2 }],
            actor: { kind: 'system', userId: 'system' },
          }),
        ),
      ).rejects.toMatchObject({ code: 'STOCK_INSUFFICIENT_AT_CONFIRM' });
      expect(await quantityOf(w.productId)).toBe(1);

      // The unreserved unit is still sellable.
      await inTx(w, () =>
        saleStock.charge({
          saleId: randomUUID(),
          items: [{ productId: w.productId, quantity: 1 }],
          actor: { kind: 'system', userId: 'system' },
        }),
      );
      expect(await quantityOf(w.productId)).toBe(0);
    });
  });

  describe('sale cancellation and hold expiry feed the queue (§4)', () => {
    it('cancelSale restores the stock and the same transaction reserves it for the waiting backorder', async () => {
      const w = await world({ quantity: 2 });
      const saleId = await confirmedSale(w, 2);
      expect(await quantityOf(w.productId)).toBe(0);
      const [a] = await waiting(w, [{ quantity: 2 }]);

      await inTenant(w, () =>
        sales.cancelSale(saleId, w.staffId, { reason: 'OTHER' }),
      );

      expect(
        (await prisma.sale.findUniqueOrThrow({ where: { id: saleId } })).status,
      ).toBe('CANCELED');
      expect((await backorder(a.id)).status).toBe('RESERVED');
      expect(await quantityOf(w.productId)).toBe(0);
      expect((await journal(w)).map((m) => `${m.type}:${m.delta}`)).toEqual([
        'SALE:-2',
        'SALE_CANCELLATION:2',
        'BACKORDER_RESERVE:-2',
      ]);
    });

    it('a HOLD_EXPIRED cancellation (sweep path) feeds the queue too', async () => {
      const w = await world({ quantity: 3 });
      const saleId = await confirmedSale(w, 3);
      const [a, b] = await waiting(w, [{ quantity: 2 }, { quantity: 2 }]);

      await inTx(w, () => sales.expireHeldSale(saleId));

      expect(
        (await prisma.sale.findUniqueOrThrow({ where: { id: saleId } }))
          .cancelReason,
      ).toBe('HOLD_EXPIRED');
      // 3 units back: a(2) reserved, b(2) does not fit.
      expect(await statuses([a.id, b.id])).toEqual(['RESERVED', 'WAITING']);
      expect(await quantityOf(w.productId)).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Cancel of a RESERVED backorder
  // ---------------------------------------------------------------------------

  describe('cancelling a RESERVED backorder (bot cancel)', () => {
    const cancel = (token: string, id: string) =>
      request(app.getHttpServer())
        .post(`/chatbot-api/backorders/${id}/cancel`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'ya no' });

    it('releases its units to the same buckets and re-allocates to the next WAITING in the same transaction', async () => {
      const w = await world();
      const [a, b] = await waiting(w, [{ quantity: 2 }, { quantity: 2 }]);
      await adjust(w, 2); // a reserved
      expect(await statuses([a.id, b.id])).toEqual(['RESERVED', 'WAITING']);

      const res = await cancel(w.token, a.id).expect(200);
      expect(res.body.backorder).toMatchObject({
        status: 'CANCELLED',
        cancelledByKind: 'CUSTOMER',
      });

      expect(await statuses([a.id, b.id])).toEqual(['CANCELLED', 'RESERVED']);
      expect(await quantityOf(w.productId)).toBe(0);
      expect(
        (await journal(w)).map(
          (m) =>
            `${m.type}:${m.groupId === a.id ? 'a' : m.groupId === b.id ? 'b' : '-'}:${m.delta}`,
        ),
      ).toEqual([
        'ADJUSTMENT:-:2',
        'BACKORDER_RESERVE:a:-2',
        'BACKORDER_RELEASE:a:2',
        'BACKORDER_RESERVE:b:-2',
      ]);
      expect(
        (await journal(w, a.id)).find((m) => m.type === 'BACKORDER_RELEASE')
          ?.actorDisplayName,
      ).toBe('Bot');
      // A second cancel is a clean 409 and moves no stock.
      await cancel(w.token, a.id).expect(409);
      expect(await quantityOf(w.productId)).toBe(0);
    });

    it('with nobody waiting the released units become sellable again', async () => {
      const w = await world();
      const [a] = await waiting(w, [{ quantity: 2 }]);
      await adjust(w, 2);
      expect(await quantityOf(w.productId)).toBe(0);
      await cancel(w.token, a.id).expect(200);
      expect(await quantityOf(w.productId)).toBe(2);
    });

    it('a RESERVED backorder cancelled twice at once releases exactly once', async () => {
      const w = await world();
      const [a] = await waiting(w, [{ quantity: 2 }]);
      await adjust(w, 2);
      const results = await Promise.all([
        cancel(w.token, a.id),
        cancel(w.token, a.id),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await quantityOf(w.productId)).toBe(2);
      expect(
        (await journal(w, a.id)).filter((m) => m.type === 'BACKORDER_RELEASE'),
      ).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Concurrency (item 4): journal locks, FIFO allocation racing counter sales
  // ---------------------------------------------------------------------------

  describe('concurrency', () => {
    it('a counter sale racing an arrival never oversells: exactly one of {sale, reservation} gets the units', async () => {
      const outcomes = { sold: 0, reserved: 0 };
      for (let round = 0; round < 8; round++) {
        const w = await world({ quantity: 2 });
        const [a] = await waiting(w, [{ quantity: 3 }]); // 2 < 3: WAITING
        const results = await Promise.allSettled([
          inTx(w, () =>
            writer.apply(
              [
                {
                  bucket: { kind: 'PRODUCT_UNTRACKED', productId: w.productId },
                  delta: 1,
                },
              ],
              {
                type: 'ADJUSTMENT',
                groupType: 'ADJUSTMENT',
                groupId: `g-${round}`,
                actor: SYSTEM,
              },
            ),
          ),
          inTx(w, () =>
            saleStock.charge({
              saleId: randomUUID(),
              items: [{ productId: w.productId, quantity: 2 }],
              actor: { kind: 'system', userId: 'system' },
            }),
          ),
        ]);
        expect(deadlocks(results)).toEqual([]);
        const [arrival, sale] = results;
        expect(arrival.status).toBe('fulfilled');
        const quantity = await quantityOf(w.productId);
        expect(quantity).toBeGreaterThanOrEqual(0);
        const reserved = (await backorder(a.id)).status === 'RESERVED';
        if (sale.status === 'fulfilled') {
          // Sale first: 2 + 1 - 2 = 1 left, the backorder (3) cannot be served.
          expect(reserved).toBe(false);
          expect(quantity).toBe(1);
          outcomes.sold++;
        } else {
          // Arrival first: 3 units were reserved, the sale found nothing.
          expect(sale.reason).toMatchObject({
            code: 'STOCK_INSUFFICIENT_AT_CONFIRM',
          });
          expect(reserved).toBe(true);
          expect(quantity).toBe(0);
          outcomes.reserved++;
        }
        // Units are conserved: never both.
        expect(sale.status === 'fulfilled' && reserved).toBe(false);
      }
      expect(outcomes.sold + outcomes.reserved).toBe(8);
    });

    it('concurrent arrivals serve the queue once: no backorder reserved twice, no negative stock, no deadlock', async () => {
      const w = await world();
      const queue = await waiting(
        w,
        Array.from({ length: 6 }, () => ({ quantity: 2 })),
      );
      const results = await Promise.allSettled(
        [0, 1, 2].map((n) =>
          inTx(w, () =>
            writer.apply(
              [
                {
                  bucket: { kind: 'PRODUCT_UNTRACKED', productId: w.productId },
                  delta: 2,
                },
              ],
              {
                type: 'ADJUSTMENT',
                groupType: 'ADJUSTMENT',
                groupId: `arr-${n}`,
                actor: SYSTEM,
              },
            ),
          ),
        ),
      );
      expect(deadlocks(results)).toEqual([]);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      // 6 units arrived: exactly 3 backorders of 2, in FIFO order.
      expect(await statuses(queue.map((q) => q.id))).toEqual([
        'RESERVED',
        'RESERVED',
        'RESERVED',
        'WAITING',
        'WAITING',
        'WAITING',
      ]);
      expect(await quantityOf(w.productId)).toBe(0);
      const reserves = (await journal(w)).filter(
        (m) => m.type === 'BACKORDER_RESERVE',
      );
      expect(reserves).toHaveLength(3);
      expect(new Set(reserves.map((m) => m.groupId)).size).toBe(3);
    });

    it('a cancel of a RESERVED backorder racing an arrival and a counter sale keeps every unit accounted for', async () => {
      for (let round = 0; round < 5; round++) {
        const w = await world();
        const [a, b] = await waiting(w, [{ quantity: 2 }, { quantity: 2 }]);
        await adjust(w, 2); // a reserved
        const results = await Promise.allSettled([
          cancel(w.token, a.id),
          inTx(w, () =>
            writer.apply(
              [
                {
                  bucket: { kind: 'PRODUCT_UNTRACKED', productId: w.productId },
                  delta: 2,
                },
              ],
              {
                type: 'ADJUSTMENT',
                groupType: 'ADJUSTMENT',
                groupId: `r-${round}`,
                actor: SYSTEM,
              },
            ),
          ),
          inTx(w, () =>
            saleStock.charge({
              saleId: randomUUID(),
              items: [{ productId: w.productId, quantity: 1 }],
              actor: { kind: 'system', userId: 'system' },
            }),
          ),
        ]);
        expect(deadlocks(results)).toEqual([]);
        const quantity = await quantityOf(w.productId);
        expect(quantity).toBeGreaterThanOrEqual(0);
        const [aStatus, bStatus] = await statuses([a.id, b.id]);
        expect(aStatus).toBe('CANCELLED');
        const sold = results[2].status === 'fulfilled' ? 1 : 0;
        const reserved = bStatus === 'RESERVED' ? 2 : 0;
        // arrived 2 (adjust) + 2 (arrival) = 4 units in total, minus sold/reserved.
        expect(quantity + sold + reserved).toBe(4);
        expect(results[0].status).toBe('fulfilled');
      }
    });

    it('lock order: a cancel waits for the stock lock BEFORE taking the backorder row, so a transaction that holds the stock and then locks the row cannot deadlock with it', async () => {
      const w = await world();
      const [a] = await waiting(w, [{ quantity: 2 }]);
      await adjust(w, 2); // a is RESERVED
      let proceed!: () => void;
      const gate = new Promise<void>((resolve) => (proceed = resolve));
      let holding!: () => void;
      const stockHeld = new Promise<void>((resolve) => (holding = resolve));
      // The order the allocator, the sweep and the checkout use: journal locks, then the row.
      const holder = inTx(w, async () => {
        await writer.lockStock([w.productId]);
        holding();
        await gate;
        await tenantPrisma.getClient().$queryRaw`
          SELECT "id" FROM "backorders" WHERE "id" = ${a.id} FOR UPDATE`;
      });
      await stockHeld;
      const cancelling = cancel(w.token, a.id).then((res) => res);
      await new Promise((resolve) => setTimeout(resolve, 500)); // the cancel is parked on the product lock
      proceed();
      const [held, cancelled] = await Promise.allSettled([holder, cancelling]);
      expect(deadlocks([held, cancelled])).toEqual([]);
      expect(held.status).toBe('fulfilled');
      expect(cancelled.status).toBe('fulfilled');
      expect(
        (cancelled as PromiseFulfilledResult<{ status: number }>).value.status,
      ).toBe(200);
      expect(await quantityOf(w.productId)).toBe(2);
    });

    const cancel = (token: string, id: string) =>
      request(app.getHttpServer())
        .post(`/chatbot-api/backorders/${id}/cancel`)
        .set('Authorization', `Bearer ${token}`)
        .send({});
  });

  // ---------------------------------------------------------------------------
  // Lot primitive (owner Q6)
  // ---------------------------------------------------------------------------

  describe('revalidateReservation (expired lot, owner Q6)', () => {
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
    const lotQuantities = async (w: World) =>
      Object.fromEntries(
        (await prisma.lot.findMany({ where: { productId: w.productId } })).map(
          (l) => [l.lotNumber, l.quantity],
        ),
      );
    const revalidate = (w: World, id: string, daysAhead: number) =>
      inTx(w, () =>
        reservations.revalidateReservation(
          tenantPrisma.getClient(),
          id,
          new Date(Date.now() + daysAhead * DAY),
        ),
      );

    it('swaps an expired lot for a valid one and stays RESERVED', async () => {
      const w = await world({ lots: true });
      const lotA = await lot(w, 'A', 2); // valid today, expired in 5 days
      const lotB = await lot(w, 'B', 60);
      const [a] = await waiting(w, [{ quantity: 8 }]);
      await adjust(w, 8, { lotId: lotA.id }); // allocation reserves the 8 units from lot A
      await adjust(w, 10, { lotId: lotB.id });
      expect(await lotQuantities(w)).toEqual({ A: 0, B: 10 });
      expect((await backorder(a.id)).status).toBe('RESERVED');

      const outcome = await revalidate(w, a.id, 5);

      expect(outcome).toEqual({ outcome: 'SWAPPED' });
      expect((await backorder(a.id)).status).toBe('RESERVED');
      // The expired lot got its units back (unsellable); lot B now holds the reservation.
      expect(await lotQuantities(w)).toEqual({ A: 8, B: 2 });
      expect(await revalidate(w, a.id, 5)).toEqual({ outcome: 'VALID' });
      expect(
        (await journal(w, a.id)).map(
          (m) => `${m.type}:${m.lotNumber}:${m.delta}`,
        ),
      ).toEqual([
        'BACKORDER_RESERVE:A:-8',
        'BACKORDER_RELEASE:A:8',
        'BACKORDER_RESERVE:B:-8',
      ]);
    });

    it('returns to WAITING keeping its place when no valid lot covers it, and serves the next one that fits', async () => {
      const w = await world({ lots: true });
      const lotA = await lot(w, 'A', 2);
      const lotB = await lot(w, 'B', 60);
      const [a] = await waiting(w, [{ quantity: 8 }]);
      await adjust(w, 8, { lotId: lotA.id });
      expect((await backorder(a.id)).status).toBe('RESERVED');
      await adjust(w, 3, { lotId: lotB.id }); // nobody is waiting yet: lot B holds 3 valid units
      // A backorder queued behind `a` that fits the valid stock (intake raced the arrival;
      // nothing re-ran the allocator for it yet).
      const [c] = await waiting(w, [{ quantity: 2 }], w.productId, 1);
      expect((await backorder(c.id)).status).toBe('WAITING');
      const before = await backorder(a.id);

      const outcome = await revalidate(w, a.id, 5); // lot A expired, B (3) cannot cover 8

      expect(outcome).toMatchObject({
        outcome: 'RESERVATION_LOST',
        backorderId: a.id,
        reservedIds: [c.id],
      });
      const lost = await backorder(a.id);
      expect(lost).toMatchObject({
        status: 'WAITING',
        reservedAt: null,
        reservedUntil: null,
        reminderAt: null,
        reservationStage: 0,
        currentPriceCents: null,
        finalPriceCents: null,
        // c (behind it) was reserved from the stock released by the loss: a was passed over.
        passedOverCount: 1,
      });
      expect(lost.scheduledAt).toEqual(before.scheduledAt); // keeps its place: front of the queue
      expect(lost.version).toBe(before.version + 1);
      // Lot A holds its 8 units again (expired, unsellable); lot B served c.
      expect(await lotQuantities(w)).toEqual({ A: 8, B: 1 });
      expect((await backorder(c.id)).status).toBe('RESERVED');
      // Nothing is held for `a` any more.
      expect(await revalidate(w, a.id, 5)).toMatchObject({
        outcome: 'NOT_RESERVED',
        status: 'WAITING',
      });
    });
  });
});
