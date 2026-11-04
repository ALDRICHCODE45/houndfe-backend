'use strict';
// Parent-only HTTP evidence. Never prints bodies/errors, tokens, names, IDs or URLs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { validatePrivatePath } = require('../supplier-runtime/host.cjs');
const { decodeBody } = require('../supplier-runtime/probe.cjs');
const ACTORS = [
  'manager',
  'editor',
  'confirmer',
  'canceller',
  'reader',
  'noaccess',
];
const collection = '/procurement/purchase-orders';
const suppliers = '/procurement/suppliers';
const key = () => crypto.randomUUID();
function parseUrl(text) {
  try {
    return new URL(text);
  } catch {
    throw new Error('Invalid disposable origin');
  }
}
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Invalid private fixture metadata');
  }
}
function validateOrigins(ready, credentials) {
  const url = parseUrl(ready.apiOrigin);
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1');
  assert(url.port && url.port !== '3000');
  assert.equal(url.origin, ready.apiOrigin);
  assert.equal(credentials.apiOrigin, ready.apiOrigin);
  const fe = parseUrl(ready.feOrigin);
  assert(['http:', 'https:'].includes(fe.protocol));
  assert.equal(fe.origin, ready.feOrigin);
  assert.notEqual(credentials.tenantId, credentials.otherTenantId);
  return { apiOrigin: url.origin, origin: fe.origin };
}
function expectResponse(response, status, error, origin) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal(
    response.headers.get('access-control-allow-credentials'),
    'true',
  );
  if (status === 204) assert.equal(response.text, '');
  if (error) assert.deepEqual(response.body, { statusCode: status, error });
  return response.body;
}
const STATUSES = ['DRAFT', 'CONFIRMED', 'CANCELLED'];
const iso = (value) =>
  typeof value === 'string' &&
  new Date(value).toISOString() === value &&
  /^\d{4}-\d{2}-\d{2}T/.test(value);
const actorSnapshot = (value) =>
  value === null ||
  (Object.keys(value).join() === 'displayName' &&
    typeof value.displayName === 'string' &&
    value.displayName.length > 0);
function detail(value) {
  assert.deepEqual(
    Object.keys(value).sort(),
    [
      'id',
      'version',
      'status',
      'createdAt',
      'updatedAt',
      'supplierId',
      'note',
      'location',
      'lines',
      'supplierDisplaySnapshot',
      'lineDisplaySnapshots',
      'lineSubtotals',
      'locationSnapshot',
      'validation',
      'supplierCurrentVersion',
      'referenceToken',
      'canConfirm',
      'confirmedAt',
      'confirmedBy',
      'cancelledAt',
      'cancelledBy',
    ].sort(),
  );
  assert(STATUSES.includes(value.status));
  assert(Number.isSafeInteger(value.version) && value.version > 0);
  assert(
    value.supplierCurrentVersion === null ||
      (Number.isSafeInteger(value.supplierCurrentVersion) &&
        value.supplierCurrentVersion > 0),
  );
  assert(
    value.referenceToken === null ||
      (typeof value.referenceToken === 'string' && value.referenceToken),
  );
  assert.equal(typeof value.canConfirm, 'boolean');
  // The FE never builds ids or tokens: ids are absent from every actor snapshot.
  for (const [at, by] of [
    ['confirmedAt', 'confirmedBy'],
    ['cancelledAt', 'cancelledBy'],
  ]) {
    assert(value[at] === null || iso(value[at]));
    assert(actorSnapshot(value[by]));
    assert.equal(value[at] === null, value[by] === null);
  }
  assert.deepEqual(Object.keys(value.validation), ['issues']);
  for (const issue of value.validation.issues) {
    assert.deepEqual(Object.keys(issue).sort(), ['code', 'path']);
    assert(issue.path.startsWith('/'));
  }
  if (value.status === 'DRAFT') {
    assert(value.confirmedAt === null && value.cancelledAt === null);
  } else {
    assert.equal(value.canConfirm, false);
    assert.deepEqual(value.validation.issues, []);
    assert.equal(value.cancelledAt !== null, value.status === 'CANCELLED');
    assert(value.status === 'CANCELLED' || value.confirmedAt !== null);
  }
  // S3: every clause of canConfirm, including an ACTIVE supplier.
  if (value.canConfirm) {
    assert.equal(value.status, 'DRAFT');
    assert(value.referenceToken && value.supplierCurrentVersion);
    assert.deepEqual(value.validation.issues, []);
    assert.equal(value.supplierDisplaySnapshot?.status, 'ACTIVE');
  }
  return value;
}
function summary(value) {
  assert.deepEqual(
    Object.keys(value).sort(),
    [
      'id',
      'version',
      'status',
      'supplierDisplaySnapshot',
      'lineCount',
      'issueCount',
      'note',
      'locationDetail',
      'createdAt',
      'updatedAt',
    ].sort(),
  );
  assert(STATUSES.includes(value.status));
  assert(Number.isSafeInteger(value.lineCount) && value.lineCount >= 0);
  assert(Number.isSafeInteger(value.issueCount) && value.issueCount >= 0);
}
// Injectable transport/check runner gives offline coverage without binding a socket.
async function scenario(request, check, catalog, origin, tenantId) {
  const expect = (response, status, error) =>
    expectResponse(response, status, error, origin);
  const empty = {
    supplierId: null,
    note: null,
    location: { detail: null },
    lines: [],
  };
  const prefix = 'Pedido semanal de croquetas Occidente';
  const create = (body, idempotencyKey = key(), actor = 'manager') =>
    request('POST', collection, { body, idempotencyKey, actor });
  const replace = (order, body, expectedVersion = order.version) =>
    request('PUT', `${collection}/${order.id}/draft`, {
      body: { expectedVersion, order: body },
      idempotencyKey: key(),
    });
  const list = async (query, actor = 'manager') => {
    const page = expect(
      await request('GET', `${collection}?${new URLSearchParams(query)}`, {
        actor,
      }),
      200,
    );
    assert.deepEqual(Object.keys(page).sort(), ['items', 'nextCursor']);
    assert(Array.isArray(page.items));
    assert(page.nextCursor === null || typeof page.nextCursor === 'string');
    page.items.forEach(summary);
    return page;
  };
  let current, original;
  const incomplete = { ...empty, note: `${prefix} · borrador incompleto` };
  const createKey = key();
  await check('create-incomplete', ['S2', 'S4', 'S8'], async () => {
    original = detail(expect(await create(incomplete, createKey), 201));
    assert.equal(original.version, 1);
    assert.deepEqual(original.validation.issues, [
      { path: '/lines', code: 'LINES_REQUIRED' },
      { path: '/supplierId', code: 'SUPPLIER_REQUIRED' },
    ]);
    assert.deepEqual(original.locationSnapshot, {
      tenantId,
      tenantName: original.locationSnapshot.tenantName,
      detail: null,
    });
    current = original;
  });
  assert(current);
  await check('create-replay-and-key-conflict', ['S2', 'S12'], async () => {
    assert.deepEqual(
      expect(await create(incomplete, createKey), 201),
      original,
    );
    expect(
      await create(
        { ...incomplete, note: `${prefix} · cambio en conflicto` },
        createKey,
      ),
      409,
      'IDEMPOTENCY_KEY_CONFLICT',
    );
  });
  let supplier;
  await check('owned-supplier-create', ['S2', 'S10'], async () => {
    supplier = expect(
      await request('POST', suppliers, {
        body: {
          displayName: 'Comercializadora Agropecuaria de Occidente',
          status: 'ACTIVE',
          termsText: null,
        },
        idempotencyKey: key(),
      }),
      201,
    );
  });
  assert(supplier);
  const line = (product, changes = {}) => ({
    lineId: key(),
    productId: product.id,
    variantId: null,
    orderedQuantity: '1',
    informedUnitCost: null,
    ...changes,
  });
  const kilogramo = line(catalog.kilogramo, {
    orderedQuantity: '12.5',
    informedUnitCost: {
      amount: '10.25',
      currency: 'MXN',
      unit: 'KILOGRAMO',
      taxBasis: 'EXCLUDES_TAX',
    },
  });
  const complete = {
    ...empty,
    supplierId: supplier.id,
    note: `${prefix} · cantidades exactas`,
    location: { detail: 'Entrega en bodega de recepción' },
    lines: [kilogramo],
  };
  await check(
    'replace-CAS-and-exact-subtotal-detail',
    ['S2', 'S4', 'S5', 'S6', 'S7', 'S8'],
    async () => {
      current = detail(expect(await replace(current, complete), 200));
      assert.equal(current.version, 2);
      assert.deepEqual(current.lines, complete.lines);
      assert.deepEqual(current.supplierDisplaySnapshot, {
        id: supplier.id,
        displayName: supplier.displayName,
        status: 'ACTIVE',
      });
      assert.deepEqual(current.lineDisplaySnapshots, [
        {
          lineId: kilogramo.lineId,
          productName: catalog.kilogramo.name,
          variantName: null,
          unit: 'KILOGRAMO',
        },
      ]);
      assert.deepEqual(current.lineSubtotals, [
        {
          lineId: kilogramo.lineId,
          subtotal: {
            amount: '128.125',
            currency: 'MXN',
            taxBasis: 'EXCLUDES_TAX',
          },
        },
      ]);
      assert.deepEqual(current.validation.issues, []);
      assert.deepEqual(
        expect(await request('GET', `${collection}/${current.id}`), 200),
        current,
      );
      expect(
        await replace(current, complete, 1),
        409,
        'ORDER_VERSION_CONFLICT',
      );
    },
  );
  assert.equal(current.version, 2);
  await check(
    'incomplete-reference-diagnostics-and-no-stock-product',
    ['S4', 'S8', 'S9'],
    async () => {
      const input = {
        ...empty,
        note: `${prefix} · referencias pendientes`,
        lines: [
          line(catalog.caja, { orderedQuantity: null }),
          line(catalog.noStock),
        ],
      };
      const saved = detail(expect(await create(input), 201));
      assert(
        saved.validation.issues.some(
          (i) =>
            i.path === '/lines/0/variantId' && i.code === 'VARIANT_REQUIRED',
        ),
      );
      assert(
        saved.validation.issues.some(
          (i) =>
            i.path === '/lines/0/orderedQuantity' &&
            i.code === 'QUANTITY_REQUIRED',
        ),
      );
      assert(
        !saved.validation.issues.some((i) => i.path === '/lines/1/productId'),
      );
      assert.equal(saved.lineSubtotals[0].subtotal, null);
    },
  );
  for (const [name, product, changes, status, error] of [
    ['service', catalog.service, {}, 400, 'MALFORMED'],
    ['foreign-product', catalog.foreign, {}, 404, 'NOT_FOUND'],
    ['random-product', { id: key() }, {}, 404, 'NOT_FOUND'],
    [
      'fraction-unidad',
      catalog.unidad,
      { orderedQuantity: '1.5' },
      400,
      'MALFORMED',
    ],
    [
      'currency-USD',
      catalog.kilogramo,
      { informedUnitCost: { ...kilogramo.informedUnitCost, currency: 'USD' } },
      400,
      'MALFORMED',
    ],
  ])
    await check(`reject-${name}`, ['S5', 'S6', 'S9', 'S12'], async () => {
      expect(
        await create({ ...empty, lines: [line(product, changes)] }),
        status,
        error,
      );
      assert.deepEqual(
        expect(await request('GET', `${collection}/${current.id}`), 200),
        current,
      );
    });
  await check('new-archived-supplier-rejected', ['S10', 'S12'], async () => {
    expect(
      await create({ ...empty, supplierId: catalog.archived.id }),
      409,
      'SUPPLIER_ARCHIVED',
    );
    expect(
      await replace(current, { ...complete, supplierId: catalog.archived.id }),
      409,
      'SUPPLIER_ARCHIVED',
    );
  });
  await check('archive-retained-supplier', ['S9', 'S10'], async () => {
    supplier = expect(
      await request('PATCH', `${suppliers}/${supplier.id}`, {
        body: {
          expectedVersion: supplier.version,
          changes: { status: 'ARCHIVED' },
        },
        idempotencyKey: key(),
      }),
      200,
    );
    const read = detail(
      expect(await request('GET', `${collection}/${current.id}`), 200),
    );
    assert.deepEqual(read.validation.issues, [
      { path: '/supplierId', code: 'SUPPLIER_ARCHIVED' },
    ]);
    current = detail(expect(await replace(current, complete), 200));
    assert.deepEqual(current.validation.issues, read.validation.issues);
    assert.equal(current.supplierDisplaySnapshot.status, 'ARCHIVED');
    assert.deepEqual(
      expect(await create(incomplete, createKey), 201),
      original,
    );
  });
  await check('list-summary-supplier-filter-and-search', ['S13'], async () => {
    const bySupplier = await list({ supplierId: supplier.id });
    assert.deepEqual(
      bySupplier.items.map((v) => v.id),
      [current.id],
    );
    assert.equal(bySupplier.items[0].lineCount, 1);
    assert.equal(bySupplier.items[0].issueCount, 1);
    assert.equal(bySupplier.items[0].note, complete.note);
    assert.equal(bySupplier.items[0].locationDetail, complete.location.detail);
    assert.deepEqual(
      (
        await list({ search: `  ${supplier.displayName.toUpperCase()}  ` })
      ).items.map((v) => v.id),
      [current.id],
    );
    assert.deepEqual(
      (await list({ search: complete.note })).items.map((v) => v.id),
      [current.id],
    );
    assert.deepEqual(
      (await list({ supplierId: catalog.active.id, search: complete.note }))
        .items,
      [],
    );
    const first = await list({ search: prefix, limit: '1' });
    assert(first.nextCursor);
    expect(
      await request(
        'GET',
        `${collection}?${new URLSearchParams({ search: `${prefix} · otra búsqueda`, cursor: first.nextCursor })}`,
      ),
      400,
      'MALFORMED',
    );
    expect(
      await request(
        'GET',
        `${collection}?${new URLSearchParams({ search: prefix, supplierId: supplier.id, cursor: first.nextCursor })}`,
      ),
      400,
      'MALFORMED',
    );
    const seen = [...first.items];
    let next = first.nextCursor;
    while (next) {
      const page = await list({ search: prefix, limit: '1', cursor: next });
      seen.push(...page.items);
      next = page.nextCursor;
      assert(seen.length <= 2);
    }
    assert.equal(seen.length, 2);
    assert.equal(new Set(seen.map((v) => v.id)).size, 2);
    for (let i = 1; i < seen.length; i++)
      assert(
        seen[i - 1].createdAt > seen[i].createdAt ||
          (seen[i - 1].createdAt === seen[i].createdAt &&
            seen[i - 1].id > seen[i].id),
      );
  });
  await check('reader-reads-and-mutations-denied', ['S11', 'S12'], async () => {
    await list({ search: prefix }, 'reader');
    expect(
      await request('GET', suppliers, { actor: 'reader' }),
      403,
      'FORBIDDEN',
    );
    expect(
      await request('GET', `${collection}/${current.id}`, { actor: 'reader' }),
      200,
    );
    for (const [method, route, body] of [
      ['POST', collection, empty],
      [
        'PUT',
        `${collection}/${current.id}/draft`,
        { expectedVersion: current.version, order: complete },
      ],
      [
        'DELETE',
        `${collection}/${current.id}`,
        { expectedVersion: current.version },
      ],
    ])
      expect(
        await request(method, route, {
          body,
          actor: 'reader',
          idempotencyKey: key(),
        }),
        403,
        'FORBIDDEN',
      );
  });
  for (const [actor, status, error] of [
    ['noaccess', 403, 'FORBIDDEN'],
    ['anonymous', 401, 'UNAUTHORIZED'],
  ])
    await check(`${actor}-denied`, ['S11', 'S12'], async () => {
      expect(await request('GET', collection, { actor }), status, error);
      expect(
        await request('GET', `${collection}/${current.id}`, { actor }),
        status,
        error,
      );
    });
  await check(
    'supplier-restrict-discard-release',
    ['S2', 'S3', 'S12'],
    async () => {
      const removeSupplier = () =>
        request('DELETE', `${suppliers}/${supplier.id}`, {
          body: { expectedVersion: supplier.version },
          idempotencyKey: key(),
        });
      expect(await removeSupplier(), 409, 'SUPPLIER_HAS_PURCHASE_ORDERS');
      const body = { expectedVersion: current.version };
      const discardKey = key();
      expect(
        await request('DELETE', `${collection}/${current.id}`, {
          body,
          idempotencyKey: discardKey,
        }),
        204,
      );
      expect(
        await request('DELETE', `${collection}/${current.id}`, {
          body,
          idempotencyKey: discardKey,
        }),
        204,
      );
      expect(
        await request('GET', `${collection}/${current.id}`),
        404,
        'NOT_FOUND',
      );
      assert.deepEqual((await list({ supplierId: supplier.id })).items, []);
      expect(await removeSupplier(), 204);
      assert.deepEqual(
        expect(await create(incomplete, createKey), 201),
        original,
      );
    },
  );
}
// O3c: confirm/cancel against the real API. Every order and supplier here is created by
// the probe with realistic business names; seeded showcase orders are never touched
// (closed orders cannot be deleted, so this evidence intentionally stays in the runtime).
async function closeScenario(request, check, catalog, origin, users) {
  const expect = (response, status, error) =>
    expectResponse(response, status, error, origin);
  const tag = 'Pedido de cierre de temporada';
  const oldName = 'Forrajes y Granos del Pacífico';
  const newName = 'Agroinsumos Peninsulares del Golfo';
  const collection = '/procurement/purchase-orders';
  const empty = {
    supplierId: null,
    note: null,
    location: { detail: null },
    lines: [],
  };
  const kg = (quantity, amount) => ({
    lineId: key(),
    productId: catalog.kilogramo.id,
    variantId: null,
    orderedQuantity: quantity,
    informedUnitCost:
      amount === null
        ? null
        : {
            amount,
            currency: 'MXN',
            unit: 'KILOGRAMO',
            taxBasis: 'EXCLUDES_TAX',
          },
  });
  const draft = async (note, supplierId, lines) =>
    detail(
      expect(
        await request('POST', collection, {
          body: { ...empty, supplierId, note: `${tag} · ${note}`, lines },
          idempotencyKey: key(),
        }),
        201,
      ),
    );
  const read = async (order, actor = 'manager') =>
    detail(
      expect(await request('GET', `${collection}/${order.id}`, { actor }), 200),
    );
  const confirmBody = (order, changes = {}) => ({
    expectedVersion: order.version,
    expectedSupplierVersion: order.supplierCurrentVersion,
    expectedReferenceToken: order.referenceToken,
    ...changes,
  });
  const confirm = (order, body, actor = 'manager', idempotencyKey = key()) =>
    request('POST', `${collection}/${order.id}/confirm`, {
      body: body ?? confirmBody(order),
      actor,
      idempotencyKey,
    });
  const cancel = (order, body, actor = 'manager', idempotencyKey = key()) =>
    request('POST', `${collection}/${order.id}/cancel`, {
      body: body ?? { expectedVersion: order.version },
      actor,
      idempotencyKey,
    });
  const supplierOf = async (displayName) =>
    expect(
      await request('POST', '/procurement/suppliers', {
        body: { displayName, status: 'ACTIVE', termsText: null },
        idempotencyKey: key(),
      }),
      201,
    );
  const patchSupplier = async (row, changes) =>
    expect(
      await request('PATCH', `/procurement/suppliers/${row.id}`, {
        body: { expectedVersion: row.version, changes },
        idempotencyKey: key(),
      }),
      200,
    );
  const list = async (query) => {
    const page = expect(
      await request('GET', `${collection}?${new URLSearchParams(query)}`),
      200,
    );
    page.items.forEach(summary);
    return page;
  };
  const ids = (page) => page.items.map((item) => item.id).sort();
  const sorted = (...orders) => orders.map((order) => order.id).sort();
  let main, second, ready, pending, readyTwo, noSupplier, archivable;
  await check('closure-setup-and-readiness-fields', ['S2', 'S3'], async () => {
    main = await supplierOf(oldName);
    second = await supplierOf('Suministros Pecuarios de Jalisco');
    ready = await draft('lista para confirmar', main.id, [kg('12.5', '10.25')]);
    readyTwo = await draft('confirmada y vigente', main.id, [kg('2', '20')]);
    pending = await draft('falta capturar el costo', main.id, [kg('3', null)]);
    noSupplier = await draft('sin proveedor asignado', null, []);
    archivable = await draft('proveedor por archivar', second.id, [
      kg('1', '5'),
    ]);
    for (const order of [ready, readyTwo, archivable]) {
      assert.equal(order.status, 'DRAFT');
      assert.equal(order.canConfirm, true);
      assert.equal(typeof order.referenceToken, 'string');
      assert.equal(
        order.supplierCurrentVersion,
        order.id === archivable.id ? second.version : main.version,
      );
      assert.equal(order.confirmedBy, null);
      assert.equal(order.cancelledBy, null);
    }
    assert.equal(pending.canConfirm, false);
    assert(pending.validation.issues.length > 0);
    assert.equal(noSupplier.canConfirm, false);
    assert.equal(noSupplier.referenceToken, null);
    assert.equal(noSupplier.supplierCurrentVersion, null);
  });
  assert(archivable);
  await check('confirm-not-ready-and-check-order', ['S4', 'S8'], async () => {
    expect(
      await confirm(noSupplier, confirmBody(noSupplier)),
      409,
      'ORDER_NOT_READY',
    );
    expect(await confirm(pending), 409, 'ORDER_NOT_READY');
    // First failure wins: version, then supplier version, then eligibility.
    expect(
      await confirm(
        ready,
        confirmBody(ready, {
          expectedVersion: ready.version + 1,
          expectedSupplierVersion: null,
          expectedReferenceToken: null,
        }),
      ),
      409,
      'ORDER_VERSION_CONFLICT',
    );
    for (const expectedSupplierVersion of [
      ready.supplierCurrentVersion + 1,
      null,
    ])
      expect(
        await confirm(ready, confirmBody(ready, { expectedSupplierVersion })),
        409,
        'SUPPLIER_VERSION_CONFLICT',
      );
    for (const expectedReferenceToken of [readyTwo.referenceToken, null])
      expect(
        await confirm(ready, confirmBody(ready, { expectedReferenceToken })),
        409,
        'ELIGIBILITY_CHANGED',
      );
    expect(
      await confirm(ready, { ...confirmBody(ready), reason: 'extra' }),
      400,
      'MALFORMED',
    );
    expect(
      await confirm(ready, { expectedVersion: ready.version }),
      400,
      'MALFORMED',
    );
    assert.deepEqual(await read(ready), ready);
  });
  await check(
    'confirm-cancel-need-own-permission',
    ['S10', 'S12'],
    async () => {
      for (const [actor, operations] of [
        ['editor', ['confirm', 'cancel']],
        ['reader', ['confirm', 'cancel']],
        ['canceller', ['confirm']],
        ['confirmer', ['cancel']],
        ['noaccess', ['confirm', 'cancel']],
      ])
        for (const operation of operations)
          expect(
            await (operation === 'confirm' ? confirm : cancel)(
              ready,
              undefined,
              actor,
            ),
            403,
            'FORBIDDEN',
          );
      for (const call of [confirm, cancel])
        expect(await call(ready, undefined, 'anonymous'), 401, 'UNAUTHORIZED');
      assert.deepEqual(await read(ready), ready);
    },
  );
  let confirmed;
  const confirmKey = key();
  await check(
    'confirm-by-confirm-only-user-and-replay',
    ['S2', 'S4', 'S9'],
    async () => {
      confirmed = detail(
        expect(await confirm(ready, undefined, 'confirmer', confirmKey), 200),
      );
      assert.equal(confirmed.status, 'CONFIRMED');
      assert.equal(confirmed.version, ready.version + 1);
      assert.deepEqual(confirmed.confirmedBy, {
        displayName: users.confirmer.displayName,
      });
      assert.equal(confirmed.canConfirm, false);
      assert.deepEqual(confirmed.lineSubtotals, [
        {
          lineId: ready.lines[0].lineId,
          subtotal: {
            amount: '128.125',
            currency: 'MXN',
            taxBasis: 'EXCLUDES_TAX',
          },
        },
      ]);
      assert.deepEqual(
        expect(await confirm(ready, undefined, 'confirmer', confirmKey), 200),
        confirmed,
      );
      expect(
        await confirm(
          ready,
          confirmBody(ready, { expectedVersion: ready.version + 1 }),
          'confirmer',
          confirmKey,
        ),
        409,
        'IDEMPOTENCY_KEY_CONFLICT',
      );
      assert.deepEqual(await read(ready), confirmed);
      assert.deepEqual(await read(ready, 'reader'), confirmed);
    },
  );
  assert(confirmed);
  await check(
    'closed-order-guards-version-first',
    ['S5', 'S6', 'S8'],
    async () => {
      const put = (version) =>
        request('PUT', `${collection}/${confirmed.id}/draft`, {
          body: {
            expectedVersion: version,
            order: {
              supplierId: confirmed.supplierId,
              note: confirmed.note,
              location: confirmed.location,
              lines: confirmed.lines,
            },
          },
          idempotencyKey: key(),
        });
      const discard = (version) =>
        request('DELETE', `${collection}/${confirmed.id}`, {
          body: { expectedVersion: version },
          idempotencyKey: key(),
        });
      expect(await put(confirmed.version), 409, 'ORDER_STATE_CONFLICT');
      expect(await put(confirmed.version + 1), 409, 'ORDER_VERSION_CONFLICT');
      expect(await discard(confirmed.version), 409, 'ORDER_STATE_CONFLICT');
      expect(
        await discard(confirmed.version + 1),
        409,
        'ORDER_VERSION_CONFLICT',
      );
      expect(
        await confirm(confirmed, confirmBody(confirmed)),
        409,
        'ORDER_STATE_CONFLICT',
      );
      assert.deepEqual(await read(confirmed), confirmed);
    },
  );
  await check('archived-supplier-blocks-confirm', ['S3', 'S4'], async () => {
    const before = archivable;
    const archived = await patchSupplier(second, { status: 'ARCHIVED' });
    archivable = await read(archivable);
    assert.equal(archivable.canConfirm, false);
    assert(
      archivable.validation.issues.some((i) => i.code === 'SUPPLIER_ARCHIVED'),
    );
    assert.equal(archivable.supplierCurrentVersion, archived.version);
    assert.equal(archivable.supplierDisplaySnapshot.status, 'ARCHIVED');
    expect(await confirm(before), 409, 'SUPPLIER_VERSION_CONFLICT');
    expect(await confirm(archivable), 409, 'SUPPLIER_ARCHIVED');
  });
  let cancelledDraft;
  const cancelKey = key();
  await check(
    'cancel-from-draft-by-cancel-only-user',
    ['S5', 'S9'],
    async () => {
      cancelledDraft = detail(
        expect(
          await cancel(archivable, undefined, 'canceller', cancelKey),
          200,
        ),
      );
      assert.equal(cancelledDraft.status, 'CANCELLED');
      assert.equal(cancelledDraft.version, archivable.version + 1);
      assert.equal(cancelledDraft.confirmedBy, null);
      assert.deepEqual(cancelledDraft.cancelledBy, {
        displayName: users.canceller.displayName,
      });
      assert.deepEqual(
        expect(
          await cancel(archivable, undefined, 'canceller', cancelKey),
          200,
        ),
        cancelledDraft,
      );
      expect(
        await cancel(
          archivable,
          { expectedVersion: archivable.version + 1 },
          'canceller',
          cancelKey,
        ),
        409,
        'IDEMPOTENCY_KEY_CONFLICT',
      );
      expect(await cancel(cancelledDraft), 409, 'ORDER_STATE_CONFLICT');
      expect(
        await cancel(cancelledDraft, {
          expectedVersion: cancelledDraft.version + 1,
        }),
        409,
        'ORDER_VERSION_CONFLICT',
      );
      // Cancel takes no reason or any other field.
      expect(
        await cancel(cancelledDraft, {
          expectedVersion: cancelledDraft.version,
          reason: 'x',
        }),
        400,
        'MALFORMED',
      );
      assert.deepEqual(await read(cancelledDraft, 'reader'), cancelledDraft);
    },
  );
  let cancelledConfirmed;
  await check(
    'cancel-from-confirmed-keeps-frozen-data',
    ['S2', 'S5'],
    async () => {
      cancelledConfirmed = detail(expect(await cancel(confirmed), 200));
      assert.equal(cancelledConfirmed.status, 'CANCELLED');
      assert.equal(cancelledConfirmed.version, confirmed.version + 1);
      assert.equal(cancelledConfirmed.confirmedAt, confirmed.confirmedAt);
      assert.deepEqual(cancelledConfirmed.confirmedBy, confirmed.confirmedBy);
      assert.deepEqual(cancelledConfirmed.cancelledBy, {
        displayName: users.manager.displayName,
      });
      assert.deepEqual(
        cancelledConfirmed.lineSubtotals,
        confirmed.lineSubtotals,
      );
      assert.deepEqual(
        cancelledConfirmed.supplierDisplaySnapshot,
        confirmed.supplierDisplaySnapshot,
      );
    },
  );
  assert(cancelledConfirmed && cancelledDraft);
  let stayingConfirmed;
  await check(
    'frozen-names-survive-rename-archive-and-search',
    ['S2', 'S7'],
    async () => {
      stayingConfirmed = detail(expect(await confirm(readyTwo), 200));
      const renamed = await patchSupplier(main, { displayName: newName });
      const archived = await patchSupplier(renamed, { status: 'ARCHIVED' });
      const after = await read(stayingConfirmed);
      assert.deepEqual(after.supplierDisplaySnapshot, {
        id: main.id,
        displayName: oldName,
        status: 'ACTIVE',
      });
      assert.deepEqual(
        after.lineDisplaySnapshots,
        stayingConfirmed.lineDisplaySnapshots,
      );
      assert.deepEqual(after.lineSubtotals, stayingConfirmed.lineSubtotals);
      assert.deepEqual(
        after.locationSnapshot,
        stayingConfirmed.locationSnapshot,
      );
      assert.equal(after.supplierCurrentVersion, archived.version);
      assert.equal(after.canConfirm, false);
      // Closed orders search the frozen name; drafts still search the live one.
      assert.deepEqual(
        ids(await list({ search: oldName.toUpperCase() })).filter((id) =>
          [stayingConfirmed.id, cancelledConfirmed.id, pending.id].includes(id),
        ),
        sorted(stayingConfirmed, cancelledConfirmed),
      );
      const live = await list({ search: newName, status: 'DRAFT' });
      assert.deepEqual(ids(live), [pending.id]);
      assert.deepEqual(
        ids(await list({ search: newName, status: 'CONFIRMED' })),
        [],
      );
    },
  );
  assert(stayingConfirmed);
  await check('status-filter-and-cursor-binding', ['S7', 'S12'], async () => {
    const byStatus = async (status) =>
      ids(await list({ search: tag, ...(status ? { status } : {}) }));
    assert.deepEqual(await byStatus('CONFIRMED'), sorted(stayingConfirmed));
    assert.deepEqual(
      await byStatus('CANCELLED'),
      sorted(cancelledConfirmed, cancelledDraft),
    );
    assert.deepEqual(await byStatus('DRAFT'), sorted(pending, noSupplier));
    assert.deepEqual(
      await byStatus(),
      sorted(
        stayingConfirmed,
        cancelledConfirmed,
        cancelledDraft,
        pending,
        noSupplier,
      ),
    );
    for (const status of ['CONFIRMED', 'CANCELLED'])
      for (const item of (await list({ search: tag, status })).items)
        assert.equal(item.status, status);
    for (const status of ['SENT', 'draft', 'CONFIRMED,DRAFT', ''])
      expect(
        await request(
          'GET',
          `${collection}?${new URLSearchParams({ status })}`,
        ),
        400,
        'MALFORMED',
      );
    expect(
      await request('GET', `${collection}?status=DRAFT&status=CONFIRMED`),
      400,
      'MALFORMED',
    );
    const first = await list({ search: tag, status: 'CANCELLED', limit: '1' });
    assert(first.nextCursor);
    for (const other of [{ status: 'CONFIRMED' }, {}])
      expect(
        await request(
          'GET',
          `${collection}?${new URLSearchParams({ search: tag, limit: '1', cursor: first.nextCursor, ...other })}`,
        ),
        400,
        'MALFORMED',
      );
    const second = await list({
      search: tag,
      status: 'CANCELLED',
      limit: '1',
      cursor: first.nextCursor,
    });
    assert.deepEqual(
      [...ids(first), ...ids(second)].sort(),
      sorted(cancelledConfirmed, cancelledDraft),
    );
    assert.equal(second.nextCursor, null);
  });
  await check('discard-empty-draft-still-allowed', ['S6'], async () => {
    expect(
      await request('DELETE', `${collection}/${noSupplier.id}`, {
        body: { expectedVersion: noSupplier.version },
        idempotencyKey: key(),
      }),
      204,
    );
    expect(
      await request('GET', `${collection}/${noSupplier.id}`),
      404,
      'NOT_FOUND',
    );
  });
}
async function main() {
  const root = path.resolve(__dirname, '../..');
  const run = path.resolve(process.argv[2]);
  assert.equal(path.dirname(run), path.join(root, '.tmp'));
  assert(/^po-runtime\.[A-Za-z0-9]+$/.test(path.basename(run)));
  const privatePath = (file, mode) =>
    validatePrivatePath(
      file,
      fs.realpathSync(file),
      fs.lstatSync(file),
      process.getuid(),
      mode,
    );
  privatePath(run, 0o700);
  for (const name of ['ready.json', 'credentials.json'])
    privatePath(path.join(run, name), 0o600);
  const ready = parseJson(
    fs.readFileSync(path.join(run, 'ready.json'), 'utf8'),
  );
  const credentials = parseJson(
    fs.readFileSync(path.join(run, 'credentials.json'), 'utf8'),
  );
  const { apiOrigin, origin } = validateOrigins(ready, credentials);
  const resultPath = path.join(run, 'probe-result.json');
  // Reserve result BEFORE any login/mutation. Concurrent/repeated execution cannot send a request.
  const fd = fs.openSync(resultPath, 'wx', 0o600);
  const checks = [];
  let statuses = [];
  const tokens = {};
  const check = async (name, specs, work) => {
    statuses = [];
    let pass = true;
    try {
      await work();
    } catch {
      pass = false;
    }
    checks.push({ check: name, specs, pass, statuses: [...statuses] });
    console.log(
      `${pass ? 'PASS' : 'FAIL'} ${name} [${specs.join(',')}] HTTP ${statuses.join(',') || 'none'}`,
    );
  };
  const request = async (
    method,
    route,
    { actor = 'manager', body, idempotencyKey } = {},
  ) => {
    assert(route.startsWith('/') && !route.startsWith('//'));
    const headers = { Origin: origin };
    if (tokens[actor]) headers.Authorization = `Bearer ${tokens[actor]}`;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${apiOrigin}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    statuses.push(response.status);
    const text = await response.text();
    return {
      status: response.status,
      text,
      headers: response.headers,
      body: decodeBody(response.status, text),
    };
  };
  try {
    for (const actor of ACTORS)
      await check(`login-${actor}`, ['S11'], async () => {
        const response = await request('POST', '/auth/login', {
          actor: 'anonymous',
          body: {
            email: credentials.users[actor].email,
            password: credentials.password,
          },
        });
        assert.equal(response.status, 200);
        assert.equal(
          response.headers.get('access-control-allow-origin'),
          origin,
        );
        assert.equal(
          response.headers.get('access-control-allow-credentials'),
          'true',
        );
        assert.equal(typeof response.body.accessToken, 'string');
        assert(response.body.accessToken.length);
        tokens[actor] = response.body.accessToken;
      });
    assert.equal(Object.keys(tokens).length, ACTORS.length);
    await scenario(
      request,
      check,
      credentials.catalog,
      origin,
      credentials.tenantId,
    );
    await closeScenario(
      request,
      check,
      credentials.catalog,
      origin,
      credentials.users,
    );
  } catch {
    checks.push({
      check: 'setup-or-prerequisite',
      specs: ['S2'],
      pass: false,
      statuses: [],
    });
    console.log('FAIL setup-or-prerequisite [S2] HTTP none');
  } finally {
    const pass = checks.length > 0 && checks.every((c) => c.pass);
    try {
      fs.writeFileSync(fd, JSON.stringify({ pass, checks }, null, 2) + '\n');
    } finally {
      fs.closeSync(fd);
    }
    process.exitCode = pass ? 0 : 1;
  }
}
module.exports = {
  validateOrigins,
  expectResponse,
  detail,
  summary,
  scenario,
  closeScenario,
};
if (require.main === module)
  main().catch(() => {
    console.log('FAIL setup-or-result-write [S2] HTTP none');
    process.exitCode = 1;
  });
