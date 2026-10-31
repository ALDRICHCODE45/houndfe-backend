import { ForbiddenException, Global, Module } from '@nestjs/common';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import type { Server } from 'node:http';
import { ClsModule } from 'nestjs-cls';
import request from 'supertest';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { CatalogEditorialReadModule } from '../catalog-editorial-read.module';
import { CatalogEditorialVocabularyModule } from '../catalog-editorial-vocabulary.module';
import { PrismaEditorialAuthority } from '../infrastructure/prisma-editorial-authority';
import type { EditorialContext } from '../application/catalog-editorial-core';
import { EDITORIAL_READER } from './editorial-read.controller';
import { EDITORIAL_DOCUMENT_READER } from '../application/editorial-document-reader';
import { EDITORIAL_SAVE_WRITER } from '../application/editorial-save-writer';
import { EDITORIAL_INITIALIZE_WRITER } from '../application/editorial-initialize-writer';
import { EDITORIAL_DISCARD_WRITER } from '../application/editorial-discard-writer';
import type { ReceiptRequestV2 } from '../application/editorial-write-request-v2';
const revision = 'ev2-sha256-' + 'a'.repeat(64);

const productId = '11111111-1111-4111-8111-111111111111';
const selected = 'selected';
const actual = 'persisted-product-tenant';
const actorId = 'actor';
const base = `/products/${productId}/editorial`;
const db = {
  user: { findUnique: jest.fn() },
  role: { findFirst: jest.fn() },
  tenantMembership: { findMany: jest.fn() },
  product: { findFirst: jest.fn() },
  $queryRaw: jest.fn(),
};
const state = { cycle: null, draft: null, published: null };
const dataRead = jest.fn();
const idOnly = ([query]: unknown[]) =>
  !Object.hasOwn((query as { where: object }).where, 'tenantId');
const core = Object.fromEntries(
  ['read', 'initialize', 'save', 'publish', 'discard'].map((operation) => [
    operation,
    jest.fn<Promise<typeof state>, [EditorialContext, unknown?]>(
      async (context) => {
        const access = await new PrismaEditorialAuthority(db as never).resolve(
          context,
        );
        const capability =
          operation === 'publish'
            ? 'canPublish'
            : operation === 'read'
              ? 'canRead'
              : operation === 'discard'
                ? 'canDiscard'
                : operation === 'save'
                  ? 'canSave'
                  : 'canCreate';
        if (!access?.[capability]) throw new ForbiddenException();
        dataRead(context);
        return state;
      },
    ),
  ]),
);
const documentReader = {
  read: jest.fn(
    async (context: EditorialContext, vocabularyRevision: string) => ({
      contractVersion: 2,
      vocabularyRevision,
      state: await core.read(context),
    }),
  ),
};
let principal: {
  userId: string;
  tenantId: string | null;
  isSuperAdmin: boolean;
};
@Global()
@Module({
  providers: [{ provide: PrismaService, useValue: db }],
  exports: [PrismaService],
})
class Database {}

// Registered controllers/scope/authorities, mocked business core: routing proof only.
// Existing coordinated-write HTTP tests separately exercise transactional admission.
describe('registered seven-route global editorial scope', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        Database,
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        CatalogEditorialReadModule,
        CatalogEditorialVocabularyModule,
      ],
    })
      .overrideProvider(EDITORIAL_READER)
      .useValue(core)
      .overrideProvider(EDITORIAL_INITIALIZE_WRITER)
      .useValue({
        async initialize(
          context: EditorialContext,
          key: string,
          intent: ReceiptRequestV2,
        ) {
          const value: unknown = await core.initialize(context, {
            ...intent.body,
            idempotencyKey: key,
          });
          return {
            status: 201,
            body: {
              contractVersion: 2,
              vocabularyRevision: revision,
              state: value,
            },
            headers: {
              'Editorial-Contract-Version': '2',
              'Editorial-Vocabulary-Revision': revision,
            },
          };
        },
      })
      .overrideProvider(EDITORIAL_SAVE_WRITER)
      .useValue({
        async save(
          context: EditorialContext,
          key: string,
          intent: ReceiptRequestV2,
        ) {
          const value: unknown = await core.save(context, {
            ...intent.body,
            idempotencyKey: key,
          });
          return {
            status: 200,
            body: {
              contractVersion: 2,
              vocabularyRevision: revision,
              state: value,
            },
            headers: {
              'Editorial-Contract-Version': '2',
              'Editorial-Vocabulary-Revision': revision,
            },
          };
        },
      })
      .overrideProvider(EDITORIAL_DISCARD_WRITER)
      .useValue({
        async discard(
          context: EditorialContext,
          key: string,
          intent: ReceiptRequestV2,
        ) {
          const value: unknown = await core.discard(context, {
            ...intent.body,
            idempotencyKey: key,
          });
          return {
            status: 200,
            body: {
              contractVersion: 2,
              vocabularyRevision: revision,
              state: value,
            },
            headers: {
              'Editorial-Contract-Version': '2',
              'Editorial-Vocabulary-Revision': revision,
            },
          };
        },
      })
      .overrideProvider(EDITORIAL_DOCUMENT_READER)
      .useValue(documentReader)
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          context.switchToHttp().getRequest<Request>().user = { ...principal };
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
    principal = { userId: actorId, tenantId: null, isSuperAdmin: true };
    db.user.findUnique.mockResolvedValue({ isActive: true });
    db.role.findFirst.mockResolvedValue({ id: 'persisted-global-role' });
    db.tenantMembership.findMany.mockResolvedValue([]);
    db.product.findFirst.mockResolvedValue({ id: productId, tenantId: actual });
    db.$queryRaw.mockImplementation((sql: { sql?: string }) =>
      Promise.resolve([
        sql.sql?.includes('FROM products p')
          ? { variants: [] }
          : {
              snapshot: {
                metadata: {
                  id: 'global',
                  semanticsVersion: 'editorial-production-1',
                },
                families: [],
                definitions: [],
              },
            },
      ]),
    );
  });
  const routes = [
    {
      operation: 'vocabulary',
      method: 'get',
      url: '/catalog-editorial/vocabulary',
      body: undefined,
    },
    { operation: 'read', method: 'get', url: base, body: undefined },
    {
      operation: 'context',
      method: 'get',
      url: base + '/context',
      body: undefined,
    },
    {
      operation: 'initialize',
      method: 'post',
      url: base + '/draft/initialize',
      body: { expectedCycle: null },
    },
    {
      operation: 'save',
      method: 'put',
      url: base + '/draft',
      body: {
        expectedCycle: 1,
        expectedRevision: 1,
        document: {
          schemaVersion: 2,
          commercialTitle: null,
          description: null,
          mediaRefs: [],
          familyCode: null,
          values: [],
          facts: [],
        },
      },
    },
    {
      operation: 'publish',
      method: 'post',
      url: base + '/draft/publish',
      body: { expectedCycle: 1, expectedRevision: 1 },
    },
    {
      operation: 'discard',
      method: 'post',
      url: base + '/draft/discard',
      body: { expectedCycle: 1, expectedRevision: 1 },
    },
  ] as const;
  for (const route of routes) {
    const send = (body: object | undefined = route.body) => {
      const req = request(app.getHttpServer() as Server)
        [route.method](route.url)
        .set('x-tenant-id', 'untrusted');
      if (route.operation === 'read')
        req.set('Editorial-Vocabulary-Revision', revision);
      else if (route.operation !== 'vocabulary')
        req.set('Idempotency-Key', 'key');
      if (
        route.operation === 'discard' ||
        route.operation === 'initialize' ||
        route.operation === 'save'
      )
        req.set('Editorial-Vocabulary-Revision', revision);
      return body === undefined ? req : req.send(body);
    };
    const deny = async (req: PromiseLike<request.Response>, status = 403) => {
      const before = structuredClone(state);
      const response = await req;
      expect(response.status).toBe(status);
      expect(response.body).toEqual({
        statusCode: status,
        error:
          status === 400
            ? 'MALFORMED'
            : status === 401
              ? 'UNAUTHORIZED'
              : 'FORBIDDEN',
      });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['editorial-contract-version']).toBe('2');
      expect(response.headers['editorial-vocabulary-revision']).toBeUndefined();
      expect(dataRead).not.toHaveBeenCalled();
      expect(db.$queryRaw).not.toHaveBeenCalled();
      expect(state).toEqual(before);
    };
    test(`${route.operation}: active persisted global/null resolves only server scope`, async () => {
      const response = await send();
      expect(response.status).toBe(
        route.operation === 'initialize' ? 201 : 200,
      );
      expect(response.body).toEqual(
        route.operation === 'vocabulary'
          ? {
              contractVersion: 2,
              vocabularyRevision: expect.stringMatching(
                /^ev2-sha256-[0-9a-f]{64}$/,
              ) as string,
              vocabulary: {
                semanticsVersion: 'editorial-production-1',
                families: [],
                definitions: [],
              },
            }
          : route.operation === 'context'
            ? { variants: [] }
            : route.operation === 'read' ||
                route.operation === 'discard' ||
                route.operation === 'initialize' ||
                route.operation === 'save'
              ? { contractVersion: 2, vocabularyRevision: revision, state }
              : state,
      );
      expect(response.headers['cache-control']).toBe('no-store');
      expect(db.role.findFirst).toHaveBeenCalledWith({
        where: {
          tenantId: null,
          tenantMemberships: { some: { userId: actorId } },
          OR: [
            { isSystem: true, name: 'Super Admin' },
            {
              permissions: {
                some: { permission: { subject: 'all', action: 'manage' } },
              },
            },
          ],
        },
        select: { id: true },
      });
      if (route.operation === 'vocabulary') {
        expect(db.product.findFirst).not.toHaveBeenCalled();
        expect(db.tenantMembership.findMany).not.toHaveBeenCalled();
      } else {
        expect(db.product.findFirst).toHaveBeenCalledWith({
          where: { id: productId },
          select: { id: true, tenantId: true },
        });
        if (route.operation === 'context')
          expect(db.$queryRaw).toHaveBeenCalledWith(
            expect.objectContaining({ values: [actual, productId] }),
          );
        else {
          const context = { actorId, tenantId: actual, productId };
          if (route.body)
            expect(core[route.operation]).toHaveBeenCalledWith(context, {
              ...route.body,
              idempotencyKey: 'key',
            });
          else {
            expect(core[route.operation]).toHaveBeenCalledWith(context);
            expect(documentReader.read).toHaveBeenCalledWith(context, revision);
          }
        }
      }
    });
    test.each([
      'stale',
      'inactive',
      'missing-actor',
      'role-lookalike',
      'proof-outage',
      'actor-outage',
      'blank-actor',
      'blank-tenant',
      'no-global-flag',
    ])(
      `${route.operation}: rejects %s before Product/data access`,
      async (mode) => {
        if (mode === 'stale' || mode === 'role-lookalike')
          db.role.findFirst.mockResolvedValue(null);
        if (mode === 'inactive')
          db.user.findUnique.mockResolvedValue({ isActive: false });
        if (mode === 'missing-actor')
          db.user.findUnique.mockResolvedValue(null);
        if (mode === 'proof-outage')
          db.role.findFirst.mockRejectedValue(new Error('private'));
        if (mode === 'actor-outage')
          db.user.findUnique.mockRejectedValue(new Error('private'));
        if (mode === 'blank-actor') principal.userId = ' ';
        if (mode === 'blank-tenant') principal.tenantId = ' ';
        if (mode === 'no-global-flag') principal.isSuperAdmin = false;
        await deny(send(), mode === 'no-global-flag' ? 401 : 403);
        expect(db.product.findFirst).not.toHaveBeenCalled();
        for (const method of Object.values(core))
          expect(method).not.toHaveBeenCalled();
      },
    );
    test(`${route.operation}: selected global context never infers a foreign tenant`, async () => {
      principal.tenantId = selected;
      if (route.operation === 'vocabulary') {
        expect((await send()).status).toBe(200);
        expect(db.product.findFirst).not.toHaveBeenCalled();
      } else {
        await deny(send());
        expect(db.product.findFirst).toHaveBeenCalledWith({
          where: { id: productId, tenantId: selected },
          select: { id: true, tenantId: true },
        });
      }
      expect(db.product.findFirst.mock.calls.some(idOnly)).toBe(false);
    });
    test.each(['exact', 'wildcard'])(
      `${route.operation}: selected %s grant stays tenant-local`,
      async (kind) => {
        principal = { ...principal, tenantId: selected, isSuperAdmin: false };
        db.role.findFirst.mockResolvedValue(null);
        db.tenantMembership.findMany.mockResolvedValue([
          {
            userId: actorId,
            tenantId: selected,
            role: {
              permissions: (kind === 'wildcard'
                ? [{ subject: 'all', action: 'manage' }]
                : ['read', 'update', 'publish'].map((action) => ({
                    subject: 'ProductEditorialDraft',
                    action,
                  }))
              ).map((permission) => ({ permission })),
            },
          },
        ]);
        if (route.operation !== 'vocabulary') await deny(send());
        db.product.findFirst.mockResolvedValue({
          id: productId,
          tenantId: selected,
        });
        expect((await send()).status).toBe(
          route.operation === 'initialize' ? 201 : 200,
        );
        expect(db.product.findFirst.mock.calls.some(idOnly)).toBe(false);
      },
    );
    test(`${route.operation}: tenant query/body cannot override verified global scope`, async () => {
      await deny(send().query({ tenantId: selected }), 400);
      await deny(send({ ...(route.body ?? {}), tenantId: selected }), 400);
      if (
        route.operation === 'read' ||
        route.operation === 'discard' ||
        route.operation === 'initialize' ||
        route.operation === 'save'
      ) {
        expect(db.product.findFirst).toHaveBeenCalled();
        expect(db.user.findUnique).toHaveBeenCalled();
        expect(documentReader.read).not.toHaveBeenCalled();
      } else {
        expect(db.product.findFirst).not.toHaveBeenCalled();
        expect(db.user.findUnique).not.toHaveBeenCalled();
      }
    });
    if (route.body)
      test(`${route.operation}: malformed key preserves operation-specific authority precedence`, async () => {
        await deny(send().unset('Idempotency-Key'), 400);
        if (
          route.operation === 'discard' ||
          route.operation === 'initialize' ||
          route.operation === 'save'
        ) {
          expect(db.user.findUnique).toHaveBeenCalled();
          expect(db.product.findFirst).toHaveBeenCalled();
        } else {
          expect(db.user.findUnique).not.toHaveBeenCalled();
          expect(db.product.findFirst).not.toHaveBeenCalled();
        }
      });
    test(`${route.operation}: persisted global revocation is rechecked`, async () => {
      expect((await send()).status).toBe(
        route.operation === 'initialize' ? 201 : 200,
      );
      dataRead.mockClear();
      db.$queryRaw.mockClear();
      db.product.findFirst.mockClear();
      db.role.findFirst.mockResolvedValue(null);
      await deny(send());
      expect(db.product.findFirst).not.toHaveBeenCalled();
    });
    if (route.operation !== 'vocabulary')
      test.each(['missing', 'blank-tenant', 'wrong-id', 'outage'])(
        `${route.operation}: Product lookup %s fails closed`,
        async (mode) => {
          if (mode === 'missing') db.product.findFirst.mockResolvedValue(null);
          if (mode === 'blank-tenant')
            db.product.findFirst.mockResolvedValue({
              id: productId,
              tenantId: ' ',
            });
          if (mode === 'wrong-id')
            db.product.findFirst.mockResolvedValue({
              id: 'foreign',
              tenantId: actual,
            });
          if (mode === 'outage')
            db.product.findFirst.mockRejectedValue(new Error('private'));
          await deny(send());
          for (const method of Object.values(core))
            expect(method).not.toHaveBeenCalled();
        },
      );
  }
});
