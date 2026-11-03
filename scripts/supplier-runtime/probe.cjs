'use strict';

// Parent owns the host and disposable database. Never print caught errors/bodies.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const origin = 'http://127.0.0.1:43179';
const collection = '/procurement/suppliers';
const results = [];
let statuses = [];
let apiOrigin;
let resultPath;
const tokens = {};
const owned = new Set();
const suffix = crypto.randomBytes(10).toString('hex');
const prefix = `RuntimeProbe-${suffix}`;
const key = () => crypto.randomUUID();

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON');
  }
}
function parseUrl(text) {
  try {
    return new URL(text);
  } catch {
    throw new Error('Invalid URL');
  }
}

function decodeBody(status, text) {
  if (status === 204) {
    assert.equal(text, '');
    return undefined;
  }
  return parseJson(text);
}

async function check(name, specs, action) {
  statuses = [];
  try {
    await action();
    results.push({ check: name, specs, pass: true, statuses: [...statuses] });
  } catch {
    results.push({ check: name, specs, pass: false, statuses: [...statuses] });
  }
  const result = results.at(-1);
  console.log(
    `${result.pass ? 'PASS' : 'FAIL'} ${name} [${specs.join(',')}] HTTP ${result.statuses.join(',') || 'none'}`,
  );
}

async function request(
  method,
  route,
  {
    actor = 'manager',
    body,
    raw,
    idempotencyKey,
    getBody = false,
    contentType,
  } = {},
) {
  const headers = { Origin: origin };
  if (tokens[actor]) headers.Authorization = `Bearer ${tokens[actor]}`;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  let payload = raw;
  if (body !== undefined) payload = JSON.stringify(body);
  if (payload !== undefined)
    headers['Content-Type'] =
      contentType ?? (getBody ? 'text/plain' : 'application/json');
  let response;
  if (getBody) {
    // Fetch forbids GET bodies; node:http exercises actual transport admission.
    headers['Content-Length'] = Buffer.byteLength(payload);
    response = await new Promise((resolve, reject) => {
      const req = http.request(
        `${apiOrigin}${route}`,
        { method, headers, timeout: 10000 },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('error', reject);
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              headers: new Headers(res.headers),
              text: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end(payload);
    });
  } else {
    const res = await fetch(`${apiOrigin}${route}`, {
      method,
      headers,
      body: payload,
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    response = {
      status: res.status,
      headers: res.headers,
      text: await res.text(),
    };
  }
  statuses.push(response.status);
  response.body = decodeBody(response.status, response.text);
  return response;
}

function expect(response, status, error) {
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
function supplier(value) {
  assert.deepEqual(
    Object.keys(value).sort(),
    [
      'id',
      'displayName',
      'termsText',
      'status',
      'version',
      'createdAt',
      'updatedAt',
    ].sort(),
  );
  assert.match(
    value.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert(Number.isSafeInteger(value.version) && value.version > 0);
  for (const field of ['createdAt', 'updatedAt'])
    assert.equal(new Date(value[field]).toISOString(), value[field]);
  assert.equal(typeof value.displayName, 'string');
  assert(value.termsText === null || typeof value.termsText === 'string');
  assert(['ACTIVE', 'ARCHIVED'].includes(value.status));
  return value;
}
async function list(query, actor = 'manager') {
  const page = expect(
    await request('GET', `${collection}?${new URLSearchParams(query)}`, {
      actor,
    }),
    200,
  );
  assert.deepEqual(Object.keys(page).sort(), ['items', 'nextCursor']);
  assert(Array.isArray(page.items));
  assert(
    page.nextCursor === null ||
      (typeof page.nextCursor === 'string' && page.nextCursor.length > 0),
  );
  for (const item of page.items) {
    supplier(item);
    // The shared runtime tenant may hold other runs' or FE suppliers; only
    // this run's unique prefix scopes ownership. The foreign tenant never shows.
    assert.notEqual(item.displayName, 'Foreign tenant supplier');
    if (query.search?.trim().toLowerCase().startsWith(prefix.toLowerCase()))
      assert(owned.has(item.id));
  }
  return page;
}
async function patch(
  record,
  changes,
  expectedVersion = record.version,
  idempotencyKey = key(),
) {
  return request('PATCH', `${collection}/${record.id}`, {
    body: { expectedVersion, changes },
    idempotencyKey,
  });
}

async function main() {
  const root = path.resolve(__dirname, '../..');
  const run = fs.realpathSync(process.argv[2]);
  assert.equal(path.dirname(run), path.join(root, '.tmp'));
  assert(path.basename(run).startsWith('supplier-runtime.'));
  assert.equal(fs.statSync(run).mode & 0o777, 0o700);
  resultPath = path.join(run, 'probe-result.json');
  assert(!fs.existsSync(resultPath));
  // These private inputs remain in memory only; never serialize or log them.
  for (const name of ['credentials.json', 'ready.json']) {
    const stat = fs.lstatSync(path.join(run, name));
    assert(stat.isFile() && !stat.isSymbolicLink());
    assert.equal(stat.mode & 0o777, 0o600);
  }
  const credentials = parseJson(
    fs.readFileSync(path.join(run, 'credentials.json'), 'utf8'),
  );
  const ready = parseJson(
    fs.readFileSync(path.join(run, 'ready.json'), 'utf8'),
  );
  const url = parseUrl(ready.apiOrigin);
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1');
  assert(url.port && url.port !== '3000');
  assert.equal(url.origin, ready.apiOrigin);
  assert.equal(credentials.apiOrigin, ready.apiOrigin);
  assert.equal(ready.feOrigin, origin);
  assert.notEqual(credentials.tenantId, credentials.otherTenantId);
  apiOrigin = ready.apiOrigin;

  for (const actor of ['manager', 'reader', 'noaccess']) {
    await check(`login-${actor}`, ['S1', 'S2', 'S4'], async () => {
      const response = await request('POST', '/auth/login', {
        actor: 'anonymous',
        body: {
          email: credentials.users[actor].email,
          password: credentials.password,
        },
      });
      assert.equal(response.status, 200);
      assert.equal(typeof response.body.accessToken, 'string');
      assert(response.body.accessToken.length > 0);
      tokens[actor] = response.body.accessToken;
    });
  }
  // Never send mutations anonymously after a failed login.
  assert(Object.keys(tokens).length === 3);
  await check('initial-run-scope-empty', ['S2', 'S3', 'S4'], async () => {
    const page = await list({ status: 'ALL', search: prefix });
    assert.deepEqual(page, { items: [], nextCursor: null });
  });
  let current;
  let original;
  const createKey = key();
  const updateKey = key();
  let updateBody;
  let updateOriginal;
  const input = {
    displayName: `${prefix}-Alpha`,
    termsText: 'Net 30',
    status: 'ACTIVE',
  };
  await check('manager-create', ['S1', 'S2', 'S3', 'S4'], async () => {
    original = supplier(
      expect(
        await request('POST', collection, {
          body: input,
          idempotencyKey: createKey,
        }),
        201,
      ),
    );
    owned.add(original.id);
    assert.equal(original.version, 1);
    for (const field of Object.keys(input))
      assert.equal(original[field], input[field]);
    current = original;
  });
  assert(current);
  await check('create-original-replay', ['S2', 'S3'], async () => {
    assert.deepEqual(
      expect(
        await request('POST', collection, {
          body: input,
          idempotencyKey: createKey,
        }),
        201,
      ),
      original,
    );
  });
  await check('create-key-conflict', ['S2', 'S3'], async () => {
    expect(
      await request('POST', collection, {
        body: { ...input, displayName: `${prefix}-Changed` },
        idempotencyKey: createKey,
      }),
      409,
      'IDEMPOTENCY_KEY_CONFLICT',
    );
  });
  await check('create-list-fixtures', ['S1', 'S2', 'S3'], async () => {
    for (const [name, status] of [
      ['Beta', 'ACTIVE'],
      ['Gamma', 'ACTIVE'],
      ['Archived', 'ARCHIVED'],
    ]) {
      const item = supplier(
        expect(
          await request('POST', collection, {
            body: { ...input, displayName: `${prefix}-${name}`, status },
            idempotencyKey: key(),
          }),
          201,
        ),
      );
      owned.add(item.id);
    }
  });
  await check(
    'list-status-and-tenant-isolation',
    ['S2', 'S3', 'S4'],
    async () => {
      for (const [status, count] of [
        ['ACTIVE', 3],
        ['ARCHIVED', 1],
        ['ALL', 4],
      ]) {
        const page = await list({ status, search: prefix });
        assert.equal(page.items.length, count);
        assert.equal(page.nextCursor, null);
        if (status !== 'ALL')
          assert(page.items.every((item) => item.status === status));
      }
      assert.equal(
        (await list({ status: 'ALL', search: 'Foreign tenant supplier' })).items
          .length,
        0,
      );
    },
  );
  await check(
    'trimmed-case-insensitive-search',
    ['S2', 'S3', 'S4'],
    async () => {
      const page = await list({
        status: 'ALL',
        search: `  ${prefix.toUpperCase()}-ALPHA  `,
      });
      assert.deepEqual(
        page.items.map((item) => item.id),
        [current.id],
      );
    },
  );
  let cursor;
  await check(
    'limit-cursor-no-duplicates-order',
    ['S2', 'S3', 'S4'],
    async () => {
      const items = [];
      let next;
      do {
        const page = await list({
          status: 'ALL',
          search: prefix,
          limit: '1',
          ...(next ? { cursor: next } : {}),
        });
        assert.equal(page.items.length, 1);
        items.push(...page.items);
        next = page.nextCursor;
        if (items.length === 1) cursor = next;
        assert(items.length <= owned.size);
      } while (next);
      assert.equal(items.length, owned.size);
      assert.equal(new Set(items.map((item) => item.id)).size, owned.size);
      assert.deepEqual(items.map((item) => item.id).sort(), [...owned].sort());
      for (let i = 1; i < items.length; i++) {
        const a = items[i - 1],
          b = items[i];
        assert(
          a.createdAt > b.createdAt ||
            (a.createdAt === b.createdAt && a.id > b.id),
        );
      }
    },
  );
  await check('cursor-search-binding', ['S2', 'S3'], async () => {
    assert(cursor);
    expect(
      await request(
        'GET',
        `${collection}?${new URLSearchParams({ status: 'ALL', search: `${prefix}-different`, cursor })}`,
      ),
      400,
      'MALFORMED',
    );
  });
  await check('manager-detail', ['S2', 'S3'], async () => {
    assert.deepEqual(
      expect(await request('GET', `${collection}/${current.id}`), 200),
      current,
    );
  });
  await check('patch-omission-preserves', ['S1', 'S2', 'S3'], async () => {
    const previous = current;
    updateBody = {
      expectedVersion: current.version,
      changes: { displayName: `${prefix}-Updated` },
    };
    current = supplier(
      expect(
        await request('PATCH', `${collection}/${current.id}`, {
          body: updateBody,
          idempotencyKey: updateKey,
        }),
        200,
      ),
    );
    updateOriginal = current;
    assert.equal(current.version, previous.version + 1);
    assert.equal(current.displayName, `${prefix}-Updated`);
    assert.equal(current.termsText, previous.termsText);
    assert.equal(current.status, previous.status);
    assert.equal(current.id, previous.id);
    assert.equal(current.createdAt, previous.createdAt);
  });
  await check('patch-stale-version', ['S2', 'S3'], async () => {
    expect(
      await patch(current, { termsText: 'stale' }, original.version),
      409,
      'SUPPLIER_VERSION_CONFLICT',
    );
  });
  await check('terms-null-clears', ['S1', 'S2', 'S3'], async () => {
    const previous = current;
    current = supplier(expect(await patch(current, { termsText: null }), 200));
    assert.equal(current.termsText, null);
    assert.equal(current.version, previous.version + 1);
  });
  await check('archive-reactivate', ['S1', 'S2', 'S3'], async () => {
    for (const status of ['ARCHIVED', 'ACTIVE']) {
      const previous = current;
      current = supplier(expect(await patch(current, { status }), 200));
      assert.equal(current.status, status);
      assert.equal(current.version, previous.version + 1);
      assert.equal(current.termsText, null);
      assert.deepEqual(
        expect(await request('GET', `${collection}/${current.id}`), 200),
        current,
      );
      assert(
        (await list({ status, search: prefix })).items.some(
          (item) => item.id === current.id,
        ),
      );
      const opposite = status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE';
      assert(
        !(await list({ status: opposite, search: prefix })).items.some(
          (item) => item.id === current.id,
        ),
      );
    }
  });
  await check('concurrent-patch-CAS', ['S2', 'S3', 'S4'], async () => {
    const previous = current;
    const responses = await Promise.all([
      patch(previous, { termsText: 'race-A' }),
      patch(previous, { termsText: 'race-B' }),
    ]);
    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [200, 409],
    );
    const winnerIndex = responses.findIndex(
      (response) => response.status === 200,
    );
    current = supplier(expect(responses[winnerIndex], 200));
    expect(responses[1 - winnerIndex], 409, 'SUPPLIER_VERSION_CONFLICT');
    assert.equal(current.version, previous.version + 1);
    assert.equal(current.termsText, winnerIndex === 0 ? 'race-A' : 'race-B');
    assert.deepEqual(
      expect(await request('GET', `${collection}/${current.id}`), 200),
      current,
    );
  });
  await check('replay-after-mutations-is-original', ['S2', 'S3'], async () => {
    assert.deepEqual(
      expect(
        await request('POST', collection, {
          body: input,
          idempotencyKey: createKey,
        }),
        201,
      ),
      original,
    );
  });
  await check('reader-list-detail', ['S2', 'S3'], async () => {
    assert.equal(
      (await list({ status: 'ALL', search: prefix }, 'reader')).items.length,
      owned.size,
    );
    assert.deepEqual(
      expect(
        await request('GET', `${collection}/${current.id}`, {
          actor: 'reader',
        }),
        200,
      ),
      current,
    );
  });
  await check('reader-create-denied', ['S2', 'S3'], async () => {
    expect(
      await request('POST', collection, {
        actor: 'reader',
        body: input,
        idempotencyKey: key(),
      }),
      403,
      'FORBIDDEN',
    );
  });
  await check('reader-patch-denied', ['S2', 'S3'], async () => {
    expect(
      await request('PATCH', `${collection}/${current.id}`, {
        actor: 'reader',
        body: {
          expectedVersion: current.version,
          changes: { termsText: 'denied' },
        },
        idempotencyKey: key(),
      }),
      403,
      'FORBIDDEN',
    );
  });
  await check('noaccess-list-denied', ['S2', 'S3'], async () => {
    expect(
      await request('GET', `${collection}?status=ALL`, { actor: 'noaccess' }),
      403,
      'FORBIDDEN',
    );
  });
  await check('anonymous-list-denied', ['S2', 'S3'], async () => {
    expect(
      await request('GET', `${collection}?status=ALL`, { actor: 'anonymous' }),
      401,
      'UNAUTHORIZED',
    );
  });
  await check('random-id-not-found', ['S2', 'S3', 'S4'], async () => {
    expect(
      await request('GET', `${collection}/${crypto.randomUUID()}`),
      404,
      'NOT_FOUND',
    );
  });
  await check('malformed-GET-text-body', ['S3'], async () => {
    expect(
      await request('GET', `${collection}?status=ALL`, {
        raw: 'nonempty',
        getBody: true,
      }),
      400,
      'MALFORMED',
    );
  });
  for (const [name, options] of [
    ['invalid-JSON', { raw: '{' }],
    ['unknown-field', { body: { ...input, unknown: true } }],
    ['blank-displayName', { body: { ...input, displayName: '  \t\n ' } }],
  ])
    await check(`malformed-${name}`, ['S3'], async () => {
      expect(
        await request('POST', collection, {
          ...options,
          idempotencyKey: key(),
        }),
        400,
        'MALFORMED',
      );
    });
  for (const limit of ['0', '101', '1e1'])
    await check(`malformed-limit-${limit}`, ['S3'], async () => {
      expect(
        await request('GET', `${collection}?status=ALL&limit=${limit}`),
        400,
        'MALFORMED',
      );
    });
  await check(
    'final-isolation-and-denials-no-write',
    ['S2', 'S3', 'S4'],
    async () => {
      const page = await list({ status: 'ALL', search: prefix });
      assert.deepEqual(
        page.items.map((item) => item.id).sort(),
        [...owned].sort(),
      );
      assert.deepEqual(
        expect(await request('GET', `${collection}/${current.id}`), 200),
        current,
      );
    },
  );

  await check('case-and-trailing-slash-reads', ['S3', 'S7'], async () => {
    const page = expect(
      await request(
        'GET',
        `/PrOcUrEmEnT/SuPpLiErS/?status=ALL&search=${prefix}`,
      ),
      200,
    );
    assert.deepEqual(
      page.items.map((item) => item.id).sort(),
      [...owned].sort(),
    );
    assert.deepEqual(
      expect(
        await request('GET', `/PROCUREMENT/SUPPLIERS/${current.id}/`),
        200,
      ),
      current,
    );
  });
  const unchanged = async () => {
    assert.deepEqual(
      expect(await request('GET', `${collection}/${current.id}`), 200),
      current,
    );
    const page = await list({ status: 'ALL', search: prefix });
    assert.deepEqual(
      page.items.map((item) => item.id).sort(),
      [...owned].sort(),
    );
  };
  for (const actor of ['reader', 'noaccess'])
    await check(
      `${actor}-delete-denied-no-write`,
      ['S2', 'S6', 'S7'],
      async () => {
        expect(
          await request('DELETE', `${collection}/${current.id}`, {
            actor,
            body: { expectedVersion: current.version },
            idempotencyKey: key(),
          }),
          403,
          'FORBIDDEN',
        );
        await unchanged();
      },
    );
  for (const [name, options] of [
    ['missing-key', { body: { expectedVersion: current.version } }],
    ['missing-version', { body: {}, idempotencyKey: key() }],
    [
      'unknown-field',
      {
        body: { expectedVersion: current.version, unknown: true },
        idempotencyKey: key(),
      },
    ],
    [
      'invalid-version',
      { body: { expectedVersion: '1' }, idempotencyKey: key() },
    ],
    ['invalid-JSON', { raw: '{', idempotencyKey: key() }],
    [
      'invalid-media',
      {
        body: { expectedVersion: current.version },
        contentType: 'text/plain',
        idempotencyKey: key(),
      },
    ],
  ])
    await check(`delete-malformed-${name}-no-write`, ['S3', 'S6'], async () => {
      expect(
        await request(
          'DELETE',
          `/PrOcUrEmEnT/SuPpLiErS/${current.id}/`,
          options,
        ),
        400,
        'MALFORMED',
      );
      await unchanged();
    });
  await check('delete-stale-version-no-write', ['S2', 'S6'], async () => {
    expect(
      await request('DELETE', `${collection}/${current.id}`, {
        body: { expectedVersion: original.version },
        idempotencyKey: key(),
      }),
      409,
      'SUPPLIER_VERSION_CONFLICT',
    );
    await unchanged();
  });
  const deletedId = current.id;
  for (const status of ['ACTIVE', 'ARCHIVED'])
    await check(
      `delete-${status}-replay-and-absence`,
      ['S2', 'S3', 'S5', 'S6', 'S7'],
      async () => {
        const item =
          status === 'ACTIVE'
            ? current
            : (await list({ status: 'ARCHIVED', search: prefix })).items[0];
        assert(item && owned.has(item.id) && item.status === status);
        const route = `/PrOcUrEmEnT/SuPpLiErS/${item.id}/`;
        const deleteKey = key();
        const body = { expectedVersion: item.version };
        expect(
          await request('DELETE', route, { body, idempotencyKey: deleteKey }),
          204,
        );
        owned.delete(item.id);
        if (status === 'ACTIVE') current = undefined;
        expect(
          await request('GET', `${collection}/${item.id}`),
          404,
          'NOT_FOUND',
        );
        const page = await list({ status: 'ALL', search: prefix });
        assert.deepEqual(
          page.items.map((value) => value.id).sort(),
          [...owned].sort(),
        );
        expect(
          await request('DELETE', route, { body, idempotencyKey: key() }),
          404,
          'NOT_FOUND',
        );
        expect(
          await request('DELETE', route, { body, idempotencyKey: deleteKey }),
          204,
        );
        expect(
          await request('DELETE', route, {
            body: { expectedVersion: item.version + 1 },
            idempotencyKey: deleteKey,
          }),
          409,
          'IDEMPOTENCY_KEY_CONFLICT',
        );
      },
    );
  await check(
    'deleted-create-and-update-historical-replay',
    ['S2', 'S6'],
    async () => {
      assert(!owned.has(deletedId));
      assert.deepEqual(
        expect(
          await request('POST', collection, {
            body: input,
            idempotencyKey: createKey,
          }),
          201,
        ),
        original,
      );
      assert.deepEqual(
        expect(
          await request('PATCH', `${collection}/${deletedId}`, {
            body: updateBody,
            idempotencyKey: updateKey,
          }),
          200,
        ),
        updateOriginal,
      );
      expect(
        await request('GET', `${collection}/${deletedId}`),
        404,
        'NOT_FOUND',
      );
      const page = await list({ status: 'ALL', search: prefix });
      assert.deepEqual(
        page.items.map((item) => item.id).sort(),
        [...owned].sort(),
      );
    },
  );
}

module.exports = { decodeBody, expect };
const execution = require.main === module ? main() : null;
execution
  ?.catch(() => {
    results.push({
      check: 'setup-or-prerequisite',
      specs: ['S4'],
      pass: false,
      statuses: [],
    });
    console.log('FAIL setup-or-prerequisite [S4] HTTP none');
  })
  .finally(() => {
    const pass = results.length > 0 && results.every((result) => result.pass);
    try {
      if (!resultPath) throw new Error('no owned result path');
      fs.writeFileSync(
        resultPath,
        JSON.stringify({ pass, checks: results }, null, 2) + '\n',
        { mode: 0o600, flag: 'wx' },
      );
    } catch {
      console.log('FAIL sanitized-result-write [S4] HTTP none');
      process.exitCode = 1;
      return;
    }
    process.exitCode = pass ? 0 : 1;
  });
