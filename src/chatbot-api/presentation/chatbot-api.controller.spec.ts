import { INestApplication, ValidationPipe } from '@nestjs/common';
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

function makeCredential(scopes: string[]) {
  return ServiceCredential.fromPersistence({
    id: 'cred-1',
    tenantId: 'tenant-1',
    name: 'Chatbot Bot',
    hashedKey: createHash('sha256').update('svc_valid-key').digest('hex'),
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
    upsertCustomerProfile: jest.Mock;
    evaluateCart: jest.Mock;
  };
  let cls: { set: jest.Mock };
  let repository: jest.Mocked<IServiceCredentialRepository>;

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
      }),
    };
    cls = { set: jest.fn() };

    repository = {
      findByHashedKey: jest.fn((hashedKey: string) => {
        const validKey = createHash('sha256')
          .update('svc_valid-key')
          .digest('hex');
        const limitedKey = createHash('sha256')
          .update('svc_limited-key')
          .digest('hex');

        if (hashedKey === validKey) {
          return makeCredential(['catalog:read']);
        }

        if (hashedKey === limitedKey) {
          return makeCredential(['customers:read']);
        }

        if (
          hashedKey ===
          createHash('sha256').update('svc_write-key').digest('hex')
        ) {
          return makeCredential(['customers:write']);
        }

        if (
          hashedKey ===
          createHash('sha256').update('svc_pricing-key').digest('hex')
        ) {
          return makeCredential(['pricing:evaluate']);
        }

        return null;
      }),
      touchLastUsedAt: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [ChatbotApiController],
      providers: [
        ServiceAuthGuard,
        { provide: ClsService, useValue: cls },
        { provide: ChatbotApiService, useValue: service },
        { provide: SERVICE_CREDENTIAL_REPOSITORY, useValue: repository },
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
    await app.init();
  });

  afterEach(async () => {
    await app.close();
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
        });
      });
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
});
