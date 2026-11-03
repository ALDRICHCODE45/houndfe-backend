// Parent-owned disposable supplier runtime; never import AppModule or load env files.
// Usage: DATABASE_URL=<owned disposable target> node host.cjs <RUN> <feOrigin>
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
let run;
let feOrigin;
let target;
function validatePrivatePath(input, real, stat, uid, mode) {
  assert.equal(input, real);
  assert(!stat.isSymbolicLink());
  assert(mode === 0o700 ? stat.isDirectory() : stat.isFile());
  assert.equal(stat.uid, uid);
  assert.equal(stat.mode & 0o7777, mode);
}
function privatePath(input, mode) {
  const resolved = path.resolve(input);
  validatePrivatePath(
    resolved,
    fs.realpathSync(resolved),
    fs.lstatSync(resolved),
    process.getuid(),
    mode,
  );
  return resolved;
}
function validateTarget(identity, text) {
  assert.deepEqual(Object.keys(identity).sort(), [
    'database',
    'ip',
    'username',
  ]);
  assert.equal(identity.database, 'nest-practice-test');
  assert.match(identity.username, /^[a-z][a-z0-9_]+$/);
  assert.notEqual(identity.username, 'postgres');
  assert.equal(require('node:net').isIP(identity.ip), 4);
  const octets = identity.ip.split('.').map(Number);
  assert(octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31);
  assert.equal(typeof text, 'string');
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('Invalid target URL');
  }
  assert(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.equal(url.hostname, identity.ip);
  assert.equal(url.port, '5432');
  assert.equal(decodeURIComponent(url.username), identity.username);
  assert.equal(decodeURIComponent(url.pathname), `/${identity.database}`);
  assert(url.password && !url.hash);
  // Only Prisma's usual public schema parameter is admitted; no target overrides.
  assert(!url.search || url.search === '?schema=public');
  return identity;
}
function routeAllowed(method, route) {
  return [
    /^(POST|OPTIONS) \/auth\/(login|logout|refresh)\/?$/i,
    /^(GET|HEAD|OPTIONS) \/auth\/me(\/permissions)?\/?$/i,
    /^(GET|HEAD|POST|OPTIONS) \/procurement\/suppliers\/?$/i,
    /^(GET|HEAD|PATCH|DELETE|OPTIONS) \/procurement\/suppliers\/[^/]+\/?$/i,
  ].some((rule) => rule.test(`${method} ${route}`));
}
function configure() {
  run = privatePath(process.argv[2], 0o700);
  try {
    feOrigin = new URL(process.argv[3]).origin;
  } catch {
    throw new Error('Usage: host.cjs <RUN> <feOrigin URL>');
  }
  assert.equal(feOrigin, 'http://127.0.0.1:43179');
  assert.equal(path.dirname(run), path.join(root, '.tmp'));
  assert(path.basename(run).startsWith('supplier-runtime.'));
  const manifest = privatePath(path.join(run, 'target-identity.json'), 0o600);
  let identity;
  try {
    identity = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  } catch {
    throw new Error('Invalid private identity manifest');
  }
  target = validateTarget(identity, process.env.DATABASE_URL);
}

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
    ['manager', ['create', 'read', 'update', 'delete']],
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
  configure();
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
  app.use((req, res, next) => {
    if (!routeAllowed(req.method, req.path))
      return res.status(403).json({ error: 'OUTSIDE_DISPOSABLE_SCOPE' });
    next();
  });
  await app.init();
  const db = app.get(compiled('shared/prisma/prisma.service').PrismaService);
  const [identity] =
    await db.$queryRaw`SELECT current_database() AS db, current_user AS usr, host(inet_server_addr()) AS ip`;
  assert.deepEqual(identity, {
    db: target.database,
    usr: target.username,
    ip: target.ip,
  });
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
module.exports = { validateTarget, validatePrivatePath, routeAllowed };
if (require.main === module) process.once('SIGTERM', () => void close(0));
if (require.main === module) process.once('SIGINT', () => void close(0));
const execution = require.main === module ? main() : null;
execution?.catch(async () => {
  console.error('Supplier host failed; private target or runtime check failed');
  await close(1);
});
