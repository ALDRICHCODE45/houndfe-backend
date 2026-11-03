const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateTarget,
  routeAllowed,
  validatePrivatePath,
  hostFailureDiagnostic,
  writeHostError,
} = require('./host.cjs');
const identity = {
  database: 'nest-practice-test',
  username: 'fixture_generated',
  ip: '172.28.0.2',
};
const url =
  'postgresql://fixture_generated:private@172.28.0.2:5432/nest-practice-test';

test('host failure diagnostic copies only bounded labels, never messages, URLs, credentials, stacks, causes or SQL', () => {
  const secret = 'postgresql://private_user:private_password@172.28.0.2/db';
  const error = Object.assign(new Error(secret), {
    name: 'PrismaClientKnownRequestError',
    code: 'P2003',
    stack: `${secret} SQL INSERT private_value`,
    cause: { password: 'private_password' },
    meta: {
      constraint: 'po_supplier_fk',
      modelName: 'ProcurementSupplier',
      detail: secret,
      field_name: secret,
    },
    query: secret,
  });
  const result = hostFailureDiagnostic('seed-catalog-suppliers', error);
  assert.deepEqual(result, {
    stage: 'seed-catalog-suppliers',
    errorName: 'PrismaClientKnownRequestError',
    prismaCode: 'P2003',
    constraint: 'po_supplier_fk',
    modelName: 'ProcurementSupplier',
  });
  assert(!JSON.stringify(result).includes('private'));
  assert.deepEqual(
    hostFailureDiagnostic(secret, {
      name: secret,
      code: secret,
      meta: { constraint: secret, modelName: secret },
    }),
    {
      stage: 'configure',
      errorName: 'UnknownError',
      constraint: 'UnknownConstraint',
      modelName: 'UnknownModel',
    },
  );
});
test('DI message contains only allowlisted graph names, with bounded work/output and no raw secrets', () => {
  class UnknownDependenciesException extends Error {}
  const message =
    "Nest can't resolve FilesService (EventEmitter) in FilesModule. " +
    'postgresql://private_user:private_password@172.28.0.2/private_db ' +
    'private_plain_identifier user@example.invalid SELECT private_column FROM private_table';
  const diagnostic = hostFailureDiagnostic(
    'compile-module',
    new UnknownDependenciesException(message),
  );
  assert.equal(
    diagnostic.diMessage,
    'Nest DI: FilesService, EventEmitter, FilesModule',
  );
  assert.match(diagnostic.diMessage, /^[A-Za-z0-9_ ,.?()'\-:]{1,256}$/);
  assert(!JSON.stringify(diagnostic).includes('private'));
  assert(
    !(
      'diMessage' in hostFailureDiagnostic('compile-module', new Error(message))
    ),
  );
  const names =
    'FilesService FilesModule STORAGE_PORT FILE_REPOSITORY EventEmitter EventEmitter2 ProductsModule ProductsService PrismaProductRepository PRODUCT_REPOSITORY StockAlertsModule STOCK_ALERT_STATE_REPOSITORY OutboxModule OutboxDispatcherService OutboxWriterService OutboxPollerService ConfigService ConfigModule ClsService PrismaService TenantPrismaService';
  const capped = hostFailureDiagnostic(
    'compile-module',
    new UnknownDependenciesException(names.repeat(3)),
  ).diMessage;
  assert(capped.length <= 256 && capped.length > 200);
  assert.match(capped, /^[A-Za-z0-9_ ,.?()'\-:]+$/);
  assert(names.split(' ').includes(capped.split(', ').at(-1)));
  assert.equal(
    hostFailureDiagnostic(
      'compile-module',
      new UnknownDependenciesException('x'.repeat(4096) + ' FilesService'),
    ).diMessage,
    'Nest DI: UnknownProvider',
  );
  let getterCalls = 0;
  const withGetter = new UnknownDependenciesException();
  Object.defineProperty(withGetter, 'message', {
    get() {
      getterCalls++;
      throw new Error('private');
    },
  });
  assert.equal(
    hostFailureDiagnostic('compile-module', withGetter).diMessage,
    'Nest DI: UnknownProvider',
  );
  assert.equal(getterCalls, 0);
});
test('host diagnostic classifies DI, Prisma initialization, PG and Node errors without retaining arbitrary names/codes', () => {
  class UnknownDependenciesException extends Error {}
  assert.deepEqual(
    hostFailureDiagnostic(
      'compile-module',
      new UnknownDependenciesException('secret DI context'),
    ),
    {
      stage: 'compile-module',
      errorName: 'UnknownDependenciesException',
      diMessage: 'Nest DI: UnknownProvider',
    },
  );
  assert.deepEqual(
    hostFailureDiagnostic('identity-pin', {
      name: 'error',
      code: '23503',
      constraint: 'po_tenant_fk',
    }),
    {
      stage: 'identity-pin',
      errorName: 'error',
      pgCode: '23503',
      constraint: 'po_tenant_fk',
    },
  );
  assert.deepEqual(
    hostFailureDiagnostic(
      'build-module',
      Object.assign(new Error('private path'), { code: 'MODULE_NOT_FOUND' }),
    ),
    { stage: 'build-module', errorName: 'Error', nodeCode: 'MODULE_NOT_FOUND' },
  );
  assert.deepEqual(
    hostFailureDiagnostic('initialize-application', {
      name: 'PrismaClientInitializationError',
      errorCode: 'P1001',
    }),
    {
      stage: 'initialize-application',
      errorName: 'PrismaClientInitializationError',
      prismaCode: 'P1001',
    },
  );
  assert.deepEqual(
    hostFailureDiagnostic('identity-pin', {
      code: 'P2010',
      meta: { code: '23503' },
    }),
    {
      stage: 'identity-pin',
      errorName: 'UnknownError',
      prismaCode: 'P2010',
      pgCode: '23503',
    },
  );
  assert.deepEqual(
    hostFailureDiagnostic('listen', { name: 'SecretName', code: 'SECRET' }),
    { stage: 'listen', errorName: 'UnknownError' },
  );
});
test('diagnostics never invoke error getters, serialize arbitrary thrown objects or follow causes', () => {
  let reads = 0;
  const error = {};
  for (const name of [
    'name',
    'code',
    'errorCode',
    'meta',
    'constraint',
    'message',
    'stack',
    'cause',
    'toJSON',
  ])
    Object.defineProperty(error, name, {
      get() {
        reads++;
        throw new Error('must not read');
      },
    });
  assert.deepEqual(hostFailureDiagnostic('compile-module', error), {
    stage: 'compile-module',
    errorName: 'UnknownError',
  });
  assert.equal(reads, 0);
  const proxy = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error('private');
      },
    },
  );
  assert.deepEqual(hostFailureDiagnostic('compile-module', proxy), {
    stage: 'compile-module',
    errorName: 'UnknownError',
  });
  assert.deepEqual(
    hostFailureDiagnostic('compile-module', 'private arbitrary thrown text'),
    { stage: 'compile-module', errorName: 'UnknownError' },
  );
});
test('failure file is private/exclusive, validates RUN, and cannot replace the first failure', () => {
  const path = require('node:path');
  const root = path.resolve(__dirname, '../..');
  const directory = path.join(root, '.tmp/po-runtime.Offline1');
  let saved;
  let writeAttempts = 0;
  const stat = {
    uid: 123,
    mode: 0o40700,
    isDirectory: () => true,
    isSymbolicLink: () => false,
  };
  const io = {
    realpathSync: (file) => file,
    lstatSync: () => stat,
    writeFileSync: (file, text, options) => {
      writeAttempts++;
      assert.equal(file, path.join(directory, 'host-error.json'));
      assert.deepEqual(options, { mode: 0o600, flag: 'wx' });
      if (saved) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      saved = text;
    },
  };
  const write = (dir = directory) =>
    writeHostError(
      dir,
      'listen',
      { code: 'EADDRINUSE', message: 'private' },
      io,
      123,
    );
  write();
  const first = saved;
  assert.deepEqual(JSON.parse(first), {
    stage: 'listen',
    errorName: 'UnknownError',
    nodeCode: 'EADDRINUSE',
  });
  assert.throws(() => write());
  assert.equal(saved, first);
  for (const dir of [
    '/tmp/po-runtime.Offline1',
    path.join(root, '.tmp/other.Offline1'),
  ])
    assert.throws(() => write(dir));
  stat.uid = 999;
  assert.throws(() => write());
  stat.uid = 123;
  stat.mode = 0o40755;
  assert.throws(() => write());
  stat.mode = 0o40700;
  stat.isSymbolicLink = () => true;
  assert.throws(() => write());
  assert.equal(saved, first);
  assert.equal(writeAttempts, 2);
});

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
