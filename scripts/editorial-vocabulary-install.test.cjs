// Explicit owned-restoration target only. Never loads dotenv or defaults to LOCALDEV.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const {
  installProductionVocabulary,
} = require('../prisma/editorial-production-vocabulary-install');
const {
  PrismaEditorialVocabularySnapshot,
} = require('../src/catalog-editorial/infrastructure/prisma-editorial-vocabulary-snapshot');
const {
  canonicalEditorialJson,
} = require('../src/catalog-editorial/domain/editorial-canonical-json');
const {
  readEditorialVocabulary,
} = require('../src/catalog-editorial/application/editorial-vocabulary-read');
const {
  validateFullProductionVocabularyV2,
} = require('../src/catalog-editorial/domain/editorial-vocabulary-full-production-v2');

const database = process.env.EDITORIAL_INSTALL_TEST_DATABASE;
assert.match(database || '', /^editorial_restore_[a-f0-9]{16}$/);
const url = new URL(process.env.EDITORIAL_INSTALL_TEST_URL);
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
assert.equal(url.port, '5432');
assert.equal(url.pathname, '/' + database);
const prisma = new PrismaClient({
  datasources: { db: { url: url.toString() } },
});
const snapshot = () => new PrismaEditorialVocabularySnapshot(prisma).read();
const digest = (value) =>
  createHash('sha256').update(canonicalEditorialJson(value)).digest('hex');

// One serial transaction lifecycle; a successful commit intentionally leaves this owned clone installed.
test('install only into the explicitly bound disposable restoration', async (t) => {
  try {
    const identity =
      await prisma.$queryRaw`SELECT current_database() AS database`;
    assert.equal(identity[0].database, database);
    const before = await snapshot();
    assert.equal(before.metadata, null);
    assert.equal(before.definitions.length, 5);
    const hash = digest(before);
    const preserved = await prisma.$queryRaw`SELECT
      (SELECT md5(coalesce(string_agg(to_jsonb(s)::text, '' ORDER BY "tenantId", "productId"), '')) FROM catalog_editorial_states s) AS states,
      (SELECT md5(coalesce(string_agg(to_jsonb(p)::text, '' ORDER BY id), '')) FROM products p) AS products`;

    await t.test(
      'before-image conflict leaves the vocabulary unchanged',
      async () => {
        await assert.rejects(
          installProductionVocabulary(prisma, '0'.repeat(64), true),
          /VOCABULARY_INSTALL_PRECONDITION_FAILED/,
        );
        assert.deepEqual(await snapshot(), before);
      },
    );
    await t.test(
      'default dry run validates all inserts then rolls them back',
      async () => {
        assert.deepEqual(await installProductionVocabulary(prisma, hash), {
          committed: false,
          canonicalDefinitions: 68,
        });
        assert.deepEqual(await snapshot(), before);
      },
    );
    await t.test(
      'mid-write failure rolls back parent and child inserts',
      async () => {
        const failing = {
          $transaction: (callback, options) =>
            prisma.$transaction(
              (tx) =>
                callback(
                  new Proxy(tx, {
                    get(target, key) {
                      if (key === 'editorialUnit')
                        return {
                          createMany: async () => {
                            throw new Error('INJECTED_WRITE_FAILURE');
                          },
                        };
                      return Reflect.get(target, key);
                    },
                  }),
                ),
              options,
            ),
        };
        await assert.rejects(
          installProductionVocabulary(failing, hash, true),
          /INJECTED_WRITE_FAILURE/,
        );
        assert.deepEqual(await snapshot(), before);
      },
    );
    await t.test(
      'commit yields full publicly representable vocabulary without touching product state',
      async () => {
        assert.deepEqual(
          await installProductionVocabulary(prisma, hash, true),
          { committed: true, canonicalDefinitions: 68 },
        );
        const readback = await readEditorialVocabulary(
          new PrismaEditorialVocabularySnapshot(prisma),
        );
        assert.equal(
          validateFullProductionVocabularyV2(readback.vocabulary).definitions
            .length,
          73,
        );
        const after = await snapshot();
        const expectedStarter = structuredClone(before);
        for (const b of expectedStarter.families[0].bindings) {
          b.publicationCheck = 'when_asserted';
          b.policy = { route: 'pending' };
        }
        expectedStarter.definitions.find(
          (d) => d.code === 'starter.weight',
        ).numericPolicy = { status: 'pending' };
        assert.deepEqual(
          after.families.filter((f) => f.code === 'starter.general'),
          expectedStarter.families,
        );
        assert.deepEqual(
          after.definitions.filter((d) => d.code.startsWith('starter.')),
          expectedStarter.definitions,
        );
        assert.deepEqual(
          await prisma.$queryRaw`SELECT
        (SELECT md5(coalesce(string_agg(to_jsonb(s)::text, '' ORDER BY "tenantId", "productId"), '')) FROM catalog_editorial_states s) AS states,
        (SELECT md5(coalesce(string_agg(to_jsonb(p)::text, '' ORDER BY id), '')) FROM products p) AS products`,
          preserved,
        );
      },
    );
    await t.test(
      'reapplying a stale before-image neither overwrites nor duplicates data',
      async () => {
        const installed = await snapshot();
        await assert.rejects(
          installProductionVocabulary(prisma, hash, true),
          /VOCABULARY_INSTALL_PRECONDITION_FAILED/,
        );
        assert.deepEqual(await snapshot(), installed);
      },
    );
  } finally {
    await prisma.$disconnect();
  }
});
