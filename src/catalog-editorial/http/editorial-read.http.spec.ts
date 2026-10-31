import { Global, Module, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import type { Server } from 'node:http';
import { ClsModule } from 'nestjs-cls';
import request from 'supertest';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { createAppValidationPipe } from '../../shared/listing/app-validation.pipe';
import { CatalogEditorialReadModule } from '../catalog-editorial-read.module';
import { createHash } from 'node:crypto';

const snapshot = {
  metadata: { id: 'global', semanticsVersion: 'editorial-production-1' },
  families: [],
  definitions: [],
};
const revision =
  'ev2-sha256-' +
  createHash('sha256')
    .update(
      '{"contractVersion":2,"vocabulary":{"definitions":[],"families":[],"semanticsVersion":"editorial-production-1"}}',
    )
    .digest('hex');
const document = () => ({
  schemaVersion: 2,
  commercialTitle: null,
  description: null,
  mediaRefs: [],
  familyCode: null,
  values: [],
  facts: [],
});
const envelope = (state: unknown) => ({
  contractVersion: 2,
  vocabularyRevision: revision,
  state,
});

const productId = '11111111-1111-4111-8111-111111111111';
const tenantId = '22222222-2222-4222-8222-222222222222';
const actorId = '33333333-3333-4333-8333-333333333333';
const path = '/products/' + productId + '/editorial';
const raw = jest.fn<Promise<unknown[]>, [Prisma.Sql]>();
const write = jest.fn();
const db = {
  user: { findUnique: jest.fn() },
  tenantMembership: { findMany: jest.fn() },
  product: { findFirst: jest.fn() },
  $transaction: jest.fn(),
  $queryRaw: jest.fn(),
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
          const req = context.switchToHttp().getRequest<Request>();
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
    db.$queryRaw.mockRejectedValue(new Error('Root metadata must not be read'));
    raw.mockImplementation((sql: Prisma.Sql | readonly string[]) => {
      const text = Array.isArray(sql) ? sql.join('') : (sql as Prisma.Sql).sql;
      return Promise.resolve(
        text.includes('editorial_vocabulary_metadata')
          ? [{ snapshot }]
          : text.includes('FROM "products"')
            ? products
            : states,
      );
    });
    db.$transaction.mockImplementation((work: (tx: unknown) => unknown) =>
      work({ $queryRaw: raw, $executeRaw: write }),
    );
  });
  afterEach(() => {
    expect(write).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
  const get = (url = path) =>
    request(app.getHttpServer() as Server)
      .get(url)
      .set('Authorization', 'Bearer synthetic')
      .set('Editorial-Vocabulary-Revision', revision);
  const rejected = async (
    response: PromiseLike<request.Response>,
    status: number,
    error: string,
  ) => {
    const result = await response;
    expect(result.status).toBe(status);
    expect(result.body).toEqual({ statusCode: status, error });
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.headers['editorial-contract-version']).toBe('2');
    expect(result.headers['editorial-vocabulary-revision']).toBeUndefined();
  };

  test('authorized empty state uses only principal scope and returns triple null', async () => {
    const response = await get().set('x-tenant-id', 'foreign');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      envelope({ cycle: null, draft: null, published: null }),
    );
    expect(response.headers['editorial-contract-version']).toBe('2');
    expect(response.headers['editorial-vocabulary-revision']).toBe(revision);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(db.user.findUnique).toHaveBeenCalledWith({
      where: { id: actorId },
      select: { isActive: true },
    });
    expect(db.product.findFirst).toHaveBeenCalledWith({
      where: { id: productId, tenantId },
      select: { id: true, tenantId: true },
    });
    expect(raw).toHaveBeenCalledTimes(3);
    for (const [sql] of raw.mock.calls.filter(
      ([query]) => !Array.isArray(query),
    ))
      expect(sql.values).toEqual([tenantId, productId]);
    expect(db.user.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
      db.$transaction.mock.invocationCallOrder[0],
    );
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
        document: document(),
      },
      published: {
        revision: 1,
        document: { ...document(), commercialTitle: 'Published' },
      },
    };
    states = [state];
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.body).toEqual(envelope(state));
    expect((response.body as { state: object }).state).not.toHaveProperty(
      'warnings',
    );
    expect(states).toEqual([state]);
  });
  test.each([undefined, 'Bearer invalid'])(
    'unauthenticated request %s is rejected before persistence',
    async (token) => {
      const req = request(app.getHttpServer() as Server).get(path);
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
  ])('current authority handles %s safely', async (kind) => {
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
    if (kind === 'wildcard') {
      const response = await get();
      expect(response.status).toBe(200);
      expect(response.body).toEqual(
        envelope({ cycle: null, draft: null, published: null }),
      );
      expect(response.headers['cache-control']).toBe('no-store');
      expect(raw).toHaveBeenCalledTimes(3);
      for (const [sql] of raw.mock.calls.filter(
        ([query]) => !Array.isArray(query),
      ))
        expect(sql.values).toEqual([tenantId, productId]);
    } else {
      await rejected(get(), 403, 'FORBIDDEN');
      expect(raw).not.toHaveBeenCalled();
    }
  });
  test('rechecks membership on the next read after revocation', async () => {
    expect((await get()).status).toBe(200);
    db.tenantMembership.findMany.mockResolvedValue([]);
    await rejected(get(), 403, 'FORBIDDEN');
    expect(db.user.findUnique).toHaveBeenCalledTimes(2);
    expect(raw).toHaveBeenCalledTimes(3);
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
  test.each([
    ['post', '/draft'],
    ['patch', '/draft'],
    ['delete', '/draft/initialize'],
  ] as const)(
    'does not register unlisted %s %s writes',
    async (method, suffix) => {
      const response = await request(app.getHttpServer() as Server)
        [method](path + suffix)
        .set('Authorization', 'Bearer synthetic')
        .send({});
      expect(response.status).toBe(404);
      expect(db.$transaction).not.toHaveBeenCalled();
    },
  );
  test.each([
    undefined,
    '',
    'bad',
    revision.toUpperCase(),
    revision.slice(0, 12) + ' ' + revision.slice(12),
    revision + ',' + revision,
  ])('rejects invalid R %s before transaction', async (value) => {
    const req = get().unset('Editorial-Vocabulary-Revision');
    if (value !== undefined) req.set('Editorial-Vocabulary-Revision', value);
    await rejected(req, 400, 'MALFORMED');
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  test.each([
    'Idempotency-Key',
    'Editorial-Care-Confirmation',
    'Editorial-Contract-Version',
    'Editorial-Adoption',
  ])('rejects prohibited %s even empty', async (header) => {
    await rejected(get().set(header, ''), 400, 'MALFORMED');
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  test('rejects duplicate raw revision occurrences', async () => {
    await rejected(
      get().set('Editorial-Vocabulary-Revision', [
        revision,
        revision,
      ] as unknown as string),
      400,
      'MALFORMED',
    );
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  test('authority takes precedence over query/body/header admission', async () => {
    db.tenantMembership.findMany.mockResolvedValue([]);
    await rejected(
      get()
        .query({ tenantId: 'foreign' })
        .send({ extra: true })
        .set('Editorial-Adoption', ''),
      403,
      'FORBIDDEN',
    );
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  test('compares actual snapshot R before reading state', async () => {
    await rejected(
      get().set(
        'Editorial-Vocabulary-Revision',
        'ev2-sha256-' + 'a'.repeat(64),
      ),
      409,
      'VOCABULARY_CHANGED',
    );
    expect(raw).toHaveBeenCalledTimes(2);
  });
  test.each(['draft', 'published'])(
    'rejects invalid %s documents without leaking either slot',
    async (slot) => {
      for (const bad of [
        {},
        { ...document(), schemaVersion: 3 },
        { ...document(), facts: null },
      ]) {
        states = [
          {
            cycle: 1,
            draft: {
              revision: 1,
              basePublishedRevision: null,
              document: document(),
            },
            published: { revision: 1, document: document() },
          },
        ];
        (states[0] as Record<string, { document: unknown }>)[slot].document =
          bad;
        const before = structuredClone(states);
        await rejected(get(), 500, 'INTERNAL_ERROR');
        expect(states).toEqual(before);
      }
    },
  );
  test.each([0, -1, 1.5, 2147483648, '1'])(
    'rejects corrupt stored counter %s',
    async (cycle) => {
      states = [{ cycle, draft: null, published: null }];
      await rejected(get(), 500, 'INTERNAL_ERROR');
    },
  );
  test('retains recognizable historical conflicts without fresh qualification', async () => {
    const value = {
      code: 'orphan',
      owner: 'sellable',
      variantId: 'gone',
      state: 'known',
      payload: { type: 'range', min: 5, max: 1, unit: 'x' },
      evidence: null,
    };
    const historical = {
      ...document(),
      commercialTitle: 'x'.repeat(501),
      values: [value, value],
    };
    const state = {
      cycle: 1,
      draft: { revision: 1, basePublishedRevision: null, document: historical },
      published: null,
    };
    states = [state];
    const before = structuredClone(state);
    expect((await get()).body).toEqual(envelope(before));
    expect(states).toEqual([before]);
  });
  test('does not treat a malformed present row as absent state', async () => {
    states = [null];
    await rejected(get(), 500, 'INTERNAL_ERROR');
    expect(states).toEqual([null]);
  });
  test('transaction metadata failure stays sanitized and never reads state', async () => {
    raw
      .mockResolvedValueOnce(products)
      .mockRejectedValueOnce(new Error('private snapshot failure'));
    await rejected(get(), 500, 'INTERNAL_ERROR');
    expect(raw).toHaveBeenCalledTimes(2);
  });
  test('unrepresentable snapshot is a typed whole-response failure', async () => {
    raw
      .mockResolvedValueOnce(products)
      .mockResolvedValueOnce([{ snapshot: { ...snapshot, metadata: null } }]);
    await rejected(get(), 500, 'EDITORIAL_VOCABULARY_UNREPRESENTABLE');
    expect(raw).toHaveBeenCalledTimes(2);
  });
  test('does not register definitions', async () => {
    expect((await get(path + '/definitions')).status).toBe(404);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
