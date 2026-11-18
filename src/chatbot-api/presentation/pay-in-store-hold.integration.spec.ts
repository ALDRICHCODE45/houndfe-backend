/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
/**
 * pay-in-store-pickup / T1 (S1, S2, S3, S5, S6) — counter-payment hold of a
 * bot PICKUP sale against PostgreSQL.
 *
 *   PATCH /chatbot-api/sales/:saleId/payment-intent  (bot, `sales:write`)
 *   PATCH /sales/:id/hold                            (staff, update:Sale)
 *   GET   /sales/:id, GET /sales                     (staff reads, `hold`)
 *   GET   /chatbot-api/checkouts/status              (bot read, `hold`)
 *   POST  /sales/:id/payments                        (counter payment)
 *
 * Boots the REAL ChatbotApiModule (it imports SalesModule, so the staff
 * controllers run behind the real JWT -> tenant -> permissions guards). Only
 * the credential repository and the bot audit log are in-memory fixtures.
 * Cleanup deletes the tenants and users it created.
 */
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { ClsModule } from 'nestjs-cls';
import request from 'supertest';
import {
  BotCredentials,
  disconnectWorldPrisma,
  worldPrisma,
} from '../../delivery-zones/test-support/delivery-zone-world';
import { DomainExceptionFilter } from '../../shared/filters/domain-exception.filter';
import { PrismaExceptionFilter } from '../../shared/filters/prisma-exception.filter';
import { createAppValidationPipe } from '../../shared/listing/app-validation.pipe';
import { DatabaseModule } from '../../shared/prisma/prisma.module';
import { ChatbotApiModule } from '../chatbot-api.module';
import { SERVICE_CREDENTIAL_REPOSITORY } from '../domain/service-credential.repository';
import { BOT_AUDIT_LOG_REPOSITORY } from '../infrastructure/prisma-bot-audit-log.repository';

const SKIP =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const d = SKIP ? describe.skip : describe;

const JWT_SECRET = 'pay-in-store-hold-test-secret';
const PHONE = { phoneCountryCode: '52', phone: '5512340000' };
const PRICE = 45000;
const HOUR = 3_600_000;
const SCOPES = [
  'customers:read',
  'customers:write',
  'sales:create',
  'sales:write',
];

d('pay-in-store hold (PostgreSQL)', () => {
  const prisma = worldPrisma();
  const credentials = new BotCredentials();
  const audit = { append: jest.fn(() => Promise.resolve()) };
  const jwt = new JwtService({
    secret: JWT_SECRET,
    signOptions: { expiresIn: '1h' },
  });
  let app: INestApplication;
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
        data: { name: `PUBLICO-hold-${randomUUID()}`, isDefault: true },
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
              JWT_REFRESH_SECRET: 'pay-in-store-hold-test-refresh',
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

  async function user(tenantId: string, name: string, grants: string[]) {
    const userId = randomUUID();
    userIds.push(userId);
    await prisma.user.create({
      data: {
        id: userId,
        name,
        email: `${userId}@hold.invalid`,
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
      email: `${userId}@hold.invalid`,
      tenantId,
      tenantSlug: `hold-${tenantId}`,
      isSuperAdmin: false,
    });
    return { userId, token };
  }

  /** A sucursal with one priced product, the bot cashier, staff and a customer. */
  async function sucursal() {
    const tenantId = randomUUID();
    tenantIds.push(tenantId);
    await prisma.tenant.create({
      data: { id: tenantId, name: 'Sucursal Norte', slug: `hold-${tenantId}` },
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
        name: 'Arena',
        useStock: true,
        quantity: 50,
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
        addressLine1: 'Av. Reforma 1',
        neighborhood: 'Centro',
        municipality: 'Cuauhtémoc',
        state: 'Ciudad de México',
        postalCode: '06000',
        contactPhone: '5512345678',
      },
    });
    const customerId = randomUUID();
    await prisma.customer.create({
      data: { id: customerId, tenantId, firstName: 'Eva', ...PHONE },
    });
    const token = credentials.register(tenantId, SCOPES);
    const readOnlyBot = credentials.register(tenantId, ['sales:read']);
    return {
      tenantId,
      cashierUserId: cashier.userId,
      staff,
      reader,
      productId,
      customerId,
      token,
      readOnlyBot,
    };
  }
  type Sucursal = Awaited<ReturnType<typeof sucursal>>;

  const http = () => request(app.getHttpServer());

  /** A real bot PICKUP sale (CONFIRMED, ONLINE, CREDIT, stock charged). */
  async function pickupSale(
    s: Sucursal,
  ): Promise<{ saleId: string; folio: string }> {
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
            productName: 'Arena',
            quantity: 1,
            unitPriceCents: PRICE,
          },
        ],
        shipping: { mode: 'pickup' },
      })
      .expect(201);
    expect(res.body.fulfillmentMode).toBe('PICKUP');
    return { saleId: res.body.saleId, folio: res.body.folio };
  }

  /** A synthetic sale row for the precondition matrix. */
  async function rawSale(
    s: Sucursal,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const id = randomUUID();
    await prisma.sale.create({
      data: {
        id,
        tenantId: s.tenantId,
        userId: s.cashierUserId,
        status: 'CONFIRMED',
        channel: 'ONLINE',
        fulfillmentMode: 'PICKUP',
        deliveryStatus: 'PENDING',
        paymentStatus: 'CREDIT',
        subtotalCents: PRICE,
        totalCents: PRICE,
        debtCents: PRICE,
        paidCents: 0,
        confirmedAt: new Date(),
        folio: `T-${id.slice(0, 8)}`,
        ...overrides,
      },
    });
    return id;
  }

  const markInStore = (s: Sucursal, saleId: string, token = s.token) =>
    http()
      .patch(`/chatbot-api/sales/${saleId}/payment-intent`)
      .set('Authorization', `Bearer ${token}`)
      .send({ method: 'IN_STORE' });

  const editHold = (
    token: string,
    saleId: string,
    body: Record<string, unknown>,
  ) =>
    http()
      .patch(`/sales/${saleId}/hold`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const holdRow = (saleId: string) =>
    prisma.sale.findUniqueOrThrow({
      where: { id: saleId },
      select: {
        paymentIntent: true,
        holdExpiresAt: true,
        holdReminderAt: true,
        holdStage: true,
        holdVersion: true,
      },
    });

  const near = (iso: string, expectedMs: number, toleranceMs = 60_000) =>
    expect(Math.abs(new Date(iso).getTime() - expectedMs)).toBeLessThan(
      toleranceMs,
    );

  describe('PATCH /chatbot-api/sales/:saleId/payment-intent', () => {
    it('marks a CONFIRMED ONLINE PICKUP unpaid sale IN_STORE with a 24 h hold and a reminder 3 h before', async () => {
      const s = await sucursal();
      const { saleId, folio } = await pickupSale(s);
      const before = Date.now();

      const res = await markInStore(s, saleId).expect(200);

      expect(Object.keys(res.body).sort()).toEqual(
        ['folio', 'holdUntil', 'paymentIntent', 'reminderAt', 'saleId'].sort(),
      );
      expect(res.body).toMatchObject({
        saleId,
        folio,
        paymentIntent: 'IN_STORE',
      });
      near(res.body.holdUntil, before + 24 * HOUR);
      expect(new Date(res.body.reminderAt).getTime()).toBe(
        new Date(res.body.holdUntil).getTime() - 3 * HOUR,
      );
      const row = await holdRow(saleId);
      expect(row).toMatchObject({
        paymentIntent: 'IN_STORE',
        holdStage: 0,
        holdVersion: 1,
      });
      expect(row.holdExpiresAt?.toISOString()).toBe(res.body.holdUntil);
      expect(row.holdReminderAt?.toISOString()).toBe(res.body.reminderAt);
    });

    it('is idempotent: re-sending the intent returns the existing hold unchanged', async () => {
      const s = await sucursal();
      const { saleId } = await pickupSale(s);
      const first = await markInStore(s, saleId).expect(200);
      const before = await holdRow(saleId);

      const again = await markInStore(s, saleId).expect(200);

      expect(again.body).toEqual(first.body);
      expect(await holdRow(saleId)).toEqual(before);
    });

    it('rejects each precondition with a clear code and writes nothing', async () => {
      const s = await sucursal();
      const cases: Array<[Record<string, unknown>, number, string]> = [
        [{ status: 'CANCELED' }, 409, 'PAY_IN_STORE_SALE_NOT_CONFIRMED'],
        [
          { status: 'DRAFT', confirmedAt: null },
          409,
          'PAY_IN_STORE_SALE_NOT_CONFIRMED',
        ],
        [
          { channel: 'POS', fulfillmentMode: null },
          422,
          'PAY_IN_STORE_REQUIRES_ONLINE',
        ],
        [{ fulfillmentMode: 'DELIVERY' }, 422, 'PAY_IN_STORE_REQUIRES_PICKUP'],
        [{ fulfillmentMode: null }, 422, 'PAY_IN_STORE_REQUIRES_PICKUP'],
        [
          {
            paymentStatus: 'PARTIAL',
            paidCents: 1000,
            debtCents: PRICE - 1000,
          },
          409,
          'PAY_IN_STORE_SALE_ALREADY_PAID',
        ],
        [
          { paymentStatus: 'PAID', paidCents: PRICE, debtCents: 0 },
          409,
          'PAY_IN_STORE_SALE_ALREADY_PAID',
        ],
      ];
      for (const [overrides, status, code] of cases) {
        const saleId = await rawSale(s, overrides);
        const res = await markInStore(s, saleId);
        expect({ overrides, status: res.status, body: res.body }).toEqual({
          overrides,
          status,
          body: { statusCode: status, error: code, message: code },
        });
        expect(await holdRow(saleId)).toEqual({
          paymentIntent: null,
          holdExpiresAt: null,
          holdReminderAt: null,
          holdStage: 0,
          holdVersion: 0,
        });
      }
    });

    it('returns 404 SALE_NOT_FOUND for a missing sale and for another tenant’s sale (isolation)', async () => {
      const a = await sucursal();
      const b = await sucursal();
      const { saleId } = await pickupSale(a);

      const missing = await markInStore(a, randomUUID());
      expect(missing.status).toBe(404);
      expect(missing.body.error).toBe('SALE_NOT_FOUND');

      const foreign = await markInStore(b, saleId);
      expect(foreign.status).toBe(404);
      expect(foreign.body).toEqual({
        statusCode: 404,
        error: 'SALE_NOT_FOUND',
        message: 'SALE_NOT_FOUND',
      });
      expect((await holdRow(saleId)).paymentIntent).toBeNull();
    });

    it('validates the body and requires the sales:write scope', async () => {
      const s = await sucursal();
      const { saleId } = await pickupSale(s);

      const wrongMethod = await http()
        .patch(`/chatbot-api/sales/${saleId}/payment-intent`)
        .set('Authorization', `Bearer ${s.token}`)
        .send({ method: 'CARD' });
      expect(wrongMethod.status).toBe(400);

      const noScope = await markInStore(s, saleId, s.readOnlyBot);
      expect(noScope.status).toBe(403);
      expect((await holdRow(saleId)).paymentIntent).toBeNull();
    });

    it('leaves a pickup sale without an intent on holdExpiresAt NULL (no implicit hold)', async () => {
      const s = await sucursal();
      const { saleId } = await pickupSale(s);

      expect(await holdRow(saleId)).toEqual({
        paymentIntent: null,
        holdExpiresAt: null,
        holdReminderAt: null,
        holdStage: 0,
        holdVersion: 0,
      });
      const detail = await http()
        .get(`/sales/${saleId}`)
        .set('Authorization', `Bearer ${s.staff.token}`)
        .expect(200);
      expect(detail.body.hold).toBeNull();
    });
  });

  describe('PATCH /sales/:id/hold (staff)', () => {
    it('moves the deadline, recomputes the reminder, resets the stage, bumps the version and records the actor', async () => {
      const s = await sucursal();
      const { saleId } = await pickupSale(s);
      await markInStore(s, saleId).expect(200);
      await prisma.sale.update({
        where: { id: saleId },
        data: { holdStage: 1 },
      });
      const emit = jest.spyOn(app.get(EventEmitter2), 'emit');
      const expiresAt = new Date(Date.now() + 48 * HOUR).toISOString();

      const res = await editHold(s.staff.token, saleId, {
        expiresAt,
        expectedVersion: 1,
      }).expect(200);

      expect(res.body.id).toBe(saleId);
      expect(res.body.hold).toEqual({
        paymentIntent: 'IN_STORE',
        expiresAt,
        reminderAt: new Date(
          new Date(expiresAt).getTime() - 3 * HOUR,
        ).toISOString(),
        stage: 0,
        version: 2,
      });
      expect(emit).toHaveBeenCalledWith(
        'sale.hold.updated',
        expect.objectContaining({
          saleId,
          tenantId: s.tenantId,
          userId: s.staff.userId,
          expiresAt,
          version: 2,
        }),
      );
      emit.mockRestore();
    });

    it('returns 409 HOLD_VERSION_CONFLICT on a stale expectedVersion and keeps the row', async () => {
      const s = await sucursal();
      const { saleId } = await pickupSale(s);
      await markInStore(s, saleId).expect(200);
      await editHold(s.staff.token, saleId, {
        expiresAt: new Date(Date.now() + 30 * HOUR).toISOString(),
        expectedVersion: 1,
      }).expect(200);
      const before = await holdRow(saleId);

      const stale = await editHold(s.staff.token, saleId, {
        expiresAt: new Date(Date.now() + 40 * HOUR).toISOString(),
        expectedVersion: 1,
      });

      expect(stale.status).toBe(409);
      expect(stale.body).toEqual({
        statusCode: 409,
        error: 'HOLD_VERSION_CONFLICT',
        message: 'HOLD_VERSION_CONFLICT',
      });
      expect(await holdRow(saleId)).toEqual(before);
    });

    it('skips the reminder when the new hold is 3 h or shorter', async () => {
      const s = await sucursal();
      const { saleId } = await pickupSale(s);
      await markInStore(s, saleId).expect(200);

      const short = new Date(Date.now() + 2 * HOUR).toISOString();
      const res = await editHold(s.staff.token, saleId, {
        expiresAt: short,
        expectedVersion: 1,
      }).expect(200);

      expect(res.body.hold).toMatchObject({
        expiresAt: short,
        reminderAt: null,
        stage: 0,
        version: 2,
      });
      expect((await holdRow(saleId)).holdReminderAt).toBeNull();
    });

    it('rejects a past deadline, a sale without IN_STORE intent, a paid sale and a caller without update:Sale', async () => {
      const s = await sucursal();
      const { saleId } = await pickupSale(s);
      await markInStore(s, saleId).expect(200);
      const future = new Date(Date.now() + 10 * HOUR).toISOString();

      const past = await editHold(s.staff.token, saleId, {
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        expectedVersion: 1,
      });
      expect(past.status).toBe(422);
      expect(past.body.error).toBe('HOLD_EXPIRY_NOT_FUTURE');

      const invalid = await editHold(s.staff.token, saleId, {
        expiresAt: 'tomorrow',
        expectedVersion: 1,
      });
      expect(invalid.status).toBe(400);

      const noIntent = await rawSale(s);
      const notInStore = await editHold(s.staff.token, noIntent, {
        expiresAt: future,
        expectedVersion: 0,
      });
      expect(notInStore.status).toBe(409);
      expect(notInStore.body.error).toBe('SALE_NOT_PAY_IN_STORE');

      const paid = await rawSale(s, {
        paymentIntent: 'IN_STORE',
        holdExpiresAt: new Date(Date.now() + HOUR),
        holdVersion: 1,
        paymentStatus: 'PARTIAL',
        paidCents: 100,
        debtCents: PRICE - 100,
      });
      const paidEdit = await editHold(s.staff.token, paid, {
        expiresAt: future,
        expectedVersion: 1,
      });
      expect(paidEdit.status).toBe(409);
      expect(paidEdit.body.error).toBe('SALE_HOLD_NOT_EDITABLE');

      const forbidden = await editHold(s.reader.token, saleId, {
        expiresAt: future,
        expectedVersion: 1,
      });
      expect(forbidden.status).toBe(403);

      const other = await sucursal();
      const foreign = await editHold(other.staff.token, saleId, {
        expiresAt: future,
        expectedVersion: 1,
      });
      expect(foreign.status).toBe(404);
      expect(foreign.body.error).toBe('SALE_NOT_FOUND');
      expect((await holdRow(saleId)).holdVersion).toBe(1);
    });
  });

  describe('T3: a staff deadline change feeds the bot (sale.pickup_extended)', () => {
    const saleFeed = (tenantId: string) =>
      prisma.chatbotFeedItem.findMany({
        where: { tenantId, saleId: { not: null } },
        orderBy: { cursor: 'asc' },
      });

    it('enqueues exactly one item per new hold version, in the edit transaction, with the customer chat', async () => {
      const s = await sucursal();
      const conversationRef = 'wa:5215512340000';
      await prisma.chatbotConversation.create({
        data: {
          tenantId: s.tenantId,
          conversationRef,
          customerKey: '525512340000',
        },
      });
      const { saleId, folio } = await pickupSale(s);
      await markInStore(s, saleId).expect(200);
      // The bot's own mark is not an extension.
      expect(await saleFeed(s.tenantId)).toHaveLength(0);

      const expiresAt = new Date(Date.now() + 30 * HOUR).toISOString();
      await editHold(s.staff.token, saleId, {
        expiresAt,
        expectedVersion: 1,
      }).expect(200);
      // A stale retry of the same edit changes nothing and feeds nothing.
      const stale = await editHold(s.staff.token, saleId, {
        expiresAt,
        expectedVersion: 1,
      });
      expect(stale.status).toBe(409);

      const items = await saleFeed(s.tenantId);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        tenantId: s.tenantId,
        requestId: null,
        saleId,
        type: 'sale.pickup_extended',
        conversationRef,
        outcome: null,
        payload: {
          saleId,
          folio,
          holdUntil: expiresAt,
          holdVersion: 2,
          conversationRef,
        },
      });

      const later = new Date(Date.now() + 50 * HOUR).toISOString();
      await editHold(s.staff.token, saleId, {
        expiresAt: later,
        expectedVersion: 2,
      }).expect(200);
      const after = await saleFeed(s.tenantId);
      expect(
        after.map((i) => (i.payload as { holdVersion: number }).holdVersion),
      ).toEqual([2, 3]);
      expect((after[1].payload as { holdUntil: string }).holdUntil).toBe(later);
    });

    it('a sale without a customer gets no item; a rejected edit leaves none', async () => {
      const s = await sucursal();
      const anonymous = await rawSale(s, {
        paymentIntent: 'IN_STORE',
        holdExpiresAt: new Date(Date.now() + 10 * HOUR),
        holdVersion: 1,
      });
      await editHold(s.staff.token, anonymous, {
        expiresAt: new Date(Date.now() + 20 * HOUR).toISOString(),
        expectedVersion: 1,
      }).expect(200);

      const paid = await rawSale(s, {
        customerId: s.customerId,
        paymentIntent: 'IN_STORE',
        holdExpiresAt: new Date(Date.now() + HOUR),
        holdVersion: 1,
        paymentStatus: 'PAID',
        paidCents: PRICE,
        debtCents: 0,
      });
      const refused = await editHold(s.staff.token, paid, {
        expiresAt: new Date(Date.now() + 20 * HOUR).toISOString(),
        expectedVersion: 1,
      });
      expect(refused.status).toBe(409);

      expect(await saleFeed(s.tenantId)).toHaveLength(0);
    });
  });

  describe('reads expose hold', () => {
    it('GET /sales/:id, GET /sales and the bot checkout status carry the hold', async () => {
      const s = await sucursal();
      const key = `co-${randomUUID()}`;
      const created = await http()
        .post('/chatbot-api/checkouts')
        .set('Authorization', `Bearer ${s.token}`)
        .set('X-Idempotency-Key', key)
        .send({
          ...PHONE,
          customer: { mode: 'existing', customerId: s.customerId },
          sale: {
            cashierUserId: s.cashierUserId,
            items: [
              {
                productId: s.productId,
                productName: 'Arena',
                quantity: 1,
                unitPriceCents: PRICE,
              },
            ],
            expectedTotalCents: PRICE,
            shipping: { mode: 'pickup' },
          },
        })
        .expect(201);
      const saleId = created.body.sale.saleId as string;

      const before = await http()
        .get('/chatbot-api/checkouts/status')
        .set('Authorization', `Bearer ${s.token}`)
        .set('X-Idempotency-Key', key)
        .expect(200);
      expect(before.body.status).toBe('succeeded');
      expect(before.body.hold).toBeNull();
      expect(before.body.checkout).toEqual(created.body);

      const marked = await markInStore(s, saleId).expect(200);
      const hold = {
        paymentIntent: 'IN_STORE',
        expiresAt: marked.body.holdUntil,
        reminderAt: marked.body.reminderAt,
        stage: 0,
        version: 1,
      };

      const detail = await http()
        .get(`/sales/${saleId}`)
        .set('Authorization', `Bearer ${s.staff.token}`)
        .expect(200);
      expect(detail.body.hold).toEqual(hold);

      const list = await http()
        .get('/sales')
        .set('Authorization', `Bearer ${s.staff.token}`)
        .expect(200);
      const row = list.body.data.find((r: { id: string }) => r.id === saleId);
      expect(row.hold).toEqual(hold);

      const after = await http()
        .get('/chatbot-api/checkouts/status')
        .set('Authorization', `Bearer ${s.token}`)
        .set('X-Idempotency-Key', key)
        .expect(200);
      expect(after.body.hold).toEqual(hold);
      // The cached creation receipt itself stays byte-identical.
      expect(after.body.checkout).toEqual(created.body);
    });
  });

  describe('counter payment of a bot sale (POST /sales/:id/payments)', () => {
    it('staff with update:Sale (not the bot cashier) charges the sale; a paid sale leaves the hold flow', async () => {
      const s = await sucursal();
      const { saleId } = await pickupSale(s);
      await markInStore(s, saleId).expect(200);

      const paid = await http()
        .post(`/sales/${saleId}/payments`)
        .set('Authorization', `Bearer ${s.staff.token}`)
        .set('Idempotency-Key', `counter-${randomUUID()}`)
        .send({ method: 'cash', amountCents: PRICE })
        .expect(201);
      expect(paid.body).toMatchObject({
        saleId,
        paidCents: PRICE,
        debtCents: 0,
        paymentStatus: 'PAID',
      });
      const payment = await prisma.salePayment.findFirstOrThrow({
        where: { saleId },
      });
      expect(payment.userId).toBe(s.staff.userId);

      // Ineligible for the T2 expiry (paymentStatus no longer CREDIT): no
      // staff hold edit, and the bot cannot re-arm the hold.
      const edit = await editHold(s.staff.token, saleId, {
        expiresAt: new Date(Date.now() + 10 * HOUR).toISOString(),
        expectedVersion: 1,
      });
      expect(edit.status).toBe(409);
      expect(edit.body.error).toBe('SALE_HOLD_NOT_EDITABLE');
      const remark = await markInStore(s, saleId);
      expect(remark.status).toBe(409);
      expect(remark.body.error).toBe('PAY_IN_STORE_SALE_ALREADY_PAID');
    });

    it('keeps the owner rule for POS sales: another cashier’s confirmed POS sale or draft is not found', async () => {
      const s = await sucursal();
      const posSale = await rawSale(s, {
        channel: 'POS',
        fulfillmentMode: null,
        deliveryStatus: 'DELIVERED',
      });
      const posDraft = await rawSale(s, {
        channel: 'POS',
        status: 'DRAFT',
        fulfillmentMode: null,
        paymentStatus: null,
        confirmedAt: null,
        folio: null,
      });

      for (const id of [posSale, posDraft]) {
        const res = await http()
          .post(`/sales/${id}/payments`)
          .set('Authorization', `Bearer ${s.staff.token}`)
          .set('Idempotency-Key', `owner-${randomUUID()}`)
          .send({ method: 'cash', amountCents: 100 });
        expect(res.status).toBe(404);
        expect(res.body.error ?? res.body.code).toBe('SALE_NOT_FOUND');
      }
      expect(
        await prisma.salePayment.count({
          where: { saleId: { in: [posSale, posDraft] } },
        }),
      ).toBe(0);
    });
  });
});
