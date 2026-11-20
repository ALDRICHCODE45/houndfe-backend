/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest bodies are untyped JSON */
/**
 * restock-backorder / T5a — the POS staff API (contract v1 §9.1-§9.3, §9.5)
 * against REAL PostgreSQL through the real JWT → TenantContext → Permissions
 * chain (CASL reading RolePermission rows).
 *
 * Boots the REAL `BackordersModule` graph (journal writer, allocator, reservation
 * service, real price preview) with only the bot credential repository replaced.
 * Every fixture lives under random tenants/users removed afterwards; the shared
 * test database is never reset.
 *
 * Proves what no unit test can: list filters, counts that ignore only the status
 * filter, sort (nulls last), pagination and tenant isolation; the detail
 * projection; the staff cancel of WAITING and RESERVED (units released to the
 * next in the queue in the same transaction, `backorder.cancelled_by_staff` in
 * the feed), VERSION_CONFLICT, BACKORDER_NOT_CANCELLABLE, concurrent cancels, and
 * the permission denials.
 */
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { ClsModule, ClsService } from 'nestjs-cls';
import request from 'supertest';
import { SERVICE_CREDENTIAL_REPOSITORY } from '../chatbot-api/domain/service-credential.repository';
import {
  BotCredentials,
  disconnectWorldPrisma,
  worldPrisma,
} from '../delivery-zones/test-support/delivery-zone-world';
import { InventoryCommands } from '../inventory/http/inventory-commands';
import { BACKORDER_NOTICE_GRANTS } from '../notifications/domain/backorder-notice';
import { usersWithGrants } from '../notifications/infrastructure/notice-recipients';
import { DomainExceptionFilter } from '../shared/filters/domain-exception.filter';
import { PrismaExceptionFilter } from '../shared/filters/prisma-exception.filter';
import { createAppValidationPipe } from '../shared/listing/app-validation.pipe';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
import { BackordersModule } from './backorders.module';
import { BACKORDER_SCOPES } from './domain/backorder-scopes';

const SKIP =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const d = SKIP ? describe.skip : describe;

const SECRET = 'backorders-staff-it-secret';
const jwt = new JwtService({
  secret: SECRET,
  signOptions: { expiresIn: '1h' },
});

const DAY = 86_400_000;
const HOUR = 3_600_000;
const RESOLVED_AT = new Date(Date.now() - DAY);

type Grants = Array<[subject: string, action: string]>;
const READ: Grants = [['Backorder', 'read']];
const READ_UPDATE: Grants = [
  ['Backorder', 'read'],
  ['Backorder', 'update'],
];

d('restock backorders — staff API (PostgreSQL)', () => {
  const prisma = worldPrisma();
  const credentials = new BotCredentials();
  const tenantIds: string[] = [];
  const userIds: string[] = [];
  const createdPriceListIds: string[] = [];
  let app: INestApplication;
  let cls: ClsService<TenantClsStore>;
  let commands: InventoryCommands;
  let publicListId: string;
  let folioSeq = 0;

  beforeAll(async () => {
    const existingDefault = await prisma.globalPriceList.findFirst({
      where: { isDefault: true },
    });
    if (existingDefault) {
      publicListId = existingDefault.id;
    } else {
      const created = await prisma.globalPriceList.create({
        data: { name: `PUBLICO-staff-${randomUUID()}`, isDefault: true },
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
              JWT_SECRET: SECRET,
              JWT_REFRESH_SECRET: 'backorders-staff-it-refresh',
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
    cls = moduleRef.get(ClsService, { strict: false });
    commands = moduleRef.get(InventoryCommands, { strict: false });
  });

  afterAll(async () => {
    await app?.close();
    if (tenantIds.length > 0) {
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

  interface Staff {
    userId: string;
    name: string;
    auth: { Authorization: string };
  }

  interface World {
    tenantId: string;
    tenantName: string;
    productId: string;
    variantProductId: string;
    variantId: string;
    decisionId: string;
    customers: Array<{ id: string; firstName: string; phone: string }>;
    manager: Staff;
    /** Holds the inventory grants `InventoryCommands.adjust` checks. */
    stocker: Staff;
  }

  const http = () => request(app.getHttpServer() as Server);

  /** A user of `tenantId` whose role holds exactly `grants`. */
  async function staff(
    tenantId: string,
    tenantSlug: string,
    grants: Grants,
    name = 'Ana Pérez',
    isActive = true,
  ): Promise<Staff> {
    const userId = randomUUID();
    userIds.push(userId);
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@staff.invalid`,
        name,
        hashedPassword: 'not-a-login-hash',
        isActive,
      },
    });
    const role = await prisma.role.create({
      data: { tenantId, name: `Staff ${userId}` },
    });
    for (const [subject, action] of grants) {
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
    const token = jwt.sign({
      sub: userId,
      email: `${userId}@staff.invalid`,
      tenantId,
      tenantSlug,
      isSuperAdmin: false,
    });
    return { userId, name, auth: { Authorization: `Bearer ${token}` } };
  }

  /** A sucursal: priced simple product, a variant product, 6 customers, a RESTOCK decision and a manager. */
  async function world(
    options: { quantity?: number; grants?: Grants } = {},
  ): Promise<World> {
    const tenantId = randomUUID();
    tenantIds.push(tenantId);
    const tenantName = `Sucursal ${tenantId.slice(0, 6)}`;
    const slug = `st-${tenantId}`;
    await prisma.tenant.create({
      data: { id: tenantId, name: tenantName, slug },
    });
    const productId = randomUUID();
    await prisma.product.create({
      data: {
        id: productId,
        tenantId,
        name: 'Croquetas Adulto 18 kg',
        useStock: true,
        quantity: options.quantity ?? 0,
      },
    });
    await prisma.priceList.create({
      data: {
        tenantId,
        productId,
        globalPriceListId: publicListId,
        priceCents: 1000,
      },
    });
    await prisma.productImage.create({
      data: {
        tenantId,
        productId,
        url: 'https://img.invalid/croquetas.png',
        isMain: true,
      },
    });
    const variantProductId = randomUUID();
    const variantId = randomUUID();
    await prisma.product.create({
      data: {
        id: variantProductId,
        tenantId,
        name: 'Arena para gato',
        hasVariants: true,
        useStock: true,
      },
    });
    await prisma.variant.create({
      data: {
        id: variantId,
        tenantId,
        productId: variantProductId,
        name: 'Bolsa 5 kg',
        option: 'Tamaño',
        value: '5 kg',
        quantity: 0,
      },
    });
    const names = ['Rosa', 'Mateo', 'Lucía', 'Pedro', 'Elena', 'Jorge'];
    const customers: World['customers'] = [];
    for (const [n, firstName] of names.entries()) {
      const id = randomUUID();
      const phone = `5551234${String(500 + n)}`;
      await prisma.customer.create({
        data: {
          id,
          tenantId,
          firstName,
          lastName: n === 0 ? 'Gómez' : null,
          phoneCountryCode: '52',
          phone,
        },
      });
      customers.push({ id, firstName, phone });
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
    const manager = await staff(
      tenantId,
      slug,
      options.grants ?? READ_UPDATE,
      'Ana Pérez',
    );
    const stocker = await staff(
      tenantId,
      slug,
      [
        ['InventoryJournal', 'read'],
        ['InventoryAdjustment', 'create'],
      ],
      'Almacén',
    );
    return {
      tenantId,
      tenantName,
      productId,
      variantProductId,
      variantId,
      decisionId: decision.id,
      customers,
      manager,
      stocker,
    };
  }

  async function backorder(
    w: World,
    over: Partial<Prisma.BackorderUncheckedCreateInput> = {},
  ) {
    folioSeq += 1;
    return prisma.backorder.create({
      data: {
        tenantId: w.tenantId,
        folio: `BO-${String(folioSeq).padStart(6, '0')}`,
        customerId: w.customers[0].id,
        productId: w.productId,
        variantId: null,
        quantity: 1,
        referencePriceCents: 1000,
        scheduledAt: new Date(Date.now() - 10 * HOUR),
        estimatedArrivalDays: 7,
        estimatedAt: new Date(Date.now() + 7 * DAY),
        sourceDecisionId: w.decisionId,
        idempotencyKey: randomUUID(),
        requestHash: 'a'.repeat(64),
        ...over,
      },
    });
  }

  /** The columns `backorders_reserved_state` requires of a RESERVED row. */
  const reservedColumns = (untilMs: number) => ({
    status: 'RESERVED' as const,
    reservedAt: new Date(),
    reservedUntil: new Date(untilMs),
    reminderAt: new Date(untilMs - 3 * HOUR),
    currentPriceCents: 1000,
    finalPriceCents: 1000,
  });

  /** A confirmed POS sale a CONFIRMED backorder can point at. */
  async function confirmedSale(w: World): Promise<string> {
    const sale = await prisma.sale.create({
      data: {
        tenantId: w.tenantId,
        userId: w.manager.userId,
        status: 'CONFIRMED',
        channel: 'POS',
        deliveryStatus: 'PENDING',
        paymentStatus: 'CREDIT',
        folio: `V-${randomUUID().slice(0, 8)}`,
        confirmedAt: new Date(),
        subtotalCents: 1000,
        totalCents: 1000,
        debtCents: 1000,
      },
    });
    return sale.id;
  }

  /** WAITING backorders in queue order, one per customer starting at `offset`. */
  async function queue(w: World, quantities: number[], offset = 0) {
    const base = Date.now() - 10 * HOUR;
    const rows: Array<Awaited<ReturnType<typeof backorder>>> = [];
    for (const [i, quantity] of quantities.entries()) {
      rows.push(
        await backorder(w, {
          customerId: w.customers[offset + i].id,
          quantity,
          scheduledAt: new Date(base + i * 1000),
        }),
      );
    }
    return rows;
  }

  /** Positive adjustment; re-reads the stock version and retries when a concurrent write moved it. */
  async function adjust(w: World, delta: number) {
    for (let attempt = 0; ; attempt++) {
      const product = await prisma.product.findUniqueOrThrow({
        where: { id: w.productId },
      });
      try {
        return await cls.runWith(
          {
            tenantId: w.tenantId,
            userId: w.stocker.userId,
            isSuperAdmin: false,
          },
          () =>
            commands.adjust(randomUUID(), {
              target: { productId: w.productId },
              expectedVersion: product.stockVersion,
              delta,
              reason: 'OTHER',
              note: 'Llegó la reposición',
            }),
        );
      } catch (error) {
        if (
          attempt >= 6 ||
          !/STOCK_VERSION_CONFLICT|version/i.test(
            String((error as Error).message),
          )
        ) {
          throw error;
        }
      }
    }
  }

  const quantityOf = async (productId: string) =>
    (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
      .quantity;
  const row = (id: string) =>
    prisma.backorder.findUniqueOrThrow({ where: { id } });
  const feedOf = (id: string) =>
    prisma.chatbotFeedItem.findMany({
      where: { backorderId: id },
      orderBy: { cursor: 'asc' },
    });
  const list = (w: World, query = '') =>
    http().get(`/backorders${query}`).set(w.manager.auth);
  const ids = (res: { body: { items: Array<{ id: string }> } }) =>
    res.body.items.map((item) => item.id);

  // ---------------------------------------------------------------------------
  // GET /backorders
  // ---------------------------------------------------------------------------

  describe('GET /backorders', () => {
    it('answers { items, page, limit, total, counts } oldest first by default', async () => {
      const w = await world();
      const [a, b, c] = await queue(w, [1, 2, 3]);
      const res = await list(w).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toMatchObject({
        page: 1,
        limit: 20,
        total: 3,
        counts: {
          WAITING: 3,
          RESERVED: 0,
          CONFIRMED: 0,
          EXPIRED: 0,
          CANCELLED: 0,
        },
      });
      expect(ids(res)).toEqual([a.id, b.id, c.id]);
      expect(res.body.items[0]).toMatchObject({
        id: a.id,
        status: 'WAITING',
        version: 1,
        origin: 'CHATBOT',
        productName: 'Croquetas Adulto 18 kg',
        productImageUrl: 'https://img.invalid/croquetas.png',
        branchName: w.tenantName,
        queuePosition: 1,
        etaOverdue: false,
        passedOverCount: 0,
        customer: {
          id: w.customers[0].id,
          name: 'Rosa Gómez',
          phone: '+525551234500',
        },
      });
      expect(
        (res.body.items as Array<{ queuePosition: number }>).map(
          (item) => item.queuePosition,
        ),
      ).toEqual([1, 2, 3]);
    });

    it('filters by a status list and keeps counts independent of it', async () => {
      const w = await world();
      const [a, b] = await queue(w, [1, 1]);
      const done = await backorder(w, {
        customerId: w.customers[2].id,
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledByKind: 'CUSTOMER',
      });
      const res = await list(w, '?status=WAITING,CANCELLED').expect(200);
      expect(new Set(ids(res))).toEqual(new Set([a.id, b.id, done.id]));
      const onlyCancelled = await list(w, '?status=CANCELLED').expect(200);
      expect(ids(onlyCancelled)).toEqual([done.id]);
      expect(onlyCancelled.body.total).toBe(1);
      expect(onlyCancelled.body.counts).toEqual({
        WAITING: 2,
        RESERVED: 0,
        CONFIRMED: 0,
        EXPIRED: 0,
        CANCELLED: 1,
      });
    });

    it('filters by product, variant and customer; counts honour them', async () => {
      const w = await world();
      const [a] = await queue(w, [1]);
      const onVariant = await backorder(w, {
        customerId: w.customers[1].id,
        productId: w.variantProductId,
        variantId: w.variantId,
      });
      const byProduct = await list(w, `?productId=${w.productId}`).expect(200);
      expect(ids(byProduct)).toEqual([a.id]);
      expect(byProduct.body.counts.WAITING).toBe(1);
      const byVariant = await list(w, `?variantId=${w.variantId}`).expect(200);
      expect(ids(byVariant)).toEqual([onVariant.id]);
      expect(byVariant.body.items[0]).toMatchObject({
        variantId: w.variantId,
        variantName: 'Bolsa 5 kg',
      });
      const byCustomer = await list(
        w,
        `?customerId=${w.customers[1].id}`,
      ).expect(200);
      expect(ids(byCustomer)).toEqual([onVariant.id]);
      expect(byCustomer.body.counts.WAITING).toBe(1);
    });

    it('searches q by customer name, phone digits, product and variant name', async () => {
      const w = await world();
      const [a] = await queue(w, [1]); // Rosa Gómez, product Croquetas
      const v = await backorder(w, {
        customerId: w.customers[1].id, // Mateo
        productId: w.variantProductId,
        variantId: w.variantId,
      });
      expect(ids(await list(w, '?q=rosa').expect(200))).toEqual([a.id]);
      expect(ids(await list(w, '?q=g%C3%B3mez').expect(200))).toEqual([a.id]);
      expect(ids(await list(w, '?q=rosa%20croquetas').expect(200))).toEqual([
        a.id,
      ]);
      expect(ids(await list(w, '?q=rosa%20arena').expect(200))).toEqual([]);
      expect(ids(await list(w, '?q=5551234501').expect(200))).toEqual([v.id]);
      expect(ids(await list(w, '?q=%2B52%205551234501').expect(200))).toEqual([
        v.id,
      ]);
      expect(ids(await list(w, '?q=arena').expect(200))).toEqual([v.id]);
      expect(ids(await list(w, '?q=bolsa%205').expect(200))).toEqual([v.id]);
      expect(ids(await list(w, '?q=18%20kg').expect(200))).toEqual([a.id]);
      expect((await list(w, '?q=rosa').expect(200)).body.counts.WAITING).toBe(
        1,
      );
      expect((await list(w, '?q=zzzz').expect(200)).body).toMatchObject({
        total: 0,
        items: [],
        counts: { WAITING: 0 },
      });
    });

    it('filters scheduledAt by from/to with a zone offset', async () => {
      const w = await world();
      const t0 = Date.parse('2026-10-10T12:00:00.000Z');
      const early = await backorder(w, {
        customerId: w.customers[0].id,
        scheduledAt: new Date(t0),
      });
      const mid = await backorder(w, {
        customerId: w.customers[1].id,
        scheduledAt: new Date(t0 + DAY),
      });
      const late = await backorder(w, {
        customerId: w.customers[2].id,
        scheduledAt: new Date(t0 + 2 * DAY),
      });
      const both = await list(
        w,
        '?from=2026-10-11T06:00:00-06:00&to=2026-10-12T12:00:00Z',
      ).expect(200);
      expect(ids(both)).toEqual([mid.id, late.id]);
      expect(both.body.counts.WAITING).toBe(2);
      expect(
        ids(await list(w, '?from=2026-10-12T00:00:00Z').expect(200)),
      ).toEqual([late.id]);
      expect(
        ids(await list(w, '?to=2026-10-10T12:00:00.000Z').expect(200)),
      ).toEqual([early.id]);
    });

    it('sorts by scheduledAt desc, status and reservedUntil (nulls last)', async () => {
      const w = await world();
      const t0 = Date.now() - 20 * HOUR;
      const waiting = await backorder(w, {
        customerId: w.customers[0].id,
        scheduledAt: new Date(t0),
      });
      const reservedLate = await backorder(w, {
        customerId: w.customers[1].id,
        scheduledAt: new Date(t0 + 1000),
        ...reservedColumns(Date.now() + 20 * HOUR),
      });
      const reservedSoon = await backorder(w, {
        customerId: w.customers[2].id,
        scheduledAt: new Date(t0 + 2000),
        ...reservedColumns(Date.now() + 5 * HOUR),
      });
      const cancelled = await backorder(w, {
        customerId: w.customers[3].id,
        scheduledAt: new Date(t0 + 3000),
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledByKind: 'CUSTOMER',
      });
      expect(ids(await list(w).expect(200))).toEqual([
        waiting.id,
        reservedLate.id,
        reservedSoon.id,
        cancelled.id,
      ]);
      expect(ids(await list(w, '?sortOrder=desc').expect(200))).toEqual([
        cancelled.id,
        reservedSoon.id,
        reservedLate.id,
        waiting.id,
      ]);
      // enum declaration order: WAITING, RESERVED, CONFIRMED, EXPIRED, CANCELLED
      expect(ids(await list(w, '?sortBy=status').expect(200))).toEqual([
        waiting.id,
        reservedLate.id,
        reservedSoon.id,
        cancelled.id,
      ]);
      expect(
        ids(await list(w, '?sortBy=status&sortOrder=desc').expect(200)),
      ).toEqual([cancelled.id, reservedLate.id, reservedSoon.id, waiting.id]);
      expect(ids(await list(w, '?sortBy=reservedUntil').expect(200))).toEqual([
        reservedSoon.id,
        reservedLate.id,
        waiting.id,
        cancelled.id,
      ]);
      expect(
        ids(await list(w, '?sortBy=reservedUntil&sortOrder=desc').expect(200)),
      ).toEqual([reservedLate.id, reservedSoon.id, waiting.id, cancelled.id]);
    });

    it('paginates and reports the total before the page cut', async () => {
      const w = await world();
      const rows = await queue(w, [1, 1, 1, 1, 1]);
      const first = await list(w, '?page=1&limit=2').expect(200);
      expect(first.body).toMatchObject({ page: 1, limit: 2, total: 5 });
      expect(ids(first)).toEqual([rows[0].id, rows[1].id]);
      const third = await list(w, '?page=3&limit=2').expect(200);
      expect(ids(third)).toEqual([rows[4].id]);
      expect(third.body.counts.WAITING).toBe(5);
      const beyond = await list(w, '?page=9&limit=2').expect(200);
      expect(beyond.body).toMatchObject({ items: [], total: 5 });
    });

    it('counts every status across the whole filtered set', async () => {
      const w = await world();
      await queue(w, [1, 1]);
      await backorder(w, {
        customerId: w.customers[2].id,
        ...reservedColumns(Date.now() + 5 * HOUR),
      });
      await backorder(w, {
        customerId: w.customers[3].id,
        status: 'EXPIRED',
        expiredAt: new Date(),
      });
      await backorder(w, {
        customerId: w.customers[4].id,
        status: 'EXPIRED',
        expiredAt: new Date(),
      });
      const res = await list(w, '?limit=1').expect(200);
      expect(res.body.counts).toEqual({
        WAITING: 2,
        RESERVED: 1,
        CONFIRMED: 0,
        EXPIRED: 2,
        CANCELLED: 0,
      });
      expect(res.body.total).toBe(5);
    });

    it('never lists, counts or filters another sucursal', async () => {
      const mine = await world();
      const theirs = await world();
      const [own] = await queue(mine, [1]);
      const [foreign] = await queue(theirs, [1, 1]);
      const res = await list(mine).expect(200);
      expect(ids(res)).toEqual([own.id]);
      expect(res.body.counts.WAITING).toBe(1);
      const byForeignCustomer = await list(
        mine,
        `?customerId=${theirs.customers[0].id}&productId=${theirs.productId}`,
      ).expect(200);
      expect(byForeignCustomer.body).toMatchObject({
        items: [],
        total: 0,
        counts: { WAITING: 0 },
      });
      expect(ids(await list(theirs).expect(200))).toContain(foreign.id);
      expect(ids(await list(theirs).expect(200))).not.toContain(own.id);
    });

    it('answers 400 INVALID_BACKORDER_REQUEST for a malformed query', async () => {
      const w = await world();
      for (const query of [
        '?page=0',
        '?limit=101',
        '?status=NOPE',
        '?productId=1',
        '?from=2026-10-10',
        '?sortBy=folio',
        '?tenantId=x',
      ]) {
        const res = await list(w, query).expect(400);
        expect(res.body).toEqual({
          statusCode: 400,
          error: 'INVALID_BACKORDER_REQUEST',
          message: 'INVALID_BACKORDER_REQUEST',
        });
      }
    });
  });

  // ---------------------------------------------------------------------------
  // GET /backorders/:id
  // ---------------------------------------------------------------------------

  describe('GET /backorders/:id', () => {
    it('returns the full BackorderStaff of a WAITING backorder', async () => {
      const w = await world();
      const [a, b] = await queue(w, [2, 1]);
      await prisma.backorder.update({
        where: { id: b.id },
        data: { passedOverCount: 3, chatbotRequestId: null },
      });
      const res = await http()
        .get(`/backorders/${b.id}`)
        .set(w.manager.auth)
        .expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({
        id: b.id,
        folio: b.folio,
        status: 'WAITING',
        version: 1,
        productId: w.productId,
        productName: 'Croquetas Adulto 18 kg',
        productImageUrl: 'https://img.invalid/croquetas.png',
        variantId: null,
        variantName: null,
        quantity: 1,
        referencePriceCents: 1000,
        priceListId: null,
        currentPriceCents: null,
        finalPriceCents: null,
        scheduledAt: b.scheduledAt.toISOString(),
        estimatedAt: b.estimatedAt.toISOString(),
        estimatedArrivalDays: 7,
        reservedAt: null,
        reservedUntil: null,
        reminderAt: null,
        queuePosition: 2,
        saleId: null,
        saleStatus: null,
        sourceDecisionId: w.decisionId,
        chatbotRequestId: null,
        origin: 'CHATBOT',
        confirmedAt: null,
        cancelledAt: null,
        expiredAt: null,
        cancelledBy: null,
        cancelledByKind: null,
        cancelReason: null,
        etaOverdue: false,
        passedOverCount: 3,
        branchName: w.tenantName,
        customerFirstName: 'Mateo',
        phoneCountryCode: '52',
        phone: w.customers[1].phone,
        customer: {
          id: w.customers[1].id,
          name: 'Mateo',
          phone: `+52${w.customers[1].phone}`,
        },
      });
      expect(a.id).not.toBe(b.id);
    });

    it('shows the variant image, the sale status and the confirmation of a CONFIRMED backorder', async () => {
      const w = await world();
      await prisma.productImage.create({
        data: {
          tenantId: w.tenantId,
          productId: w.variantProductId,
          variantId: w.variantId,
          url: 'https://img.invalid/arena-5kg.png',
          isMain: true,
        },
      });
      const saleId = await confirmedSale(w);
      const confirmedAt = new Date(Date.now() - HOUR);
      const b = await backorder(w, {
        productId: w.variantProductId,
        variantId: w.variantId,
        status: 'CONFIRMED',
        confirmedAt,
        saleId,
        currentPriceCents: 900,
        finalPriceCents: 900,
        reservedAt: new Date(Date.now() - 2 * HOUR),
        reservedUntil: new Date(Date.now() + 22 * HOUR),
        referencePriceListId: publicListId,
      });
      const res = await http()
        .get(`/backorders/${b.id}`)
        .set(w.manager.auth)
        .expect(200);
      expect(res.body).toMatchObject({
        status: 'CONFIRMED',
        productImageUrl: 'https://img.invalid/arena-5kg.png',
        saleId,
        saleStatus: 'CONFIRMED',
        confirmedAt: confirmedAt.toISOString(),
        finalPriceCents: 900,
        priceListId: publicListId,
        queuePosition: null,
      });
      await prisma.sale.update({
        where: { id: saleId },
        data: { status: 'CANCELED' },
      });
      const after = await http()
        .get(`/backorders/${b.id}`)
        .set(w.manager.auth)
        .expect(200);
      expect(after.body.saleStatus).toBe('CANCELED');
    });

    it('flags etaOverdue only for a WAITING backorder whose answered re-estimate also lapsed', async () => {
      const w = await world();
      const past = new Date(Date.now() - DAY);
      const lapsed = await backorder(w, {
        customerId: w.customers[0].id,
        etaStage: 2,
        estimatedAt: past,
      });
      const asked = await backorder(w, {
        customerId: w.customers[1].id,
        etaStage: 1,
        estimatedAt: past,
      });
      const reserved = await backorder(w, {
        customerId: w.customers[2].id,
        etaStage: 2,
        estimatedAt: past,
        ...reservedColumns(Date.now() + 5 * HOUR),
      });
      const flags = async (id: string): Promise<boolean> => {
        const res = await http()
          .get(`/backorders/${id}`)
          .set(w.manager.auth)
          .expect(200);
        return res.body.etaOverdue as boolean;
      };
      expect(await flags(lapsed.id)).toBe(true);
      expect(await flags(asked.id)).toBe(false);
      expect(await flags(reserved.id)).toBe(false);
    });

    it('answers 404 BACKORDER_NOT_FOUND for an unknown, malformed or foreign id', async () => {
      const mine = await world();
      const theirs = await world();
      const [foreign] = await queue(theirs, [1]);
      for (const id of [randomUUID(), 'not-a-uuid', foreign.id]) {
        const res = await http()
          .get(`/backorders/${id}`)
          .set(mine.manager.auth)
          .expect(404);
        expect(res.body).toEqual({
          statusCode: 404,
          error: 'BACKORDER_NOT_FOUND',
          message: 'BACKORDER_NOT_FOUND',
        });
      }
    });
  });

  // ---------------------------------------------------------------------------
  // POST /backorders/:id/cancel
  // ---------------------------------------------------------------------------

  describe('POST /backorders/:id/cancel', () => {
    const cancel = (
      w: World,
      id: string,
      body: object,
      auth = w.manager.auth,
    ) => http().post(`/backorders/${id}/cancel`).set(auth).send(body);

    it('cancels a WAITING backorder: STAFF, canceller, reason, version + 1, feed item', async () => {
      const w = await world();
      const [a, b] = await queue(w, [1, 1]);
      const res = await cancel(w, a.id, {
        reason: '  Cliente pidió cancelar  ',
        version: 1,
      }).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toMatchObject({
        id: a.id,
        status: 'CANCELLED',
        version: 2,
        cancelledByKind: 'STAFF',
        cancelledBy: { id: w.manager.userId, name: 'Ana Pérez' },
        cancelReason: 'Cliente pidió cancelar',
        queuePosition: null,
      });
      expect(res.body.cancelledAt).toEqual(expect.any(String));
      const stored = await row(a.id);
      expect(stored).toMatchObject({
        status: 'CANCELLED',
        cancelledByKind: 'STAFF',
        cancelledByUserId: w.manager.userId,
        version: 2,
      });
      const feed = await feedOf(a.id);
      expect(feed).toHaveLength(1);
      expect(feed[0]).toMatchObject({
        type: 'backorder.cancelled_by_staff',
        tenantId: w.tenantId,
        backorderId: a.id,
        requestId: null,
        saleId: null,
      });
      expect(feed[0].payload).toMatchObject({
        backorderId: a.id,
        version: 2,
        reason: 'Cliente pidió cancelar',
        sourceDecisionId: w.decisionId,
      });
      // The rest of the queue moves up; no stock moved.
      const next = await http()
        .get(`/backorders/${b.id}`)
        .set(w.manager.auth)
        .expect(200);
      expect(next.body.queuePosition).toBe(1);
      expect(
        await prisma.stockMovement.count({ where: { tenantId: w.tenantId } }),
      ).toBe(0);
    });

    it('accepts a body without reason and stores null', async () => {
      const w = await world();
      const [a] = await queue(w, [1]);
      const res = await cancel(w, a.id, { version: 1 }).expect(200);
      expect(res.body.cancelReason).toBeNull();
      expect((await feedOf(a.id))[0].payload).toMatchObject({ reason: null });
    });

    it('releases a RESERVED backorder to the next in the queue in the same transaction', async () => {
      const w = await world();
      const [a, b, c] = await queue(w, [2, 2, 5]);
      await adjust(w, 4); // a and b reserved, c waits
      expect(
        (await Promise.all([a, b, c].map((x) => row(x.id)))).map(
          (x) => x.status,
        ),
      ).toEqual(['RESERVED', 'RESERVED', 'WAITING']);
      const reservedVersion = (await row(a.id)).version;

      const res = await cancel(w, a.id, { version: reservedVersion }).expect(
        200,
      );
      expect(res.body).toMatchObject({
        status: 'CANCELLED',
        cancelledByKind: 'STAFF',
        version: reservedVersion + 1,
      });
      // c needs 5: it does not fit the 2 released units, so it keeps waiting.
      expect(
        (await Promise.all([a, b, c].map((x) => row(x.id)))).map(
          (x) => x.status,
        ),
      ).toEqual(['CANCELLED', 'RESERVED', 'WAITING']);
      expect(await quantityOf(w.productId)).toBe(2);
      const movements = await prisma.stockMovement.findMany({
        where: { tenantId: w.tenantId, groupId: a.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      expect(movements.map((m) => `${m.type}:${m.delta}`)).toEqual([
        'BACKORDER_RESERVE:-2',
        'BACKORDER_RELEASE:2',
      ]);
      expect(movements[1].actorDisplayName).toBe('Ana Pérez');
      expect(movements[1].actorId).toBe(w.manager.userId);
      expect((await feedOf(a.id)).map((i) => i.type)).toEqual([
        'backorder.reserved',
        'backorder.cancelled_by_staff',
      ]);
    });

    it('serves the next WAITING backorder with the released units', async () => {
      const w = await world();
      const [a, b] = await queue(w, [2, 2]);
      await adjust(w, 2); // a reserved
      expect((await row(b.id)).status).toBe('WAITING');
      const res = await cancel(w, a.id, { version: (await row(a.id)).version });
      expect(res.status).toBe(200);
      expect((await row(b.id)).status).toBe('RESERVED');
      expect(await quantityOf(w.productId)).toBe(0);
      const movements = await prisma.stockMovement.findMany({
        where: { tenantId: w.tenantId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      expect(
        movements.map(
          (m) =>
            `${m.type}:${m.groupId === a.id ? 'a' : m.groupId === b.id ? 'b' : '-'}:${m.delta}`,
        ),
      ).toEqual([
        'ADJUSTMENT:-:2',
        'BACKORDER_RESERVE:a:-2',
        'BACKORDER_RELEASE:a:2',
        'BACKORDER_RESERVE:b:-2',
      ]);
      expect((await feedOf(b.id)).map((i) => i.type)).toEqual([
        'backorder.reserved',
      ]);
    });

    it('with nobody waiting the released units become sellable again', async () => {
      const w = await world();
      const [a] = await queue(w, [2]);
      await adjust(w, 2);
      expect(await quantityOf(w.productId)).toBe(0);
      await cancel(w, a.id, { version: (await row(a.id)).version }).expect(200);
      expect(await quantityOf(w.productId)).toBe(2);
    });

    it('answers 409 VERSION_CONFLICT {currentVersion} for a stale version and changes nothing', async () => {
      const w = await world();
      const [a] = await queue(w, [1]);
      await prisma.backorder.update({
        where: { id: a.id },
        data: { version: { increment: 2 } },
      });
      const res = await cancel(w, a.id, { version: 1 }).expect(409);
      expect(res.body).toEqual({
        statusCode: 409,
        error: 'VERSION_CONFLICT',
        message: 'VERSION_CONFLICT',
        currentVersion: 3,
      });
      expect(await row(a.id)).toMatchObject({ status: 'WAITING', version: 3 });
      expect(await feedOf(a.id)).toHaveLength(0);
      // Retrying with the version of the answer succeeds.
      await cancel(w, a.id, { version: 3 }).expect(200);
    });

    it('a stale version on a RESERVED backorder releases nothing', async () => {
      const w = await world();
      const [a] = await queue(w, [2]);
      await adjust(w, 2);
      const before = await prisma.stockMovement.count({
        where: { tenantId: w.tenantId },
      });
      await cancel(w, a.id, { version: 1 }).expect(409);
      expect((await row(a.id)).status).toBe('RESERVED');
      expect(
        await prisma.stockMovement.count({ where: { tenantId: w.tenantId } }),
      ).toBe(before);
    });

    it.each(['CONFIRMED', 'EXPIRED', 'CANCELLED'] as const)(
      'answers 409 BACKORDER_NOT_CANCELLABLE {status: %s} and never moves stock',
      async (status) => {
        const w = await world();
        const extra: Partial<Prisma.BackorderUncheckedCreateInput> =
          status === 'CONFIRMED'
            ? { confirmedAt: new Date(), saleId: await confirmedSale(w) }
            : status === 'EXPIRED'
              ? { expiredAt: new Date() }
              : { cancelledAt: new Date(), cancelledByKind: 'CUSTOMER' };
        const b = await backorder(w, { status, ...extra });
        for (const version of [b.version, 99]) {
          const res = await cancel(w, b.id, { version }).expect(409);
          expect(res.body).toEqual({
            statusCode: 409,
            error: 'BACKORDER_NOT_CANCELLABLE',
            message: 'BACKORDER_NOT_CANCELLABLE',
            status,
          });
        }
        expect((await row(b.id)).status).toBe(status);
        expect(await feedOf(b.id)).toHaveLength(0);
      },
    );

    it('answers 404 BACKORDER_NOT_FOUND for an unknown, malformed or foreign id and leaves the foreign one untouched', async () => {
      const mine = await world();
      const theirs = await world();
      const [foreign] = await queue(theirs, [1]);
      for (const id of [randomUUID(), 'not-a-uuid', foreign.id]) {
        const res = await cancel(mine, id, { version: 1 }).expect(404);
        expect(res.body).toEqual({
          statusCode: 404,
          error: 'BACKORDER_NOT_FOUND',
          message: 'BACKORDER_NOT_FOUND',
        });
      }
      expect((await row(foreign.id)).status).toBe('WAITING');
    });

    it('answers 400 INVALID_BACKORDER_REQUEST without version or with a long reason', async () => {
      const w = await world();
      const [a] = await queue(w, [1]);
      for (const body of [
        {},
        { reason: 'x' },
        { version: '1' },
        { version: 0 },
        { version: 1, reason: 'x'.repeat(281) },
        { version: 1, tenantId: w.tenantId },
      ]) {
        const res = await cancel(w, a.id, body).expect(400);
        expect(res.body).toEqual({
          statusCode: 400,
          error: 'INVALID_BACKORDER_REQUEST',
          message: 'INVALID_BACKORDER_REQUEST',
        });
      }
      expect((await row(a.id)).status).toBe('WAITING');
    });

    it('two concurrent cancels of a RESERVED backorder: one wins, one 409, one release, no deadlock', async () => {
      const w = await world();
      const [a] = await queue(w, [2]);
      await adjust(w, 2);
      const { version } = await row(a.id);
      const results = await Promise.all([
        cancel(w, a.id, { version }),
        cancel(w, a.id, { version }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const loser = results.find((r) => r.status === 409)!;
      expect(['BACKORDER_NOT_CANCELLABLE', 'VERSION_CONFLICT']).toContain(
        loser.body.error,
      );
      expect(await quantityOf(w.productId)).toBe(2);
      const releases = await prisma.stockMovement.count({
        where: {
          tenantId: w.tenantId,
          groupId: a.id,
          type: 'BACKORDER_RELEASE',
        },
      });
      expect(releases).toBe(1);
      expect(await feedOf(a.id)).toHaveLength(2);
    });

    it('a staff cancel racing a stock arrival keeps every unit accounted for', async () => {
      const w = await world();
      const [a, b] = await queue(w, [2, 2]);
      await adjust(w, 2); // a RESERVED
      const { version } = await row(a.id);
      const results = await Promise.allSettled([
        cancel(w, a.id, { version }),
        adjust(w, 2),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(
        (results[0] as PromiseFulfilledResult<{ status: number }>).value.status,
      ).toBe(200);
      expect(
        await Promise.all([a, b].map(async (x) => (await row(x.id)).status)),
      ).toEqual(['CANCELLED', 'RESERVED']);
      // 4 units arrived in total, 2 are held by b, 2 are sellable.
      expect(await quantityOf(w.productId)).toBe(2);
    });

    it('a staff cancel racing the customer cancel of the same RESERVED backorder: one wins, units released once', async () => {
      const w = await world();
      const [a] = await queue(w, [2]);
      await adjust(w, 2);
      const botToken = credentials.register(w.tenantId, [
        BACKORDER_SCOPES.read,
        BACKORDER_SCOPES.cancel,
      ]);
      const { version } = await row(a.id);
      const results = await Promise.all([
        cancel(w, a.id, { version }),
        http()
          .post(`/chatbot-api/backorders/${a.id}/cancel`)
          .set('Authorization', `Bearer ${botToken}`)
          .send({ reason: 'ya no' }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await quantityOf(w.productId)).toBe(2);
      expect(
        await prisma.stockMovement.count({
          where: {
            tenantId: w.tenantId,
            groupId: a.id,
            type: 'BACKORDER_RELEASE',
          },
        }),
      ).toBe(1);
      const stored = await row(a.id);
      expect(stored.status).toBe('CANCELLED');
      expect(['STAFF', 'CUSTOMER']).toContain(stored.cancelledByKind);
      // Exactly one cancel item exists only when the staff cancel won.
      const cancelItems = (await feedOf(a.id)).filter(
        (i) => i.type === 'backorder.cancelled_by_staff',
      );
      expect(cancelItems).toHaveLength(
        stored.cancelledByKind === 'STAFF' ? 1 : 0,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Permissions
  // ---------------------------------------------------------------------------

  describe('permissions (read:Backorder / update:Backorder)', () => {
    it('answers 401 without a token', async () => {
      const anonymous = await http().get('/backorders').expect(401);
      expect(anonymous.body).toEqual({
        statusCode: 401,
        message: 'Unauthorized',
      });
      await http().get(`/backorders/${randomUUID()}`).expect(401);
      await http()
        .post(`/backorders/${randomUUID()}/cancel`)
        .send({ version: 1 })
        .expect(401);
    });

    it('answers 403 on every route to a user without read/update:Backorder', async () => {
      const w = await world();
      const [a] = await queue(w, [1]);
      const nobody = await staff(
        w.tenantId,
        `st-${w.tenantId}`,
        [['Product', 'read']],
        'Sin permiso',
      );
      for (const res of [
        await http().get('/backorders').set(nobody.auth),
        await http().get(`/backorders/${a.id}`).set(nobody.auth),
        await http()
          .post(`/backorders/${a.id}/cancel`)
          .set(nobody.auth)
          .send({ version: 1 }),
      ]) {
        expect(res.status).toBe(403);
        expect(res.body).toEqual({
          statusCode: 403,
          error: 'INSUFFICIENT_PERMISSIONS',
          message: 'Insufficient permissions',
          timestamp: expect.any(String) as unknown,
        });
      }
      expect((await row(a.id)).status).toBe('WAITING');
    });

    it('a Cashier-like user (read only) lists and reads but cannot cancel', async () => {
      const w = await world();
      const [a] = await queue(w, [1]);
      const cashier = await staff(w.tenantId, `st-${w.tenantId}`, READ, 'Caja');
      expect(
        ids(await http().get('/backorders').set(cashier.auth).expect(200)),
      ).toEqual([a.id]);
      await http().get(`/backorders/${a.id}`).set(cashier.auth).expect(200);
      const denied = await http()
        .post(`/backorders/${a.id}/cancel`)
        .set(cashier.auth)
        .send({ version: 1 })
        .expect(403);
      expect(denied.body.statusCode).toBe(403);
      expect((await row(a.id)).status).toBe('WAITING');
    });

    it('update without read still cannot list', async () => {
      const w = await world();
      const updater = await staff(
        w.tenantId,
        `st-${w.tenantId}`,
        [['Backorder', 'update']],
        'Solo update',
      );
      await http().get('/backorders').set(updater.auth).expect(403);
    });

    it('a manager of another sucursal sees nothing of this one even with the grants', async () => {
      const mine = await world();
      const theirs = await world();
      const [a] = await queue(mine, [1]);
      await http()
        .get(`/backorders/${a.id}`)
        .set(theirs.manager.auth)
        .expect(404);
      await cancel404(theirs, a.id);
    });

    const cancel404 = async (w: World, id: string) => {
      await http()
        .post(`/backorders/${id}/cancel`)
        .set(w.manager.auth)
        .send({ version: 1 })
        .expect(404);
      expect((await row(id)).status).toBe('WAITING');
    };
  });

  // ---------------------------------------------------------------------------
  // §9.5 staff notices: who receives them
  // ---------------------------------------------------------------------------

  describe('staff notice recipients (§9.5)', () => {
    it('resolve through read:Backorder: Manager and Cashier grants in, others and inactive users out', async () => {
      const w = await world();
      const slug = `st-${w.tenantId}`;
      const cashier = await staff(w.tenantId, slug, READ, 'Caja');
      const updateOnly = await staff(
        w.tenantId,
        slug,
        [['Backorder', 'update']],
        'Solo update',
      );
      const other = await staff(
        w.tenantId,
        slug,
        [['Product', 'read']],
        'Otro',
      );
      const inactive = await staff(w.tenantId, slug, READ, 'Baja', false);
      const foreign = await world();

      const recipients = await usersWithGrants(
        prisma,
        w.tenantId,
        BACKORDER_NOTICE_GRANTS,
      );
      expect(new Set(recipients)).toEqual(
        new Set([w.manager.userId, cashier.userId]),
      );
      expect(recipients).not.toContain(updateOnly.userId);
      expect(recipients).not.toContain(other.userId);
      expect(recipients).not.toContain(inactive.userId);
      expect(recipients).not.toContain(foreign.manager.userId);
    });
  });
});
