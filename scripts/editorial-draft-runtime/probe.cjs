// Actual public HTTP only; no response substitution or direct state-table assertions.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
async function main() {
  const run = fs.realpathSync(process.argv[2]);
  assert.equal(path.dirname(run), path.resolve(__dirname, '../../.tmp'));
  assert(path.basename(run).startsWith('draft-runtime.'));
  const fixture = JSON.parse(
    fs.readFileSync(path.join(run, 'http-credentials.json'), 'utf8'),
  );
  const other = JSON.parse(
    fs.readFileSync(path.join(run, 'browser-credentials.json'), 'utf8'),
  );
  const origin = new URL(fixture.apiOrigin);
  assert.equal(origin.hostname, '127.0.0.1');
  assert.equal(origin.protocol, 'http:');
  assert(origin.port && origin.port !== '3000');
  const base = `/products/${fixture.productId}/editorial`;
  let token;
  let revision;
  const observations = [];
  async function call(method, route, body, status, extra = {}) {
    const headers = { 'Content-Type': 'application/json', ...extra };
    if (token && !Object.hasOwn(headers, 'Authorization'))
      headers.Authorization = `Bearer ${token}`;
    const response = await fetch(fixture.apiOrigin + route, {
      method,
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    observations.push({ method, route, status: response.status });
    fs.writeFileSync(
      path.join(run, 'http-requests.json'),
      JSON.stringify(observations),
      { mode: 0o600 },
    );
    assert.equal(response.status, status, `${method} ${route}`);
    if (route.includes('editorial'))
      assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json();
    if (result.vocabularyRevision) {
      assert.equal(response.headers.get('editorial-contract-version'), '2');
      assert.equal(
        response.headers.get('editorial-vocabulary-revision'),
        result.vocabularyRevision,
      );
      if (revision) assert.equal(result.vocabularyRevision, revision);
    }
    return result;
  }
  assert.deepEqual(await call('GET', base, undefined, 401), {
    statusCode: 401,
    error: 'UNAUTHORIZED',
  });
  const credentials = { email: fixture.email, password: fixture.password };
  const login = () => call('POST', '/auth/login', credentials, 200);
  const session = await login();
  assert.equal(session.requiresTenantSelection, false);
  assert.equal(typeof session.accessToken, 'string');
  token = session.accessToken;
  await call('GET', '/auth/me', undefined, 200);
  await call('GET', '/auth/me/permissions', undefined, 200);
  const vocabulary = await call(
    'GET',
    '/catalog-editorial/vocabulary',
    undefined,
    200,
  );
  revision = vocabulary.vocabularyRevision;
  assert.match(revision, /^ev2-sha256-[a-f0-9]{64}$/);
  const pin = { 'Editorial-Vocabulary-Revision': revision };
  const context = await call('GET', base + '/context', undefined, 200);
  assert.deepEqual(Object.keys(context), ['variants']);
  assert.equal(context.variants.length, 1);
  const empty = await call('GET', base, undefined, 200, pin);
  assert.deepEqual(empty.state, { cycle: null, draft: null, published: null });
  const createHeaders = { ...pin, 'Idempotency-Key': 'runtime-initialize' };
  const initialize = () =>
    call(
      'POST',
      base + '/draft/initialize',
      { expectedCycle: null },
      201,
      createHeaders,
    );
  const initial = await initialize();
  assert.equal(initial.state.cycle, 1);
  assert.equal(initial.state.draft.revision, 1);
  assert.deepEqual(await initialize(), initial);
  const document = {
    ...initial.state.draft.document,
    commercialTitle: 'Persisted runtime title',
    description: 'Persisted runtime description',
  };
  const body = { expectedCycle: 1, expectedRevision: 1, document };
  const saveHeaders = { ...pin, 'Idempotency-Key': 'runtime-save' };
  const saved = await call('PUT', base + '/draft', body, 200, saveHeaders);
  assert.equal(saved.state.draft.revision, 2);
  assert.deepEqual(saved.state.draft.document, document);
  assert.equal(saved.state.published, null);
  assert.deepEqual(
    await call('PUT', base + '/draft', body, 200, saveHeaders),
    saved,
  );
  for (const [method, route, request, status, error, headers] of [
    [
      'GET',
      base,
      undefined,
      401,
      'UNAUTHORIZED',
      { ...pin, Authorization: 'Bearer invalid' },
    ],
    [
      'GET',
      `/products/${other.productId}/editorial`,
      undefined,
      403,
      'FORBIDDEN',
      pin,
    ],
    [
      'GET',
      base,
      undefined,
      409,
      'VOCABULARY_CHANGED',
      { 'Editorial-Vocabulary-Revision': 'ev2-sha256-' + '0'.repeat(64) },
    ],
    [
      'PUT',
      base + '/draft',
      body,
      409,
      'CONFLICT',
      { ...pin, 'Idempotency-Key': 'runtime-stale' },
    ],
  ]) {
    assert.deepEqual(await call(method, route, request, status, headers), {
      statusCode: status,
      error,
    });
    assert.deepEqual(await call('GET', base, undefined, 200, pin), saved);
  }
  token = (await login()).accessToken;
  assert.deepEqual(await call('GET', base, undefined, 200, pin), saved);
  fs.writeFileSync(
    path.join(run, 'http-proof.json'),
    JSON.stringify({ result: 'PASS', observations, state: saved }, null, 2),
    { mode: 0o600, flag: 'wx' },
  );
  console.log(
    'PASS: real login, pinned vocabulary, draft initialize/save/replay/reopen and rejected-input conservation',
  );
}
main().catch(() => {
  console.error('HTTP proof failed; no automatic retry');
  process.exitCode = 1;
});
