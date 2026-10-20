/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await */
// Isolated fixture: actual sale/ledger/stock-alert/outbox adapters; pricing/demand selection remains deterministic.
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { CheckoutRequestDto } from './dto/checkout.request';
import { computeCheckoutRequestHash } from '../application/checkout.service';
import { PrismaPromotionUsageRepository } from '../../promotions/infrastructure/prisma-promotion-usage.repository';
import { PrismaProductRepository } from '../../products/infrastructure/prisma-product.repository';
import { PrismaStockAlertStateRepository } from '../../stock-alerts/infrastructure/prisma-stock-alert-state.repository';
import { OutboxWriterService } from '../../shared/outbox/outbox-writer.service';
import { ClsService } from 'nestjs-cls';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { CheckoutController } from './checkout.controller';
import { CheckoutService } from '../application/checkout.service';
import { ChatbotApiController } from './chatbot-api.controller';
import { ChatbotApiService } from '../application/chatbot-api.service';
import { CustomersService } from '../../customers/customers.service';
import { PrismaCustomerRepository } from '../../customers/infrastructure/prisma-customer.repository';
import { PrismaSaleRepository } from '../../sales/infrastructure/prisma-sale.repository';
import { SalesService } from '../../sales/sales.service';
import { DeliveryRoute } from '../../delivery-routes/domain/delivery-route.entity';
import { DeliveryRoutesService } from '../../delivery-routes/application/delivery-routes.service';
import { PrismaDeliveryRouteRepository } from '../../delivery-routes/infrastructure/prisma-delivery-route.repository';
import { PrismaEligibleSalesReader } from '../../delivery-routes/infrastructure/eligible-sales-prisma.reader';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { PrismaServiceCredentialRepository } from '../infrastructure/prisma-service-credential.repository';
import { SERVICE_CREDENTIAL_REPOSITORY } from '../domain/service-credential.repository';
import { BOT_AUDIT_LOG_REPOSITORY } from '../infrastructure/prisma-bot-audit-log.repository';
import { ServiceAuthGuard } from './guards/service-auth.guard';
import { BotAuditInterceptor } from './interceptors/bot-audit.interceptor';

const token = 'svc_disposable-checkout-test';
const rotatedToken = 'svc_disposable-checkout-rotated';
const foreignToken = 'svc_disposable-checkout-other-tenant';
const hashToken = (value: string) =>
  createHash('sha256').update(value).digest('hex');
function disposableUrl(): string {
  const raw = process.env.ATOMIC_CHECKOUT_TEST_DATABASE_URL;
  if (!raw)
    throw new Error(
      'Explicit disposable ATOMIC_CHECKOUT_TEST_DATABASE_URL required; no dotenv fallback',
    );
  const url = new URL(raw);
  if (
    url.protocol !== 'postgresql:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.pathname !== '/atomic_checkout_test'
  )
    throw new Error('Refusing non-loopback or non-disposable checkout target');
  return raw;
}

describe('Checkout isolated PostgreSQL HTTP transaction proof', () => {
  let db: PrismaClient;
  let app: INestApplication;
  let tenantId: string;
  let cashier: string;
  let productId: string;
  let tenant: TenantPrismaService;
  let contexts: AsyncLocalStorage<Record<string, unknown>>;
  let failOutbox: boolean;
  let hold: { entered: () => void; wait: Promise<void> } | undefined;
  let confirmation: jest.SpyInstance;
  let sales: SalesService;
  let audit: { append: jest.Mock };
  let credentialId: string;
  let extraTenantIds: string[];
  let capacityDemands: Array<{ promotionId: string; units: number }>;
  let afterSaleOutbox: (() => Promise<void>) | undefined;
  beforeAll(() => {
    db = new PrismaClient({ datasources: { db: { url: disposableUrl() } } });
  });
  afterAll(async () => {
    await db.$disconnect();
  });
  beforeEach(async () => {
    tenantId = randomUUID();
    cashier = randomUUID();
    productId = randomUUID();
    failOutbox = false;
    hold = undefined;
    afterSaleOutbox = undefined;
    capacityDemands = [];
    extraTenantIds = [];
    credentialId = randomUUID();
    await db.tenant.create({
      data: {
        id: tenantId,
        name: 'Isolated checkout fixture',
        slug: `checkout-${tenantId}`,
      },
    });
    await db.serviceCredential.create({
      data: {
        id: credentialId,
        tenantId,
        name: 'Disposable fixture',
        hashedKey: hashToken(token),
        scopes: ['customers:read', 'customers:write', 'sales:create'],
        rateLimit: 1000,
      },
    });
    await db.user.create({
      data: {
        id: cashier,
        name: 'Fixture cashier',
        email: `${cashier}@example.invalid`,
        hashedPassword: 'unused-test-fixture',
      },
    });
    const role = await db.role.create({
      data: { tenantId, name: 'Fixture cashier' },
    });
    await db.tenantMembership.create({
      data: { tenantId, userId: cashier, roleId: role.id },
    });
    await db.product.create({
      data: {
        id: productId,
        tenantId,
        name: 'Fixture item',
        quantity: 10,
        useStock: true,
      },
    });
    contexts = new AsyncLocalStorage<Record<string, unknown>>();
    const cls = {
      get: (key: string) => contexts.getStore()?.[key],
      set: (key: string, value: unknown) => {
        const ctx = contexts.getStore();
        if (!ctx) throw new Error('Fixture CLS missing');
        ctx[key] = value;
      },
    };
    // SAFETY: PrismaService extends PrismaClient; this owned fixture uses its generated client API only.
    // SAFETY: the CLS shim supplies exactly get/set used by the tenant extension/ambient transaction.
    tenant = new TenantPrismaService(
      db as unknown as PrismaService,
      cls as unknown as ClsService<TenantClsStore>,
    );
    const repo = new PrismaSaleRepository(tenant);
    // SAFETY: the actual confirmBotSale method uses the explicitly installed ports below.
    sales = Object.create(SalesService.prototype) as SalesService;
    const outbox = new OutboxWriterService();
    const publish: OutboxWriterService['publish'] = outbox.publish.bind(outbox);
    // Observe/inject only AFTER the actual adapter writes the final sale event.
    // Stock/promotion event writes run unchanged, through that same real writer.
    jest
      .spyOn(outbox, 'publish')
      .mockImplementation(
        async (...args: Parameters<OutboxWriterService['publish']>) => {
          await publish(...args);
          if (args[2] !== 'Sale') return;
          if (afterSaleOutbox) await afterSaleOutbox();
          if (hold) {
            const current = hold;
            hold = undefined;
            current.entered();
            await current.wait;
          }
          if (failOutbox)
            throw new Error('driver error phone 5512345678 Private Street');
        },
      );
    const products = new PrismaProductRepository(
      tenant,
      outbox,
      new PrismaStockAlertStateRepository(),
    );
    Object.assign(sales, {
      tenantPrisma: tenant,
      saleRepo: repo,
      productsService: {
        getApplicablePrices: async () => [{ priceCents: 10000 }],
        decrementStockForCharge: (
          items: Parameters<
            PrismaProductRepository['decrementStockForCharge']
          >[0],
        ) => products.decrementStockForCharge(items),
      },
      recomputePricingAndPromotions: async () => ({
        promotionCapacityDemands: capacityDemands,
      }),
      promotionUsageRepo: new PrismaPromotionUsageRepository(tenant, outbox),
      outboxWriter: outbox,
      eventEmitter: { emit: jest.fn() },
    });
    confirmation = jest.spyOn(sales, 'confirmBotSale');
    const config = new ConfigService({ BOT_SHIPPING_CHARGE_MAX_CENTS: 50000 });
    type ReadPorts = ConstructorParameters<typeof ChatbotApiService>;
    // SAFETY: catalog/promotion ports are unused by the checkout-context read exercised here.
    const reads = new ChatbotApiService(
      {} as ReadPorts[0],
      new PrismaCustomerRepository(tenant),
      {} as ReadPorts[2],
      sales,
      repo,
      tenant,
      config,
    );
    audit = { append: jest.fn().mockResolvedValue(undefined) };
    const module = await Test.createTestingModule({
      controllers: [CheckoutController, ChatbotApiController],
      providers: [
        CheckoutService,
        ServiceAuthGuard,
        BotAuditInterceptor,
        { provide: TenantPrismaService, useValue: tenant },
        { provide: SalesService, useValue: sales },
        { provide: ConfigService, useValue: config },
        { provide: ChatbotApiService, useValue: reads },
        { provide: ClsService, useValue: cls },
        { provide: BOT_AUDIT_LOG_REPOSITORY, useValue: audit },
        {
          provide: SERVICE_CREDENTIAL_REPOSITORY,
          // SAFETY: the owned generated client supplies PrismaService's credential API.
          useValue: new PrismaServiceCredentialRepository(
            db as unknown as PrismaService,
          ),
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use((_req: unknown, _res: unknown, next: () => void) =>
      contexts.run({}, next),
    );
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    await app.init();
  });
  afterEach(async () => {
    await app?.close();
    if (tenantId)
      await db.tenant.deleteMany({
        where: { id: { in: [tenantId, ...extraTenantIds] } },
      });
    if (cashier) await db.user.deleteMany({ where: { id: cashier } });
  });

  const body = () => ({
    phoneCountryCode: '52',
    phone: '5512345678',
    customer: { mode: 'createIfAbsent', firstName: 'Ana' },
    deliveryAddress: {
      mode: 'newSaved',
      address: { street: 'Fixture Street' },
    },
    sale: {
      cashierUserId: cashier,
      items: [
        {
          productId,
          productName: 'Fixture item',
          quantity: 1,
          unitPriceCents: 10000,
        },
      ],
      expectedTotalCents: 10000,
    },
  });
  const post = (value: object, key = 'atomic-key', auth = token) =>
    request(app.getHttpServer())
      .post('/chatbot-api/checkouts')
      .set('Authorization', `Bearer ${auth}`)
      .set('X-Idempotency-Key', key)
      .send(value);
  const status = (key = 'atomic-key', auth = token) =>
    request(app.getHttpServer())
      .get('/chatbot-api/checkouts/status')
      .set('Authorization', `Bearer ${auth}`)
      .set('X-Idempotency-Key', key);
  const context = () =>
    request(app.getHttpServer())
      .get(
        '/chatbot-api/customers/checkout-context?phoneCountryCode=52&phone=5512345678',
      )
      .set('Authorization', `Bearer ${token}`);
  // Isolated physical transaction probes supplement public HTTP reads for effects with no public listing API.
  const committedEffects = async (
    owner = tenantId,
    item = productId,
    client: Prisma.TransactionClient = db,
  ) => ({
    customers: await client.customer.count({ where: { tenantId: owner } }),
    addresses: await client.customerAddress.count({
      where: { tenantId: owner },
    }),
    sales: await client.sale.count({ where: { tenantId: owner } }),
    receipts: await client.saleIdempotency.count({
      where: { tenantId: owner },
    }),
    outbox: await client.outboxEvent.count({ where: { tenantId: owner } }),
    folios: await client.saleFolioCounter.findMany({
      where: { tenantId: owner },
      select: { period: true, lastNumber: true },
      orderBy: { period: 'asc' },
    }),
    stock: (await client.product.findUniqueOrThrow({ where: { id: item } }))
      .quantity,
    promotionUsages: await client.promotionUsage.count({
      where: { tenantId: owner },
    }),
    promotions: await client.promotion.findMany({
      where: { tenantId: owner },
      select: { id: true, consumedProductUnits: true },
      orderBy: { id: 'asc' },
    }),
    stockAlerts: await client.stockAlertState.findMany({
      where: { tenantId: owner },
      select: { productId: true, alerted: true, alertEpoch: true },
      orderBy: { productId: 'asc' },
    }),
  });

  const deliveryFields = {
    street: 'Snapshot Street',
    exteriorNumber: '14',
    interiorNumber: '2B',
    zipCode: '64000',
    neighborhood: 'Centro',
    municipality: 'Monterrey',
    city: 'Monterrey',
    state: 'Nuevo León',
    visualReferences: 'Blue gate',
    carrierPhone: '5512345678',
    label: 'Home',
    latitude: 25.68,
    longitude: -100.31,
  };
  const snapshotColumns = (fields = deliveryFields) =>
    Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [
        `shipping${key[0].toUpperCase()}${key.slice(1)}`,
        value,
      ]),
    );
  const persistedSale = (id: string) =>
    db.sale.findUniqueOrThrow({ where: { id, tenantId } });

  const savedDeliveryAddress = async () => {
    const customer = await db.customer.create({
      data: {
        tenantId,
        firstName: 'Fixture',
        phoneCountryCode: '52',
        phone: '5512345678',
      },
    });
    const address = await db.customerAddress.create({
      data: { tenantId, customerId: customer.id, ...deliveryFields },
    });
    return { customer, address };
  };

  const correctionBody = (
    customerId: string,
    address: { id: string; updatedAt: Date },
    changes: Record<string, string | null> = {},
  ) => {
    const fields = Object.fromEntries(
      Object.entries(deliveryFields).filter(
        ([, value]) => typeof value === 'string',
      ),
    );
    return {
      ...body(),
      customer: { mode: 'existing', customerId },
      deliveryAddress: {
        mode: 'existingUpdated',
        addressId: address.id,
        expectedVersion: address.updatedAt.toISOString(),
        address: { ...fields, ...changes },
      },
    };
  };

  it('existingUpdated: updates in place, snapshots corrected fields and replays without another write', async () => {
    const { customer, address } = await savedDeliveryAddress();
    const value = correctionBody(customer.id, address, { zipCode: '64001' });
    const first = await post(value);
    expect(first.status).toBe(201);
    const updated = await db.customerAddress.findUniqueOrThrow({
      where: { id: address.id },
    });
    expect(updated).toEqual({
      ...address,
      zipCode: '64001',
      latitude: null,
      longitude: null,
      updatedAt: expect.any(Date),
    });
    expect(updated.updatedAt).not.toEqual(address.updatedAt);
    expect(first.body.address).toEqual({
      resolution: 'updated',
      id: address.id,
      version: updated.updatedAt.toISOString(),
    });
    expect(await persistedSale(first.body.sale.saleId)).toMatchObject({
      shippingAddressId: address.id,
      ...snapshotColumns(),
      shippingZipCode: '64001',
      shippingLatitude: null,
      shippingLongitude: null,
    });
    const effects = await committedEffects();
    expect((await post(value)).body).toEqual(first.body);
    expect((await status()).body.checkout).toEqual(first.body);
    expect(await committedEffects()).toEqual(effects);
    expect(
      await db.customerAddress.findUniqueOrThrow({ where: { id: address.id } }),
    ).toEqual(updated);
    const conflict = await post({
      ...value,
      deliveryAddress: {
        ...value.deliveryAddress,
        address: { ...value.deliveryAddress.address, zipCode: '64002' },
      },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('IDEMPOTENCY_KEY_CONFLICT');
    expect(await committedEffects()).toEqual(effects);
  });

  it.each(['re-quote', 'late failure'] as const)(
    'existingUpdated: rolls back the correction on %s',
    async (failure) => {
      const { customer, address } = await savedDeliveryAddress();
      const value = correctionBody(customer.id, address, { zipCode: '64001' });
      const before = await committedEffects();
      if (failure === 're-quote') value.sale.expectedTotalCents = 1;
      else failOutbox = true;
      let observed: unknown;
      afterSaleOutbox = async () => {
        observed = await tenant.getClient().customerAddress.findUniqueOrThrow({
          where: { id: address.id },
        });
      };
      const response = await post(value);
      expect(response.status).toBe(failure === 're-quote' ? 409 : 500);
      expect(response.body.error).toBe(
        failure === 're-quote' ? 'PROMO_RE_QUOTE' : 'CHECKOUT_CREATE_FAILED',
      );
      if (failure === 'late failure')
        expect(observed).toMatchObject({ zipCode: '64001', latitude: null });
      expect(
        await db.customerAddress.findUniqueOrThrow({
          where: { id: address.id },
        }),
      ).toEqual(address);
      expect(await committedEffects()).toEqual(before);
    },
  );

  it('existingUpdated: replaces all body fields, clearing omitted optional values and preserving other columns', async () => {
    const { customer, address } = await savedDeliveryAddress();
    const value = correctionBody(customer.id, address);
    value.deliveryAddress.address = { street: 'Replacement Street' };
    const response = await post(value);
    expect(response.status).toBe(201);
    expect(
      await db.customerAddress.findUniqueOrThrow({ where: { id: address.id } }),
    ).toEqual({
      ...address,
      street: 'Replacement Street',
      exteriorNumber: null,
      interiorNumber: null,
      zipCode: null,
      neighborhood: null,
      municipality: null,
      city: null,
      state: null,
      label: null,
      visualReferences: null,
      carrierPhone: null,
      latitude: null,
      longitude: null,
      updatedAt: expect.any(Date),
    });
  });

  it('existingUpdated: rejects noncanonical dates before any business changes', async () => {
    const { customer, address } = await savedDeliveryAddress();
    const value = correctionBody(customer.id, address);
    value.deliveryAddress.expectedVersion = '2026-02-31T00:00:00.000Z';
    const before = await committedEffects();
    const response = await post(value);
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('INVALID_CHECKOUT_REQUEST');
    expect(await committedEffects()).toEqual(before);
  });

  it('existingUpdated: stale version rejects without any business changes', async () => {
    const { customer, address } = await savedDeliveryAddress();
    const value = correctionBody(customer.id, address, { zipCode: '64001' });
    value.deliveryAddress.expectedVersion = '2000-01-01T00:00:00.000Z';
    const before = await committedEffects();
    const response = await post(value);
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('ADDRESS_VERSION_CONFLICT');
    expect(await committedEffects()).toEqual(before);
    expect(
      await db.customerAddress.findUniqueOrThrow({ where: { id: address.id } }),
    ).toEqual(address);
  });

  it.each(['customer', 'tenant', 'missing'] as const)(
    'existingUpdated: hides an address owned by another %s',
    async (owner) => {
      const { customer, address } = await savedDeliveryAddress();
      let ownerTenant = tenantId;
      if (owner === 'tenant') {
        ownerTenant = randomUUID();
        extraTenantIds.push(ownerTenant);
        await db.tenant.create({
          data: { id: ownerTenant, name: 'Foreign fixture', slug: ownerTenant },
        });
      }
      const foreign = await db.customer.create({
        data: { tenantId: ownerTenant, firstName: 'Other' },
      });
      const foreignAddress = await db.customerAddress.create({
        data: {
          tenantId: ownerTenant,
          customerId: foreign.id,
          street: 'Other',
        },
      });
      const value = correctionBody(customer.id, address, { zipCode: '64001' });
      value.deliveryAddress.addressId =
        owner === 'missing' ? randomUUID() : foreignAddress.id;
      const before = await committedEffects();
      const response = await post(value);
      expect(response.status).toBe(404);
      expect(response.body.error).toBe('SHIPPING_ADDRESS_NOT_FOUND');
      expect(await committedEffects()).toEqual(before);
      expect(
        await db.customerAddress.findUniqueOrThrow({
          where: { id: address.id },
        }),
      ).toEqual(address);
      expect(
        await db.customerAddress.findUniqueOrThrow({
          where: { id: foreignAddress.id },
        }),
      ).toEqual(foreignAddress);
    },
  );

  it('existingUpdated: identical normalized body is existing with no write or version change', async () => {
    const { customer, address } = await savedDeliveryAddress();
    await db.customerAddress.update({
      where: { id: address.id },
      data: { label: null, updatedAt: address.updatedAt },
    });
    const value = correctionBody(customer.id, address);
    // Optional omission and stored null compare identically.
    Reflect.deleteProperty(value.deliveryAddress.address, 'label');
    const response = await post(value);
    expect(response.status).toBe(201);
    expect(response.body.address).toEqual({
      resolution: 'existing',
      id: address.id,
      version: address.updatedAt.toISOString(),
    });
    expect(
      await db.customerAddress.findUniqueOrThrow({ where: { id: address.id } }),
    ).toEqual({ ...address, label: null });
  });

  it.each([
    'street',
    'exteriorNumber',
    'interiorNumber',
    'zipCode',
    'neighborhood',
    'municipality',
    'city',
    'state',
  ])(
    'existingUpdated: invalidates coordinates on changed location field %s',
    async (field) => {
      const { customer, address } = await savedDeliveryAddress();
      const response = await post(
        correctionBody(customer.id, address, {
          [field]: field === 'state' ? 'Jalisco' : 'Changed',
        }),
      );
      expect(response.status).toBe(201);
      expect(response.body.address.resolution).toBe('updated');
      expect(
        await db.customerAddress.findUniqueOrThrow({
          where: { id: address.id },
        }),
      ).toMatchObject({ latitude: null, longitude: null });
    },
  );

  it.each(['label', 'visualReferences', 'carrierPhone'])(
    'existingUpdated: preserves coordinates when only %s changes',
    async (field) => {
      const { customer, address } = await savedDeliveryAddress();
      const response = await post(
        correctionBody(customer.id, address, { [field]: 'Changed' }),
      );
      expect(response.status).toBe(201);
      expect(response.body.address.resolution).toBe('updated');
      expect(
        await db.customerAddress.findUniqueOrThrow({
          where: { id: address.id },
        }),
      ).toEqual({
        ...address,
        [field]: 'Changed',
        updatedAt: expect.any(Date),
      });
      expect(await persistedSale(response.body.sale.saleId)).toMatchObject({
        shippingLatitude: deliveryFields.latitude,
        shippingLongitude: deliveryFields.longitude,
      });
    },
  );

  it('existingUpdated: leaves a previous confirmed order on a route stop unchanged', async () => {
    const { customer, address } = await savedDeliveryAddress();
    const previous = await post(
      {
        ...body(),
        customer: { mode: 'existing', customerId: customer.id },
        deliveryAddress: {
          mode: 'existing',
          addressId: address.id,
          expectedVersion: address.updatedAt.toISOString(),
        },
      },
      'previous-order',
    );
    expect(previous.status).toBe(201);
    const saleId: string = previous.body.sale.saleId;
    const before = await persistedSale(saleId);
    await contexts.run({ tenantId }, async () => {
      const routeRepo = new PrismaDeliveryRouteRepository(tenant);
      const routes = Object.create(
        DeliveryRoutesService.prototype,
      ) as DeliveryRoutesService;
      Object.assign(routes, { tenantPrisma: tenant });
      const route = await DeliveryRoute.create({
        tenantId,
        driverUserId: cashier,
        saleIds: [saleId],
        checkSaleEligibility: (id) =>
          routes['checkSaleEligibility'](id, tenantId),
      });
      await routeRepo.save(route);
      const beforeRoute = await routeRepo.findOneWithStops({
        tenantId,
        id: route.id,
      });
      const corrected = await post(
        correctionBody(customer.id, address, { street: 'Corrected Street' }),
        'corrected-order',
      );
      expect(corrected.status).toBe(201);
      expect(corrected.body.address.resolution).toBe('updated');
      expect(await persistedSale(corrected.body.sale.saleId)).toMatchObject({
        shippingAddressId: address.id,
        shippingStreet: 'Corrected Street',
      });
      expect(await persistedSale(saleId)).toEqual(before);
      expect(
        await routeRepo.findOneWithStops({ tenantId, id: route.id }),
      ).toEqual(beforeRoute);
      expect(beforeRoute?.stops[0].shippingAddress).toMatchObject({
        street: deliveryFields.street,
        zipCode: deliveryFields.zipCode,
        latitude: deliveryFields.latitude,
        longitude: deliveryFields.longitude,
      });
    });
  });

  it.each(['new', 'existing', 'legacy bot', 'POS'] as const)(
    'snapshot: persists and freezes all delivery fields for %s',
    async (path) => {
      const { customer, address } = await savedDeliveryAddress();
      let saleId: string;
      if (path === 'new' || path === 'existing') {
        const value = {
          ...body(),
          customer: { mode: 'existing', customerId: customer.id },
          deliveryAddress:
            path === 'new'
              ? {
                  mode: 'newSaved',
                  address: Object.fromEntries(
                    Object.entries(deliveryFields).filter(
                      ([, value]) => typeof value === 'string',
                    ),
                  ),
                }
              : {
                  mode: 'existing',
                  addressId: address.id,
                  expectedVersion: address.updatedAt.toISOString(),
                },
        };
        const response = await post(value);
        expect(response.status).toBe(201);
        saleId = response.body.sale.saleId;
      } else if (path === 'legacy bot') {
        const response = await request(app.getHttpServer())
          .post('/chatbot-api/sales')
          .set('Authorization', `Bearer ${token}`)
          .set('X-Idempotency-Key', 'snapshot-bot')
          .send({
            ...body().sale,
            customerId: customer.id,
            shippingAddressId: address.id,
          });
        expect(response.status).toBe(201);
        saleId = response.body.saleId;
      } else {
        saleId = randomUUID();
        await db.sale.create({
          data: { id: saleId, tenantId, userId: cashier },
        });
        await contexts.run({ tenantId }, async () => {
          await sales.assignCustomer(saleId, cashier, {
            customerId: customer.id,
            shippingAddressId: address.id,
          });
          expect(await persistedSale(saleId)).toMatchObject(snapshotColumns());
          await sales.clearShippingAddress(saleId, cashier);
          expect(await persistedSale(saleId)).toMatchObject({
            shippingAddressId: null,
            shippingStreet: null,
            shippingLatitude: null,
          });
          await sales.setShippingAddress(saleId, cashier, {
            shippingAddressId: address.id,
          });
          expect(await persistedSale(saleId)).toMatchObject(snapshotColumns());
          await db.customerAddress.update({
            where: { id: address.id },
            data: { street: 'Before confirmation' },
          });
          await sales.chargeDraft(
            saleId,
            cashier,
            { payments: [] },
            'snapshot-pos',
          );
        });
      }
      const before = await persistedSale(saleId);
      const fields = {
        ...deliveryFields,
        street: path === 'POS' ? 'Before confirmation' : deliveryFields.street,
      };
      // The newSaved DTO currently accepts no coordinates; they remain nullable.
      expect(before).toMatchObject({
        ...snapshotColumns(fields),
        ...(path === 'new'
          ? { shippingLatitude: null, shippingLongitude: null }
          : {}),
      });
      const addressId = before.shippingAddressId!;
      const customers = new CustomersService(
        new PrismaCustomerRepository(tenant),
        db as unknown as PrismaService,
        tenant,
      );
      await contexts.run({ tenantId }, () =>
        customers.updateAddress(customer.id, addressId, {
          street: 'After confirmation',
        }),
      );
      expect(await persistedSale(saleId)).toEqual(before);
      await db.customerAddress.delete({ where: { id: addressId, tenantId } });
      expect(await persistedSale(saleId)).toEqual({
        ...before,
        shippingAddressId: null,
      });
      const reloaded = await contexts.run({ tenantId }, () =>
        new PrismaSaleRepository(tenant).findById(saleId),
      );
      expect(reloaded).toHaveProperty('shippingAddressSnapshot', {
        ...fields,
        ...(path === 'new' ? { latitude: null, longitude: null } : {}),
      });
      // A generic metadata save must not erase a confirmed snapshot.
      await contexts.run({ tenantId }, () =>
        new PrismaSaleRepository(tenant).save(reloaded!),
      );
      expect(await persistedSale(saleId)).toMatchObject({
        ...snapshotColumns(fields),
        ...(path === 'new'
          ? { shippingLatitude: null, shippingLongitude: null }
          : {}),
      });
    },
  );

  it.each(['edit', 'delete'] as const)(
    'snapshot reads: POS, bot, routes, search and next-stop survive customer address %s',
    async (mutation) => {
      const { customer, address } = await savedDeliveryAddress();
      const response = await post({
        ...body(),
        customer: { mode: 'existing', customerId: customer.id },
        deliveryAddress: {
          mode: 'existing',
          addressId: address.id,
          expectedVersion: address.updatedAt.toISOString(),
        },
      });
      expect(response.status).toBe(201);
      const saleId: string = response.body.sale.saleId;
      await db.sale.update({
        where: { id: saleId },
        data: { deliveryStatus: 'PENDING' },
      });
      await contexts.run({ tenantId }, async () => {
        const repo = new PrismaSaleRepository(tenant);
        const routeRepo = new PrismaDeliveryRouteRepository(tenant);
        const reader = new PrismaEligibleSalesReader(tenant);
        const routes = Object.create(
          DeliveryRoutesService.prototype,
        ) as DeliveryRoutesService;
        Object.assign(routes, { tenantPrisma: tenant });
        const route = await DeliveryRoute.create({
          tenantId,
          driverUserId: cashier,
          saleIds: [saleId],
          checkSaleEligibility: (id) =>
            routes['checkSaleEligibility'](id, tenantId),
        });
        await routeRepo.save(route);
        const read = async () => {
          const pos = await repo.findDraftResponseById(saleId);
          const detail = await routeRepo.findOneWithStops({
            tenantId,
            id: route.id,
          });
          const list = await routeRepo.list({ tenantId });
          const eligible = await reader.findEligibleSales({
            tenantId,
            page: 1,
            limit: 10,
            saleScope: null,
          });
          const next = await routes['composeNextStopPayload'](
            db,
            tenantId,
            route,
            'current-stop',
            'next-stop',
            saleId,
          );
          const history = await request(app.getHttpServer())
            .get(
              '/chatbot-api/customers/by-phone/5512345678/orders?phoneCountryCode=52',
            )
            .set('Authorization', `Bearer ${token}`);
          expect(history.status).toBe(200);
          return {
            pos: pos?.shippingAddress,
            detail: detail?.stops[0].shippingAddress,
            list: list[0].stops[0].shippingAddress,
            eligible: eligible.rows[0].shippingAddress,
            next: next.nextAddressLabel,
            bot: history.body[0].shippingAddress,
          };
        };
        const before = await read();
        if (mutation === 'edit')
          await db.customerAddress.update({
            where: { id: address.id },
            data: {
              street: 'Changed Street',
              zipCode: '99999',
              latitude: 0,
              longitude: 0,
            },
          });
        else await db.customerAddress.delete({ where: { id: address.id } });
        const after = await read();
        for (const key of ['pos', 'detail', 'list', 'eligible'] as const) {
          expect(after[key]).toEqual({
            ...before[key],
            id: mutation === 'delete' ? null : address.id,
          });
        }
        expect(after.bot).toEqual(before.bot);
        expect(after.next).toEqual(before.next);
        expect(after.detail).toMatchObject({
          latitude: deliveryFields.latitude,
          longitude: deliveryFields.longitude,
        });
        for (const q of [deliveryFields.street, deliveryFields.zipCode]) {
          const matches = await reader.findEligibleSales({
            tenantId,
            page: 1,
            limit: 10,
            saleScope: null,
            q,
          });
          expect(matches.total).toBe(1);
          expect(matches.rows[0].id).toBe(saleId);
        }
        for (const q of ['Changed Street', '99999']) {
          const matches = await reader.findEligibleSales({
            tenantId,
            page: 1,
            limit: 10,
            saleScope: null,
            q,
          });
          expect(matches.total).toBe(0);
        }
        await expect(
          routes['checkSaleEligibility'](saleId, tenantId),
        ).resolves.toMatchObject({ hasShippingAddress: true });
      });
    },
  );

  it('snapshot: rolls back persisted columns after confirmation fails and leaves existing address unchanged', async () => {
    const { customer, address } = await savedDeliveryAddress();
    const value = {
      ...body(),
      customer: { mode: 'existing', customerId: customer.id },
      deliveryAddress: {
        mode: 'existing',
        addressId: address.id,
        expectedVersion: address.updatedAt.toISOString(),
      },
    };
    let observed: unknown;
    afterSaleOutbox = async () => {
      observed = await tenant
        .getClient()
        .sale.findFirstOrThrow({ where: { tenantId } });
    };
    failOutbox = true;
    expect((await post(value)).status).toBe(500);
    expect(observed).toMatchObject(snapshotColumns());
    expect(await db.sale.count({ where: { tenantId } })).toBe(0);
    expect(
      await db.customerAddress.findUniqueOrThrow({
        where: { id: address.id },
      }),
    ).toEqual(address);
    value.sale.expectedTotalCents = 1;
    failOutbox = false;
    expect((await post(value, 're-quote')).status).toBe(409);
    expect(await db.sale.count({ where: { tenantId } })).toBe(0);
    expect(
      await db.customerAddress.findUniqueOrThrow({
        where: { id: address.id },
      }),
    ).toEqual(address);
  });

  it('commits and replays customer/address/actual confirmed sale/folio/stock/outbox together', async () => {
    const first = await post(body());
    expect(first.status).toBe(201);
    expect(first.body.sale).toMatchObject({
      totalCents: 10000,
      paidCents: 0,
      debtCents: 10000,
    });
    const before = await committedEffects();
    const replay = await post(body());
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(await committedEffects()).toEqual(before);
    expect(confirmation).toHaveBeenCalledTimes(1);
    expect(before).toMatchObject({
      customers: 1,
      addresses: 1,
      sales: 1,
      receipts: 1,
      outbox: 1,
      stock: 9,
    });
    expect((await status()).body).toEqual({
      status: 'succeeded',
      checkout: first.body,
    });
  });
  it('rolls back all effects after post-confirm outbox failure and permits same-key recovery', async () => {
    const baseline = await committedEffects();
    const publicBefore = (await context()).body;
    failOutbox = true;
    const failed = await post(body());
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({
      statusCode: 500,
      error: 'CHECKOUT_CREATE_FAILED',
      message: 'CHECKOUT_CREATE_FAILED',
    });
    expect(await committedEffects()).toEqual(baseline);
    expect((await context()).body).toEqual(publicBefore);
    expect((await status()).body).toEqual({
      status: 'not_observed',
      checkout: null,
    });
    expect(JSON.stringify(audit.append.mock.calls)).not.toMatch(
      /5512345678|Private Street/,
    );
    failOutbox = false;
    expect((await post(body())).status).toBe(201);
  });
  it('rolls back new records when actual sales re-quote rejects total', async () => {
    const baseline = await committedEffects();
    const value = body();
    value.sale.expectedTotalCents = 1;
    const rejected = await post(value);
    expect(rejected.status).toBe(409);
    expect(rejected.body).toEqual({
      statusCode: 409,
      error: 'PROMO_RE_QUOTE',
      message: 'PROMO_RE_QUOTE',
    });
    expect(await committedEffects()).toEqual(baseline);
    expect((await context()).body.status).toBe('not_found');
  });
  it('different concurrent keys for same phone create one customer and two sales', async () => {
    const responses = await Promise.all([
      post(body(), 'one'),
      post(body(), 'two'),
    ]);
    expect(responses.map((r) => r.status)).toEqual([201, 201]);
    expect(responses[0].body.customer.customerId).toBe(
      responses[1].body.customer.customerId,
    );
    expect(await committedEffects()).toMatchObject({
      customers: 1,
      addresses: 2,
      sales: 2,
      receipts: 2,
      outbox: 2,
      stock: 8,
    });
  });
  it('finds a POS-typed phone through every chatbot lookup without duplicating the customer', async () => {
    const pos = new CustomersService(
      new PrismaCustomerRepository(tenant),
      db as unknown as PrismaService,
      tenant,
    );
    const created = await contexts.run({ tenantId }, () =>
      pos.create({
        firstName: 'Pos',
        phoneCountryCode: '+52',
        phone: '55 8587 6245',
      }),
    );
    const lookup = await request(app.getHttpServer())
      .get(
        '/chatbot-api/customers/checkout-context?phoneCountryCode=52&phone=5585876245',
      )
      .set('Authorization', `Bearer ${token}`);
    expect(lookup.status).toBe(200);
    expect(lookup.body).toMatchObject({
      status: 'unique',
      customer: { customerId: created.id },
    });
    const byPhone = await request(app.getHttpServer())
      .get(
        '/chatbot-api/customers/by-phone?phoneCountryCode=52&phone=5585876245',
      )
      .set('Authorization', `Bearer ${token}`);
    expect(byPhone.status).toBe(200);
    expect(byPhone.body).toMatchObject({
      found: true,
      customer: {
        customerId: created.id,
        phoneCountryCode: '52',
        phone: '5585876245',
      },
    });
    const checkout = await post(
      { ...body(), phone: '5585876245' },
      'pos-phone',
    );
    expect(checkout.status).toBe(201);
    expect(checkout.body.customer).toMatchObject({
      resolution: 'existing',
      customerId: created.id,
    });
    expect(await committedEffects()).toMatchObject({ customers: 1, sales: 1 });
  });
  it('same key in progress yields safe conflict/not_observed then exact replay after commit', async () => {
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((r) => {
      entered = r;
    });
    const wait = new Promise<void>((r) => {
      release = r;
    });
    hold = { entered, wait };
    const first = post(body()).then((result) => result);
    try {
      // Fail promptly if the first request exits before reaching the latch; do not mask it as a timeout.
      await Promise.race([
        reached,
        first.then((response) => {
          throw new Error(
            `Checkout ended before latch with status ${response.status}`,
          );
        }),
      ]);
      expect((await status()).body).toEqual({
        status: 'not_observed',
        checkout: null,
      });
      const concurrent = await post(body());
      expect(concurrent.status).toBe(409);
      expect(concurrent.body).toEqual({
        statusCode: 409,
        error: 'IDEMPOTENCY_KEY_IN_FLIGHT',
        message: 'IDEMPOTENCY_KEY_IN_FLIGHT',
      });
    } finally {
      release();
    }
    const success = await first;
    expect(success.status).toBe(201);
    expect((await post(body())).body).toEqual(success.body);
    expect(confirmation).toHaveBeenCalledTimes(1);
  });
  it('includes approved freight and approval uniqueness in the same rollback boundary', async () => {
    const value = {
      ...body(),
      sale: {
        ...body().sale,
        expectedTotalCents: 10500,
        shipping: {
          chargeCents: 500,
          approvalId: 'approval-one',
          quoteId: 'quote-one',
        },
      },
    };
    const first = await post(value);
    expect(first.status).toBe(201);
    expect(first.body.sale).toMatchObject({
      subtotalCents: 10000,
      shippingChargeCents: 500,
      totalCents: 10500,
    });
    const baseline = await committedEffects();
    const replay = await post(value);
    expect(replay.body).toEqual(first.body);
    const reused = await post(value, 'different-key');
    expect(reused.status).toBe(409);
    expect(reused.body.error).toBe('SHIPPING_APPROVAL_ALREADY_USED');
    expect(await committedEffects()).toEqual(baseline);
    value.sale.shipping.quoteId = 'different-quote';
    expect((await post(value)).body.error).toBe('IDEMPOTENCY_KEY_CONFLICT');
  });
  it('rejects stale existing address, preserves saved profile/address and appends only on success', async () => {
    const customer = await db.customer.create({
      data: {
        tenantId,
        firstName: 'Saved',
        phoneCountryCode: '52',
        phone: '5512345678',
      },
    });
    const address = await db.customerAddress.create({
      data: { tenantId, customerId: customer.id, street: 'Saved Street' },
    });
    const value = {
      ...body(),
      customer: { mode: 'existing', customerId: customer.id },
      deliveryAddress: {
        mode: 'existing',
        addressId: address.id,
        expectedVersion: address.updatedAt.toISOString(),
      },
    };
    const before = (await context()).body;
    const created = await post(value);
    expect(created.status).toBe(201);
    expect((await context()).body).toEqual(before);
    await db.customerAddress.update({
      where: { id: address.id },
      data: {
        street: 'Changed Street',
        updatedAt: new Date(address.updatedAt.getTime() + 1000),
      },
    });
    const baseline = await committedEffects();
    const stale = await post(value, 'stale-key');
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('ADDRESS_VERSION_CONFLICT');
    expect(await committedEffects()).toEqual(baseline);
  });

  it('S7 gap 1: rolls back real promotion ledger/counter, stock alert and all actual outbox writes', async () => {
    const promotion = await db.promotion.create({
      data: {
        tenantId,
        title: 'Fixture capacity',
        type: 'PRODUCT_DISCOUNT',
        method: 'AUTOMATIC',
        maxProductUnits: 1,
      },
    });
    await db.product.update({
      where: { id: productId },
      data: { minQuantity: 9 },
    });
    capacityDemands = [{ promotionId: promotion.id, units: 1 }];
    const baseline = await committedEffects();
    const publicBefore = (await context()).body;
    let inside: Awaited<ReturnType<typeof committedEffects>> | undefined;
    let eventTypes: string[] = [];
    afterSaleOutbox = async () => {
      // SAFETY: ambient transaction client exposes the generated read API used by this probe.
      const tx = tenant.getClient() as unknown as Prisma.TransactionClient;
      inside = await committedEffects(tenantId, productId, tx);
      eventTypes = (
        await tx.outboxEvent.findMany({
          where: { tenantId },
          select: { eventType: true },
          orderBy: { eventType: 'asc' },
        })
      ).map((row) => row.eventType);
    };
    failOutbox = true;
    const failed = await post(body());
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({
      statusCode: 500,
      error: 'CHECKOUT_CREATE_FAILED',
      message: 'CHECKOUT_CREATE_FAILED',
    });
    // Prove those real writes occurred BEFORE failure; absence after rollback alone is not enough.
    expect(inside).toMatchObject({
      customers: 1,
      addresses: 1,
      sales: 1,
      receipts: 0,
      outbox: 3,
      stock: 9,
      promotionUsages: 1,
      promotions: [{ id: promotion.id, consumedProductUnits: 1 }],
      stockAlerts: [{ productId, alerted: true, alertEpoch: 1 }],
    });
    expect(inside?.folios).toEqual([
      { period: expect.any(String), lastNumber: 1 },
    ]);
    expect(eventTypes).toEqual([
      'promotion.near_capacity.detected',
      'sale.confirmed',
      'stock.low.detected',
    ]);
    expect(await committedEffects()).toEqual(baseline);
    expect((await context()).body).toEqual(publicBefore);
    expect((await status()).body).toEqual({
      status: 'not_observed',
      checkout: null,
    });
    expect(JSON.stringify(audit.append.mock.calls)).not.toMatch(
      /5512345678|Private Street/,
    );
    failOutbox = false;
    afterSaleOutbox = undefined;
    const success = await post(body());
    expect(success.status).toBe(201);
    const committed = await committedEffects();
    expect(committed).toMatchObject({
      customers: 1,
      addresses: 1,
      sales: 1,
      receipts: 1,
      outbox: 3,
      stock: 9,
      promotionUsages: 1,
      promotions: [{ id: promotion.id, consumedProductUnits: 1 }],
      stockAlerts: [{ productId, alerted: true, alertEpoch: 1 }],
    });
    expect((await status()).body).toEqual({
      status: 'succeeded',
      checkout: success.body,
    });
    expect((await post(body())).body).toEqual(success.body);
    expect(await committedEffects()).toEqual(committed);
  });

  it.each([
    { row: 'customer', action: 'update' },
    { row: 'customer', action: 'delete' },
    { row: 'address', action: 'update' },
    { row: 'address', action: 'delete' },
  ])(
    'S7 gap 2: holds $row row against concurrent non-advisory legacy-style $action',
    async ({ row, action }) => {
      const customer = await db.customer.create({
        data: {
          tenantId,
          firstName: 'Saved',
          phoneCountryCode: '52',
          phone: '5512345678',
        },
      });
      const address = await db.customerAddress.create({
        data: { tenantId, customerId: customer.id, street: 'Saved Street' },
      });
      const value = {
        ...body(),
        customer: { mode: 'existing', customerId: customer.id },
        deliveryAddress: {
          mode: 'existing',
          addressId: address.id,
          expectedVersion: address.updatedAt.toISOString(),
        },
      };
      const baseline = await committedEffects();
      const publicBefore = (await context()).body;
      let entered!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      hold = { entered, wait };
      const first = post(value).then((result) => result);
      const table =
        row === 'customer'
          ? Prisma.raw('customers')
          : Prisma.raw('customer_addresses');
      const id = row === 'customer' ? customer.id : address.id;
      const update =
        row === 'customer'
          ? Prisma.sql`UPDATE customers SET "firstName" = 'Legacy Changed' WHERE id = ${id} AND "tenantId" = ${tenantId}`
          : Prisma.sql`UPDATE customer_addresses SET street = 'Legacy Changed' WHERE id = ${id} AND "tenantId" = ${tenantId}`;
      const write =
        action === 'update'
          ? update
          : Prisma.sql`DELETE FROM ${table} WHERE id = ${id} AND "tenantId" = ${tenantId}`;
      try {
        await Promise.race([
          reached,
          first.then((response) => {
            throw new Error(
              `Checkout ended before row-lock latch: ${response.status}`,
            );
          }),
        ]);
        // An independent connection does not cooperate with checkout advisory locks.
        // PostgreSQL's bounded lock_timeout is the observation, not a sleep/timing guess.
        await expect(
          db.$transaction(async (tx) => {
            await tx.$executeRaw`SET LOCAL lock_timeout = '100ms'`;
            return tx.$executeRaw(write);
          }),
        ).rejects.toMatchObject({ code: 'P2010', meta: { code: '55P03' } });
        expect(await committedEffects()).toEqual(baseline);
        expect((await context()).body).toEqual(publicBefore);
        expect((await status()).body).toEqual({
          status: 'not_observed',
          checkout: null,
        });
      } finally {
        release();
      }
      const success = await first;
      expect(success.status).toBe(201);
      expect(success.body.customer).toMatchObject({
        customerId: customer.id,
        firstName: 'Saved',
      });
      expect(success.body.address).toMatchObject({
        id: address.id,
        version: address.updatedAt.toISOString(),
      });
      expect((await status()).body).toEqual({
        status: 'succeeded',
        checkout: success.body,
      });
      expect((await context()).body).toEqual(publicBefore);
      // Lock is released on commit. Do not infer delete permission/snapshot semantics from that.
      const unlocked = await db.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT id FROM ${table} WHERE id = ${id} AND "tenantId" = ${tenantId} FOR UPDATE NOWAIT`,
      );
      expect(unlocked).toEqual([{ id }]);
      expect(await committedEffects()).toMatchObject({
        customers: 1,
        addresses: 1,
        sales: 1,
        receipts: 1,
        stock: 9,
        outbox: 1,
      });
    },
  );

  it('S7 gap 3: keeps identical phone/key isolated between two dynamically authenticated tenants', async () => {
    const other = randomUUID();
    extraTenantIds.push(other);
    const otherProduct = randomUUID();
    await db.tenant.create({
      data: {
        id: other,
        name: 'Other isolated fixture',
        slug: `checkout-${other}`,
      },
    });
    const role = await db.role.create({
      data: { tenantId: other, name: 'Fixture cashier' },
    });
    await db.tenantMembership.create({
      data: { tenantId: other, userId: cashier, roleId: role.id },
    });
    await db.product.create({
      data: {
        id: otherProduct,
        tenantId: other,
        name: 'Fixture item',
        quantity: 10,
        useStock: true,
      },
    });
    await db.serviceCredential.create({
      data: {
        tenantId: other,
        name: 'Other disposable fixture',
        hashedKey: hashToken(foreignToken),
        scopes: ['customers:read', 'customers:write', 'sales:create'],
        rateLimit: 1000,
      },
    });
    const a = await post(body());
    expect(a.status).toBe(201);
    expect((await status('atomic-key', foreignToken)).body).toEqual({
      status: 'not_observed',
      checkout: null,
    });
    const value = body();
    value.sale.items[0].productId = otherProduct;
    const b = await post(value, 'atomic-key', foreignToken);
    expect(b.status).toBe(201);
    expect(b.body.customer.customerId).not.toBe(a.body.customer.customerId);
    expect(b.body.address.id).not.toBe(a.body.address.id);
    expect(b.body.sale.saleId).not.toBe(a.body.sale.saleId);
    expect((await status()).body).toEqual({
      status: 'succeeded',
      checkout: a.body,
    });
    expect((await status('atomic-key', foreignToken)).body).toEqual({
      status: 'succeeded',
      checkout: b.body,
    });
    const beforeA = await committedEffects();
    const beforeB = await committedEffects(other, otherProduct);
    const foreignCustomer = await post(
      {
        ...value,
        customer: { mode: 'existing', customerId: a.body.customer.customerId },
      },
      'foreign-customer',
      foreignToken,
    );
    expect(foreignCustomer.status).toBe(404);
    expect(foreignCustomer.body).toEqual({
      statusCode: 404,
      error: 'CUSTOMER_NOT_FOUND',
      message: 'CUSTOMER_NOT_FOUND',
    });
    const foreignAddress = await post(
      {
        ...value,
        customer: { mode: 'existing', customerId: b.body.customer.customerId },
        deliveryAddress: {
          mode: 'existing',
          addressId: a.body.address.id,
          expectedVersion: a.body.address.version,
        },
      },
      'foreign-address',
      foreignToken,
    );
    expect(foreignAddress.status).toBe(404);
    expect(foreignAddress.body).toEqual({
      statusCode: 404,
      error: 'SHIPPING_ADDRESS_NOT_FOUND',
      message: 'SHIPPING_ADDRESS_NOT_FOUND',
    });
    for (const key of ['foreign-customer', 'foreign-address'])
      expect((await status(key, foreignToken)).body).toEqual({
        status: 'not_observed',
        checkout: null,
      });
    expect(await committedEffects()).toEqual(beforeA);
    expect(await committedEffects(other, otherProduct)).toEqual(beforeB);
    expect((await post(body())).body).toEqual(a.body);
    expect((await post(value, 'atomic-key', foreignToken)).body).toEqual(
      b.body,
    );
    expect(await committedEffects()).toEqual(beforeA);
    expect(await committedEffects(other, otherProduct)).toEqual(beforeB);
  });

  it('S7 gap 3: recovers/replays a committed key after credential rotation without a new sale', async () => {
    const value = body();
    const original = await post(value);
    expect(original.status).toBe(201);
    const baseline = await committedEffects();
    expect(
      (
        await db.serviceCredential.findUniqueOrThrow({
          where: { id: credentialId },
        })
      ).lastUsedAt,
    ).toBeInstanceOf(Date);
    await db.serviceCredential.update({
      where: { id: credentialId },
      data: { isActive: false, revokedAt: new Date() },
    });
    const rotated = await db.serviceCredential.create({
      data: {
        tenantId,
        name: 'Rotated disposable fixture',
        hashedKey: hashToken(rotatedToken),
        scopes: ['customers:read', 'customers:write', 'sales:create'],
        rateLimit: 1000,
      },
    });
    expect(rotated.id).not.toBe(credentialId);
    const revoked = await post(value);
    expect(revoked.status).toBe(401);
    expect(revoked.body).toEqual({
      statusCode: 401,
      message: 'Invalid service credential',
      error: 'Unauthorized',
    });
    expect(await committedEffects()).toEqual(baseline);
    expect((await status('atomic-key', rotatedToken)).body).toEqual({
      status: 'succeeded',
      checkout: original.body,
    });
    const replay = await post(value, 'atomic-key', rotatedToken);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(original.body);
    const changed = await post(
      { ...value, customer: { mode: 'createIfAbsent', firstName: 'Changed' } },
      'atomic-key',
      rotatedToken,
    );
    expect(changed.status).toBe(409);
    expect(changed.body).toEqual({
      statusCode: 409,
      error: 'IDEMPOTENCY_KEY_CONFLICT',
      message: 'IDEMPOTENCY_KEY_CONFLICT',
    });
    expect(await committedEffects()).toEqual(baseline);
    expect(confirmation).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: 'matching success',
      receiptStatus: 'SUCCEEDED' as const,
      changedHash: false,
      expectedError: null,
    },
    {
      name: 'changed intent',
      receiptStatus: 'SUCCEEDED' as const,
      changedHash: true,
      expectedError: 'IDEMPOTENCY_KEY_CONFLICT',
    },
    {
      name: 'in-flight record',
      receiptStatus: 'IN_FLIGHT' as const,
      changedHash: false,
      expectedError: 'IDEMPOTENCY_KEY_IN_FLIGHT',
    },
  ])(
    'S7 gap 3: handles actual PostgreSQL P2002 with $name after rollback/outside-tx read',
    async ({ receiptStatus, changedHash, expectedError }) => {
      const value = body();
      const winner = await post(value, 'winner');
      expect(winner.status).toBe(201);
      const baseline = await committedEffects();
      const errors: string[] = [];
      let outsideReads = 0;
      const run: TenantPrismaService['runInTransaction'] =
        tenant.runInTransaction.bind(tenant);
      const getClient: TenantPrismaService['getClient'] =
        tenant.getClient.bind(tenant);
      jest
        .spyOn(tenant, 'runInTransaction')
        .mockImplementation(async (work, level) => {
          try {
            return await run(work, level);
          } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError)
              errors.push(error.code);
            throw error;
          }
        });
      jest.spyOn(tenant, 'getClient').mockImplementation(() => {
        if (errors.includes('P2002') && !tenant.isInTransaction())
          outsideReads++;
        return getClient();
      });
      afterSaleOutbox = async () => {
        afterSaleOutbox = undefined;
        // Deliberately non-cooperating writer: current checkout writers serialize this key,
        // so the unique-error fallback cannot be reached by two cooperating HTTP writers.
        // Insert a real, independently committed receipt referencing an actual committed sale;
        // never mock/throw P2002. The pending checkout's receipt INSERT hits the real constraint.
        await db.saleIdempotency.create({
          data: {
            tenantId,
            operation: 'bot_checkout_create',
            key: 'unique-race',
            requestHash: changedHash
              ? 'different-intent'
              : computeCheckoutRequestHash(
                  plainToInstance(CheckoutRequestDto, value),
                ),
            status: receiptStatus,
            saleId: winner.body.sale.saleId,
            responseJson: winner.body as Prisma.InputJsonValue,
          },
        });
      };
      const result = await post(value, 'unique-race');
      expect(errors).toEqual(['P2002']);
      expect(outsideReads).toBeGreaterThan(0);
      if (expectedError) {
        expect(result.status).toBe(409);
        expect(result.body).toEqual({
          statusCode: 409,
          error: expectedError,
          message: expectedError,
        });
      } else {
        expect(result.status).toBe(201);
        expect(result.body).toEqual(winner.body);
      }
      // Only the independently inserted winner receipt is new; all losing order effects rollback.
      expect(await committedEffects()).toEqual({
        ...baseline,
        receipts: baseline.receipts + 1,
      });
      expect((await status('winner')).body).toEqual({
        status: 'succeeded',
        checkout: winner.body,
      });
      expect((await status('unique-race')).body).toEqual(
        receiptStatus === 'SUCCEEDED'
          ? { status: 'succeeded', checkout: winner.body }
          : { status: 'not_observed', checkout: null },
      );
    },
  );
});
