// Parent-owned disposable supplier runtime; never import AppModule or load env files.
// Usage: DATABASE_URL=<owned disposable target> node host.cjs <RUN> <feOrigin>
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const run = fs.realpathSync(process.argv[2]);
let feOrigin;
try {
  feOrigin = new URL(process.argv[3]).origin;
} catch {
  throw new Error('Usage: host.cjs <RUN> <feOrigin URL>');
}
assert.equal(path.dirname(run), path.join(root, '.tmp'));
assert(path.basename(run).startsWith('supplier-runtime.'));
assert.equal(fs.statSync(run).mode & 0o777, 0o700);
assert(/@172\.\d+\.\d+\.\d+:5432\//.test(process.env.DATABASE_URL ?? ''));
const compiled = (file) => require(path.join(root, 'dist', file));
const record = (name, value) =>
  fs.writeFileSync(path.join(run, name), JSON.stringify(value, null, 2), {
    mode: 0o600,
    flag: 'wx',
  });
const secret = () => crypto.randomBytes(32).toString('base64url');
let app;
let closing;

async function seed(db, password) {
  const hash = await require('bcrypt').hash(password, 12);
  const permission = async (action) =>
    (await db.permission.findUnique({
      where: { subject_action: { subject: 'ProcurementSupplier', action } },
    })) ??
    (await db.permission.create({
      data: { subject: 'ProcurementSupplier', action },
    }));
  const tenantId = crypto.randomUUID();
  const otherTenantId = crypto.randomUUID();
  for (const [id, name] of [
    [tenantId, 'Supplier runtime tenant'],
    [otherTenantId, 'Supplier runtime foreign tenant'],
  ])
    await db.tenant.create({ data: { id, name, slug: `o3a-${id}` } });
  await db.procurementSupplier.create({
    data: {
      tenantId: otherTenantId,
      displayName: 'Foreign tenant supplier',
      termsText: null,
      status: 'ACTIVE',
    },
  });
  const users = {};
  for (const [label, actions] of [
    ['manager', ['create', 'read', 'update']],
    ['reader', ['read']],
    ['noaccess', []],
  ]) {
    const userId = crypto.randomUUID();
    const roleId = crypto.randomUUID();
    const email = `${label}-${userId.slice(0, 8)}@supplier-runtime.invalid`;
    await db.user.create({
      data: {
        id: userId,
        email,
        name: `Supplier ${label}`,
        hashedPassword: hash,
      },
    });
    await db.role.create({
      data: {
        id: roleId,
        tenantId,
        name: `Supplier runtime ${label} ${roleId}`,
      },
    });
    for (const action of actions)
      await db.rolePermission.create({
        data: { roleId, permissionId: (await permission(action)).id },
      });
    await db.tenantMembership.create({ data: { tenantId, userId, roleId } });
    users[label] = { email, userId };
  }
  return { tenantId, otherTenantId, users };
}

async function main() {
  record('host-started.json', { pid: process.pid });
  const { Test } = require('@nestjs/testing');
  const { ConfigModule } = require('@nestjs/config');
  const { ClsModule } = require('nestjs-cls');
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        ignoreEnvVars: true,
        load: [
          () => ({
            NODE_ENV: 'development',
            JWT_SECRET: secret(),
            JWT_REFRESH_SECRET: secret(),
          }),
        ],
      }),
      ClsModule.forRoot({ global: true, middleware: { mount: true } }),
      compiled('auth/auth.module').AuthModule,
      compiled('procurement/suppliers/suppliers.module').SuppliersModule,
    ],
  }).compile();
  app = module.createNestApplication({ logger: ['error', 'warn'] });
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
      origin: [feOrigin],
      credentials: true,
    }),
  );
  // Same order as main.ts: supplier admission after CORS, before init.
  compiled(
    'procurement/suppliers/supplier-http.filter',
  ).installSupplierBodyParser(app);
  const allowed = [
    /^(POST|OPTIONS) \/auth\/(login|logout|refresh)$/,
    /^(GET|OPTIONS) \/auth\/me(\/permissions)?$/,
    /^[A-Z]+ \/procurement\/suppliers(\/[^/]*)?$/,
  ];
  app.use((req, res, next) => {
    if (!allowed.some((rule) => rule.test(`${req.method} ${req.path}`)))
      return res.status(403).json({ error: 'OUTSIDE_DISPOSABLE_SCOPE' });
    next();
  });
  await app.init();
  const db = app.get(compiled('shared/prisma/prisma.service').PrismaService);
  const [identity] =
    await db.$queryRaw`SELECT current_database() AS db, current_user AS usr`;
  assert.deepEqual(identity, { db: 'nest-practice-test', usr: 'o3a_test' });
  const password = secret();
  const fixture = await seed(db, password);
  await app.listen(0, '127.0.0.1');
  const port = app.getHttpServer().address().port;
  assert.notEqual(port, 3000);
  const apiOrigin = `http://127.0.0.1:${port}`;
  record('credentials.json', { apiOrigin, password, ...fixture });
  record('ready.json', { apiOrigin, feOrigin, pid: process.pid });
  console.log(`Owned supplier API ready at ${apiOrigin}; credentials private`);
}

async function close(code) {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => process.exit(1), 5000);
  try {
    await app?.close();
    record('host-stopped.json', { pid: process.pid });
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
  fs.writeFileSync(path.join(run, 'host-error.txt'), String(error?.stack), {
    mode: 0o600,
  });
  console.error('Supplier host failed; diagnostic in private run directory');
  await close(1);
});
