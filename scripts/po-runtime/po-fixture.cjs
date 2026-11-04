'use strict';
// O3c disposable-runtime fixture: realistic Spanish names only (human rule), users
// with distinct permission shapes, and closed orders made through the REAL HTTP
// commands so audits, receipts and frozen snapshots are genuine. Imports are inert.
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const SUBJECT = 'ProcurementPurchaseOrder';
const CONFIRM = 'ProcurementOrderConfirmation';
const CANCEL = 'ProcurementOrderCancellation';
const crud = (subject) =>
  ['create', 'read', 'update', 'delete'].map((action) => [subject, action]);

// label -> who they are and exactly what they may do. No ids are ever shown by the UI,
// so the display name is also the actor snapshot stored on confirm/cancel.
const USERS = [
  {
    label: 'manager',
    displayName: 'María González',
    roleName: 'Gerente de compras',
    grants: [
      ...crud('ProcurementSupplier'),
      ...crud(SUBJECT),
      ['Product', 'read'],
      [CONFIRM, 'create'],
      [CANCEL, 'create'],
    ],
  },
  {
    label: 'editor',
    displayName: 'Luis Hernández',
    roleName: 'Capturista de compras',
    grants: [
      ...crud(SUBJECT),
      ['ProcurementSupplier', 'read'],
      ['Product', 'read'],
    ],
  },
  {
    label: 'confirmer',
    displayName: 'Sofía Ramírez',
    roleName: 'Autorizadora de órdenes',
    grants: [
      [SUBJECT, 'read'],
      [CONFIRM, 'create'],
    ],
  },
  {
    label: 'canceller',
    displayName: 'Jorge Martínez',
    roleName: 'Responsable de cancelaciones',
    grants: [
      [SUBJECT, 'read'],
      [CANCEL, 'create'],
    ],
  },
  {
    label: 'reader',
    displayName: 'Ana Torres',
    roleName: 'Consulta de compras',
    grants: [[SUBJECT, 'read']],
  },
  {
    label: 'noaccess',
    displayName: 'Carlos Mendoza',
    roleName: 'Sin acceso a compras',
    grants: [],
  },
];
const TENANT_NAME = 'Mascotas y Alimentos El Roble';
const FOREIGN_TENANT_NAME = 'Veterinaria Central del Sur (otro negocio)';
const FOREIGN_SUPPLIER_NAME = 'Proveedor de otro negocio';

function fixtureGrants(label) {
  const user = USERS.find((entry) => entry.label === label);
  assert(user, 'Unknown fixture user');
  return user.grants.map((grant) => [...grant]);
}

// Keys are the probe/FE contract; names are what a person would see on screen.
const PRODUCTS = [
  ['croquetas', 'Croquetas Adulto 15 kg', 'BOLSA', 'PRODUCT', true, null],
  ['unidad', 'Juguete mordedera de hule', 'UNIDAD', 'PRODUCT', true, null],
  ['kilogramo', 'Croquetas a granel', 'KILOGRAMO', 'PRODUCT', true, null],
  [
    'caja',
    'Latas de alimento húmedo (caja)',
    'CAJA',
    'PRODUCT',
    true,
    ['Pollo 400 g', 'Res 400 g'],
  ],
  [
    'unidadVariants',
    'Collar ajustable',
    'UNIDAD',
    'PRODUCT',
    true,
    ['Chico · Azul', 'Grande · Rojo'],
  ],
  [
    'noStock',
    'Pecera personalizada (sobre pedido)',
    'UNIDAD',
    'PRODUCT',
    false,
    null,
  ],
  ['service', 'Servicio de baño y corte', 'HORA', 'SERVICE', false, null],
  [
    'foreign',
    'Producto exclusivo de otro negocio',
    'UNIDAD',
    'PRODUCT',
    false,
    null,
  ],
];
const SUPPLIERS = {
  active: 'Distribuidora Veterinaria del Norte',
  archived: 'Alimentos Balanceados del Bajío (archivado)',
};

async function seedCatalog(db, tenantId, otherTenantId, setStage = () => {}) {
  const catalog = {};
  for (const [label, name, unit, type, useStock, variants] of PRODUCTS) {
    setStage('seed-catalog-products');
    const product = await db.product.create({
      data: {
        tenantId: label === 'foreign' ? otherTenantId : tenantId,
        name,
        unit,
        type,
        useStock,
        hasVariants: variants !== null,
      },
    });
    catalog[label] = { id: product.id, name: product.name, unit };
    if (variants) {
      catalog[label].variants = [];
      for (const variantName of variants) {
        setStage('seed-catalog-variants');
        const variant = await db.variant.create({
          data: { tenantId, productId: product.id, name: variantName },
        });
        catalog[label].variants.push({ id: variant.id, name: variant.name });
      }
    }
  }
  setStage('seed-catalog-suppliers');
  for (const [key, status] of [
    ['active', 'ACTIVE'],
    ['archived', 'ARCHIVED'],
  ]) {
    const supplier = await db.procurementSupplier.create({
      data: { tenantId, displayName: SUPPLIERS[key], status },
    });
    catalog[key] = {
      id: supplier.id,
      displayName: supplier.displayName,
      version: supplier.version,
    };
  }
  return catalog;
}

async function seed({ db, password, setStage = () => {} }) {
  setStage('seed-password');
  const hash = await require('bcrypt').hash(password, 12);
  const permission = async (action, subject) =>
    (await db.permission.findUnique({
      where: { subject_action: { subject, action } },
    })) ?? (await db.permission.create({ data: { subject, action } }));
  const tenantId = crypto.randomUUID();
  const otherTenantId = crypto.randomUUID();
  setStage('seed-tenants');
  // The FE shell shows the slug under the tenant name: keep it readable.
  for (const [id, name, slug] of [
    [tenantId, TENANT_NAME, 'mascotas-el-roble'],
    [otherTenantId, FOREIGN_TENANT_NAME, 'veterinaria-central-del-sur'],
  ])
    await db.tenant.create({ data: { id, name, slug } });
  setStage('seed-foreign-supplier');
  await db.procurementSupplier.create({
    data: {
      tenantId: otherTenantId,
      displayName: FOREIGN_SUPPLIER_NAME,
      termsText: null,
      status: 'ACTIVE',
    },
  });
  const users = {};
  for (const { label, displayName, roleName } of USERS) {
    const userId = crypto.randomUUID();
    const roleId = crypto.randomUUID();
    const email = `${label}-${userId.slice(0, 8)}@po-runtime.invalid`;
    setStage('seed-users');
    await db.user.create({
      data: { id: userId, email, name: displayName, hashedPassword: hash },
    });
    setStage('seed-roles');
    await db.role.create({ data: { id: roleId, tenantId, name: roleName } });
    setStage('seed-permissions');
    for (const [subject, action] of fixtureGrants(label))
      await db.rolePermission.create({
        data: { roleId, permissionId: (await permission(action, subject)).id },
      });
    setStage('seed-memberships');
    await db.tenantMembership.create({ data: { tenantId, userId, roleId } });
    users[label] = { email, userId, displayName };
  }
  const catalog = await seedCatalog(db, tenantId, otherTenantId, setStage);
  return { tenantId, otherTenantId, users, catalog };
}

function defaultTransport(apiOrigin) {
  return async (method, route, { token, body, idempotencyKey } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${apiOrigin}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    const text = await response.text();
    try {
      return { status: response.status, body: text ? JSON.parse(text) : null };
    } catch {
      throw new Error('Invalid seed response');
    }
  };
}

// Real commands, real actors. Any unexpected status aborts the whole host start:
// a half-seeded showcase is worse than none.
async function seedOrders({ apiOrigin, password, fixture, transport }) {
  const send = transport ?? defaultTransport(apiOrigin);
  const { catalog, users } = fixture;
  const tokens = {};
  const call = async (actor, method, route, expected, body) => {
    const mutating = method !== 'GET' && !route.startsWith('/auth/');
    const response = await send(method, route, {
      token: tokens[actor],
      body,
      idempotencyKey: mutating ? crypto.randomUUID() : undefined,
    });
    assert.equal(response.status, expected);
    return response.body;
  };
  for (const actor of ['manager', 'confirmer', 'canceller']) {
    const login = await call(actor, 'POST', '/auth/login', 200, {
      email: users[actor].email,
      password,
    });
    assert.equal(typeof login.accessToken, 'string');
    tokens[actor] = login.accessToken;
  }
  const orders = '/procurement/purchase-orders';
  const suppliers = '/procurement/suppliers';
  const supplier = (displayName) =>
    call('manager', 'POST', suppliers, 201, {
      displayName,
      status: 'ACTIVE',
      termsText: null,
    });
  const accesorios = await supplier('Mayorista de Accesorios Pet Center');
  let hidalgo = await supplier('Distribuidora Canina Hidalgo');
  const cost = (product, amount, taxBasis = 'EXCLUDES_TAX') => ({
    amount,
    currency: 'MXN',
    unit: product.unit,
    taxBasis,
  });
  const line = (product, quantity, informedUnitCost, variant = null) => ({
    lineId: crypto.randomUUID(),
    productId: product.id,
    variantId: variant ? variant.id : null,
    orderedQuantity: quantity,
    informedUnitCost,
  });
  const input = (supplierRow, note, detail, lines) => ({
    supplierId: supplierRow.id,
    note,
    location: { detail },
    lines,
  });
  const create = async (body) => call('manager', 'POST', orders, 201, body);
  const confirmBody = (order) => ({
    expectedVersion: order.version,
    expectedSupplierVersion: order.supplierCurrentVersion,
    expectedReferenceToken: order.referenceToken,
  });
  const confirm = (actor, order) =>
    call(
      actor,
      'POST',
      `${orders}/${order.id}/confirm`,
      200,
      confirmBody(order),
    );
  const cancel = (actor, order) =>
    call(actor, 'POST', `${orders}/${order.id}/cancel`, 200, {
      expectedVersion: order.version,
    });
  const norte = catalog.active;
  const croquetas = catalog.croquetas;
  const collar = catalog.unidadVariants;
  const [chicoAzul, grandeRojo] = collar.variants;

  const ready = (order) => {
    assert.equal(order.status, 'DRAFT');
    assert.equal(order.canConfirm, true);
    assert.deepEqual(order.validation.issues, []);
    return order;
  };
  const result = {};
  result.readyToConfirm = ready(
    await create(
      input(
        norte,
        'Reposición mensual de croquetas y collares',
        'Bodega principal, andén 2',
        [
          line(croquetas, '12', cost(croquetas, '780.5')),
          line(collar, '24', cost(collar, '85', 'INCLUDES_TAX'), chicoAzul),
          line(catalog.kilogramo, '25.5', cost(catalog.kilogramo, '31.2')),
        ],
      ),
    ),
  );
  result.readyToConfirmSpare = ready(
    await create(
      input(
        accesorios,
        'Accesorios para temporada de lluvias',
        'Mostrador de accesorios',
        [
          line(collar, '10', cost(collar, '92.5', 'INCLUDES_TAX'), grandeRojo),
          line(catalog.unidad, '30', cost(catalog.unidad, '45')),
        ],
      ),
    ),
  );
  result.incompleteCost = await create(
    input(norte, 'Pedido pendiente: falta capturar el costo', null, [
      line(croquetas, '8', null),
    ]),
  );
  assert.equal(result.incompleteCost.canConfirm, false);
  assert(result.incompleteCost.validation.issues.length > 0);
  // Saved while ACTIVE, then archived: the draft keeps the supplier and the issue.
  result.archivedSupplierDraft = await create(
    input(
      hidalgo,
      'Pedido guardado antes de archivar al proveedor',
      'Bodega de refrigerados',
      [
        line(
          catalog.caja,
          '6',
          cost(catalog.caja, '540'),
          catalog.caja.variants[0],
        ),
      ],
    ),
  );
  assert.equal(result.archivedSupplierDraft.canConfirm, true);
  hidalgo = await call('manager', 'PATCH', `${suppliers}/${hidalgo.id}`, 200, {
    expectedVersion: hidalgo.version,
    changes: {
      status: 'ARCHIVED',
      displayName: 'Distribuidora Canina Hidalgo (archivado)',
    },
  });
  result.archivedSupplierDraft = await call(
    'manager',
    'GET',
    `${orders}/${result.archivedSupplierDraft.id}`,
    200,
  );
  assert.equal(result.archivedSupplierDraft.canConfirm, false);
  assert.equal(
    result.archivedSupplierDraft.supplierDisplaySnapshot.status,
    'ARCHIVED',
  );
  assert(
    result.archivedSupplierDraft.validation.issues.some(
      (issue) => issue.code === 'SUPPLIER_ARCHIVED',
    ),
  );

  const closed = async (body, actor, expectedBy) => {
    const order = await confirm(actor, ready(await create(body)));
    assert.equal(order.status, 'CONFIRMED');
    assert.deepEqual(order.confirmedBy, { displayName: expectedBy });
    return order;
  };
  result.confirmed = await closed(
    input(
      norte,
      'Orden confirmada: croquetas premium para la sucursal',
      'Bodega principal, andén 1',
      [line(croquetas, '20', cost(croquetas, '795'))],
    ),
    'manager',
    users.manager.displayName,
  );
  result.confirmedSpare = await closed(
    input(
      accesorios,
      'Orden confirmada: juguetes para cachorro',
      'Mostrador de accesorios',
      [line(catalog.unidad, '48', cost(catalog.unidad, '39.9'))],
    ),
    'manager',
    users.manager.displayName,
  );
  const draftToCancel = ready(
    await create(
      input(
        accesorios,
        'Pedido cancelado antes de confirmar: cambio de proveedor',
        null,
        [line(catalog.unidad, '15', cost(catalog.unidad, '41'))],
      ),
    ),
  );
  result.cancelledFromDraft = await cancel('canceller', draftToCancel);
  assert.equal(result.cancelledFromDraft.status, 'CANCELLED');
  assert.equal(result.cancelledFromDraft.confirmedAt, null);
  assert.deepEqual(result.cancelledFromDraft.cancelledBy, {
    displayName: users.canceller.displayName,
  });
  const toCancelLater = await closed(
    input(
      norte,
      'Orden cancelada tras confirmar: proveedor sin existencias',
      'Bodega principal, andén 2',
      [line(croquetas, '5', cost(croquetas, '780.5'))],
    ),
    'confirmer',
    users.confirmer.displayName,
  );
  result.cancelledFromConfirmed = await cancel('canceller', toCancelLater);
  assert.equal(result.cancelledFromConfirmed.status, 'CANCELLED');
  assert.deepEqual(result.cancelledFromConfirmed.confirmedBy, {
    displayName: users.confirmer.displayName,
  });
  assert.deepEqual(result.cancelledFromConfirmed.cancelledBy, {
    displayName: users.canceller.displayName,
  });
  const summary = Object.fromEntries(
    Object.entries(result).map(([key, order]) => [
      key,
      { id: order.id, status: order.status, note: order.note },
    ]),
  );
  return {
    orders: summary,
    suppliers: {
      accesorios: { id: accesorios.id, displayName: accesorios.displayName },
      archivedAfterDraft: { id: hidalgo.id, displayName: hidalgo.displayName },
    },
  };
}

module.exports = {
  USERS,
  fixtureGrants,
  seedCatalog,
  seed,
  seedOrders,
  afterListen: seedOrders,
  names: { TENANT_NAME, FOREIGN_TENANT_NAME, FOREIGN_SUPPLIER_NAME, SUPPLIERS },
};
