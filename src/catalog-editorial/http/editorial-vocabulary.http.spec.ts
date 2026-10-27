import { Global, Module, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import type { Request } from 'express';
import { ClsModule } from 'nestjs-cls';
import request from 'supertest';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { CatalogEditorialVocabularyModule } from '../catalog-editorial-vocabulary.module';

const path = '/catalog-editorial/vocabulary';
const grant = { subject: 'ProductEditorialDraft', action: 'read' };
const member = (permission = grant, tenantId = 'tenant') => ({
  userId: 'actor',
  tenantId,
  role: { permissions: [{ permission }] },
});
const db = {
  user: { findUnique: jest.fn() },
  tenantMembership: { findMany: jest.fn() },
  $queryRaw: jest.fn(),
};
let principal = { userId: 'actor', tenantId: 'tenant', isSuperAdmin: false };
@Global()
@Module({
  providers: [{ provide: PrismaService, useValue: db }],
  exports: [PrismaService],
})
class Database {}
describe('vocabulary HTTP', () => {
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
    principal = { userId: 'actor', tenantId: 'tenant', isSuperAdmin: false };
    db.user.findUnique.mockResolvedValue({ isActive: true });
    db.tenantMembership.findMany.mockResolvedValue([member()]);
    db.$queryRaw.mockResolvedValue([
      { snapshot: { families: [], definitions: [] } },
    ]);
  });
  const get = () =>
    request(app.getHttpServer() as Server)
      .get(path)
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
  it('returns empty company vocabulary using only principal scope', async () => {
    await check(get().set('x-tenant-id', 'foreign'), 200, {
      families: [],
      definitions: [],
    });
    expect(db.tenantMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'actor', tenantId: 'tenant' },
      }),
    );
  });
  it('preserves exact shapes, ordered ties, archives and null units', async () => {
    const definition = (code: string, type: string, extra = {}) => ({
      id: code,
      code,
      label: code,
      type,
      ...extra,
    });
    const binding = (code: string) => ({
      definitionId: code,
      definitionCode: code,
      owner: 'product',
      sortOrder: 0,
    });
    const unit = (code: string | null) => ({ code, label: code, sortOrder: 0 });
    const option = (code: string, archived: boolean) => ({
      code,
      label: code,
      archived,
      sortOrder: 0,
    });
    const snapshot = {
      families: ['a', 'b'].map((code) => ({
        id: code,
        code,
        label: 'Same',
        bindings: code === 'a' ? [binding('a'), binding('b')] : [],
      })),
      definitions: [
        definition('a', 'text'),
        definition('b', 'boolean'),
        definition('c', 'number', { units: [unit(null), unit('kg')] }),
        definition('d', 'single', {
          options: [option('a', true), option('b', false)],
        }),
        definition('e', 'multi', { options: [] }),
      ],
    };
    db.$queryRaw.mockResolvedValue([{ snapshot }]);
    await check(get(), 200, snapshot);
  });
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
    'missing',
    'nonmember',
    'foreign',
    'manage',
    'product',
    'update',
    'outage',
    'blank',
    'query',
    'readFailure',
  ])('handles %s', async (mode) => {
    if (mode === 'tenant' || mode === 'superadmin') principal.tenantId = '';
    if (mode === 'superadmin') principal.isSuperAdmin = true;
    if (mode === 'blank') principal.userId = ' ';
    if (mode === 'inactive')
      db.user.findUnique.mockResolvedValue({ isActive: false });
    if (mode === 'missing') db.user.findUnique.mockResolvedValue(null);
    if (mode === 'nonmember')
      db.tenantMembership.findMany.mockResolvedValue([]);
    if (mode === 'foreign')
      db.tenantMembership.findMany.mockResolvedValue([member(grant, 'other')]);
    if (['manage', 'product', 'update'].includes(mode)) {
      const subject = mode === 'product' ? 'Product' : grant.subject;
      const permission = {
        subject,
        action: mode === 'update' ? 'update' : 'read',
      };
      if (mode === 'manage')
        Object.assign(permission, { subject: 'all', action: 'manage' });
      db.tenantMembership.findMany.mockResolvedValue([member(permission)]);
    }
    if (mode === 'outage')
      db.user.findUnique.mockRejectedValue(new Error('secret'));
    if (mode === 'readFailure')
      db.$queryRaw.mockRejectedValue(new Error('secret'));
    const errors: Record<string, [number, string]> = {
      tenant: [401, 'UNAUTHORIZED'],
      query: [400, 'MALFORMED'],
      readFailure: [500, 'INTERNAL_ERROR'],
    };
    const [status, error] = errors[mode] ?? [403, 'FORBIDDEN'];
    const req = mode === 'query' ? get().query({ tenantId: 'foreign' }) : get();
    await check(req, status, { statusCode: status, error });
    if (mode !== 'readFailure') expect(db.$queryRaw).not.toHaveBeenCalled();
  });
});
