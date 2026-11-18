/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
/**
 * pay-in-store-pickup / T2 (S2, S3, S4) — the hold sweep against PostgreSQL.
 *
 *   - reminder once (`sale.pickup_reminder`, stage 1);
 *   - expiry of an unpaid hold: cancel HOLD_EXPIRED by the system, stock
 *     restored through the journal, promotion usage restored, `sale.canceled`
 *     outbox row, `sale.pickup_expired` once, stage 2;
 *   - paid / partial / pending receipt: never cancelled; partial and pending
 *     receipt give ONE staff notice (in-app, `SALE_HOLD_REVIEW`);
 *   - races: a payment holding the sale row (SKIP LOCKED, then review), a
 *     staff hold edit between candidate read and lock (stale), two sweeps
 *     side by side (one cancel);
 *   - tenant isolation.
 *
 * Boots the REAL ChatbotApiModule (it imports SalesModule) so the sales come
 * from the bot checkout (stock charged by the journal) and the hold from the
 * bot payment-intent route. The sweep is driven through `tick(now)` with a
 * `now` past the deadline; no ScheduleModule is loaded, so `@Interval` is
 * inert here. Assertions are per sale: other suites' rows may also be due.
 */
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { ClsModule } from 'nestjs-cls';
import request from 'supertest';
import {
  BotCredentials,
  disconnectWorldPrisma,
  worldPrisma,
} from '../delivery-zones/test-support/delivery-zone-world';
import { ChatbotApiModule } from '../chatbot-api/chatbot-api.module';
import { SERVICE_CREDENTIAL_REPOSITORY } from '../chatbot-api/domain/service-credential.repository';
import { BOT_AUDIT_LOG_REPOSITORY } from '../chatbot-api/infrastructure/prisma-bot-audit-log.repository';
import { DomainExceptionFilter } from '../shared/filters/domain-exception.filter';
import { PrismaExceptionFilter } from '../shared/filters/prisma-exception.filter';
import { createAppValidationPipe } from '../shared/listing/app-validation.pipe';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import type { PrismaService } from '../shared/prisma/prisma.service';
import { NOTICE_NOTIFY_EVENT_TYPE } from '../notifications/domain/chatbot-request-notice';
import { toNotificationView } from '../notifications/domain/notification-view';
import { noopNotificationEvents } from '../notifications/domain/notification-events.port';
import { listNotificationRows } from '../notifications/infrastructure/notification-rows';
import { ChatbotRequestNotifyConsumer } from '../notifications/outbox/chatbot-request-notify.consumer';
import { SaleHoldSweepScheduler } from './sale-hold-sweep.scheduler';
import { SaleHoldSweepStore } from './sale-hold-sweep.store';

const SKIP =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const d = SKIP ? describe.skip : describe;

const JWT_SECRET = 'sale-hold-sweep-test-secret';
const PHONE = { phoneCountryCode: '52', phone: '5512349999' };
const PRICE = 45000;
const STOCK = 50;
const HOUR = 3_600_000;
const SCOPES = [
  'customers:read',
  'customers:write',
  'sales:create',
  'sales:write',
];

d('sale hold sweep (PostgreSQL)', () => {
  const prisma = worldPrisma();
  const credentials = new BotCredentials();
  const audit = { append: jest.fn(() => Promise.resolve()) };
  const jwt = new JwtService({
    secret: JWT_SECRET,
    signOptions: { expiresIn: '1h' },
  });
  let app: INestApplication;
  let scheduler: SaleHoldSweepScheduler;
  let store: SaleHoldSweepStore;
  const tenantIds: string[] = [];
  const userIds: string[] = [];
  const createdPriceListIds: string[] = [];
  let defaultListId: string;

  beforeAll(async () => {
    const existingDefault = await prisma.globalPriceList.findFirst({
      where: { isDefault: true },
    });
    if (existingDefault) {
      defaultListId = existingDefault.id;
    } else {
      const created = await prisma.globalPriceList.create({
        data: { name: `PUBLICO-sweep-${randomUUID()}`, isDefault: true },
      });
      createdPriceListIds.push(created.id);
      defaultListId = created.id;
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              PROMOTIONS_BUSINESS_TIMEZONE: 'America/Mexico_City',
              BOT_SHIPPING_CHARGE_MAX_CENTS: 50000,
              JWT_SECRET,
              JWT_REFRESH_SECRET: 'sale-hold-sweep-test-refresh',
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
        ChatbotApiModule,
      ],
    })
      .overrideProvider(SERVICE_CREDENTIAL_REPOSITORY)
      .useValue(credentials.repository)
      .overrideProvider(BOT_AUDIT_LOG_REPOSITORY)
      .useValue(audit)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createAppValidationPipe());
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new PrismaExceptionFilter(),
    );
    await app.init();
    scheduler = app.get(SaleHoldSweepScheduler);
    store = app.get(SaleHoldSweepStore);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app?.close();
    if (tenantIds.length > 0) {
      await prisma.notification.deleteMany({
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

  async function user(tenantId: string, name: string, grants: string[]) {
    const userId = randomUUID();
    userIds.push(userId);
    await prisma.user.create({
      data: {
        id: userId,
        name,
        email: `${userId}@sweep.invalid`,
        hashedPassword: 'unused-test-fixture',
        isActive: true,
      },
    });
    const role = await prisma.role.create({
      data: { tenantId, name: `${name} ${userId}` },
    });
    for (const grant of grants) {
      const [subject, action] = grant.split(':');
      const permission = await prisma.permission.upsert({
        where: { subject_action: { subject, action } },
        update: {},
        create: { subject, action, description: `${action} ${subject}` },
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
      email: `${userId}@sweep.invalid`,
      tenantId,
      tenantSlug: `sweep-${tenantId}`,
      isSuperAdmin: false,
    });
    return { userId, token };
  }

  async function sucursal() {
    const tenantId = randomUUID();
    tenantIds.push(tenantId);
    await prisma.tenant.create({
      data: { id: tenantId, name: 'Sucursal Sur', slug: `sweep-${tenantId}` },
    });
    const cashier = await user(tenantId, 'Bot cashier', []);
    const staff = await user(tenantId, 'Mostrador', [
      'Sale:read',
      'Sale:update',
    ]);
    const reader = await user(tenantId, 'Solo lectura', ['Sale:read']);
    const productId = randomUUID();
    await prisma.product.create({
      data: {
        id: productId,
        tenantId,
        name: 'Croquetas',
        useStock: true,
        quantity: STOCK,
      },
    });
    await prisma.priceList.create({
      data: {
        tenantId,
        productId,
        globalPriceListId: defaultListId,
        priceCents: PRICE,
      },
    });
    await prisma.shippingOrigin.create({
      data: {
        tenantId,
        addressLine1: 'Av. Juárez 2',
        neighborhood: 'Centro',
        municipality: 'Cuauhtémoc',
        state: 'Ciudad de México',
        postalCode: '06000',
        contactPhone: '5512345678',
      },
    });
    const customerId = randomUUID();
    await prisma.customer.create({
      data: { id: customerId, tenantId, firstName: 'Iris', ...PHONE },
    });
    const token = credentials.register(tenantId, SCOPES);
    return {
      tenantId,
      cashierUserId: cashier.userId,
      staff,
      reader,
      productId,
      customerId,
      token,
    };
  }
  type Sucursal = Awaited<ReturnType<typeof sucursal>>;

  const http = () => request(app.getHttpServer());

  /** A real bot PICKUP sale marked IN_STORE (24 h hold, reminder at 21 h). */
  async function heldSale(
    s: Sucursal,
  ): Promise<{ saleId: string; folio: string; holdUntil: Date }> {
    const res = await http()
      .post('/chatbot-api/sales')
      .set('Authorization', `Bearer ${s.token}`)
      .set('X-Idempotency-Key', `pickup-${randomUUID()}`)
      .send({
        cashierUserId: s.cashierUserId,
        customerId: s.customerId,
        items: [
          {
            productId: s.productId,
            productName: 'Croquetas',
            quantity: 1,
            unitPriceCents: PRICE,
          },
        ],
        shipping: { mode: 'pickup' },
      })
      .expect(201);
    const saleId: string = res.body.saleId;
    const hold = await http()
      .patch(`/chatbot-api/sales/${saleId}/payment-intent`)
      .set('Authorization', `Bearer ${s.token}`)
      .send({ method: 'IN_STORE' })
      .expect(200);
    return {
      saleId,
      folio: res.body.folio,
      holdUntil: new Date(hold.body.holdUntil),
    };
  }

  const saleRow = (saleId: string) =>
    prisma.sale.findUniqueOrThrow({
      where: { id: saleId },
      select: {
        status: true,
        cancelReason: true,
        canceledByUserId: true,
        canceledAt: true,
        paymentStatus: true,
        holdStage: true,
        holdVersion: true,
      },
    });

  const stockOf = async (productId: string) =>
    (
      await prisma.product.findUniqueOrThrow({
        where: { id: productId },
        select: { quantity: true },
      })
    ).quantity;

  const feedItems = (saleId: string, type: string) =>
    prisma.chatbotFeedItem.findMany({ where: { saleId, type } });

  const canceledEvents = (tenantId: string, saleId: string) =>
    prisma.outboxEvent.findMany({
      where: {
        tenantId,
        aggregateId: saleId,
        eventType: 'sale.canceled',
      },
    });

  const reviewNotices = (tenantId: string, saleId: string) =>
    prisma.outboxEvent.findMany({
      where: {
        tenantId,
        aggregateId: saleId,
        eventType: NOTICE_NOTIFY_EVENT_TYPE,
      },
    });

  const after = (deadline: Date, ms = 60_000) =>
    new Date(deadline.getTime() + ms);

  describe('reminder stage (S3)', () => {
    it('sends the customer reminder once when it is due, then waits for the deadline', async () => {
      const s = await sucursal();
      const { saleId, holdUntil } = await heldSale(s);
      const reminderDue = new Date(holdUntil.getTime() - 3 * HOUR + 1000);

      // Before the reminder instant nothing happens.
      await scheduler.tick(new Date(holdUntil.getTime() - 3 * HOUR - 1000));
      expect(await feedItems(saleId, 'sale.pickup_reminder')).toHaveLength(0);
      expect((await saleRow(saleId)).holdStage).toBe(0);

      const first = await scheduler.tick(reminderDue);
      expect(first.reminders).toBeGreaterThanOrEqual(1);
      const items = await feedItems(saleId, 'sale.pickup_reminder');
      expect(items).toHaveLength(1);
      expect(items[0].tenantId).toBe(s.tenantId);
      expect(items[0].payload).toMatchObject({
        saleId,
        holdUntil: holdUntil.toISOString(),
        holdVersion: 1,
      });
      expect(await saleRow(saleId)).toMatchObject({
        status: 'CONFIRMED',
        holdStage: 1,
        holdVersion: 1,
      });

      // A second tick (or a replica) never reminds twice.
      await scheduler.tick(new Date(reminderDue.getTime() + 60_000));
      expect(await feedItems(saleId, 'sale.pickup_reminder')).toHaveLength(1);
      expect((await saleRow(saleId)).holdStage).toBe(1);
    });

    it('sends no reminder to a fully paid sale and takes it out of the hold flow', async () => {
      const s = await sucursal();
      const { saleId, holdUntil } = await heldSale(s);
      await http()
        .post(`/sales/${saleId}/payments`)
        .set('Authorization', `Bearer ${s.staff.token}`)
        .set('Idempotency-Key', `paid-${randomUUID()}`)
        .send({ method: 'cash', amountCents: PRICE })
        .expect(201);

      await scheduler.tick(new Date(holdUntil.getTime() - 2 * HOUR));
      expect(await feedItems(saleId, 'sale.pickup_reminder')).toHaveLength(0);
      expect(await saleRow(saleId)).toMatchObject({
        status: 'CONFIRMED',
        paymentStatus: 'PAID',
        holdStage: 2,
      });
      expect(await reviewNotices(s.tenantId, saleId)).toHaveLength(0);
    });
  });

  describe('expiry stage (S2)', () => {
    it('cancels an unpaid expired hold: HOLD_EXPIRED, stock and promotion usage restored, sale.canceled, expired item once', async () => {
      const s = await sucursal();
      const { saleId, holdUntil } = await heldSale(s);
      expect(await stockOf(s.productId)).toBe(STOCK - 1);
      // A capacity claim of this sale (as the checkout records it).
      const promotionId = randomUUID();
      await prisma.promotion.create({
        data: {
          id: promotionId,
          tenantId: s.tenantId,
          title: `Hold ${promotionId.slice(0, 8)}`,
          type: 'ORDER_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'FIXED',
          discountValue: 100,
          maxProductUnits: 10,
          consumedProductUnits: 1,
        },
      });
      await prisma.promotionUsage.create({
        data: { tenantId: s.tenantId, saleId, promotionId, units: 1 },
      });

      const result = await scheduler.tick(after(holdUntil));
      expect(result.expired).toBeGreaterThanOrEqual(1);

      const row = await saleRow(saleId);
      expect(row).toMatchObject({
        status: 'CANCELED',
        cancelReason: 'HOLD_EXPIRED',
        canceledByUserId: 'system',
        holdStage: 2,
        holdVersion: 1,
      });
      expect(row.canceledAt).not.toBeNull();
      expect(await stockOf(s.productId)).toBe(STOCK);
      const reversal = await prisma.stockMovement.findMany({
        where: { tenantId: s.tenantId, productId: s.productId, delta: 1 },
      });
      expect(reversal).toHaveLength(1);
      expect(reversal[0].actorDisplayName).toBe('Sistema');
      const promotion = await prisma.promotion.findUniqueOrThrow({
        where: { id: promotionId },
        select: { consumedProductUnits: true },
      });
      expect(promotion.consumedProductUnits).toBe(0);
      const usage = await prisma.promotionUsage.findFirstOrThrow({
        where: { saleId, promotionId },
      });
      expect(usage.restoredAt).not.toBeNull();
      const canceled = await canceledEvents(s.tenantId, saleId);
      expect(canceled).toHaveLength(1);
      expect(canceled[0].payload).toMatchObject({
        saleId,
        tenantId: s.tenantId,
        reason: 'HOLD_EXPIRED',
        actorId: 'system',
        refundedCents: 0,
      });
      const expiredItems = await feedItems(saleId, 'sale.pickup_expired');
      expect(expiredItems).toHaveLength(1);
      expect(expiredItems[0].payload).toMatchObject({ saleId, holdVersion: 1 });
      // A missed reminder is not sent after the deadline.
      expect(await feedItems(saleId, 'sale.pickup_reminder')).toHaveLength(0);
      expect(await reviewNotices(s.tenantId, saleId)).toHaveLength(0);

      // Idempotent: the next tick finds nothing for this sale.
      await scheduler.tick(after(holdUntil, 2 * HOUR));
      expect(await feedItems(saleId, 'sale.pickup_expired')).toHaveLength(1);
      expect(await canceledEvents(s.tenantId, saleId)).toHaveLength(1);
      expect(await stockOf(s.productId)).toBe(STOCK);
    });

    it('the staff detail shows the system cancellation with reason HOLD_EXPIRED', async () => {
      const s = await sucursal();
      const { saleId, holdUntil } = await heldSale(s);
      await scheduler.tick(after(holdUntil));
      const detail = await http()
        .get(`/sales/${saleId}`)
        .set('Authorization', `Bearer ${s.staff.token}`)
        .expect(200);
      expect(detail.body).toMatchObject({
        status: 'CANCELED',
        cancelReason: 'HOLD_EXPIRED',
      });
      expect(detail.body.canceledBy ?? null).toBeNull();
    });
  });

  describe('S4: payment or pending receipt -> no cancel, one staff notice', () => {
    it('a fully paid sale whose deadline passed is left alone, silently', async () => {
      const s = await sucursal();
      const { saleId, holdUntil } = await heldSale(s);
      await scheduler.tick(new Date(holdUntil.getTime() - 2 * HOUR)); // reminded
      await http()
        .post(`/sales/${saleId}/payments`)
        .set('Authorization', `Bearer ${s.staff.token}`)
        .set('Idempotency-Key', `paid-${randomUUID()}`)
        .send({ method: 'cash', amountCents: PRICE })
        .expect(201);

      await scheduler.tick(after(holdUntil));
      expect(await saleRow(saleId)).toMatchObject({
        status: 'CONFIRMED',
        paymentStatus: 'PAID',
        holdStage: 2,
      });
      expect(await canceledEvents(s.tenantId, saleId)).toHaveLength(0);
      expect(await feedItems(saleId, 'sale.pickup_expired')).toHaveLength(0);
      expect(await reviewNotices(s.tenantId, saleId)).toHaveLength(0);
    });

    it('a partially paid sale is not cancelled and staff get one notice', async () => {
      const s = await sucursal();
      const { saleId, folio, holdUntil } = await heldSale(s);
      await http()
        .post(`/sales/${saleId}/payments`)
        .set('Authorization', `Bearer ${s.staff.token}`)
        .set('Idempotency-Key', `partial-${randomUUID()}`)
        .send({ method: 'cash', amountCents: 1000 })
        .expect(201);

      // The reminder stage skips the customer reminder but keeps the hold.
      await scheduler.tick(new Date(holdUntil.getTime() - 2 * HOUR));
      expect(await feedItems(saleId, 'sale.pickup_reminder')).toHaveLength(0);
      expect((await saleRow(saleId)).holdStage).toBe(1);

      await scheduler.tick(after(holdUntil));
      await scheduler.tick(after(holdUntil, HOUR));
      expect(await saleRow(saleId)).toMatchObject({
        status: 'CONFIRMED',
        paymentStatus: 'PARTIAL',
        holdStage: 2,
      });
      expect(await stockOf(s.productId)).toBe(STOCK - 1);
      expect(await canceledEvents(s.tenantId, saleId)).toHaveLength(0);
      expect(await feedItems(saleId, 'sale.pickup_expired')).toHaveLength(0);
      const notices = await reviewNotices(s.tenantId, saleId);
      expect(notices).toHaveLength(1);
      expect(notices[0].payload).toEqual({
        type: 'SALE_HOLD_REVIEW',
        saleId,
        saleFolio: folio,
        holdVersion: 1,
        reason: 'PAYMENT_RECEIVED',
        dedupKey: `hold-review:${saleId}:1`,
      });
    });

    it('a pending receipt blocks the cancel; the notice reaches update:Sale staff in-app only', async () => {
      const s = await sucursal();
      const { saleId, folio, holdUntil } = await heldSale(s);
      await prisma.receiptEvidence.create({
        data: {
          tenantId: s.tenantId,
          saleId,
          mediaUrl: 'https://unused.invalid/r.jpg',
          status: 'PENDING',
        },
      });

      await scheduler.tick(after(holdUntil));
      expect(await saleRow(saleId)).toMatchObject({
        status: 'CONFIRMED',
        paymentStatus: 'CREDIT',
        holdStage: 2,
      });
      expect(await stockOf(s.productId)).toBe(STOCK - 1);
      expect(await canceledEvents(s.tenantId, saleId)).toHaveLength(0);
      expect(await feedItems(saleId, 'sale.pickup_expired')).toHaveLength(0);
      const notices = await reviewNotices(s.tenantId, saleId);
      expect(notices).toHaveLength(1);
      expect(notices[0].payload).toMatchObject({ reason: 'RECEIPT_PENDING' });

      // Delivered by the request-notice consumer: staff with update:Sale get
      // one in-app notification; a read-only user does not; no email job.
      const consumer = new ChatbotRequestNotifyConsumer(
        prisma as unknown as PrismaService,
        noopNotificationEvents,
        () => new Date(),
        25,
        3,
      );
      for (let i = 0; i < 200 && (await consumer.processOne()); i++);
      const published = await prisma.outboxEvent.findUniqueOrThrow({
        where: { id: notices[0].id },
      });
      expect(published.status).toBe('PUBLISHED');
      const rows = await prisma.notification.findMany({
        where: { tenantId: s.tenantId },
      });
      expect(rows.map((row) => row.userId)).toEqual([s.staff.userId]);
      expect(rows[0]).toMatchObject({
        type: 'SALE_HOLD_REVIEW',
        requestId: null,
        dedupKey: `hold-review:${saleId}:1`,
      });
      const [viewRow] = await listNotificationRows(prisma, {
        tenantId: s.tenantId,
        userId: s.staff.userId,
        unreadOnly: false,
        take: 5,
      });
      expect(toNotificationView(viewRow)).toMatchObject({
        type: 'SALE_HOLD_REVIEW',
        title: 'Apartado vencido: revisa la venta',
        body: `Venta ${folio} · Comprobante pendiente de revisar`,
        folio,
        saleId,
        requestId: null,
        requestOpen: null,
      });
      expect(
        await prisma.outboxEvent.count({
          where: {
            tenantId: s.tenantId,
            aggregateType: 'Notification',
            aggregateId: rows[0].id,
          },
        }),
      ).toBe(0);
    });
  });

  describe('races', () => {
    it('a payment holding the sale row wins: the sweep skips it, then reviews instead of cancelling', async () => {
      const s = await sucursal();
      const { saleId, holdUntil } = await heldSale(s);
      let commit!: () => void;
      const released = new Promise<void>((resolve) => (commit = resolve));
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));
      const payment = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM sales WHERE id = ${saleId} FOR UPDATE`;
          await tx.sale.update({
            where: { id: saleId },
            data: {
              paidCents: 1000,
              debtCents: PRICE - 1000,
              paymentStatus: 'PARTIAL',
            },
          });
          locked();
          await released;
        },
        { timeout: 30_000 },
      );
      await isLocked;

      const busy = await scheduler.tick(after(holdUntil));
      expect(busy.skipped).toBeGreaterThanOrEqual(1);
      expect((await saleRow(saleId)).status).toBe('CONFIRMED');

      commit();
      await payment;
      await scheduler.tick(after(holdUntil));
      expect(await saleRow(saleId)).toMatchObject({
        status: 'CONFIRMED',
        paymentStatus: 'PARTIAL',
        holdStage: 2,
      });
      expect(await canceledEvents(s.tenantId, saleId)).toHaveLength(0);
      expect(await reviewNotices(s.tenantId, saleId)).toHaveLength(1);
    });

    it('a staff hold edit between the candidate read and the lock makes the candidate stale', async () => {
      const s = await sucursal();
      const { saleId, holdUntil } = await heldSale(s);
      const proto = Object.getPrototypeOf(store) as {
        readCandidates: (...args: unknown[]) => Promise<unknown[]>;
      };
      const original = proto.readCandidates;
      jest
        .spyOn(proto, 'readCandidates')
        .mockImplementationOnce(async function (
          this: unknown,
          ...args: unknown[]
        ) {
          const rows = (await original.call(this, ...args)) as unknown[];
          await http()
            .patch(`/sales/${saleId}/hold`)
            .set('Authorization', `Bearer ${s.staff.token}`)
            .send({
              expiresAt: new Date(Date.now() + 48 * HOUR).toISOString(),
              expectedVersion: 1,
            })
            .expect(200);
          return rows;
        });

      const result = await scheduler.tick(after(holdUntil));
      expect(result.stale).toBeGreaterThanOrEqual(1);
      expect(await saleRow(saleId)).toMatchObject({
        status: 'CONFIRMED',
        holdStage: 0,
        holdVersion: 2,
      });
      expect(await canceledEvents(s.tenantId, saleId)).toHaveLength(0);
      expect(await feedItems(saleId, 'sale.pickup_expired')).toHaveLength(0);
    });

    it('two sweeps side by side cancel the sale once', async () => {
      const s = await sucursal();
      const { saleId, holdUntil } = await heldSale(s);
      const now = after(holdUntil);
      const [a, b] = await Promise.all([
        store.runBatch(now),
        store.runBatch(now),
      ]);
      expect(a.failed + b.failed).toBe(0);
      expect((await saleRow(saleId)).status).toBe('CANCELED');
      expect(await canceledEvents(s.tenantId, saleId)).toHaveLength(1);
      expect(await feedItems(saleId, 'sale.pickup_expired')).toHaveLength(1);
      expect(await stockOf(s.productId)).toBe(STOCK);
      expect(
        await prisma.stockMovement.count({
          where: { tenantId: s.tenantId, productId: s.productId, delta: 1 },
        }),
      ).toBe(1);
    });
  });

  it('tenant isolation: each sale is cancelled in its own tenant and touches only its own stock', async () => {
    const north = await sucursal();
    const south = await sucursal();
    const n = await heldSale(north);
    const sNorth = await heldSale(north);
    const keep = await heldSale(south);
    // South's hold is extended by staff of south: it is not due.
    await http()
      .patch(`/sales/${keep.saleId}/hold`)
      .set('Authorization', `Bearer ${south.staff.token}`)
      .send({
        expiresAt: new Date(n.holdUntil.getTime() + 48 * HOUR).toISOString(),
        expectedVersion: 1,
      })
      .expect(200);

    await scheduler.tick(after(n.holdUntil));

    for (const id of [n.saleId, sNorth.saleId]) {
      expect((await saleRow(id)).status).toBe('CANCELED');
      const [event] = await canceledEvents(north.tenantId, id);
      expect(event.tenantId).toBe(north.tenantId);
      const [item] = await feedItems(id, 'sale.pickup_expired');
      expect(item.tenantId).toBe(north.tenantId);
    }
    expect(await stockOf(north.productId)).toBe(STOCK);
    expect(await saleRow(keep.saleId)).toMatchObject({
      status: 'CONFIRMED',
      holdStage: 0,
    });
    expect(await stockOf(south.productId)).toBe(STOCK - 1);
    expect(
      await prisma.outboxEvent.count({
        where: { tenantId: south.tenantId, eventType: 'sale.canceled' },
      }),
    ).toBe(0);
  });

  it('a failing sale backs off and never blocks the rest of the batch', async () => {
    const s = await sucursal();
    const poison = await heldSale(s);
    const healthy = await heldSale(s);
    const proto = Object.getPrototypeOf(store) as {
      handle: (...args: unknown[]) => Promise<unknown>;
    };
    const original = proto.handle;
    jest.spyOn(proto, 'handle').mockImplementation(function (
      this: unknown,
      ...args: unknown[]
    ) {
      const candidate = args[0] as { id: string };
      if (candidate.id === poison.saleId) {
        return Promise.reject(new Error('boom'));
      }
      return original.call(this, ...args) as Promise<unknown>;
    });

    const now = after(healthy.holdUntil);
    const first = await scheduler.tick(now);
    expect(first.failed).toBeGreaterThanOrEqual(1);
    expect((await saleRow(healthy.saleId)).status).toBe('CANCELED');
    expect((await saleRow(poison.saleId)).status).toBe('CONFIRMED');

    // Backed off: the next tick within the backoff does not retry it.
    const second = await scheduler.tick(new Date(now.getTime() + 1000));
    expect(second.failed).toBe(0);

    // After the backoff the row is retried (and now succeeds).
    jest.restoreAllMocks();
    await scheduler.tick(new Date(Date.now() + 2 * 60_000 + 25 * HOUR));
    expect((await saleRow(poison.saleId)).status).toBe('CANCELED');
  });
});
