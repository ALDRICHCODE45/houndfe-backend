import { Global, Module } from '@nestjs/common';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import type { Request } from 'express';
import { ClsModule } from 'nestjs-cls';
import request from 'supertest';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { CatalogEditorialReadModule } from '../catalog-editorial-read.module';

const productId = '11111111-1111-4111-8111-111111111111';
const tenantId = 'tenant';
const actorId = 'actor';
const body = { expectedCycle: 3, expectedRevision: 7 };
const vocabulary = {
  definitions: [],
  families: [],
  semanticsVersion: 'editorial-production-1',
};
// Independent canonical JSON oracle for this empty, ASCII vocabulary.
const revision =
  'ev2-sha256-' +
  createHash('sha256')
    .update(JSON.stringify({ contractVersion: 2, vocabulary }))
    .digest('hex');
const intent = {
  receiptVersion: 2,
  contractVersion: 2,
  vocabularyRevision: revision,
  careConfirmation: null,
  body,
};
const published = {
  revision: 11,
  document: {
    schemaVersion: 2,
    commercialTitle: null,
    description: '',
    mediaRefs: ['historical-media'],
    familyCode: null,
    values: [],
    facts: [],
  },
};
const result = {
  receiptVersion: 2,
  status: 200,
  body: {
    contractVersion: 2,
    vocabularyRevision: revision,
    state: { cycle: 3, draft: null, published },
  },
  headers: {
    'Editorial-Contract-Version': '2',
    'Editorial-Vocabulary-Revision': revision,
  },
  careAttestation: null,
};
type Query = { sql: string; values: unknown[] };
const authority = () => ({
  user: { findUnique: jest.fn() },
  role: { findFirst: jest.fn() },
  tenantMembership: { findMany: jest.fn() },
  product: { findFirst: jest.fn() },
});
const tx = { ...authority(), $queryRaw: jest.fn(), $executeRaw: jest.fn() };
const db = { ...authority(), $transaction: jest.fn(), $queryRaw: jest.fn() };
let events: string[];
let stored: { cycle: number; draftRevision: number | null; published: unknown };
let receipt: { request: unknown; result: unknown } | null;
let fail: string;
let snapshot: unknown;
@Global()
@Module({
  providers: [{ provide: PrismaService, useValue: db }],
  exports: [PrismaService],
})
class Database {}

// Real registration/controller/authority/transaction/codecs; only JWT/Prisma I/O replaced.
// This verifies SQL intent and ordering, NOT PostgreSQL blocking or rollback.
describe('registered V2 discard composition', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        Database,
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        CatalogEditorialReadModule,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          context.switchToHttp().getRequest<Request>().user = {
            userId: actorId,
            tenantId,
            isSuperAdmin: false,
          };
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
    jest.resetAllMocks();
    events = [];
    fail = '';
    receipt = null;
    stored = {
      cycle: 3,
      draftRevision: 7,
      published: JSON.parse(JSON.stringify(published)) as unknown,
    };
    snapshot = {
      metadata: { id: 'global', semanticsVersion: 'editorial-production-1' },
      families: [],
      definitions: [],
    };
    for (const client of [db, tx]) {
      client.user.findUnique.mockResolvedValue({ isActive: true });
      client.role.findFirst.mockResolvedValue(null);
      client.product.findFirst.mockResolvedValue({ id: productId, tenantId });
      client.tenantMembership.findMany.mockResolvedValue([
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
    }
    db.$transaction.mockImplementation(
      async (work: (client: unknown) => Promise<unknown>) => {
        events.push('begin');
        try {
          const value = await work(tx);
          if (fail === 'commit') throw new Error('private commit detail');
          events.push('commit');
          return value;
        } catch (error) {
          events.push('reject');
          throw error;
        }
      },
    );
    tx.$queryRaw.mockImplementation((query: Query | readonly string[]) => {
      const sql = Array.isArray(query) ? query.join('') : (query as Query).sql;
      const kind = sql.includes('AS snapshot')
        ? 'snapshot'
        : sql.includes('FROM "products"')
          ? 'product'
          : sql.includes('FROM "catalog_editorial_discard_receipts"')
            ? 'receipt'
            : 'state';
      events.push(kind);
      if (fail === kind) throw new Error('private SQL detail');
      if (kind === 'snapshot') return Promise.resolve([{ snapshot }]);
      if (kind === 'product')
        return Promise.resolve(
          fail === 'disappeared' ? [] : [{ id: productId }],
        );
      if (kind === 'receipt')
        return Promise.resolve(
          receipt
            ? [
                {
                  matches:
                    (query as Query).values[0] ===
                    JSON.stringify(receipt.request),
                  result: receipt.result,
                },
              ]
            : [],
        );
      return Promise.resolve(fail === 'absent' ? [] : [stored]);
    });
    tx.$executeRaw.mockImplementation((query: Query) => {
      const kind = query.sql.includes('LOCK TABLE')
        ? 'lock'
        : query.sql.includes('UPDATE ')
          ? 'update'
          : 'insert';
      events.push(kind);
      if (fail === kind) throw new Error('private database failure');
      return Promise.resolve(fail === kind + '-count' ? 0 : 1);
    });
  });
  const send = (input: object = body) =>
    request(app.getHttpServer() as Server)
      .post(`/products/${productId}/editorial/draft/discard`)
      .set('Idempotency-Key', 'key')
      .set('Editorial-Vocabulary-Revision', revision)
      .send(input);
  function check(response: request.Response, status: number, value: unknown) {
    expect(response.status).toBe(status);
    expect(response.body).toEqual(value);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['editorial-contract-version']).toBe('2');
    expect(response.headers['editorial-vocabulary-revision']).toBe(
      status === 200 ? revision : undefined,
    );
  }
  async function rejected(
    req: PromiseLike<request.Response>,
    status: number,
    error: string,
  ) {
    const before = structuredClone({ stored, receipt });
    check(await req, status, { statusCode: status, error });
    expect({ stored, receipt }).toEqual(before);
    expect(events).not.toContain('commit');
  }
  it('commits direct V2 acknowledgement after complete lock/snapshot and unchanged Published', async () => {
    check(await send(), 200, result.body);
    expect(events).toEqual([
      'begin',
      'product',
      'receipt',
      'state',
      'lock',
      'snapshot',
      'update',
      'insert',
      'commit',
    ]);
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'ReadCommitted',
    });
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(tx.user.findUnique).toHaveBeenCalledTimes(1);
    const queries = tx.$queryRaw.mock.calls.map(([query]: [Query]) => query);
    expect(queries[0]).toEqual(
      expect.objectContaining({
        sql: expect.stringContaining('FOR UPDATE') as unknown,
        values: [tenantId, productId],
      }),
    );
    expect(queries[1]).toEqual(
      expect.objectContaining({
        sql: expect.stringContaining('CAST(') as unknown,
        values: [JSON.stringify(intent), tenantId, productId, actorId, 'key'],
      }),
    );
    expect(queries[2].sql).not.toContain('"draftDocument"');
    const [lock, update, insert] = tx.$executeRaw.mock.calls.map(
      ([query]: [Query]) => query,
    );
    expect(lock.sql.replace(/\s+/g, ' ').trim()).toBe(
      'LOCK TABLE "editorial_families", "editorial_definitions", "editorial_bindings", "editorial_options", "editorial_units", "editorial_groups", "editorial_group_members", "editorial_aliases", "editorial_vocabulary_metadata" IN SHARE MODE',
    );
    expect(lock.values).toEqual([]);
    expect(update.sql).toContain(
      '"draftRevision" = NULL, "draftDocument" = NULL, "basePublishedRevision" = NULL',
    );
    expect(update.sql).not.toMatch(
      /"(?:publishedDocument|publishedRevision)"\s*=/,
    );
    expect(update.values).toEqual([tenantId, productId, 3, 7]);
    expect(insert.values).toEqual([
      tenantId,
      productId,
      actorId,
      'key',
      JSON.stringify(intent),
      JSON.stringify(result),
    ]);
  });
  it.each(['inactive', 'read-only', 'update-only', 'foreign', 'outage'])(
    'denies %s before malformed intent',
    async (mode) => {
      if (mode === 'inactive')
        db.user.findUnique.mockResolvedValue({ isActive: false });
      if (mode === 'foreign')
        db.product.findFirst.mockResolvedValue({
          id: productId,
          tenantId: 'other',
        });
      if (mode === 'outage')
        db.user.findUnique.mockRejectedValue(new Error('private'));
      if (mode.endsWith('-only'))
        db.tenantMembership.findMany.mockResolvedValue([
          {
            userId: actorId,
            tenantId,
            role: {
              permissions: [
                {
                  permission: {
                    subject: 'ProductEditorialDraft',
                    action: mode.split('-')[0],
                  },
                },
              ],
            },
          },
        ]);
      await rejected(send({}).unset('Idempotency-Key'), 403, 'FORBIDDEN');
      expect(db.$transaction).not.toHaveBeenCalled();
    },
  );
  it('rechecks persisted authority inside the transaction', async () => {
    tx.user.findUnique.mockResolvedValue({ isActive: false });
    await rejected(send(), 403, 'FORBIDDEN');
    expect(events).toEqual(['begin', 'reject']);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
  it.each([
    'Editorial-Care-Confirmation',
    'Editorial-Adoption',
    'Editorial-Contract-Version',
  ])('rejects even empty forbidden %s', async (name) => {
    await rejected(send().set(name, ''), 400, 'MALFORMED');
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it.each(['Editorial-Vocabulary-Revision', 'Idempotency-Key'])(
    'requires exactly one %s',
    async (name) => {
      const value = name === 'Idempotency-Key' ? 'key' : revision;
      for (const invalid of ['', [value, value], value + ', ' + value]) {
        await rejected(send().set(name, invalid as string), 400, 'MALFORMED');
      }
      await rejected(send().unset(name), 400, 'MALFORMED');
      expect(db.$transaction).not.toHaveBeenCalled();
    },
  );
  it.each([
    {},
    [],
    { ...body, extra: true },
    { ...body, expectedCycle: null },
    { ...body, expectedRevision: 0 },
    { ...body, expectedRevision: 1.5 },
    { ...body, expectedRevision: '7' },
  ])('rejects closed transition %p', async (input) => {
    await rejected(send(input), 400, 'MALFORMED');
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('rejects query, noncanonical R and oversized key', async () => {
    await rejected(send().query({ tenantId: 'other' }), 400, 'MALFORMED');
    for (const r of [
      revision.toUpperCase(),
      revision.slice(1),
      revision.replace('sha256', 'sha 256'),
    ])
      await rejected(
        send().set('Editorial-Vocabulary-Revision', r),
        400,
        'MALFORMED',
      );
    await rejected(
      send().set('Idempotency-Key', 'k'.repeat(201)),
      400,
      'MALFORMED',
    );
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it.each(['a  b', 'k'.repeat(200)])(
    'preserves admitted key %p',
    async (key) => {
      check(await send().set('Idempotency-Key', key), 200, result.body);
      expect((tx.$queryRaw.mock.calls as [Query][])[1][0].values).toEqual([
        JSON.stringify(intent),
        tenantId,
        productId,
        actorId,
        key,
      ]);
    },
  );
  it.each([undefined, [], ['second', 'first']])(
    'replays recorded warnings %p before stale CAS and unavailable vocabulary',
    async (codes) => {
      const recorded = JSON.parse(JSON.stringify(result)) as typeof result;
      if (codes !== undefined)
        Object.assign(recorded.body.state, {
          warnings: codes.map((optionCode) => ({
            code: 'ARCHIVED_OPTION',
            familyId: 'old',
            definitionId: 'old',
            owner: 'product',
            variantId: null,
            optionCode,
          })),
        });
      receipt = { request: intent, result: recorded };
      stored.cycle = 99;
      fail = 'snapshot';
      check(await send(), 200, recorded.body);
      expect(events).toEqual(['begin', 'product', 'receipt', 'commit']);
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    },
  );
  it.each(['revision', 'body', 'legacy'])(
    'rejects same-key changed %s identity',
    async (mode) => {
      receipt = {
        request:
          mode === 'legacy'
            ? body
            : {
                ...intent,
                ...(mode === 'revision'
                  ? { vocabularyRevision: 'ev2-sha256-' + 'a'.repeat(64) }
                  : { body: { ...body, expectedRevision: 8 } }),
              },
        result,
      };
      await rejected(send(), 409, 'CONFLICT');
      expect(events).toEqual(['begin', 'product', 'receipt', 'reject']);
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    },
  );
  it.each(['legacy', 'status', 'revision', 'attestation'])(
    'rejects corrupt recorded %s without mutation',
    async (mode) => {
      const recorded = JSON.parse(JSON.stringify(result)) as typeof result;
      if (mode === 'status') recorded.status = 201;
      if (mode === 'revision')
        recorded.headers['Editorial-Vocabulary-Revision'] =
          'ev2-sha256-' + 'b'.repeat(64);
      if (mode === 'attestation')
        Object.assign(recorded, { careAttestation: {} });
      receipt = {
        request: intent,
        result: mode === 'legacy' ? result.body.state : recorded,
      };
      await rejected(send(), 500, 'INTERNAL_ERROR');
      expect(events).toEqual(['begin', 'product', 'receipt', 'reject']);
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    },
  );
  it.each(['absent', 'cycle', 'revision', 'no-draft', 'unbounded'])(
    'checks %s CAS before vocabulary',
    async (mode) => {
      if (mode === 'absent') fail = 'absent';
      if (mode === 'cycle') stored.cycle++;
      if (mode === 'revision') stored.draftRevision = 8;
      if (mode === 'no-draft') stored.draftRevision = null;
      await rejected(
        send(
          mode === 'unbounded'
            ? { ...body, expectedRevision: 2147483648 }
            : body,
        ),
        409,
        'CONFLICT',
      );
      expect(events).toEqual([
        'begin',
        'product',
        'receipt',
        'state',
        'reject',
      ]);
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    },
  );
  it('rejects disappearance after authority without receipt access', async () => {
    fail = 'disappeared';
    await rejected(send(), 404, 'NOT_FOUND');
    expect(events).toEqual(['begin', 'product', 'reject']);
  });
  it('checks R from fresh complete metadata before mutation', async () => {
    await rejected(
      send().set(
        'Editorial-Vocabulary-Revision',
        'ev2-sha256-' + 'a'.repeat(64),
      ),
      409,
      'VOCABULARY_CHANGED',
    );
    expect(events).toEqual([
      'begin',
      'product',
      'receipt',
      'state',
      'lock',
      'snapshot',
      'reject',
    ]);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });
  it('rejects unrepresentable metadata without mutation', async () => {
    snapshot = { metadata: null, families: [], definitions: [] };
    await rejected(send(), 500, 'EDITORIAL_VOCABULARY_UNREPRESENTABLE');
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });
  it.each([
    null,
    { revision: 11, document: null },
    { revision: 11, document: {} },
  ])('handles surviving Published %p structurally', async (value) => {
    stored.published = value;
    if (value === null)
      check(await send(), 200, {
        ...result.body,
        state: { cycle: 3, draft: null, published: null },
      });
    else {
      await rejected(send(), 409, 'EDITORIAL_STATE_UNREADABLE');
      expect(events).not.toContain('update');
    }
  });
  it.each([
    'lock',
    'snapshot',
    'update',
    'insert',
    'commit',
    'update-count',
    'insert-count',
  ])('fails closed without retry on %s failure', async (stage) => {
    fail = stage;
    await rejected(
      send(),
      stage === 'update-count' ? 409 : 500,
      stage === 'update-count' ? 'CONFLICT' : 'INTERNAL_ERROR',
    );
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toBe('reject');
    if (['lock', 'snapshot', 'update', 'update-count'].includes(stage))
      expect(events).not.toContain('insert');
  });
});
