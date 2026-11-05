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
});
