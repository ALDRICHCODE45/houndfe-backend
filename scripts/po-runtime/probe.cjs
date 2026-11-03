'use strict';
// Parent-only HTTP evidence. Never prints bodies/errors, tokens, names, IDs or URLs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { validatePrivatePath } = require('../supplier-runtime/host.cjs');
const { decodeBody } = require('../supplier-runtime/probe.cjs');
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
    ].sort(),
  );
  assert.equal(value.status, 'DRAFT');
  assert(Number.isSafeInteger(value.version) && value.version > 0);
  assert.deepEqual(Object.keys(value.validation), ['issues']);
  for (const issue of value.validation.issues) {
    assert.deepEqual(Object.keys(issue).sort(), ['code', 'path']);
    assert(issue.path.startsWith('/'));
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
  assert.equal(value.status, 'DRAFT');
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
  const prefix = `POProbe-${crypto.randomBytes(10).toString('hex')}`;
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
  const incomplete = { ...empty, note: `${prefix}-incomplete` };
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
      await create({ ...incomplete, note: `${prefix}-conflict` }, createKey),
      409,
      'IDEMPOTENCY_KEY_CONFLICT',
    );
  });
  let supplier;
  await check('owned-supplier-create', ['S2', 'S10'], async () => {
    supplier = expect(
      await request('POST', suppliers, {
        body: {
          displayName: `${prefix}-supplier`,
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
    note: `${prefix}-exact`,
    location: { detail: 'Owned delivery' },
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
        note: `${prefix}-pending`,
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
        `${collection}?${new URLSearchParams({ search: `${prefix}-changed`, cursor: first.nextCursor })}`,
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
    for (const actor of ['manager', 'reader', 'noaccess'])
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
    assert.equal(Object.keys(tokens).length, 3);
    await scenario(
      request,
      check,
      credentials.catalog,
      origin,
      credentials.tenantId,
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
module.exports = { validateOrigins, expectResponse, detail, summary, scenario };
if (require.main === module)
  main().catch(() => {
    console.log('FAIL setup-or-result-write [S2] HTTP none');
    process.exitCode = 1;
  });
