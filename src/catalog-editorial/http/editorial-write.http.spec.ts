import { Global, Module, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
const emptyV2 = {
  schemaVersion: 2,
  commercialTitle: null,
  description: null,
  mediaRefs: [],
  familyCode: null,
  values: [],
  facts: [],
};
const metadata = { id: 'global', semanticsVersion: 'editorial-production-1' };
const currentR =
  'ev2-sha256-' +
  createHash('sha256')
    .update(
      JSON.stringify({
        contractVersion: 2,
        vocabulary: {
          definitions: [],
          families: [],
          semanticsVersion: metadata.semanticsVersion,
        },
      }),
    )
    .digest('hex');
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
import { EDITORIAL_SAVE_WRITER } from '../application/editorial-save-writer';
import { EDITORIAL_INITIALIZE_WRITER } from '../application/editorial-initialize-writer';
import { EDITORIAL_DISCARD_WRITER } from '../application/editorial-discard-writer';
import {
  EDITORIAL_PUBLISH_WRITER,
  EditorialPublicationNotReadyError,
} from '../application/editorial-publish-writer';
import type { EditorialContext } from '../application/catalog-editorial-core';
import type { ReceiptRequestV2 } from '../application/editorial-write-request-v2';
const revision = 'ev2-sha256-' + 'a'.repeat(64);

const productId = '11111111-1111-4111-8111-111111111111';
const tenantId = '22222222-2222-4222-8222-222222222222';
const actorId = '33333333-3333-4333-8333-333333333333';
const path = `/products/${productId}/editorial/draft`;
const core = {
  initialize: jest.fn(),
  save: jest.fn(),
  publish: jest.fn(),
  discard: jest.fn(),
};
type Operation = keyof typeof core;
const publishIntent = jest.fn();
const db = { $transaction: jest.fn() };
const raw = jest.fn();
const tx = {
  user: { findUnique: jest.fn() },
  tenantMembership: { findMany: jest.fn() },
  product: { findFirst: jest.fn() },
  $queryRaw: raw,
  $executeRaw: jest.fn().mockResolvedValue(1),
};
Object.assign(db, tx);
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
  if (mockCore) {
    builder.overrideProvider(EDITORIAL_INITIALIZE_WRITER).useValue({
      async initialize(
        context: EditorialContext,
        key: string,
        intent: ReceiptRequestV2,
      ) {
        const state: unknown = await core.initialize(context, {
          ...intent.body,
          idempotencyKey: key,
        });
        return {
          status: 201,
          body: { contractVersion: 2, vocabularyRevision: revision, state },
          headers: {
            'Editorial-Contract-Version': '2',
            'Editorial-Vocabulary-Revision': revision,
          },
        };
      },
    });
    builder.overrideProvider(EDITORIAL_SAVE_WRITER).useValue({
      async save(
        context: EditorialContext,
        key: string,
        intent: ReceiptRequestV2,
      ) {
        const state: unknown = await core.save(context, {
          ...intent.body,
          idempotencyKey: key,
        });
        return {
          status: 200,
          body: { contractVersion: 2, vocabularyRevision: revision, state },
          headers: {
            'Editorial-Contract-Version': '2',
            'Editorial-Vocabulary-Revision': revision,
          },
        };
      },
    });
    builder.overrideProvider(EDITORIAL_DISCARD_WRITER).useValue({
      async discard(
        context: EditorialContext,
        key: string,
        intent: ReceiptRequestV2,
      ) {
        const state: unknown = await core.discard(context, {
          ...intent.body,
          idempotencyKey: key,
        });
        return {
          status: 200,
          body: { contractVersion: 2, vocabularyRevision: revision, state },
          headers: {
            'Editorial-Contract-Version': '2',
            'Editorial-Vocabulary-Revision': revision,
          },
        };
      },
    });
    builder.overrideProvider(EDITORIAL_PUBLISH_WRITER).useValue({
      async publish(
        context: EditorialContext,
        key: string,
        intent: ReceiptRequestV2,
      ) {
        publishIntent(intent);
        const state: unknown = await core.publish(context, {
          ...intent.body,
          idempotencyKey: key,
        });
        return {
          status: 200,
          body: { contractVersion: 2, vocabularyRevision: revision, state },
          headers: {
            'Editorial-Contract-Version': '2',
            'Editorial-Vocabulary-Revision': revision,
          },
        };
      },
    });
  }
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
  test.each([
    ...['read', 'update', 'manage', 'both'].flatMap((grant) =>
      [false, true].map((available) => ({ grant, available, invalid: false })),
    ),
    { grant: 'manage', available: true, invalid: true },
    { grant: 'both', available: true, invalid: true },
  ])(
    'transaction-scoped $grant: sources=$available, invalid document=$invalid',
    async ({ grant, available, invalid }) => {
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
        if (invalid && operation === 'initialize') continue;
        const before = structuredClone(state);
        tx.$executeRaw.mockClear();
        raw
          .mockReset()
          .mockImplementation((sql: { sql: string } | readonly string[]) => {
            if (!available)
              return Promise.reject(new Error('gate unavailable'));
            if (Array.isArray(sql))
              return Promise.resolve([
                { snapshot: { metadata, families: [], definitions: [] } },
              ]);
            const query = sql as { sql: string };
            return Promise.resolve(
              query.sql.includes('FROM "products"')
                ? [{ id: productId }]
                : operation === 'save' &&
                    query.sql.includes('FROM "catalog_editorial_states"')
                  ? [
                      {
                        cycle: 1,
                        draftRevision: 1,
                        basePublishedRevision: null,
                        draftDocument: emptyV2,
                        published: null,
                      },
                    ]
                  : [],
            );
          });
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
                document: {
                  ...emptyV2,
                  mediaRefs: invalid ? ['unowned-asset'] : [],
                },
              };
        req.set('Editorial-Vocabulary-Revision', currentR);
        const response = await req
          .set('Authorization', 'Bearer synthetic')
          .set('Idempotency-Key', 'key')
          .send(body);
        const authorized = grant === 'both' || grant === 'manage';
        const admitted = authorized && available;
        const success = admitted && !invalid;
        const status = admitted
          ? invalid
            ? 400
            : operation === 'initialize'
              ? 201
              : 200
          : authorized
            ? 500
            : 403;
        expect(response.status).toBe(status);
        expect(response.body).toEqual(
          success
            ? operation === 'initialize'
              ? {
                  contractVersion: 2,
                  vocabularyRevision: currentR,
                  state: {
                    cycle: 1,
                    draft: {
                      revision: 1,
                      basePublishedRevision: null,
                      document: emptyV2,
                    },
                    published: null,
                  },
                }
              : {
                  contractVersion: 2,
                  vocabularyRevision: currentR,
                  state: {
                    cycle: 1,
                    draft: {
                      revision: 2,
                      basePublishedRevision: null,
                      document: emptyV2,
                    },
                    published: null,
                  },
                }
            : {
                statusCode: status,
                error: invalid
                  ? 'MALFORMED'
                  : status === 500
                    ? 'INTERNAL_ERROR'
                    : 'FORBIDDEN',
              },
        );
        expect(response.headers['cache-control']).toBe('no-store');
        expect(tx.$executeRaw).toHaveBeenCalledTimes(
          success ? 3 : invalid ? 1 : 0,
        );
        if (!admitted) expect(raw).toHaveBeenCalledTimes(authorized ? 1 : 0);
        if (invalid) {
          expect(state).toEqual(before);
          expect(raw).toHaveBeenCalledWith(
            expect.objectContaining({
              sql: expect.stringContaining(
                'FROM private_media_assets',
              ) as unknown,
              values: [tenantId, productId, 'unowned-asset'],
            }),
          );
        }
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
    tx.user.findUnique.mockResolvedValue({ isActive: true });
    tx.product.findFirst.mockResolvedValue({ id: productId, tenantId });
    tx.tenantMembership.findMany.mockResolvedValue([
      {
        userId: actorId,
        tenantId,
        role: {
          permissions: ['read', 'update', 'publish'].map((action) => ({
            permission: { subject: 'ProductEditorialDraft', action },
          })),
        },
      },
    ]);
    core.initialize.mockResolvedValue(state);
    core.save.mockResolvedValue(state);
    core.publish.mockResolvedValue({
      cycle: 1,
      draft: null,
      published: { revision: 1, document: emptyDocument() },
    });
    core.discard.mockResolvedValue({ cycle: 1, draft: null, published: null });
  });
  const send = (operation: Operation, body: object, key = 'key') => {
    const req =
      operation === 'save'
        ? request(app.getHttpServer() as Server).put(path)
        : request(app.getHttpServer() as Server).post(path + '/' + operation);
    return req
      .set('Editorial-Vocabulary-Revision', revision)
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
  for (const operation of [
    'initialize',
    'save',
    'publish',
    'discard',
  ] as const) {
    const body =
      operation === 'initialize'
        ? { expectedCycle: null }
        : operation === 'save'
          ? { expectedCycle: 1, expectedRevision: 1, document: emptyV2 }
          : { expectedCycle: 1, expectedRevision: 1 };
    test(`${operation} returns state and replay status using principal scope`, async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await send(operation, body).set(
          'x-tenant-id',
          'foreign',
        );
        expect(response.status).toBe(operation === 'initialize' ? 201 : 200);
        expect(response.body).toEqual(
          operation === 'publish'
            ? {
                contractVersion: 2,
                vocabularyRevision: revision,
                state: {
                  cycle: 1,
                  draft: null,
                  published: { revision: 1, document: emptyDocument() },
                },
              }
            : operation === 'discard'
              ? {
                  contractVersion: 2,
                  vocabularyRevision: revision,
                  state: { cycle: 1, draft: null, published: null },
                }
              : { contractVersion: 2, vocabularyRevision: revision, state },
        );
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
        operation === 'save'
          ? request(app.getHttpServer() as Server).put(
              '/products/bad/editorial/draft',
            )
          : request(app.getHttpServer() as Server).post(
              '/products/bad/editorial/draft/' + operation,
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
  for (const operation of ['publish', 'discard'] as const) {
    test.each([null, 0, 1.5, '1', undefined])(
      `${operation} rejects invalid or missing revision %p`,
      async (expectedRevision) => {
        await rejected(
          send(operation, { expectedCycle: 1, expectedRevision }),
          400,
          'MALFORMED',
        );
        expect(core[operation]).not.toHaveBeenCalled();
      },
    );
    test(`${operation} rejects null or missing cycle`, async () => {
      for (const body of [
        { expectedRevision: 1 },
        { expectedCycle: null, expectedRevision: 1 },
      ]) {
        await rejected(send(operation, body), 400, 'MALFORMED');
      }
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
  test('save requires a closed V2 shape but leaves fresh limits to the writer', async () => {
    await rejected(
      send('save', { expectedCycle: 1, expectedRevision: 1 }),
      400,
      'MALFORMED',
    );
    await rejected(
      send('save', {
        expectedCycle: 1,
        expectedRevision: 1,
        document: { untouched: 'x' },
      }),
      400,
      'MALFORMED',
    );
    expect(core.save).not.toHaveBeenCalled();
    const document = { ...emptyV2, commercialTitle: 'x'.repeat(201) };
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
  const publishing = () =>
    send('publish', { expectedCycle: 1, expectedRevision: 1 });
  test('publish returns the readiness items with an unready 400', async () => {
    const items = [
      {
        scope: 'definition',
        definitionCode: 'measure.net_mass',
        variantId: null,
        sectionCode: 'contenido-empaque',
        problem: 'REQUIRED_MISSING',
        message: 'Falta el peso neto.',
      },
    ];
    core.publish.mockRejectedValueOnce(
      new EditorialPublicationNotReadyError({
        items: items as never,
        bySection: { 'contenido-empaque': 1 },
      }),
    );
    const response = await publishing();
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      statusCode: 400,
      error: 'MALFORMED',
      items,
      bySection: { 'contenido-empaque': 1 },
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['editorial-contract-version']).toBe('2');
    expect(response.headers['editorial-vocabulary-revision']).toBeUndefined();
  });
  test('publish carries an exact care confirmation into the intent', async () => {
    await publishing();
    expect(publishIntent).toHaveBeenLastCalledWith(
      expect.objectContaining({ careConfirmation: null }),
    );
    expect(
      (await publishing().set('Editorial-Care-Confirmation', 'review-v1'))
        .status,
    ).toBe(200);
    expect(publishIntent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        careConfirmation: 'review-v1',
        vocabularyRevision: revision,
      }),
    );
  });
  test.each(['', 'review-v2', 'review-v1, review-v1'])(
    'publish rejects care confirmation %p',
    async (token) => {
      await rejected(
        publishing().set('Editorial-Care-Confirmation', token),
        400,
        'MALFORMED',
      );
      expect(core.publish).not.toHaveBeenCalled();
    },
  );
  test('publish rejects a duplicated care confirmation header', async () => {
    const req = publishing();
    req.set('Editorial-Care-Confirmation', 'review-v1');
    // supertest joins repeated set() values into one raw header per call.
    await rejected(
      req.set('editorial-care-confirmation', ['review-v1', 'review-v1']),
      400,
      'MALFORMED',
    );
    expect(core.publish).not.toHaveBeenCalled();
  });
  test.each(['Editorial-Contract-Version', 'Editorial-Adoption'])(
    'publish rejects obsolete %s',
    async (name) => {
      await rejected(publishing().set(name, '2'), 400, 'MALFORMED');
      expect(core.publish).not.toHaveBeenCalled();
    },
  );
  test('publish requires the vocabulary revision header', async () => {
    await rejected(
      publishing().unset('Editorial-Vocabulary-Revision'),
      400,
      'MALFORMED',
    );
    expect(core.publish).not.toHaveBeenCalled();
  });
  test('publish needs the publish grant, not update', async () => {
    tx.tenantMembership.findMany.mockResolvedValue([
      {
        userId: actorId,
        tenantId,
        role: {
          permissions: ['read', 'update'].map((action) => ({
            permission: { subject: 'ProductEditorialDraft', action },
          })),
        },
      },
    ]);
    await rejected(publishing(), 403, 'FORBIDDEN');
    tx.tenantMembership.findMany.mockResolvedValue([
      {
        userId: actorId,
        tenantId,
        role: {
          permissions: ['read', 'publish'].map((action) => ({
            permission: { subject: 'ProductEditorialDraft', action },
          })),
        },
      },
    ]);
    expect((await publishing()).status).toBe(200);
  });
});
