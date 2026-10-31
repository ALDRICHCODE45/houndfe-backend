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
import { buildProductionVocabularyManifest } from '../../../prisma/editorial-production-vocabulary.manifest';
import { readEditorialVocabulary } from '../application/editorial-vocabulary-read';

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
const baseRevision =
  'ev2-sha256-' +
  createHash('sha256')
    .update(JSON.stringify(canonical({ contractVersion: 2, vocabulary })))
    .digest('hex');
let revision = baseRevision;
const intent = (
  document = empty(),
  expectedCycle = 3,
  expectedRevision = 7,
) => ({
  receiptVersion: 2,
  contractVersion: 2,
  vocabularyRevision: revision,
  careConfirmation: null,
  body: { expectedCycle, expectedRevision, document },
});
function acknowledgement(
  document = empty(),
  cycle = 3,
  published: unknown = null,
) {
  return {
    receiptVersion: 2,
    status: 200,
    body: {
      contractVersion: 2,
      vocabularyRevision: revision,
      state: {
        cycle,
        draft: {
          revision: 8,
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
  basePublishedRevision: number | null;
  draftDocument: unknown;
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
describe('registered V2 save composition', () => {
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
    revision = baseRevision;
    events = [];
    stored = {
      cycle: 3,
      draftRevision: 7,
      basePublishedRevision: null,
      draftDocument: empty(),
      published: null,
    };
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
          : sql.includes('FROM "catalog_editorial_save_receipts"')
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
                    JSON.stringify(
                      canonical(
                        JSON.parse((query as Query).values[0] as string),
                      ),
                    ) === JSON.stringify(canonical(receipt.request)),
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
  const send = (body: object = intent().body) =>
    request(app.getHttpServer() as Server)
      .put(`/products/${productId}/editorial/draft`)
      .set('Idempotency-Key', 'key')
      .set('Editorial-Vocabulary-Revision', revision)
      .send(body);
  function check(response: request.Response, status: number, body: unknown) {
    expect(response.status).toBe(status);
    expect(response.body).toEqual(body);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['editorial-contract-version']).toBe('2');
    expect(response.headers['editorial-vocabulary-revision']).toBe(
      status === 200 ? revision : undefined,
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
  it('replaces Draft and records 200 only after same-tx locks and real reference observations', async () => {
    const result = acknowledgement();
    check(await send(), 200, result.body);
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
      8,
      JSON.stringify(empty()),
      tenantId,
      productId,
      3,
      7,
    ]);
    expect(write.sql.split('WHERE')[0]).not.toMatch(
      /"(?:cycle|basePublishedRevision|publishedRevision|publishedDocument)"\s*=/,
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
      200,
      acknowledgement().body,
    );
    expect((tx.$queryRaw.mock.calls as [Query][])[1][0].values.at(-1)).toBe(
      key,
    );
  });
  it.each([
    'absent',
    'no-draft',
    'cycle',
    'revision',
    'overflow',
    'large-wire',
  ])('checks %s CAS before metadata', async (mode) => {
    const body = intent().body;
    if (mode === 'absent') stored = null;
    if (mode === 'no-draft') stored!.draftRevision = null;
    if (mode === 'cycle') body.expectedCycle = 2;
    if (mode === 'revision') body.expectedRevision = 6;
    if (mode === 'overflow') {
      stored!.draftRevision = 2147483647;
      body.expectedRevision = 2147483647;
    }
    if (mode === 'large-wire') body.expectedRevision = 2147483648;
    await reject(send(body), 409, 'CONFLICT');
    expect(events).toEqual(['begin', 'product', 'receipt', 'state', 'reject']);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
  it.each([
    null,
    {},
    { ...empty(), extra: true },
    { ...empty(), schemaVersion: 1 },
    { ...empty(), values: [{}] },
    { ...empty(), facts: [{}] },
    { ...empty(), mediaRefs: [1] },
  ])(
    'rejects malformed nested document %p before transaction',
    async (document) => {
      await reject(send({ ...intent().body, document }), 400, 'MALFORMED');
      expect(db.$transaction).not.toHaveBeenCalled();
    },
  );
  it.each([null, 0, -1, 1.5, '7'])(
    'rejects invalid revision %p before transaction',
    async (expectedRevision) => {
      await reject(
        send({ ...intent().body, expectedRevision }),
        400,
        'MALFORMED',
      );
      expect(db.$transaction).not.toHaveBeenCalled();
    },
  );
  it('replaces rather than merges Draft, preserving cycle/base/Published', async () => {
    const published = {
      revision: 11,
      document: { ...empty(), commercialTitle: 'published' },
    };
    stored = {
      cycle: 3,
      draftRevision: 7,
      basePublishedRevision: 11,
      draftDocument: {
        ...empty(),
        commercialTitle: 'old',
        mediaRefs: ['old-media'],
      },
      published,
    };
    const document = { ...empty(), description: 'replacement' };
    check(
      await send(intent(document).body),
      200,
      acknowledgement(document, 3, published).body,
    );
    const write = (tx.$executeRaw.mock.calls as [Query][])[1][0];
    expect(write.values).toEqual([
      8,
      JSON.stringify(document),
      tenantId,
      productId,
      3,
      7,
    ]);
    expect(write.sql.split('WHERE')[0]).not.toMatch(
      /"(?:cycle|basePublishedRevision|publishedRevision|publishedDocument)"\s*=/,
    );
  });
  it.each([
    null,
    {},
    { ...empty(), extra: true },
    { ...empty(), schemaVersion: 1 },
  ])('replaces malformed baseline %p with a valid candidate', async (old) => {
    stored!.draftDocument = old;
    check(await send(), 200, acknowledgement().body);
  });
  it.each(['family', 'variant', 'media', 'duplicate'])(
    'invalid whole %s baseline grants no archived option but permits correction',
    async (mode) => {
      const old = selection();
      if (mode === 'family') old.familyCode = 'gone';
      if (mode === 'variant') old.values[1].variantId = 'gone';
      if (mode === 'media') old.mediaRefs = ['unowned'];
      if (mode === 'duplicate') old.values.push(old.values[0]);
      stored!.draftDocument = old;
      await reject(send(intent(selection()).body), 400, 'MALFORMED');
      expect(events).not.toContain('state-write');
      check(await send(), 200, acknowledgement().body);
    },
  );
  it('conserves single/multi membership and reads candidate/baseline media union', async () => {
    stored!.draftDocument = { ...selection(), mediaRefs: ['old-media'] };
    assets = ['old-media', 'new-media'];
    const document = { ...selection(), mediaRefs: ['new-media'] };
    const result = acknowledgement(document);
    Object.assign(result.body.state, { warnings: warnings() });
    check(await send(intent(document).body), 200, result.body);
    const query = (tx.$queryRaw.mock.calls as [Query][]).find(([q]) =>
      q.sql?.includes('FROM private_media_assets'),
    )![0];
    expect(query.values).toEqual([
      tenantId,
      productId,
      'new-media',
      'old-media',
    ]);
    expect(query.sql).toContain('FOR SHARE');
  });
  it.each(['single-new', 'multi-new', 'moved', 'readded', 'published-only'])(
    'rejects archived %s not conserved from stored Draft',
    async (mode) => {
      const old = selection();
      const document = selection();
      if (mode === 'single-new')
        document.values[0] = {
          ...document.values[0],
          state: 'known',
          payload: { type: 'single', value: 'older' },
        };
      if (mode === 'multi-new')
        old.values[1] = {
          ...old.values[1],
          state: 'known',
          payload: { type: 'multi', value: ['old'] },
        };
      if (mode === 'moved') {
        variants.push('other');
        document.values[0].variantId = 'other';
      }
      if (mode === 'readded' || mode === 'published-only') old.values = [];
      if (mode === 'published-only')
        stored!.published = { revision: 11, document };
      stored!.draftDocument = old;
      await reject(send(intent(document).body), 400, 'MALFORMED');
      expect(events).not.toContain('state-write');
    },
  );
  it('permits removing an archived member without revoking retained membership', async () => {
    stored!.draftDocument = selection();
    const document = selection();
    document.values = [
      {
        ...document.values[1],
        state: 'known',
        payload: { type: 'multi', value: ['old'] },
      },
    ];
    const result = acknowledgement(document);
    Object.assign(result.body.state, { warnings: [warnings()[2]] });
    check(await send(intent(document).body), 200, result.body);
  });
  it.each(['bounds', 'evidence', 'facts'])(
    'does not revoke baseline conservation for unrelated historical %s failure',
    async (mode) => {
      const old = selection();
      if (mode === 'bounds') {
        old.commercialTitle = 'x'.repeat(250);
        old.description = 'y'.repeat(20001);
      }
      if (mode === 'evidence')
        old.values[0].evidence = { sourceRef: '', verifiedOn: 'not a date' };
      if (mode === 'facts')
        old.facts = [
          {
            variantId: 'v',
            presentation: 'unqualified',
            declarations: [],
            careReview: null,
          },
        ];
      stored!.draftDocument = old;
      const document = selection();
      const result = acknowledgement(document);
      Object.assign(result.body.state, { warnings: warnings() });
      check(await send(intent(document).body), 200, result.body);
    },
  );
  it.each([
    'family',
    'variant',
    'media',
    'duplicate',
    'bounds',
    'evidence',
    'NA',
    'facts',
  ])('rejects fresh %s failure without writes', async (mode) => {
    stored!.draftDocument = selection();
    const document = selection();
    if (mode === 'family') document.familyCode = 'missing';
    if (mode === 'variant') document.values[0].variantId = 'missing';
    if (mode === 'media') document.mediaRefs = ['unowned'];
    if (mode === 'duplicate') document.values.push(document.values[0]);
    if (mode === 'bounds') document.commercialTitle = 'x'.repeat(250);
    if (mode === 'evidence')
      document.values[0].evidence = { sourceRef: '', verifiedOn: 'not a date' };
    if (mode === 'NA')
      document.values[0] = {
        code: 'single',
        owner: 'sellable',
        variantId: 'v',
        state: 'not_applicable',
        evidence: null,
      };
    if (mode === 'facts')
      document.facts = [
        {
          variantId: 'v',
          presentation: 'unqualified',
          declarations: [
            { key: 'animalApplied', state: 'unknown', evidence: null },
          ],
          careReview: null,
        },
      ];
    await reject(send(intent(document).body), 400, 'MALFORMED');
    expect(events).not.toContain('state-write');
  });
  it.each([
    'pending',
    'resolved-invalid',
    'range-order',
    'unit',
    'historical-baseline',
    'replay',
  ])('uses real numeric admission only for fresh %s', async (mode) => {
    const definition = {
      id: 'actual/range',
      code: 'range',
      label: 'Range',
      type: 'range',
      units: [{ code: 'kg', label: 'kg', sortOrder: 0 }],
      numericPolicy:
        mode === 'pending' || mode === 'range-order' || mode === 'unit'
          ? { status: 'pending' }
          : {
              status: 'resolved',
              magnitude: 'custom',
              integer: true,
              lower: 0,
              lowerInclusive: true,
              upper: 10,
              upperInclusive: true,
            },
    };
    const binding = {
      ...family.bindings[0],
      definitionId: definition.id,
      definitionCode: definition.code,
    };
    const next = {
      ...vocabulary,
      definitions: [definitions[0], definition, definitions[1]],
      families: [
        {
          ...family,
          bindings: [family.bindings[0], binding, family.bindings[1]],
        },
      ],
    };
    revision =
      'ev2-sha256-' +
      createHash('sha256')
        .update(
          JSON.stringify(canonical({ contractVersion: 2, vocabulary: next })),
        )
        .digest('hex');
    const data = snapshot as {
      definitions: unknown[];
      families: { bindings: unknown[] }[];
    };
    data.definitions.splice(1, 0, {
      ...definition,
      units: definition.units.map((u) => ({
        ...u,
        id: 'unit/range/kg',
        unitCode: u.code,
        definitionType: definition.type,
        definitionId: definition.id,
      })),
      options: [],
      groups: [],
      aliases: [],
    });
    data.families[0].bindings.splice(1, 0, { ...binding, familyId: family.id });
    const numeric: DocumentShapeV2 = {
      ...empty(),
      familyCode: 'f',
      values: [
        {
          code: 'range',
          owner: 'sellable',
          variantId: 'v',
          state: 'known',
          evidence: null,
          payload: {
            type: 'range',
            min: mode === 'range-order' ? 9 : 0,
            max: mode === 'range-order' ? 2 : 11,
            unit: mode === 'unit' ? 'missing' : 'kg',
          },
        },
      ],
    };
    if (mode === 'historical-baseline') {
      stored!.draftDocument = {
        ...selection(),
        values: [...selection().values, ...numeric.values],
      };
      const document = selection();
      const result = acknowledgement(document);
      Object.assign(result.body.state, { warnings: warnings() });
      check(await send(intent(document).body), 200, result.body);
    } else if (mode === 'replay' || mode === 'pending') {
      const result = acknowledgement(numeric);
      if (mode === 'replay') receipt = { request: intent(numeric), result };
      check(await send(intent(numeric).body), 200, result.body);
      if (mode === 'replay') expect(events).not.toContain('state-write');
    } else {
      await reject(send(intent(numeric).body), 400, 'MALFORMED');
      expect(events).not.toContain('state-write');
    }
  });
  it.each([
    'optional-empty',
    'optional-nonempty',
    'care-unresolved',
    'care-invalid',
  ])(
    'checks custom facts/care %s without publication completeness',
    async (mode) => {
      const document = { ...empty(), familyCode: 'f' };
      document.facts = [
        {
          variantId: 'v',
          presentation: 'Presentation',
          declarations: [],
          careReview: null,
        },
      ];
      if (mode.startsWith('optional'))
        document.facts[0].declarations = [
          {
            key: 'optionalNonpertinenceCodes',
            state: 'known',
            value: mode === 'optional-empty' ? [] : ['single'],
            basis: 'Basis',
            evidence: { sourceRef: 'Label', verifiedOn: '2024-02-29' },
          },
        ];
      else
        document.facts[0].careReview = {
          state: 'prepared',
          jurisdiction: mode === 'care-invalid' ? '' : 'MX',
          intendedUse: 'Use',
          determination: 'identified',
          basis: 'Basis',
          evidence: [],
          requirements: [
            {
              key: 'r',
              description: 'Requirement',
              disposition: 'unresolved',
              evidence: [],
              basis: 'Basis',
            },
          ],
          warnings: [],
        };
      if (mode !== 'optional-empty') {
        await reject(send(intent(document).body), 400, 'MALFORMED');
        expect(events).not.toContain('state-write');
      } else
        check(
          await send(intent(document).body),
          200,
          acknowledgement(document).body,
        );
    },
  );
  it.each(['unresolved', 'bad-care', 'NA-own', 'NA-other'])(
    'admits production care/NA with actual helpers: %s',
    async (mode) => {
      const manifest = buildProductionVocabularyManifest();
      const definitions = manifest.definitions.map((definition, i) => {
        const id = `actual/${i}`;
        return {
          ...definition,
          id,
          numericPolicy:
            'numericPolicy' in definition ? definition.numericPolicy : null,
          units:
            'units' in definition
              ? definition.units.map((unit, j) => ({
                  ...unit,
                  id: `unit/${i}/${j}`,
                  unitCode: unit.code,
                  definitionId: id,
                  definitionType: definition.type,
                }))
              : [],
          options:
            'options' in definition
              ? definition.options.map((option) => ({
                  ...option,
                  definitionId: id,
                  definitionType: definition.type,
                  archivedAt: option.archived ? '2025-01-01' : null,
                }))
              : [],
          groups:
            'groups' in definition
              ? definition.groups.map((group) => ({
                  ...group,
                  definitionId: id,
                  definitionType: definition.type,
                  members: group.optionCodes.map((optionCode) => ({
                    definitionId: id,
                    groupCode: group.code,
                    optionCode,
                  })),
                }))
              : [],
          aliases:
            'aliases' in definition
              ? definition.aliases.map((alias) => ({
                  ...alias,
                  definitionId: id,
                }))
              : [],
        };
      });
      snapshot = {
        metadata: { id: 'global', semanticsVersion: manifest.semanticsVersion },
        definitions,
        families: manifest.families.map((family) => ({
          id: family.code,
          code: family.code,
          label: family.label,
          bindings: family.bindings.map((binding) => ({
            ...binding,
            familyId: family.code,
            definitionId: definitions.find(
              (d) => d.code === binding.definitionCode,
            )!.id,
          })),
        })),
      };
      // The base fixture pins R independently; this richer fixture exercises domain composition.
      revision = (
        await readEditorialVocabulary({ read: () => Promise.resolve(snapshot) })
      ).vocabularyRevision;
      const document = {
        ...empty(),
        familyCode: mode.startsWith('NA') ? 'hygiene' : 'care',
      };
      document.facts = [
        {
          variantId: mode === 'NA-other' ? 'other' : 'v',
          presentation: 'Presentation',
          declarations: [],
          careReview: null,
        },
      ];
      variants.push('other');
      if (mode.startsWith('NA')) {
        document.values = [
          {
            code: 'animal.target',
            owner: 'sellable',
            variantId: 'v',
            state: 'not_applicable',
            evidence: null,
          },
        ];
        document.facts[0].declarations = [
          {
            key: 'animalApplied',
            state: 'known',
            value: false,
            basis: 'Basis',
            evidence: { sourceRef: 'Label', verifiedOn: '2024-02-29' },
          },
        ];
      } else
        document.facts[0].careReview = {
          state: 'prepared',
          jurisdiction: mode === 'bad-care' ? '' : 'MX',
          intendedUse: 'Use',
          determination: 'identified',
          basis: 'Basis',
          evidence: [],
          requirements: [
            {
              key: 'r',
              description: 'Requirement',
              disposition: 'unresolved',
              evidence: [],
              basis: 'Basis',
            },
          ],
          warnings: [],
        };
      if (mode === 'bad-care' || mode === 'NA-other') {
        await reject(send(intent(document).body), 400, 'MALFORMED');
        expect(events).not.toContain('state-write');
      } else
        check(
          await send(intent(document).body),
          200,
          acknowledgement(document).body,
        );
    },
  );
  it('allows incomplete save without publication gates', async () => {
    const document = selection();
    stored!.draftDocument = document;
    const result = acknowledgement(document);
    Object.assign(result.body.state, { warnings: warnings() });
    check(await send(intent(document).body), 200, result.body);
  });
  it('preserves context-invalid Published without fresh qualification', async () => {
    const published = {
      revision: 11,
      document: {
        ...selection(),
        mediaRefs: ['gone'],
        commercialTitle: 'x'.repeat(250),
      },
    };
    stored!.published = published;
    stored!.basePublishedRevision = 11;
    check(await send(), 200, acknowledgement(empty(), 3, published).body);
  });
  it.each([
    null,
    {},
    { ...empty(), schemaVersion: 1 },
    { ...empty(), extra: true },
  ])('fails closed on malformed surviving Published %p', async (document) => {
    stored!.published = { revision: 11, document };
    await reject(send(), 500, 'INTERNAL_ERROR');
    expect(events).not.toContain('state-write');
  });
  it.each([undefined, [], warnings().reverse()])(
    'replays exact recorded warnings %p without current state/CAS/R comparison',
    async (recordedWarnings) => {
      const document = selection();
      const result = acknowledgement(document);
      if (recordedWarnings !== undefined)
        Object.assign(result.body.state, { warnings: recordedWarnings });
      receipt = { request: intent(document), result };
      stored = null;
      (snapshot as { families: { label: string }[] }).families[0].label =
        'Changed R';
      check(await send(intent(document).body), 200, result.body);
      expect(events).not.toContain('state');
      expect(events).not.toContain('state-write');
      expect(events).not.toContain('receipt-write');
    },
  );
  it.each(['draft', 'published'])(
    'replay checks recorded %s references, not current live state',
    async (slot) => {
      const document = selection();
      const published = { revision: 11, document: empty() };
      if (slot === 'draft') document.values[0].variantId = 'gone';
      else published.document.mediaRefs = ['unowned'];
      receipt = {
        request: intent(document),
        result: acknowledgement(document, 3, published),
      };
      await reject(send(intent(document).body), 400, 'MALFORMED');
      expect(events).not.toContain('state');
      expect(events).not.toContain('state-write');
    },
  );
  it.each(['bounds', 'evidence', 'facts'])(
    'replays historical %s failure without fresh admission',
    async (mode) => {
      const document = selection();
      if (mode === 'bounds') document.commercialTitle = 'x'.repeat(250);
      if (mode === 'evidence')
        document.values[0].evidence = {
          sourceRef: '',
          verifiedOn: 'not a date',
        };
      if (mode === 'facts')
        document.facts = [
          {
            variantId: 'v',
            presentation: 'unqualified',
            declarations: [],
            careReview: null,
          },
        ];
      const result = acknowledgement(document);
      receipt = { request: intent(document), result };
      check(await send(intent(document).body), 200, result.body);
      expect(events).not.toContain('state-write');
    },
  );
  it.each(['R', 'document', 'cycle', 'revision', 'legacy'])(
    'conflicts on changed %s intent before metadata',
    async (mode) => {
      const changed = intent();
      if (mode === 'R')
        changed.vocabularyRevision = 'ev2-sha256-' + 'a'.repeat(64);
      if (mode === 'document') changed.body.document.description = 'different';
      if (mode === 'cycle') changed.body.expectedCycle = 2;
      if (mode === 'revision') changed.body.expectedRevision = 6;
      receipt = {
        request: mode === 'legacy' ? changed.body : changed,
        result: acknowledgement(),
      };
      await reject(send(), 409, 'CONFLICT');
      expect(events).toEqual(['begin', 'product', 'receipt', 'reject']);
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    },
  );
  it.each([
    'cycle',
    'revision',
    'document',
    'missing-draft',
    'status',
    'R',
    'legacy',
  ])('rejects incoherent recorded %s', async (mode) => {
    const result = acknowledgement();
    if (mode === 'cycle') result.body.state.cycle = 4;
    if (mode === 'revision') result.body.state.draft.revision = 9;
    if (mode === 'document')
      result.body.state.draft.document.description = 'different';
    if (mode === 'missing-draft')
      Object.assign(result.body.state, { draft: null });
    if (mode === 'status') result.status = 201;
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
