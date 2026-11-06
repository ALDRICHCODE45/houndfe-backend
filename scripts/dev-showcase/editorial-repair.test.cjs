// Offline: `node --test scripts/dev-showcase/editorial-repair.test.cjs`
// (stub decoder and fake Prisma; no dist/, no database).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LEGACY_EDITORIAL_PRODUCTS,
  planRepair,
  repairLegacyEditorialStates,
} = require('./editorial-repair.cjs');

// Stands in for the API decoder: a TypeError for any non-V2 document.
function decode({ state }) {
  for (const slot of [state.draft, state.published])
    if (slot && slot.document?.schemaVersion !== 2)
      throw new TypeError('Expected a recorded editorial state V2');
}
const v2 = { schemaVersion: 2 };
const legacy = { schemaVersion: 1, commercialTitle: 'secreto' };
const draft = (document) => ({
  revision: 3,
  basePublishedRevision: null,
  document,
});
const published = (document) => ({ revision: 2, document });
const row = (name, fields) => ({
  productId: 'p-' + name,
  name,
  draft: null,
  published: null,
  referenced: false,
  ...fields,
});

test('plans only the slots that do not decode as V2', () => {
  const { counts, actions } = planRepair(
    [
      row('valid', { draft: draft(v2), published: published(v2) }),
      row('legacy draft', { draft: draft(legacy) }),
      row('legacy published, valid draft', {
        draft: draft(v2),
        published: published(legacy),
      }),
      row('all legacy, referenced', {
        draft: draft(legacy),
        published: published(legacy),
        referenced: true,
      }),
    ],
    decode,
  );
  assert.deepEqual(
    actions.map((a) => a.action),
    ['none', 'delete', 'clear', 'clear'],
  );
  assert.deepEqual(actions[2], {
    productId: 'p-legacy published, valid draft',
    name: 'legacy published, valid draft',
    action: 'clear',
    clearDraft: false,
    clearPublished: true,
  });
  assert.deepEqual(counts, {
    rowsMatched: 4,
    slotsCleared: 4,
    rowsDeleted: 1,
    rowsKeptReferenced: 1,
  });
});

test('a referenced row is never deleted; an unexpected decoder error propagates', () => {
  const { actions } = planRepair(
    [row('x', { draft: draft(legacy), referenced: true })],
    decode,
  );
  assert.equal(actions[0].action, 'clear');
  assert.throws(
    () =>
      planRepair([row('x', { draft: draft(v2) })], () => {
        throw new Error('boom');
      }),
    /boom/,
  );
});

function fakePrisma(rows) {
  const queries = [];
  const writes = [];
  const tx = {
    tenant: { findUnique: async () => ({ id: 'centro-id' }) },
    $queryRaw: async (sql) => {
      queries.push(sql);
      return rows;
    },
    $executeRaw: async (sql) => {
      writes.push(sql);
      return 1;
    },
  };
  return {
    queries,
    writes,
    prisma: { $transaction: (work) => work(tx) },
  };
}

test('dry run is the default: counts only, no writes, no document contents', async () => {
  const fake = fakePrisma([row('legacy', { draft: draft(legacy) })]);
  const report = await repairLegacyEditorialStates(fake.prisma, { decode });
  assert.equal(fake.writes.length, 0);
  assert.deepEqual(report, {
    applied: false,
    rowsMatched: 1,
    slotsCleared: 1,
    rowsDeleted: 1,
    rowsKeptReferenced: 0,
    products: ['legacy'],
  });
  assert.equal(JSON.stringify(report).includes('secreto'), false);
  // Selection is scoped to the centro tenant and the four named products.
  const [select] = fake.queries;
  assert.match(select.text, /s\."tenantId" = \$1/);
  assert.match(select.sql, /FOR UPDATE OF s/);
  assert.deepEqual(select.values, ['centro-id', ...LEGACY_EDITORIAL_PRODUCTS]);
});

test('--apply clears or deletes each planned row, scoped by tenant and product', async () => {
  const fake = fakePrisma([
    row('a', { draft: draft(legacy) }),
    row('b', { draft: draft(v2), published: published(legacy) }),
    row('c', { draft: draft(v2) }),
  ]);
  const report = await repairLegacyEditorialStates(fake.prisma, {
    decode,
    apply: true,
  });
  assert.equal(report.applied, true);
  assert.deepEqual(
    fake.writes.map((sql) => [sql.sql.trim().split(/\s+/)[0], sql.values]),
    [
      ['DELETE', ['centro-id', 'p-a']],
      ['UPDATE', ['centro-id', 'p-b']],
    ],
  );
  assert.match(fake.writes[1].sql, /"unpublishedRevision" = GREATEST/);
  assert.doesNotMatch(fake.writes[1].sql, /draftDocument/);
});

test('a second run after the repair finds nothing to do', async () => {
  const fake = fakePrisma([row('a', { draft: draft(v2) })]);
  const report = await repairLegacyEditorialStates(fake.prisma, {
    decode,
    apply: true,
  });
  assert.equal(report.slotsCleared, 0);
  assert.equal(fake.writes.length, 0);
});
