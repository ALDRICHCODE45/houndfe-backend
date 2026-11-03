'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  validateOrigins,
  expectResponse,
  detail,
  summary,
  scenario,
} = require('./probe.cjs');
const origin = 'http://127.0.0.1:43179';
const headers = () =>
  new Headers({
    'cache-control': 'no-store',
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
  });
test('origin guard forbids normal API3000, nonloopback, paths, credentials and mismatched private inputs', () => {
  const ready = { apiOrigin: 'http://127.0.0.1:45581', feOrigin: origin };
  const credentials = {
    apiOrigin: ready.apiOrigin,
    tenantId: 'owned',
    otherTenantId: 'other',
  };
  assert.deepEqual(validateOrigins(ready, credentials), {
    apiOrigin: ready.apiOrigin,
    origin,
  });
  for (const apiOrigin of [
    'http://127.0.0.1:3000',
    'http://localhost:45581',
    'https://127.0.0.1:45581',
    'http://127.0.0.1:45581/path',
    'http://u:p@127.0.0.1:45581',
    'invalid',
  ])
    assert.throws(() =>
      validateOrigins({ ...ready, apiOrigin }, { ...credentials, apiOrigin }),
    );
  assert.throws(() =>
    validateOrigins(ready, {
      ...credentials,
      apiOrigin: 'http://127.0.0.1:45582',
    }),
  );
  assert.throws(() =>
    validateOrigins(ready, { ...credentials, otherTenantId: 'owned' }),
  );
});
test('every feature response requires no-store/CORS and an exact closed error or zero-byte 204', () => {
  const response = {
    status: 409,
    text: '{}',
    headers: headers(),
    body: { statusCode: 409, error: 'SUPPLIER_ARCHIVED' },
  };
  assert.equal(
    expectResponse(response, 409, 'SUPPLIER_ARCHIVED', origin),
    response.body,
  );
  assert.throws(() =>
    expectResponse(
      { ...response, body: { ...response.body, message: 'driver' } },
      409,
      'SUPPLIER_ARCHIVED',
      origin,
    ),
  );
  for (const header of [
    'cache-control',
    'access-control-allow-origin',
    'access-control-allow-credentials',
  ]) {
    const changed = headers();
    changed.delete(header);
    assert.throws(() =>
      expectResponse(
        { ...response, headers: changed },
        409,
        'SUPPLIER_ARCHIVED',
        origin,
      ),
    );
  }
  assert.equal(
    expectResponse(
      { status: 204, text: '', headers: headers() },
      204,
      undefined,
      origin,
    ),
    undefined,
  );
  assert.throws(() =>
    expectResponse(
      { status: 204, text: 'null', headers: headers() },
      204,
      undefined,
      origin,
    ),
  );
  assert.throws(() => detail({ actorId: 'not-wire' }));
  assert.throws(() => summary({ total: 1 }));
});
// A deterministic in-memory transport validates probe sequencing/assertions only.
// It is NOT an API implementation test or HTTP/PostgreSQL evidence.
function fixture(poison = false) {
  const catalog = Object.fromEntries(
    ['kilogramo', 'unidad', 'caja', 'noStock', 'service', 'foreign'].map(
      (name) => [name, { id: randomUUID(), name }],
    ),
  );
  catalog.active = { id: randomUUID() };
  catalog.archived = { id: randomUUID() };
  const suppliers = new Map(),
    orders = new Map(),
    receipts = new Map(),
    calls = [];
  let sequence = 0;
  const response = (status, body) => ({
    status,
    body: structuredClone(body),
    text: status === 204 ? '' : JSON.stringify(body),
    headers: headers(),
  });
  const error = (status, code) =>
    response(status, { statusCode: status, error: code });
  const build = (input, id, version, createdAt) => {
    const supplier = suppliers.get(input.supplierId);
    const issues = [];
    if (!input.lines.length)
      issues.push({ path: '/lines', code: 'LINES_REQUIRED' });
    for (const [i, line] of input.lines.entries()) {
      if (line.productId === catalog.caja.id && line.variantId === null)
        issues.push({
          path: `/lines/${i}/variantId`,
          code: 'VARIANT_REQUIRED',
        });
      if (line.orderedQuantity === null)
        issues.push({
          path: `/lines/${i}/orderedQuantity`,
          code: 'QUANTITY_REQUIRED',
        });
    }
    if (!input.supplierId)
      issues.push({ path: '/supplierId', code: 'SUPPLIER_REQUIRED' });
    else if (supplier?.status === 'ARCHIVED')
      issues.push({ path: '/supplierId', code: 'SUPPLIER_ARCHIVED' });
    return {
      ...input,
      id,
      version,
      status: 'DRAFT',
      createdAt,
      updatedAt: createdAt,
      supplierDisplaySnapshot: supplier
        ? {
            id: supplier.id,
            displayName: supplier.displayName,
            status: supplier.status,
          }
        : null,
      lineDisplaySnapshots: input.lines.map((line) => ({
        lineId: line.lineId,
        productName: Object.values(catalog).find((v) => v.id === line.productId)
          ?.name,
        variantName: null,
        unit: line.productId === catalog.kilogramo.id ? 'KILOGRAMO' : 'UNIDAD',
      })),
      lineSubtotals: input.lines.map((line) => ({
        lineId: line.lineId,
        subtotal: line.informedUnitCost
          ? {
              amount: poison ? '128.12' : '128.125',
              currency: 'MXN',
              taxBasis: 'EXCLUDES_TAX',
            }
          : null,
      })),
      locationSnapshot: {
        tenantId: 'owned',
        tenantName: 'Owned tenant',
        detail: input.location.detail,
      },
      validation: { issues },
    };
  };
  const request = async (method, route, options = {}) => {
    calls.push({ method, route, actor: options.actor || 'manager' });
    const { body, actor = 'manager', idempotencyKey } = options;
    const url = new URL(route, 'http://offline.invalid');
    const po = url.pathname.startsWith('/procurement/purchase-orders');
    if (actor === 'anonymous') return error(401, 'UNAUTHORIZED');
    if (
      actor === 'noaccess' ||
      (actor === 'reader' && (method !== 'GET' || !po))
    )
      return error(403, 'FORBIDDEN');
    const namespace = `${method}:${url.pathname}:${idempotencyKey}`;
    const prior = receipts.get(namespace);
    if (idempotencyKey && prior)
      return prior.hash === JSON.stringify(body)
        ? prior.response
        : error(409, 'IDEMPOTENCY_KEY_CONFLICT');
    const remember = (value) => {
      if (idempotencyKey && value.status < 300)
        receipts.set(namespace, {
          hash: JSON.stringify(body),
          response: {
            ...value,
            body: structuredClone(value.body),
            headers: new Headers(value.headers),
          },
        });
      return value;
    };
    if (!po) {
      const id = url.pathname.split('/')[3];
      if (method === 'POST') {
        const item = { ...body, id: randomUUID(), version: 1 };
        suppliers.set(item.id, item);
        return remember(response(201, item));
      }
      if (method === 'PATCH') {
        const item = { ...suppliers.get(id), ...body.changes, version: 2 };
        suppliers.set(id, item);
        return remember(response(200, item));
      }
      if (method === 'DELETE') {
        if ([...orders.values()].some((v) => v.supplierId === id))
          return error(409, 'SUPPLIER_HAS_PURCHASE_ORDERS');
        suppliers.delete(id);
        return remember(response(204));
      }
      throw new Error('Unexpected supplier transport request');
    }
    const id = url.pathname.split('/')[3];
    if (method === 'GET' && !id) {
      const search = url.searchParams.get('search') || '',
        supplierId = url.searchParams.get('supplierId') || '';
      const cursor = url.searchParams.get('cursor');
      const scope = JSON.stringify([search, supplierId]);
      let offset = 0;
      if (cursor) {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (decoded.scope !== scope) return error(400, 'MALFORMED');
        offset = decoded.offset;
      }
      const matching = [...orders.values()]
        .map((v) => build(v, v.id, v.version, v.createdAt))
        .filter(
          (v) =>
            (!supplierId || v.supplierId === supplierId) &&
            (!search ||
              `${v.note} ${v.supplierDisplaySnapshot?.displayName || ''}`
                .toLowerCase()
                .includes(search.trim().toLowerCase())),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const limit = Number(url.searchParams.get('limit') || 25);
      const page = matching.slice(offset, offset + limit);
      const items = page.map((v) => ({
        id: v.id,
        version: v.version,
        status: v.status,
        supplierDisplaySnapshot: v.supplierDisplaySnapshot,
        lineCount: v.lines.length,
        issueCount: v.validation.issues.length,
        note: v.note,
        locationDetail: v.location.detail,
        createdAt: v.createdAt,
        updatedAt: v.updatedAt,
      }));
      return response(200, {
        items,
        nextCursor:
          offset + limit < matching.length
            ? Buffer.from(
                JSON.stringify({ scope, offset: offset + limit }),
              ).toString('base64url')
            : null,
      });
    }
    if (method === 'GET') {
      const saved = orders.get(id);
      return saved
        ? response(200, build(saved, saved.id, saved.version, saved.createdAt))
        : error(404, 'NOT_FOUND');
    }
    if (method === 'DELETE') {
      orders.delete(id);
      return remember(response(204));
    }
    const input = method === 'PUT' ? body.order : body;
    if (input.supplierId === catalog.archived.id)
      return error(409, 'SUPPLIER_ARCHIVED');
    for (const line of input.lines) {
      if (
        line.productId === catalog.service.id ||
        line.informedUnitCost?.currency === 'USD' ||
        (line.productId === catalog.unidad.id &&
          line.orderedQuantity.includes('.'))
      )
        return error(400, 'MALFORMED');
      if (
        !Object.values(catalog).some((v) => v.id === line.productId) ||
        line.productId === catalog.foreign.id
      )
        return error(404, 'NOT_FOUND');
    }
    const previous = orders.get(id);
    if (method === 'PUT' && body.expectedVersion !== previous.version)
      return error(409, 'ORDER_VERSION_CONFLICT');
    const saved = build(
      input,
      id || randomUUID(),
      previous ? previous.version + 1 : 1,
      previous?.createdAt || new Date(1700000000000 + sequence++).toISOString(),
    );
    orders.set(saved.id, saved);
    return remember(response(method === 'POST' ? 201 : 200, saved));
  };
  return { catalog, request, calls };
}
test('full probe scenario executes against only an injected offline transport, including reader PO-only policy', async () => {
  const f = fixture();
  const names = [];
  await scenario(
    f.request,
    async (name, specs, action) => {
      names.push(name);
      assert(specs.every((s) => /^S\d+$/.test(s)));
      await action();
    },
    f.catalog,
    origin,
    'owned',
  );
  assert.equal(names.length, 17);
  assert(
    f.calls.some(
      (c) => c.actor === 'reader' && c.route === '/procurement/suppliers',
    ),
  );
  assert(
    f.calls.some(
      (c) =>
        c.method === 'DELETE' &&
        c.route.startsWith('/procurement/purchase-orders/'),
    ),
  );
});
test('probe reports exact-decimal assertion failure rather than silently accepting rounding', async () => {
  const f = fixture(true),
    failed = [];
  await scenario(
    f.request,
    async (name, _specs, action) => {
      try {
        await action();
      } catch {
        failed.push(name);
      }
    },
    f.catalog,
    origin,
    'owned',
  );
  assert(failed.includes('replace-CAS-and-exact-subtotal-detail'));
});
