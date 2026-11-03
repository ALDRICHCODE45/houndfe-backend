const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateTarget,
  routeAllowed,
  validatePrivatePath,
} = require('./host.cjs');
const identity = {
  database: 'nest-practice-test',
  username: 'fixture_generated',
  ip: '172.28.0.2',
};
const url =
  'postgresql://fixture_generated:private@172.28.0.2:5432/nest-practice-test';

test('target pins exact database, generated user, host and port', () => {
  assert.deepEqual(validateTarget(identity, url), identity);
  assert.deepEqual(validateTarget(identity, `${url}?schema=public`), identity);
  assert.throws(() => validateTarget(undefined, url));
  assert.throws(() => validateTarget(null, url));
  assert.throws(() => validateTarget({ ...identity, ip: '127.0.0.1' }, url));
  for (const changed of [
    url.replace('5432', '3000'),
    url.replace('fixture_generated', 'o3a_test'),
    url.replace('172.28.0.2', '127.0.0.1'),
    url.replace('nest-practice-test', 'existing'),
    url.replace(':private', ''),
    url.replace(':5432', ''),
    `${url}?host=127.0.0.1`,
    `${url}#fragment`,
    'not a URL',
    undefined,
  ])
    assert.throws(() => validateTarget(identity, changed));
  assert.throws(() => validateTarget({ ...identity, extra: true }, url));
});
test('private inputs reject symlink, wrong owner, wrong mode and realpath mismatch', () => {
  const stat = {
    isFile: () => true,
    isSymbolicLink: () => false,
    uid: 42,
    mode: 0o100600,
  };
  assert.doesNotThrow(() =>
    validatePrivatePath('/run/input', '/run/input', stat, 42, 0o600),
  );
  for (const changed of [
    { ...stat, uid: 1 },
    { ...stat, mode: 0o100644 },
    { ...stat, isSymbolicLink: () => true },
    { ...stat, isFile: () => false },
  ])
    assert.throws(() =>
      validatePrivatePath('/run/input', '/run/input', changed, 42, 0o600),
    );
  assert.throws(() =>
    validatePrivatePath('/run/link', '/run/input', stat, 42, 0o600),
  );
  const directory = { ...stat, mode: 0o40700, isDirectory: () => true };
  assert.doesNotThrow(() =>
    validatePrivatePath('/run', '/run', directory, 42, 0o700),
  );
  assert.throws(() => validatePrivatePath('/run', '/run', directory, 1, 0o700));
});
test('route boundary matches case and optional slash but not siblings or extra segments', () => {
  for (const [method, route] of [
    ['DELETE', '/PROCUREMENT/SUPPLIERS/abc/'],
    ['GET', '/Procurement/Suppliers/'],
    ['POST', '/AUTH/LOGIN/'],
    ['GET', '/Auth/Me/Permissions/'],
  ])
    assert(routeAllowed(method, route));
  for (const [method, route] of [
    ['DELETE', '/procurement/suppliers'],
    ['POST', '/procurement/suppliers/abc'],
    ['PUT', '/procurement/suppliers/abc'],
    ['GET', '/procurement/suppliersX'],
    ['GET', '/procurement/suppliers/abc/history'],
    ['GET', '/procurement/suppliers//'],
  ])
    assert(!routeAllowed(method, route));
});
