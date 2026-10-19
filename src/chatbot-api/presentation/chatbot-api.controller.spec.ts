import {
  BadRequestException,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { ClsService } from 'nestjs-cls';
import { ChatbotApiController } from './chatbot-api.controller';
import { ChatbotApiService } from '../application/chatbot-api.service';
import {
  IServiceCredentialRepository,
  SERVICE_CREDENTIAL_REPOSITORY,
} from '../domain/service-credential.repository';
import { ServiceCredential } from '../domain/service-credential.entity';
import { ServiceAuthGuard } from './guards/service-auth.guard';
import { BotAuditInterceptor } from './interceptors/bot-audit.interceptor';
import { BOT_AUDIT_LOG_REPOSITORY } from '../infrastructure/prisma-bot-audit-log.repository';
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';
import { DomainExceptionFilter } from '../../shared/filters/domain-exception.filter';

function makeCredential(scopes: string[], rawToken = 'svc_valid-key') {
  return ServiceCredential.fromPersistence({
    id: 'cred-1',
    tenantId: 'tenant-1',
    name: 'Chatbot Bot',
    hashedKey: createHash('sha256').update(rawToken).digest('hex'),
    scopes,
    isActive: true,
    lastUsedAt: null,
    rateLimit: 60,
    createdAt: new Date('2026-06-11T00:00:00.000Z'),
    revokedAt: null,
  });
}

describe('ChatbotApiController', () => {
  let app: INestApplication;
  let service: {
    searchCatalog: jest.Mock;
    checkStock: jest.Mock;
    findCustomerByPhone: jest.Mock;
    getCheckoutContext: jest.Mock;
    upsertCustomerProfile: jest.Mock;
    evaluateCart: jest.Mock;
    registerBotSale: jest.Mock;
    attachReceipt: jest.Mock;
    setDeliveryMetadata: jest.Mock;
    getOrderHistoryByPhone: jest.Mock;
    cancelBotSale: jest.Mock;
    getActivePaymentDetail: jest.Mock;
  };
  let cls: { set: jest.Mock };
  let repository: jest.Mocked<IServiceCredentialRepository>;
  let auditLogs: { append: jest.Mock };

  beforeEach(async () => {
    service = {
      searchCatalog: jest.fn().mockResolvedValue([
        {
          productId: 'prod-1',
          name: 'Royal Canin Mini Adult',
          brand: 'Royal Canin',
          imageUrl: 'https://cdn.example.com/main.jpg',
          description: 'Dry food for small dogs',
          price: {
            priceCents: 259900,
            fromPriceCents: 249900,
            promoPriceCents: null,
            promotionEvaluationStatus: 'needs_human_review',
          },
          stock: { status: 'available', quantity: 12 },
          packageInfo: { weightGrams: null, dimensions: null },
          variants: [],
        },
      ]),
      checkStock: jest.fn().mockResolvedValue({
        productId: 'prod-1',
        name: 'Royal Canin Mini Adult',
        stock: { status: 'out_of_stock', quantity: 0 },
        variants: [],
      }),
      findCustomerByPhone: jest.fn().mockResolvedValue({
        found: true,
        customer: {
          customerId: 'cust-1',
          firstName: 'Ada',
          lastName: 'Lovelace',
          phoneCountryCode: '52',
          phone: '5512345678',
          preferredPaymentMethod: 'transfer',
          address: {
            id: 'addr-1',
            label: 'Home',
            street: 'Evergreen 742',
            exteriorNumber: '742',
            interiorNumber: null,
            zipCode: '01234',
            neighborhood: 'Centro',
            municipality: 'Benito Juarez',
            city: 'CDMX',
            state: 'Ciudad de México',
            visualReferences: 'Blue gate',
            carrierPhone: '5511223344',
          },
        },
      }),
      getCheckoutContext: jest.fn().mockResolvedValue({
        status: 'not_found',
        customer: null,
        addresses: [],
        nextAfterAddressId: null,
      }),
      upsertCustomerProfile: jest.fn().mockResolvedValue({
        status: 'created',
        customer: {
          customerId: 'cust-2',
          firstName: 'Ada',
          lastName: 'Lovelace',
          phoneCountryCode: '52',
          phone: '5512345678',
          preferredPaymentMethod: 'transfer',
          address: {
            id: 'addr-2',
            label: 'Home',
            street: 'Evergreen 742',
            exteriorNumber: '742',
            interiorNumber: null,
            zipCode: '01234',
            neighborhood: 'Centro',
            municipality: 'Benito Juarez',
            city: 'CDMX',
            state: 'Ciudad de México',
            visualReferences: 'Blue gate',
            carrierPhone: '5511223344',
          },
        },
      }),
      evaluateCart: jest.fn().mockResolvedValue({
        items: [
          {
            productId: 'prod-1',
            variantId: null,
            quantity: 2,
            unitPriceCents: 1000,
            originalPriceCents: 2000,
            finalPriceCents: 1800,
            appliedPromotionTitle: '10% off Royal Canin',
            discountAmountCents: 200,
          },
        ],
        promotionEvaluationStatus: 'fully_evaluated',
        customerResolution: 'not_provided',
      }),
      registerBotSale: jest.fn().mockResolvedValue({
        saleId: 'sale-bot-1',
        folio: 'BOT-0001',
        paymentStatus: 'CREDIT',
        channel: 'ONLINE',
        deliveryStatus: 'PENDING',
        totalCents: 519800,
        paidCents: 0,
        debtCents: 519800,
        confirmedAt: '2026-06-11T00:00:00.000Z',
      }),
      attachReceipt: jest.fn().mockResolvedValue({
        receiptId: 'receipt-1',
        status: 'PENDING',
      }),
      setDeliveryMetadata: jest.fn().mockResolvedValue(undefined),
      cancelBotSale: jest.fn().mockResolvedValue({
        saleId: 'sale-bot-1',
        status: 'CANCELED',
        refundedCents: 0,
        restockedItems: [{ productId: 'prod-1', variantId: null, quantity: 2 }],
        canceledAt: '2026-06-23T00:00:00.000Z',
      }),
      getActivePaymentDetail: jest.fn().mockResolvedValue({
        id: 'pd-1',
        bankName: 'BBVA',
        beneficiary: 'Tienda XYZ',
        clabe: '012345678901234567',
        accountNumber: '1234567890',
        isActive: true,
        updatedAt: '2026-08-24T12:00:00.000Z',
      }),
      getOrderHistoryByPhone: jest.fn().mockResolvedValue([
        {
          saleId: 'sale-bot-1',
          folio: 'BOT-0001',
          confirmedAt: '2026-06-11T00:00:00.000Z',
          channel: 'ONLINE',
          deliveryStatus: 'PENDING',
          paymentStatus: 'CREDIT',
          totalCents: 519800,
          paidCents: 0,
          debtCents: 519800,
          items: [
            {
              productId: 'prod-1',
              variantId: null,
              productName: 'Royal Canin Mini',
              variantName: null,
              quantity: 2,
              unitPriceCents: 259900,
            },
          ],
          payments: [],
          shippingAddress: null,
        },
      ]),
    };
    cls = { set: jest.fn() };
    auditLogs = { append: jest.fn().mockResolvedValue(undefined) };

    repository = {
      findByHashedKey: jest.fn((hashedKey: string) => {
        const validKey = createHash('sha256')
          .update('svc_valid-key')
          .digest('hex');
        const limitedKey = createHash('sha256')
          .update('svc_limited-key')
          .digest('hex');

        if (hashedKey === validKey) {
          return Promise.resolve(
            makeCredential(['catalog:read'], 'svc_valid-key'),
          );
        }

        if (hashedKey === limitedKey) {
          return Promise.resolve(
            makeCredential(['customers:read'], 'svc_limited-key'),
          );
        }

        if (
          hashedKey ===
          createHash('sha256').update('svc_write-key').digest('hex')
        ) {
          return Promise.resolve(
            makeCredential(['customers:write'], 'svc_write-key'),
          );
        }

        if (
          hashedKey ===
          createHash('sha256').update('svc_pricing-key').digest('hex')
        ) {
          return Promise.resolve(
            makeCredential(['pricing:evaluate'], 'svc_pricing-key'),
          );
        }

        if (
          hashedKey ===
          createHash('sha256').update('svc_sales-key').digest('hex')
        ) {
          return Promise.resolve(
            makeCredential(
              ['sales:create', 'sales:write', 'customers:read'],
              'svc_sales-key',
            ),
          );
        }

        // Q1 / WU1 — credential with the bot's payment-details:read scope.
        if (
          hashedKey ===
          createHash('sha256').update('svc_payment-key').digest('hex')
        ) {
          return Promise.resolve(
            makeCredential(
              ['payment-details:read', 'catalog:read'],
              'svc_payment-key',
            ),
          );
        }

        return Promise.resolve(null);
      }),
      touchLastUsedAt: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [ChatbotApiController],
      providers: [
        ServiceAuthGuard,
        BotAuditInterceptor,
        { provide: ClsService, useValue: cls },
        { provide: ChatbotApiService, useValue: service },
        { provide: SERVICE_CREDENTIAL_REPOSITORY, useValue: repository },
        { provide: BOT_AUDIT_LOG_REPOSITORY, useValue: auditLogs },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    // Register the global DomainExceptionFilter so BusinessRuleViolationError
    // surfaces as the right HTTP status (e.g. NO_ACTIVE_PAYMENT_DETAIL → 404).
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.init();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  function httpServer(): Parameters<typeof request>[0] {
    return app.getHttpServer() as Parameters<typeof request>[0];
  }

  it('GET /chatbot-api/catalog/search returns 401 without a service credential', async () => {
    await request(httpServer())
      .get('/chatbot-api/catalog/search')
      .query({ q: 'royal' })
      .expect(401);
  });

  it('GET /chatbot-api/catalog/search returns 403 for valid credentials without catalog scope', async () => {
    await request(httpServer())
      .get('/chatbot-api/catalog/search')
      .set('Authorization', 'Bearer svc_limited-key')
      .query({ q: 'royal' })
      .expect(403);
  });

  it('GET /chatbot-api/catalog/search validates query params and returns the service payload', async () => {
    await request(httpServer())
      .get('/chatbot-api/catalog/search')
      .set('Authorization', 'Bearer svc_valid-key')
      .query({ q: 'royal', limit: '5' })
      .expect(200)
      .expect(({ body }: { body: unknown }) => {
        expect(service.searchCatalog).toHaveBeenCalledWith({
          q: 'royal',
          limit: 5,
        });
        expect(body).toEqual([
          {
            productId: 'prod-1',
            name: 'Royal Canin Mini Adult',
            brand: 'Royal Canin',
            imageUrl: 'https://cdn.example.com/main.jpg',
            description: 'Dry food for small dogs',
            price: {
              priceCents: 259900,
              fromPriceCents: 249900,
              promoPriceCents: null,
              promotionEvaluationStatus: 'needs_human_review',
            },
            stock: { status: 'available', quantity: 12 },
            packageInfo: { weightGrams: null, dimensions: null },
            variants: [],
          },
        ]);
      });
  });

  it('GET /chatbot-api/catalog/search returns 400 when q is missing', async () => {
    await request(httpServer())
      .get('/chatbot-api/catalog/search')
      .set('Authorization', 'Bearer svc_valid-key')
      .expect(400);
  });

  it('GET /chatbot-api/catalog/:productId/stock validates the UUID param and returns stock payload', async () => {
    const productId = 'a8fdbf81-31ee-4f43-8739-0c70c9388d72';

    await request(httpServer())
      .get(`/chatbot-api/catalog/${productId}/stock`)
      .set('Authorization', 'Bearer svc_valid-key')
      .expect(200)
      .expect(({ body }: { body: unknown }) => {
        expect(service.checkStock).toHaveBeenCalledWith(productId);
        expect(body).toEqual({
          productId: 'prod-1',
          name: 'Royal Canin Mini Adult',
          stock: { status: 'out_of_stock', quantity: 0 },
          variants: [],
        });
      });
  });

  it('GET /chatbot-api/catalog/:productId/stock returns 400 for invalid UUIDs', async () => {
    await request(httpServer())
      .get('/chatbot-api/catalog/not-a-uuid/stock')
      .set('Authorization', 'Bearer svc_valid-key')
      .expect(400);
  });

  it('GET /chatbot-api/customers/by-phone validates query params and returns the customer payload', async () => {
    await request(httpServer())
      .get('/chatbot-api/customers/by-phone')
      .set('Authorization', 'Bearer svc_limited-key')
      .query({ phoneCountryCode: '+52', phone: '55 1234 5678' })
      .expect(200)
      .expect(({ body }: { body: unknown }) => {
        const response = body as {
          found: boolean;
          customer: { customerId: string };
        };
        expect(service.findCustomerByPhone).toHaveBeenCalledWith({
          phoneCountryCode: '+52',
          phone: '55 1234 5678',
        });
        expect(response.found).toBe(true);
        expect(response.customer.customerId).toBe('cust-1');
      });
  });

  it('GET /chatbot-api/customers/by-phone returns 400 when the phone query is missing', async () => {
    await request(httpServer())
      .get('/chatbot-api/customers/by-phone')
      .set('Authorization', 'Bearer svc_limited-key')
      .query({ phoneCountryCode: '+52' })
      .expect(400);
  });

  describe('GET /chatbot-api/customers/checkout-context', () => {
    const route = '/chatbot-api/customers/checkout-context';
    const phoneQuery = { phoneCountryCode: '52', phone: '5512345678' };

    it.each(['not_found', 'unique', 'ambiguous'])(
      'returns the exact %s envelope with default pagination and audit telemetry',
      async (status) => {
        const result = {
          status,
          customer:
            status === 'unique'
              ? { customerId: 'cust-1', firstName: 'Ada', lastName: null }
              : null,
          addresses: [],
          nextAfterAddressId: null,
        };
        service.getCheckoutContext.mockResolvedValue(result);
        await request(httpServer())
          .get(route)
          .set('Authorization', 'Bearer svc_limited-key')
          .query(phoneQuery)
          .expect(200)
          .expect(result);
        expect(service.getCheckoutContext.mock.calls).toEqual([
          [
            {
              ...phoneQuery,
              limit: 10,
              afterAddressId: undefined,
            },
          ],
        ]);
        expect(cls.set).toHaveBeenCalledWith('tenantId', 'tenant-1');
        expect(repository.touchLastUsedAt.mock.calls).toEqual([['cred-1']]);
        expect(auditLogs.append.mock.calls).toEqual([
          [
            {
              tenantId: 'tenant-1',
              credentialId: 'cred-1',
              action: 'customers.checkout_context',
              resourceType: 'customer',
              resourceId: null,
              metadata: {
                branchId: 'tenant-1',
                httpMethod: 'GET',
                routePath: route,
                statusCode: 200,
                outcome: 'success',
              },
            },
          ],
        ]);
        expect(service.upsertCustomerProfile).not.toHaveBeenCalled();
        expect(service.registerBotSale).not.toHaveBeenCalled();
      },
    );

    it('forwards an explicit owned cursor and maximum limit', async () => {
      const afterAddressId = 'a8fdbf81-31ee-4f43-8739-0c70c9388d72';
      await request(httpServer())
        .get(route)
        .set('Authorization', 'Bearer svc_limited-key')
        .query({ ...phoneQuery, limit: '20', afterAddressId })
        .expect(200);
      expect(service.getCheckoutContext).toHaveBeenCalledWith({
        ...phoneQuery,
        limit: 20,
        afterAddressId,
      });
    });

    it.each([
      {},
      { phone: '5512345678' },
      { phoneCountryCode: '52' },
      { ...phoneQuery, phone: '' },
      { ...phoneQuery, phone: '+5512345678' },
      { ...phoneQuery, phone: '5'.repeat(21) },
      { ...phoneQuery, phoneCountryCode: '5'.repeat(11) },
      { ...phoneQuery, phoneCountryCode: '+52' },
      { ...phoneQuery, limit: '0' },
      { ...phoneQuery, limit: '21' },
      { ...phoneQuery, limit: '1.5' },
      { ...phoneQuery, limit: '' },
      { ...phoneQuery, limit: 'NaN' },
      { ...phoneQuery, afterAddressId: '' },
      { ...phoneQuery, afterAddressId: 'invalid' },
      { ...phoneQuery, tenantId: 'foreign' },
      { ...phoneQuery, customerId: 'foreign' },
    ])('rejects malformed input without business calls: %j', async (query) => {
      await request(httpServer())
        .get(route)
        .set('Authorization', 'Bearer svc_limited-key')
        .query(query)
        .expect(400);
      expect(service.getCheckoutContext).not.toHaveBeenCalled();
      expect(service.upsertCustomerProfile).not.toHaveBeenCalled();
      expect(service.registerBotSale).not.toHaveBeenCalled();
      const auditCalls = auditLogs.append.mock.calls as unknown[][];
      expect(auditCalls[0]?.[0]).toMatchObject({
        action: 'customers.checkout_context',
        metadata: { statusCode: 400, outcome: 'error' },
      });
    });

    it.each([
      [undefined, undefined, 401],
      ['Bearer svc_valid-key', undefined, 403],
      ['Bearer svc_limited-key', 'other-tenant', 403],
    ])(
      'preserves auth/tenant rejection (%s, %s)',
      async (token, branch, status) => {
        const call = request(httpServer()).get(route).query(phoneQuery);
        if (token) call.set('Authorization', token);
        if (branch) call.set('X-Branch-Id', branch);
        await call.expect(status);
        expect(service.getCheckoutContext).not.toHaveBeenCalled();
        expect(repository.touchLastUsedAt.mock.calls).toEqual([]);
        expect(auditLogs.append).not.toHaveBeenCalled();
      },
    );

    it('returns a scoped cursor error without converting failure to customer absence', async () => {
      service.getCheckoutContext.mockRejectedValue(
        new BadRequestException({
          statusCode: 400,
          error: 'INVALID_ADDRESS_CURSOR',
          message: 'INVALID_ADDRESS_CURSOR',
        }),
      );
      await request(httpServer())
        .get(route)
        .set('Authorization', 'Bearer svc_limited-key')
        .query(phoneQuery)
        .expect(400)
        .expect(({ body }: { body: { error: string } }) => {
          expect(body.error).toBe('INVALID_ADDRESS_CURSOR');
        });
      const auditCalls = auditLogs.append.mock.calls as unknown[][];
      expect(auditCalls[0]?.[0]).toMatchObject({
        metadata: { statusCode: 400, outcome: 'error' },
      });
    });

    // S6 privacy correction — a raw read failure can carry sender phone or
    // saved-address text (driver/ORM message). The public new route must not
    // echo it on the wire or into audit.errorMessage, and must stay a failure
    // (safe 500), never a fabricated not_found. This exercises the real
    // `ChatbotApiService` with a mock tenant client, not a hand-made rejection.
    it.each(['customer', 'address', 'cursor'] as const)(
      'sanitizes a %s read failure carrying phone/address text into a safe 500 and safe audit errorMessage',
      async (stage) => {
        const sensitivePhone = phoneQuery.phone;
        const sensitiveStreet = 'Evergreen 742';
        const leak = `read failed phone=${sensitivePhone} street=${sensitiveStreet}`;
        const customerRow = { id: 'cust-1', firstName: 'Ada', lastName: null };
        const customerState = structuredClone(customerRow);
        const addressState = structuredClone([
          {
            id: 'a8fdbf81-31ee-4f43-8739-0c70c9388d72',
            updatedAt: new Date('2026-10-12T00:00:00.000Z'),
            street: sensitiveStreet,
          },
        ]);

        const readClient = {
          customer: { findMany: jest.fn().mockResolvedValue([customerRow]) },
          customerAddress: {
            findFirst: jest.fn().mockResolvedValue({
              id: 'a8fdbf81-31ee-4f43-8739-0c70c9388d72',
              createdAt: new Date('2026-01-01T00:00:00.000Z'),
            }),
            findMany: jest.fn().mockResolvedValue([]),
          },
        };
        const failure = new Error(leak);
        if (stage === 'customer') {
          readClient.customer.findMany.mockRejectedValue(failure);
        } else if (stage === 'address') {
          readClient.customerAddress.findMany.mockRejectedValue(failure);
        } else {
          readClient.customerAddress.findFirst.mockRejectedValue(failure);
        }

        const realService = new ChatbotApiService(
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          {
            getTenantId: () => 'tenant-1',
            getClient: () => readClient,
          } as never,
          {} as never,
        );
        service.getCheckoutContext.mockImplementation(
          (input: Parameters<ChatbotApiService['getCheckoutContext']>[0]) =>
            realService.getCheckoutContext(input),
        );

        const response = await request(httpServer())
          .get(route)
          .set('Authorization', 'Bearer svc_limited-key')
          .query(
            stage === 'cursor'
              ? {
                  ...phoneQuery,
                  afterAddressId: 'a8fdbf81-31ee-4f43-8739-0c70c9388d72',
                }
              : phoneQuery,
          );

        const auditCalls = auditLogs.append.mock.calls as unknown[][];
        expect(auditCalls).toHaveLength(1);
        const auditEntry = auditCalls[0][0] as {
          action: string;
          metadata: {
            statusCode: number;
            outcome: string;
            errorMessage?: string;
          };
        };
        expect(auditEntry.action).toBe('customers.checkout_context');
        expect(auditEntry.metadata.errorMessage).toBe(
          'CHECKOUT_CONTEXT_READ_FAILED',
        );
        expect(auditEntry.metadata).toMatchObject({
          statusCode: 500,
          outcome: 'error',
        });
        expect(JSON.stringify(auditEntry)).not.toContain(sensitivePhone);
        expect(JSON.stringify(auditEntry)).not.toContain(sensitiveStreet);

        expect(response.status).toBe(500);
        expect(response.body).toEqual({
          statusCode: 500,
          error: 'CHECKOUT_CONTEXT_READ_FAILED',
          message: 'CHECKOUT_CONTEXT_READ_FAILED',
        });
        expect(JSON.stringify(response.body)).not.toContain(sensitivePhone);
        expect(JSON.stringify(response.body)).not.toContain(sensitiveStreet);

        // Failure stays a failure; no read is converted into a synthetic
        // absence and no business write happens.
        expect(readClient.customer.findMany).toHaveBeenCalledTimes(1);
        expect(customerRow).toEqual(customerState);
        expect(addressState).toEqual([
          {
            id: 'a8fdbf81-31ee-4f43-8739-0c70c9388d72',
            updatedAt: new Date('2026-10-12T00:00:00.000Z'),
            street: sensitiveStreet,
          },
        ]);
        expect(service.upsertCustomerProfile).not.toHaveBeenCalled();
        expect(service.registerBotSale).not.toHaveBeenCalled();
      },
    );
  });

  it('PUT /chatbot-api/customers/by-phone requires customers:write scope', async () => {
    await request(httpServer())
      .put('/chatbot-api/customers/by-phone')
      .set('Authorization', 'Bearer svc_limited-key')
      .send({
        firstName: 'Ada',
        phoneCountryCode: '+52',
        phone: '55 1234 5678',
        address: { street: 'Evergreen 742' },
      })
      .expect(403);
  });

  it('PUT /chatbot-api/customers/by-phone validates the body and returns the upsert payload', async () => {
    await request(httpServer())
      .put('/chatbot-api/customers/by-phone')
      .set('Authorization', 'Bearer svc_write-key')
      .send({
        firstName: 'Ada',
        lastName: 'Lovelace',
        phoneCountryCode: '+52',
        phone: '55 1234 5678',
        preferredPaymentMethod: 'transfer',
        address: {
          label: 'Home',
          street: 'Evergreen 742',
          exteriorNumber: '742',
          zipCode: '01234',
          neighborhood: 'Centro',
          municipality: 'Benito Juarez',
          city: 'CDMX',
          state: 'Ciudad de México',
          visualReferences: 'Blue gate',
          carrierPhone: '55 11 22 33 44',
        },
      })
      .expect(200)
      .expect(({ body }: { body: unknown }) => {
        const response = body as {
          status: string;
          customer: { customerId: string };
        };
        expect(service.upsertCustomerProfile).toHaveBeenCalledWith({
          firstName: 'Ada',
          lastName: 'Lovelace',
          phoneCountryCode: '+52',
          phone: '55 1234 5678',
          preferredPaymentMethod: 'transfer',
          address: {
            label: 'Home',
            street: 'Evergreen 742',
            exteriorNumber: '742',
            zipCode: '01234',
            neighborhood: 'Centro',
            municipality: 'Benito Juarez',
            city: 'CDMX',
            state: 'Ciudad de México',
            visualReferences: 'Blue gate',
            carrierPhone: '55 11 22 33 44',
          },
        });
        expect(response.status).toBe('created');
        expect(response.customer.customerId).toBe('cust-2');
      });
  });

  it('POST /chatbot-api/pricing/evaluate-cart requires pricing:evaluate scope', async () => {
    await request(httpServer())
      .post('/chatbot-api/pricing/evaluate-cart')
      .set('Authorization', 'Bearer svc_valid-key')
      .send({
        items: [
          {
            productId: 'a8fdbf81-31ee-4f43-8739-0c70c9388d72',
            quantity: 2,
            unitPriceCents: 1000,
          },
        ],
      })
      .expect(403);
  });

  it('POST /chatbot-api/pricing/evaluate-cart validates the payload and returns pricing status', async () => {
    await request(httpServer())
      .post('/chatbot-api/pricing/evaluate-cart')
      .set('Authorization', 'Bearer svc_pricing-key')
      .send({
        items: [
          {
            productId: 'a8fdbf81-31ee-4f43-8739-0c70c9388d72',
            quantity: 2,
            unitPriceCents: 1000,
          },
        ],
      })
      .expect(201)
      .expect(({ body }: { body: unknown }) => {
        expect(service.evaluateCart).toHaveBeenCalledWith({
          items: [
            {
              productId: 'a8fdbf81-31ee-4f43-8739-0c70c9388d72',
              variantId: null,
              quantity: 2,
              unitPriceCents: 1000,
            },
          ],
        });
        expect(body).toEqual({
          items: [
            {
              productId: 'prod-1',
              variantId: null,
              quantity: 2,
              unitPriceCents: 1000,
              originalPriceCents: 2000,
              finalPriceCents: 1800,
              appliedPromotionTitle: '10% off Royal Canin',
              discountAmountCents: 200,
            },
          ],
          promotionEvaluationStatus: 'fully_evaluated',
          customerResolution: 'not_provided',
        });
      });
  });

  it.each([
    { phoneCountryCode: '52' },
    { phone: '5512345678' },
    { phoneCountryCode: '+52', phone: '5512345678' },
  ])(
    'rejects invalid pricing phone pairs with the standard DTO error: %j',
    async (phone) => {
      const response = await request(httpServer())
        .post('/chatbot-api/pricing/evaluate-cart')
        .set('Authorization', 'Bearer svc_pricing-key')
        .send({
          ...phone,
          items: [
            {
              productId: 'a8fdbf81-31ee-4f43-8739-0c70c9388d72',
              quantity: 1,
              unitPriceCents: 1000,
            },
          ],
        })
        .expect(400);
      expect(response.body).toMatchObject({
        statusCode: 400,
        error: 'Bad Request',
        message: expect.any(Array) as unknown[],
      });
      expect(service.evaluateCart).not.toHaveBeenCalled();
    },
  );

  it('forwards the pricing customer pair and returns the backend price unchanged', async () => {
    service.evaluateCart.mockResolvedValue({
      items: [
        {
          productId: 'a8fdbf81-31ee-4f43-8739-0c70c9388d72',
          variantId: null,
          quantity: 1,
          unitPriceCents: 800,
          originalPriceCents: 800,
          finalPriceCents: 640,
          discountAmountCents: 160,
          appliedPromotionTitle: '20% off',
        },
      ],
      promotionEvaluationStatus: 'fully_evaluated',
      customerResolution: 'unique',
    });
    const response = await request(httpServer())
      .post('/chatbot-api/pricing/evaluate-cart')
      .set('Authorization', 'Bearer svc_pricing-key')
      .send({
        phoneCountryCode: '052',
        phone: '05512345678',
        items: [
          {
            productId: 'a8fdbf81-31ee-4f43-8739-0c70c9388d72',
            quantity: 1,
            unitPriceCents: 7,
          },
        ],
      })
      .expect(201);
    expect(response.body).toMatchObject({
      customerResolution: 'unique',
      items: [
        {
          unitPriceCents: 800,
          originalPriceCents: 800,
          finalPriceCents: 640,
          discountAmountCents: 160,
        },
      ],
    });
    expect(service.evaluateCart).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneCountryCode: '052',
        phone: '05512345678',
      }),
    );
  });

  it('POST /chatbot-api/pricing/evaluate-cart returns 400 for invalid item payloads', async () => {
    await request(httpServer())
      .post('/chatbot-api/pricing/evaluate-cart')
      .set('Authorization', 'Bearer svc_pricing-key')
      .send({
        items: [
          {
            productId: 'not-a-uuid',
            quantity: 0,
            unitPriceCents: -1,
          },
        ],
      })
      .expect(400);
  });

  // ── Bot Sale Routes (Slice 6) ────────────────────────────────────────────────

  const saleId = 'a8fdbf81-31ee-4f43-8739-0c70c9388d72';
  const cashierUserId = 'b1fdbf81-31ee-4f43-8739-0c70c9388d72';
  const customerId = 'c2fdbf81-31ee-4f43-8739-0c70c9388d72';

  const validBotSalePayload = {
    cashierUserId,
    customerId,
    items: [
      {
        productId: 'a8fdbf81-31ee-4f43-8739-0c70c9388d72',
        productName: 'Royal Canin Mini',
        quantity: 2,
        unitPriceCents: 259900,
      },
    ],
  };

  it('POST /chatbot-api/sales returns 401 without credentials', async () => {
    await request(httpServer())
      .post('/chatbot-api/sales')
      .send(validBotSalePayload)
      .expect(401);
  });

  it('POST /chatbot-api/sales returns 403 for credentials missing sales:create scope', async () => {
    await request(httpServer())
      .post('/chatbot-api/sales')
      .set('Authorization', 'Bearer svc_valid-key')
      .send(validBotSalePayload)
      .expect(403);
  });

  it('POST /chatbot-api/sales creates a bot sale and returns the response', async () => {
    await request(httpServer())
      .post('/chatbot-api/sales')
      .set('Authorization', 'Bearer svc_sales-key')
      .set('X-Idempotency-Key', 'bot-order-abc-123')
      .send(validBotSalePayload)
      .expect(201)
      .expect(({ body }: { body: unknown }) => {
        expect(service.registerBotSale).toHaveBeenCalledWith(
          expect.objectContaining({
            cashierUserId,
            customerId,
            idempotencyKey: 'bot-order-abc-123',
          }),
        );
        expect(body).toEqual(
          expect.objectContaining({
            saleId: 'sale-bot-1',
            paymentStatus: 'CREDIT',
            channel: 'ONLINE',
          }),
        );
      });
  });

  it('POST /chatbot-api/sales forwards validated shipping to the service gate', async () => {
    service.registerBotSale.mockResolvedValueOnce({
      saleId: 'sale-shipping-1',
      subtotalCents: 2000,
      discountCents: 200,
      shippingChargeCents: 2500,
      totalCents: 4300,
      debtCents: 4300,
    });
    await request(httpServer())
      .post('/chatbot-api/sales')
      .set('Authorization', 'Bearer svc_sales-key')
      .set('X-Idempotency-Key', 'bot-shipping-approved')
      .send({
        ...validBotSalePayload,
        shippingAddressId: 'cf070bfb-ee86-460b-ab8a-7893d324e346',
        shipping: {
          chargeCents: 2500,
          approvalId: 'approval-1',
          quoteId: 'quote-1',
        },
        expectedTotalCents: 4300,
      })
      .expect(201)
      .expect(
        ({
          body,
        }: {
          body: { shippingChargeCents?: number; totalCents?: number };
        }) => {
          expect(body.shippingChargeCents).toBe(2500);
          expect(body.totalCents).toBe(4300);
        },
      );
    expect(service.registerBotSale).toHaveBeenCalledWith(
      expect.objectContaining({
        shipping: {
          chargeCents: 2500,
          approvalId: 'approval-1',
          quoteId: 'quote-1',
        },
        shippingAddressId: 'cf070bfb-ee86-460b-ab8a-7893d324e346',
        expectedTotalCents: 4300,
      }),
    );
  });

  it('POST /chatbot-api/sales propagates a disabled shipping gate without creating a sale', async () => {
    service.registerBotSale.mockRejectedValueOnce(
      new BusinessRuleViolationError(
        'Shipping charge is not available',
        'SHIPPING_CHARGE_UNAVAILABLE',
      ),
    );
    await request(httpServer())
      .post('/chatbot-api/sales')
      .set('Authorization', 'Bearer svc_sales-key')
      .set('X-Idempotency-Key', 'bot-shipping-dormant')
      .send({
        ...validBotSalePayload,
        shipping: { chargeCents: 2500, approvalId: 'approval-1' },
      })
      .expect(422)
      .expect(({ body }: { body: { error?: string } }) => {
        expect(body.error).toBe('SHIPPING_CHARGE_UNAVAILABLE');
      });
  });

  it('POST /chatbot-api/sales validates nested shipping fields before the gate', async () => {
    await request(httpServer())
      .post('/chatbot-api/sales')
      .set('Authorization', 'Bearer svc_sales-key')
      .set('X-Idempotency-Key', 'bot-shipping-invalid')
      .send({
        ...validBotSalePayload,
        shipping: { chargeCents: -5, approvalId: '' },
      })
      .expect(400);
    expect(service.registerBotSale).not.toHaveBeenCalled();
  });

  it.each([
    { chargeCents: 2500, approvalId: '   ' },
    { chargeCents: 2500, approvalId: 'approval-1', quoteId: null },
  ])(
    'POST /chatbot-api/sales rejects malformed shipping identity %j',
    async (shipping) => {
      await request(httpServer())
        .post('/chatbot-api/sales')
        .set('Authorization', 'Bearer svc_sales-key')
        .set('X-Idempotency-Key', 'bot-shipping-invalid-identity')
        .send({ ...validBotSalePayload, shipping })
        .expect(400);
      expect(service.registerBotSale).not.toHaveBeenCalled();
    },
  );

  it('POST /chatbot-api/sales returns 400 for invalid payload', async () => {
    await request(httpServer())
      .post('/chatbot-api/sales')
      .set('Authorization', 'Bearer svc_sales-key')
      .set('X-Idempotency-Key', 'bot-order-abc-123')
      .send({ cashierUserId: 'not-a-uuid', customerId: '', items: [] })
      .expect(400);
  });

  it('POST /chatbot-api/sales returns 400 when items is an empty array', async () => {
    await request(httpServer())
      .post('/chatbot-api/sales')
      .set('Authorization', 'Bearer svc_sales-key')
      .set('X-Idempotency-Key', 'bot-order-abc-124')
      .send({
        cashierUserId: '7d880665-5aa5-4cbc-b273-3fe1a2df2b54',
        customerId: 'c0a97789-c50c-4e30-9915-65c44837a50e',
        shippingAddressId: 'cf070bfb-ee86-460b-ab8a-7893d324e346',
        items: [],
      })
      .expect(400)
      .expect(({ body }: { body: { message?: string[] } }) => {
        expect(body.message).toEqual(
          expect.arrayContaining(['items must contain at least 1 elements']),
        );
      });
  });

  // ── Q3 / WU2 — X-Idempotency-Key pipe rejects before any DB read ─────

  it('POST /chatbot-api/sales returns 400 INVALID_IDEMPOTENCY_KEY when the header is missing', async () => {
    await request(httpServer())
      .post('/chatbot-api/sales')
      .set('Authorization', 'Bearer svc_sales-key')
      .send(validBotSalePayload)
      .expect(400)
      .expect(({ body }: { body: { error?: string; message?: string } }) => {
        // InvalidArgumentError → DomainExceptionFilter → 400 with code in
        // `error` and human-readable message in `message`. The header
        // arrives as `undefined` (not a string), which the pipe rejects
        // with the "must be a string" message — both branches still
        // produce `INVALID_IDEMPOTENCY_KEY` so the wire contract is
        // uniform.
        expect(body.error).toBe('INVALID_IDEMPOTENCY_KEY');
        expect(body.message).toMatch(/idempotency key/i);
      });
    // CRITICAL: pipe runs BEFORE the service is invoked, so the bot
    // service's registerBotSale is never called (no DB read).
    expect(service.registerBotSale).not.toHaveBeenCalled();
  });

  it('POST /chatbot-api/sales returns 400 INVALID_IDEMPOTENCY_KEY when the header is empty', async () => {
    await request(httpServer())
      .post('/chatbot-api/sales')
      .set('Authorization', 'Bearer svc_sales-key')
      .set('X-Idempotency-Key', '')
      .send(validBotSalePayload)
      .expect(400)
      .expect(({ body }: { body: { error?: string } }) => {
        expect(body.error).toBe('INVALID_IDEMPOTENCY_KEY');
      });
    expect(service.registerBotSale).not.toHaveBeenCalled();
  });

  it('POST /chatbot-api/sales returns 400 INVALID_IDEMPOTENCY_KEY when the header is whitespace only', async () => {
    await request(httpServer())
      .post('/chatbot-api/sales')
      .set('Authorization', 'Bearer svc_sales-key')
      .set('X-Idempotency-Key', '   ')
      .send(validBotSalePayload)
      .expect(400)
      .expect(({ body }: { body: { error?: string } }) => {
        expect(body.error).toBe('INVALID_IDEMPOTENCY_KEY');
      });
    expect(service.registerBotSale).not.toHaveBeenCalled();
  });

  it('POST /chatbot-api/sales returns 400 INVALID_IDEMPOTENCY_KEY when the key exceeds 200 characters', async () => {
    const oversized = 'a'.repeat(201);
    await request(httpServer())
      .post('/chatbot-api/sales')
      .set('Authorization', 'Bearer svc_sales-key')
      .set('X-Idempotency-Key', oversized)
      .send(validBotSalePayload)
      .expect(400)
      .expect(({ body }: { body: { error?: string; message?: string } }) => {
        expect(body.error).toBe('INVALID_IDEMPOTENCY_KEY');
        expect(body.message).toMatch(/maximum length of 200 characters/i);
      });
    expect(service.registerBotSale).not.toHaveBeenCalled();
  });

  it('POST /chatbot-api/sales forwards the trimmed idempotency key to the service (whitespace trimmed away)', async () => {
    await request(httpServer())
      .post('/chatbot-api/sales')
      .set('Authorization', 'Bearer svc_sales-key')
      .set('X-Idempotency-Key', '  bot-order-abc-trimmed  ')
      .send(validBotSalePayload)
      .expect(201)
      .expect(({ body }: { body: unknown }) => {
        expect(service.registerBotSale).toHaveBeenCalledWith(
          expect.objectContaining({
            idempotencyKey: 'bot-order-abc-trimmed',
          }),
        );
        expect(body).toEqual(
          expect.objectContaining({
            saleId: 'sale-bot-1',
            paymentStatus: 'CREDIT',
            channel: 'ONLINE',
          }),
        );
      });
  });

  it('POST /chatbot-api/sales/:saleId/receipts attaches a receipt and returns PENDING status', async () => {
    await request(httpServer())
      .post(`/chatbot-api/sales/${saleId}/receipts`)
      .set('Authorization', 'Bearer svc_sales-key')
      .send({
        mediaUrl: 'https://cdn.example.com/receipts/transfer.jpg',
        declaredAmountCents: 519800,
        declaredReference: 'TRF-99887',
      })
      .expect(201)
      .expect(({ body }: { body: unknown }) => {
        expect(service.attachReceipt).toHaveBeenCalledWith(
          expect.objectContaining({
            saleId,
            mediaUrl: 'https://cdn.example.com/receipts/transfer.jpg',
            declaredAmountCents: 519800,
          }),
        );
        expect(body).toEqual({ receiptId: 'receipt-1', status: 'PENDING' });
      });
  });

  it('PATCH /chatbot-api/sales/:saleId/delivery updates delivery metadata', async () => {
    await request(httpServer())
      .patch(`/chatbot-api/sales/${saleId}/delivery`)
      .set('Authorization', 'Bearer svc_sales-key')
      .send({
        carrierName: 'DHL',
        trackingRef: 'DHL-1234567890',
        estimatedDeliveryAt: '2026-06-20T00:00:00.000Z',
      })
      .expect(200)
      .expect(({ body }: { body: unknown }) => {
        expect(service.setDeliveryMetadata).toHaveBeenCalledWith(
          expect.objectContaining({
            saleId,
            carrierName: 'DHL',
            trackingRef: 'DHL-1234567890',
          }),
        );
        expect(body).toEqual({});
      });
  });

  it('GET /chatbot-api/customers/by-phone/:phone/orders returns order history', async () => {
    await request(httpServer())
      .get('/chatbot-api/customers/by-phone/5512345678/orders')
      .set('Authorization', 'Bearer svc_sales-key')
      .query({ phoneCountryCode: '52' })
      .expect(200)
      .expect(({ body }: { body: unknown }) => {
        expect(service.getOrderHistoryByPhone).toHaveBeenCalledWith(
          expect.objectContaining({
            phone: '5512345678',
            phoneCountryCode: '52',
          }),
        );
        expect(Array.isArray(body)).toBe(true);
        expect((body as unknown[]).length).toBeGreaterThan(0);
      });
  });

  // ── D.2.1 Bot cancel route ────────────────────────────────────────────────

  it('POST /chatbot-api/sales/:saleId/cancel returns 401 without credentials', async () => {
    await request(httpServer())
      .post(`/chatbot-api/sales/${saleId}/cancel`)
      .send({ reason: 'CUSTOMER_REQUEST', cashierUserId: cashierUserId })
      .expect(401);
  });

  it('POST /chatbot-api/sales/:saleId/cancel returns 403 for credentials missing sales:write scope', async () => {
    await request(httpServer())
      .post(`/chatbot-api/sales/${saleId}/cancel`)
      .set('Authorization', 'Bearer svc_valid-key')
      .send({ reason: 'CUSTOMER_REQUEST', cashierUserId: cashierUserId })
      .expect(403);
  });

  it('POST /chatbot-api/sales/:saleId/cancel cancels the sale and returns the result', async () => {
    await request(httpServer())
      .post(`/chatbot-api/sales/${saleId}/cancel`)
      .set('Authorization', 'Bearer svc_sales-key')
      .send({ reason: 'CUSTOMER_REQUEST', cashierUserId: cashierUserId })
      .expect(200)
      .expect(({ body }: { body: unknown }) => {
        expect(service.cancelBotSale).toHaveBeenCalledWith({
          saleId,
          reason: 'CUSTOMER_REQUEST',
          cashierUserId,
        });
        expect(body).toEqual(
          expect.objectContaining({
            saleId: 'sale-bot-1',
            status: 'CANCELED',
          }),
        );
      });
  });

  it('POST /chatbot-api/sales/:saleId/cancel returns 400 for invalid reason', async () => {
    await request(httpServer())
      .post(`/chatbot-api/sales/${saleId}/cancel`)
      .set('Authorization', 'Bearer svc_sales-key')
      .send({ reason: 'INVALID_REASON', cashierUserId: cashierUserId })
      .expect(400);
  });

  it('POST /chatbot-api/sales/:saleId/cancel returns 400 for missing cashierUserId', async () => {
    await request(httpServer())
      .post(`/chatbot-api/sales/${saleId}/cancel`)
      .set('Authorization', 'Bearer svc_sales-key')
      .send({ reason: 'CUSTOMER_REQUEST' })
      .expect(400);
  });

  // ── Q1 / WU1 — GET /chatbot-api/payment-details ────────────────────────

  it('GET /chatbot-api/payment-details returns 200 for a credential with payment-details:read', async () => {
    await request(httpServer())
      .get('/chatbot-api/payment-details')
      .set('Authorization', 'Bearer svc_payment-key')
      .expect(200)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toEqual({
          id: 'pd-1',
          bankName: 'BBVA',
          beneficiary: 'Tienda XYZ',
          clabe: '012345678901234567',
          accountNumber: '1234567890',
          isActive: true,
          updatedAt: '2026-08-24T12:00:00.000Z',
        });
      });
    expect(service.getActivePaymentDetail).toHaveBeenCalledTimes(1);
  });

  it('GET /chatbot-api/payment-details returns 403 for a credential without payment-details:read', async () => {
    // svc_valid-key only has catalog:read — the method-level override
    // requires payment-details:read, so the scope check fails (D3).
    await request(httpServer())
      .get('/chatbot-api/payment-details')
      .set('Authorization', 'Bearer svc_valid-key')
      .expect(403);
    expect(service.getActivePaymentDetail).not.toHaveBeenCalled();
  });

  it('GET /chatbot-api/payment-details returns 404 NO_ACTIVE_PAYMENT_DETAIL', async () => {
    service.getActivePaymentDetail.mockRejectedValueOnce(
      new BusinessRuleViolationError(
        'No active payment detail for tenant',
        'NO_ACTIVE_PAYMENT_DETAIL',
      ),
    );
    await request(httpServer())
      .get('/chatbot-api/payment-details')
      .set('Authorization', 'Bearer svc_payment-key')
      .expect(404);
  });
});
