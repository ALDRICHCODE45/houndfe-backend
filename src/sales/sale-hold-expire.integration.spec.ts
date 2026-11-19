/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
/**
 * pay-in-store-pickup / T6 (S10, S11, S12) — «Vencer apartado ahora» against
 * PostgreSQL: POST /sales/:id/hold/expire runs the hold sweep's own expiry
 * decision now, for staff (update:Sale, Idempotency-Key).
 *
 *   - CANCELLED: unpaid, no pending receipt -> cancel HOLD_EXPIRED by the
 *     ACTING user (stock actor too), `sale.pickup_expired`, stage 2;
 *   - REVIEW: partial payment or pending receipt -> stage 2, one
 *     SALE_HOLD_REVIEW notice, one `sale.pickup_expired_review` (S12);
 *   - SETTLED: fully paid -> stage 2 silently;
 *   - errors, idempotent replay, permission, tenant isolation, the race with
 *     the sweep (one cancel), the read model of a cancelled + expired sale;
 *   - S12 on the other producers: `branchName` on every `sale.pickup_*`, the
 *     staff edit's `previousHoldUntil` + `direction`, the sweep's
 *     `sale.pickup_expired_review`, and the sweep's cancel still by `system`.
 *
 * Same boot as the sweep spec: the REAL ChatbotApiModule (it imports
 * SalesModule), sales from the bot checkout, the hold from the bot route.
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
import { NOTICE_NOTIFY_EVENT_TYPE } from '../notifications/domain/chatbot-request-notice';
import { SaleHoldSweepScheduler } from './sale-hold-sweep.scheduler';
import { SaleHoldSweepStore } from './sale-hold-sweep.store';

const SKIP =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const d = SKIP ? describe.skip : describe;

const JWT_SECRET = 'sale-hold-expire-test-secret';
const PHONE = { phoneCountryCode: '52', phone: '5512348888' };
const CHAT_KEY = '525512348888';
const BRANCH = 'Sucursal Poniente';
const PRICE = 45000;
const STOCK = 50;
const HOUR = 3_600_000;
const SCOPES = [
  'customers:read',
  'customers:write',
  'sales:create',
  'sales:write',
];

d('POST /sales/:id/hold/expire (PostgreSQL)', () => {
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
        data: { name: `PUBLICO-expire-${randomUUID()}`, isDefault: true },
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
              JWT_REFRESH_SECRET: 'sale-hold-expire-test-refresh',
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
        email: `${userId}@expire.invalid`,
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
      email: `${userId}@expire.invalid`,
      tenantId,
      tenantSlug: `expire-${tenantId}`,
      isSuperAdmin: false,
    });
    return { userId, token, name };
  }

  async function sucursal() {
    const tenantId = randomUUID();
    tenantIds.push(tenantId);
    await prisma.tenant.create({
      data: { id: tenantId, name: BRANCH, slug: `expire-${tenantId}` },
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
    const conversationRef = `wa:${tenantId.slice(0, 8)}`;
    await prisma.chatbotConversation.create({
      data: { tenantId, conversationRef, customerKey: CHAT_KEY },
    });
    const token = credentials.register(tenantId, SCOPES);
    return {
      tenantId,
      cashierUserId: cashier.userId,
      staff,
      reader,
      productId,
      customerId,
      conversationRef,
      token,
    };
  }
  type Sucursal = Awaited<ReturnType<typeof sucursal>>;

  const http = () => request(app.getHttpServer());

  /** A real bot PICKUP sale marked IN_STORE (24 h hold, version 1). */
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

  const expire = (
    token: string,
    saleId: string,
    body: Record<string, unknown>,
    key: string | null = `expire-${randomUUID()}`,
  ) => {
    const req = http()
      .post(`/sales/${saleId}/hold/expire`)
      .set('Authorization', `Bearer ${token}`);
    if (key !== null) req.set('Idempotency-Key', key);
    return req.send(body);
  };

  const pay = (s: Sucursal, saleId: string, amountCents: number) =>
    http()
      .post(`/sales/${saleId}/payments`)
      .set('Authorization', `Bearer ${s.staff.token}`)
      .set('Idempotency-Key', `pay-${randomUUID()}`)
      .send({ method: 'cash', amountCents })
      .expect(201);

  const saleRow = (saleId: string) =>
    prisma.sale.findUniqueOrThrow({
      where: { id: saleId },
      select: {
        status: true,
        cancelReason: true,
        canceledByUserId: true,
        canceledAt: true,
        paymentStatus: true,
        holdExpiresAt: true,
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
      where: { tenantId, aggregateId: saleId, eventType: 'sale.canceled' },
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

  describe('outcomes (S11: exactly the sweep decision, now)', () => {
    it('CANCELLED: unpaid -> HOLD_EXPIRED by the acting user, stock back, sale.pickup_expired once, stage 2', async () => {
      const s = await sucursal();
      const { saleId, folio, holdUntil } = await heldSale(s);
      expect(await stockOf(s.productId)).toBe(STOCK - 1);

      const res = await expire(s.staff.token, saleId, {
        expectedVersion: 1,
      }).expect(200);

      expect(res.body).toMatchObject({
        id: saleId,
        outcome: 'CANCELLED',
        status: 'CANCELED',
        cancelReason: 'HOLD_EXPIRED',
        canceledBy: { id: s.staff.userId, name: 'Mostrador' },
        hold: {
          paymentIntent: 'IN_STORE',
          expiresAt: holdUntil.toISOString(),
          stage: 2,
          version: 1,
        },
      });
      expect(res.body.hold.expiredAt).toBe(res.body.canceledAt);

      const row = await saleRow(saleId);
      expect(row).toMatchObject({
        status: 'CANCELED',
        cancelReason: 'HOLD_EXPIRED',
        canceledByUserId: s.staff.userId,
        holdStage: 2,
        holdVersion: 1,
      });
      // The deadline is not rewritten: the expiry is the cancel instant.
      expect(row.holdExpiresAt?.toISOString()).toBe(holdUntil.toISOString());
      expect(await stockOf(s.productId)).toBe(STOCK);
      const reversal = await prisma.stockMovement.findMany({
        where: { tenantId: s.tenantId, productId: s.productId, delta: 1 },
      });
      expect(reversal).toHaveLength(1);
      expect(reversal[0].actorDisplayName).toBe('Mostrador');
      const canceled = await canceledEvents(s.tenantId, saleId);
      expect(canceled).toHaveLength(1);
      expect(canceled[0].payload).toMatchObject({
        reason: 'HOLD_EXPIRED',
        actorId: s.staff.userId,
      });
      const items = await feedItems(saleId, 'sale.pickup_expired');
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        tenantId: s.tenantId,
        requestId: null,
        conversationRef: s.conversationRef,
      });
      expect(items[0].payload).toEqual({
        saleId,
        folio,
        branchName: BRANCH,
        holdVersion: 1,
        conversationRef: s.conversationRef,
      });
      expect(await feedItems(saleId, 'sale.pickup_expired_review')).toEqual([]);
      expect(await reviewNotices(s.tenantId, saleId)).toHaveLength(0);

      // The sweep finds nothing left to do for it.
      await scheduler.tick(after(holdUntil));
      expect(await canceledEvents(s.tenantId, saleId)).toHaveLength(1);
      expect(await feedItems(saleId, 'sale.pickup_expired')).toHaveLength(1);
    });

    it('REVIEW (partial payment): no cancel, stage 2, one staff notice, one sale.pickup_expired_review', async () => {
      const s = await sucursal();
      const { saleId, folio } = await heldSale(s);
      await pay(s, saleId, 1000);

      const res = await expire(s.staff.token, saleId, {
        expectedVersion: 1,
      }).expect(200);
      expect(res.body).toMatchObject({
        outcome: 'REVIEW',
        status: 'CONFIRMED',
        paymentStatus: 'PARTIAL',
        hold: { stage: 2, version: 1 },
      });
      // Not cancelled: no expiry instant is stored, so no `expiredAt`.
      expect(res.body.hold).not.toHaveProperty('expiredAt');
      expect(await saleRow(saleId)).toMatchObject({
        status: 'CONFIRMED',
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
      const items = await feedItems(saleId, 'sale.pickup_expired_review');
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        requestId: null,
        conversationRef: s.conversationRef,
      });
      expect(items[0].payload).toEqual({
        saleId,
        folio,
        branchName: BRANCH,
        holdVersion: 1,
        conversationRef: s.conversationRef,
      });
    });

    it('REVIEW (pending receipt): no cancel, notice reason RECEIPT_PENDING', async () => {
      const s = await sucursal();
      const { saleId } = await heldSale(s);
      await prisma.receiptEvidence.create({
        data: {
          tenantId: s.tenantId,
          saleId,
          mediaUrl: 'https://unused.invalid/r.jpg',
          status: 'PENDING',
        },
      });
      const res = await expire(s.staff.token, saleId, {
        expectedVersion: 1,
      }).expect(200);
      expect(res.body).toMatchObject({
        outcome: 'REVIEW',
        status: 'CONFIRMED',
        paymentStatus: 'CREDIT',
        hold: { stage: 2 },
      });
      const notices = await reviewNotices(s.tenantId, saleId);
      expect(notices).toHaveLength(1);
      expect(notices[0].payload).toMatchObject({ reason: 'RECEIPT_PENDING' });
      expect(
        await feedItems(saleId, 'sale.pickup_expired_review'),
      ).toHaveLength(1);
      expect(await canceledEvents(s.tenantId, saleId)).toHaveLength(0);
    });

    it('SETTLED (fully paid): stage 2 silently, no notice, no feed item', async () => {
      const s = await sucursal();
      const { saleId } = await heldSale(s);
      await pay(s, saleId, PRICE);
      const res = await expire(s.staff.token, saleId, {
        expectedVersion: 1,
      }).expect(200);
      expect(res.body).toMatchObject({
        outcome: 'SETTLED',
        status: 'CONFIRMED',
        paymentStatus: 'PAID',
        hold: { stage: 2 },
      });
      expect(res.body.hold).not.toHaveProperty('expiredAt');
      expect(await reviewNotices(s.tenantId, saleId)).toHaveLength(0);
      expect(await prisma.chatbotFeedItem.count({ where: { saleId } })).toBe(0);
    });
  });

  describe('errors', () => {
    it('HOLD_VERSION_CONFLICT on a stale version: nothing changes, the key is not consumed', async () => {
      const s = await sucursal();
      const { saleId } = await heldSale(s);
      const key = `expire-${randomUUID()}`;
      const res = await expire(
        s.staff.token,
        saleId,
        { expectedVersion: 7 },
        key,
      );
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('HOLD_VERSION_CONFLICT');
      expect(await saleRow(saleId)).toMatchObject({
        status: 'CONFIRMED',
        holdStage: 0,
      });
      expect(await stockOf(s.productId)).toBe(STOCK - 1);
      expect(
        await prisma.saleIdempotency.count({
          where: { tenantId: s.tenantId, key },
        }),
      ).toBe(0);
    });

    it('HOLD_ALREADY_CLOSED once expired; SALE_HOLD_NOT_EDITABLE on a staff-cancelled sale; SALE_NOT_PAY_IN_STORE; SALE_NOT_FOUND', async () => {
      const s = await sucursal();
      const { saleId } = await heldSale(s);
      await expire(s.staff.token, saleId, { expectedVersion: 1 }).expect(200);
      const closed = await expire(s.staff.token, saleId, {
        expectedVersion: 1,
      });
      expect(closed.status).toBe(409);
      expect(closed.body.error).toBe('HOLD_ALREADY_CLOSED');

      const other = await heldSale(s);
      await prisma.sale.update({
        where: { id: other.saleId },
        data: { status: 'CANCELED', cancelReason: 'CUSTOMER_REQUEST' },
      });
      const notEditable = await expire(s.staff.token, other.saleId, {
        expectedVersion: 1,
      });
      expect(notEditable.status).toBe(409);
      expect(notEditable.body.error).toBe('SALE_HOLD_NOT_EDITABLE');

      const plain = await heldSale(s);
      await prisma.sale.update({
        where: { id: plain.saleId },
        data: { paymentIntent: null },
      });
      const notInStore = await expire(s.staff.token, plain.saleId, {
        expectedVersion: 1,
      });
      expect(notInStore.status).toBe(409);
      expect(notInStore.body.error).toBe('SALE_NOT_PAY_IN_STORE');

      const missing = await expire(s.staff.token, randomUUID(), {
        expectedVersion: 1,
      });
      expect(missing.status).toBe(404);
      expect(missing.body.error).toBe('SALE_NOT_FOUND');
    });

    it('400 without Idempotency-Key or with an invalid body', async () => {
      const s = await sucursal();
      const { saleId } = await heldSale(s);
      const noKey = await expire(
        s.staff.token,
        saleId,
        { expectedVersion: 1 },
        null,
      );
      expect(noKey.status).toBe(400);
      expect(JSON.stringify(noKey.body)).toContain('IDEMPOTENCY_KEY_REQUIRED');
      const badBody = await expire(s.staff.token, saleId, {});
      expect(badBody.status).toBe(400);
      expect((await saleRow(saleId)).holdStage).toBe(0);
    });

    it('403 without update:Sale', async () => {
      const s = await sucursal();
      const { saleId } = await heldSale(s);
      const res = await expire(s.reader.token, saleId, { expectedVersion: 1 });
      expect(res.status).toBe(403);
      expect(await saleRow(saleId)).toMatchObject({
        status: 'CONFIRMED',
        holdStage: 0,
      });
    });

    it('tenant isolation: staff of another branch get 404 and the sale is untouched', async () => {
      const north = await sucursal();
      const south = await sucursal();
      const { saleId } = await heldSale(north);
      const res = await expire(south.staff.token, saleId, {
        expectedVersion: 1,
      });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('SALE_NOT_FOUND');
      expect(await saleRow(saleId)).toMatchObject({
        status: 'CONFIRMED',
        holdStage: 0,
      });
      expect(await stockOf(north.productId)).toBe(STOCK - 1);
      expect(await feedItems(saleId, 'sale.pickup_expired')).toHaveLength(0);
    });
  });

  describe('idempotency', () => {
    it('a replay with the same key returns the first result; the same key with another body is IDEMPOTENCY_KEY_CONFLICT', async () => {
      const s = await sucursal();
      const { saleId } = await heldSale(s);
      const key = `expire-${randomUUID()}`;
      const first = await expire(
        s.staff.token,
        saleId,
        { expectedVersion: 1 },
        key,
      ).expect(200);
      const replay = await expire(
        s.staff.token,
        saleId,
        { expectedVersion: 1 },
        key,
      ).expect(200);
      expect(replay.body).toEqual(first.body);
      expect(replay.body.outcome).toBe('CANCELLED');
      expect(await canceledEvents(s.tenantId, saleId)).toHaveLength(1);
      expect(await feedItems(saleId, 'sale.pickup_expired')).toHaveLength(1);

      const conflict = await expire(
        s.staff.token,
        saleId,
        { expectedVersion: 2 },
        key,
      );
      expect(conflict.status).toBe(409);
      expect(conflict.body.error).toBe('IDEMPOTENCY_KEY_CONFLICT');
    });
  });

  it('race: the sweep and a manual expire side by side cancel the sale once', async () => {
    const s = await sucursal();
    const { saleId, holdUntil } = await heldSale(s);
    const [, manual] = await Promise.all([
      store.runBatch(after(holdUntil)),
      expire(s.staff.token, saleId, { expectedVersion: 1 }),
    ]);
    expect([200, 409]).toContain(manual.status);
    if (manual.status === 409) {
      expect(manual.body.error).toBe('HOLD_ALREADY_CLOSED');
    }
    expect(await saleRow(saleId)).toMatchObject({
      status: 'CANCELED',
      cancelReason: 'HOLD_EXPIRED',
      holdStage: 2,
    });
    expect(await canceledEvents(s.tenantId, saleId)).toHaveLength(1);
    expect(await feedItems(saleId, 'sale.pickup_expired')).toHaveLength(1);
    expect(await stockOf(s.productId)).toBe(STOCK);
    expect(
      await prisma.stockMovement.count({
        where: { tenantId: s.tenantId, productId: s.productId, delta: 1 },
      }),
    ).toBe(1);
  });

  describe('read model (S10): cancelled AND expired', () => {
    it('detail and list rows keep hold (expiresAt, stage) and add expiredAt = canceledAt on a HOLD_EXPIRED sale', async () => {
      const s = await sucursal();
      const manual = await heldSale(s);
      const auto = await heldSale(s);
      await expire(s.staff.token, manual.saleId, {
        expectedVersion: 1,
      }).expect(200);
      await scheduler.tick(after(auto.holdUntil));

      for (const { saleId, holdUntil } of [manual, auto]) {
        const detail = await http()
          .get(`/sales/${saleId}`)
          .set('Authorization', `Bearer ${s.reader.token}`)
          .expect(200);
        const row = await saleRow(saleId);
        expect(detail.body).toMatchObject({
          status: 'CANCELED',
          cancelReason: 'HOLD_EXPIRED',
          hold: {
            paymentIntent: 'IN_STORE',
            expiresAt: holdUntil.toISOString(),
            stage: 2,
            expiredAt: row.canceledAt?.toISOString(),
          },
        });
      }

      const list = await http()
        .get('/sales')
        .query({ status: 'CANCELED', limit: 50 })
        .set('Authorization', `Bearer ${s.reader.token}`)
        .expect(200);
      const rows = (list.body.data ?? list.body.items) as Array<{
        id: string;
        cancelReason: string | null;
        hold: { stage: number; expiredAt?: string } | null;
      }>;
      for (const { saleId } of [manual, auto]) {
        const row = rows.find((r) => r.id === saleId);
        expect(row).toMatchObject({
          cancelReason: 'HOLD_EXPIRED',
          hold: { stage: 2 },
        });
        expect(row?.hold?.expiredAt).toBe(
          (await saleRow(saleId)).canceledAt?.toISOString(),
        );
      }
    });

    it('a live hold keeps its exact previous shape (no expiredAt)', async () => {
      const s = await sucursal();
      const { saleId } = await heldSale(s);
      const detail = await http()
        .get(`/sales/${saleId}`)
        .set('Authorization', `Bearer ${s.reader.token}`)
        .expect(200);
      expect(detail.body.hold).toEqual({
        paymentIntent: 'IN_STORE',
        expiresAt: expect.any(String),
        reminderAt: expect.any(String),
        stage: 0,
        version: 1,
      });
    });
  });

  describe('S12 on the other producers', () => {
    it('the sweep cancel is unchanged (actor system) and its sale.pickup_expired carries branchName', async () => {
      const s = await sucursal();
      const { saleId, folio, holdUntil } = await heldSale(s);
      await scheduler.tick(after(holdUntil));
      expect(await saleRow(saleId)).toMatchObject({
        status: 'CANCELED',
        cancelReason: 'HOLD_EXPIRED',
        canceledByUserId: 'system',
        holdStage: 2,
      });
      const [item] = await feedItems(saleId, 'sale.pickup_expired');
      expect(item.payload).toEqual({
        saleId,
        folio,
        branchName: BRANCH,
        holdVersion: 1,
        conversationRef: s.conversationRef,
      });
    });

    it('the sweep reminder carries branchName', async () => {
      const s = await sucursal();
      const { saleId, holdUntil } = await heldSale(s);
      await scheduler.tick(new Date(holdUntil.getTime() - 2 * HOUR));
      const [item] = await feedItems(saleId, 'sale.pickup_reminder');
      expect(item.payload).toMatchObject({
        saleId,
        branchName: BRANCH,
        holdUntil: holdUntil.toISOString(),
        holdVersion: 1,
      });
    });

    it('the sweep REVIEW emits sale.pickup_expired_review exactly once per hold version', async () => {
      const s = await sucursal();
      const { saleId, folio, holdUntil } = await heldSale(s);
      await pay(s, saleId, 1000);
      await scheduler.tick(after(holdUntil));
      await scheduler.tick(after(holdUntil, HOUR));
      const items = await feedItems(saleId, 'sale.pickup_expired_review');
      expect(items).toHaveLength(1);
      expect(items[0].payload).toEqual({
        saleId,
        folio,
        branchName: BRANCH,
        holdVersion: 1,
        conversationRef: s.conversationRef,
      });
      expect(await reviewNotices(s.tenantId, saleId)).toHaveLength(1);
      expect((await saleRow(saleId)).status).toBe('CONFIRMED');
    });

    it('a staff edit sends previousHoldUntil + direction (EXTENDED, then SHORTENED) and branchName', async () => {
      const s = await sucursal();
      const { saleId, holdUntil } = await heldSale(s);
      const later = new Date(holdUntil.getTime() + 10 * HOUR);
      await http()
        .patch(`/sales/${saleId}/hold`)
        .set('Authorization', `Bearer ${s.staff.token}`)
        .send({ expiresAt: later.toISOString(), expectedVersion: 1 })
        .expect(200);
      const sooner = new Date(Date.now() + 5 * HOUR);
      await http()
        .patch(`/sales/${saleId}/hold`)
        .set('Authorization', `Bearer ${s.staff.token}`)
        .send({ expiresAt: sooner.toISOString(), expectedVersion: 2 })
        .expect(200);

      const items = await prisma.chatbotFeedItem.findMany({
        where: { saleId, type: 'sale.pickup_extended' },
        orderBy: { cursor: 'asc' },
      });
      expect(items.map((i) => i.payload)).toEqual([
        {
          saleId,
          folio: expect.any(String),
          branchName: BRANCH,
          holdUntil: later.toISOString(),
          previousHoldUntil: holdUntil.toISOString(),
          direction: 'EXTENDED',
          holdVersion: 2,
          conversationRef: s.conversationRef,
        },
        {
          saleId,
          folio: expect.any(String),
          branchName: BRANCH,
          holdUntil: sooner.toISOString(),
          previousHoldUntil: later.toISOString(),
          direction: 'SHORTENED',
          holdVersion: 3,
          conversationRef: s.conversationRef,
        },
      ]);
    });
  });
});
