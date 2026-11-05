import { Prisma, type PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  disconnectIntegrationPrisma,
  integrationPrisma,
} from '../../../test/integration/reset-db';
import { EditorialPublicationNotReadyError } from '../application/editorial-publish-writer';
import { readEditorialVocabulary } from '../application/editorial-vocabulary-read';
import { createEditorialWriteRequestV2 } from '../application/editorial-write-request-v2';
import { isRecognizableDocumentV2 } from '../domain/editorial-document-recognition-v2';
import { PrismaEditorialDiscardWriter } from './prisma-editorial-discard-writer';
import { PrismaEditorialInitializeWriter } from './prisma-editorial-initialize-writer';
import { PrismaEditorialPublishWriter } from './prisma-editorial-publish-writer';
import { PrismaEditorialReadinessReader } from './prisma-editorial-readiness-reader';
import { PrismaEditorialSaveWriter } from './prisma-editorial-save-writer';
import { PrismaEditorialVocabularySnapshot } from './prisma-editorial-vocabulary-snapshot';
import {
  fact,
  installCanonicalVocabulary,
  known,
  readyCareReview,
  readyDrafts,
  uninstallVocabulary,
} from './test-support/editorial-publication-postgres';

// Real PostgreSQL, real production vocabulary, real V2 drafts per family.
const tenantId = randomUUID();
const globalPriceListId = randomUUID();
const actors = {
  editor: randomUUID(),
  publisher: randomUUID(),
  reader: randomUUID(),
};
const grants = {
  editor: ['read', 'update', 'publish'],
  publisher: ['read', 'publish'],
  reader: ['read'],
} as const;

let prisma: PrismaClient;
let installed = false;
let revision: string;
const publisher = () => new PrismaEditorialPublishWriter(prisma);
const scopeOf = (productId: string, actorId: string = actors.editor) => ({
  actorId,
  tenantId,
  productId,
});

type Draft = Record<string, unknown>;
/** A simple product, offered on the tenant catalog list unless told otherwise. */
async function product(
  draft: unknown,
  {
    offered = true,
    published = null,
  }: { offered?: boolean; published?: unknown } = {},
): Promise<string> {
  const productId = randomUUID();
  await prisma.product.create({
    data: {
      id: productId,
      tenantId,
      name: 'Producto ' + productId.slice(0, 8),
      includeInOnlineCatalog: offered,
    },
  });
  await prisma.priceList.create({
    data: { tenantId, productId, globalPriceListId, priceCents: 25000 },
  });
  if (draft !== undefined)
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "catalog_editorial_states"
        ("tenantId", "productId", "cycle", "draftRevision", "draftDocument",
         "publishedRevision", "publishedDocument")
      VALUES (${tenantId}, ${productId}, 1, 4, CAST(${JSON.stringify(draft)} AS JSONB),
        ${published === null ? null : 1},
        CAST(${published === null ? null : JSON.stringify(published)} AS JSONB))`);
  return productId;
}

const intent = (
  operation: 'publish' | 'discard' | 'save' | 'initialize',
  body: object = { expectedCycle: 1, expectedRevision: 4 },
  {
    careConfirmation = null,
    vocabularyRevision = revision,
  }: {
    careConfirmation?: 'review-v1' | null;
    vocabularyRevision?: string;
  } = {},
) =>
  createEditorialWriteRequestV2(
    operation,
    { vocabularyRevision, careConfirmation },
    body,
  );
const publish = (
  productId: string,
  options: Parameters<typeof intent>[2] & {
    key?: string;
    actorId?: string;
    body?: object;
  } = {},
) =>
  publisher().publish(
    scopeOf(productId, options.actorId),
    options.key ?? 'publish-' + randomUUID(),
    intent('publish', options.body, options),
  );

// Static identifier allowlist; all data stays parameterized.
const receiptTables = {
  create: Prisma.sql`"catalog_editorial_create_receipts"`,
  save: Prisma.sql`"catalog_editorial_save_receipts"`,
  publish: Prisma.sql`"catalog_editorial_publish_receipts"`,
  discard: Prisma.sql`"catalog_editorial_discard_receipts"`,
};

/** Every persisted editorial row of this product: state and all receipts. */
async function rows(productId: string) {
  const read = (table: keyof typeof receiptTables) =>
    prisma.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
      SELECT * FROM ${receiptTables[table]}
      WHERE "tenantId" = ${tenantId} AND "productId" = ${productId}
      ORDER BY "actorId", "idempotencyKey"`);
  return {
    states: await prisma.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
      SELECT * FROM "catalog_editorial_states"
      WHERE "tenantId" = ${tenantId} AND "productId" = ${productId}`),
    create: await read('create'),
    save: await read('save'),
    publish: await read('publish'),
    discard: await read('discard'),
  };
}

async function notReady(promise: Promise<unknown>) {
  const error: unknown = await promise.then(
    () => {
      throw new Error('Expected publish to be rejected as not ready');
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(EditorialPublicationNotReadyError);
  expect((error as Error).message).toBe('MALFORMED');
  return (error as EditorialPublicationNotReadyError).readiness;
}

/** Wait until `count` backends are blocked on a lock (bounded). */
async function waitForLockWaiters(count: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>(
      Prisma.sql`SELECT count(DISTINCT pid)::int AS waiting FROM pg_locks WHERE NOT granted`,
    );
    if (waiting >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Expected ${count} lock waiters`);
}

const openGates: ((commit: boolean) => void)[] = [];
afterEach(() => {
  // A failed assertion must never leave a gate holding locks.
  for (const release of openGates.splice(0)) release(false);
});

/** Holds a lock in its own transaction until released. */
function gate(work: (tx: Prisma.TransactionClient) => Promise<unknown>) {
  let release!: (commit: boolean) => void;
  const released = new Promise<boolean>((resolve) => (release = resolve));
  openGates.push(release);
  let ready!: () => void;
  const entered = new Promise<void>((resolve) => (ready = resolve));
  const settled = prisma
    .$transaction(
      async (tx) => {
        await work(tx);
        ready();
        if (!(await released)) throw new Error('ROLLBACK_GATE');
      },
      { timeout: 20_000 },
    )
    .catch((error: unknown) => {
      if (!(error instanceof Error && error.message === 'ROLLBACK_GATE'))
        throw error;
    });
  return { entered, release, settled };
}

beforeAll(async () => {
  prisma = integrationPrisma();
  await installCanonicalVocabulary(prisma);
  installed = true;
  revision = (
    await readEditorialVocabulary(new PrismaEditorialVocabularySnapshot(prisma))
  ).vocabularyRevision;
  await prisma.tenant.create({
    data: { id: tenantId, name: 'Publish', slug: 'publish-' + tenantId },
  });
  await prisma.globalPriceList.create({
    data: { id: globalPriceListId, name: 'Publish ' + globalPriceListId },
  });
  await prisma.tenantCatalogPriceList.create({
    data: { tenantId, globalPriceListId },
  });
  for (const [name, actions] of Object.entries(grants)) {
    const role = await prisma.role.create({
      data: { tenantId, name: `editorial-${name}` },
    });
    for (const action of actions) {
      const permission = await prisma.permission.upsert({
        where: {
          subject_action: { subject: 'ProductEditorialDraft', action },
        },
        create: { subject: 'ProductEditorialDraft', action },
        update: {},
      });
      await prisma.rolePermission.create({
        data: { roleId: role.id, permissionId: permission.id },
      });
    }
    const userId = actors[name as keyof typeof actors];
    await prisma.user.create({
      data: {
        id: userId,
        email: `${name}-${userId}@publish.test`,
        hashedPassword: 'x',
        name,
      },
    });
    await prisma.tenantMembership.create({
      data: { userId, tenantId, roleId: role.id },
    });
  }
}, 60_000);

afterAll(async () => {
  try {
    for (const table of Object.values(receiptTables))
      await prisma.$executeRaw(
        Prisma.sql`DELETE FROM ${table} WHERE "tenantId" = ${tenantId}`,
      );
    await prisma.$executeRaw(
      Prisma.sql`DELETE FROM "catalog_editorial_states" WHERE "tenantId" = ${tenantId}`,
    );
    await prisma.privateMediaAsset.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.user.deleteMany({
      where: { id: { in: Object.values(actors) } },
    });
    await prisma.globalPriceList.deleteMany({
      where: { id: globalPriceListId },
    });
  } finally {
    try {
      // Never truncate a vocabulary this spec did not install.
      if (installed) await uninstallVocabulary(prisma);
    } finally {
      await disconnectIntegrationPrisma();
    }
  }
});

describe('V2 publish on PostgreSQL', () => {
  it.each(['food', 'treat', 'toy', 'hygiene', 'accessory'] as const)(
    '%s: a ready draft is published as stored',
    async (family) => {
      const draft = readyDrafts[family]();
      const productId = await product(draft);
      const key = 'publish-' + family;
      const result = await publish(productId, { key });
      expect(result).toEqual({
        receiptVersion: 2,
        status: 200,
        body: {
          contractVersion: 2,
          vocabularyRevision: revision,
          state: {
            cycle: 1,
            draft: null,
            published: { revision: 1, document: draft },
          },
        },
        headers: {
          'Editorial-Contract-Version': '2',
          'Editorial-Vocabulary-Revision': revision,
        },
        careAttestation: null,
      });
      const after = await rows(productId);
      expect(after.states).toEqual([
        expect.objectContaining({
          cycle: 1,
          draftRevision: null,
          draftDocument: null,
          basePublishedRevision: null,
          publishedRevision: 1,
          publishedDocument: draft,
        }),
      ]);
      expect(after.publish).toEqual([
        expect.objectContaining({
          actorId: actors.editor,
          idempotencyKey: key,
          request: intent('publish'),
          result: JSON.parse(JSON.stringify(result)) as unknown,
        }),
      ]);
    },
  );

  it('keeps only the latest Published and increments its revision', async () => {
    const previous = { ...readyDrafts.food(), commercialTitle: 'Antes' };
    const productId = await product(readyDrafts.food(), {
      published: previous,
    });
    const result = await publish(productId);
    expect(result.body.state.published).toEqual({
      revision: 2,
      document: readyDrafts.food(),
    });
    expect((await rows(productId)).states[0]).toMatchObject({
      publishedRevision: 2,
      publishedDocument: readyDrafts.food(),
    });
  });

  it('care: stores the fresh care attestation in the receipt only', async () => {
    const draft = readyDrafts.care();
    const productId = await product(draft);
    const before = Date.now();
    const result = await publish(productId, { careConfirmation: 'review-v1' });
    expect(result.body.state.published?.revision).toBe(1);
    expect(result.careAttestation).toEqual({
      actorId: actors.editor,
      tenantId,
      productId,
      confirmedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/) as string,
      cycle: 1,
      draftRevision: 4,
      publishedRevision: 1,
      vocabularyRevision: revision,
      documentDigest: expect.stringMatching(
        /^ecd2-sha256-[0-9a-f]{64}$/,
      ) as string,
      subjects: [{ variantId: null, presentation: 'Pieza' }],
    });
    expect(
      Date.parse(result.careAttestation!.confirmedAt),
    ).toBeGreaterThanOrEqual(before - 1000);
    expect(JSON.stringify(result.body)).not.toContain('confirmedAt');
    const [receipt] = (await rows(productId)).publish;
    expect(receipt.result).toMatchObject({
      careAttestation: JSON.parse(
        JSON.stringify(result.careAttestation),
      ) as unknown,
    });
  });

  it.each([
    ['care without confirmation', 'care', null],
    ['non-care with confirmation', 'food', 'review-v1'],
  ] as const)(
    '%s is 400 MALFORMED without items and writes nothing',
    async (_, family, careConfirmation) => {
      const productId = await product(readyDrafts[family]());
      const before = await rows(productId);
      const error: unknown = await publish(productId, {
        careConfirmation,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(EditorialPublicationNotReadyError);
      expect((error as Error).message).toBe('MALFORMED');
      expect(await rows(productId)).toEqual(before);
    },
  );

  const values = (family: keyof typeof readyDrafts) =>
    (readyDrafts[family]() as Draft).values as Draft[];
  const blocked: [string, () => Draft, { offered?: boolean }?][] = [
    [
      'REQUIRED_MISSING',
      () => ({
        ...readyDrafts.food(),
        values: values('food').filter((v) => v.code !== 'measure.net_mass'),
      }),
    ],
    [
      'EVIDENCE_REQUIRED',
      () => ({
        ...readyDrafts.food(),
        values: values('food').map((v) =>
          v.code === 'food.format' ? { ...v, evidence: null } : v,
        ),
      }),
    ],
    [
      'NA_NOT_ALLOWED',
      () => ({
        ...readyDrafts.food(),
        values: values('food').map((v) =>
          v.code === 'animal.target'
            ? {
                ...v,
                state: 'not_applicable',
                payload: undefined,
                evidence: null,
              }
            : v,
        ),
      }),
    ],
    [
      'INVALID_VALUE',
      () => ({
        ...readyDrafts.food(),
        values: values('food').map((v) =>
          v.code === 'measure.net_mass'
            ? known('measure.net_mass', {
                type: 'number',
                value: 0,
                unit: 'kg',
              })
            : v,
        ),
      }),
    ],
    [
      'MAGNITUDE_MISMATCH',
      () => ({
        ...readyDrafts.food(),
        values: [
          ...values('food'),
          known('content.kind', {
            type: 'single',
            value: 'content.kind.volume',
          }),
        ],
      }),
    ],
    [
      'NOT_APPLICABLE_VALUE',
      () => ({
        ...readyDrafts.hygiene(),
        values: [
          ...values('hygiene'),
          known('hygiene.form', {
            type: 'single',
            value: 'hygiene.form.liquid',
          }),
        ],
      }),
    ],
    [
      'TOY_TYPES_MISMATCH',
      () => ({
        ...readyDrafts.toy(),
        facts: [
          {
            variantId: null,
            presentation: 'Pieza',
            declarations: [
              fact('relevantDimensionCodes', {
                codes: [],
                toyTypes: ['toy.type.rope'],
              }),
            ],
            careReview: null,
          },
        ],
      }),
    ],
    [
      'FACTS_CONFLICT',
      () => ({
        ...readyDrafts.accessory(),
        values: [
          ...values('accessory'),
          known('measure.fit.neck', {
            type: 'range',
            min: 20,
            max: 30,
            unit: 'cm',
          }),
        ],
        facts: [
          {
            variantId: null,
            presentation: 'Pieza',
            declarations: [
              fact('fitDeterminesChoice', false),
              fact('relevantFitCodes', ['measure.fit.neck']),
              fact('capacityDeterminesChoice', false),
              fact('relevantCapacityCodes', []),
              fact('electricalApplies', false),
              fact('relevantEquipmentCodes', []),
            ],
            careReview: null,
          },
        ],
      }),
    ],
    ['CARE_REVIEW_INCOMPLETE', () => readyDrafts.care({ state: 'unknown' })],
    [
      'CARE_REVIEW_INCOMPLETE (public warning, D11)',
      () => {
        const review = readyCareReview();
        review.warnings[0].disclosure = 'public_required';
        return readyDrafts.care(review);
      },
    ],
    ['NO_OFFERED_PRESENTATION', () => readyDrafts.food(), { offered: false }],
    [
      'REQUIRED_MISSING (title)',
      () => ({ ...readyDrafts.food(), commercialTitle: '   ' }),
    ],
    [
      'REQUIRED_MISSING (family)',
      () => ({
        ...readyDrafts.food(),
        familyCode: null,
        values: [],
        facts: [],
      }),
    ],
    [
      'DRAFT_INVALID (unknown definition)',
      () => ({
        ...readyDrafts.food(),
        values: [
          ...values('food'),
          known('no.such.code', { type: 'text', value: 'x' }),
        ],
      }),
    ],
    ['DRAFT_INVALID (not a V2 document)', () => ({ legacy: true })],
  ];
  // Object rows: a short tuple row would make Jest pass `done` as `options`.
  it.each(
    blocked.map(([name, build, options = {}]) => ({ name, build, options })),
  )(
    '$name: 400 with the readiness items and nothing written',
    async ({ name, build, options }) => {
      const draft = JSON.parse(JSON.stringify(build())) as Draft;
      const productId = await product(draft, options);
      const before = await rows(productId);
      const readiness = await new PrismaEditorialReadinessReader(prisma).read(
        scopeOf(productId),
        revision,
      );
      expect(readiness.ready).toBe(false);
      expect(readiness.items.map((i) => i.problem)).toContain(
        name.split(' ')[0],
      );
      const body = await notReady(
        publish(productId, {
          careConfirmation: draft.familyCode === 'care' ? 'review-v1' : null,
        }),
      );
      // Same list as the readiness GET: one rule implementation.
      expect(body).toEqual({
        items: readiness.items,
        bySection: readiness.bySection,
      });
      expect(await rows(productId)).toEqual(before);
    },
  );

  it('stale cycle or revision, or no draft, is CONFLICT without effects', async () => {
    const productId = await product(readyDrafts.food());
    const before = await rows(productId);
    for (const body of [
      { expectedCycle: 2, expectedRevision: 4 },
      { expectedCycle: 1, expectedRevision: 3 },
    ])
      await expect(publish(productId, { body })).rejects.toThrow('CONFLICT');
    expect(await rows(productId)).toEqual(before);
    const absent = await product(undefined);
    await expect(publish(absent)).rejects.toThrow('CONFLICT');
  });

  it('a changed vocabulary revision is VOCABULARY_CHANGED without effects', async () => {
    const productId = await product(readyDrafts.food());
    const before = await rows(productId);
    await expect(
      publish(productId, {
        vocabularyRevision: 'ev2-sha256-' + '0'.repeat(64),
      }),
    ).rejects.toThrow('VOCABULARY_CHANGED');
    expect(await rows(productId)).toEqual(before);
  });

  it('replays the recorded result; a different intent with the same key conflicts', async () => {
    const productId = await product(readyDrafts.food());
    const recorded = await publish(productId, { key: 'same' });
    // Later activity: a new cycle with a new Draft.
    await new PrismaEditorialInitializeWriter(prisma).initialize(
      scopeOf(productId),
      'init',
      intent('initialize', { expectedCycle: 1 }),
    );
    const baseline = await rows(productId);
    expect(await publish(productId, { key: 'same' })).toEqual(recorded);
    expect(await rows(productId)).toEqual(baseline);
    await expect(
      publish(productId, {
        key: 'same',
        body: { expectedCycle: 2, expectedRevision: 1 },
      }),
    ).rejects.toThrow('CONFLICT');
    // The same key in another receipt namespace is independent.
    await new PrismaEditorialDiscardWriter(prisma).discard(
      scopeOf(productId),
      'same',
      intent('discard', { expectedCycle: 2, expectedRevision: 1 }),
    );
    const after = await rows(productId);
    expect(after.publish).toEqual(baseline.publish);
    expect(after.discard).toHaveLength(1);
  });

  it('after publish and initialize, the consumed pair is stale everywhere', async () => {
    const productId = await product(readyDrafts.food());
    await publish(productId);
    await new PrismaEditorialInitializeWriter(prisma).initialize(
      scopeOf(productId),
      'init',
      intent('initialize', { expectedCycle: 1 }),
    );
    const baseline = await rows(productId);
    const stale = { expectedCycle: 1, expectedRevision: 4 };
    await expect(publish(productId, { body: stale })).rejects.toThrow(
      'CONFLICT',
    );
    await expect(
      new PrismaEditorialDiscardWriter(prisma).discard(
        scopeOf(productId),
        'stale-discard',
        intent('discard', stale),
      ),
    ).rejects.toThrow('CONFLICT');
    await expect(
      new PrismaEditorialSaveWriter(prisma).save(
        scopeOf(productId),
        'stale-save',
        intent('save', { ...stale, document: readyDrafts.food() }),
      ),
    ).rejects.toThrow('CONFLICT');
    expect(await rows(productId)).toEqual(baseline);
  });

  it('authority: publish needs read+publish (not update); discard needs update', async () => {
    const productId = await product(readyDrafts.food());
    const before = await rows(productId);
    await expect(
      publish(productId, { actorId: actors.reader }),
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      new PrismaEditorialDiscardWriter(prisma).discard(
        scopeOf(productId, actors.publisher),
        'discard',
        intent('discard'),
      ),
    ).rejects.toThrow('FORBIDDEN');
    expect(await rows(productId)).toEqual(before);
    const result = await publish(productId, { actorId: actors.publisher });
    expect(result.body.state.published?.revision).toBe(1);
    // A foreign tenant scope never reaches the product.
    await expect(
      publisher().publish(
        { ...scopeOf(productId), tenantId: randomUUID() },
        'foreign',
        intent('publish'),
      ),
    ).rejects.toThrow('FORBIDDEN');
  });

  it('discard clears an invalid draft without validating it and keeps Published and cycle', async () => {
    const published = readyDrafts.food();
    const productId = await product({ legacy: true }, { published });
    const result = await new PrismaEditorialDiscardWriter(prisma).discard(
      scopeOf(productId),
      'discard',
      intent('discard'),
    );
    expect(result.body.state).toEqual({
      cycle: 1,
      draft: null,
      published: { revision: 1, document: published },
    });
    expect((await rows(productId)).states[0]).toMatchObject({
      cycle: 1,
      draftRevision: null,
      draftDocument: null,
      publishedRevision: 1,
      publishedDocument: published,
    });
  });

  it.each(['save', 'discard'] as const)(
    'publish and a concurrent %s serialize on the Product: one wins, no deadlock',
    async (other) => {
      const productId = await product(readyDrafts.food());
      const hold = gate((tx) =>
        tx.$queryRaw(Prisma.sql`SELECT "id" FROM "products"
          WHERE "tenantId" = ${tenantId} AND "id" = ${productId} FOR UPDATE`),
      );
      await hold.entered;
      const first = publish(productId, { key: 'race' }).then(
        (value) => ({ ok: true as const, value }),
        (error: Error) => ({ ok: false as const, error }),
      );
      await waitForLockWaiters(1);
      const second = (
        other === 'save'
          ? new PrismaEditorialSaveWriter(prisma).save(
              scopeOf(productId),
              'race',
              intent('save', {
                expectedCycle: 1,
                expectedRevision: 4,
                document: readyDrafts.food(),
              }),
            )
          : new PrismaEditorialDiscardWriter(prisma).discard(
              scopeOf(productId),
              'race',
              intent('discard'),
            )
      ).then(
        (value) => ({ ok: true as const, value }),
        (error: Error) => ({ ok: false as const, error }),
      );
      await waitForLockWaiters(2);
      hold.release(true);
      await hold.settled;
      const [a, b] = await Promise.all([first, second]);
      // Publish queued first on the Product row, so it wins; the other is stale.
      expect(a.ok).toBe(true);
      expect(b).toMatchObject({ ok: false, error: { message: 'CONFLICT' } });
      const after = await rows(productId);
      expect(after.states[0]).toMatchObject({
        publishedRevision: 1,
        draftRevision: null,
      });
      expect(after.publish).toHaveLength(1);
      expect(after[other]).toEqual([]);
    },
  );

  it('a save that wins the race makes the pending publish stale', async () => {
    const productId = await product(readyDrafts.food());
    const hold = gate((tx) =>
      tx.$queryRaw(Prisma.sql`SELECT "id" FROM "products"
        WHERE "tenantId" = ${tenantId} AND "id" = ${productId} FOR UPDATE`),
    );
    await hold.entered;
    const save = new PrismaEditorialSaveWriter(prisma).save(
      scopeOf(productId),
      'race',
      intent('save', {
        expectedCycle: 1,
        expectedRevision: 4,
        document: readyDrafts.food(),
      }),
    );
    await waitForLockWaiters(1);
    const pending = publish(productId).catch((error: Error) => error);
    await waitForLockWaiters(2);
    hold.release(true);
    await hold.settled;
    expect((await save).body.state.draft?.revision).toBe(5);
    expect(await pending).toMatchObject({ message: 'CONFLICT' });
  });

  it('rolls back the state change fully when its receipt collides late', async () => {
    const productId = await product(readyDrafts.food());
    const baseline = await rows(productId);
    // An uncommitted receipt with the same key: invisible at lookup. Its FK
    // holds the state row, so the writer waits at state FOR UPDATE and later
    // collides at its own receipt INSERT, after the state UPDATE.
    const hold = gate((tx) =>
      tx.$executeRaw(Prisma.sql`INSERT INTO "catalog_editorial_publish_receipts"
        ("tenantId", "productId", "actorId", "idempotencyKey", "request", "result")
        VALUES (${tenantId}, ${productId}, ${actors.editor}, 'collide',
          '{"gate":true}'::jsonb, '{"gate":true}'::jsonb)`),
    );
    await hold.entered;
    const pending = publish(productId, { key: 'collide' }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await waitForLockWaiters(1);
    expect(await rows(productId)).toEqual(baseline);
    hold.release(true);
    await hold.settled;
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: 'P2010', meta: { code: '23505' } },
    });
    const after = await rows(productId);
    expect(after.states).toEqual(baseline.states);
    expect(after.publish).toEqual([
      expect.objectContaining({
        idempotencyKey: 'collide',
        request: { gate: true },
      }),
    ]);
  });

  it('holds the vocabulary SHARE locks through validation until it ends', async () => {
    const productId = await product(undefined);
    const assetId = randomUUID();
    await prisma.privateMediaAsset.create({
      data: {
        id: assetId,
        tenantId,
        productId,
        storageKey: 'publish/' + assetId,
        mimeType: 'image/png',
        sizeBytes: 1,
      },
    });
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "catalog_editorial_states"
        ("tenantId", "productId", "cycle", "draftRevision", "draftDocument")
      VALUES (${tenantId}, ${productId}, 1, 4, CAST(${JSON.stringify({
        ...readyDrafts.food(),
        mediaRefs: [assetId],
      })} AS JSONB))`);
    // The selected asset's FOR SHARE comes after the vocabulary locks: an
    // exclusive row lock on it parks the writer mid-validation.
    const hold = gate((tx) =>
      tx.$queryRaw(Prisma.sql`SELECT "id" FROM "private_media_assets"
        WHERE "id" = ${assetId} FOR UPDATE`),
    );
    await hold.entered;
    const pending = publish(productId).catch((error: unknown) => error);
    await waitForLockWaiters(1);
    // PrismaPromise is lazy: `.then` sends the statement now.
    const archive = prisma
      .$executeRaw(
        Prisma.sql`UPDATE "editorial_options" SET "archivedAt" = NULL
          WHERE "code" = 'food.format.kibble'`,
      )
      .then((count) => count);
    await waitForLockWaiters(2);
    hold.release(true);
    await hold.settled;
    // Media cannot be published yet: the writer ends (rollback), then the
    // option writer proceeds.
    expect(await pending).toBeInstanceOf(EditorialPublicationNotReadyError);
    expect(await archive).toBe(1);
  });
});

/**
 * L5: collecting rules run past the first failure, so malformed documents must
 * still end as MALFORMED (or a readiness item), never as a TypeError (500).
 * Every case is shape-valid V2 (the parser owns shape errors) and breaks a later
 * gate, alone or together with collectable problems.
 */
describe('malformed V2 documents never surface a TypeError', () => {
  const base = () => readyDrafts.food() as Draft;
  const vals = () => base().values as Draft[];
  const facts = (declarations: unknown[], careReview: unknown = null) => [
    { variantId: null, presentation: 'Pieza', declarations, careReview },
  ];
  // Collectable noise that used to stop the chain before later gates ran.
  const noisy = (d: Draft): Draft => ({
    ...d,
    commercialTitle: 'x'.repeat(201),
    values: (d.values as Draft[]).map((v) =>
      v.code === 'food.format'
        ? { ...v, evidence: { sourceRef: ' ', verifiedOn: '2026-02-30' } }
        : v.code === 'measure.net_mass'
          ? known('measure.net_mass', { type: 'number', value: -1, unit: 'kg' })
          : v,
    ),
  });
  const corpus: Record<string, () => Draft> = {
    'unknown definition': () => ({
      ...base(),
      values: [...vals(), known('no.such', { type: 'text', value: 'x' })],
    }),
    'wrong owner': () => ({
      ...base(),
      values: vals().map((v, i) => (i === 0 ? { ...v, owner: 'product' } : v)),
    }),
    'wrong payload type': () => ({
      ...base(),
      values: vals().map((v) =>
        v.code === 'food.format'
          ? known('food.format', { type: 'text', value: 'kibble' })
          : v,
      ),
    }),
    'unknown option': () => ({
      ...base(),
      values: vals().map((v) =>
        v.code === 'food.format'
          ? known('food.format', { type: 'single', value: 'food.format.nope' })
          : v,
      ),
    }),
    'unknown unit': () => ({
      ...base(),
      values: vals().map((v) =>
        v.code === 'measure.net_mass'
          ? known('measure.net_mass', { type: 'number', value: 2, unit: 'lb' })
          : v,
      ),
    }),
    'foreign variant': () => ({
      ...base(),
      values: vals().map((v, i) =>
        i === 0 ? { ...v, variantId: randomUUID() } : v,
      ),
    }),
    'duplicate value': () => ({ ...base(), values: [...vals(), vals()[0]] }),
    'unknown family': () => ({ ...base(), familyCode: 'no-such-family' }),
    'null family with values': () => ({ ...base(), familyCode: null }),
    'facts for a foreign subject': () => ({
      ...base(),
      facts: [{ ...(base().facts as Draft[])[0], variantId: randomUUID() }],
    }),
    'fact not allowed in the family': () => ({
      ...base(),
      facts: facts([
        fact('contentMagnitude', 'mass'),
        fact('relevantDimensionCodes', { codes: [], toyTypes: ['x'] }),
      ]),
    }),
    'invalid fact value': () => ({
      ...base(),
      facts: facts([fact('contentMagnitude', 'weight')]),
    }),
    'care review outside care': () => ({
      ...base(),
      facts: facts([fact('contentMagnitude', 'mass')], readyCareReview()),
    }),
    'invalid prepared care review': () => ({
      ...(readyDrafts.care() as Draft),
      facts: facts(
        [
          fact('contentMagnitude', 'volume'),
          fact('presentationKind', 'formulation'),
        ],
        {
          ...readyCareReview(),
          evidence: [{ sourceRef: '', verifiedOn: 'x' }],
        },
      ),
    }),
    'unbound not_applicable': () => ({
      ...base(),
      values: [
        ...vals(),
        {
          code: 'toy.type',
          owner: 'sellable',
          variantId: null,
          state: 'not_applicable',
          evidence: null,
        },
      ],
    }),
  };
  const cases = Object.entries(corpus).flatMap(([name, build]) => [
    { name, build },
    { name: name + ' + collectable problems', build: () => noisy(build()) },
  ]);
  /** Settles to MALFORMED or success; anything else (TypeError, 500) fails. */
  async function admitted(promise: Promise<unknown>) {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    if (error === null) return 'ok';
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe('MALFORMED');
    return error instanceof EditorialPublicationNotReadyError
      ? 'not-ready'
      : 'malformed';
  }
  const shapeOk = (d: Draft) => {
    try {
      intent('save', { expectedCycle: 1, expectedRevision: 4, document: d });
      return true;
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError); // shape error: HTTP 400
      return false;
    }
  };

  it.each(cases)(
    '$name: save, readiness, publish, initialize',
    async ({ build }) => {
      const document = JSON.parse(JSON.stringify(build())) as Draft;
      // Submitted: save rejects as MALFORMED (400), never a 500.
      const saved = await product(readyDrafts.food());
      if (shapeOk(document))
        expect(
          await admitted(
            new PrismaEditorialSaveWriter(prisma).save(
              scopeOf(saved),
              'save',
              intent('save', {
                expectedCycle: 1,
                expectedRevision: 4,
                document,
              }),
            ),
          ),
        ).toBe('malformed');
      // Stored Draft: readiness answers, publish is a 400 with items.
      const stored = await product(document);
      const readiness = await new PrismaEditorialReadinessReader(prisma).read(
        scopeOf(stored),
        revision,
      );
      expect(readiness.ready).toBe(false);
      expect(
        await admitted(
          publish(stored, {
            careConfirmation:
              document.familyCode === 'care' ? 'review-v1' : null,
          }),
        ),
      ).toBe('not-ready');
      // Stored Published: initialize copies it (S42: no conservation) or rejects.
      const source = await product(undefined);
      await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "catalog_editorial_states"
        ("tenantId", "productId", "cycle", "publishedRevision", "publishedDocument")
      VALUES (${tenantId}, ${source}, 1, 1, CAST(${JSON.stringify(document)} AS JSONB))`);
      const initialized = new PrismaEditorialInitializeWriter(
        prisma,
      ).initialize(
        scopeOf(source),
        'init',
        intent('initialize', { expectedCycle: 1 }),
      );
      if (isRecognizableDocumentV2(document))
        expect(await admitted(initialized)).not.toBe('not-ready');
      // Contract §2: an unrecognizable stored slot is INTERNAL_ERROR (500), as
      // in the document GET. That is the recorded-state decoder's deliberate
      // rejection, not a collecting rule, and predates T1.
      else
        await expect(initialized).rejects.toThrow(
          new TypeError('Expected a recorded editorial state V2'),
        );
    },
  );
});
