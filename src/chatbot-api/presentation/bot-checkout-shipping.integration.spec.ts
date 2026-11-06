/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
/**
 * shipping-zones / T7 (S8, S10) — bot checkout/sale shipping against
 * PostgreSQL: POST /chatbot-api/shipping/quotes → POST /chatbot-api/checkouts
 * and POST /chatbot-api/sales with `shipping: { quoteId }`, store pickup and
 * the deprecated `{ chargeCents, approvalId }` shape.
 *
 * Boots the REAL ChatbotApiModule (repricing, quote engine, verifier, sale
 * confirmation, stock journal, folios). SURCHARGE zones need no carrier.
 * Only the credential repository and the audit log are in-memory fixtures.
 * Cleanup deletes the tenants it created (cascading their sales and quotes).
 */
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
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

const PHONE = { phoneCountryCode: '52', phone: '5512345678' };
const DEST = {
  zipCode: '64000',
  state: 'Nuevo León',
  municipality: 'Monterrey',
  neighborhood: 'Centro',
};
const PRICE = 60000;
// SURCHARGE 30000 − credit 12000 (one unit above $500) = 18000.
const CHARGE = 18000;
const SCOPES = [
  'shipping:quote',
  'customers:read',
  'customers:write',
  'sales:create',
];

d('bot checkout and sale shipping (PostgreSQL)', () => {
  const prisma = worldPrisma();
  const credentials = new BotCredentials();
  const audit = { append: jest.fn(() => Promise.resolve()) };
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
        data: { name: `PUBLICO-t7-${randomUUID()}`, isDefault: true },
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
              // Legacy `{ chargeCents, approvalId }` ceiling (deprecated path).
              BOT_SHIPPING_CHARGE_MAX_CENTS: 50000,
              // Boot-time reads of unrelated modules in the real graph.
              JWT_SECRET: 'bot-checkout-shipping-test-secret',
              JWT_REFRESH_SECRET: 'bot-checkout-shipping-test-refresh',
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

  /** A sucursal with a SURCHARGE zone, one priced product, a cashier and a customer. */
  async function sucursal(options: { hours?: boolean } = {}) {
    const tenantId = randomUUID();
    tenantIds.push(tenantId);
    await prisma.tenant.create({
      data: {
        id: tenantId,
        name: 'Sucursal Centro',
        slug: `t7-${tenantId}`,
      },
    });
    const cashierUserId = randomUUID();
    userIds.push(cashierUserId);
    await prisma.user.create({
      data: {
        id: cashierUserId,
        name: 'Bot cashier',
        email: `${cashierUserId}@t7.invalid`,
        hashedPassword: 'unused-test-fixture',
      },
    });
    const role = await prisma.role.create({
      data: { tenantId, name: `Cashier ${cashierUserId}` },
    });
    await prisma.tenantMembership.create({
      data: { tenantId, userId: cashierUserId, roleId: role.id },
    });
    const productId = randomUUID();
    await prisma.product.create({
      data: {
        id: productId,
        tenantId,
        name: 'Croquetas',
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
    await prisma.deliveryZone.create({
      data: {
        tenantId,
        zipCode: DEST.zipCode,
        type: 'SURCHARGE',
        surchargeCents: 30000,
        etaDays: 2,
        isActive: true,
        approvedById: cashierUserId,
        approvedByDisplayName: 'Gerente',
        approvedAt: new Date(),
      },
    });
    await prisma.shippingOrigin.create({
      data: {
        tenantId,
        addressLine1: 'Av. Juárez 123',
        neighborhood: 'Centro',
        municipality: 'Cuauhtémoc',
        state: 'Ciudad de México',
        postalCode: '06000',
        contactPhone: '5512345678',
      },
    });
    if (options.hours) {
      await prisma.tenantOpeningHours.create({
        data: {
          tenantId,
          timeZone: 'America/Mexico_City',
          days: [
            'MONDAY',
            'TUESDAY',
            'WEDNESDAY',
            'THURSDAY',
            'FRIDAY',
            'SATURDAY',
            'SUNDAY',
          ].map((day) => ({
            day,
            ranges: day === 'SUNDAY' ? [] : [{ open: '09:00', close: '18:00' }],
          })),
        },
      });
    }
    const customerId = randomUUID();
    await prisma.customer.create({
      data: { id: customerId, tenantId, firstName: 'Ana', ...PHONE },
    });
    const addressId = randomUUID();
    await prisma.customerAddress.create({
      data: {
        id: addressId,
        tenantId,
        customerId,
        street: 'Calle 5',
        ...DEST,
      },
    });
    const token = credentials.register(tenantId, SCOPES);
    return {
      tenantId,
      cashierUserId,
      productId,
      customerId,
      addressId,
      token,
    };
  }
  type Sucursal = Awaited<ReturnType<typeof sucursal>>;

  const http = () => request(app.getHttpServer());

  async function quote(
    s: Sucursal,
    quantity = 1,
    phone = PHONE,
  ): Promise<string> {
    const res = await http()
      .post('/chatbot-api/shipping/quotes')
      .set('Authorization', `Bearer ${s.token}`)
      .send({
        ...phone,
        items: [{ productId: s.productId, quantity }],
        destination: DEST,
      })
      .expect(201);
    expect(res.body.customerChargeCents).toBe(CHARGE);
    return res.body.quoteId as string;
  }

  const items = (s: Sucursal, quantity = 1) => [
    {
      productId: s.productId,
      productName: 'Croquetas',
      quantity,
      unitPriceCents: PRICE,
    },
  ];

  const checkout = (
    s: Sucursal,
    key: string,
    sale: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) =>
    http()
      .post('/chatbot-api/checkouts')
      .set('Authorization', `Bearer ${s.token}`)
      .set('X-Idempotency-Key', key)
      .send({
        ...PHONE,
        customer: { mode: 'existing', customerId: s.customerId },
        deliveryAddress: {
          mode: 'newSaved',
          address: { street: 'Calle 5', ...DEST },
        },
        sale: {
          cashierUserId: s.cashierUserId,
          items: items(s),
          expectedTotalCents: PRICE + CHARGE,
          ...sale,
        },
        ...extra,
      });

  const botSale = (s: Sucursal, key: string, body: Record<string, unknown>) =>
    http()
      .post('/chatbot-api/sales')
      .set('Authorization', `Bearer ${s.token}`)
      .set('X-Idempotency-Key', key)
      .send({
        cashierUserId: s.cashierUserId,
        customerId: s.customerId,
        items: items(s),
        ...body,
      });

  const saleRow = (saleId: string) =>
    prisma.sale.findUniqueOrThrow({
      where: { id: saleId },
      select: {
        totalCents: true,
        debtCents: true,
        shippingChargeCents: true,
        shippingQuoteRecordId: true,
        shippingApprovalId: true,
        fulfillmentMode: true,
        deliveryStatus: true,
        shippingAddressId: true,
        shippingStreet: true,
      },
    });

  describe('POST /chatbot-api/checkouts with shipping { quoteId }', () => {
    it('charges the verified quote into total and debt and records it on the sale', async () => {
      const s = await sucursal();
      const quoteId = await quote(s);

      const res = await checkout(s, 'co-1', { shipping: { quoteId } }).expect(
        201,
      );

      expect(res.body.sale).toMatchObject({
        deliveryStatus: 'PENDING',
        subtotalCents: PRICE,
        shippingChargeCents: CHARGE,
        totalCents: PRICE + CHARGE,
        debtCents: PRICE + CHARGE,
        fulfillmentMode: 'DELIVERY',
      });
      expect(res.body).not.toHaveProperty('pickupLocation');
      const stored = await prisma.shippingQuote.findFirstOrThrow({
        where: { tenantId: s.tenantId },
      });
      expect(await saleRow(res.body.sale.saleId)).toMatchObject({
        totalCents: PRICE + CHARGE,
        debtCents: PRICE + CHARGE,
        shippingChargeCents: CHARGE,
        shippingQuoteRecordId: stored.id,
        shippingApprovalId: null,
        fulfillmentMode: 'DELIVERY',
        deliveryStatus: 'PENDING',
      });
    });

    it('replays the same key and refuses the quote for a second sale (single use)', async () => {
      const s = await sucursal();
      const quoteId = await quote(s);
      const first = await checkout(s, 'co-2', {
        shipping: { quoteId },
      }).expect(201);

      const replay = await checkout(s, 'co-2', {
        shipping: { quoteId },
      }).expect(201);
      expect(replay.body).toEqual(first.body);

      const reuse = await checkout(s, 'co-3', { shipping: { quoteId } });
      expect(reuse.status).toBe(409);
      expect(reuse.body).toEqual({
        statusCode: 409,
        error: 'SHIPPING_QUOTE_ALREADY_USED',
        message: 'SHIPPING_QUOTE_ALREADY_USED',
      });
      expect(await prisma.sale.count({ where: { tenantId: s.tenantId } })).toBe(
        1,
      );
    });

    it('rejects an expired quote with 409 SHIPPING_QUOTE_EXPIRED and writes nothing', async () => {
      const s = await sucursal();
      const quoteId = await quote(s);
      await prisma.shippingQuote.updateMany({
        where: { tenantId: s.tenantId },
        data: {
          createdAt: new Date(Date.now() - 120_000),
          expiresAt: new Date(Date.now() - 60_000),
        },
      });

      const res = await checkout(s, 'co-4', { shipping: { quoteId } });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('SHIPPING_QUOTE_EXPIRED');
      expect(await prisma.sale.count({ where: { tenantId: s.tenantId } })).toBe(
        0,
      );
      expect(
        await prisma.customerAddress.count({ where: { tenantId: s.tenantId } }),
      ).toBe(1);
    });

    it('rejects changed lines and destination with 409 SHIPPING_QUOTE_MISMATCH listing the parts', async () => {
      const s = await sucursal();
      const quoteId = await quote(s);

      const res = await checkout(
        s,
        'co-5',
        {
          shipping: { quoteId },
          items: items(s, 2),
          expectedTotalCents: 2 * PRICE + CHARGE,
        },
        {
          deliveryAddress: {
            mode: 'newSaved',
            address: { street: 'Calle 5', ...DEST, zipCode: '64010' },
          },
        },
      );

      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        statusCode: 409,
        error: 'SHIPPING_QUOTE_MISMATCH',
        message: 'SHIPPING_QUOTE_MISMATCH',
        mismatches: ['LINES', 'DESTINATION'],
      });
    });

    it('rejects an unknown quote and a quote of another sucursal with 404', async () => {
      const s = await sucursal();
      const other = await sucursal();
      const foreignQuote = await quote(other);

      for (const quoteId of [`shq_${'x'.repeat(43)}`, foreignQuote]) {
        const res = await checkout(s, `co-6-${quoteId.slice(-4)}`, {
          shipping: { quoteId },
        });
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('SHIPPING_QUOTE_NOT_FOUND');
      }
    });
  });

  describe('POST /chatbot-api/sales with shipping { quoteId }', () => {
    it('charges the quote, refuses reuse, and frees the key after a rejected quote', async () => {
      const s = await sucursal();
      const stale = await quote(s);
      await prisma.shippingQuote.updateMany({
        where: { tenantId: s.tenantId },
        data: {
          createdAt: new Date(Date.now() - 120_000),
          expiresAt: new Date(Date.now() - 60_000),
        },
      });

      const expired = await botSale(s, 'sale-1', {
        shippingAddressId: s.addressId,
        expectedTotalCents: PRICE + CHARGE,
        shipping: { quoteId: stale },
      });
      expect(expired.status).toBe(409);
      expect(expired.body.error).toBe('SHIPPING_QUOTE_EXPIRED');

      // Same Idempotency-Key, fresh quote: the rejected attempt left no slot.
      const quoteId = await quote(s);
      const ok = await botSale(s, 'sale-1', {
        shippingAddressId: s.addressId,
        expectedTotalCents: PRICE + CHARGE,
        shipping: { quoteId },
      }).expect(201);
      expect(ok.body).toMatchObject({
        totalCents: PRICE + CHARGE,
        debtCents: PRICE + CHARGE,
        shippingChargeCents: CHARGE,
        fulfillmentMode: 'DELIVERY',
      });
      expect(await saleRow(ok.body.saleId)).toMatchObject({
        shippingChargeCents: CHARGE,
        fulfillmentMode: 'DELIVERY',
        shippingAddressId: s.addressId,
      });

      const reuse = await botSale(s, 'sale-2', {
        shippingAddressId: s.addressId,
        expectedTotalCents: PRICE + CHARGE,
        shipping: { quoteId },
      });
      expect(reuse.status).toBe(409);
      expect(reuse.body.error).toBe('SHIPPING_QUOTE_ALREADY_USED');
    });

    it('rejects a quote made for another customer phone (CUSTOMER mismatch)', async () => {
      const s = await sucursal();
      const quoteId = await quote(s, 1, {
        phoneCountryCode: '52',
        phone: '5599999999',
      });

      const res = await botSale(s, 'sale-3', {
        shippingAddressId: s.addressId,
        expectedTotalCents: PRICE + CHARGE,
        shipping: { quoteId },
      });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        error: 'SHIPPING_QUOTE_MISMATCH',
        mismatches: ['CUSTOMER'],
      });
    });
  });

  describe('two requests racing for one quote', () => {
    /** Exactly one sale, charged once; the loser got ALREADY_USED. */
    async function expectOneWinner(
      s: Sucursal,
      results: request.Response[],
      saleIdOf: (body: Record<string, unknown>) => string,
    ) {
      const statuses = results.map((res) => res.status).sort();
      expect(statuses).toEqual([201, 409]);
      const winner = results.find((res) => res.status === 201)!;
      const loser = results.find((res) => res.status === 409)!;
      expect(loser.body).toEqual({
        statusCode: 409,
        error: 'SHIPPING_QUOTE_ALREADY_USED',
        message: 'SHIPPING_QUOTE_ALREADY_USED',
      });
      const sales = await prisma.sale.findMany({
        where: { tenantId: s.tenantId },
        select: { id: true, totalCents: true, debtCents: true },
      });
      expect(sales).toEqual([
        {
          id: saleIdOf(winner.body),
          totalCents: PRICE + CHARGE,
          debtCents: PRICE + CHARGE,
        },
      ]);
      // Stock is charged once (50 → 49).
      expect(
        await prisma.product.findUniqueOrThrow({
          where: { id: s.productId },
          select: { quantity: true },
        }),
      ).toEqual({ quantity: 49 });
    }

    it('POST /chatbot-api/sales: one sale, the other 409 SHIPPING_QUOTE_ALREADY_USED', async () => {
      const s = await sucursal();
      const quoteId = await quote(s);
      const body = {
        shippingAddressId: s.addressId,
        expectedTotalCents: PRICE + CHARGE,
        shipping: { quoteId },
      };

      const results = await Promise.all([
        botSale(s, 'race-sale-a', body),
        botSale(s, 'race-sale-b', body),
      ]);

      await expectOneWinner(s, results, (b) => b.saleId as string);
    });

    it('POST /chatbot-api/checkouts: one sale, the other 409 SHIPPING_QUOTE_ALREADY_USED', async () => {
      const s = await sucursal();
      const quoteId = await quote(s);

      const results = await Promise.all([
        checkout(s, 'race-co-a', { shipping: { quoteId } }),
        checkout(s, 'race-co-b', { shipping: { quoteId } }),
      ]);

      await expectOneWinner(
        s,
        results,
        (b) => (b.sale as { saleId: string }).saleId,
      );
    });

    it('a checkout and a sale racing for the same quote: still one sale', async () => {
      const s = await sucursal();
      const quoteId = await quote(s);

      const results = await Promise.all([
        checkout(s, 'race-mixed-co', { shipping: { quoteId } }),
        botSale(s, 'race-mixed-sale', {
          shippingAddressId: s.addressId,
          expectedTotalCents: PRICE + CHARGE,
          shipping: { quoteId },
        }),
      ]);

      await expectOneWinner(
        s,
        results,
        (b) => (b.saleId as string) ?? (b.sale as { saleId: string }).saleId,
      );
    });
  });

  describe('store pickup (shipping { mode: "pickup" })', () => {
    it('checkout: new customer without address gets a PICKUP sale and the pickup location', async () => {
      const s = await sucursal({ hours: true });

      const res = await http()
        .post('/chatbot-api/checkouts')
        .set('Authorization', `Bearer ${s.token}`)
        .set('X-Idempotency-Key', 'pickup-1')
        .send({
          phoneCountryCode: '52',
          phone: '5511112222',
          customer: { mode: 'createIfAbsent', firstName: 'Luis' },
          sale: {
            cashierUserId: s.cashierUserId,
            items: items(s),
            expectedTotalCents: PRICE,
            shipping: { mode: 'pickup' },
          },
        })
        .expect(201);

      expect(res.body.customer).toMatchObject({
        resolution: 'created',
        firstName: 'Luis',
      });
      expect(res.body.address).toBeNull();
      expect(res.body.sale).toMatchObject({
        totalCents: PRICE,
        deliveryStatus: 'PENDING',
        fulfillmentMode: 'PICKUP',
      });
      expect(res.body.sale).not.toHaveProperty('shippingChargeCents');
      expect(res.body.pickupLocation).toEqual({
        name: 'Sucursal Centro',
        address: {
          addressLine1: 'Av. Juárez 123',
          addressLine2: null,
          neighborhood: 'Centro',
          municipality: 'Cuauhtémoc',
          state: 'Ciudad de México',
          postalCode: '06000',
          formatted:
            'Av. Juárez 123, Centro, Cuauhtémoc, Ciudad de México, C.P. 06000',
        },
        hours: expect.objectContaining({
          timeZone: 'America/Mexico_City',
          summary: 'Lunes a sábado: 09:00–18:00. Domingo: cerrado.',
        }),
      });
      expect(await saleRow(res.body.sale.saleId)).toMatchObject({
        fulfillmentMode: 'PICKUP',
        deliveryStatus: 'PENDING',
        shippingChargeCents: 0,
        shippingAddressId: null,
        shippingStreet: null,
      });
      expect(
        await prisma.customerAddress.count({
          where: {
            tenantId: s.tenantId,
            customerId: res.body.customer.customerId,
          },
        }),
      ).toBe(0);
    });

    it('sales: existing customer with customerId only; address is refused', async () => {
      const s = await sucursal();

      const res = await botSale(s, 'pickup-2', {
        shipping: { mode: 'pickup' },
      }).expect(201);
      expect(res.body).toMatchObject({
        fulfillmentMode: 'PICKUP',
        totalCents: PRICE,
        pickupLocation: expect.objectContaining({
          name: 'Sucursal Centro',
          hours: null,
        }),
      });
      expect(await saleRow(res.body.saleId)).toMatchObject({
        fulfillmentMode: 'PICKUP',
        shippingAddressId: null,
      });

      const withAddress = await botSale(s, 'pickup-3', {
        shippingAddressId: s.addressId,
        shipping: { mode: 'pickup' },
      });
      expect(withAddress.status).toBe(422);
      expect(withAddress.body.error).toBe(
        'SHIPPING_ADDRESS_NOT_ALLOWED_FOR_PICKUP',
      );
    });
  });

  describe('deprecated { chargeCents, approvalId } shape', () => {
    it('still registers through checkouts and sales with the legacy ceiling', async () => {
      const s = await sucursal();

      const viaCheckout = await checkout(s, 'legacy-1', {
        expectedTotalCents: PRICE + 2500,
        shipping: { chargeCents: 2500, approvalId: 'approval-legacy-1' },
      }).expect(201);
      expect(viaCheckout.body.sale).toMatchObject({
        shippingChargeCents: 2500,
        totalCents: PRICE + 2500,
      });
      expect(viaCheckout.body.sale).not.toHaveProperty('fulfillmentMode');
      expect(await saleRow(viaCheckout.body.sale.saleId)).toMatchObject({
        shippingApprovalId: 'approval-legacy-1',
        shippingQuoteRecordId: null,
        fulfillmentMode: 'DELIVERY',
      });

      const viaSales = await botSale(s, 'legacy-2', {
        shippingAddressId: s.addressId,
        expectedTotalCents: PRICE + 2500,
        shipping: { chargeCents: 2500, approvalId: 'approval-legacy-2' },
      }).expect(201);
      expect(viaSales.body).toMatchObject({
        shippingChargeCents: 2500,
        totalCents: PRICE + 2500,
      });

      const overCeiling = await botSale(s, 'legacy-3', {
        shippingAddressId: s.addressId,
        expectedTotalCents: PRICE + 60000,
        shipping: { chargeCents: 60000, approvalId: 'approval-legacy-3' },
      });
      expect(overCeiling.status).toBe(422);
      expect(overCeiling.body.error).toBe('SHIPPING_CHARGE_EXCEEDS_MAX');
    });
  });
});
