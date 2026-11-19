import { Global, Module, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import type { Server } from 'node:http';
import { ClsModule } from 'nestjs-cls';
import request from 'supertest';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { createAppValidationPipe } from '../../shared/listing/app-validation.pipe';
import type { ReadinessV2 } from '../application/editorial-publication-readiness-v2';
import { EDITORIAL_READINESS_READER } from '../application/editorial-readiness-reader';
import { CatalogEditorialReadModule } from '../catalog-editorial-read.module';

const productId = '11111111-1111-4111-8111-111111111111';
const tenantId = '22222222-2222-4222-8222-222222222222';
const actorId = '33333333-3333-4333-8333-333333333333';
const revision = 'ev2-sha256-' + 'b'.repeat(64);
const path = `/products/${productId}/editorial/draft/readiness`;
const readiness: ReadinessV2 = {
  ready: false,
  cycle: 3,
  draftRevision: 12,
  vocabularyRevision: revision,
  items: [
    {
      scope: 'definition',
      definitionCode: 'measure.net_mass',
      variantId: null,
      sectionCode: 'contenido-empaque',
      problem: 'REQUIRED_MISSING',
      message: 'Falta el peso neto.',
    },
  ],
  bySection: { 'contenido-empaque': 1 },
};
const reader = { read: jest.fn() };
const db = {
  user: { findUnique: jest.fn() },
  role: { findFirst: jest.fn() },
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
let actions: string[];

type StoredRole = {
  id: string;
  tenantId: string | null;
  isSystem: boolean;
  name: string;
  memberUserIds: string[];
  permissions: { subject: string; action: string }[];
};
let roles: StoredRole[];
// Evaluates the exact persisted global-administrator predicate against
// stored roles; an unknown predicate shape fails the test loudly.
function findGlobalRole(args: {
  where: {
    tenantId: null;
    tenantMemberships: { some: { userId: string } };
    OR: Array<
      | { isSystem: boolean; name: string }
      | {
          permissions: {
            some: { permission: { subject: string; action: string } };
          };
        }
    >;
  };
  select: { id: true };
}) {
  const { where } = args;
  if (where.tenantId !== null || !Array.isArray(where.OR))
    throw new Error('unexpected global role predicate');
  const role = roles.find(
    (r) =>
      r.tenantId === null &&
      r.memberUserIds.includes(where.tenantMemberships.some.userId) &&
      where.OR.some((branch) =>
        'permissions' in branch
          ? r.permissions.some(
              (p) =>
                p.subject === branch.permissions.some.permission.subject &&
                p.action === branch.permissions.some.permission.action,
            )
          : r.isSystem === branch.isSystem && r.name === branch.name,
      ),
  );
  return Promise.resolve(role ? { id: role.id } : null);
}
const superAdminRole = (members: string[]): StoredRole => ({
  id: 'system-super-admin',
  tenantId: null,
  isSystem: true,
  name: 'Super Admin',
  memberUserIds: members,
  permissions: [{ subject: 'all', action: 'manage' }],
});
const globalManageAllRole = (members: string[]): StoredRole => ({
  id: 'global-editors',
  tenantId: null,
  isSystem: false,
  name: 'Global Editors',
  memberUserIds: members,
  permissions: [{ subject: 'all', action: 'manage' }],
});

@Global()
@Module({
  providers: [{ provide: PrismaService, useValue: db }],
  exports: [PrismaService],
})
class TestDatabaseModule {}

describe('GET /products/:productId/editorial/draft/readiness', () => {
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
      .overrideProvider(EDITORIAL_READINESS_READER)
      .useValue(reader)
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
    actions = ['read'];
    roles = [];
    db.role.findFirst.mockImplementation(findGlobalRole);
    db.user.findUnique.mockResolvedValue({ isActive: true });
    db.tenantMembership.findMany.mockImplementation(() =>
      Promise.resolve([
        {
          userId: actorId,
          tenantId,
          role: {
            permissions: actions.map((action) => ({
              permission: { subject: 'ProductEditorialDraft', action },
            })),
          },
        },
      ]),
    );
    db.product.findFirst.mockResolvedValue({ id: productId, tenantId });
    reader.read.mockResolvedValue(readiness);
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
    expect(reader.read).not.toHaveBeenCalled();
  };

  test('returns the evaluated readiness with editorial headers and no-store', async () => {
    const response = await get().set('x-tenant-id', 'foreign');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(readiness);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['editorial-contract-version']).toBe('2');
    expect(response.headers['editorial-vocabulary-revision']).toBe(revision);
    expect(reader.read).toHaveBeenCalledWith(
      { actorId, tenantId, productId },
      revision,
    );
  });

  test('needs only ProductEditorialDraft:read', async () => {
    actions = ['update'];
    await rejected(get(), 403, 'FORBIDDEN');
  });

  test('rejects unauthenticated and tenantless principals before reading', async () => {
    await rejected(
      request(app.getHttpServer() as Server).get(path),
      401,
      'UNAUTHORIZED',
    );
    principal = { ...principal, tenantId: null, isSuperAdmin: true };
    await rejected(get(), 403, 'FORBIDDEN');
  });

  test.each([
    [
      'a malformed product id',
      () => get(`/products/x/editorial/draft/readiness`),
    ],
    ['a query', () => get().query({ actorId: 'foreign' })],
    ['a body', () => get().send({ document: {} })],
    ['an idempotency key', () => get().set('Idempotency-Key', 'k')],
    [
      'a missing revision',
      () =>
        request(app.getHttpServer() as Server)
          .get(path)
          .set('Authorization', 'Bearer synthetic'),
    ],
    [
      'a malformed revision',
      () =>
        request(app.getHttpServer() as Server)
          .get(path)
          .set('Authorization', 'Bearer synthetic')
          .set('Editorial-Vocabulary-Revision', 'ev2-sha256-x'),
    ],
  ])('rejects %s as MALFORMED', async (_, send) => {
    await rejected(send(), 400, 'MALFORMED');
  });

  test.each([
    ['NOT_FOUND', 404],
    ['VOCABULARY_CHANGED', 409],
  ])('maps reader %s to %d', async (code, status) => {
    reader.read.mockRejectedValue(new Error(code));
    const response = await get();
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ statusCode: status, error: code });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['editorial-vocabulary-revision']).toBeUndefined();
  });

  test('never touches the write surfaces', async () => {
    await get();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  describe('global mode (positive)', () => {
    const productTenant = '44444444-4444-4444-8444-444444444444';
    const expectGlobalRead = async () => {
      const response = await get().set('x-tenant-id', 'foreign');
      expect(response.status).toBe(200);
      expect(response.body).toEqual(readiness);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['editorial-contract-version']).toBe('2');
      expect(response.headers['editorial-vocabulary-revision']).toBe(revision);
      // Tenant comes from the persisted Product, never from the request.
      expect(db.product.findFirst).toHaveBeenNthCalledWith(1, {
        where: { id: productId },
        select: { id: true, tenantId: true },
      });
      expect(reader.read).toHaveBeenCalledWith(
        { actorId, tenantId: productTenant, productId },
        revision,
      );
    };
    beforeEach(() => {
      principal = { userId: actorId, tenantId: null, isSuperAdmin: true };
      // No membership in the Product's tenant: authority is the global role.
      db.tenantMembership.findMany.mockResolvedValue([]);
      db.product.findFirst.mockResolvedValue({
        id: productId,
        tenantId: productTenant,
      });
    });

    test('global Super Admin (system role, tenantId null) reads readiness of any tenant Product', async () => {
      roles = [superAdminRole([actorId])];
      await expectGlobalRead();
    });

    test('global manage:all role (tenantId null) reads readiness of any tenant Product', async () => {
      roles = [globalManageAllRole([actorId])];
      await expectGlobalRead();
    });

    test('Super Admin with a selected tenant reads within that tenant only', async () => {
      roles = [superAdminRole([actorId])];
      principal = { userId: actorId, tenantId, isSuperAdmin: true };
      db.product.findFirst.mockResolvedValue({ id: productId, tenantId });
      const response = await get();
      expect(response.status).toBe(200);
      expect(db.product.findFirst).toHaveBeenNthCalledWith(1, {
        where: { id: productId, tenantId },
        select: { id: true, tenantId: true },
      });
      expect(reader.read).toHaveBeenCalledWith(
        { actorId, tenantId, productId },
        revision,
      );
    });

    test('tenant role with manage:all reads readiness in its tenant', async () => {
      principal = { userId: actorId, tenantId, isSuperAdmin: false };
      db.product.findFirst.mockResolvedValue({ id: productId, tenantId });
      db.tenantMembership.findMany.mockResolvedValue([
        {
          userId: actorId,
          tenantId,
          role: {
            permissions: [{ permission: { subject: 'all', action: 'manage' } }],
          },
        },
      ]);
      expect((await get()).status).toBe(200);
      expect(reader.read).toHaveBeenCalledWith(
        { actorId, tenantId, productId },
        revision,
      );
    });

    test.each([
      [
        'a non-system "Super Admin" lookalike',
        () => [
          { ...superAdminRole([actorId]), isSystem: false, permissions: [] },
        ],
      ],
      [
        'a global role without membership',
        () => [superAdminRole(['someone-else'])],
      ],
      [
        'a tenant-scoped manage:all role',
        () => [{ ...globalManageAllRole([actorId]), tenantId }],
      ],
    ])('rejects %s before reading', async (_, stored) => {
      roles = stored();
      await rejected(get(), 403, 'FORBIDDEN');
    });
  });
});
