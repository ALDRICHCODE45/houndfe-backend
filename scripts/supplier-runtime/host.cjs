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
let poMode = false;
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
function routeAllowed(method, route, po = false) {
  const extra = po
    ? [
        /^(GET|HEAD|POST|OPTIONS) \/procurement\/purchase-orders\/?$/i,
        /^(GET|HEAD|DELETE|OPTIONS) \/procurement\/purchase-orders\/[^/]+\/?$/i,
        /^(PUT|OPTIONS) \/procurement\/purchase-orders\/[^/]+\/draft\/?$/i,
        /^(GET|HEAD|OPTIONS) \/products\/?$/i,
        /^(GET|HEAD|OPTIONS) \/products\/[^/]+\/variants\/?$/i,
      ]
    : [];
  return [
    ...extra,
    /^(POST|OPTIONS) \/auth\/(login|logout|refresh)\/?$/i,
    /^(GET|HEAD|OPTIONS) \/auth\/me(\/permissions)?\/?$/i,
    /^(GET|HEAD|POST|OPTIONS) \/procurement\/suppliers\/?$/i,
    /^(GET|HEAD|PATCH|DELETE|OPTIONS) \/procurement\/suppliers\/[^/]+\/?$/i,
  ].some((rule) => rule.test(`${method} ${route}`));
}
function selectorQueryAllowed(route, query) {
  if (/^\/products\/?$/i.test(route))
    return Object.entries(query).every(
      ([name, value]) =>
        ['search', 'type', 'page', 'limit'].includes(name) &&
        typeof value === 'string',
    );
  if (/^\/products\/[^/]+\/variants\/?$/i.test(route))
    return Object.keys(query).length === 0;
  return true;
}
function configure() {
  run = privatePath(process.argv[2], 0o700);
  try {
    feOrigin = new URL(
      process.argv[3] || (poMode ? 'http://127.0.0.1:43179' : ''),
    ).origin;
  } catch {
    throw new Error('Usage: host.cjs <RUN> <feOrigin URL>');
  }
  if (!poMode) assert.equal(feOrigin, 'http://127.0.0.1:43179');
  else assert.match(feOrigin, /^https?:\/\//);
  assert.equal(path.dirname(run), path.join(root, '.tmp'));
  assert(
    path.basename(run).startsWith(poMode ? 'po-runtime.' : 'supplier-runtime.'),
  );
  if (poMode)
    for (const file of ['.env', '.env.test', 'prisma/.env'])
      assert(!fs.existsSync(path.join(root, file)));
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
function installParsers(app, po, load = compiled) {
  load('procurement/suppliers/supplier-http.filter').installSupplierBodyParser(
    app,
  );
  if (po)
    load(
      'procurement/purchase-orders/po-body-parser',
    ).installPurchaseOrderBodyParser(app);
}
const record = (name, value) =>
  fs.writeFileSync(path.join(run, name), JSON.stringify(value, null, 2), {
    mode: 0o600,
    flag: 'wx',
  });
const secret = () => crypto.randomBytes(32).toString('base64url');
let app;
let closing;

function fixtureGrants(label, po = false) {
  if (label === 'noaccess') return [];
  if (label === 'reader')
    return [[po ? 'ProcurementPurchaseOrder' : 'ProcurementSupplier', 'read']];
  assert.equal(label, 'manager');
  const subjects = po
    ? ['ProcurementSupplier', 'ProcurementPurchaseOrder']
    : ['ProcurementSupplier'];
  const grants = subjects.flatMap((subject) =>
    ['create', 'read', 'update', 'delete'].map((action) => [subject, action]),
  );
  return po ? [...grants, ['Product', 'read']] : grants;
}
async function seed(db, password) {
  const hash = await require('bcrypt').hash(password, 12);
  const permission = async (action, subject = 'ProcurementSupplier') =>
    (await db.permission.findUnique({
      where: { subject_action: { subject, action } },
    })) ??
    (await db.permission.create({
      data: { subject, action },
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
  for (const label of ['manager', 'reader', 'noaccess']) {
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
    for (const [subject, action] of fixtureGrants(label, poMode))
      await db.rolePermission.create({
        data: { roleId, permissionId: (await permission(action, subject)).id },
      });
    await db.tenantMembership.create({ data: { tenantId, userId, roleId } });
    users[label] = { email, userId };
  }
  const catalog = poMode
    ? await seedCatalog(db, tenantId, otherTenantId)
    : undefined;
  return { tenantId, otherTenantId, users, ...(catalog ? { catalog } : {}) };
}

async function seedCatalog(db, tenantId, otherTenantId) {
  const prefix = `PO-${crypto.randomUUID()}`;
  const catalog = { prefix };
  for (const [label, unit, type, useStock, hasVariants] of [
    ['unidad', 'UNIDAD', 'PRODUCT', true, false],
    ['kilogramo', 'KILOGRAMO', 'PRODUCT', true, false],
    ['caja', 'CAJA', 'PRODUCT', true, true],
    ['unidadVariants', 'UNIDAD', 'PRODUCT', true, true],
    ['noStock', 'UNIDAD', 'PRODUCT', false, false],
    ['service', 'HORA', 'SERVICE', false, false],
    ['foreign', 'UNIDAD', 'PRODUCT', false, false],
  ]) {
    const product = await db.product.create({
      data: {
        tenantId: label === 'foreign' ? otherTenantId : tenantId,
        name: `${prefix}-${label}`,
        unit,
        type,
        useStock,
        hasVariants,
      },
    });
    catalog[label] = { id: product.id, name: product.name, unit };
    if (hasVariants) {
      catalog[label].variants = [];
      for (const name of ['Small', 'Large']) {
        const variant = await db.variant.create({
          data: {
            tenantId,
            productId: product.id,
            name: `${prefix}-${name}`,
          },
        });
        catalog[label].variants.push({ id: variant.id, name: variant.name });
      }
    }
  }
  for (const status of ['ACTIVE', 'ARCHIVED']) {
    const supplier = await db.procurementSupplier.create({
      data: {
        tenantId,
        displayName: `${prefix}-${status}`,
        status,
      },
    });
    catalog[status.toLowerCase()] = {
      id: supplier.id,
      displayName: supplier.displayName,
      version: supplier.version,
    };
  }
  return catalog;
}

async function main(options = {}) {
  poMode = options.po === true;
  configure();
  if (poMode)
    process.env = {
      DATABASE_URL: process.env.DATABASE_URL,
      NODE_ENV: 'development',
      COREPACK_ENABLE_NETWORK: '0',
      PRISMA_GENERATE_SKIP_AUTOINSTALL: 'true',
    };
  record('host-started.json', { pid: process.pid });
  const { Test } = require('@nestjs/testing');
  const { ConfigModule } = require('@nestjs/config');
  const { ClsModule } = require('nestjs-cls');
  const builder = Test.createTestingModule({
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
            ...(poMode
              ? {
                  SPACES_ENDPOINT: 'http://127.0.0.1:1',
                  SPACES_REGION: 'disposable',
                  SPACES_ACCESS_KEY_ID: 'disposable',
                  SPACES_SECRET_ACCESS_KEY: 'disposable',
                  SPACES_BUCKET: 'disposable',
                  SPACES_PUBLIC_BASE_URL: 'http://127.0.0.1:1',
                }
              : {}),
          }),
        ],
      }),
      ClsModule.forRoot({ global: true, middleware: { mount: true } }),
      compiled('auth/auth.module').AuthModule,
      compiled('procurement/suppliers/suppliers.module').SuppliersModule,
      ...(poMode
        ? [
            compiled('procurement/purchase-orders/purchase-orders.module')
              .PurchaseOrdersModule,
            compiled('products/products.module').ProductsModule,
          ]
        : []),
    ],
  });
  if (poMode)
    builder
      .overrideProvider(
        compiled('shared/outbox/outbox-poller.service').OutboxPollerService,
      )
      .useValue({});
  const module = await builder.compile();
  app = module.createNestApplication({
    logger: poMode ? false : ['error', 'warn'],
  });
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
  installParsers(app, poMode);
  app.use((req, res, next) => {
    if (
      !routeAllowed(req.method, req.path, poMode) ||
      (poMode && !selectorQueryAllowed(req.path, req.query))
    )
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
function start(options) {
  process.once('SIGTERM', () => void close(0));
  process.once('SIGINT', () => void close(0));
  main(options).catch(async () => {
    console.error(
      'Disposable host failed; private target or runtime check failed',
    );
    await close(1);
  });
}
module.exports = {
  validateTarget,
  validatePrivatePath,
  routeAllowed,
  selectorQueryAllowed,
  seedCatalog,
  fixtureGrants,
  installParsers,
  start,
};
if (require.main === module) process.once('SIGTERM', () => void close(0));
if (require.main === module) process.once('SIGINT', () => void close(0));
const execution = require.main === module ? main() : null;
execution?.catch(async () => {
  console.error('Supplier host failed; private target or runtime check failed');
  await close(1);
});
