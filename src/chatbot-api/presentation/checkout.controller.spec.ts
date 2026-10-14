/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await */
// Heterogeneous Prisma protocol fixture; real PostgreSQL proof is in the integration suite.
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ClsService } from 'nestjs-cls';
import { ConfigService } from '@nestjs/config';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { CheckoutController } from './checkout.controller';
import { CheckoutService } from '../application/checkout.service';
import { ChatbotApiController } from './chatbot-api.controller';
import { ChatbotApiService } from '../application/chatbot-api.service';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { SalesService } from '../../sales/sales.service';
import { ServiceAuthGuard } from './guards/service-auth.guard';
import { BotAuditInterceptor } from './interceptors/bot-audit.interceptor';
import { SERVICE_CREDENTIAL_REPOSITORY } from '../domain/service-credential.repository';
import { ServiceCredential } from '../domain/service-credential.entity';
import { BOT_AUDIT_LOG_REPOSITORY } from '../infrastructure/prisma-bot-audit-log.repository';
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';

const CUSTOMER = '10000000-0000-4000-8000-000000000001';
const ADDRESS = '20000000-0000-4000-8000-000000000001';
const CASHIER = '30000000-0000-4000-8000-000000000001';
const PRODUCT = '40000000-0000-4000-8000-000000000001';
const VERSION = '2026-10-13T22:00:00.000Z';
const RAW_TOKEN = 'svc_checkout-test';

type Row = Record<string, any>;
type State = {
  customers: Row[];
  addresses: Row[];
  receipts: Row[];
  sales: Row[];
  stock: number;
  folio: number;
  outbox: number;
};

/** Transactional fixture only; PostgreSQL lock/rollback proof lives in the integration spec. */
function fixture() {
  let committed: State = {
    customers: [],
    addresses: [],
    receipts: [],
    sales: [],
    stock: 10,
    folio: 0,
    outbox: 0,
  };
  const local = new AsyncLocalStorage<State>();
  let queue: Promise<unknown> = Promise.resolve();
  let serial = 0;
  const state = () => local.getStore() ?? committed;
  const match = (row: Row, where: Row = {}) =>
    Object.entries(where).every(([k, v]) => row[k] === v);
  const customer = {
    findMany: jest.fn(async ({ where, take }: Row) =>
      state()
        .customers.filter((r) => match(r, where))
        .slice(0, take),
    ),
    create: jest.fn(async ({ data }: Row) => {
      const row = { id: CUSTOMER, lastName: null, ...data };
      state().customers.push(row);
      return row;
    }),
  };
  const customerAddress = {
    findUnique: jest.fn(
      async ({ where }: Row) =>
        state().addresses.find((r) => match(r, where)) ?? null,
    ),
    create: jest.fn(async ({ data }: Row) => {
      const row = { id: ADDRESS, updatedAt: new Date(VERSION), ...data };
      state().addresses.push(row);
      return row;
    }),
  };
  const saleIdempotency = {
    findUnique: jest.fn(
      async ({ where }: Row) =>
        state().receipts.find((r) => match(r, where.tenantId_operation_key)) ??
        null,
    ),
    create: jest.fn(async ({ data }: Row) => {
      const row = { id: `receipt-${++serial}`, ...data };
      state().receipts.push(row);
      return row;
    }),
  };
  const prisma = {
    customer,
    customerAddress,
    saleIdempotency,
    tenantMembership: {
      findFirst: jest.fn(async ({ where }: Row) =>
        where.userId === CASHIER && where.tenantId === 'tenant-1'
          ? { id: 'membership' }
          : null,
      ),
    },
    $queryRaw: jest.fn(async () => [{ acquired: true }]),
  };
  const tenant = {
    getTenantId: () => 'tenant-1',
    getClient: () => prisma,
    runInTransaction: async <T>(work: () => Promise<T>): Promise<T> => {
      const run = queue.then(() =>
        local.run(structuredClone(committed), async () => {
          const result = await work();
          committed = state();
          return result;
        }),
      );
      queue = run.catch(() => undefined);
      return run;
    },
  };
  const sales = {
    confirmBotSale: jest.fn(async (input: Row) => {
      state().stock -= input.items.reduce(
        (n: number, i: Row) => n + i.quantity,
        0,
      );
      state().folio++;
      state().outbox++;
      const total =
        input.items.reduce(
          (n: number, i: Row) => n + i.quantity * i.unitPriceCents,
          0,
        ) + (input.shipping?.chargeCents ?? 0);
      const result = {
        saleId: '50000000-0000-4000-8000-000000000001',
        folio: String(state().folio),
        paymentStatus: 'CREDIT',
        channel: 'ONLINE',
        deliveryStatus: 'PENDING',
        totalCents: total,
        discountCents: 0,
        paidCents: 0,
        debtCents: total,
        confirmedAt: VERSION,
        ...(input.shipping
          ? {
              subtotalCents: total - input.shipping.chargeCents,
              shippingChargeCents: input.shipping.chargeCents,
            }
          : {}),
      };
      state().sales.push(result);
      if (total !== input.expectedTotalCents)
        throw new BusinessRuleViolationError(
          'private phone 5512345678 Example Street',
          'PROMO_RE_QUOTE',
          { private: 'Example Street' },
        );
      return result;
    }),
  };
  // Read-only existing public endpoints expose committed business observations.
  const reads = {
    getCheckoutContext: jest.fn(async () => ({
      customers: committed.customers,
      addresses: committed.addresses,
    })),
    checkStock: jest.fn(async () => ({ quantity: committed.stock })),
    getOrderHistoryByPhone: jest.fn(async () => ({ orders: committed.sales })),
  };
  return {
    prisma,
    tenant,
    sales,
    reads,
    seed: (data: Partial<State>) => {
      committed = { ...committed, ...data };
    },
  };
}

function input() {
  return {
    phoneCountryCode: '52',
    phone: '5512345678',
    customer: { mode: 'createIfAbsent', firstName: 'Ana' },
    deliveryAddress: {
      mode: 'newSaved',
      address: { street: 'Example Street' },
    },
    sale: {
      cashierUserId: CASHIER,
      items: [
        {
          productId: PRODUCT,
          productName: 'Product',
          quantity: 1,
          unitPriceCents: 10000,
        },
      ],
      expectedTotalCents: 10000,
    },
  };
}

describe('Atomic checkout public HTTP contract', () => {
  let app: INestApplication;
  let f: ReturnType<typeof fixture>;
  let scopes: string[];
  let audit: { append: jest.Mock };
  beforeEach(async () => {
    f = fixture();
    scopes = [
      'customers:write',
      'sales:create',
      'customers:read',
      'catalog:read',
    ];
    audit = { append: jest.fn().mockResolvedValue(undefined) };
    const module = await Test.createTestingModule({
      controllers: [ChatbotApiController, CheckoutController],
      providers: [
        { provide: ChatbotApiService, useValue: f.reads },
        CheckoutService,
        { provide: TenantPrismaService, useValue: f.tenant },
        { provide: SalesService, useValue: f.sales },
        { provide: ConfigService, useValue: { get: () => 50000 } },
        { provide: ClsService, useValue: { set: jest.fn() } },
        {
          provide: SERVICE_CREDENTIAL_REPOSITORY,
          useValue: {
            findByHashedKey: async () =>
              ServiceCredential.fromPersistence({
                id: 'cred',
                tenantId: 'tenant-1',
                name: 'Checkout',
                hashedKey: createHash('sha256').update(RAW_TOKEN).digest('hex'),
                scopes,
                isActive: true,
                rateLimit: 1000,
                lastUsedAt: null,
                revokedAt: null,
                createdAt: new Date(VERSION),
              }),
            touchLastUsedAt: jest.fn(),
          },
        },
        { provide: BOT_AUDIT_LOG_REPOSITORY, useValue: audit },
        ServiceAuthGuard,
        BotAuditInterceptor,
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    await app.init();
  });
  afterEach(async () => {
    await app.close();
  });
  const post = (app: INestApplication, body: object, key = 'checkout-key') =>
    request(app.getHttpServer())
      .post('/chatbot-api/checkouts')
      .set('Authorization', `Bearer ${RAW_TOKEN}`)
      .set('X-Idempotency-Key', key)
      .send(body);
  const status = (app: INestApplication, key = 'checkout-key') =>
    request(app.getHttpServer())
      .get('/chatbot-api/checkouts/status')
      .set('Authorization', `Bearer ${RAW_TOKEN}`)
      .set('X-Idempotency-Key', key);
  const read = (app: INestApplication, path: string) =>
    request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${RAW_TOKEN}`);
  const safe = (code: string, statusCode: number) => ({
    statusCode,
    error: code,
    message: code,
  });

  it('creates customer/address/sale together, then exposes only committed result', async () => {
    const response = await post(app, input());
    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      status: 'created',
      customer: {
        resolution: 'created',
        customerId: CUSTOMER,
        firstName: 'Ana',
        lastName: null,
      },
      address: { resolution: 'created', id: ADDRESS, version: VERSION },
      sale: {
        saleId: '50000000-0000-4000-8000-000000000001',
        folio: '1',
        paymentStatus: 'CREDIT',
        channel: 'ONLINE',
        deliveryStatus: 'PENDING',
        totalCents: 10000,
        discountCents: 0,
        paidCents: 0,
        debtCents: 10000,
        confirmedAt: VERSION,
      },
    });
    expect((await status(app)).body).toEqual({
      status: 'succeeded',
      checkout: response.body,
    });
    expect(f.sales.confirmBotSale).toHaveBeenCalledTimes(1);
  });
  it('rolls back even after sale side effects, leaves reads unchanged and key retryable', async () => {
    const before = (await read(app, '/chatbot-api/customers/checkout-context'))
      .body;
    const bad = input();
    bad.sale.expectedTotalCents = 1;
    const rejected = await post(app, bad);
    expect(rejected.status).toBe(409);
    expect(rejected.body).toEqual(safe('PROMO_RE_QUOTE', 409));
    expect(
      (await read(app, '/chatbot-api/customers/checkout-context')).body,
    ).toEqual(before);
    expect(
      (await read(app, `/chatbot-api/catalog/${PRODUCT}/stock`)).body,
    ).toEqual({ quantity: 10 });
    expect((await status(app)).body).toEqual({
      status: 'not_observed',
      checkout: null,
    });
    expect((await post(app, input())).status).toBe(201);
  });
  it('replays original response and rejects changed semantic intent without effects', async () => {
    const first = await post(app, input());
    expect(first.status).toBe(201);
    const replay = await post(app, input());
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    const changed = input();
    changed.customer.firstName = 'Other';
    expect((await post(app, changed)).body).toEqual(
      safe('IDEMPOTENCY_KEY_CONFLICT', 409),
    );
    expect(f.sales.confirmBotSale).toHaveBeenCalledTimes(1);
    expect(
      (await read(app, `/chatbot-api/catalog/${PRODUCT}/stock`)).body,
    ).toEqual({ quantity: 9 });
  });
  it('canonicalizes nullable omission without conflating shipping presence', async () => {
    const first = await post(app, input());
    expect(first.status).toBe(201);
    const equivalent: any = input();
    equivalent.customer.lastName = null;
    equivalent.deliveryAddress.address.label = null;
    equivalent.sale.items[0].variantId = null;
    equivalent.sale.items[0].variantName = null;
    expect((await post(app, equivalent)).body).toEqual(first.body);
    const shipping: any = input();
    shipping.sale.shipping = { chargeCents: 100, approvalId: 'approved' };
    shipping.sale.expectedTotalCents = 10100;
    expect((await post(app, shipping)).body).toEqual(
      safe('IDEMPOTENCY_KEY_CONFLICT', 409),
    );
  });
  it('preserves existing profile/address and validates selected address freshness', async () => {
    f.seed({
      customers: [
        {
          id: CUSTOMER,
          tenantId: 'tenant-1',
          phoneCountryCode: '52',
          phone: '5512345678',
          firstName: 'Saved',
          lastName: 'Person',
        },
      ],
      addresses: [
        {
          id: ADDRESS,
          tenantId: 'tenant-1',
          customerId: CUSTOMER,
          updatedAt: new Date(VERSION),
          street: 'Saved Street',
        },
      ],
    });
    const body: any = input();
    body.customer = { mode: 'existing', customerId: CUSTOMER };
    body.deliveryAddress = {
      mode: 'existing',
      addressId: ADDRESS,
      expectedVersion: VERSION,
    };
    const before = (await read(app, '/chatbot-api/customers/checkout-context'))
      .body;
    const created = await post(app, body);
    expect(created.status).toBe(201);
    expect(created.body.customer.resolution).toBe('existing');
    expect(created.body.address.resolution).toBe('existing');
    expect(
      (await read(app, '/chatbot-api/customers/checkout-context')).body,
    ).toEqual(before);
    body.deliveryAddress.expectedVersion = '2026-10-12T22:00:00.000Z';
    expect((await post(app, body, 'stale')).body).toEqual(
      safe('ADDRESS_VERSION_CONFLICT', 409),
    );
  });
  it('reuses unique existing customer without applying supplied new-profile data', async () => {
    f.seed({
      customers: [
        {
          id: CUSTOMER,
          tenantId: 'tenant-1',
          phoneCountryCode: '52',
          phone: '5512345678',
          firstName: 'Saved',
          lastName: null,
        },
      ],
    });
    const created = await post(app, input());
    expect(created.status).toBe(201);
    expect(created.body.customer).toEqual({
      resolution: 'existing',
      customerId: CUSTOMER,
      firstName: 'Saved',
      lastName: null,
    });
    expect(f.prisma.customer.create).not.toHaveBeenCalled();
  });
  it('rejects ambiguous identity without leaking other customers', async () => {
    f.seed({
      customers: [1, 2].map((n) => ({
        id: `private-${n}`,
        tenantId: 'tenant-1',
        phoneCountryCode: '52',
        phone: '5512345678',
        firstName: 'PRIVATE',
      })),
    });
    const result = await post(app, input());
    expect(result.status).toBe(409);
    expect(result.body).toEqual(safe('CUSTOMER_PHONE_AMBIGUOUS', 409));
    expect(f.sales.confirmBotSale).not.toHaveBeenCalled();
    expect((await status(app)).body).toEqual({
      status: 'not_observed',
      checkout: null,
    });
  });
  it('does not choose missing/mismatched existing identity', async () => {
    const body: any = input();
    body.customer = { mode: 'existing', customerId: CUSTOMER };
    expect((await post(app, body)).body).toEqual(
      safe('CUSTOMER_NOT_FOUND', 404),
    );
  });
  it('requires an in-tenant cashier before any business insert', async () => {
    const body = input();
    body.sale.cashierUserId = CUSTOMER;
    expect((await post(app, body)).body).toEqual(
      safe('CASHIER_NOT_FOUND', 404),
    );
    expect(f.prisma.customer.create).not.toHaveBeenCalled();
  });
  it('keeps shipping in total, response and replay hash, preserving trimmed approval intent', async () => {
    const body: any = input();
    body.sale.shipping = {
      chargeCents: 500,
      approvalId: ' approval ',
      quoteId: ' quote ',
    };
    body.sale.expectedTotalCents = 10500;
    const result = await post(app, body);
    expect(result.status).toBe(201);
    expect(result.body.sale).toMatchObject({
      subtotalCents: 10000,
      shippingChargeCents: 500,
      totalCents: 10500,
      debtCents: 10500,
    });
    expect(f.sales.confirmBotSale.mock.calls[0][0].shipping).toEqual({
      chargeCents: 500,
      approvalId: 'approval',
      quoteId: 'quote',
    });
    body.sale.shipping.approvalId = 'approval';
    body.sale.shipping.quoteId = 'quote';
    expect((await post(app, body)).body).toEqual(result.body);
    body.sale.shipping.quoteId = 'other';
    expect((await post(app, body)).body).toEqual(
      safe('IDEMPOTENCY_KEY_CONFLICT', 409),
    );
  });
  it('handles concurrent same key as one committed sale', async () => {
    const results = await Promise.all([post(app, input()), post(app, input())]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(results[0].body).toEqual(results[1].body);
    expect(f.sales.confirmBotSale).toHaveBeenCalledTimes(1);
  });
  it('different keys for same phone create one customer, two successful orders', async () => {
    const results = await Promise.all([
      post(app, input(), 'one'),
      post(app, input(), 'two'),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(f.prisma.customer.create).toHaveBeenCalledTimes(1);
    expect(f.sales.confirmBotSale).toHaveBeenCalledTimes(2);
  });
  it('returns not_observed for missing or foreign-operation receipt, never infers failure', async () => {
    f.seed({
      receipts: [
        {
          tenantId: 'tenant-1',
          operation: 'bot_sale_register',
          key: 'checkout-key',
          status: 'SUCCEEDED',
          responseJson: { private: true },
        },
      ],
    });
    const result = await status(app);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: 'not_observed', checkout: null });
  });
  it('sanitizes unexpected database/PII error on wire and audit', async () => {
    f.prisma.customer.findMany.mockRejectedValue(
      new Error('phone 5512345678 Example Street PRIVATE'),
    );
    const result = await post(app, input());
    expect(result.status).toBe(500);
    expect(result.body).toEqual(safe('CHECKOUT_CREATE_FAILED', 500));
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'checkouts.create',
        metadata: expect.objectContaining({
          statusCode: 500,
          errorMessage: 'CHECKOUT_CREATE_FAILED',
        }),
      }),
    );
    expect(JSON.stringify(audit.append.mock.calls)).not.toMatch(
      /5512345678|Example Street|PRIVATE/,
    );
  });
  it('sanitizes status read failure and records safe audit action', async () => {
    f.prisma.saleIdempotency.findUnique.mockRejectedValue(
      new Error('PRIVATE 5512345678'),
    );
    const result = await status(app);
    expect(result.status).toBe(500);
    expect(result.body).toEqual(safe('CHECKOUT_CREATE_FAILED', 500));
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'checkouts.status',
        metadata: expect.objectContaining({
          errorMessage: 'CHECKOUT_CREATE_FAILED',
        }),
      }),
    );
  });
  it.each(['customers:write', 'sales:create'])(
    'requires %s for POST and status',
    async (missing) => {
      scopes = scopes.filter((s) => s !== missing);
      expect((await post(app, input())).status).toBe(403);
      expect((await status(app)).status).toBe(403);
      expect(f.sales.confirmBotSale).not.toHaveBeenCalled();
    },
  );
  it('requires key and preserves service tenant/auth boundaries', async () => {
    expect((await post(app, input(), '')).body).toEqual(
      safe('INVALID_IDEMPOTENCY_KEY', 400),
    );
    expect(
      (
        await request(app.getHttpServer())
          .post('/chatbot-api/checkouts')
          .send(input())
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app.getHttpServer())
          .post('/chatbot-api/checkouts')
          .set('Authorization', `Bearer ${RAW_TOKEN}`)
          .set('X-Branch-Id', 'foreign')
          .set('X-Idempotency-Key', 'key')
          .send(input())
      ).status,
    ).toBe(403);
  });
  it.each([
    [
      'phone',
      (b: any) => {
        b.phone = '+551234';
      },
    ],
    [
      'country boundary',
      (b: any) => {
        b.phoneCountryCode = '1'.repeat(11);
      },
    ],
    [
      'unknown field',
      (b: any) => {
        b.tenantId = 'foreign';
      },
    ],
    [
      'mixed customer modes',
      (b: any) => {
        b.customer.customerId = CUSTOMER;
      },
    ],
    [
      'mixed address modes',
      (b: any) => {
        b.deliveryAddress.addressId = ADDRESS;
      },
    ],
    [
      'name blank',
      (b: any) => {
        b.customer.firstName = ' ';
      },
    ],
    [
      'street blank',
      (b: any) => {
        b.deliveryAddress.address.street = ' ';
      },
    ],
    [
      'expected total omitted',
      (b: any) => {
        delete b.sale.expectedTotalCents;
      },
    ],
    [
      'shipping null',
      (b: any) => {
        b.sale.shipping = null;
      },
    ],
    [
      'shipping invalid',
      (b: any) => {
        b.sale.shipping = { chargeCents: 0, approvalId: ' ' };
      },
    ],
  ])('rejects %s without reserving key or invoking sale', async (_, mutate) => {
    const body = input();
    mutate(body);
    const result = await post(app, body);
    expect(result.status).toBe(400);
    expect(result.body).toEqual(safe('INVALID_CHECKOUT_REQUEST', 400));
    expect(f.sales.confirmBotSale).not.toHaveBeenCalled();
    expect((await status(app)).body).toEqual({
      status: 'not_observed',
      checkout: null,
    });
  });
});
