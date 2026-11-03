'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  splitMigrations,
  verifyAdditive,
  expectSqlError,
  directProof,
  redact,
  FORWARD,
} = require('./verify-po-migration.cjs');
const migration = (name) => `prisma/migrations/${name}/migration.sql`;
test('baseline excludes only the PO forward migration; unexpected paths fail closed', () => {
  const files = [
    'prisma/migrations/migration_lock.toml',
    migration('20260502052444_multi_tenant_foundation'),
    migration('20261103010100_supplier_delete_evidence'),
    migration(FORWARD),
  ];
  assert.deepEqual(splitMigrations(files).baseline, files.slice(0, -1));
  for (const invalid of [
    files.slice(0, -1),
    files.slice(1),
    [...files, '../escape'],
    [...files, migration('20270101000000_unknown')],
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
