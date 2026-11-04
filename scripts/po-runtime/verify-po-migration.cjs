'use strict';
// Parent-only executable. Imports are inert; no retries, resume, installs or cleanup.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  ROOT,
  LABEL,
  proofEnvironment,
  validateTarget,
  validateIdentity,
  validateEmptySchema,
  IDENTITY_SQL,
} = require('../supplier-runtime/verify-delete-migration.cjs');
const {
  validateTarget: validateManifest,
} = require('../supplier-runtime/host.cjs');
// FORWARD is the O3b draft migration; O3C are applied afterwards, over seeded O3b data.
const FORWARD = '20261104010000_procurement_purchase_order_drafts';
const O3C = [
  '20261104010100_procurement_po_confirm_cancel_enums',
  '20261104010200_procurement_po_confirm_cancel_storage',
];
const ORDERS = 'procurement_purchase_orders';
const LINES = 'procurement_purchase_order_lines';
const AUDITS = 'procurement_purchase_order_audits';
const RECEIPTS = 'procurement_purchase_order_receipts';
const PO_TABLES = [ORDERS, LINES, AUDITS, RECEIPTS];
// What O3c may change, exactly: anything else about any pre-existing table is a defect.
const NEW_COLUMNS = {
  [ORDERS]: [
    'confirmedAt',
    'confirmedByDisplayName',
    'cancelledAt',
    'cancelledByDisplayName',
    'lineSubtotalsSnapshot',
  ],
};
const NEW_CHECKS = {
  [ORDERS]: ['po_frozen_subtotals_check', 'po_status_transition_check'],
};
const WIDENED_CHECKS = {
  [AUDITS]: ['po_audit_snapshots_check'],
  [RECEIPTS]: ['po_receipt_http_check', 'po_receipt_namespace_check'],
};
const NEW_ENUM_LABELS = {
  ProcurementPurchaseOrderStatus: ['CONFIRMED', 'CANCELLED'],
  ProcurementPurchaseOrderOperation: ['CONFIRM', 'CANCEL'],
};
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const check = (condition) => assert(condition, 'Safety precondition rejected');
function redact(output, secrets = []) {
  for (const value of secrets.filter(Boolean))
    output = output.split(value).join('[REDACTED]');
  return output.replace(
    /postgres(?:ql)?:\/\/[^\s"']+/g,
    '[REDACTED DATABASE URL]',
  );
}
function splitMigrations(files) {
  check(files.includes('prisma/migrations/migration_lock.toml'));
  for (const file of files)
    check(
      /^prisma\/migrations\/(migration_lock\.toml|[0-9a-z_]+\/migration\.sql)$/.test(
        file,
      ),
    );
  const path = (name) => `prisma/migrations/${name}/migration.sql`;
  const forward = path(FORWARD);
  const o3c = O3C.map(path);
  check(files.includes(forward) && o3c.every((f) => files.includes(f)));
  check(o3c[0] < o3c[1] && forward < o3c[0]);
  // Nothing may sort after the O3c migrations, and nothing unknown between them.
  const migrations = files.filter((f) => f.endsWith('/migration.sql'));
  check(migrations.every((f) => f <= o3c[1]));
  check(migrations.filter((f) => f > forward).every((f) => o3c.includes(f)));
  return {
    baseline: files.filter((f) => f !== forward && !o3c.includes(f)),
    forward,
    o3c,
  };
}
function verifyAdditive(before, after) {
  // These are catalog/data projections of EVERY pre-existing public table.
  assert.deepEqual(after, before);
}
async function expectSqlError(db, sql, values, code, constraint) {
  let caught;
  try {
    await db.query(sql, values);
  } catch (error) {
    caught = error;
  }
  check(caught && caught.code === code && caught.constraint === constraint);
  return { code: caught.code, constraint: caught.constraint };
}
async function directProof(db, prisma, pin, observe = () => {}) {
  await pin();
  const tenant = crypto.randomUUID(),
    supplier = crypto.randomUUID(),
    order = crypto.randomUUID();
  await db.query(
    'INSERT INTO tenants (id,name,slug,"updatedAt") VALUES ($1,$1,$1,now())',
    [tenant],
  );
  await db.query(
    'INSERT INTO procurement_suppliers (id,"tenantId","displayName",status,"updatedAt") VALUES ($1,$2,$1,\'ACTIVE\',now())',
    [supplier, tenant],
  );
  await db.query(
    'INSERT INTO procurement_purchase_orders (id,"tenantId","supplierId","locationTenantName","updatedAt") VALUES ($1,$2,$3,$2,now())',
    [order, tenant, supplier],
  );
  const insert = `INSERT INTO procurement_purchase_order_lines
    ("tenantId","orderId","lineId",position,"orderedQuantity","informedUnitCostPresent","costAmount",currency)
    VALUES ($1,$2,$3,0,$4,$5,$6,$7)`;
  const errors = [];
  const otherTenant = crypto.randomUUID();
  await db.query(
    'INSERT INTO tenants (id,name,slug,"updatedAt") VALUES ($1,$1,$1,now())',
    [otherTenant],
  );
  errors.push(
    await expectSqlError(
      db,
      'INSERT INTO procurement_purchase_orders (id,"tenantId","supplierId","locationTenantName","updatedAt") VALUES ($1,$2,$3,$2,now())',
      [crypto.randomUUID(), otherTenant, supplier],
      '23503',
      'po_supplier_fk',
    ),
  );
  for (const [quantity, present, amount, currency, constraint] of [
    ['1', true, '1', 'USD', 'po_line_currency_check'],
    ['0', true, '1', 'MXN', 'po_line_quantity_check'],
    ['01', true, '1', 'MXN', 'po_line_quantity_check'],
    ['1.0001', true, '1', 'MXN', 'po_line_quantity_check'],
    ['1e2', true, '1', 'MXN', 'po_line_quantity_check'],
    ['1', true, '-1', 'MXN', 'po_line_amount_check'],
    ['1', true, '01', 'MXN', 'po_line_amount_check'],
    ['1', true, '1.00001', 'MXN', 'po_line_amount_check'],
    ['1', false, '0', null, 'po_line_cost_presence_check'],
  ])
    errors.push(
      await expectSqlError(
        db,
        insert,
        [
          tenant,
          order,
          crypto.randomUUID(),
          quantity,
          present,
          amount,
          currency,
        ],
        '23514',
        constraint,
      ),
    );
  await db.query(insert, [
    tenant,
    order,
    crypto.randomUUID(),
    '12.5',
    true,
    '10.2500',
    'MXN',
  ]);
  errors.push(
    await expectSqlError(
      db,
      'DELETE FROM procurement_suppliers WHERE id=$1 AND "tenantId"=$2',
      [supplier, tenant],
      '23503',
      'po_supplier_fk',
    ),
  );
  let prismaError;
  try {
    await prisma.procurementSupplier.deleteMany({
      where: { tenantId: tenant, id: supplier },
    });
  } catch (error) {
    prismaError = error;
  }
  check(prismaError?.code === 'P2003');
  // Preserve only the bounded constraint name, never the message/stack/target.
  // Prisma 6.19 reports it as meta.constraint (observed on PostgreSQL).
  const constraint = prismaError.meta?.constraint;
  observe({
    code: 'P2003',
    constraint:
      typeof constraint === 'string' &&
      /^[a-zA-Z0-9_ ()-]{1,200}$/.test(constraint)
        ? constraint
        : null,
  });
  check(constraint === 'po_supplier_fk');
  await db.query(
    `INSERT INTO procurement_purchase_order_audits
    (id,"tenantId","orderId","actorId",operation,"orderVersion","afterSnapshot") VALUES ($1,$2,$3,'proof','CREATE',1,'{}');
  `.trim(),
    [crypto.randomUUID(), tenant, order],
  );
  await db.query(
    `INSERT INTO procurement_purchase_order_receipts
    ("tenantId","actorId",operation,target,"idempotencyKey","orderId","requestHash","statusCode","responseBody")
    VALUES ($1,'proof','CREATE','collection','proof',$2,$3,201,'{}')`,
    [tenant, order, 'a'.repeat(64)],
  );
  const evidence = async () =>
    (
      await db.query(
        `SELECT 'audit' AS kind,to_jsonb(t)::text AS record FROM procurement_purchase_order_audits t WHERE "tenantId"=$1
    UNION ALL SELECT 'receipt',to_jsonb(t)::text FROM procurement_purchase_order_receipts t WHERE "tenantId"=$1 ORDER BY kind,record`,
        [tenant],
      )
    ).rows;
  const before = await evidence();
  check(before.length === 2);
  check(
    (
      await db.query(
        'SELECT count(*)::int AS n FROM procurement_purchase_order_lines WHERE "tenantId"=$1 AND "orderId"=$2',
        [tenant, order],
      )
    ).rows[0].n === 1,
  );
  await db.query(
    'DELETE FROM procurement_purchase_orders WHERE id=$1 AND "tenantId"=$2',
    [order, tenant],
  );
  check(
    (
      await db.query(
        'SELECT count(*)::int AS n FROM procurement_purchase_order_lines WHERE "tenantId"=$1 AND "orderId"=$2',
        [tenant, order],
      )
    ).rows[0].n === 0,
  );
  assert.deepEqual(await evidence(), before);
  // Remove only this proof's live supplier so ONLY durable PO evidence can block tenant deletion.
  await db.query(
    'DELETE FROM procurement_suppliers WHERE id=$1 AND "tenantId"=$2',
    [supplier, tenant],
  );
  let tenantError;
  try {
    await db.query('DELETE FROM tenants WHERE id=$1', [tenant]);
  } catch (error) {
    tenantError = error;
  }
  check(
    tenantError?.code === '23503' &&
      ['po_audit_tenant_fk', 'po_receipt_tenant_fk'].includes(
        tenantError.constraint,
      ),
  );
  errors.push({ code: tenantError.code, constraint: tenantError.constraint });
  return {
    errors,
    prisma: { code: 'P2003', constraint },
    lineCascade: true,
    evidencePreserved: true,
    tenantRestrict: true,
  };
}
// Catalog + data projection of public tables. `hidden` lists columns O3c added: they are
// stripped from the row hash so only the pre-existing part of each row is compared.
async function captureTables(db, tables, hidden = {}) {
  const tableState = {};
  for (const table of tables) {
    check(/^[a-zA-Z0-9_]+$/.test(table));
    // PostgreSQL quotes the catalog-derived identifier with %I; values stay bound.
    const statement = (
      await db.query('SELECT format($1::text, $2::text) AS sql', [
        'SELECT (to_jsonb(t) - $1::text[])::text AS record FROM %I t ORDER BY 1',
        table,
      ])
    ).rows[0].sql;
    const data = (await db.query(statement, [hidden[table] ?? []])).rows;
    const columns = (
      await db.query(
        "SELECT column_name,data_type,udt_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",
        [table],
      )
    ).rows;
    const constraints = (
      await db.query(
        `SELECT conname,contype,convalidated,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass ORDER BY conname`,
        [table],
      )
    ).rows;
    const indexes = (
      await db.query(
        "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename=$1 ORDER BY indexname",
        [table],
      )
    ).rows;
    tableState[table] = {
      count: data.length,
      dataHash: sha(JSON.stringify(data)),
      columns,
      constraints,
      indexes,
    };
  }
  const enums = {};
  const enumRows = (
    await db.query(
      `SELECT t.typname AS name, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
       FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
       JOIN pg_namespace n ON n.oid = t.typnamespace AND n.nspname = 'public'
       GROUP BY t.typname ORDER BY t.typname`,
    )
  ).rows;
  for (const row of enumRows) {
    // pg parses text[] but not name[]; a raw '{A,B}' literal must never pass as labels.
    check(
      Array.isArray(row.labels) &&
        row.labels.every((label) => typeof label === 'string'),
    );
    enums[row.name] = row.labels;
  }
  return { tables: tableState, enums };
}
// O3c delta rule over two captureTables() results (same table list, hidden columns applied).
function verifyO3cDelta(before, after) {
  assert.deepEqual(Object.keys(after.tables), Object.keys(before.tables));
  for (const [table, old] of Object.entries(before.tables)) {
    const next = after.tables[table];
    assert.equal(next.count, old.count);
    assert.equal(next.dataHash, old.dataHash);
    assert.deepEqual(next.indexes, old.indexes);
    const added = NEW_COLUMNS[table] ?? [];
    // New columns are appended, nullable, with no default, so old rows stay NULL there.
    assert.deepEqual(next.columns.slice(0, old.columns.length), old.columns);
    assert.deepEqual(
      next.columns.slice(old.columns.length).map((c) => c.column_name),
      added,
    );
    for (const column of next.columns.slice(old.columns.length)) {
      assert.equal(column.is_nullable, 'YES');
      assert.equal(column.column_default, null);
    }
    const byName = (list) => new Map(list.map((c) => [c.conname, c]));
    const was = byName(old.constraints);
    const now = byName(next.constraints);
    const widened = WIDENED_CHECKS[table] ?? [];
    const created = NEW_CHECKS[table] ?? [];
    assert.deepEqual(
      [...now.keys()].sort(),
      [...was.keys(), ...created].sort(),
    );
    for (const [name, constraint] of now) {
      assert.equal(constraint.convalidated, true, name);
      if (created.includes(name)) continue;
      if (widened.includes(name))
        assert.notDeepEqual(constraint, was.get(name));
      else assert.deepEqual(constraint, was.get(name), name);
    }
    for (const name of widened) {
      assert.equal(was.get(name).contype, 'c');
      assert.equal(now.get(name).contype, 'c');
    }
  }
  assert.deepEqual(
    Object.keys(after.enums).sort(),
    Object.keys(before.enums).sort(),
  );
  for (const [name, labels] of Object.entries(before.enums)) {
    assert(Array.isArray(labels) && Array.isArray(after.enums[name]), name);
    assert.deepEqual(after.enums[name], [
      ...labels,
      ...(NEW_ENUM_LABELS[name] ?? []),
    ]);
  }
}
const NAMES = {
  tenant: 'Mascotas y Alimentos El Roble',
  active: 'Distribuidora Veterinaria del Norte',
  archived: 'Alimentos Balanceados del Bajío (archivado)',
  product: 'Croquetas Adulto 15 kg',
  manager: 'María González',
  canceller: 'Jorge Martínez',
};
// Realistic O3b-era rows (DRAFT only, including discarded-order evidence) that O3c must
// carry forward untouched. Written under the O3b schema, so no O3c column is mentioned.
async function seedO3bDrafts(db, pin) {
  await pin();
  const id = () => crypto.randomUUID();
  const ids = {
    tenant: id(),
    active: id(),
    archived: id(),
    product: id(),
    orderOne: id(),
    orderTwo: id(),
    orderThree: id(),
    discarded: id(),
  };
  const actor = id();
  const hash = (label) => sha(label);
  await db.query(
    'INSERT INTO tenants (id,name,slug,"updatedAt") VALUES ($1,$2,$1,now())',
    [ids.tenant, NAMES.tenant],
  );
  for (const [supplier, name, status] of [
    [ids.active, NAMES.active, 'ACTIVE'],
    [ids.archived, NAMES.archived, 'ARCHIVED'],
  ])
    await db.query(
      'INSERT INTO procurement_suppliers (id,"tenantId","displayName",status,"updatedAt") VALUES ($1,$2,$3,$4,now())',
      [supplier, ids.tenant, name, status],
    );
  await db.query(
    'INSERT INTO products (id,"tenantId",name,"updatedAt") VALUES ($1,$2,$3,now())',
    [ids.product, ids.tenant, NAMES.product],
  );
  const snapshot = (supplier, name, status) =>
    JSON.stringify({ id: supplier, displayName: name, status });
  const order = `INSERT INTO procurement_purchase_orders
    (id,"tenantId","supplierId",version,note,"locationDetail","locationTenantName","supplierDisplaySnapshot","updatedAt")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,now())`;
  for (const values of [
    [
      ids.orderOne,
      ids.tenant,
      ids.active,
      2,
      'Reposición mensual de croquetas',
      'Bodega principal, andén 2',
      NAMES.tenant,
      snapshot(ids.active, NAMES.active, 'ACTIVE'),
    ],
    [ids.orderTwo, ids.tenant, null, 1, null, null, NAMES.tenant, null],
    [
      ids.orderThree,
      ids.tenant,
      ids.archived,
      1,
      'Pedido guardado antes de archivar al proveedor',
      null,
      NAMES.tenant,
      snapshot(ids.archived, NAMES.archived, 'ARCHIVED'),
    ],
  ])
    await db.query(order, values);
  const line = `INSERT INTO procurement_purchase_order_lines
    ("tenantId","orderId","lineId",position,"productId","orderedQuantity","informedUnitCostPresent","costAmount",currency,"costUnit","taxBasis","productName","unitSnapshot")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`;
  for (const values of [
    [
      ids.tenant,
      ids.orderOne,
      id(),
      0,
      ids.product,
      '12',
      true,
      '780.5',
      'MXN',
      'BOLSA',
      'EXCLUDES_TAX',
      NAMES.product,
      'BOLSA',
    ],
    [
      ids.tenant,
      ids.orderOne,
      id(),
      1,
      null,
      null,
      false,
      null,
      null,
      null,
      null,
      null,
      null,
    ],
    [
      ids.tenant,
      ids.orderThree,
      id(),
      0,
      ids.product,
      '3.5',
      true,
      '31.2',
      'MXN',
      'KILOGRAMO',
      'INCLUDES_TAX',
      NAMES.product,
      'KILOGRAMO',
    ],
  ])
    await db.query(line, values);
  const audit = `INSERT INTO procurement_purchase_order_audits
    (id,"tenantId","orderId","actorId",operation,"orderVersion","beforeSnapshot","afterSnapshot")
    VALUES ($1,$2,$3,$4,$5::"ProcurementPurchaseOrderOperation",$6,$7::jsonb,$8::jsonb)`;
  const body = (orderId, note) =>
    JSON.stringify({ id: orderId, status: 'DRAFT', note });
  for (const [orderId, operation, version, before, after] of [
    [ids.orderOne, 'CREATE', 1, null, body(ids.orderOne, null)],
    [
      ids.orderOne,
      'REPLACE',
      2,
      body(ids.orderOne, null),
      body(ids.orderOne, 'Reposición mensual de croquetas'),
    ],
    [
      ids.discarded,
      'CREATE',
      1,
      null,
      body(ids.discarded, 'Pedido de prueba descartado'),
    ],
    [
      ids.discarded,
      'DELETE',
      2,
      body(ids.discarded, 'Pedido de prueba descartado'),
      null,
    ],
  ])
    await db.query(audit, [
      id(),
      ids.tenant,
      orderId,
      actor,
      operation,
      version,
      before,
      after,
    ]);
  const receipt = `INSERT INTO procurement_purchase_order_receipts
    ("tenantId","actorId",operation,target,"idempotencyKey","orderId","requestHash","statusCode","responseBody")
    VALUES ($1,$2,$3::"ProcurementPurchaseOrderOperation",$4,$5,$6,$7,$8,$9::jsonb)`;
  for (const [operation, target, orderId, status, response] of [
    ['CREATE', 'collection', ids.orderOne, 201, body(ids.orderOne, null)],
    [
      'REPLACE',
      ids.orderOne,
      ids.orderOne,
      200,
      body(ids.orderOne, 'Reposición mensual de croquetas'),
    ],
    ['DELETE', ids.discarded, ids.discarded, 204, 'null'],
  ])
    await db.query(receipt, [
      ids.tenant,
      actor,
      operation,
      target,
      `solicitud-${operation.toLowerCase()}`,
      orderId,
      hash(operation),
      status,
      response,
    ]);
  return { orders: 3, lines: 3, audits: 4, receipts: 3 };
}
// Direct SQL against the final schema: widened CHECKs accept CONFIRM/CANCEL evidence and
// closed-order rows, and every bad combination fails with its own named constraint.
// PostgreSQL evaluates CHECKs by name, so each rejected row is otherwise valid for the
// constraints that sort before the one under test.
async function o3cProof(db, pin) {
  await pin();
  const tenant = crypto.randomUUID(),
    supplier = crypto.randomUUID(),
    actor = crypto.randomUUID();
  await db.query(
    'INSERT INTO tenants (id,name,slug,"updatedAt") VALUES ($1,$2,$1,now())',
    [tenant, NAMES.tenant],
  );
  await db.query(
    'INSERT INTO procurement_suppliers (id,"tenantId","displayName",status,"updatedAt") VALUES ($1,$2,$3,\'ACTIVE\',now())',
    [supplier, tenant, NAMES.active],
  );
  const at = '2026-11-04T16:30:00.000Z';
  const array = '[{"lineId":"renglon-1","subtotal":null}]';
  const orderSql = `INSERT INTO procurement_purchase_orders
    (id,"tenantId","supplierId",status,"locationTenantName","confirmedAt","confirmedByDisplayName","cancelledAt","cancelledByDisplayName","lineSubtotalsSnapshot","updatedAt")
    VALUES ($1,$2,$3,$4::"ProcurementPurchaseOrderStatus",$5,$6,$7,$8,$9,$10::jsonb,now())`;
  // mode: true = both fields of the pair, 'at-only' / 'name-only' = half a pair.
  const pair = (mode, name) => [
    mode === true || mode === 'at-only' ? at : null,
    mode === true || mode === 'name-only' ? name : null,
  ];
  const order = (status, confirmed, cancelled, subtotals) => [
    crypto.randomUUID(),
    tenant,
    supplier,
    status,
    NAMES.tenant,
    ...pair(confirmed, NAMES.manager),
    ...pair(cancelled, NAMES.canceller),
    subtotals,
  ];
  // [status, confirmedAt/By, cancelledAt/By, subtotals]; true = pair set.
  const accepted = [
    ['DRAFT', false, false, null],
    ['CONFIRMED', true, false, '[]'],
    ['CONFIRMED', true, false, array],
    ['CANCELLED', false, true, null],
    ['CANCELLED', false, true, array],
    ['CANCELLED', true, true, array],
  ];
  for (const [status, c, x, subtotals] of accepted)
    await db.query(orderSql, order(status, c, x, subtotals));
  const errors = [];
  const reject = async (sql, values, constraint) =>
    errors.push(await expectSqlError(db, sql, values, '23514', constraint));
  const nameOnly = 'name-only';
  const atOnly = 'at-only';
  const transition = 'po_status_transition_check';
  for (const [status, c, x, subtotals] of [
    ['DRAFT', true, false, null],
    ['DRAFT', nameOnly, false, null],
    ['DRAFT', false, true, null],
    ['DRAFT', false, atOnly, null],
    ['CONFIRMED', false, false, array],
    ['CONFIRMED', atOnly, false, array],
    ['CONFIRMED', nameOnly, false, array],
    ['CONFIRMED', true, true, array],
    ['CANCELLED', false, false, null],
    ['CANCELLED', false, atOnly, null],
    ['CANCELLED', false, nameOnly, null],
    ['CANCELLED', atOnly, true, array],
    ['CANCELLED', nameOnly, true, array],
  ])
    await reject(orderSql, order(status, c, x, subtotals), transition);
  const frozen = 'po_frozen_subtotals_check';
  for (const [status, c, x, subtotals] of [
    ['DRAFT', false, false, '[]'],
    ['CONFIRMED', true, false, null],
    ['CONFIRMED', true, false, '{}'],
    ['CONFIRMED', true, false, '"importe"'],
    ['CANCELLED', false, true, '{}'],
    ['CANCELLED', true, true, '"importe"'],
  ])
    await reject(orderSql, order(status, c, x, subtotals), frozen);
  const auditSql = `INSERT INTO procurement_purchase_order_audits
    (id,"tenantId","orderId","actorId",operation,"orderVersion","beforeSnapshot","afterSnapshot")
    VALUES ($1,$2,$3,$4,$5::"ProcurementPurchaseOrderOperation",$6,$7::jsonb,$8::jsonb)`;
  const audit = (operation, version, before, after) => [
    crypto.randomUUID(),
    tenant,
    'orden-de-prueba',
    actor,
    operation,
    version,
    before,
    after,
  ];
  const object = '{"status":"DRAFT"}';
  for (const [operation, version] of [
    ['CONFIRM', 2],
    ['CANCEL', 3],
  ])
    await db.query(auditSql, audit(operation, version, object, object));
  const auditCheck = 'po_audit_snapshots_check';
  let version = 10;
  for (const [operation, before, after] of [
    ['CONFIRM', null, object],
    ['CONFIRM', object, null],
    ['CONFIRM', '[]', object],
    ['CANCEL', object, '"cancelada"'],
    ['CANCEL', null, null],
    ['CREATE', object, object],
    ['REPLACE', null, object],
    ['DELETE', object, object],
  ])
    await reject(
      auditSql,
      audit(operation, version++, before, after),
      auditCheck,
    );
  const receiptSql = `INSERT INTO procurement_purchase_order_receipts
    ("tenantId","actorId",operation,target,"idempotencyKey","orderId","requestHash","statusCode","responseBody")
    VALUES ($1,$2,$3::"ProcurementPurchaseOrderOperation",$4,$5,$6,$7,$8,$9::jsonb)`;
  const orderId = 'orden-de-prueba';
  let key = 0;
  const receipt = (operation, target, status, response = '{}') => [
    tenant,
    actor,
    operation,
    target,
    `solicitud-${key++}`,
    orderId,
    'b'.repeat(64),
    status,
    response,
  ];
  for (const [operation, status] of [
    ['CONFIRM', 200],
    ['CANCEL', 200],
  ])
    await db.query(receiptSql, receipt(operation, orderId, status));
  for (const [operation, target, status, response, constraint] of [
    ['CONFIRM', 'collection', 200, '{}', 'po_receipt_namespace_check'],
    ['CANCEL', 'otra-orden', 200, '{}', 'po_receipt_namespace_check'],
    ['CREATE', orderId, 201, '{}', 'po_receipt_namespace_check'],
    ['CONFIRM', orderId, 201, '{}', 'po_receipt_http_check'],
    ['CANCEL', orderId, 204, 'null', 'po_receipt_http_check'],
    ['DELETE', orderId, 200, '{}', 'po_receipt_http_check'],
    ['CREATE', 'collection', 200, '{}', 'po_receipt_http_check'],
  ])
    await reject(
      receiptSql,
      receipt(operation, target, status, response),
      constraint,
    );
  const count = async (table) =>
    (
      await db.query(
        `SELECT count(*)::int AS n FROM ${PO_TABLES.find((t) => t === table)} WHERE "tenantId"=$1`,
        [tenant],
      )
    ).rows[0].n;
  assert.equal(await count(ORDERS), accepted.length);
  assert.equal(await count(AUDITS), 2);
  assert.equal(await count(RECEIPTS), 2);
  const states = (
    await db.query(
      `SELECT status::text AS status, count(*)::int AS n FROM ${ORDERS} WHERE "tenantId"=$1 GROUP BY status ORDER BY status`,
      [tenant],
    )
  ).rows;
  assert.deepEqual(states, [
    { status: 'CANCELLED', n: 3 },
    { status: 'CONFIRMED', n: 2 },
    { status: 'DRAFT', n: 1 },
  ]);
  return {
    accepted: {
      orders: accepted.length,
      audits: 2,
      receipts: 2,
    },
    errors,
  };
}
async function main() {
  check(process.argv.length === 2);
  check(
    fs.realpathSync(process.cwd()) === ROOT && fs.realpathSync(ROOT) === ROOT,
  );
  check(fs.statSync(path.join(ROOT, '.git')).isFile());
  const temporary = path.join(ROOT, '.tmp');
  const temporaryStat = fs.lstatSync(temporary);
  check(
    fs.realpathSync(temporary) === temporary &&
      !temporaryStat.isSymbolicLink() &&
      temporaryStat.isDirectory() &&
      temporaryStat.uid === process.getuid(),
  );
  for (const file of ['.env', '.env.test', 'prisma/.env'])
    check(!fs.existsSync(path.join(ROOT, file)));
  const directory = fs.mkdtempSync(path.join(ROOT, '.tmp/po-migration-proof.'));
  fs.chmodSync(directory, 0o700);
  const save = (name, value) =>
    fs.writeFileSync(
      path.join(directory, name),
      JSON.stringify(value, null, 2) + '\n',
      { mode: 0o600, flag: 'wx' },
    );
  const result = { state: 'preflight', commands: [], resourcesRetained: true };
  const env = proofEnvironment(directory);
  env.CHECKPOINT_DISABLE = '1';
  env.PRISMA_HIDE_UPDATE_MESSAGE = '1';
  process.env = { ...env };
  let password, url, db, prisma;
  const run = (label, command, args, raw = false) => {
    const response = spawnSync(command, args, {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      timeout: 300000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const output = (response.stdout || '') + (response.stderr || '');
    const step = {
      label,
      status: response.status,
      signal: response.signal,
      spawnError: response.error?.code || null,
    };
    result.commands.push(step);
    const stem = `${String(result.commands.length).padStart(3, '0')}-${label}`;
    fs.writeFileSync(
      path.join(directory, `${stem}.log`),
      redact(output, [password, url]),
      { mode: 0o600, flag: 'wx' },
    );
    save(`${stem}.json`, step);
    check(!response.error && !response.signal && response.status === 0);
    return raw ? response.stdout : response.stdout.trim();
  };
  const docker = (label, args) =>
    run(label, 'docker', ['--host', 'unix:///var/run/docker.sock', ...args]);
  try {
    check(
      run('canonical-root', 'git', ['rev-parse', '--show-toplevel']) === ROOT,
    );
    check(
      path.resolve(
        ROOT,
        run('common-dir', 'git', ['rev-parse', '--git-common-dir']),
      ) !== path.join(ROOT, '.git'),
    );
    check(require('prisma/package.json').version.startsWith('6.'));
    const cli = require.resolve('prisma/build/index.js');
    const jest = require.resolve('jest/bin/jest');
    const token = crypto.randomBytes(16).toString('hex');
    const owner = {
      root: ROOT,
      token,
      name: `houndfe-po-${token}`,
      network: `houndfe-po-${token}-net`,
      user: `proof_${token}`,
      database: 'nest-practice-test',
    };
    password = crypto.randomBytes(32).toString('hex');
    owner.imageId = JSON.parse(
      docker('cached-image', ['image', 'inspect', 'postgres:17']),
    )[0].Id;
    save('ownership-planned.json', owner);
    result.state = 'network-create';
    owner.networkId = docker('network-create', [
      'network',
      'create',
      '--internal',
      '--label',
      `${LABEL}=${token}`,
      owner.network,
    ]);
    save('ownership-network.json', owner);
    result.state = 'container-create';
    owner.containerId = docker('container-create', [
      'create',
      '--pull=never',
      '--name',
      owner.name,
      '--label',
      `${LABEL}=${token}`,
      '--network',
      owner.network,
      '--read-only',
      '--tmpfs',
      '/var/lib/postgresql/data:rw,nosuid,nodev',
      '--tmpfs',
      '/var/run/postgresql:rw,nosuid,nodev',
      '--env',
      `POSTGRES_USER=${owner.user}`,
      '--env',
      `POSTGRES_PASSWORD=${password}`,
      '--env',
      `POSTGRES_DB=${owner.database}`,
      'postgres:17',
    ]);
    save('ownership-container.json', owner);
    docker('container-start', ['start', owner.containerId]);
    // One bounded startup pause, then exactly one readiness observation. Failure is final.
    await new Promise((resolve) => setTimeout(resolve, 5000));
    owner.ip = JSON.parse(
      docker('container-inspect', ['inspect', owner.containerId]),
    )[0].NetworkSettings.Networks[owner.network]?.IPAddress;
    url = `postgresql://${owner.user}:${password}@${owner.ip}:5432/${owner.database}`;
    const guard = () =>
      validateTarget(
        owner,
        JSON.parse(
          docker('container-inspect', ['inspect', owner.containerId]),
        )[0],
        JSON.parse(
          docker('network-inspect', ['network', 'inspect', owner.networkId]),
        )[0],
        url,
        fs.realpathSync(process.cwd()),
      );
    guard();
    const identity = {
      database: owner.database,
      username: owner.user,
      ip: owner.ip,
    };
    validateManifest(identity, url);
    save('ownership.json', owner);
    save('target-identity.json', identity);
    save('target.json', { url });
    env.DATABASE_URL = url;
    process.env.DATABASE_URL = url;
    result.state = 'readiness';
    docker('readiness', [
      'exec',
      owner.containerId,
      'pg_isready',
      '-h',
      '127.0.0.1',
      '-U',
      owner.user,
      '-d',
      owner.database,
    ]);
    const { Client } = require('pg');
    db = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    await db.connect();
    const pin = async () => {
      guard();
      validateIdentity((await db.query(IDENTITY_SQL)).rows[0], owner);
    };
    await pin();
    validateEmptySchema(
      (
        await db.query(`SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='public') AS public_exists,
      EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace UNION ALL SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace UNION ALL SELECT 1 FROM pg_type WHERE typnamespace='public'::regnamespace) AS public_nonempty,
      EXISTS(SELECT 1 FROM pg_class WHERE relname='_prisma_migrations') AS ledger_present`)
      ).rows[0],
    );
    const files = run('migration-tree', 'git', [
      'ls-tree',
      '-r',
      '--name-only',
      'HEAD',
      '--',
      'prisma/migrations',
    ]).split('\n');
    const { baseline, forward, o3c } = splitMigrations(files);
    assert.deepEqual(
      fs.readdirSync(path.join(ROOT, 'prisma/migrations')).sort(),
      [
        'migration_lock.toml',
        ...files
          .filter((f) => f.endsWith('/migration.sql'))
          .map((f) => f.split('/')[2]),
      ].sort(),
    );
    const schemaDir = path.join(directory, 'prisma');
    fs.mkdirSync(path.join(schemaDir, 'migrations'), {
      recursive: true,
      mode: 0o700,
    });
    fs.writeFileSync(
      path.join(schemaDir, 'schema.prisma'),
      fs.readFileSync(path.join(ROOT, 'prisma/schema.prisma')),
      { flag: 'wx', mode: 0o600 },
    );
    const hashes = {};
    const copy = (file) => {
      const content = run(
        'migration-read',
        'git',
        ['show', `HEAD:${file}`],
        true,
      );
      const original = fs.readFileSync(path.join(ROOT, file));
      check(original.equals(Buffer.from(content)));
      hashes[file] = sha(original);
      const dest = path.join(schemaDir, path.relative('prisma', file));
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.writeFileSync(dest, original, { flag: 'wx', mode: 0o600 });
    };
    const deploy = async () => {
      await pin();
      run('migrate-deploy', process.execPath, [
        cli,
        'migrate',
        'deploy',
        '--schema',
        path.join(schemaDir, 'schema.prisma'),
      ]);
    };
    for (const file of baseline) copy(file);
    result.state = 'baseline';
    await deploy();
    const tables = (
      await db.query(
        `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations' ORDER BY tablename`,
      )
    ).rows.map((r) => r.tablename);
    result.state = 'preservation-seed';
    await pin();
    const tenant = crypto.randomUUID(),
      supplier = crypto.randomUUID(),
      product = crypto.randomUUID();
    await db.query(
      'INSERT INTO tenants (id,name,slug,"updatedAt") VALUES ($1,$1,$1,now())',
      [tenant],
    );
    await db.query(
      'INSERT INTO procurement_suppliers (id,"tenantId","displayName",status,"updatedAt") VALUES ($1,$2,$1,\'ACTIVE\',now())',
      [supplier, tenant],
    );
    await db.query(
      'INSERT INTO products (id,"tenantId",name,"updatedAt") VALUES ($1,$2,$1,now())',
      [product, tenant],
    );
    const snapshot = () => captureTables(db, tables);
    const before = (await snapshot()).tables;
    save('before.json', before);
    const ledger = async () =>
      (
        await db.query(
          'SELECT migration_name,checksum,finished_at IS NOT NULL AS finished,rolled_back_at IS NOT NULL AS rolled_back FROM "_prisma_migrations" ORDER BY migration_name',
        )
      ).rows;
    const baselineLedger = await ledger();
    copy(forward);
    result.state = 'forward';
    await deploy();
    const after = (await snapshot()).tables;
    save('after.json', after);
    verifyAdditive(before, after);
    const forwardLedger = await ledger();
    assert.deepEqual(
      forwardLedger.filter((r) => r.migration_name !== FORWARD),
      baselineLedger,
    );
    result.preservation = true;
    // O3c: seed realistic O3b DRAFT rows, apply both O3c migrations over them, and
    // require the exact additive delta with every pre-existing row unchanged.
    result.state = 'o3c-seed';
    result.o3cSeeded = await seedO3bDrafts(db, pin);
    const o3bTableNames = (
      await db.query(
        `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations' ORDER BY tablename`,
      )
    ).rows.map((r) => r.tablename);
    check(PO_TABLES.every((table) => o3bTableNames.includes(table)));
    const hidden = NEW_COLUMNS;
    const o3bState = await captureTables(db, o3bTableNames, hidden);
    save('o3c-before.json', o3bState);
    for (const file of o3c) copy(file);
    result.state = 'o3c-forward';
    await deploy();
    result.state = 'o3c-preservation';
    const o3cState = await captureTables(db, o3bTableNames, hidden);
    save('o3c-after.json', o3cState);
    verifyO3cDelta(o3bState, o3cState);
    const survivors = (
      await db.query(
        `SELECT count(*)::int AS total,
           (count(*) FILTER (WHERE status = 'DRAFT'
             AND "confirmedAt" IS NULL AND "confirmedByDisplayName" IS NULL
             AND "cancelledAt" IS NULL AND "cancelledByDisplayName" IS NULL
             AND "lineSubtotalsSnapshot" IS NULL))::int AS untouched
         FROM ${ORDERS}`,
      )
    ).rows[0];
    assert.deepEqual(survivors, {
      total: result.o3cSeeded.orders,
      untouched: result.o3cSeeded.orders,
    });
    result.o3cPreservation = true;
    const finalLedger = await ledger();
    save('ledger.json', finalLedger);
    save('hashes.json', hashes);
    assert.deepEqual(
      finalLedger.filter((r) => !o3c.some((f) => f.includes(r.migration_name))),
      forwardLedger,
    );
    check(
      finalLedger.length ===
        files.filter((f) => f.endsWith('/migration.sql')).length,
    );
    check(
      finalLedger.every(
        (r) =>
          r.finished &&
          !r.rolled_back &&
          r.checksum ===
            hashes[`prisma/migrations/${r.migration_name}/migration.sql`],
      ),
    );
    result.state = 'sql-constraints';
    prisma = new (require('@prisma/client').PrismaClient)({
      datasources: { db: { url } },
    });
    result.constraints = await directProof(db, prisma, pin, (value) =>
      save('prisma-fk-observation.json', value),
    );
    await prisma.$disconnect();
    prisma = null;
    result.state = 'o3c-sql-constraints';
    result.o3cConstraints = await o3cProof(db, pin);
    result.state = 'integration';
    const specs = ['purchase-orders', 'suppliers'].flatMap((folder) =>
      fs
        .readdirSync(path.join(ROOT, 'src/procurement', folder))
        .filter((f) => f.endsWith('.integration.spec.ts'))
        .sort()
        .map((f) => `src/procurement/${folder}/${f}`),
    );
    check(specs.length === 5);
    for (const spec of specs) {
      await pin();
      for (const file of ['.env', '.env.test', 'prisma/.env'])
        check(!fs.existsSync(path.join(ROOT, file)));
      run(
        `integration-${path.basename(spec, '.integration.spec.ts')}`,
        process.execPath,
        [
          jest,
          '--config',
          'jest.integration.config.js',
          '--runInBand',
          '--no-cache',
          '--runTestsByPath',
          spec,
        ],
      );
    }
    result.state = 'passed';
  } catch {
    result.failedAt = result.state;
    result.state = 'failed';
    process.exitCode = 1;
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
    if (db) await db.end().catch(() => {});
    save('results.json', result);
    console.log(
      `PO proof ${result.state}; retained ${path.relative(ROOT, directory)}`,
    );
  }
}
module.exports = {
  splitMigrations,
  verifyAdditive,
  verifyO3cDelta,
  captureTables,
  seedO3bDrafts,
  o3cProof,
  expectSqlError,
  directProof,
  redact,
  FORWARD,
  O3C,
};
if (require.main === module)
  main().catch(() => {
    console.error('PO proof preflight rejected');
    process.exitCode = 1;
  });
