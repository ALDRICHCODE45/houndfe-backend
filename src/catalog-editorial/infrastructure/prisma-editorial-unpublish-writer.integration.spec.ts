import { Prisma, type PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  disconnectIntegrationPrisma,
  integrationPrisma,
} from '../../../test/integration/reset-db';
import { readEditorialVocabulary } from '../application/editorial-vocabulary-read';
import { createEditorialWriteRequestV2 } from '../application/editorial-write-request-v2';
import { coversPublishedSubjectV2 } from '../domain/editorial-published-subjects-v2';
import { PrismaEditorialInitializeWriter } from './prisma-editorial-initialize-writer';
import { readEditorialPublishedCoverageV2 } from './prisma-editorial-published-coverage-v2';
import { PrismaEditorialPublishWriter } from './prisma-editorial-publish-writer';
import { PrismaEditorialUnpublishWriter } from './prisma-editorial-unpublish-writer';
import { PrismaEditorialVocabularySnapshot } from './prisma-editorial-vocabulary-snapshot';
import {
  installCanonicalVocabulary,
  readyDrafts,
  uninstallVocabulary,
} from './test-support/editorial-publication-postgres';

// Real PostgreSQL: publish records E (S5) and unpublish removes Published (S6).
const tenantId = randomUUID();
const globalPriceListId = randomUUID();
const actors = {
  editor: randomUUID(),
  publisher: randomUUID(),
  updater: randomUUID(),
  reader: randomUUID(),
};
const grants = {
  editor: ['read', 'update', 'publish'],
  publisher: ['read', 'publish'],
  updater: ['read', 'update'],
  reader: ['read'],
} as const;

let prisma: PrismaClient;
let installed = false;
let revision: string;
const scopeOf = (productId: string, actorId: string = actors.editor) => ({
  actorId,
  tenantId,
  productId,
});
type Draft = Record<string, unknown>;

const intent = (
  operation: 'publish' | 'unpublish' | 'initialize',
  body: object,
  vocabularyRevision = revision,
) =>
  createEditorialWriteRequestV2(
    operation,
    { vocabularyRevision, careConfirmation: null },
    body,
  );
const publish = (
  productId: string,
  body: object,
  key = 'publish-' + randomUUID(),
) =>
  new PrismaEditorialPublishWriter(prisma).publish(
    scopeOf(productId),
    key,
    intent('publish', body),
  );
const unpublish = (
  productId: string,
  body: object,
  {
    key = 'unpublish-' + randomUUID(),
    actorId = actors.editor,
    vocabularyRevision = revision,
  }: { key?: string; actorId?: string; vocabularyRevision?: string } = {},
) =>
  new PrismaEditorialUnpublishWriter(prisma).unpublish(
    scopeOf(productId, actorId),
    key,
    intent('unpublish', body, vocabularyRevision),
  );

/** A simple product (no variants) offered on the tenant catalog list. */
async function simpleProduct(): Promise<string> {
  const productId = randomUUID();
  await prisma.product.create({
    data: { id: productId, tenantId, name: 'Simple ' + productId.slice(0, 8) },
  });
  await prisma.priceList.create({
    data: { tenantId, productId, globalPriceListId, priceCents: 25000 },
  });
  return productId;
}

/** A variant product: `offered` variants are priced, the rest are OFF. */
async function variantProduct(offered: number, off = 0) {
  const productId = randomUUID();
  await prisma.product.create({
    data: {
      id: productId,
      tenantId,
      name: 'Variantes ' + productId.slice(0, 8),
      hasVariants: true,
    },
  });
  const priceList = await prisma.priceList.create({
    data: { tenantId, productId, globalPriceListId, priceCents: 25000 },
  });
  const variantIds: string[] = [];
  const offIds: string[] = [];
  for (let i = 0; i < offered + off; i++) {
    const id = randomUUID();
    await prisma.variant.create({
      data: {
        id,
        tenantId,
        productId,
        name: `Talla ${i}`,
        catalogPublishMode: i < offered ? 'INHERIT' : 'OFF',
      },
    });
    await prisma.variantPrice.create({
      data: {
        tenantId,
        variantId: id,
        priceListId: priceList.id,
        priceCents: 25000,
      },
    });
    (i < offered ? variantIds : offIds).push(id);
  }
  return { productId, priceListId: priceList.id, variantIds, offIds };
}

/** A ready food draft whose sellable values and facts name each subject. */
function draftFor(subjects: (string | null)[]): Draft {
  const base = readyDrafts.food();
  const [row] = base.facts;
  return {
    ...base,
    values: subjects.flatMap((variantId) =>
      base.values.map((value) => ({ ...value, variantId })),
    ),
    facts: subjects.map((variantId) => ({ ...row, variantId })),
  };
}

async function saveDraft(
  productId: string,
  draft: Draft,
  {
    cycle = 1,
    draftRevision = 4,
    base = null,
  }: { cycle?: number; draftRevision?: number; base?: number | null } = {},
) {
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "catalog_editorial_states"
      ("tenantId", "productId", "cycle", "draftRevision", "basePublishedRevision",
       "draftDocument")
    VALUES (${tenantId}, ${productId}, ${cycle}, ${draftRevision}, ${base},
      CAST(${JSON.stringify(draft)} AS JSONB))
    ON CONFLICT ("tenantId", "productId") DO UPDATE SET
      "cycle" = EXCLUDED."cycle", "draftRevision" = EXCLUDED."draftRevision",
      "basePublishedRevision" = EXCLUDED."basePublishedRevision",
      "draftDocument" = EXCLUDED."draftDocument"`);
}

const receiptTables = {
  create: Prisma.sql`"catalog_editorial_create_receipts"`,
  save: Prisma.sql`"catalog_editorial_save_receipts"`,
  publish: Prisma.sql`"catalog_editorial_publish_receipts"`,
  discard: Prisma.sql`"catalog_editorial_discard_receipts"`,
  unpublish: Prisma.sql`"catalog_editorial_unpublish_receipts"`,
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
    publish: await read('publish'),
    unpublish: await read('unpublish'),
  };
}

const covers = async (productId: string, subject: string | null) =>
  coversPublishedSubjectV2(
    (await readEditorialPublishedCoverageV2(prisma, tenantId, [productId])).get(
      productId,
    ),
    subject,
  );

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

const settle = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: Error) => ({ ok: false as const, error }),
  );

beforeAll(async () => {
  prisma = integrationPrisma();
  await installCanonicalVocabulary(prisma);
  installed = true;
  revision = (
    await readEditorialVocabulary(new PrismaEditorialVocabularySnapshot(prisma))
  ).vocabularyRevision;
  await prisma.tenant.create({
    data: { id: tenantId, name: 'Unpublish', slug: 'unpublish-' + tenantId },
  });
  await prisma.globalPriceList.create({
    data: { id: globalPriceListId, name: 'Unpublish ' + globalPriceListId },
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
        email: `${name}-${userId}@unpublish.test`,
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
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.user.deleteMany({
      where: { id: { in: Object.values(actors) } },
    });
    await prisma.globalPriceList.deleteMany({
      where: { id: globalPriceListId },
    });
  } finally {
    try {
      if (installed) await uninstallVocabulary(prisma);
    } finally {
      await disconnectIntegrationPrisma();
    }
  }
});

describe('publish records the covered subjects (S5)', () => {
  it('a simple product records its presentation', async () => {
    const productId = await simpleProduct();
    await saveDraft(productId, draftFor([null]));
    await publish(productId, { expectedCycle: 1, expectedRevision: 4 });
    expect((await rows(productId)).states[0]).toMatchObject({
      publishedRevision: 1,
      publishedSubjects: [null],
    });
    expect(await covers(productId, null)).toBe(true);
  });

  it('records offered variants only; a later-offered variant waits for a republish', async () => {
    const { productId, priceListId, variantIds, offIds } = await variantProduct(
      2,
      1,
    );
    await saveDraft(productId, draftFor(variantIds));
    const key = 'publish-variants';
    const recorded = await publish(
      productId,
      { expectedCycle: 1, expectedRevision: 4 },
      key,
    );
    const sorted = [...variantIds].sort();
    expect((await rows(productId)).states[0]).toMatchObject({
      publishedSubjects: sorted,
    });
    for (const id of variantIds) expect(await covers(productId, id)).toBe(true);
    expect(await covers(productId, offIds[0])).toBe(false);

    // A new variant becomes offered after the publish: not covered.
    const later = randomUUID();
    await prisma.variant.create({
      data: { id: later, tenantId, productId, name: 'Nueva' },
    });
    await prisma.variantPrice.create({
      data: { tenantId, variantId: later, priceListId, priceCents: 9000 },
    });
    expect(await covers(productId, later)).toBe(false);

    // Replay returns the recorded result and never rewrites the recording.
    const before = await rows(productId);
    expect(
      await publish(productId, { expectedCycle: 1, expectedRevision: 4 }, key),
    ).toEqual(recorded);
    expect(await rows(productId)).toEqual(before);

    // Republishing a draft that names it covers it.
    await new PrismaEditorialInitializeWriter(prisma).initialize(
      scopeOf(productId),
      'init',
      intent('initialize', { expectedCycle: 1 }),
    );
    await saveDraft(productId, draftFor([...variantIds, later]), {
      cycle: 2,
      draftRevision: 1,
      base: 1,
    });
    await publish(productId, { expectedCycle: 2, expectedRevision: 1 });
    expect((await rows(productId)).states[0]).toMatchObject({
      publishedRevision: 2,
      publishedSubjects: [...variantIds, later].sort(),
    });
    expect(await covers(productId, later)).toBe(true);
  });
});

describe('unpublish on PostgreSQL (S6)', () => {
  async function published(withDraft: boolean) {
    const productId = await simpleProduct();
    await saveDraft(productId, draftFor([null]));
    await publish(productId, { expectedCycle: 1, expectedRevision: 4 });
    if (withDraft)
      await saveDraft(
        productId,
        { ...draftFor([null]), commercialTitle: 'Borrador' },
        { cycle: 1, draftRevision: 7, base: 1 },
      );
    return productId;
  }

  it('removes Published and its subjects, keeps the draft and cycle, records the receipt', async () => {
    const productId = await published(true);
    const draft = { ...draftFor([null]), commercialTitle: 'Borrador' };
    const key = 'unpublish-keep';
    const result = await unpublish(
      productId,
      { expectedCycle: 1, expectedRevision: 1 },
      { key },
    );
    expect(result).toEqual({
      receiptVersion: 2,
      status: 200,
      body: {
        contractVersion: 2,
        vocabularyRevision: revision,
        state: {
          cycle: 1,
          draft: { revision: 7, basePublishedRevision: 1, document: draft },
          published: null,
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
        draftRevision: 7,
        basePublishedRevision: 1,
        draftDocument: draft,
        publishedRevision: null,
        publishedDocument: null,
        publishedSubjects: null,
      }),
    ]);
    expect(after.unpublish).toEqual([
      expect.objectContaining({
        actorId: actors.editor,
        idempotencyKey: key,
        request: intent('unpublish', { expectedCycle: 1, expectedRevision: 1 }),
        result: JSON.parse(JSON.stringify(result)) as unknown,
      }),
    ]);
    expect(await covers(productId, null)).toBe(false);
  });

  it('without a draft the state keeps only its cycle', async () => {
    const productId = await published(false);
    const result = await unpublish(productId, {
      expectedCycle: 1,
      expectedRevision: 1,
    });
    expect(result.body.state).toEqual({
      cycle: 1,
      draft: null,
      published: null,
    });
  });

  it('replays the recorded result; a different intent with the same key conflicts', async () => {
    const productId = await published(false);
    const body = { expectedCycle: 1, expectedRevision: 1 };
    const recorded = await unpublish(productId, body, { key: 'same' });
    // Later activity: published again at the next revision.
    await saveDraft(productId, draftFor([null]), { draftRevision: 9 });
    await publish(productId, { expectedCycle: 1, expectedRevision: 9 });
    const baseline = await rows(productId);
    expect(await unpublish(productId, body, { key: 'same' })).toEqual(recorded);
    expect(await rows(productId)).toEqual(baseline);
    await expect(
      unpublish(
        productId,
        { expectedCycle: 1, expectedRevision: 2 },
        { key: 'same' },
      ),
    ).rejects.toThrow('CONFLICT');
    expect(await rows(productId)).toEqual(baseline);
  });

  it('stale cycle, stale revision or nothing published is CONFLICT without effects', async () => {
    const productId = await published(true);
    const before = await rows(productId);
    for (const body of [
      { expectedCycle: 2, expectedRevision: 1 },
      { expectedCycle: 1, expectedRevision: 2 },
    ])
      await expect(unpublish(productId, body)).rejects.toThrow('CONFLICT');
    expect(await rows(productId)).toEqual(before);

    const draftOnly = await simpleProduct();
    await saveDraft(draftOnly, draftFor([null]));
    const draftBefore = await rows(draftOnly);
    await expect(
      unpublish(draftOnly, { expectedCycle: 1, expectedRevision: 1 }),
    ).rejects.toThrow('CONFLICT');
    expect(await rows(draftOnly)).toEqual(draftBefore);
    await expect(
      unpublish(await simpleProduct(), {
        expectedCycle: 1,
        expectedRevision: 1,
      }),
    ).rejects.toThrow('CONFLICT');
  });

  it('a changed vocabulary revision is VOCABULARY_CHANGED without effects', async () => {
    const productId = await published(false);
    const before = await rows(productId);
    await expect(
      unpublish(
        productId,
        { expectedCycle: 1, expectedRevision: 1 },
        { vocabularyRevision: 'ev2-sha256-' + '0'.repeat(64) },
      ),
    ).rejects.toThrow('VOCABULARY_CHANGED');
    expect(await rows(productId)).toEqual(before);
  });

  it('authority: read + publish is required; update does not suffice', async () => {
    const productId = await published(false);
    const before = await rows(productId);
    const body = { expectedCycle: 1, expectedRevision: 1 };
    for (const actorId of [actors.reader, actors.updater])
      await expect(unpublish(productId, body, { actorId })).rejects.toThrow(
        'FORBIDDEN',
      );
    await expect(
      new PrismaEditorialUnpublishWriter(prisma).unpublish(
        { ...scopeOf(productId), tenantId: randomUUID() },
        'foreign',
        intent('unpublish', body),
      ),
    ).rejects.toThrow('FORBIDDEN');
    expect(await rows(productId)).toEqual(before);
    const result = await unpublish(productId, body, {
      actorId: actors.publisher,
    });
    expect(result.body.state.published).toBeNull();
  });

  it('never reuses a Published revision after unpublish', async () => {
    const productId = await published(false);
    await unpublish(productId, { expectedCycle: 1, expectedRevision: 1 });
    await saveDraft(productId, draftFor([null]), { draftRevision: 5 });
    const again = await publish(productId, {
      expectedCycle: 1,
      expectedRevision: 5,
    });
    expect(again.body.state.published?.revision).toBe(2);
    expect((await rows(productId)).states[0]).toMatchObject({
      publishedRevision: 2,
      publishedSubjects: [null],
    });
    // The stale pair of the removed publication cannot unpublish the new one.
    const before = await rows(productId);
    await expect(
      unpublish(productId, { expectedCycle: 1, expectedRevision: 1 }),
    ).rejects.toThrow('CONFLICT');
    expect(await rows(productId)).toEqual(before);
  });

  it('takes the Tenant SHARE lock before the Product: a Tenant writer blocks it', async () => {
    const productId = await published(false);
    const hold = gate((tx) =>
      tx.$queryRaw(Prisma.sql`SELECT "id" FROM "tenants"
        WHERE "id" = ${tenantId} FOR UPDATE`),
    );
    await hold.entered;
    const pending = settle(
      unpublish(productId, { expectedCycle: 1, expectedRevision: 1 }),
    );
    await waitForLockWaiters(1);
    // Still waiting: nothing changed yet.
    expect((await rows(productId)).states[0]).toMatchObject({
      publishedRevision: 1,
    });
    hold.release(true);
    await hold.settled;
    expect(await pending).toMatchObject({ ok: true });
  });

  it('publish and a concurrent unpublish serialize on the Product: one wins, no deadlock', async () => {
    const productId = await published(true);
    const hold = gate((tx) =>
      tx.$queryRaw(Prisma.sql`SELECT "id" FROM "products"
        WHERE "tenantId" = ${tenantId} AND "id" = ${productId} FOR UPDATE`),
    );
    await hold.entered;
    const first = settle(
      publish(productId, { expectedCycle: 1, expectedRevision: 7 }),
    );
    await waitForLockWaiters(1);
    const second = settle(
      unpublish(productId, { expectedCycle: 1, expectedRevision: 1 }),
    );
    await waitForLockWaiters(2);
    hold.release(true);
    await hold.settled;
    const [a, b] = await Promise.all([first, second]);
    // Publish queued first, so it wins; the unpublish names a stale revision.
    expect(a.ok).toBe(true);
    expect(b).toMatchObject({ ok: false, error: { message: 'CONFLICT' } });
    const after = await rows(productId);
    expect(after.states[0]).toMatchObject({ publishedRevision: 2 });
    expect(after.unpublish).toEqual([]);
  });
});
