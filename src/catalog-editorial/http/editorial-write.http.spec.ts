import { Global, Module, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import request from 'supertest';
import type { Request } from 'express';
import type { Server } from 'node:http';
import { idempotencyKey } from './idempotency-key';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { createAppValidationPipe } from '../../shared/listing/app-validation.pipe';
import { CatalogEditorialReadModule } from '../catalog-editorial-read.module';
import { emptyDocument } from '../domain/document';
import { EDITORIAL_READER } from './editorial-read.controller';

const productId = '11111111-1111-4111-8111-111111111111';
const tenantId = '22222222-2222-4222-8222-222222222222';
const actorId = '33333333-3333-4333-8333-333333333333';
const path = `/products/${productId}/editorial/draft`;
const core = { initialize: jest.fn(), save: jest.fn() };
const db = { $transaction: jest.fn() };
const raw = jest.fn();
const tx = {
  user: { findUnique: jest.fn() },
  tenantMembership: { findMany: jest.fn() },
  product: { findFirst: jest.fn() },
  $queryRaw: raw,
};
let tenant: string | null;
const state = {
  cycle: 1,
  draft: {
    revision: 1,
    basePublishedRevision: null,
    document: emptyDocument(),
  },
  published: null,
  warnings: [{ code: 'ARCHIVED_OPTION', optionCode: 'old' }],
};
@Global()
@Module({
  providers: [{ provide: PrismaService, useValue: db }],
  exports: [PrismaService],
})
class TestDatabaseModule {}

async function application(mockCore: boolean) {
  const builder = Test.createTestingModule({
    imports: [
      TestDatabaseModule,
      ClsModule.forRoot({ global: true, middleware: { mount: true } }),
      CatalogEditorialReadModule,
    ],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue({
      canActivate(context: ExecutionContext) {
        const req = context.switchToHttp().getRequest<Request>();
        if (req.headers.authorization !== 'Bearer synthetic')
          throw new UnauthorizedException();
        req.user = { userId: actorId, tenantId: tenant, isSuperAdmin: false };
        return true;
      },
    });
  if (mockCore) builder.overrideProvider(EDITORIAL_READER).useValue(core);
  const module = await builder.compile();
  const app = module.createNestApplication();
  app.useGlobalPipes(createAppValidationPipe());
  await app.init();
  return app;
}

test('decoded header whitespace is not trimmed; nonstrings are malformed', () => {
  expect(idempotencyKey('  ')).toBe('  ');
  expect(idempotencyKey(' key ')).toBe(' key ');
  for (const value of [undefined, [], 1])
    expect(() => idempotencyKey(value)).toThrow();
});

describe('coordinated write wiring', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await application(false);
  });
  afterAll(async () => {
    await app?.close();
  });
  test.each(['read', 'update', 'manage', 'both'])(
    'both operations use exact transaction-scoped capabilities: %s',
    async (grant) => {
      tenant = tenantId;
      tx.user.findUnique.mockResolvedValue({ isActive: true });
      tx.product.findFirst.mockResolvedValue({ id: productId, tenantId });
      const actions = grant === 'both' ? ['read', 'update'] : [grant];
      tx.tenantMembership.findMany.mockResolvedValue([
        {
          userId: actorId,
          tenantId,
          role: {
            permissions: actions.map((action) => ({
              permission: {
                subject: action === 'manage' ? 'all' : 'ProductEditorialDraft',
                action,
              },
            })),
          },
        },
      ]);
      db.$transaction.mockImplementation((work: (value: unknown) => unknown) =>
        work(tx),
      );
      for (const operation of ['initialize', 'save'] as const) {
        raw.mockReset().mockRejectedValue(new Error('gate unavailable'));
        const req =
          operation === 'initialize'
            ? request(app.getHttpServer() as Server).post(path + '/initialize')
            : request(app.getHttpServer() as Server).put(path);
        const body =
          operation === 'initialize'
            ? { expectedCycle: null }
            : {
                expectedCycle: 1,
                expectedRevision: 1,
                document: emptyDocument(),
              };
        const response = await req
          .set('Authorization', 'Bearer synthetic')
          .set('Idempotency-Key', 'key')
          .send(body);
        expect(response.status).toBe(403);
        expect(response.body).toEqual({ statusCode: 403, error: 'FORBIDDEN' });
        expect(raw).toHaveBeenCalledTimes(grant === 'both' ? 1 : 0);
      }
      expect(tx.user.findUnique).toHaveBeenCalled();
    },
  );
});

describe('editorial write HTTP', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await application(true);
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    tenant = tenantId;
    core.initialize.mockResolvedValue(state);
    core.save.mockResolvedValue(state);
  });
  const send = (
    operation: 'initialize' | 'save',
    body: object,
    key = 'key',
  ) => {
    const req =
      operation === 'initialize'
        ? request(app.getHttpServer() as Server).post(path + '/initialize')
        : request(app.getHttpServer() as Server).put(path);
    return req
      .set('Authorization', 'Bearer synthetic')
      .set('Idempotency-Key', key)
      .send(body);
  };
  const rejected = async (
    response: PromiseLike<request.Response>,
    status: number,
    error: string,
  ) => {
    const result = await response;
    expect(result.status).toBe(status);
    expect(result.body).toEqual({ statusCode: status, error });
    expect(result.headers['cache-control']).toBe('no-store');
  };
  for (const operation of ['initialize', 'save'] as const) {
    const body =
      operation === 'initialize'
        ? { expectedCycle: null }
        : { expectedCycle: 1, expectedRevision: 1, document: emptyDocument() };
    test(`${operation} returns state and replay status using principal scope`, async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await send(operation, body).set(
          'x-tenant-id',
          'foreign',
        );
        expect(response.status).toBe(operation === 'initialize' ? 201 : 200);
        expect(response.body).toEqual(state);
        expect(response.headers['cache-control']).toBe('no-store');
      }
      expect(core[operation]).toHaveBeenCalledTimes(2);
      expect(core[operation]).toHaveBeenCalledWith(
        { actorId, tenantId, productId },
        { ...body, idempotencyKey: 'key' },
      );
    });
    test.each(['', 'x'.repeat(201)])(
      `${operation} rejects invalid header %p`,
      async (key) => {
        await rejected(send(operation, body, key), 400, 'MALFORMED');
        expect(core[operation]).not.toHaveBeenCalled();
      },
    );
    test(`${operation} requires header`, async () => {
      await rejected(
        send(operation, body).unset('Idempotency-Key'),
        400,
        'MALFORMED',
      );
      expect(core[operation]).not.toHaveBeenCalled();
    });
    test(`${operation} preserves whitespace and accepts 200 characters`, async () => {
      for (const key of ['a  b', 'x'.repeat(200)]) {
        const response = await send(operation, body, key);
        expect(response.status).toBe(operation === 'initialize' ? 201 : 200);
        expect(core[operation]).toHaveBeenLastCalledWith(expect.anything(), {
          ...body,
          idempotencyKey: key,
        });
      }
    });
    test.each([
      {},
      [],
      { ...body, actorId: 'foreign' },
      { ...body, idempotencyKey: 'body' },
      { ...body, expectedCycle: 0 },
      { ...body, expectedCycle: '1' },
      { ...body, expectedCycle: 1.5 },
    ])(`${operation} rejects closed-body violation %p`, async (invalid) => {
      await rejected(send(operation, invalid), 400, 'MALFORMED');
      expect(core[operation]).not.toHaveBeenCalled();
    });
    test.each([
      ['MALFORMED', 400],
      ['UNAUTHORIZED', 401],
      ['FORBIDDEN', 403],
      ['NOT_FOUND', 404],
      ['CONFLICT', 409],
      ['INTERNAL_ERROR', 500],
      ['secret persistence detail', 500],
    ] as const)(`${operation} maps %s`, async (error, status) => {
      core[operation].mockRejectedValueOnce(new Error(error));
      await rejected(
        send(operation, body),
        status,
        status === 500 ? 'INTERNAL_ERROR' : error,
      );
    });
    test(`${operation} guards run before validation and core`, async () => {
      tenant = null;
      await rejected(
        send(operation, {}).unset('Authorization'),
        401,
        'UNAUTHORIZED',
      );
      await rejected(send(operation, {}), 401, 'UNAUTHORIZED');
      tenant = ' ';
      await rejected(send(operation, {}), 403, 'FORBIDDEN');
      expect(core[operation]).not.toHaveBeenCalled();
    });
    test(`${operation} rejects query and malformed UUID`, async () => {
      await rejected(
        send(operation, body).query({ tenantId: 'foreign' }),
        400,
        'MALFORMED',
      );
      const req =
        operation === 'initialize'
          ? request(app.getHttpServer() as Server).post(
              '/products/bad/editorial/draft/initialize',
            )
          : request(app.getHttpServer() as Server).put(
              '/products/bad/editorial/draft',
            );
      await rejected(
        req
          .set('Authorization', 'Bearer synthetic')
          .set('Idempotency-Key', 'key')
          .send(body),
        400,
        'MALFORMED',
      );
      expect(core[operation]).not.toHaveBeenCalled();
    });
  }
  test.each([null, 0, 1.5, '1'])(
    'save rejects invalid revision %p',
    async (expectedRevision) => {
      await rejected(
        send('save', { expectedCycle: 1, expectedRevision, document: {} }),
        400,
        'MALFORMED',
      );
      expect(core.save).not.toHaveBeenCalled();
    },
  );
  test('save requires document but passes it through without HTTP limits', async () => {
    await rejected(
      send('save', { expectedCycle: 1, expectedRevision: 1 }),
      400,
      'MALFORMED',
    );
    const document = { untouched: 'x'.repeat(201) };
    const response = await send('save', {
      expectedCycle: 1,
      expectedRevision: 1,
      document,
    });
    expect(response.status).toBe(200);
    expect(core.save).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ document }),
    );
  });
});
