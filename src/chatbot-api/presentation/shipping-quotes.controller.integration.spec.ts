/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
/**
 * shipping-zones / T3 — POST /chatbot-api/shipping/quotes against PostgreSQL.
 *
 * Boots the REAL ChatbotApiModule (sale repricing through SalesService and
 * the promotions engine, ServiceAuthGuard, BotAuditInterceptor), with only
 * the carrier list replaced by scripted fake carriers and the credential
 * repository by in-memory fixtures. Cleanup deletes only the rows it created.
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
import { SHIPPING_CARRIERS } from '../../shipping/quotes/domain/shipping-carrier.port';
import type {
  CarrierQuoteRequest,
  CarrierRateOption,
} from '../../shipping/quotes/domain/shipping-carrier.port';
import { ShippingQuoteVerifier } from '../../shipping/quotes/application/shipping-quote-verifier.service';
import { FakeShippingCarrier } from '../../shipping/quotes/infrastructure/fake-shipping-carrier';
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
const DAY = 24 * 60 * 60 * 1000;

type Answer = (req: CarrierQuoteRequest) => Promise<CarrierRateOption[]>;

d('POST /chatbot-api/shipping/quotes (PostgreSQL)', () => {
  const prisma = worldPrisma();
  const credentials = new BotCredentials();
  const audit = { append: jest.fn(() => Promise.resolve()) };
  const answers: Record<'alpha' | 'beta', Answer> = {
    alpha: () => Promise.reject(new Error('unset')),
    beta: () => Promise.reject(new Error('unset')),
  };
  const carrierRequests: CarrierQuoteRequest[] = [];
  let app: INestApplication;
  let verifier: ShippingQuoteVerifier;
  const tenantIds: string[] = [];
  const createdPriceListIds: string[] = [];
  let defaultListId: string;

  const rate = (overrides: Partial<CarrierRateOption>): CarrierRateOption => ({
    carrier: 'Alpha',
    service: 'standard',
    totalCents: 15000,
    etaDays: 4,
    rateId: 'rate-1',
    validUntil: new Date(Date.now() + DAY),
    ...overrides,
  });

  beforeAll(async () => {
    const existingDefault = await prisma.globalPriceList.findFirst({
      where: { isDefault: true },
    });
    if (existingDefault) {
      defaultListId = existingDefault.id;
    } else {
      const created = await prisma.globalPriceList.create({
        data: { name: `PUBLICO-quotes-${randomUUID()}`, isDefault: true },
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
              SHIPPING_CARRIER_TIMEOUT_MS: '2000',
              // Boot-time reads of unrelated modules in the real graph.
              JWT_SECRET: 'shipping-quotes-test-secret',
              JWT_REFRESH_SECRET: 'shipping-quotes-test-refresh',
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
      .overrideProvider(SHIPPING_CARRIERS)
      .useValue(
        (['alpha', 'beta'] as const).map(
          (name) =>
            new FakeShippingCarrier(name, (req) => {
              carrierRequests.push(req);
              return answers[name](req);
            }),
        ),
      )
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
    verifier = app.get(ShippingQuoteVerifier);
  });

  afterAll(async () => {
    await app?.close();
    if (tenantIds.length > 0) {
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
    if (createdPriceListIds.length > 0) {
      await prisma.globalPriceList.deleteMany({
        where: { id: { in: createdPriceListIds } },
      });
    }
    await disconnectWorldPrisma();
  });

  beforeEach(() => {
    carrierRequests.length = 0;
    audit.append.mockClear();
    answers.alpha = () => Promise.reject(new Error('unset'));
    answers.beta = () => Promise.reject(new Error('unset'));
  });

  /** A sucursal with one priced product, a customer, boxes and an origin. */
  async function sucursal(
    options: {
      priceCents?: number;
      quantity?: number;
      packaging?: boolean;
      origin?: boolean;
      boxes?: boolean;
    } = {},
  ) {
    const tenantId = randomUUID();
    tenantIds.push(tenantId);
    await prisma.tenant.create({
      data: { id: tenantId, name: 'Quote branch', slug: `shq-${tenantId}` },
    });
    const productId = randomUUID();
    await prisma.product.create({
      data: {
        id: productId,
        tenantId,
        name: 'Quote product',
        useStock: true,
        quantity: options.quantity ?? 10,
      },
    });
    await prisma.priceList.create({
      data: {
        tenantId,
        productId,
        globalPriceListId: defaultListId,
        priceCents: options.priceCents ?? 60000,
      },
    });
    if (options.packaging !== false) {
      await prisma.productPackaging.create({
        data: {
          productId,
          tenantId,
          weightG: 450,
          lengthCm: 20,
          widthCm: 12,
          heightCm: 8,
        },
      });
    }
    if (options.boxes !== false) {
      await prisma.shippingBox.create({
        data: {
          tenantId,
          name: 'Caja mediana',
          innerLengthCm: 40,
          innerWidthCm: 30,
          innerHeightCm: 30,
          weightG: 300,
          maxContentWeightG: 20000,
        },
      });
    }
    if (options.origin !== false) {
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
    }
    const customerId = randomUUID();
    await prisma.customer.create({
      data: { id: customerId, tenantId, firstName: 'Ana', ...PHONE },
    });
    const token = credentials.register(tenantId, ['shipping:quote']);
    return { tenantId, productId, customerId, token };
  }

  async function zone(
    tenantId: string,
    type: 'FREE' | 'SURCHARGE' | 'CARRIER_ONLY' | 'DENIED',
    extra: {
      surchargeCents?: number;
      etaDays?: number;
      isActive?: boolean;
    } = {},
  ) {
    const userId = randomUUID();
    await prisma.deliveryZone.create({
      data: {
        tenantId,
        zipCode: DEST.zipCode,
        type,
        surchargeCents: extra.surchargeCents ?? null,
        etaDays: extra.etaDays ?? null,
        isActive: extra.isActive ?? true,
        approvedById: userId,
        approvedByDisplayName: 'Gerente',
        approvedAt: new Date(),
      },
    });
  }

  const post = (token: string, body: unknown) =>
    request(app.getHttpServer())
      .post('/chatbot-api/shipping/quotes')
      .set('Authorization', `Bearer ${token}`)
      .send(body as object);

  const body = (
    productId: string,
    quantity = 1,
    destination: object = DEST,
  ) => ({
    ...PHONE,
    items: [{ productId, quantity }],
    destination,
  });

  it('FREE: no carrier, zero charge, zone days; persisted and verifiable', async () => {
    const s = await sucursal();
    await zone(s.tenantId, 'FREE', { etaDays: 1 });
    const res = await post(s.token, body(s.productId, 2)).expect(201);
    expect(res.body).toEqual({
      quoteId: expect.stringMatching(/^shq_[A-Za-z0-9_-]{43}$/),
      expiresAt: expect.any(String),
      zoneStatus: 'FREE',
      option: null,
      eta: { days: 1, reason: null },
      costCents: 0,
      creditCents: 0,
      customerChargeCents: 0,
      currency: 'MXN',
    });
    expect(carrierRequests).toHaveLength(0);
    const ttl = Date.parse(res.body.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(29 * 60_000);
    expect(ttl).toBeLessThanOrEqual(30 * 60_000);

    const stored = await prisma.shippingQuote.findMany({
      where: { tenantId: s.tenantId },
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      customerId: s.customerId,
      zoneType: 'FREE',
      costCents: 0,
      currency: 'MXN',
    });
    expect(stored[0].tokenHash).not.toBe(res.body.quoteId);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: s.tenantId,
        action: 'shipping.quote',
        resourceType: 'shipping_quote',
      }),
    );
  });

  it('SURCHARGE: credit from real repricing lowers the surcharge (per unit above $500)', async () => {
    const s = await sucursal({ priceCents: 60000 });
    await zone(s.tenantId, 'SURCHARGE', { surchargeCents: 30000, etaDays: 2 });
    const res = await post(s.token, body(s.productId, 2)).expect(201);
    expect(res.body).toMatchObject({
      zoneStatus: 'SURCHARGE',
      option: null,
      eta: { days: 2, reason: null },
      costCents: 30000,
      creditCents: 24000,
      customerChargeCents: 6000,
    });
  });

  it('SURCHARGE: a unit priced exactly $500 earns no credit', async () => {
    const s = await sucursal({ priceCents: 50000 });
    await zone(s.tenantId, 'SURCHARGE', { surchargeCents: 4500, etaDays: 2 });
    const res = await post(s.token, body(s.productId, 3)).expect(201);
    expect(res.body).toMatchObject({
      costCents: 4500,
      creditCents: 0,
      customerChargeCents: 4500,
    });
  });

  it('SURCHARGE: the customer price list drives the credit (sale repricing)', async () => {
    const s = await sucursal({ priceCents: 60000 });
    const list = await prisma.globalPriceList.create({
      data: { name: `MAYOREO-quotes-${randomUUID()}` },
    });
    createdPriceListIds.push(list.id);
    await prisma.priceList.create({
      data: {
        tenantId: s.tenantId,
        productId: s.productId,
        globalPriceListId: list.id,
        priceCents: 40000,
      },
    });
    await prisma.customer.update({
      where: { id: s.customerId },
      data: { globalPriceListId: list.id },
    });
    await zone(s.tenantId, 'SURCHARGE', { surchargeCents: 30000, etaDays: 2 });
    const res = await post(s.token, body(s.productId, 2)).expect(201);
    expect(res.body).toMatchObject({
      creditCents: 0,
      customerChargeCents: 30000,
    });
  });

  it('DENIED: no quote, no charge, nothing stored', async () => {
    const s = await sucursal();
    await zone(s.tenantId, 'DENIED');
    const res = await post(s.token, body(s.productId)).expect(201);
    expect(res.body).toEqual({
      quoteId: null,
      expiresAt: null,
      zoneStatus: 'DENIED',
      option: null,
      eta: { days: null, reason: null },
      costCents: 0,
      creditCents: 0,
      customerChargeCents: 0,
      currency: 'MXN',
    });
    expect(
      await prisma.shippingQuote.count({ where: { tenantId: s.tenantId } }),
    ).toBe(0);
  });

  it('PENDING: unknown or inactive zone, no validation opened', async () => {
    const s = await sucursal();
    const unknown = await post(s.token, body(s.productId)).expect(201);
    expect(unknown.body).toMatchObject({
      zoneStatus: 'PENDING',
      quoteId: null,
    });
    await zone(s.tenantId, 'FREE', { etaDays: 1, isActive: false });
    const inactive = await post(s.token, body(s.productId)).expect(201);
    expect(inactive.body).toMatchObject({
      zoneStatus: 'PENDING',
      quoteId: null,
    });
    expect(
      await prisma.deliveryZoneValidation.count({
        where: { tenantId: s.tenantId },
      }),
    ).toBe(0);
  });

  it('CARRIER_ONLY: cheapest carrier, package and origin sent, credit applied, expiry bounded by the rate', async () => {
    const s = await sucursal({ priceCents: 60000 });
    await zone(s.tenantId, 'CARRIER_ONLY');
    const validUntil = new Date(Date.now() + 10 * 60_000);
    answers.alpha = () =>
      Promise.resolve([rate({ carrier: 'Alpha', totalCents: 18000 })]);
    answers.beta = () =>
      Promise.resolve([
        rate({
          carrier: 'Beta',
          service: 'express',
          totalCents: 15000,
          etaDays: 2,
          rateId: 'beta-rate',
          validUntil,
        }),
      ]);
    const res = await post(s.token, body(s.productId, 1)).expect(201);
    expect(res.body).toMatchObject({
      zoneStatus: 'CARRIER_ONLY',
      option: { carrier: 'Beta', service: 'express', etaDays: 2 },
      eta: { days: 2, reason: null },
      costCents: 15000,
      creditCents: 12000,
      customerChargeCents: 3000,
    });
    expect(res.body.expiresAt).toBe(validUntil.toISOString());
    expect(carrierRequests).toHaveLength(2);
    expect(carrierRequests[0]).toMatchObject({
      tenantId: s.tenantId,
      origin: { postalCode: '06000' },
      destination: { postalCode: '64000', state: 'Nuevo León' },
      parcel: { weightG: 750, lengthCm: 40, widthCm: 30, heightCm: 30 },
    });
    const stored = await prisma.shippingQuote.findFirstOrThrow({
      where: { tenantId: s.tenantId },
    });
    expect(stored).toMatchObject({
      carrier: 'Beta',
      service: 'express',
      carrierRateId: 'beta-rate',
      costCents: 15000,
      creditCents: 12000,
      customerChargeCents: 3000,
    });
    expect(stored.box).toMatchObject({
      box: { name: 'Caja mediana' },
      totalWeightG: 750,
    });
  });

  it('CARRIER_ONLY: one carrier failing uses the other; all failing is SHIPPING_QUOTE_UNAVAILABLE', async () => {
    const s = await sucursal();
    await zone(s.tenantId, 'CARRIER_ONLY');
    answers.beta = () =>
      Promise.resolve([rate({ carrier: 'Beta', totalCents: 22000 })]);
    const ok = await post(s.token, body(s.productId)).expect(201);
    expect(ok.body.option).toMatchObject({ carrier: 'Beta' });

    answers.beta = () => Promise.reject(new Error('Av. Juárez 123'));
    const down = await post(s.token, body(s.productId)).expect(503);
    expect(down.body).toMatchObject({
      statusCode: 503,
      error: 'SHIPPING_QUOTE_UNAVAILABLE',
    });
    expect(JSON.stringify(down.body)).not.toContain('Juárez');
  });

  it('CARRIER_ONLY: PACKAGING_DATA_MISSING lists the products', async () => {
    const s = await sucursal({ packaging: false });
    await zone(s.tenantId, 'CARRIER_ONLY');
    const res = await post(s.token, body(s.productId)).expect(422);
    expect(res.body).toMatchObject({
      error: 'PACKAGING_DATA_MISSING',
      missing: [{ productId: s.productId, variantId: null }],
    });
    expect(carrierRequests).toHaveLength(0);
  });

  it('CARRIER_ONLY: NO_SHIPPING_BOX_FITS without boxes', async () => {
    const s = await sucursal({ boxes: false });
    await zone(s.tenantId, 'CARRIER_ONLY');
    const res = await post(s.token, body(s.productId)).expect(422);
    expect(res.body).toMatchObject({
      error: 'NO_SHIPPING_BOX_FITS',
      boxesConsidered: 0,
    });
  });

  it('CARRIER_ONLY: SHIPPING_ORIGIN_NOT_CONFIGURED', async () => {
    const s = await sucursal({ origin: false });
    await zone(s.tenantId, 'CARRIER_ONLY');
    const res = await post(s.token, body(s.productId)).expect(422);
    expect(res.body).toMatchObject({ error: 'SHIPPING_ORIGIN_NOT_CONFIGURED' });
  });

  it('own zones need no packaging data', async () => {
    const s = await sucursal({ packaging: false, boxes: false, origin: false });
    await zone(s.tenantId, 'SURCHARGE', { surchargeCents: 4500, etaDays: 2 });
    await post(s.token, body(s.productId)).expect(201);
  });

  it('S9: a line without sellable stock returns STOCK_PENDING (expired lots excluded)', async () => {
    const s = await sucursal({ quantity: 3 });
    await zone(s.tenantId, 'FREE', { etaDays: 1 });
    await prisma.lot.create({
      data: {
        tenantId: s.tenantId,
        productId: s.productId,
        lotNumber: 'L-EXPIRED',
        quantity: 2,
        expirationDate: new Date('2020-01-01T00:00:00.000Z'),
      },
    });
    const short = await post(s.token, body(s.productId, 2)).expect(201);
    expect(short.body.eta).toEqual({ days: null, reason: 'STOCK_PENDING' });
    const enough = await post(s.token, body(s.productId, 1)).expect(201);
    expect(enough.body.eta).toEqual({ days: 1, reason: null });
  });

  it('saved address destination: binds through verify; foreign address is 404', async () => {
    const s = await sucursal();
    await zone(s.tenantId, 'SURCHARGE', { surchargeCents: 4500, etaDays: 2 });
    const address = await prisma.customerAddress.create({
      data: {
        tenantId: s.tenantId,
        customerId: s.customerId,
        street: 'Calle 1',
        ...DEST,
      },
    });
    const res = await post(
      s.token,
      body(s.productId, 1, { shippingAddressId: address.id }),
    ).expect(201);
    const lines = [{ productId: s.productId, quantity: 1 }];
    const ok = await verifier.verify(res.body.quoteId, {
      tenantId: s.tenantId,
      customer: PHONE,
      lines,
      destination: DEST,
    });
    expect(ok).toMatchObject({
      status: 'OK',
      // $600 unit → $120 credit, capped at the $45 surcharge.
      quote: {
        costCents: 4500,
        creditCents: 4500,
        customerChargeCents: 0,
        currency: 'MXN',
      },
    });
    expect(
      await verifier.verify(res.body.quoteId, {
        tenantId: s.tenantId,
        customer: PHONE,
        lines: [{ productId: s.productId, quantity: 2 }],
        destination: DEST,
      }),
    ).toEqual({ status: 'MISMATCH', mismatches: ['LINES'] });
    expect(
      await verifier.verify(
        res.body.quoteId,
        { tenantId: s.tenantId, customer: PHONE, lines, destination: DEST },
        new Date(Date.now() + 31 * 60_000),
      ),
    ).toEqual({ status: 'EXPIRED' });
    expect(
      await verifier.verify('shq_' + 'x'.repeat(43), {
        tenantId: s.tenantId,
        customer: PHONE,
        lines,
        destination: DEST,
      }),
    ).toEqual({ status: 'NOT_FOUND' });

    const other = await sucursal();
    const foreign = await post(
      other.token,
      body(other.productId, 1, { shippingAddressId: address.id }),
    ).expect(404);
    expect(foreign.body.error).toBe('SHIPPING_ADDRESS_NOT_FOUND');
  });

  it('tenant isolation: another sucursal cannot quote my product nor verify my quote', async () => {
    const mine = await sucursal();
    await zone(mine.tenantId, 'FREE', { etaDays: 1 });
    const res = await post(mine.token, body(mine.productId)).expect(201);
    const other = await sucursal();
    await zone(other.tenantId, 'FREE', { etaDays: 1 });
    const foreign = await post(other.token, body(mine.productId)).expect(404);
    expect(foreign.body.error).toBe('PRODUCT_NOT_FOUND');
    expect(
      await verifier.verify(res.body.quoteId, {
        tenantId: other.tenantId,
        customer: PHONE,
        lines: [{ productId: mine.productId, quantity: 1 }],
        destination: DEST,
      }),
    ).toEqual({ status: 'NOT_FOUND' });
  });

  it('validation: destination XOR, unknown keys, missing phone, duplicate lines, scope', async () => {
    const s = await sucursal();
    await post(s.token, body(s.productId, 1, { zipCode: '64000' })).expect(400);
    await post(
      s.token,
      body(s.productId, 1, { ...DEST, shippingAddressId: randomUUID() }),
    ).expect(400);
    await post(s.token, { ...body(s.productId), unitPriceCents: 1 }).expect(
      400,
    );
    await post(s.token, {
      items: body(s.productId).items,
      destination: DEST,
    }).expect(400);
    const dup = await post(s.token, {
      ...PHONE,
      items: [
        { productId: s.productId, quantity: 1 },
        { productId: s.productId, quantity: 2 },
      ],
      destination: DEST,
    }).expect(400);
    expect(dup.body.error).toBe('DUPLICATE_CART_LINE');
    const noScope = credentials.register(s.tenantId, ['pricing:evaluate']);
    await post(noScope, body(s.productId)).expect(403);
  });
});
