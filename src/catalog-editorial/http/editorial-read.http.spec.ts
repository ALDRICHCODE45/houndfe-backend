import { Global, Module, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import request from 'supertest';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { createAppValidationPipe } from '../../shared/listing/app-validation.pipe';
import { CatalogEditorialReadModule } from '../catalog-editorial-read.module';
import { emptyDocument } from '../domain/document';

const productId = '11111111-1111-4111-8111-111111111111';
const tenantId = '22222222-2222-4222-8222-222222222222';
const actorId = '33333333-3333-4333-8333-333333333333';
const path = '/products/' + productId + '/editorial';
const raw = jest.fn();
const write = jest.fn();
const db = {
  user: { findUnique: jest.fn() },
  tenantMembership: { findMany: jest.fn() },
  product: { findFirst: jest.fn() },
  $transaction: jest.fn(),
};
let principal: {
  userId: string;
  tenantId: string | null;
  isSuperAdmin: boolean;
};
let products: { id: string }[];
let states: unknown[];

@Global()
@Module({
  providers: [{ provide: PrismaService, useValue: db }],
  exports: [PrismaService],
})
class TestDatabaseModule {}

describe('authenticated editorial read HTTP', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        TestDatabaseModule,
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        CatalogEditorialReadModule,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          const req = context.switchToHttp().getRequest();
          if (req.headers.authorization !== 'Bearer synthetic')
            throw new UnauthorizedException();
          req.user = { ...principal };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    principal = { userId: actorId, tenantId, isSuperAdmin: false };
    products = [{ id: productId }];
    states = [];
    db.user.findUnique.mockResolvedValue({ isActive: true });
    db.tenantMembership.findMany.mockResolvedValue([
      {
        userId: actorId,
        tenantId,
        role: {
          permissions: [
            {
              permission: { subject: 'ProductEditorialDraft', action: 'read' },
            },
          ],
        },
      },
    ]);
    db.product.findFirst.mockResolvedValue({ id: productId, tenantId });
    raw.mockImplementation((sql: { sql: string }) =>
      Promise.resolve(sql.sql.includes('FROM "products"') ? products : states),
    );
    db.$transaction.mockImplementation((work: (tx: unknown) => unknown) =>
      work({ $queryRaw: raw, $executeRaw: write }),
    );
  });
  afterEach(() => {
    expect(write).not.toHaveBeenCalled();
  });
  const get = (url = path) =>
    request(app.getHttpServer())
      .get(url)
      .set('Authorization', 'Bearer synthetic');
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

  test('authorized empty state uses only principal scope and returns triple null', async () => {
    const response = await get().set('x-tenant-id', 'foreign');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      cycle: null,
      draft: null,
      published: null,
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(db.user.findUnique).toHaveBeenCalledWith({
      where: { id: actorId },
      select: { isActive: true },
    });
    expect(db.product.findFirst).toHaveBeenCalledWith({
      where: { id: productId, tenantId },
      select: { id: true, tenantId: true },
    });
    expect(raw).toHaveBeenCalledTimes(2);
    for (const [sql] of raw.mock.calls)
      expect(sql.values).toEqual([tenantId, productId]);
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
    });
  });
  test('returns persisted state unchanged without inventing read warnings', async () => {
    const state = {
      cycle: 2,
      draft: {
        revision: 3,
        basePublishedRevision: 1,
        document: emptyDocument(),
      },
      published: { revision: 1, document: {} },
    };
    states = [state];
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.body).toEqual(state);
    expect(response.body).not.toHaveProperty('warnings');
    expect(states).toEqual([state]);
  });
  test.each([undefined, 'Bearer invalid'])(
    'unauthenticated request %s is rejected before persistence',
    async (token) => {
      const req = request(app.getHttpServer()).get(path);
      if (token) req.set('Authorization', token);
      await rejected(req, 401, 'UNAUTHORIZED');
      expect(db.$transaction).not.toHaveBeenCalled();
    },
  );
  test('superadmin still needs a concrete principal tenant', async () => {
    principal = { ...principal, tenantId: null, isSuperAdmin: true };
    await rejected(get(), 403, 'FORBIDDEN');
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  test('malformed Product UUID is rejected before persistence', async () => {
    await rejected(get('/products/not-a-uuid/editorial'), 400, 'MALFORMED');
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  test.each(['actorId', 'tenantId', 'capabilities'])(
    'rejects closed query field %s',
    async (field) => {
      await rejected(get().query({ [field]: 'foreign' }), 400, 'MALFORMED');
      expect(db.$transaction).not.toHaveBeenCalled();
    },
  );
  test.each([{ tenantId: 'foreign' }, { actorId: 'foreign' }, []])(
    'rejects unexpected decoded body %p',
    async (body) => {
      await rejected(get().send(body), 400, 'MALFORMED');
      expect(db.$transaction).not.toHaveBeenCalled();
    },
  );
  test.each([
    'inactive',
    'nonmember',
    'wildcard',
    'update-only',
    'foreign-product',
  ])('current authority denies %s without state disclosure', async (kind) => {
    if (kind === 'inactive')
      db.user.findUnique.mockResolvedValue({ isActive: false });
    if (kind === 'nonmember')
      db.tenantMembership.findMany.mockResolvedValue([]);
    if (kind === 'foreign-product')
      db.product.findFirst.mockResolvedValue({
        id: productId,
        tenantId: 'foreign',
      });
    if (kind === 'wildcard' || kind === 'update-only')
      db.tenantMembership.findMany.mockResolvedValue([
        {
          userId: actorId,
          tenantId,
          role: {
            permissions: [
              {
                permission:
                  kind === 'wildcard'
                    ? { subject: 'all', action: 'manage' }
                    : { subject: 'ProductEditorialDraft', action: 'update' },
              },
            ],
          },
        },
      ]);
    await rejected(get(), 403, 'FORBIDDEN');
    expect(raw).not.toHaveBeenCalled();
  });
  test('rechecks membership on the next read after revocation', async () => {
    expect((await get()).status).toBe(200);
    db.tenantMembership.findMany.mockResolvedValue([]);
    await rejected(get(), 403, 'FORBIDDEN');
    expect(db.user.findUnique).toHaveBeenCalledTimes(2);
    expect(raw).toHaveBeenCalledTimes(2);
    expect(states).toEqual([]);
  });
  test('Product disappearing after authority yields localized NOT_FOUND', async () => {
    products = [];
    await rejected(get(), 404, 'NOT_FOUND');
    expect(raw).toHaveBeenCalledTimes(1);
  });
  test('unknown persistence errors are sanitized', async () => {
    db.$transaction.mockRejectedValueOnce(new Error('secret database detail'));
    await rejected(get(), 500, 'INTERNAL_ERROR');
    expect(raw).not.toHaveBeenCalled();
  });
  test.each(['post', 'put'] as const)(
    'does not register %s writes',
    async (method) => {
      const response = await request(app.getHttpServer())
        [method](path + (method === 'post' ? '/draft/initialize' : '/draft'))
        .set('Authorization', 'Bearer synthetic')
        .send({});
      expect(response.status).toBe(404);
      expect(db.$transaction).not.toHaveBeenCalled();
    },
  );
  test('does not register definitions', async () => {
    expect((await get(path + '/definitions')).status).toBe(404);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
