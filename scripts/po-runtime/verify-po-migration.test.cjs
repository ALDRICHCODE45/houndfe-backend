'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  splitMigrations,
  verifyAdditive,
  verifyO3cDelta,
  seedO3bDrafts,
  o3cProof,
  expectSqlError,
  directProof,
  redact,
  FORWARD,
  O3C,
} = require('./verify-po-migration.cjs');
const migration = (name) => `prisma/migrations/${name}/migration.sql`;
test('migration tree splits into baseline, O3b forward and the two ordered O3c migrations; unexpected paths fail closed', () => {
  const files = [
    'prisma/migrations/migration_lock.toml',
    migration('20260502052444_multi_tenant_foundation'),
    migration('20261103010100_supplier_delete_evidence'),
    migration(FORWARD),
    ...O3C.map(migration),
  ];
  const split = splitMigrations(files);
  assert.deepEqual(split.baseline, files.slice(0, 3));
  assert.equal(split.forward, migration(FORWARD));
  assert.deepEqual(split.o3c, O3C.map(migration));
  for (const invalid of [
    // missing lock, forward or either O3c migration
    files.slice(1),
    files.filter((f) => f !== migration(FORWARD)),
    files.filter((f) => f !== migration(O3C[0])),
    files.filter((f) => f !== migration(O3C[1])),
    // anything newer than O3c, or unknown between O3b and O3c
    [...files, migration('20270101000000_unknown')],
    [...files, '../escape'],
    [
      ...files.slice(0, 4),
      migration('20261104010150_unreviewed_extra'),
      ...files.slice(4),
    ],
  ])
    assert.throws(() => splitMigrations(invalid));
});
test('additive preservation rejects a changed row hash, old column, index or constraint', () => {
  const before = {
    tenants: {
      count: 1,
      dataHash: 'hash',
      columns: ['id'],
      constraints: ['tenant_fk'],
      indexes: ['tenant_pk'],
    },
  };
  verifyAdditive(before, structuredClone(before));
  for (const field of [
    'count',
    'dataHash',
    'columns',
    'constraints',
    'indexes',
  ]) {
    const after = structuredClone(before);
    after.tenants[field] = null;
    assert.throws(() => verifyAdditive(before, after));
  }
});
test('sanitized logs redact explicit password, URL and unrecognized URL variants', () => {
  const output = redact(
    'private-password postgresql://u:private-password@host/db postgres://other:secret@host/db',
    ['private-password'],
  );
  assert(!output.includes('private-password'));
  assert(!output.includes('secret'));
  assert(!output.includes('://'));
});
test('SQL rejection proves exact driver code AND named constraint, not just any exception', async () => {
  const db = (error) => ({
    query: async () => {
      if (error) throw error;
      return { rows: [] };
    },
  });
  assert.deepEqual(
    await expectSqlError(
      db({ code: '23503', constraint: 'po_supplier_fk' }),
      'query',
      [],
      '23503',
      'po_supplier_fk',
    ),
    { code: '23503', constraint: 'po_supplier_fk' },
  );
  for (const error of [
    null,
    new Error('setup failure'),
    { code: '23503', constraint: 'wrong' },
    { code: '23514', constraint: 'po_supplier_fk' },
  ])
    await assert.rejects(() =>
      expectSqlError(db(error), 'query', [], '23503', 'po_supplier_fk'),
    );
});
function adapter(field = 'po_supplier_fk') {
  let pins = 0;
  const calls = [];
  const db = {
    query: async (sql, values) => {
      calls.push(sql);
      assert.equal(pins, 1);
      if (
        sql.startsWith('INSERT INTO procurement_purchase_orders') &&
        calls.filter((s) =>
          s.startsWith('INSERT INTO procurement_purchase_orders'),
        ).length === 2
      )
        throw { code: '23503', constraint: 'po_supplier_fk' };
      if (sql.includes('INSERT INTO procurement_purchase_order_lines')) {
        const [, , , quantity, present, amount, currency] = values;
        let constraint;
        if (currency === 'USD') constraint = 'po_line_currency_check';
        else if (['0', '01', '1.0001', '1e2'].includes(quantity))
          constraint = 'po_line_quantity_check';
        else if (['-1', '01', '1.00001'].includes(amount))
          constraint = 'po_line_amount_check';
        else if (!present) constraint = 'po_line_cost_presence_check';
        if (constraint) throw { code: '23514', constraint };
      }
      if (
        sql.startsWith('DELETE FROM procurement_suppliers') &&
        calls.filter((s) => s.startsWith('DELETE FROM procurement_suppliers'))
          .length === 1
      )
        throw { code: '23503', constraint: 'po_supplier_fk' };
      if (sql.startsWith('DELETE FROM tenants'))
        throw { code: '23503', constraint: 'po_audit_tenant_fk' };
      if (sql.includes("SELECT 'audit' AS kind"))
        return {
          rows: [
            { kind: 'audit', record: '{}' },
            { kind: 'receipt', record: '{}' },
          ],
        };
      return {
        rows: sql.includes('count(*)')
          ? [
              {
                n: calls.some((s) =>
                  s.startsWith('DELETE FROM procurement_purchase_orders'),
                )
                  ? 0
                  : 1,
              },
            ]
          : [],
      };
    },
  };
  const prisma = {
    procurementSupplier: {
      deleteMany: async () => {
        throw {
          code: 'P2003',
          meta: { modelName: 'ProcurementSupplier', constraint: field },
        };
      },
    },
  };
  return {
    db,
    prisma,
    pin: async () => {
      pins++;
    },
    calls,
  };
}
test('direct proof pins before fixture writes and records only bounded P2003 metadata', async () => {
  const f = adapter();
  const result = await directProof(f.db, f.prisma, f.pin);
  assert.deepEqual(result.prisma, {
    code: 'P2003',
    constraint: 'po_supplier_fk',
  });
  assert.equal(result.errors.length, 12);
  assert(
    result.lineCascade && result.evidencePreserved && result.tenantRestrict,
  );
  assert(
    f.calls.some((s) => s.includes('DELETE FROM procurement_purchase_orders')),
  );
});
test('unexpected/missing Prisma field metadata fails, never reports a false named-FK proof', async () => {
  for (const field of [
    undefined,
    'other_fk',
    'po_supplier_fk (index)',
    'secret arbitrary message',
  ]) {
    const f = adapter(field);
    if (field === undefined)
      f.prisma.procurementSupplier.deleteMany = async () => {
        throw { code: 'P2003', meta: {} };
      };
    await assert.rejects(() => directProof(f.db, f.prisma, f.pin));
  }
});

// ---- O3c delta rule -------------------------------------------------------------
const column = (name, extra = {}) => ({
  column_name: name,
  data_type: 'text',
  udt_name: 'text',
  is_nullable: 'YES',
  column_default: null,
  ...extra,
});
const check = (name, definition, extra = {}) => ({
  conname: name,
  contype: 'c',
  convalidated: true,
  definition,
  ...extra,
});
function o3bState() {
  const table = (columns, constraints) => ({
    count: 3,
    dataHash: 'same-rows',
    columns,
    constraints,
    indexes: [{ indexname: 'idx', indexdef: 'CREATE INDEX idx' }],
  });
  return {
    tables: {
      tenants: table(
        [column('id')],
        [check('tenants_pkey', 'PRIMARY KEY (id)')],
      ),
      procurement_purchase_orders: table(
        [column('id'), column('status', { column_default: "'DRAFT'" })],
        [check('po_version_check', 'CHECK (version > 0)')],
      ),
      procurement_purchase_order_audits: table(
        [column('id')],
        [check('po_audit_snapshots_check', 'CHECK (old)')],
      ),
      procurement_purchase_order_receipts: table(
        [column('id')],
        [
          check('po_receipt_namespace_check', 'CHECK (old namespace)'),
          check('po_receipt_http_check', 'CHECK (old http)'),
        ],
      ),
    },
    enums: {
      ProcurementPurchaseOrderStatus: ['DRAFT'],
      ProcurementPurchaseOrderOperation: ['CREATE', 'REPLACE', 'DELETE'],
      UnitOfMeasure: ['UNIDAD'],
    },
  };
}
function o3cState() {
  const state = structuredClone(o3bState());
  const orders = state.tables.procurement_purchase_orders;
  orders.columns.push(
    ...[
      'confirmedAt',
      'confirmedByDisplayName',
      'cancelledAt',
      'cancelledByDisplayName',
      'lineSubtotalsSnapshot',
    ].map((name) => column(name)),
  );
  orders.constraints.push(
    check('po_status_transition_check', 'CHECK (new)'),
    check('po_frozen_subtotals_check', 'CHECK (new)'),
  );
  state.tables.procurement_purchase_order_audits.constraints[0].definition =
    'CHECK (wider)';
  for (const c of state.tables.procurement_purchase_order_receipts.constraints)
    c.definition = `${c.definition} wider`;
  state.enums.ProcurementPurchaseOrderStatus.push('CONFIRMED', 'CANCELLED');
  state.enums.ProcurementPurchaseOrderOperation.push('CONFIRM', 'CANCEL');
  return state;
}
test('O3c delta accepts exactly the additive change and nothing else', () => {
  assert.doesNotThrow(() => verifyO3cDelta(o3bState(), o3cState()));
});
test('O3c delta rejects every deviation: data, columns, checks, indexes, enums, untouched tables', () => {
  const mutations = {
    'a changed row': (s) =>
      (s.tables.procurement_purchase_orders.dataHash = 'x'),
    'a lost row': (s) =>
      (s.tables.procurement_purchase_order_lines = undefined),
    'row count': (s) => (s.tables.procurement_purchase_order_audits.count = 2),
    'a dropped index': (s) => (s.tables.tenants.indexes = []),
    'a changed index': (s) =>
      (s.tables.procurement_purchase_orders.indexes[0].indexdef = 'other'),
    'an untouched table gaining a column': (s) =>
      s.tables.tenants.columns.push(column('extra')),
    'an untouched table check changing': (s) =>
      (s.tables.tenants.constraints[0].definition = 'PRIMARY KEY (slug)'),
    'a new column with a default': (s) =>
      (s.tables.procurement_purchase_orders.columns.at(-1).column_default =
        '1'),
    'a new NOT NULL column': (s) =>
      (s.tables.procurement_purchase_orders.columns.at(-1).is_nullable = 'NO'),
    'a missing new column': (s) =>
      s.tables.procurement_purchase_orders.columns.pop(),
    'an extra new column': (s) =>
      s.tables.procurement_purchase_orders.columns.push(column('surprise')),
    'a renamed old column': (s) =>
      (s.tables.procurement_purchase_orders.columns[0].column_name = 'orderId'),
    'a missing status check': (s) =>
      s.tables.procurement_purchase_orders.constraints.pop(),
    'an unvalidated check': (s) =>
      (s.tables.procurement_purchase_orders.constraints.at(-1).convalidated =
        false),
    'an unexpected extra check': (s) =>
      s.tables.procurement_purchase_orders.constraints.push(
        check('po_extra', 'x'),
      ),
    'an audit check left unchanged': (s) =>
      (s.tables.procurement_purchase_order_audits.constraints[0].definition =
        'CHECK (old)'),
    'a receipt check left unchanged': (s) =>
      (s.tables.procurement_purchase_order_receipts.constraints[0].definition =
        'CHECK (old namespace)'),
    'a dropped receipt check': (s) =>
      s.tables.procurement_purchase_order_receipts.constraints.pop(),
    'a missing enum label': (s) => s.enums.ProcurementPurchaseOrderStatus.pop(),
    'enum labels in another order': (s) =>
      s.enums.ProcurementPurchaseOrderOperation.reverse(),
    'an unrelated enum changing': (s) => s.enums.UnitOfMeasure.push('PIEZA'),
    'a new enum type': (s) => (s.enums.Surprise = ['X']),
  };
  for (const [label, mutate] of Object.entries(mutations)) {
    const state = o3cState();
    mutate(state);
    assert.throws(() => verifyO3cDelta(o3bState(), state), label);
  }
});
// ---- O3b-era seed ---------------------------------------------------------------
const readable = /^[A-ZÁÉÍÓÚÑ][\p{L}0-9 ,.:()'·-]+$/u;
function recorder() {
  const queries = [];
  let pins = 0;
  return {
    queries,
    pin: async () => {
      pins++;
      assert.equal(queries.length, 0, 'pin happens before the first write');
    },
    pins: () => pins,
    db: {
      query: async (sql, values = []) => {
        queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), values });
        return { rows: [] };
      },
    },
  };
}
test('O3b-era preservation seed writes only DRAFT-era rows with readable names, via the O3b schema', async () => {
  const f = recorder();
  const counts = await seedO3bDrafts(f.db, f.pin);
  assert.deepEqual(counts, { orders: 3, lines: 3, audits: 4, receipts: 3 });
  assert.equal(f.pins(), 1);
  const into = (table) =>
    f.queries.filter((q) => q.sql.startsWith(`INSERT INTO ${table} `));
  assert.equal(into('procurement_purchase_orders').length, 3);
  assert.equal(into('procurement_purchase_order_lines').length, 3);
  assert.equal(into('procurement_purchase_order_audits').length, 4);
  assert.equal(into('procurement_purchase_order_receipts').length, 3);
  // Nothing from O3c exists yet: the seed must not name its columns/values.
  for (const { sql, values } of f.queries) {
    assert(!/confirm|cancel|lineSubtotals/i.test(sql), sql);
    assert(!values.some((v) => /^(CONFIRM|CANCEL)(LED)?/.test(String(v))));
  }
  const names = [
    ...into('tenants'),
    ...into('procurement_suppliers'),
    ...into('products'),
  ].flatMap((q) =>
    q.values.filter(
      (v) => /\p{L}{3}/u.test(String(v)) && !/^[0-9a-f]{8}-/.test(String(v)),
    ),
  );
  assert(names.length >= 5);
  for (const name of names) assert(readable.test(name), name);
  const notes = into('procurement_purchase_orders')
    .map((q) => q.values[4])
    .filter(Boolean);
  assert(notes.length === 2);
  for (const note of notes) assert(readable.test(note), note);
  // The discarded order keeps its DELETE evidence: audit v2 with no after-snapshot,
  // and a 204 receipt whose stored body is the JSON null.
  const audits = into('procurement_purchase_order_audits').map((q) => q.values);
  assert(audits.some((v) => v[4] === 'DELETE' && v[7] === null));
  const receipts = into('procurement_purchase_order_receipts').map(
    (q) => q.values,
  );
  assert(
    receipts.some((v) => v[2] === 'DELETE' && v[7] === 204 && v[8] === 'null'),
  );
  assert(receipts.some((v) => v[2] === 'CREATE' && v[3] === 'collection'));
});
// ---- O3c SQL constraints: a JS restatement of the migration's CHECKs -------------
// Evaluated in PostgreSQL's alphabetical order, so the named constraint is the first
// one that fails. This guards the proof's case table, not PostgreSQL itself.
function emulator() {
  const saved = { orders: [], audits: [], receipts: [] };
  const fail = (constraint) => {
    throw { code: '23514', constraint };
  };
  const isArray = (json) => json !== null && Array.isArray(JSON.parse(json));
  const isObject = (json) => {
    if (json === null) return false;
    const value = JSON.parse(json);
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  };
  const orderRules = {
    po_frozen_subtotals_check: (o) =>
      (o.status === 'DRAFT' && o.subtotals === null) ||
      (o.status === 'CONFIRMED' && isArray(o.subtotals)) ||
      (o.status === 'CANCELLED' &&
        (o.subtotals === null || isArray(o.subtotals))),
    po_status_transition_check: (o) => {
      const pair = (a, b) => (a !== null) === (b !== null);
      const none = (a, b) => a === null && b === null;
      const both = (a, b) => a !== null && b !== null;
      if (o.status === 'DRAFT') return none(o.cAt, o.cBy) && none(o.xAt, o.xBy);
      if (o.status === 'CONFIRMED')
        return both(o.cAt, o.cBy) && none(o.xAt, o.xBy);
      return both(o.xAt, o.xBy) && pair(o.cAt, o.cBy);
    },
  };
  const auditRule = (a) => {
    const [b, f] = [a.before, a.after];
    return (
      (a.op === 'CREATE' && b === null && isObject(f)) ||
      (a.op === 'REPLACE' && isObject(b) && isObject(f)) ||
      (a.op === 'DELETE' && isObject(b) && f === null) ||
      (['CONFIRM', 'CANCEL'].includes(a.op) && isObject(b) && isObject(f))
    );
  };
  const receiptRules = {
    po_receipt_http_check: (r) =>
      (r.op === 'CREATE' && r.status === 201) ||
      (['REPLACE', 'CONFIRM', 'CANCEL'].includes(r.op) && r.status === 200) ||
      (r.op === 'DELETE' && r.status === 204 && r.body === 'null'),
    po_receipt_namespace_check: (r) =>
      (r.op === 'CREATE' && r.target === 'collection') ||
      (['REPLACE', 'DELETE', 'CONFIRM', 'CANCEL'].includes(r.op) &&
        r.target === r.orderId),
  };
  return {
    saved,
    pin: async () => {},
    db: {
      query: async (sql, v = []) => {
        if (sql.startsWith('INSERT INTO procurement_purchase_orders')) {
          const o = {
            status: v[3],
            cAt: v[5],
            cBy: v[6],
            xAt: v[7],
            xBy: v[8],
            subtotals: v[9],
          };
          for (const name of Object.keys(orderRules).sort())
            if (!orderRules[name](o)) fail(name);
          saved.orders.push(o);
        } else if (
          sql.startsWith('INSERT INTO procurement_purchase_order_audits')
        ) {
          const a = { op: v[4], before: v[6], after: v[7] };
          if (!auditRule(a)) fail('po_audit_snapshots_check');
          saved.audits.push(a);
        } else if (
          sql.startsWith('INSERT INTO procurement_purchase_order_receipts')
        ) {
          const r = {
            op: v[2],
            target: v[3],
            orderId: v[5],
            status: v[7],
            body: v[8],
          };
          for (const name of Object.keys(receiptRules).sort())
            if (!receiptRules[name](r)) fail(name);
          saved.receipts.push(r);
        } else if (
          sql.includes('count(*)') &&
          sql.includes('GROUP BY status')
        ) {
          const counts = {};
          for (const o of saved.orders)
            counts[o.status] = (counts[o.status] ?? 0) + 1;
          return {
            rows: Object.keys(counts)
              .sort()
              .map((status) => ({ status, n: counts[status] })),
          };
        } else if (sql.includes('count(*)')) {
          const table = /FROM (\w+)/.exec(sql)[1];
          const key = {
            procurement_purchase_orders: 'orders',
            procurement_purchase_order_audits: 'audits',
            procurement_purchase_order_receipts: 'receipts',
          }[table];
          return { rows: [{ n: saved[key].length }] };
        }
        return { rows: [] };
      },
    },
  };
}
test('O3c SQL proof accepts valid CONFIRM/CANCEL evidence and names every violated constraint', async () => {
  const f = emulator();
  const result = await o3cProof(f.db, f.pin);
  assert.deepEqual(result.accepted, { orders: 6, audits: 2, receipts: 2 });
  assert.equal(f.saved.orders.length, 6);
  const counts = {};
  for (const e of result.errors) {
    assert.equal(e.code, '23514');
    counts[e.constraint] = (counts[e.constraint] ?? 0) + 1;
  }
  assert.deepEqual(counts, {
    po_status_transition_check: 13,
    po_frozen_subtotals_check: 6,
    po_audit_snapshots_check: 8,
    po_receipt_namespace_check: 3,
    po_receipt_http_check: 4,
  });
  // Both closed-order shapes exist, including CANCELLED-from-CONFIRMED.
  assert(
    f.saved.orders.some((o) => o.status === 'CANCELLED' && o.cAt && o.xAt),
  );
  assert(f.saved.orders.some((o) => o.status === 'CANCELLED' && !o.cAt));
  for (const op of ['CONFIRM', 'CANCEL']) {
    assert(f.saved.audits.some((a) => a.op === op));
    assert(f.saved.receipts.some((r) => r.op === op));
  }
});
test('O3c SQL proof fails closed when a constraint is missing, wrong, or reports another name', async () => {
  for (const mutate of [
    // CHECK absent: a bad row is accepted, so the expected rejection never happens
    (name) => (name === 'po_status_transition_check' ? () => true : null),
    (name) => (name === 'po_frozen_subtotals_check' ? () => true : null),
  ]) {
    const f = emulator();
    const query = f.db.query;
    // Silence one rule by pre-accepting the corresponding INSERT shape.
    f.db.query = async (sql, values) => {
      if (
        mutate('po_status_transition_check')?.() &&
        sql.startsWith('INSERT INTO procurement_purchase_orders') &&
        values[3] === 'DRAFT' &&
        values[5] !== null
      )
        return { rows: [] };
      if (
        mutate('po_frozen_subtotals_check')?.() &&
        sql.startsWith('INSERT INTO procurement_purchase_orders') &&
        values[3] === 'DRAFT' &&
        values[9] !== null
      )
        return { rows: [] };
      return query(sql, values);
    };
    await assert.rejects(() => o3cProof(f.db, f.pin));
  }
  // A rejection that carries the wrong constraint name is not proof of the right one.
  const f = emulator();
  const query = f.db.query;
  f.db.query = async (sql, values) => {
    try {
      return await query(sql, values);
    } catch (error) {
      throw { ...error, constraint: 'po_version_check' };
    }
  };
  await assert.rejects(() => o3cProof(f.db, f.pin));
  // Pin first: no write before identity is confirmed.
  const writes = [];
  await assert.rejects(() =>
    o3cProof({ query: async (sql) => writes.push(sql) }, async () => {
      throw new Error('identity mismatch');
    }),
  );
  assert.deepEqual(writes, []);
});
