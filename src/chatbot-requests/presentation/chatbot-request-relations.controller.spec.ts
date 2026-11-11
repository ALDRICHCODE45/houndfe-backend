/**
 * HTTP contract of merge and link-customer (§3.10, §12.11, §12.12): the real
 * controller, DTO pipe and scoped filter over a mocked service; guards are a
 * stub that sets the JWT user.
 */
import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PERMISSIONS_KEY } from '../../auth/authorization/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { ActiveUserGuard } from '../../auth/guards/active-user.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { createAppValidationPipe } from '../../shared/listing/app-validation.pipe';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import {
  ChatbotRequestCommandError,
  type ChatbotRequestView,
} from '../application/chatbot-request-commands.service';
import { ChatbotRequestRelationsService } from '../application/chatbot-request-relations.service';
import { ChatbotRequestRelationsController } from './chatbot-request-relations.controller';

const ID = '2b7c1a90-6f3e-4d2a-8b1c-0d9e8f7a6b5c';
const INTO = '9d1e2f30-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const CUSTOMER = '0c1d2e3f-4a5b-4c6d-8e7f-1a2b3c4d5e6f';
const KEY = '5f0b2c1e-6a43-4f7e-9c1d-2b3a4c5d6e7f';
const VIEW = {
  id: ID,
  folio: 'S-000010',
  status: 'CANCELLED',
  version: 3,
} as unknown as ChatbotRequestView;

class StubGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest<{ user: unknown }>().user = {
      userId: 'u-ana',
      tenantId: 't-1',
      isSuperAdmin: false,
    };
    return true;
  }
}

describe('ChatbotRequestRelationsController', () => {
  let app: INestApplication;
  const merge = jest.fn();
  const linkCustomer = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ChatbotRequestRelationsController],
      providers: [
        {
          provide: ChatbotRequestRelationsService,
          useValue: { merge, linkCustomer },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(StubGuard)
      .overrideGuard(TenantContextGuard)
      .useClass(StubGuard)
      .overrideGuard(ActiveUserGuard)
      .useClass(StubGuard)
      .overrideGuard(PermissionsGuard)
      .useClass(StubGuard)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    merge.mockReset().mockResolvedValue(VIEW);
    linkCustomer.mockReset().mockResolvedValue(VIEW);
  });

  const post = (path: string, body: object, key: string | null = KEY) => {
    const call = request(app.getHttpServer() as Parameters<typeof request>[0])
      .post(`/chatbot-requests/${ID}/${path}`)
      .send(body);
    return key === null ? call : call.set('Idempotency-Key', key);
  };
  const mergeBody = {
    expectedVersion: 2,
    intoRequestId: INTO,
    intoExpectedVersion: 4,
  };

  it('declares the four staff guards in order', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, ChatbotRequestRelationsController),
    ).toEqual([
      JwtAuthGuard,
      TenantContextGuard,
      ActiveUserGuard,
      PermissionsGuard,
    ]);
  });

  it.each(['merge', 'linkCustomer'] as const)(
    '%s requires read and update:ChatbotRequest',
    (method) => {
      expect(
        Reflect.getMetadata(
          PERMISSIONS_KEY,
          ChatbotRequestRelationsController.prototype[method],
        ),
      ).toEqual([
        ['read', 'ChatbotRequest'],
        ['update', 'ChatbotRequest'],
      ]);
    },
  );

  it('merges with the JWT actor, the key and both versions', async () => {
    const res = await post('merge', mergeBody).expect(200);
    expect(res.body).toEqual({ request: VIEW });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(merge).toHaveBeenCalledWith({
      requestId: ID,
      actorUserId: 'u-ana',
      idempotencyKey: KEY,
      expectedVersion: 2,
      intoRequestId: INTO,
      intoExpectedVersion: 4,
    });
  });

  it('links a customer with the JWT actor, the key and the version', async () => {
    await post('link-customer', {
      expectedVersion: 2,
      customerId: CUSTOMER,
    }).expect(200);
    expect(linkCustomer).toHaveBeenCalledWith({
      requestId: ID,
      actorUserId: 'u-ana',
      idempotencyKey: KEY,
      expectedVersion: 2,
      customerId: CUSTOMER,
    });
  });

  it.each([
    ['merge', {}],
    ['merge', { expectedVersion: 2, intoRequestId: INTO }],
    ['merge', { ...mergeBody, intoRequestId: 'nope' }],
    ['merge', { ...mergeBody, intoExpectedVersion: 0 }],
    ['merge', { ...mergeBody, tenantId: 'x' }],
    ['link-customer', { expectedVersion: 2 }],
    ['link-customer', { expectedVersion: 2, customerId: 'nope' }],
    ['link-customer', { expectedVersion: 2, customerId: CUSTOMER, phone: '5' }],
  ])(
    'rejects %s %j with 400 and never calls the service',
    async (path, body) => {
      await post(path, body).expect(400);
      expect(merge).not.toHaveBeenCalled();
      expect(linkCustomer).not.toHaveBeenCalled();
    },
  );

  it.each([
    [null, 'merge', mergeBody],
    [
      'not-a-uuid',
      'link-customer',
      { expectedVersion: 2, customerId: CUSTOMER },
    ],
  ])(
    'rejects a missing or malformed Idempotency-Key (%s)',
    async (key, path, body) => {
      const res = await post(path, body, key).expect(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    },
  );

  it('maps MERGE_NOT_ALLOWED to 422 and a target conflict to 409 with current and intoRequestId', async () => {
    merge.mockRejectedValueOnce(
      new ChatbotRequestCommandError('MERGE_NOT_ALLOWED', 422, {
        version: 2,
        status: 'NEW',
        claimedBy: null,
      }),
    );
    const refused = await post('merge', mergeBody).expect(422);
    expect(refused.body).toMatchObject({
      code: 'MERGE_NOT_ALLOWED',
      current: { version: 2 },
    });
    merge.mockRejectedValueOnce(
      new ChatbotRequestCommandError(
        'VERSION_CONFLICT',
        409,
        { version: 5, status: 'NEW', claimedBy: null },
        { intoRequestId: INTO },
      ),
    );
    const conflict = await post('merge', mergeBody).expect(409);
    expect(conflict.body).toMatchObject({
      code: 'VERSION_CONFLICT',
      current: { version: 5 },
      intoRequestId: INTO,
    });
  });

  it('maps CUSTOMER_PHONE_MISMATCH to 422', async () => {
    linkCustomer.mockRejectedValueOnce(
      new ChatbotRequestCommandError('CUSTOMER_PHONE_MISMATCH', 422),
    );
    const res = await post('link-customer', {
      expectedVersion: 2,
      customerId: CUSTOMER,
    }).expect(422);
    expect(res.body).toMatchObject({ code: 'CUSTOMER_PHONE_MISMATCH' });
  });
});
