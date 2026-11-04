'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  validateOrigins,
  expectResponse,
  detail,
  summary,
  totalsShape,
  expectedTotals,
  scenario,
  closeScenario,
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
// It is NOT an API implementation test or HTTP/PostgreSQL evidence. `bugs` switches on
// deliberate server defects so the tests can prove the probe would notice them.
const PEOPLE = {
  manager: 'María González',
  confirmer: 'Sofía Ramírez',
  canceller: 'Jorge Martínez',
};
const PO_READERS = ['manager', 'editor', 'confirmer', 'canceller', 'reader'];
function decimalProduct(left, right) {
  const scale = (value) => {
    const [whole, fraction = ''] = value.split('.');
    return { digits: BigInt(whole + fraction), places: fraction.length };
  };
  const a = scale(left),
    b = scale(right);
  const digits = (a.digits * b.digits).toString();
  const places = a.places + b.places;
  const padded = digits.padStart(places + 1, '0');
  const whole = padded.slice(0, padded.length - places);
  const fraction = padded.slice(padded.length - places).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}
const unreadable = /sondeo|probe|test|fixture|runtime|POProbe|[0-9a-f]{8}-/i;
function fixture({ poison = false, bugs = [] } = {}) {
  const bug = (name) => bugs.includes(name);
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
  const unitOf = (id) => (id === catalog.kilogramo.id ? 'KILOGRAMO' : 'UNIDAD');
  const issuesOf = (input, supplier) => {
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
      if (line.informedUnitCost === null)
        issues.push({
          path: `/lines/${i}/informedUnitCost/amount`,
          code: 'COST_AMOUNT_REQUIRED',
        });
    }
    if (!input.supplierId)
      issues.push({ path: '/supplierId', code: 'SUPPLIER_REQUIRED' });
    else if (supplier?.status === 'ARCHIVED' && !bug('archived-can-confirm'))
      issues.push({ path: '/supplierId', code: 'SUPPLIER_ARCHIVED' });
    return issues;
  };
  const live = (record) => {
    const { input } = record;
    const supplier = suppliers.get(input.supplierId);
    return {
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
        unit: unitOf(line.productId),
      })),
      lineSubtotals: input.lines.map((line) => ({
        lineId: line.lineId,
        subtotal:
          line.informedUnitCost?.amount && line.orderedQuantity
            ? {
                amount: poison
                  ? '128.12'
                  : decimalProduct(
                      line.orderedQuantity,
                      line.informedUnitCost.amount,
                    ),
                currency: 'MXN',
                taxBasis: line.informedUnitCost.taxBasis,
              }
            : null,
      })),
    };
  };
  // Faithful list totals: exact per basis, EXCLUDES_TAX first, null on zero lines or any
  // null subtotal. The defects each break exactly one rule the probe must notice.
  const totalsOf = (lineSubtotals) => {
    if (!lineSubtotals.length || lineSubtotals.some((v) => v.subtotal === null))
      return null;
    const places = 7;
    const units = (amount) => {
      const [whole, fraction = ''] = amount.split('.');
      return BigInt(whole + fraction.padEnd(places, '0'));
    };
    const render = (sum) => {
      const text = sum.toString().padStart(places + 1, '0');
      return `${text.slice(0, -places)}.${text.slice(-places)}`
        .replace(/0+$/, '')
        .replace(/\.$/, '');
    };
    const sums = new Map();
    for (const { subtotal } of lineSubtotals) {
      const basis = bug('totals-sum-across-bases')
        ? 'EXCLUDES_TAX'
        : subtotal.taxBasis;
      sums.set(basis, (sums.get(basis) ?? 0n) + units(subtotal.amount));
    }
    const order = bug('totals-wrong-order')
      ? ['INCLUDES_TAX', 'EXCLUDES_TAX']
      : ['EXCLUDES_TAX', 'INCLUDES_TAX'];
    return order
      .filter((basis) => sums.has(basis))
      .map((taxBasis) => ({
        amount: bug('totals-float')
          ? String(Number(render(sums.get(taxBasis))) + 1e-16 * 3)
          : render(sums.get(taxBasis)),
        currency: 'MXN',
        taxBasis,
      }));
  };
  const view = (record) => {
    const { input } = record;
    const supplier = suppliers.get(input.supplierId);
    const draft = record.status === 'DRAFT';
    const issues = draft ? issuesOf(input, supplier) : [];
    const referenceToken =
      draft && supplier && input.lines.length ? `prt1.${record.id}` : null;
    const snapshots = record.frozen ?? live(record);
    return {
      ...structuredClone(input),
      id: record.id,
      version: record.version,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...structuredClone(snapshots),
      locationSnapshot: {
        tenantId: 'owned',
        tenantName: 'Owned tenant',
        detail: input.location.detail,
      },
      validation: { issues },
      supplierCurrentVersion: supplier?.version ?? null,
      referenceToken,
      canConfirm:
        draft &&
        !issues.length &&
        referenceToken !== null &&
        (bug('archived-can-confirm') || supplier?.status === 'ACTIVE'),
      confirmedAt: record.confirmedAt,
      confirmedBy: record.confirmedBy,
      cancelledAt: record.cancelledAt,
      cancelledBy: record.cancelledBy,
    };
  };
  const allowed = (actor, method, url) => {
    const [, , second, , action] = url.pathname.split('/');
    if (second !== 'purchase-orders')
      return method === 'GET'
        ? ['manager', 'editor'].includes(actor)
        : actor === 'manager';
    if (action === 'confirm')
      return (
        ['manager', 'confirmer'].includes(actor) ||
        (bug('editor-can-confirm') && actor === 'editor')
      );
    if (action === 'cancel') return ['manager', 'canceller'].includes(actor);
    if (method === 'GET') return PO_READERS.includes(actor);
    return ['manager', 'editor'].includes(actor);
  };
  const request = async (method, route, options = {}) => {
    calls.push({ method, route, actor: options.actor || 'manager' });
    const { body, actor = 'manager', idempotencyKey } = options;
    const url = new URL(route, 'http://offline.invalid');
    const po = url.pathname.startsWith('/procurement/purchase-orders');
    if (actor === 'anonymous') return error(401, 'UNAUTHORIZED');
    if (!allowed(actor, method, url)) return error(403, 'FORBIDDEN');
    const namespace = `${actor}:${method}:${url.pathname}:${idempotencyKey}`;
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
        const current = suppliers.get(id);
        const item = {
          ...current,
          ...body.changes,
          version: current.version + 1,
        };
        suppliers.set(id, item);
        return remember(response(200, item));
      }
      if (method === 'DELETE') {
        if ([...orders.values()].some((v) => v.input.supplierId === id))
          return error(409, 'SUPPLIER_HAS_PURCHASE_ORDERS');
        suppliers.delete(id);
        return remember(response(204));
      }
      throw new Error('Unexpected supplier transport request');
    }
    const [, , , id, action] = url.pathname.split('/');
    if (method === 'GET' && !id) {
      const search = (url.searchParams.get('search') || '').trim();
      const supplierId = url.searchParams.get('supplierId') || '';
      const statuses = url.searchParams.getAll('status');
      if (
        statuses.length > 1 ||
        (statuses.length === 1 &&
          !['DRAFT', 'CONFIRMED', 'CANCELLED'].includes(statuses[0]))
      )
        return error(400, 'MALFORMED');
      const status = bug('ignore-status-filter') ? '' : (statuses[0] ?? '');
      const cursor = url.searchParams.get('cursor');
      const scope = JSON.stringify([search, supplierId, statuses[0] ?? '']);
      let offset = 0;
      if (cursor) {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (decoded.scope !== scope) return error(400, 'MALFORMED');
        offset = decoded.offset;
      }
      const matching = [...orders.values()]
        .map((record) => ({ record, v: view(record) }))
        .filter(
          ({ record, v }) =>
            (!supplierId || v.supplierId === supplierId) &&
            (!status || v.status === status) &&
            (!search ||
              `${v.note} ${
                record.status === 'DRAFT' || bug('live-name-search-on-closed')
                  ? (suppliers.get(v.supplierId)?.displayName ?? '')
                  : (v.supplierDisplaySnapshot?.displayName ?? '')
              }`
                .toLowerCase()
                .includes(search.toLowerCase())),
        )
        .map(({ v }) => v)
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
        totals: totalsOf(v.lineSubtotals),
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
      return saved ? response(200, view(saved)) : error(404, 'NOT_FOUND');
    }
    const record = orders.get(id);
    if (action === 'confirm' || action === 'cancel') {
      if (!record) return error(404, 'NOT_FOUND');
      const keys =
        action === 'confirm'
          ? [
              'expectedReferenceToken',
              'expectedSupplierVersion',
              'expectedVersion',
            ]
          : ['expectedVersion'];
      if (Object.keys(body).sort().join() !== keys.join())
        return error(400, 'MALFORMED');
      if (body.expectedVersion !== record.version)
        return error(409, 'ORDER_VERSION_CONFLICT');
      if (action === 'cancel' && record.status === 'CANCELLED')
        return error(409, 'ORDER_STATE_CONFLICT');
      const stamp = new Date(1700100000000 + sequence++).toISOString();
      if (action === 'cancel') {
        record.frozen ??= {
          ...live(record),
          lineSubtotals: record.input.lines.map((line) => ({
            lineId: line.lineId,
            subtotal: null,
          })),
        };
        Object.assign(record, {
          status: 'CANCELLED',
          version: record.version + 1,
          updatedAt: stamp,
          cancelledAt: stamp,
          cancelledBy: { displayName: PEOPLE[actor] },
        });
        return remember(response(200, view(record)));
      }
      if (record.status !== 'DRAFT') return error(409, 'ORDER_STATE_CONFLICT');
      const supplier = suppliers.get(record.input.supplierId);
      if (!supplier) return error(409, 'ORDER_NOT_READY');
      if (body.expectedSupplierVersion !== supplier.version)
        return error(409, 'SUPPLIER_VERSION_CONFLICT');
      if (supplier.status === 'ARCHIVED')
        return error(409, 'SUPPLIER_ARCHIVED');
      const current = view(record);
      if (current.referenceToken === null) return error(409, 'ORDER_NOT_READY');
      if (body.expectedReferenceToken !== current.referenceToken)
        return error(409, 'ELIGIBILITY_CHANGED');
      if (current.validation.issues.length)
        return error(409, 'ORDER_NOT_READY');
      Object.assign(record, {
        status: 'CONFIRMED',
        version: record.version + 1,
        updatedAt: stamp,
        confirmedAt: stamp,
        confirmedBy: { displayName: PEOPLE[actor] },
        frozen: bug('no-freeze') ? null : live(record),
      });
      return remember(response(200, view(record)));
    }
    if (method === 'DELETE' || method === 'PUT') {
      if (!record) return error(404, 'NOT_FOUND');
      if (body.expectedVersion !== record.version)
        return error(409, 'ORDER_VERSION_CONFLICT');
      if (record.status !== 'DRAFT') return error(409, 'ORDER_STATE_CONFLICT');
      if (method === 'DELETE') {
        orders.delete(id);
        return remember(response(204));
      }
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
    const stamp = new Date(1700000000000 + sequence++).toISOString();
    const saved = record ?? {
      id: randomUUID(),
      version: 0,
      createdAt: stamp,
      status: 'DRAFT',
      frozen: null,
      confirmedAt: null,
      confirmedBy: null,
      cancelledAt: null,
      cancelledBy: null,
    };
    Object.assign(saved, {
      input,
      version: saved.version + 1,
      updatedAt: stamp,
    });
    orders.set(saved.id, saved);
    return remember(response(method === 'POST' ? 201 : 200, view(saved)));
  };
  return { catalog, request, calls, suppliers, orders };
}
const users = Object.fromEntries(
  ['manager', 'editor', 'confirmer', 'canceller', 'reader', 'noaccess'].map(
    (label) => [label, { displayName: PEOPLE[label] ?? label }],
  ),
);
const run = async (work, f, collect) =>
  work(
    f.request,
    async (name, specs, action) => {
      assert(specs.every((s) => /^S\d+$/.test(s)));
      await collect(name, action);
    },
    f.catalog,
    origin,
    work === scenario ? 'owned' : users,
  );
const passing = (names) => async (name, action) => {
  names.push(name);
  await action();
};
const failing = (failed) => async (name, action) => {
  try {
    await action();
  } catch {
    failed.push(name);
  }
};
test('full probe scenario executes against only an injected offline transport, including reader PO-only policy', async () => {
  const f = fixture();
  const names = [];
  await run(scenario, f, passing(names));
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
  const f = fixture({ poison: true }),
    failed = [];
  await run(scenario, f, failing(failed));
  assert(failed.includes('replace-CAS-and-exact-subtotal-detail'));
});
test('O3c close scenario passes against a faithful transport and keeps its data readable', async () => {
  const f = fixture();
  const names = [];
  await run(scenario, f, passing([]));
  await run(closeScenario, f, passing(names));
  assert.deepEqual(names, [
    'closure-setup-and-readiness-fields',
    'confirm-not-ready-and-check-order',
    'confirm-cancel-need-own-permission',
    'confirm-by-confirm-only-user-and-replay',
    'closed-order-guards-version-first',
    'archived-supplier-blocks-confirm',
    'cancel-from-draft-by-cancel-only-user',
    'cancel-from-confirmed-keeps-frozen-data',
    'frozen-names-survive-rename-archive-and-search',
    'status-filter-and-cursor-binding',
    'list-totals-per-tax-basis',
    'discard-empty-draft-still-allowed',
  ]);
  // Human rule: probe data lives in the FE's database too, so it reads like a business.
  for (const supplier of f.suppliers.values())
    assert(!unreadable.test(supplier.displayName), supplier.displayName);
  for (const { input } of f.orders.values())
    if (input.note) assert(!unreadable.test(input.note), input.note);
  const actors = new Set(f.calls.map((c) => c.actor));
  for (const actor of [
    'editor',
    'confirmer',
    'canceller',
    'reader',
    'noaccess',
  ])
    assert(actors.has(actor));
  const by = (operation, actor) =>
    f.calls.some(
      (c) =>
        c.actor === actor &&
        c.method === 'POST' &&
        c.route.endsWith(`/${operation}`),
    );
  assert(by('confirm', 'confirmer') && by('cancel', 'canceller'));
  const states = [...f.orders.values()].map((o) => o.status).sort();
  assert.deepEqual(states.slice(0, 1), ['CANCELLED']);
  assert.equal(states.filter((s) => s === 'CONFIRMED').length, 1);
  assert.equal(states.filter((s) => s === 'CANCELLED').length, 2);
});
test('close scenario never reads or mutates orders it did not create', async () => {
  const f = fixture();
  const seeded = f.request('POST', '/procurement/purchase-orders', {
    body: {
      supplierId: null,
      note: 'Reposición mensual de croquetas y collares',
      location: { detail: null },
      lines: [],
    },
    idempotencyKey: randomUUID(),
  });
  const showcase = (await seeded).body;
  await run(closeScenario, f, passing([]));
  const touched = f.calls.filter((c) => c.route.includes(showcase.id));
  assert.equal(touched.length, 0);
  assert.equal(f.orders.get(showcase.id).version, 1);
});
test('probe notices each deliberate server defect in the O3c contract', async () => {
  for (const [bug, expected] of [
    ['editor-can-confirm', 'confirm-cancel-need-own-permission'],
    ['archived-can-confirm', 'archived-supplier-blocks-confirm'],
    ['no-freeze', 'frozen-names-survive-rename-archive-and-search'],
    ['ignore-status-filter', 'status-filter-and-cursor-binding'],
    [
      'live-name-search-on-closed',
      'frozen-names-survive-rename-archive-and-search',
    ],
    ['totals-sum-across-bases', 'list-totals-per-tax-basis'],
    ['totals-wrong-order', 'list-totals-per-tax-basis'],
    ['totals-float', 'list-totals-per-tax-basis'],
  ]) {
    const f = fixture({ bugs: [bug] }),
      failed = [];
    // A defect may also break a later prerequisite assert; the check still failed first.
    await run(closeScenario, f, failing(failed)).catch(() => {});
    assert(failed.includes(expected), `${bug} -> ${failed.join()}`);
  }
});
test('detail() accepts every status shape and rejects inconsistent closed or ready ones', () => {
  const draft = {
    id: 'o',
    version: 1,
    status: 'DRAFT',
    createdAt: 'a',
    updatedAt: 'a',
    supplierId: 's',
    note: null,
    location: { detail: null },
    lines: [],
    supplierDisplaySnapshot: {
      id: 's',
      displayName: 'Norte',
      status: 'ACTIVE',
    },
    lineDisplaySnapshots: [],
    lineSubtotals: [],
    locationSnapshot: { tenantId: 't', tenantName: 'n', detail: null },
    validation: { issues: [] },
    supplierCurrentVersion: 2,
    referenceToken: 'prt1.abc',
    canConfirm: true,
    confirmedAt: null,
    confirmedBy: null,
    cancelledAt: null,
    cancelledBy: null,
  };
  assert.equal(detail(draft), draft);
  const stamp = '2026-11-03T10:00:00.000Z';
  const confirmed = {
    ...draft,
    status: 'CONFIRMED',
    canConfirm: false,
    referenceToken: null,
    confirmedAt: stamp,
    confirmedBy: { displayName: 'María González' },
  };
  assert.equal(detail(confirmed), confirmed);
  assert(
    detail({
      ...confirmed,
      status: 'CANCELLED',
      cancelledAt: stamp,
      cancelledBy: { displayName: 'Jorge Martínez' },
    }),
  );
  for (const changes of [
    { canConfirm: false, status: 'BORRADOR' },
    {
      canConfirm: true,
      supplierDisplaySnapshot: {
        ...draft.supplierDisplaySnapshot,
        status: 'ARCHIVED',
      },
    },
    { canConfirm: true, referenceToken: null },
    { canConfirm: true, supplierCurrentVersion: null },
    {
      canConfirm: true,
      validation: { issues: [{ path: '/lines', code: 'LINES_REQUIRED' }] },
    },
    { confirmedAt: stamp },
    { confirmedBy: { displayName: 'María González' } },
    { confirmedAt: 'ayer', confirmedBy: { displayName: 'María González' } },
    { cancelledAt: stamp, cancelledBy: { displayName: 'Jorge', id: 'u-1' } },
    { actorId: 'user-id' },
    { referenceToken: '' },
    { canConfirm: 'yes' },
  ])
    assert.throws(
      () => detail({ ...draft, ...changes }),
      JSON.stringify(changes),
    );
  assert.throws(() => detail({ ...confirmed, canConfirm: true }));
  assert.throws(() => detail({ ...confirmed, status: 'CANCELLED' }));
  assert.throws(() =>
    detail({
      ...confirmed,
      validation: { issues: [{ path: '/x', code: 'X' }] },
    }),
  );
  const { cancelledBy, ...missing } = draft;
  assert(cancelledBy === null);
  assert.throws(() => detail(missing));
});
test('summary accepts all three statuses and nothing else', () => {
  const item = (status) => ({
    id: 'o',
    version: 1,
    status,
    supplierDisplaySnapshot: null,
    lineCount: 0,
    issueCount: 0,
    totals: null,
    note: null,
    locationDetail: null,
    createdAt: 'a',
    updatedAt: 'a',
  });
  for (const status of ['DRAFT', 'CONFIRMED', 'CANCELLED'])
    assert.doesNotThrow(() => summary(item(status)));
  assert.throws(() => summary(item('SENT')));
  assert.throws(() => summary({ ...item('DRAFT'), counts: {} }));
  const { totals, ...withoutTotals } = item('DRAFT');
  assert(totals === null);
  assert.throws(() => summary(withoutTotals));
});
const total = (amount, taxBasis, currency = 'MXN') => ({
  amount,
  currency,
  taxBasis,
});
test('totals shape accepts null, one basis or both in order, and rejects anything else', () => {
  assert.doesNotThrow(() => totalsShape(null));
  assert.doesNotThrow(() => totalsShape([total('0.3', 'INCLUDES_TAX')]));
  assert.doesNotThrow(() =>
    totalsShape([total('12.5', 'EXCLUDES_TAX'), total('116', 'INCLUDES_TAX')]),
  );
  for (const bad of [
    undefined,
    [],
    [total('1', 'INCLUDES_TAX'), total('2', 'EXCLUDES_TAX')],
    [total('1', 'EXCLUDES_TAX'), total('2', 'EXCLUDES_TAX')],
    [total('1', 'EXCLUDES_TAX'), total('2', 'INCLUDES_TAX'), total('3', 'X')],
    [total('1.0', 'EXCLUDES_TAX')],
    [total('1.50', 'EXCLUDES_TAX')],
    [total('01', 'EXCLUDES_TAX')],
    [total('1e3', 'EXCLUDES_TAX')],
    [total('-1', 'EXCLUDES_TAX')],
    [total('1', 'EXCLUDES_TAX', 'USD')],
    [{ ...total('1', 'EXCLUDES_TAX'), tax: '0' }],
    [{ amount: '1', currency: 'MXN', taxBasis: 'MIXED' }],
  ])
    assert.throws(() => totalsShape(bad), JSON.stringify(bad));
});
test('expectedTotals sums exactly per basis and is null for zero or missing subtotals', () => {
  const sub = (amount, taxBasis) => ({
    lineId: randomUUID(),
    subtotal: total(amount, taxBasis),
  });
  assert.equal(expectedTotals([]), null);
  assert.equal(
    expectedTotals([sub('1', 'EXCLUDES_TAX'), { lineId: 'x', subtotal: null }]),
    null,
  );
  assert.deepEqual(
    expectedTotals([sub('0.1', 'EXCLUDES_TAX'), sub('0.2', 'EXCLUDES_TAX')]),
    [total('0.3', 'EXCLUDES_TAX')],
  );
  assert.deepEqual(
    expectedTotals([
      sub('116', 'INCLUDES_TAX'),
      sub('10', 'EXCLUDES_TAX'),
      sub('2.5', 'EXCLUDES_TAX'),
      sub('0.25', 'INCLUDES_TAX'),
      sub('0.75', 'INCLUDES_TAX'),
    ]),
    [total('12.5', 'EXCLUDES_TAX'), total('117', 'INCLUDES_TAX')],
  );
});
