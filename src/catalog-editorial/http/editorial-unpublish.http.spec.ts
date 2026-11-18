import { Global, Module, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import request from 'supertest';
import type { Request } from 'express';
import type { Server } from 'node:http';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { createAppValidationPipe } from '../../shared/listing/app-validation.pipe';
import { CatalogEditorialReadModule } from '../catalog-editorial-read.module';
import { EDITORIAL_UNPUBLISH_WRITER } from '../application/editorial-unpublish-writer';
import type { ReceiptRequestV2 } from '../application/editorial-write-request-v2';
import type { EditorialContext } from '../application/catalog-editorial-core';
import { emptyDocument } from '../domain/document';

const revision = 'ev2-sha256-' + 'a'.repeat(64);
const productId = '11111111-1111-4111-8111-111111111111';
const tenantId = '22222222-2222-4222-8222-222222222222';
const actorId = '33333333-3333-4333-8333-333333333333';
const path = `/products/${productId}/editorial/published/unpublish`;
const body = { expectedCycle: 2, expectedRevision: 3 };
const unpublish = jest.fn();
const db = {
  $transaction: jest.fn(),
  user: { findUnique: jest.fn() },
  role: { findFirst: jest.fn() },
  tenantMembership: { findMany: jest.fn() },
  product: { findFirst: jest.fn() },
};
let tenant: string | null;
let superAdminClaim: boolean;

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
const kept = {
  revision: 4,
  basePublishedRevision: 3,
  document: emptyDocument(),
};

@Global()
@Module({
  providers: [{ provide: PrismaService, useValue: db }],
  exports: [PrismaService],
})
class TestDatabaseModule {}

const grant = (...actions: string[]) =>
  db.tenantMembership.findMany.mockResolvedValue([
    {
      userId: actorId,
      tenantId,
      role: {
        permissions: actions.map((action) => ({
          permission: { subject: 'ProductEditorialDraft', action },
        })),
      },
    },
  ]);

describe('POST /products/:productId/editorial/published/unpublish', () => {
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
          req.user = {
            userId: actorId,
            tenantId: tenant,
            isSuperAdmin: superAdminClaim,
          };
          return true;
        },
      })
      .overrideProvider(EDITORIAL_UNPUBLISH_WRITER)
      .useValue({
        unpublish: (
          context: EditorialContext,
          key: string,
          intent: ReceiptRequestV2,
        ) => unpublish(context, key, intent) as unknown,
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
    tenant = tenantId;
    superAdminClaim = false;
    roles = [];
    db.role.findFirst.mockImplementation(findGlobalRole);
    db.user.findUnique.mockResolvedValue({ isActive: true });
    db.product.findFirst.mockResolvedValue({ id: productId, tenantId });
    grant('read', 'publish');
    unpublish.mockResolvedValue({
      receiptVersion: 2,
      status: 200,
      body: {
        contractVersion: 2,
        vocabularyRevision: revision,
        state: { cycle: 2, draft: kept, published: null },
      },
      headers: {
        'Editorial-Contract-Version': '2',
        'Editorial-Vocabulary-Revision': revision,
      },
      careAttestation: null,
    });
  });
  const send = (payload: unknown = body, key = 'key') =>
    request(app.getHttpServer() as Server)
      .post(path)
      .set('Authorization', 'Bearer synthetic')
      .set('Editorial-Vocabulary-Revision', revision)
      .set('Idempotency-Key', key)
      .send(payload as object);
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

  it('returns 200 with Published removed and the draft kept, using principal scope', async () => {
    const response = await send().set('x-tenant-id', 'foreign');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      contractVersion: 2,
      vocabularyRevision: revision,
      state: { cycle: 2, draft: kept, published: null },
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['editorial-contract-version']).toBe('2');
    expect(response.headers['editorial-vocabulary-revision']).toBe(revision);
    expect(unpublish).toHaveBeenCalledWith(
      { actorId, tenantId, productId },
      'key',
      {
        receiptVersion: 2,
        contractVersion: 2,
        vocabularyRevision: revision,
        careConfirmation: null,
        body,
      },
    );
  });

  it('needs read + publish, not update', async () => {
    grant('read', 'update');
    await rejected(send(), 403, 'FORBIDDEN');
    grant('publish');
    await rejected(send(), 403, 'FORBIDDEN');
    expect(unpublish).not.toHaveBeenCalled();
    grant('read', 'publish');
    expect((await send()).status).toBe(200);
  });

  it('guards run before validation and the writer', async () => {
    await rejected(send({}).unset('Authorization'), 401, 'UNAUTHORIZED');
    tenant = ' ';
    await rejected(send({}), 403, 'FORBIDDEN');
    expect(unpublish).not.toHaveBeenCalled();
  });

  it.each([
    {},
    [],
    { expectedCycle: 2 },
    { expectedRevision: 3 },
    { ...body, extra: true },
    { ...body, expectedCycle: null },
    { ...body, expectedRevision: null },
    { ...body, expectedRevision: 0 },
    { ...body, expectedCycle: 1.5 },
    { ...body, expectedRevision: '3' },
  ])('rejects the non-closed body %p as MALFORMED', async (invalid) => {
    await rejected(send(invalid), 400, 'MALFORMED');
    expect(unpublish).not.toHaveBeenCalled();
  });

  it.each(['', 'x'.repeat(201)])(
    'rejects the idempotency key %p',
    async (key) => {
      await rejected(send(body, key), 400, 'MALFORMED');
      expect(unpublish).not.toHaveBeenCalled();
    },
  );

  it('requires the key and the vocabulary revision header', async () => {
    await rejected(send().unset('Idempotency-Key'), 400, 'MALFORMED');
    await rejected(
      send().unset('Editorial-Vocabulary-Revision'),
      400,
      'MALFORMED',
    );
    await rejected(
      send().set('Editorial-Vocabulary-Revision', 'ev2-sha256-bad'),
      400,
      'MALFORMED',
    );
    expect(unpublish).not.toHaveBeenCalled();
  });

  it.each([
    'Editorial-Care-Confirmation',
    'Editorial-Contract-Version',
    'Editorial-Adoption',
  ])('rejects the prohibited header %s', async (name) => {
    await rejected(send().set(name, 'review-v1'), 400, 'MALFORMED');
    expect(unpublish).not.toHaveBeenCalled();
  });

  it('rejects a query and a malformed product id', async () => {
    await rejected(send().query({ tenantId: 'x' }), 400, 'MALFORMED');
    await rejected(
      request(app.getHttpServer() as Server)
        .post('/products/bad/editorial/published/unpublish')
        .set('Authorization', 'Bearer synthetic')
        .set('Editorial-Vocabulary-Revision', revision)
        .set('Idempotency-Key', 'key')
        .send(body),
      400,
      'MALFORMED',
    );
    expect(unpublish).not.toHaveBeenCalled();
  });

  it.each([
    ['CONFLICT', 409],
    ['VOCABULARY_CHANGED', 409],
    ['FORBIDDEN', 403],
    ['NOT_FOUND', 404],
    ['secret persistence detail', 500],
  ] as const)('maps the writer failure %s', async (error, status) => {
    unpublish.mockRejectedValueOnce(new Error(error));
    await rejected(send(), status, status === 500 ? 'INTERNAL_ERROR' : error);
  });
  describe('global mode (positive)', () => {
    const productTenant = '44444444-4444-4444-8444-444444444444';
    const expectGlobalUnpublish = async () => {
      const response = await send().set('x-tenant-id', 'foreign');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        contractVersion: 2,
        vocabularyRevision: revision,
        state: { cycle: 2, draft: kept, published: null },
      });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['editorial-contract-version']).toBe('2');
      expect(response.headers['editorial-vocabulary-revision']).toBe(revision);
      // Tenant comes from the persisted Product, never from the request.
      expect(db.product.findFirst).toHaveBeenNthCalledWith(1, {
        where: { id: productId },
        select: { id: true, tenantId: true },
      });
      expect(unpublish).toHaveBeenCalledWith(
        { actorId, tenantId: productTenant, productId },
        'key',
        {
          receiptVersion: 2,
          contractVersion: 2,
          vocabularyRevision: revision,
          careConfirmation: null,
          body,
        },
      );
    };
    beforeEach(() => {
      tenant = null;
      superAdminClaim = true;
      // No membership in the Product's tenant: authority is the global role.
      db.tenantMembership.findMany.mockResolvedValue([]);
      db.product.findFirst.mockResolvedValue({
        id: productId,
        tenantId: productTenant,
      });
    });

    it('global Super Admin (system role, tenantId null) unpublishes any tenant Product', async () => {
      roles = [superAdminRole([actorId])];
      await expectGlobalUnpublish();
    });

    it('global manage:all role (tenantId null) unpublishes any tenant Product', async () => {
      roles = [globalManageAllRole([actorId])];
      await expectGlobalUnpublish();
    });

    it('Super Admin with a selected tenant unpublishes within that tenant only', async () => {
      roles = [superAdminRole([actorId])];
      tenant = tenantId;
      db.product.findFirst.mockResolvedValue({ id: productId, tenantId });
      expect((await send()).status).toBe(200);
      expect(db.product.findFirst).toHaveBeenNthCalledWith(1, {
        where: { id: productId, tenantId },
        select: { id: true, tenantId: true },
      });
      expect(unpublish).toHaveBeenCalledWith(
        { actorId, tenantId, productId },
        'key',
        expect.anything(),
      );
    });

    it('tenant role with manage:all unpublishes in its tenant (no exact publish grant)', async () => {
      tenant = tenantId;
      superAdminClaim = false;
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
      expect((await send()).status).toBe(200);
      expect(unpublish).toHaveBeenCalledWith(
        { actorId, tenantId, productId },
        'key',
        expect.anything(),
      );
    });

    it.each([
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
    ])('rejects %s before the writer', async (_, stored) => {
      roles = stored();
      await rejected(send(), 403, 'FORBIDDEN');
      expect(unpublish).not.toHaveBeenCalled();
    });
  });
});
