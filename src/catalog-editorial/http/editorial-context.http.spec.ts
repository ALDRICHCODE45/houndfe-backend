import { Global, Module, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import type { Server } from 'node:http';
import { ClsModule } from 'nestjs-cls';
import request from 'supertest';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { CatalogEditorialVocabularyModule } from '../catalog-editorial-vocabulary.module';

const productId = '11111111-1111-4111-8111-111111111111';
const tenantId = '22222222-2222-4222-8222-222222222222';
const actorId = '33333333-3333-4333-8333-333333333333';
const path = `/products/${productId}/editorial/context`;
const grant = { subject: 'ProductEditorialDraft', action: 'read' };
const member = (permission = grant, tenant = tenantId) => ({
  userId: actorId,
  tenantId: tenant,
  role: { permissions: [{ permission }] },
});
const db = {
  user: { findUnique: jest.fn() },
  tenantMembership: { findMany: jest.fn() },
  product: { findFirst: jest.fn() },
  $queryRaw: jest.fn(),
};
let principal = { userId: actorId, tenantId, isSuperAdmin: false };
@Global()
@Module({
  providers: [{ provide: PrismaService, useValue: db }],
  exports: [PrismaService],
})
class Database {}
describe('editorial context HTTP', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        Database,
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        CatalogEditorialVocabularyModule,
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
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    principal = { userId: actorId, tenantId, isSuperAdmin: false };
    db.user.findUnique.mockResolvedValue({ isActive: true });
    db.tenantMembership.findMany.mockResolvedValue([member()]);
    db.product.findFirst.mockResolvedValue({ id: productId, tenantId });
    db.$queryRaw.mockResolvedValue([{ variants: [] }]);
  });
  const get = (url = path) =>
    request(app.getHttpServer() as Server)
      .get(url)
      .set('Authorization', 'Bearer synthetic');
  const check = async (
    response: PromiseLike<request.Response>,
    status: number,
    body: unknown,
  ) => {
    const result = await response;
    expect(result.status).toBe(status);
    expect(result.body).toEqual(body);
    expect(result.headers['cache-control']).toBe('no-store');
  };
  it('returns [] using principal scope, ignoring the hasVariants flag', async () => {
    db.product.findFirst.mockResolvedValue({
      id: productId,
      tenantId,
      hasVariants: true,
    });
    await check(get().set('x-tenant-id', 'foreign'), 200, { variants: [] });
    expect(db.product.findFirst).toHaveBeenCalledWith({
      where: { id: productId, tenantId },
      select: { id: true, tenantId: true },
    });
    expect(db.tenantMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: actorId, tenantId } }),
    );
  });
  it('returns the complete id/name list with duplicate names ordered by id', async () => {
    const variants = ['a', 'b', 'c'].map((id) => ({
      id,
      name: id === 'c' ? 'Z' : 'Same',
    }));
    db.product.findFirst.mockResolvedValue({
      id: productId,
      tenantId,
      hasVariants: false,
    });
    db.$queryRaw.mockResolvedValue([{ variants }]);
    await check(get(), 200, { variants });
  });
  it.each(['{"tenantId":"foreign"}', '[]'])(
    'rejects unexpected decoded body %s',
    async (body) => {
      const req = get().set('Content-Type', 'application/json').send(body);
      await check(req, 400, { statusCode: 400, error: 'MALFORMED' });
      expect(db.user.findUnique).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, 'Bearer invalid'])('rejects token %s', async (token) => {
    const req = request(app.getHttpServer() as Server).get(path);
    if (token) req.set('Authorization', token);
    await check(req, 401, { statusCode: 401, error: 'UNAUTHORIZED' });
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });
  it.each([
    'tenant',
    'superadmin',
    'inactive',
    'missingActor',
    'nonmember',
    'foreignMember',
    'manage',
    'productOnly',
    'updateOnly',
    'outage',
    'blankActor',
    'foreignProduct',
    'missingProduct',
    'vanished',
    'query',
    'uuid',
    'readFailure',
  ])('handles %s without leaking data', async (mode) => {
    if (mode === 'tenant' || mode === 'superadmin') principal.tenantId = '';
    if (mode === 'superadmin') principal.isSuperAdmin = true;
    if (mode === 'blankActor') principal.userId = ' ';
    if (mode === 'inactive')
      db.user.findUnique.mockResolvedValue({ isActive: false });
    if (mode === 'missingActor') db.user.findUnique.mockResolvedValue(null);
    if (mode === 'nonmember')
      db.tenantMembership.findMany.mockResolvedValue([]);
    if (mode === 'foreignMember')
      db.tenantMembership.findMany.mockResolvedValue([member(grant, 'other')]);
    const permissions: Record<string, typeof grant> = {
      manage: { subject: 'all', action: 'manage' },
      productOnly: { subject: 'Product', action: 'read' },
      updateOnly: { subject: grant.subject, action: 'update' },
    };
    if (permissions[mode])
      db.tenantMembership.findMany.mockResolvedValue([
        member(permissions[mode]),
      ]);
    if (mode === 'outage')
      db.tenantMembership.findMany.mockRejectedValue(new Error('secret'));
    if (mode === 'foreignProduct')
      db.product.findFirst.mockResolvedValue({
        id: productId,
        tenantId: 'other',
      });
    if (mode === 'missingProduct') db.product.findFirst.mockResolvedValue(null);
    if (mode === 'vanished') db.$queryRaw.mockResolvedValue([]);
    if (mode === 'readFailure')
      db.$queryRaw.mockRejectedValue(new Error('secret'));
    const errors: Record<string, [number, string]> = {
      tenant: [401, 'UNAUTHORIZED'],
      vanished: [404, 'NOT_FOUND'],
      query: [400, 'MALFORMED'],
      uuid: [400, 'MALFORMED'],
      readFailure: [500, 'INTERNAL_ERROR'],
    };
    const [status, error] = errors[mode] ?? [403, 'FORBIDDEN'];
    let req = get(mode === 'uuid' ? path.replace(productId, 'invalid') : path);
    if (mode === 'query') req = req.query({ productId: 'foreign' });
    await check(req, status, { statusCode: status, error });
    if (!['vanished', 'readFailure'].includes(mode))
      expect(db.$queryRaw).not.toHaveBeenCalled();
    if (['uuid', 'query'].includes(mode))
      expect(db.user.findUnique).not.toHaveBeenCalled();
  });
});
