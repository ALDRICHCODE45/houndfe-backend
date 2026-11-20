/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- supertest bodies are untyped JSON */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ClsService } from 'nestjs-cls';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { ServiceCredential } from '../../chatbot-api/domain/service-credential.entity';
import { SERVICE_CREDENTIAL_REPOSITORY } from '../../chatbot-api/domain/service-credential.repository';
import { ServiceAuthGuard } from '../../chatbot-api/presentation/guards/service-auth.guard';
import { BackordersBotService } from '../application/backorders-bot.service';
import { BackorderError } from '../domain/backorder-error';
import { BACKORDER_SCOPES } from '../domain/backorder-scopes';
import { BackordersBotController } from './backorders-bot.controller';
import type { BackorderBot } from './dto/backorder-bot.response';

const RAW_TOKEN = 'svc_backorders-test';
const UUID = (n: number) =>
  `${String(n).padStart(8, '0')}-0000-4000-8000-000000000001`;

const BACKORDER: BackorderBot = {
  id: UUID(10),
  folio: 'BO-000001',
  status: 'WAITING',
  productId: UUID(2),
  productName: 'Croquetas',
  variantId: null,
  variantName: null,
  quantity: 2,
  referencePriceCents: 114900,
  currentPriceCents: null,
  finalPriceCents: null,
  scheduledAt: '2026-11-20T15:00:00.000Z',
  estimatedAt: '2026-11-27T15:00:00.000Z',
  estimatedArrivalDays: 7,
  reservedAt: null,
  reservedUntil: null,
  reminderAt: null,
  queuePosition: 1,
  saleId: null,
  sourceDecisionId: UUID(3),
  cancelledByKind: null,
  cancelReason: null,
  branchName: 'Centro',
  customerFirstName: 'Rosa',
  phoneCountryCode: '52',
  phone: '5512349901',
};

const body = (over: Record<string, unknown> = {}) => ({
  phoneCountryCode: '52',
  phone: '5512349901',
  customer: { mode: 'existing', customerId: UUID(1) },
  productId: UUID(2),
  quantity: 2,
  sourceDecisionId: UUID(3),
  ...over,
});

describe('BackordersBotController (HTTP, mocked service)', () => {
  let app: INestApplication;
  let scopes: string[];
  let service: {
    create: jest.Mock;
    findById: jest.Mock;
    list: jest.Mock;
    cancel: jest.Mock;
    feedResumeAfter: jest.Mock;
  };
  const cls = { set: jest.fn() };

  beforeEach(async () => {
    scopes = [
      BACKORDER_SCOPES.create,
      BACKORDER_SCOPES.read,
      BACKORDER_SCOPES.cancel,
    ];
    service = {
      create: jest
        .fn()
        .mockResolvedValue({ replayed: false, backorder: BACKORDER }),
      findById: jest.fn().mockResolvedValue(BACKORDER),
      list: jest.fn().mockResolvedValue([BACKORDER]),
      feedResumeAfter: jest.fn().mockResolvedValue(null),
      cancel: jest
        .fn()
        .mockResolvedValue({ ...BACKORDER, status: 'CANCELLED' }),
    };
    const module = await Test.createTestingModule({
      controllers: [BackordersBotController],
      providers: [
        { provide: BackordersBotService, useValue: service },
        { provide: ClsService, useValue: cls },
        {
          provide: SERVICE_CREDENTIAL_REPOSITORY,
          useValue: {
            findByHashedKey: () =>
              Promise.resolve(
                ServiceCredential.fromPersistence({
                  id: 'cred',
                  tenantId: 'tenant-1',
                  name: 'Backorders',
                  hashedKey: createHash('sha256')
                    .update(RAW_TOKEN)
                    .digest('hex'),
                  scopes,
                  isActive: true,
                  rateLimit: 1000,
                  lastUsedAt: null,
                  revokedAt: null,
                  createdAt: new Date(),
                }),
              ),
            touchLastUsedAt: jest.fn(),
          },
        },
        ServiceAuthGuard,
      ],
    }).compile();
    app = module.createNestApplication();
    // The app's global pipe must not touch the `unknown` bodies.
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const auth = (call: request.Test) =>
    call.set('Authorization', `Bearer ${RAW_TOKEN}`);

  describe('POST /chatbot-api/backorders', () => {
    const post = (payload: object, key: string | null = 'bo-key-1') => {
      const call = auth(http().post('/chatbot-api/backorders'));
      if (key !== null) call.set('X-Idempotency-Key', key);
      return call.send(payload);
    };

    it('201 with { backorder } and no-store on a new backorder', async () => {
      const response = await post(body());
      expect(response.status).toBe(201);
      expect(response.body).toEqual({ backorder: BACKORDER });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(service.create).toHaveBeenCalledWith(
        expect.objectContaining({
          phone: '5512349901',
          quantity: 2,
          variantId: null,
          expectedReferencePriceCents: null,
        }),
        'bo-key-1',
      );
    });

    it('200 when the same key and body replay', async () => {
      service.create.mockResolvedValue({
        replayed: true,
        backorder: BACKORDER,
      });
      const response = await post(body());
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ backorder: BACKORDER });
    });

    it('trims the idempotency key', async () => {
      await post(body(), '  bo-key-1  ');
      expect(service.create).toHaveBeenCalledWith(
        expect.anything(),
        'bo-key-1',
      );
    });

    it.each([
      ['missing', null],
      ['blank', '   '],
      ['over 200 characters', 'k'.repeat(201)],
    ])(
      '400 INVALID_IDEMPOTENCY_KEY when the key is %s',
      async (_label, key) => {
        const response = await post(body(), key);
        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
          error: 'INVALID_IDEMPOTENCY_KEY',
          message: 'INVALID_IDEMPOTENCY_KEY',
        });
        expect(service.create).not.toHaveBeenCalled();
      },
    );

    it('400 INVALID_BACKORDER_REQUEST on an invalid body, before the service', async () => {
      const response = await post(body({ quantity: 0 }));
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        statusCode: 400,
        error: 'INVALID_BACKORDER_REQUEST',
        message: 'INVALID_BACKORDER_REQUEST',
      });
      expect(service.create).not.toHaveBeenCalled();
    });

    it.each([
      ['STOCK_AVAILABLE_NOW', { availableToSell: 5 }, 409],
      ['BACKORDER_DUPLICATE', { backorderId: UUID(10) }, 409],
      ['PRICE_OUT_OF_DATE', { currentPriceCents: 109900 }, 409],
      ['SOURCE_DECISION_NOT_ESTIMATED', {}, 409],
      ['SOURCE_DECISION_NOT_FOUND', {}, 404],
      ['PRODUCT_NOT_FOUND', {}, 404],
      ['VARIANT_NOT_FOUND', {}, 404],
      ['CUSTOMER_NOT_FOUND', {}, 404],
      ['VARIANT_REQUIRED', {}, 422],
      ['VARIANT_NOT_OF_PRODUCT', {}, 422],
      ['CUSTOMER_PHONE_AMBIGUOUS', {}, 409],
      ['IDEMPOTENCY_KEY_IN_FLIGHT', {}, 409],
      ['IDEMPOTENCY_KEY_CONFLICT', {}, 409],
    ] as const)(
      'maps %s to %i with its detail',
      async (code, details, status) => {
        service.create.mockRejectedValue(new BackorderError(code, details));
        const response = await post(body());
        expect(response.status).toBe(status);
        expect(response.body).toEqual({
          statusCode: status,
          error: code,
          message: code,
          ...details,
        });
      },
    );

    it('answers a generic 500 for an unexpected failure', async () => {
      service.create.mockRejectedValue(new Error('postgres://secret@host/db'));
      const response = await post(body());
      expect(response.status).toBe(500);
      expect(JSON.stringify(response.body)).not.toContain('secret');
      expect(response.body.error).toBe('BACKORDER_REQUEST_FAILED');
    });

    it('403 without backorders:create, and the service is never called', async () => {
      scopes = [BACKORDER_SCOPES.read, BACKORDER_SCOPES.cancel];
      const response = await post(body());
      expect(response.status).toBe(403);
      expect(service.create).not.toHaveBeenCalled();
    });

    it('401 without a service credential', async () => {
      const response = await http()
        .post('/chatbot-api/backorders')
        .set('X-Idempotency-Key', 'k')
        .send(body());
      expect(response.status).toBe(401);
      expect(service.create).not.toHaveBeenCalled();
    });

    it('403 when X-Branch-Id names another sucursal', async () => {
      const response = await post(body()).set('X-Branch-Id', 'tenant-2');
      expect(response.status).toBe(403);
      expect(service.create).not.toHaveBeenCalled();
    });
  });

  describe('GET /chatbot-api/backorders/:id', () => {
    it('200 with { backorder } and no-store', async () => {
      const response = await auth(
        http().get(`/chatbot-api/backorders/${UUID(10)}`),
      );
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ backorder: BACKORDER });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(service.findById).toHaveBeenCalledWith(UUID(10));
    });

    it('404 BACKORDER_NOT_FOUND', async () => {
      service.findById.mockRejectedValue(
        new BackorderError('BACKORDER_NOT_FOUND'),
      );
      const response = await auth(
        http().get(`/chatbot-api/backorders/${UUID(11)}`),
      );
      expect(response.status).toBe(404);
      expect(response.body.error).toBe('BACKORDER_NOT_FOUND');
    });

    it('404 for a malformed id, never reaching the service', async () => {
      const response = await auth(
        http().get('/chatbot-api/backorders/not-a-uuid'),
      );
      expect(response.status).toBe(404);
      expect(response.body.error).toBe('BACKORDER_NOT_FOUND');
      expect(service.findById).not.toHaveBeenCalled();
    });

    it('403 with only backorders:create', async () => {
      scopes = [BACKORDER_SCOPES.create];
      const response = await auth(
        http().get(`/chatbot-api/backorders/${UUID(10)}`),
      );
      expect(response.status).toBe(403);
    });
  });

  describe('GET /chatbot-api/backorders', () => {
    it('200 with { items } and the parsed filter (a recovery read also carries the feed pointer)', async () => {
      const response = await auth(
        http().get('/chatbot-api/backorders').query({
          phoneCountryCode: '52',
          phone: '5512349901',
          status: 'WAITING,RESERVED',
          updatedSince: '2026-11-20T10:00:00.000Z',
        }),
      );
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        items: [BACKORDER],
        backorderUndeliveredResumeAfter: null,
      });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(service.list).toHaveBeenCalledWith({
        phoneCountryCode: '52',
        phone: '5512349901',
        statuses: ['WAITING', 'RESERVED'],
        updatedSince: new Date('2026-11-20T10:00:00.000Z'),
      });
    });

    it('recovery (updatedSince) returns the feed position of the oldest unacknowledged backorder item', async () => {
      service.feedResumeAfter.mockResolvedValue('000000000041');
      const response = await auth(
        http()
          .get('/chatbot-api/backorders')
          .query({ updatedSince: '2026-11-20T10:00:00.000Z' }),
      );
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        items: [BACKORDER],
        backorderUndeliveredResumeAfter: '000000000041',
      });
    });

    it('without updatedSince the answer is exactly { items } (T1 shape) and never reads the pointer', async () => {
      const response = await auth(
        http().get('/chatbot-api/backorders').query({ status: 'WAITING' }),
      );
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ items: [BACKORDER] });
      expect(service.feedResumeAfter).not.toHaveBeenCalled();
    });

    it.each([
      ['a lone phone', { phone: '5512349901' }],
      ['an unknown status', { status: 'DONE' }],
      ['an unknown key', { page: '2' }],
    ])('400 INVALID_BACKORDER_REQUEST for %s', async (_label, query) => {
      const response = await auth(
        http().get('/chatbot-api/backorders').query(query),
      );
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('INVALID_BACKORDER_REQUEST');
      expect(service.list).not.toHaveBeenCalled();
    });

    it('409 CUSTOMER_PHONE_AMBIGUOUS from the service', async () => {
      service.list.mockRejectedValue(
        new BackorderError('CUSTOMER_PHONE_AMBIGUOUS'),
      );
      const response = await auth(
        http()
          .get('/chatbot-api/backorders')
          .query({ phoneCountryCode: '52', phone: '5512349901' }),
      );
      expect(response.status).toBe(409);
    });

    it('403 without backorders:read', async () => {
      scopes = [BACKORDER_SCOPES.create, BACKORDER_SCOPES.cancel];
      const response = await auth(http().get('/chatbot-api/backorders'));
      expect(response.status).toBe(403);
    });
  });

  describe('POST /chatbot-api/backorders/:id/cancel', () => {
    const cancel = (id: string, payload?: object) =>
      auth(http().post(`/chatbot-api/backorders/${id}/cancel`)).send(payload);

    it('200 with the cancelled backorder; reason is trimmed', async () => {
      const response = await cancel(UUID(10), {
        reason: ' ya no lo necesito ',
      });
      expect(response.status).toBe(200);
      expect(response.body.backorder.status).toBe('CANCELLED');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(service.cancel).toHaveBeenCalledWith(
        UUID(10),
        'ya no lo necesito',
      );
    });

    it('accepts an empty body (reason null)', async () => {
      const response = await cancel(UUID(10));
      expect(response.status).toBe(200);
      expect(service.cancel).toHaveBeenCalledWith(UUID(10), null);
    });

    it('409 BACKORDER_NOT_CANCELLABLE {status} for a terminal state', async () => {
      service.cancel.mockRejectedValue(
        new BackorderError('BACKORDER_NOT_CANCELLABLE', {
          status: 'CONFIRMED',
        }),
      );
      const response = await cancel(UUID(10), {});
      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        statusCode: 409,
        error: 'BACKORDER_NOT_CANCELLABLE',
        message: 'BACKORDER_NOT_CANCELLABLE',
        status: 'CONFIRMED',
      });
    });

    it('404 for a malformed id and for an unknown backorder', async () => {
      expect((await cancel('nope', {})).status).toBe(404);
      service.cancel.mockRejectedValue(
        new BackorderError('BACKORDER_NOT_FOUND'),
      );
      expect((await cancel(UUID(12), {})).status).toBe(404);
    });

    it('400 for a reason over 280 characters', async () => {
      const response = await cancel(UUID(10), { reason: 'x'.repeat(281) });
      expect(response.status).toBe(400);
      expect(service.cancel).not.toHaveBeenCalled();
    });

    it('403 without backorders:cancel (read and create are not enough)', async () => {
      scopes = [BACKORDER_SCOPES.create, BACKORDER_SCOPES.read];
      const response = await cancel(UUID(10), {});
      expect(response.status).toBe(403);
      expect(service.cancel).not.toHaveBeenCalled();
    });
  });
});
