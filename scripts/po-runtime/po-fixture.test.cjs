'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  USERS,
  fixtureGrants,
  seedCatalog,
  seed,
  seedOrders,
  names,
} = require('./po-fixture.cjs');
const { fixtureHooks } = require('../supplier-runtime/host.cjs');
const fixture = require('./po-fixture.cjs');
// Human rule: readable, realistic Spanish names; never ids, prefixes or test words.
const unreadable =
  /(^|[^a-z])(test|probe|fixture|runtime|sondeo)([^a-z]|$)|[0-9a-f]{8}-|PO-|^[\w.-]+-\d+$/i;
const readable = (value) => {
  assert.equal(typeof value, 'string');
  assert(value.trim().length >= 6 && !unreadable.test(value), value);
};
function fakeDb() {
  const rows = {
    tenant: [],
    user: [],
    role: [],
    permission: [],
    rolePermission: [],
    tenantMembership: [],
    product: [],
    variant: [],
    procurementSupplier: [],
  };
  const model = (name) => ({
    create: async ({ data }) => {
      const row = { id: randomUUID(), version: 1, ...data };
      rows[name].push(row);
      return row;
    },
    findUnique: async ({ where: { subject_action: key } }) =>
      rows.permission.find(
        (row) => row.subject === key.subject && row.action === key.action,
      ) ?? null,
  });
  return {
    rows,
    db: Object.fromEntries(Object.keys(rows).map((key) => [key, model(key)])),
  };
}
const grantSet = (label) =>
  fixtureGrants(label)
    .map(([subject, action]) => `${action}:${subject}`)
    .sort();
test('five user shapes plus noaccess hold exactly the grants the O3c matrix needs', () => {
  assert.deepEqual(
    USERS.map((user) => user.label),
    ['manager', 'editor', 'confirmer', 'canceller', 'reader', 'noaccess'],
  );
  const all = [
    'create:ProcurementOrderCancellation',
    'create:ProcurementOrderConfirmation',
    'create:ProcurementPurchaseOrder',
    'create:ProcurementSupplier',
    'delete:ProcurementPurchaseOrder',
    'delete:ProcurementSupplier',
    'read:Product',
    'read:ProcurementPurchaseOrder',
    'read:ProcurementSupplier',
    'update:ProcurementPurchaseOrder',
    'update:ProcurementSupplier',
  ].sort();
  assert.deepEqual(grantSet('manager'), all);
  // read + edit, but neither confirm nor cancel
  assert.deepEqual(
    grantSet('editor'),
    [
      'create:ProcurementPurchaseOrder',
      'delete:ProcurementPurchaseOrder',
      'read:Product',
      'read:ProcurementPurchaseOrder',
      'read:ProcurementSupplier',
      'update:ProcurementPurchaseOrder',
    ].sort(),
  );
  assert.deepEqual(grantSet('confirmer'), [
    'create:ProcurementOrderConfirmation',
    'read:ProcurementPurchaseOrder',
  ]);
  assert.deepEqual(grantSet('canceller'), [
    'create:ProcurementOrderCancellation',
    'read:ProcurementPurchaseOrder',
  ]);
  assert.deepEqual(grantSet('reader'), ['read:ProcurementPurchaseOrder']);
  assert.deepEqual(grantSet('noaccess'), []);
  assert.throws(() => fixtureGrants('unknown'));
  // callers cannot mutate the shared definitions
  fixtureGrants('manager').length = 0;
  assert.equal(fixtureGrants('manager').length, all.length);
});
test('every seeded name a person can see is realistic and readable', () => {
  for (const user of USERS) {
    readable(user.displayName);
    readable(user.roleName);
  }
  assert.equal(new Set(USERS.map((u) => u.displayName)).size, USERS.length);
  for (const name of [
    names.TENANT_NAME,
    names.FOREIGN_TENANT_NAME,
    names.FOREIGN_SUPPLIER_NAME,
    ...Object.values(names.SUPPLIERS),
  ])
    readable(name);
  assert.equal(names.SUPPLIERS.active, 'Distribuidora Veterinaria del Norte');
  assert.equal(
    names.SUPPLIERS.archived,
    'Alimentos Balanceados del Bajío (archivado)',
  );
});
test('catalog seeds readable products/variants/suppliers and keeps the probe keys', async () => {
  const f = fakeDb();
  const catalog = await seedCatalog(f.db, 'owned', 'foreign');
  for (const key of [
    'croquetas',
    'unidad',
    'kilogramo',
    'caja',
    'unidadVariants',
    'noStock',
    'service',
    'foreign',
    'active',
    'archived',
  ])
    assert(catalog[key].id, key);
  for (const row of [...f.rows.product, ...f.rows.variant]) readable(row.name);
  assert.equal(catalog.croquetas.name, 'Croquetas Adulto 15 kg');
  assert.equal(catalog.croquetas.unit, 'BOLSA');
  assert.equal(catalog.unidadVariants.name, 'Collar ajustable');
  assert.deepEqual(
    catalog.unidadVariants.variants.map((v) => v.name),
    ['Chico · Azul', 'Grande · Rojo'],
  );
  assert.equal(catalog.kilogramo.unit, 'KILOGRAMO');
  assert.equal(catalog.service.unit, 'HORA');
  assert.equal(
    f.rows.product.find((row) => row.name === catalog.noStock.name).useStock,
    false,
  );
  assert.equal(
    f.rows.product.filter((row) => row.tenantId === 'foreign').length,
    1,
  );
  assert(
    f.rows.variant.every(
      (row) => row.tenantId === 'owned' && row.productId !== catalog.foreign.id,
    ),
  );
  assert.deepEqual(
    f.rows.procurementSupplier.map((row) => row.status),
    ['ACTIVE', 'ARCHIVED'],
  );
});
test('seed links each readable user to a role with exactly its grants', async () => {
  const f = fakeDb();
  const stages = [];
  const result = await seed({
    db: f.db,
    password: 'generated-in-memory',
    setStage: (stage) => stages.push(stage),
  });
  assert.deepEqual(
    Object.keys(result.users),
    USERS.map((u) => u.label),
  );
  assert.notEqual(result.tenantId, result.otherTenantId);
  assert.deepEqual(
    f.rows.tenant.map((t) => t.name),
    [names.TENANT_NAME, names.FOREIGN_TENANT_NAME],
  );
  // The FE shell shows the tenant slug under its name: readable, no ids.
  assert.deepEqual(
    f.rows.tenant.map((t) => t.slug),
    ['mascotas-el-roble', 'veterinaria-central-del-sur'],
  );
  for (const user of USERS) {
    const created = f.rows.user.find((row) => row.name === user.displayName);
    assert.equal(result.users[user.label].displayName, user.displayName);
    assert.equal(result.users[user.label].userId, created.id);
    assert(
      created.hashedPassword &&
        created.hashedPassword !== 'generated-in-memory',
    );
    const membership = f.rows.tenantMembership.find(
      (row) => row.userId === created.id,
    );
    assert.equal(membership.tenantId, result.tenantId);
    assert.equal(
      f.rows.role.find((row) => row.id === membership.roleId).name,
      user.roleName,
    );
    const held = f.rows.rolePermission
      .filter((row) => row.roleId === membership.roleId)
      .map((row) => f.rows.permission.find((p) => p.id === row.permissionId))
      .map((p) => `${p.action}:${p.subject}`)
      .sort();
    assert.deepEqual(held, grantSet(user.label));
  }
  // permissions are shared rows: each (subject, action) exists once
  const keys = f.rows.permission.map((p) => `${p.subject}:${p.action}`);
  assert.equal(new Set(keys).size, keys.length);
  assert(stages.every((stage) => typeof stage === 'string'));
  assert(result.catalog.active && result.catalog.archived);
});
test('the host admits this fixture only through the PO-mode hook', () => {
  assert.equal(fixtureHooks({ po: true, fixture }), fixture);
  assert.equal(fixtureHooks({ po: false, fixture }), undefined);
});
// In-memory transport: validates call sequencing, actors and assertions only. It is NOT
// API behavior or PostgreSQL evidence.
function fakeApi({ breakAt } = {}) {
  const suppliers = new Map();
  const orders = new Map();
  const calls = [];
  const people = {};
  const fx = {
    users: Object.fromEntries(
      USERS.map((u) => [
        u.label,
        { email: `${u.label}@x.invalid`, displayName: u.displayName },
      ]),
    ),
    catalog: {},
  };
  const catalog = {
    active: { id: randomUUID(), displayName: 'Norte', version: 1 },
  };
  for (const [key, unit] of [
    ['croquetas', 'BOLSA'],
    ['unidad', 'UNIDAD'],
    ['kilogramo', 'KILOGRAMO'],
    ['caja', 'CAJA'],
    ['unidadVariants', 'UNIDAD'],
  ])
    catalog[key] = {
      id: randomUUID(),
      unit,
      variants: [
        { id: randomUUID(), name: 'A' },
        { id: randomUUID(), name: 'B' },
      ],
    };
  fx.catalog = catalog;
  suppliers.set(catalog.active.id, {
    id: catalog.active.id,
    version: 1,
    status: 'ACTIVE',
    displayName: 'Norte',
  });
  const view = (o) => {
    const s = suppliers.get(o.supplierId);
    const issues = [];
    if (o.status === 'DRAFT') {
      if (s.status === 'ARCHIVED')
        issues.push({ path: '/supplierId', code: 'SUPPLIER_ARCHIVED' });
      o.lines.forEach((l, i) => {
        if (!l.informedUnitCost)
          issues.push({
            path: `/lines/${i}/informedUnitCost/amount`,
            code: 'COST_AMOUNT_REQUIRED',
          });
      });
    }
    return {
      ...structuredClone(o),
      supplierCurrentVersion: s.version,
      referenceToken: o.status === 'DRAFT' ? `prt1.${o.id}` : null,
      canConfirm:
        o.status === 'DRAFT' && !issues.length && s.status === 'ACTIVE',
      validation: { issues },
      supplierDisplaySnapshot: { id: s.id, status: s.status },
    };
  };
  const reply = (status, body) => ({ status, body });
  const transport = async (method, route, options = {}) => {
    const { token, body, idempotencyKey } = options;
    calls.push({ method, route, token, idempotencyKey, body });
    if (breakAt === `${method} ${route.split('/').slice(-1)[0]}`)
      return reply(500, { statusCode: 500, error: 'INTERNAL_ERROR' });
    if (route === '/auth/login') {
      const label = Object.keys(fx.users).find(
        (k) => fx.users[k].email === body.email,
      );
      people[`t-${label}`] = label;
      return reply(200, { accessToken: `t-${label}` });
    }
    const actor = people[token];
    if (method === 'POST' && route === '/procurement/suppliers') {
      const row = { id: randomUUID(), version: 1, ...body };
      suppliers.set(row.id, row);
      return reply(201, structuredClone(row));
    }
    if (method === 'PATCH') {
      const row = suppliers.get(route.split('/').pop());
      Object.assign(row, body.changes, { version: row.version + 1 });
      return reply(200, structuredClone(row));
    }
    if (method === 'POST' && route === '/procurement/purchase-orders') {
      const order = {
        id: randomUUID(),
        version: 1,
        status: 'DRAFT',
        confirmedAt: null,
        confirmedBy: null,
        cancelledAt: null,
        cancelledBy: null,
        ...body,
      };
      orders.set(order.id, order);
      return reply(201, view(order));
    }
    const [, , , id, action] = route.split('/');
    const order = orders.get(id);
    if (method === 'GET') return reply(200, view(order));
    const name = fx.users[actor].displayName;
    if (action === 'confirm') {
      if (actor === 'canceller' || actor === 'reader')
        return reply(403, { statusCode: 403, error: 'FORBIDDEN' });
      assert(view(order).canConfirm);
      assert.equal(body.expectedReferenceToken, `prt1.${id}`);
      Object.assign(order, {
        status: 'CONFIRMED',
        version: order.version + 1,
        confirmedAt: '2026-11-03T10:00:00.000Z',
        confirmedBy: { displayName: name },
      });
      return reply(200, view(order));
    }
    if (action === 'cancel') {
      Object.assign(order, {
        status: 'CANCELLED',
        version: order.version + 1,
        cancelledAt: '2026-11-03T11:00:00.000Z',
        cancelledBy: { displayName: name },
      });
      return reply(200, view(order));
    }
    throw new Error('Unexpected fake request');
  };
  return { transport, calls, fixture: fx, orders, suppliers };
}
test('orders are made through real commands by the intended actors; every mutation is idempotent-keyed', async () => {
  const api = fakeApi();
  const result = await seedOrders({
    apiOrigin: 'http://127.0.0.1:1',
    password: 'p',
    fixture: api.fixture,
    transport: api.transport,
  });
  assert.deepEqual(Object.keys(result.orders), [
    'readyToConfirm',
    'readyToConfirm2',
    'readyToConfirm3',
    'incompleteCost',
    'archivedSupplierDraft',
    'confirmed',
    'confirmed2',
    'confirmed3',
    'cancelledFromDraft',
    'cancelledFromConfirmed',
  ]);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(result.orders).map(([k, v]) => [k, v.status]),
    ),
    {
      readyToConfirm: 'DRAFT',
      readyToConfirm2: 'DRAFT',
      readyToConfirm3: 'DRAFT',
      incompleteCost: 'DRAFT',
      archivedSupplierDraft: 'DRAFT',
      confirmed: 'CONFIRMED',
      confirmed2: 'CONFIRMED',
      confirmed3: 'CONFIRMED',
      cancelledFromDraft: 'CANCELLED',
      cancelledFromConfirmed: 'CANCELLED',
    },
  );
  for (const order of Object.values(result.orders)) readable(order.note);
  for (const supplier of Object.values(result.suppliers))
    readable(supplier.displayName);
  const mutating = api.calls.filter(
    (c) => c.method !== 'GET' && c.route !== '/auth/login',
  );
  assert(mutating.every((c) => typeof c.idempotencyKey === 'string'));
  assert.equal(
    new Set(mutating.map((c) => c.idempotencyKey)).size,
    mutating.length,
  );
  assert(
    api.calls
      .filter((c) => c.route === '/auth/login')
      .every((c) => c.idempotencyKey === undefined),
  );
  // closed orders: confirm by the confirm-only user, cancel by the cancel-only user
  const state = Object.fromEntries(api.orders);
  const byNote = (note) =>
    Object.values(state).find((order) => order.note === note);
  const fromConfirmed = byNote(result.orders.cancelledFromConfirmed.note);
  assert.equal(fromConfirmed.confirmedBy.displayName, 'Sofía Ramírez');
  assert.equal(fromConfirmed.cancelledBy.displayName, 'Jorge Martínez');
  const fromDraft = byNote(result.orders.cancelledFromDraft.note);
  assert.equal(fromDraft.confirmedAt, null);
  assert.equal(fromDraft.cancelledBy.displayName, 'Jorge Martínez');
  assert.equal(
    byNote(result.orders.confirmed.note).confirmedBy.displayName,
    'María González',
  );
  // showcase drafts stay untouched: never confirmed, cancelled, replaced or deleted
  for (const key of [
    'readyToConfirm',
    'readyToConfirm2',
    'readyToConfirm3',
    'incompleteCost',
  ])
    assert.equal(byNote(result.orders[key].note).version, 1);
  // every showcase order has its own readable note, so the UI can tell them apart
  const notes = Object.values(result.orders).map((order) => order.note);
  assert.equal(new Set(notes).size, notes.length);
  assert(!api.calls.some((c) => ['PUT', 'DELETE'].includes(c.method)));
  // the draft whose supplier was archived after saving
  const archived = result.suppliers.archivedAfterDraft;
  assert.equal(api.suppliers.get(archived.id).status, 'ARCHIVED');
  readable(archived.displayName);
});
test('any unexpected status aborts seeding instead of leaving a half-made showcase', async () => {
  for (const breakAt of ['POST confirm', 'POST cancel', 'POST login']) {
    const api = fakeApi({ breakAt });
    await assert.rejects(() =>
      seedOrders({
        apiOrigin: 'http://127.0.0.1:1',
        password: 'p',
        fixture: api.fixture,
        transport: api.transport,
      }),
    );
  }
});
