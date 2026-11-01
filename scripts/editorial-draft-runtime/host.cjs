// Parent-owned minimal real host; never import AppModule or load environment files.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { openRelay } = require('./relay.cjs');
const root = path.resolve(__dirname, '../..');
const run = fs.realpathSync(process.argv[2]);
assert.equal(path.dirname(run), path.join(root, '.tmp'));
assert(path.basename(run).startsWith('draft-runtime.'));
const fd = fs.openSync(
  path.join(run, 'config.json'),
  fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
);
const stat = fs.fstatSync(fd);
assert(
  stat.isFile() &&
    stat.uid === process.getuid() &&
    (stat.mode & 0o777) === 0o600,
);
assert(stat.size > 0 && stat.size < 4096);
let config;
try {
  const buffer = Buffer.alloc(4097);
  const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
  assert.equal(size, stat.size);
  config = JSON.parse(buffer.subarray(0, size).toString('utf8'));
} catch {
  throw new Error('Invalid private runtime configuration');
} finally {
  fs.closeSync(fd);
}
const target = config.pinned;
assert.deepEqual(config.binding.target, target);
assert.equal(config.feOrigin, 'http://127.0.0.1:43179');
const compiled = (file) => require(path.join(root, 'dist', file));
function record(name, value) {
  fs.writeFileSync(path.join(run, name), JSON.stringify(value), {
    mode: 0o600,
    flag: 'wx',
  });
}
let client;
let app;
let relay;
let closing;
async function main() {
  record('host-started.json', { owner: target.owner, pid: process.pid });
  relay = await openRelay(target, config.network);
  target.port = relay.port;
  config.binding.target = { ...target };
  const { constructEditorialPostgresClient } = compiled(
    'catalog-editorial/infrastructure/editorial-coordination-postgres-harness',
  );
  client = await constructEditorialPostgresClient(config.binding, target);
  const [identity] =
    await client.$queryRaw`SELECT current_database() AS db, current_user AS usr, current_schema() AS schema`;
  assert.deepEqual(identity, {
    db: target.database,
    usr: target.user,
    schema: config.binding.schema,
  });
  const { Test } = require('@nestjs/testing');
  const { ConfigModule } = require('@nestjs/config');
  const { ClsModule } = require('nestjs-cls');
  const { PrismaService } = compiled('shared/prisma/prisma.service');
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        ignoreEnvVars: true,
        skipProcessEnv: true,
        load: [
          () => ({
            NODE_ENV: 'development',
            JWT_SECRET: config.jwt,
            JWT_REFRESH_SECRET: config.refresh,
          }),
        ],
      }),
      ClsModule.forRoot({ global: true, middleware: { mount: true } }),
      compiled('auth/auth.module').AuthModule,
      compiled('catalog-editorial/catalog-editorial-read.module')
        .CatalogEditorialReadModule,
      compiled('catalog-editorial/catalog-editorial-vocabulary.module')
        .CatalogEditorialVocabularyModule,
    ],
  })
    .overrideProvider(PrismaService)
    .useValue(client)
    .compile();
  app = module.createNestApplication({ logger: false });
  app.useGlobalPipes(
    compiled('shared/listing/app-validation.pipe').createAppValidationPipe(),
  );
  app.useGlobalFilters(
    new (compiled(
      'shared/filters/domain-exception.filter',
    ).DomainExceptionFilter)(),
    new (compiled(
      'shared/filters/prisma-exception.filter',
    ).PrismaExceptionFilter)(),
  );
  app.enableCors(
    compiled('catalog-editorial/http/editorial-cors').editorialCors({
      origin: [config.feOrigin],
      credentials: true,
    }),
  );
  const allowed = new Set([
    'POST /auth/login',
    'POST /auth/logout',
    'GET /auth/me',
    'GET /auth/me/permissions',
    'GET /catalog-editorial/vocabulary',
  ]);
  app.use((req, res, next) => {
    const method =
      req.method === 'OPTIONS'
        ? req.get('Access-Control-Request-Method')
        : req.method;
    if (!allowed.has(`${method} ${req.path}`))
      return res.status(403).json({ error: 'OUTSIDE_DISPOSABLE_SCOPE' });
    next();
  });
  await app.init();
  const { seedEditorialPostgres } = compiled(
    'catalog-editorial/infrastructure/editorial-coordination-postgres-fixture',
  );
  const hash = await require('bcrypt').hash(config.fixturePassword, 12);
  const fixtures = [];
  for (const purpose of ['http', 'browser']) {
    const fixture = await client.$transaction(async (tx) => {
      const f = await seedEditorialPostgres(tx, `${target.owner}-${purpose}`);
      await tx.$executeRaw`UPDATE users SET "hashedPassword" = ${hash} WHERE id = ${f.ids.userId}`;
      await tx.$executeRaw`UPDATE editorial_bindings SET "publicationCheck" = 'when_asserted', policy = '{"route":"pending"}'::jsonb WHERE "familyId" = ${f.ids.familyId}`;
      return f;
    });
    fixtures.push(fixture);
    const base = `/products/${fixture.ids.productId}/editorial`;
    for (const route of [
      `GET ${base}`,
      `GET ${base}/context`,
      `POST ${base}/draft/initialize`,
      `PUT ${base}/draft`,
    ])
      allowed.add(route);
  }
  await client.$executeRaw`INSERT INTO editorial_vocabulary_metadata (id, "semanticsVersion") VALUES ('global', 'editorial-production-1')`;
  await app.listen(0, '127.0.0.1');
  const port = app.getHttpServer().address().port;
  assert.notEqual(port, 3000);
  for (let i = 0; i < fixtures.length; i++) {
    const f = fixtures[i];
    const payload = {
      apiOrigin: `http://127.0.0.1:${port}`,
      email: f.values.email,
      password: config.fixturePassword,
      productId: f.ids.productId,
      tenantId: f.ids.tenantId,
      userId: f.ids.userId,
    };
    record(`${i === 0 ? 'http' : 'browser'}-credentials.json`, payload);
  }
  record('ready.json', {
    owner: target.owner,
    apiOrigin: `http://127.0.0.1:${port}`,
    feOrigin: config.feOrigin,
    pid: process.pid,
  });
  console.log(
    'Owned draft API ready; fixture credentials remain in private files',
  );
}
async function close(code) {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => process.exit(1), 5000);
  try {
    await relay?.close();
    const results = await Promise.allSettled([
      app?.close(),
      client?.$disconnect(),
    ]);
    if (results.some((result) => result.status === 'rejected')) code = 1;
    record('host-stopped.json', { owner: target.owner, pid: process.pid });
  } catch {
    code = 1;
  } finally {
    clearTimeout(deadline);
    process.exit(code);
  }
}
process.once('SIGTERM', () => void close(0));
process.once('SIGINT', () => void close(0));
main().catch(async (error) => {
  try {
    fs.writeFileSync(path.join(run, 'host-error.txt'), String(error.name), {
      mode: 0o600,
    });
    console.error('Draft host failed; private diagnostic retained');
  } finally {
    await close(1);
  }
});
