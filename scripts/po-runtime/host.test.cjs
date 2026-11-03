'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  routeAllowed,
  selectorQueryAllowed,
  seedCatalog,
  fixtureGrants,
  installParsers,
} = require('./host.cjs');
test('host installs the actual production PO body-parser module only in PO mode', () => {
  for (const po of [false, true]) {
    const calls = [];
    const app = {};
    const modules = {
      'procurement/suppliers/supplier-http.filter': {
        installSupplierBodyParser: (value) => {
          assert.equal(value, app);
          calls.push('supplier');
        },
      },
      'procurement/purchase-orders/po-body-parser': {
        installPurchaseOrderBodyParser: (value) => {
          assert.equal(value, app);
          calls.push('po');
        },
      },
    };
    installParsers(app, po, (name) => {
      assert(Object.hasOwn(modules, name));
      return modules[name];
    });
    assert.deepEqual(calls, po ? ['supplier', 'po'] : ['supplier']);
  }
});
test('PO opt-in admits only five PO routes and two selector reads', () => {
  for (const [method, route] of [
    ['GET', '/PROCUREMENT/PURCHASE-ORDERS/'],
    ['POST', '/procurement/purchase-orders'],
    ['GET', '/procurement/purchase-orders/abc'],
    ['PUT', '/Procurement/Purchase-Orders/abc/DRAFT/'],
    ['DELETE', '/procurement/purchase-orders/abc/'],
    ['GET', '/PRODUCTS/'],
    ['GET', '/products/abc/variants/'],
  ]) {
    assert(routeAllowed(method, route, true));
    assert(!routeAllowed(method, route));
  }
  for (const [method, route] of [
    ['PATCH', '/procurement/purchase-orders/abc'],
    ['PUT', '/procurement/purchase-orders/abc'],
    ['POST', '/procurement/purchase-orders/abc/draft'],
    ['GET', '/procurement/purchase-orders/abc/draft'],
    ['DELETE', '/procurement/purchase-orders'],
    ['GET', '/procurement/purchase-orders/abc/history'],
    ['GET', '/procurement/purchase-orders//'],
    ['GET', '/products/abc'],
    ['POST', '/products'],
    ['GET', '/products/abc/variants/xyz'],
  ])
    assert(!routeAllowed(method, route, true));
});
test('selector query boundary excludes adjacent capabilities and structured/repeated values', () => {
  assert(
    selectorQueryAllowed('/PRODUCTS/', {
      search: 'box',
      type: 'PRODUCT',
      page: '1',
      limit: '25',
    }),
  );
  assert(selectorQueryAllowed('/products/abc/variants/', {}));
  for (const query of [{ status: 'ALL' }, { search: ['a', 'b'] }, { type: {} }])
    assert(!selectorQueryAllowed('/products', query));
  assert(!selectorQueryAllowed('/products/abc/variants', { limit: '1' }));
});
test('PO reader has ONLY read PO; supplier-only grants are unchanged', () => {
  assert.deepEqual(fixtureGrants('reader', true), [
    ['ProcurementPurchaseOrder', 'read'],
  ]);
  assert.deepEqual(fixtureGrants('reader'), [['ProcurementSupplier', 'read']]);
  assert.deepEqual(fixtureGrants('noaccess', true), []);
  const grants = fixtureGrants('manager', true);
  assert.equal(grants.length, 9);
  for (const subject of ['ProcurementSupplier', 'ProcurementPurchaseOrder'])
    for (const action of ['read', 'create', 'update', 'delete'])
      assert(grants.some((g) => g[0] === subject && g[1] === action));
  assert.deepEqual(
    grants.filter((g) => g[0] === 'Product'),
    [['Product', 'read']],
  );
});
test('catalog fixtures are tenant-scoped, unique, and exercise selector variants', async () => {
  const writes = { product: [], variant: [], procurementSupplier: [] };
  const db = Object.fromEntries(
    Object.keys(writes).map((model) => [
      model,
      {
        create: async ({ data }) => {
          writes[model].push(data);
          return {
            ...data,
            id: `${model}-${writes[model].length}`,
            version: 1,
          };
        },
      },
    ]),
  );
  const catalog = await seedCatalog(db, 'owned', 'foreign');
  assert.equal(writes.product.length, 7);
  assert.equal(writes.variant.length, 4);
  assert.equal(catalog.unidadVariants.unit, 'UNIDAD');
  assert.equal(catalog.unidadVariants.variants.length, 2);
  assert.equal(catalog.caja.variants.length, 2);
  assert(
    writes.variant.every(
      (v) =>
        v.tenantId === 'owned' &&
        [catalog.caja.id, catalog.unidadVariants.id].includes(v.productId),
    ),
  );
  assert.equal(
    writes.product.filter((v) => v.tenantId === 'foreign').length,
    1,
  );
  assert.equal(
    writes.product.find((v) => v.name.endsWith('-noStock')).useStock,
    false,
  );
  assert.equal(
    writes.product.find((v) => v.name.endsWith('-service')).type,
    'SERVICE',
  );
  assert.deepEqual(
    writes.procurementSupplier.map((v) => v.status),
    ['ACTIVE', 'ARCHIVED'],
  );
  assert(writes.product.every((v) => v.name.startsWith(catalog.prefix)));
});
