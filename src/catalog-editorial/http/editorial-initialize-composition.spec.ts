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
import type { DocumentShapeV2 } from '../domain/editorial-document-shape-v2';

const productId = '11111111-1111-4111-8111-111111111111';
const tenantId = 'tenant';
const actorId = 'actor';
const empty = (): DocumentShapeV2 => ({
  schemaVersion: 2,
  commercialTitle: null,
  description: null,
  mediaRefs: [],
  familyCode: null,
  values: [],
  facts: [],
});
const definitions = ['multi', 'single'].map((type) => ({
  id: `id/${type}`,
  code: type,
  label: type,
  type,
  options: ['old', 'older'].map((code, sortOrder) => ({
    code,
    label: code,
    sortOrder,
    archived: true,
  })),
  groups: [],
  aliases: [],
}));
const family = {
  id: 'family/f',
  code: 'f',
  label: 'Family',
  bindings: definitions.map((d) => ({
    definitionId: d.id,
    definitionCode: d.code,
    owner: 'sellable',
    sortOrder: 0,
    exposure: 'INTERNAL',
    searchable: false,
    publicationCheck: 'when_asserted',
    policy: { route: 'pending' },
  })),
};
const vocabulary = {
  semanticsVersion: 'editorial-production-1',
  families: [family],
  definitions,
};
// Independent recursive key sort; fixtures use ASCII keys and ordinary integers.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b, 'en'))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
const revision =
  'ev2-sha256-' +
  createHash('sha256')
    .update(JSON.stringify(canonical({ contractVersion: 2, vocabulary })))
    .digest('hex');
const intent = (expectedCycle: number | null = null) => ({
  receiptVersion: 2,
  contractVersion: 2,
  vocabularyRevision: revision,
  careConfirmation: null,
  body: { expectedCycle },
});
function acknowledgement(
  document = empty(),
  cycle = 1,
  published: unknown = null,
) {
  return {
    receiptVersion: 2,
    status: 201,
    body: {
      contractVersion: 2,
      vocabularyRevision: revision,
      state: {
        cycle,
        draft: {
          revision: 1,
          basePublishedRevision: published === null ? null : 11,
          document,
        },
        published,
      },
    },
    headers: {
      'Editorial-Contract-Version': '2',
      'Editorial-Vocabulary-Revision': revision,
    },
    careAttestation: null,
  };
}
function selection(): DocumentShapeV2 {
  return {
    ...empty(),
    familyCode: 'f',
    values: [
      {
        code: 'single',
        owner: 'sellable',
        variantId: 'v',
        state: 'known',
        payload: { type: 'single', value: 'old' },
        evidence: null,
      },
      {
        code: 'multi',
        owner: 'sellable',
        variantId: 'v',
        state: 'known',
        payload: { type: 'multi', value: ['older', 'old'] },
        evidence: null,
      },
    ],
  };
}
const warnings = () =>
  ['single/old', 'multi/older', 'multi/old'].map((item) => {
    const [code, optionCode] = item.split('/');
    return {
      code: 'ARCHIVED_OPTION',
      familyId: 'family/f',
      definitionId: `id/${code}`,
      owner: 'sellable',
      variantId: 'v',
      optionCode,
    };
  });
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
let stored: {
  cycle: number;
  draftRevision: number | null;
  published: unknown;
} | null;
let receipt: { request: unknown; result: unknown } | null;
let assets: string[];
let variants: string[];
let fail: string;
let snapshot: unknown;
@Global()
@Module({
  providers: [{ provide: PrismaService, useValue: db }],
  exports: [PrismaService],
})
class Database {}

// Actual registered composition; fake Prisma returns JSON, not rollback or lock proof.
describe('registered V2 initialize composition', () => {
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
    stored = null;
    receipt = null;
    fail = '';
    assets = [];
    variants = ['v'];
    snapshot = {
      metadata: { id: 'global', semanticsVersion: vocabulary.semanticsVersion },
      families: [
        {
          ...family,
          bindings: family.bindings.map((b) => ({ ...b, familyId: family.id })),
        },
      ],
      definitions: definitions.map((d) => ({
        ...d,
        numericPolicy: null,
        units: [],
        options: d.options.map((o) => ({
          ...o,
          definitionId: d.id,
          definitionType: d.type,
          archivedAt: '2025-01-01',
        })),
      })),
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
          if (fail === 'commit') throw new Error('private commit');
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
          : sql.includes('FROM "catalog_editorial_create_receipts"')
            ? 'receipt'
            : sql.includes('FROM variants')
              ? 'variants'
              : sql.includes('FROM private_media_assets')
                ? 'assets'
                : 'state';
      events.push(kind);
      if (fail === kind) throw new Error('private source detail');
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
      if (kind === 'snapshot') return Promise.resolve([{ snapshot }]);
      if (kind === 'variants' || kind === 'assets')
        return Promise.resolve(
          (kind === 'variants' ? variants : assets).map((id) => ({ id })),
        );
      return Promise.resolve(stored ? [stored] : []);
    });
    tx.$executeRaw.mockImplementation((query: Query) => {
      const kind = query.sql.includes('LOCK TABLE')
        ? 'lock'
        : query.sql.includes('"catalog_editorial_states"')
          ? 'state-write'
          : 'receipt-write';
      events.push(kind);
      if (fail === kind) throw new Error('private mutation detail');
      return Promise.resolve(fail === kind + '-count' ? 0 : 1);
    });
  });
  const send = (body: object = { expectedCycle: null }) =>
    request(app.getHttpServer() as Server)
      .post(`/products/${productId}/editorial/draft/initialize`)
      .set('Idempotency-Key', 'key')
      .set('Editorial-Vocabulary-Revision', revision)
      .send(body);
  function check(response: request.Response, status: number, body: unknown) {
    expect(response.status).toBe(status);
    expect(response.body).toEqual(body);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['editorial-contract-version']).toBe('2');
    expect(response.headers['editorial-vocabulary-revision']).toBe(
      status === 201 ? revision : undefined,
    );
  }
  async function reject(
    req: PromiseLike<request.Response>,
    status: number,
    error: string,
  ) {
    const before = structuredClone({ stored, receipt });
    check(await req, status, { statusCode: status, error });
    expect({ stored, receipt }).toEqual(before);
    expect(events).not.toContain('commit');
    expect(events).not.toContain('receipt-write');
  }
  it('creates exact empty V2 state and receipt only after same-tx locks and real reference observations', async () => {
    const result = acknowledgement();
    check(await send(), 201, result.body);
    expect(events).toEqual([
      'begin',
      'product',
      'receipt',
      'state',
      'lock',
      'snapshot',
      'variants',
      'assets',
      'state-write',
      'receipt-write',
      'commit',
    ]);
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'ReadCommitted',
    });
    expect(db.$queryRaw).not.toHaveBeenCalled();
    const queries = tx.$queryRaw.mock.calls.map(([q]: [Query]) => q);
    expect(queries[0].values).toEqual([tenantId, productId]);
    expect(queries[0].sql).toContain('FOR UPDATE');
    expect(queries[1].values).toEqual([
      JSON.stringify(intent()),
      tenantId,
      productId,
      actorId,
      'key',
    ]);
    expect(queries[1].sql).toContain('AS JSONB');
    expect(queries[2].sql).toContain('FOR UPDATE');
    expect(queries[4].values).toEqual([tenantId, productId]);
    expect(queries[5].sql).toContain('FALSE');
    const [lock, write, insert] = tx.$executeRaw.mock.calls.map(
      ([q]: [Query]) => q,
    );
    expect(lock.sql.replace(/\s+/g, ' ').trim()).toBe(
      'LOCK TABLE "editorial_families", "editorial_definitions", "editorial_bindings", "editorial_options", "editorial_units", "editorial_groups", "editorial_group_members", "editorial_aliases", "editorial_vocabulary_metadata" IN SHARE MODE',
    );
    expect(write.values).toEqual([
      tenantId,
      productId,
      1,
      null,
      JSON.stringify(empty()),
    ]);
    expect(write.sql).not.toMatch(
      /"(?:publishedRevision|publishedDocument)"\s*=/,
    );
    expect(insert.values).toEqual([
      tenantId,
      productId,
      actorId,
      'key',
      JSON.stringify(intent()),
      JSON.stringify(result),
    ]);
  });
  it.each(['inactive', 'read-only', 'update-only', 'foreign', 'outage'])(
    'rejects %s authority before malformed intent',
    async (mode) => {
      if (mode === 'inactive')
        db.user.findUnique.mockResolvedValue({ isActive: false });
      if (mode === 'foreign')
        db.product.findFirst.mockResolvedValue({
          id: productId,
          tenantId: 'foreign',
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
      await reject(send({}).unset('Idempotency-Key'), 403, 'FORBIDDEN');
      expect(db.$transaction).not.toHaveBeenCalled();
    },
  );
  it('rechecks current transaction authority', async () => {
    tx.user.findUnique.mockResolvedValue({ isActive: false });
    await reject(send(), 403, 'FORBIDDEN');
    expect(events).toEqual(['begin', 'reject']);
  });
  it.each([
    'Editorial-Care-Confirmation',
    'Editorial-Adoption',
    'Editorial-Contract-Version',
  ])('forbids even empty %s', async (header) => {
    await reject(send().set(header, ''), 400, 'MALFORMED');
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it.each(['Idempotency-Key', 'Editorial-Vocabulary-Revision'])(
    'requires one exact %s',
    async (header) => {
      const value = header === 'Idempotency-Key' ? 'key' : revision;
      for (const invalid of ['', [value, value], value + ', ' + value])
        await reject(send().set(header, invalid as string), 400, 'MALFORMED');
      await reject(send().unset(header), 400, 'MALFORMED');
      expect(db.$transaction).not.toHaveBeenCalled();
    },
  );
  it.each([
    {},
    [],
    { expectedCycle: 0 },
    { expectedCycle: -1 },
    { expectedCycle: 1.5 },
    { expectedCycle: '1' },
    { expectedCycle: null, document: {} },
  ])('rejects closed wire %p', async (body) => {
    await reject(send(body), 400, 'MALFORMED');
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('rejects query, invalid R and oversized key before transaction', async () => {
    await reject(send().query({ tenantId: 'foreign' }), 400, 'MALFORMED');
    await reject(
      send().set('Editorial-Vocabulary-Revision', revision.toUpperCase()),
      400,
      'MALFORMED',
    );
    await reject(
      send().set('Idempotency-Key', 'x'.repeat(201)),
      400,
      'MALFORMED',
    );
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it.each(['a  b', 'x'.repeat(200)])('retains key %p', async (key) => {
    check(
      await send().set('Idempotency-Key', key),
      201,
      acknowledgement().body,
    );
    expect((tx.$queryRaw.mock.calls as [Query][])[1][0].values.at(-1)).toBe(
      key,
    );
  });
  it.each([
    'absent-positive',
    'existing-null',
    'stale',
    'draft',
    'overflow',
    'large-wire',
  ])('checks %s CAS before metadata', async (mode) => {
    let expectedCycle: number | null = 3;
    if (mode !== 'absent-positive')
      stored = { cycle: 3, draftRevision: null, published: null };
    if (mode === 'existing-null') expectedCycle = null;
    if (mode === 'stale') expectedCycle = 2;
    if (mode === 'draft') stored!.draftRevision = 1;
    if (mode === 'overflow') {
      stored!.cycle = 2147483647;
      expectedCycle = 2147483647;
    }
    if (mode === 'large-wire') expectedCycle = 2147483648;
    await reject(send({ expectedCycle }), 409, 'CONFLICT');
    expect(events).toEqual(['begin', 'product', 'receipt', 'state', 'reject']);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
  it('increments retained empty state and preserves its absent Published', async () => {
    stored = { cycle: 3, draftRevision: null, published: null };
    check(
      await send({ expectedCycle: 3 }),
      201,
      acknowledgement(empty(), 4).body,
    );
  });
  it('copies Published exactly and derives actual-ID archived warnings in candidate order', async () => {
    const document = selection();
    const published = { revision: 11, document };
    stored = { cycle: 3, draftRevision: null, published };
    const result = acknowledgement(document, 4, published);
    Object.assign(result.body.state, { warnings: warnings() });
    check(await send({ expectedCycle: 3 }), 201, result.body);
    expect((tx.$executeRaw.mock.calls as [Query][])[1][0].values).toEqual([
      tenantId,
      productId,
      4,
      11,
      JSON.stringify(document),
    ]);
  });
  it.each(['family', 'variant', 'media', 'duplicate'])(
    'copies context-invalid %s baseline without conservation warnings',
    async (mode) => {
      const document = selection();
      if (mode === 'family') document.familyCode = 'deleted';
      if (mode === 'variant') variants = [];
      if (mode === 'media') document.mediaRefs = ['unowned'];
      if (mode === 'duplicate') document.values.push(document.values[0]);
      const published = { revision: 11, document };
      stored = { cycle: 3, draftRevision: null, published };
      check(
        await send({ expectedCycle: 3 }),
        201,
        acknowledgement(document, 4, published).body,
      );
    },
  );
  it('does not freshly qualify historical bounds, evidence, numeric assertions or facts', async () => {
    const document = selection();
    document.commercialTitle = 'x'.repeat(250);
    document.description = 'y'.repeat(20001);
    document.values[0].evidence = { sourceRef: '', verifiedOn: 'not a date' };
    document.values.push({
      code: 'old.range',
      owner: 'product',
      variantId: null,
      state: 'known',
      payload: { type: 'range', min: 9, max: -2, unit: '' },
      evidence: null,
    });
    document.facts = [
      {
        variantId: 'v',
        presentation: 'unqualified',
        declarations: [],
        careReview: null,
      },
    ];
    const published = { revision: 11, document };
    stored = { cycle: 3, draftRevision: null, published };
    check(
      await send({ expectedCycle: 3 }),
      201,
      acknowledgement(document, 4, published).body,
    );
  });
  it.each([
    null,
    {},
    { ...empty(), schemaVersion: 1 },
    { ...empty(), extra: true },
  ])('fails closed on malformed Published %p', async (document) => {
    stored = {
      cycle: 3,
      draftRevision: null,
      published: { revision: 11, document },
    };
    await reject(send({ expectedCycle: 3 }), 409, 'EDITORIAL_STATE_UNREADABLE');
    expect(events).not.toContain('state-write');
  });
  it('observes selected media under the same qualified Product gate', async () => {
    const document = empty();
    document.mediaRefs = ['second', 'first'];
    assets = ['first', 'second'];
    const published = { revision: 11, document };
    stored = { cycle: 3, draftRevision: null, published };
    check(
      await send({ expectedCycle: 3 }),
      201,
      acknowledgement(document, 4, published).body,
    );
    const query = (tx.$queryRaw.mock.calls as [Query][]).find(([q]) =>
      q.sql?.includes('FROM private_media_assets'),
    )![0];
    expect(query.values).toEqual([tenantId, productId, 'first', 'second']);
    expect(query.sql).toContain('FOR SHARE');
  });
  it.each([undefined, [], warnings().reverse()])(
    'replays exact recorded warnings %p without CAS/current-R comparison',
    async (recordedWarnings) => {
      const document = selection();
      const published = { revision: 11, document };
      const result = acknowledgement(document, 4, published);
      if (recordedWarnings !== undefined)
        Object.assign(result.body.state, { warnings: recordedWarnings });
      receipt = { request: intent(3), result };
      stored = { cycle: 99, draftRevision: 8, published: null };
      const changed = snapshot as { families: { label: string }[] };
      changed.families[0].label = 'Changed current R';
      check(await send({ expectedCycle: 3 }), 201, result.body);
      expect(events).not.toContain('state');
      expect(events).not.toContain('state-write');
      expect(events).not.toContain('receipt-write');
    },
  );
  it.each(['variant', 'media', 'option'])(
    'rejects replay after current %s reference loss',
    async (mode) => {
      const document = selection();
      if (mode === 'variant') variants = [];
      if (mode === 'media') document.mediaRefs = ['gone'];
      if (mode === 'option')
        document.values[0] = {
          ...document.values[0],
          state: 'known',
          evidence: null,
          payload: { type: 'single', value: 'removed' },
        };
      receipt = {
        request: intent(3),
        result: acknowledgement(document, 4, { revision: 11, document }),
      };
      await reject(send({ expectedCycle: 3 }), 400, 'MALFORMED');
      expect(events).not.toContain('state-write');
    },
  );
  it.each(['R', 'body', 'legacy-create'])(
    'conflicts for same-key changed %s intent before references',
    async (mode) => {
      receipt = {
        request:
          mode === 'legacy-create'
            ? { expectedCycle: null, document: empty() }
            : {
                ...intent(),
                ...(mode === 'R'
                  ? { vocabularyRevision: 'ev2-sha256-' + 'a'.repeat(64) }
                  : { body: { expectedCycle: 3 } }),
              },
        result: acknowledgement(),
      };
      await reject(send(), 409, 'CONFLICT');
      expect(events).toEqual(['begin', 'product', 'receipt', 'reject']);
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    },
  );
  it.each([
    'cycle',
    'draft-revision',
    'base',
    'document',
    'missing-draft',
    'status',
    'R',
    'legacy',
  ])('rejects incoherent recorded %s', async (mode) => {
    const result = acknowledgement();
    if (mode === 'cycle') result.body.state.cycle = 9;
    if (mode === 'draft-revision') result.body.state.draft.revision = 2;
    if (mode === 'base') result.body.state.draft.basePublishedRevision = 11;
    if (mode === 'document')
      result.body.state.draft.document.commercialTitle = 'not empty';
    if (mode === 'missing-draft')
      Object.assign(result.body.state, { draft: null });
    if (mode === 'status') result.status = 200;
    if (mode === 'R')
      result.headers['Editorial-Vocabulary-Revision'] =
        'ev2-sha256-' + 'a'.repeat(64);
    receipt = {
      request: intent(),
      result: mode === 'legacy' ? result.body.state : result,
    };
    await reject(send(), 500, 'INTERNAL_ERROR');
    expect(events).not.toContain('state-write');
  });
  it('checks fresh R after CAS but before reference reads and mutation', async () => {
    await reject(
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
  });
  it('rejects Product disappearance after authority', async () => {
    fail = 'disappeared';
    await reject(send(), 404, 'NOT_FOUND');
    expect(events).toEqual(['begin', 'product', 'reject']);
  });
  it('rejects unrepresentable current metadata', async () => {
    snapshot = { metadata: null, families: [], definitions: [] };
    await reject(send(), 500, 'EDITORIAL_VOCABULARY_UNREPRESENTABLE');
    expect(events).not.toContain('state-write');
  });
  it.each([
    'lock',
    'snapshot',
    'variants',
    'assets',
    'state-write',
    'receipt-write',
    'commit',
    'state-write-count',
    'receipt-write-count',
  ])('propagates %s failure without retry or success', async (stage) => {
    fail = stage;
    const before = structuredClone(stored);
    check(await send(), stage === 'state-write-count' ? 409 : 500, {
      statusCode: stage === 'state-write-count' ? 409 : 500,
      error: stage === 'state-write-count' ? 'CONFLICT' : 'INTERNAL_ERROR',
    });
    expect(stored).toEqual(before);
    expect(events.at(-1)).toBe('reject');
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    if (
      [
        'lock',
        'snapshot',
        'variants',
        'assets',
        'state-write',
        'state-write-count',
      ].includes(stage)
    )
      expect(events).not.toContain('receipt-write');
  });
});
