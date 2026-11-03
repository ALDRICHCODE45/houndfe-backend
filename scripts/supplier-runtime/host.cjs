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
let stage = 'configure';
const STAGES = new Set([
  'configure',
  'isolate-environment',
  'started-record',
  'load-testing',
  'build-module',
  'override-providers',
  'compile-module',
  'create-application',
  'configure-http',
  'initialize-application',
  'identity-pin',
  'seed-password',
  'seed-tenants',
  'seed-foreign-supplier',
  'seed-users',
  'seed-roles',
  'seed-permissions',
  'seed-memberships',
  'seed-catalog-products',
  'seed-catalog-variants',
  'seed-catalog-suppliers',
  'listen',
  'credentials-record',
  'ready-record',
  'ready',
  'shutdown',
]);
const ERROR_NAMES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'AssertionError',
  'DatabaseError',
  'error',
  'UnknownDependenciesException',
  'UnknownElementException',
  'UndefinedModuleException',
  'InvalidModuleException',
  'PrismaClientKnownRequestError',
  'PrismaClientUnknownRequestError',
  'PrismaClientInitializationError',
  'PrismaClientValidationError',
  'PrismaClientRustPanicError',
]);
const PG_CODES = new Set([
  '23502',
  '23503',
  '23505',
  '23514',
  '42P01',
  '42703',
  '28P01',
  '28000',
  '3D000',
  '42501',
  '53300',
  '57P03',
  '08001',
  '08003',
  '08006',
  '55P03',
  '57014',
  '40001',
  '40P01',
]);
const NODE_CODES = new Set([
  'MODULE_NOT_FOUND',
  'ERR_MODULE_NOT_FOUND',
  'ENOENT',
  'EACCES',
  'EPERM',
  'EEXIST',
  'EADDRINUSE',
  'EADDRNOTAVAIL',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ECONNRESET',
  'ERR_INVALID_ARG_TYPE',
  'ERR_INVALID_ARG_VALUE',
  'ERR_ASSERTION',
  'ERR_DLOPEN_FAILED',
  'ERR_REQUIRE_ESM',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
]);
const MODELS = new Set([
  'Tenant',
  'User',
  'Role',
  'Permission',
  'RolePermission',
  'TenantMembership',
  'Product',
  'Variant',
  'ProcurementSupplier',
  'ProcurementSupplierAudit',
  'ProcurementSupplierReceipt',
  'ProcurementPurchaseOrder',
  'ProcurementPurchaseOrderLine',
  'ProcurementPurchaseOrderAudit',
  'ProcurementPurchaseOrderReceipt',
]);
const CONSTRAINTS = new Set([
  'po_supplier_fk',
  'supplier_tenant_fk',
  'po_tenant_fk',
  'po_line_tenant_fk',
  'po_line_order_fk',
  'po_audit_tenant_fk',
  'po_receipt_tenant_fk',
  'supplier_audit_tenant_fk',
  'supplier_receipt_tenant_fk',
  'permissions_subject_action_key',
  'role_permissions_roleId_permissionId_key',
  'tenants_pkey',
  'tenants_slug_key',
  'users_pkey',
  'users_email_key',
  'roles_pkey',
  'products_pkey',
  'variants_pkey',
  'procurement_suppliers_pkey',
]);
// DI diagnostics admit only names from this host graph, not arbitrary message words.
const DI_NAMES = new Set([
  'FilesService',
  'FilesModule',
  'STORAGE_PORT',
  'FILE_REPOSITORY',
  'EventEmitter',
  'EventEmitter2',
  'ProductsModule',
  'ProductsService',
  'PrismaProductRepository',
  'PRODUCT_REPOSITORY',
  'StockAlertsModule',
  'STOCK_ALERT_STATE_REPOSITORY',
  'OutboxModule',
  'OutboxDispatcherService',
  'OutboxWriterService',
  'OutboxPollerService',
  'ConfigService',
  'ConfigModule',
  'ClsService',
  'ClsModule',
  'PrismaService',
  'TenantPrismaService',
  'DatabaseModule',
  'AuthModule',
  'AuthService',
  'JwtStrategy',
  'JwtService',
  'JwtAuthGuard',
  'PermissionsGuard',
  'CaslAbilityFactory',
  'TenantContextGuard',
  'PermissionSeeder',
  'PrismaUserRepository',
  'USER_REPOSITORY',
  'PrismaRoleRepository',
  'ROLE_REPOSITORY',
  'PrismaPermissionRepository',
  'PERMISSION_REPOSITORY',
  'LoginOtpService',
  'PrismaLoginOtpRepository',
  'LoginRateLimitGuard',
  'ResendMailer',
  'MailerModule',
  'MAILER',
  'SatCatalogModule',
  'SatCatalogService',
  'PrismaSatKeyRepository',
  'SAT_KEY_REPOSITORY',
  'SuppliersModule',
  'SupplierCommands',
  'SupplierQueries',
  'SupplierCursor',
  'PurchaseOrdersModule',
  'PurchaseOrderCommands',
  'PurchaseOrderQueries',
  'PurchaseOrderCursor',
  'Reflector',
  'ModuleRef',
  'S3_CLIENT',
]);
function boundedDiMessage(error) {
  const message = errorField(error, 'message');
  // Bound work as well as output; never regex/serialize an unbounded driver payload.
  const words =
    typeof message === 'string'
      ? message.slice(0, 4096).match(/[A-Za-z][A-Za-z0-9_]*/g) || []
      : [];
  const names = [...new Set(words.filter((word) => DI_NAMES.has(word)))];
  let output = 'Nest DI: ';
  for (const name of names) {
    const next = output + (output === 'Nest DI: ' ? '' : ', ') + name;
    if (next.length > 256) break;
    output = next;
  }
  return output === 'Nest DI: ' ? 'Nest DI: UnknownProvider' : output;
}
// Read data properties only: never invoke error getters, stringify it or traverse causes.
function errorField(error, key) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function'))
    return undefined;
  try {
    const own = Object.getOwnPropertyDescriptor(error, key);
    if (own) return Object.hasOwn(own, 'value') ? own.value : undefined;
    if (key === 'name') {
      const prototype = Object.getPrototypeOf(error);
      if (!prototype) return undefined;
      const constructor = Object.getOwnPropertyDescriptor(
        prototype,
        'constructor',
      )?.value;
      const className =
        typeof constructor === 'function'
          ? Object.getOwnPropertyDescriptor(constructor, 'name')?.value
          : undefined;
      if (ERROR_NAMES.has(className)) return className;
      return Object.getOwnPropertyDescriptor(prototype, key)?.value;
    }
  } catch {
    // Untrusted proxy traps must not prevent the bounded diagnostic from being written.
  }
  return undefined;
}
function hostFailureDiagnostic(currentStage, error) {
  const name = errorField(error, 'name');
  const diagnostic = {
    stage: STAGES.has(currentStage) ? currentStage : 'configure',
    errorName: ERROR_NAMES.has(name) ? name : 'UnknownError',
  };
  if (diagnostic.errorName === 'UnknownDependenciesException')
    diagnostic.diMessage = boundedDiMessage(error);
  const meta = errorField(error, 'meta');
  const code = errorField(error, 'code');
  const prismaCode = code || errorField(error, 'errorCode');
  if (typeof prismaCode === 'string' && /^P[0-9]{4}$/.test(prismaCode))
    diagnostic.prismaCode = prismaCode;
  if (PG_CODES.has(code)) diagnostic.pgCode = code;
  else if (PG_CODES.has(errorField(meta, 'code')))
    diagnostic.pgCode = errorField(meta, 'code');
  if (NODE_CODES.has(code)) diagnostic.nodeCode = code;
  const constraint =
    errorField(error, 'constraint') ?? errorField(meta, 'constraint');
  if (constraint !== undefined)
    diagnostic.constraint = CONSTRAINTS.has(constraint)
      ? constraint
      : 'UnknownConstraint';
  const model = errorField(meta, 'modelName');
  if (model !== undefined)
    diagnostic.modelName = MODELS.has(model) ? model : 'UnknownModel';
  return diagnostic;
}
function writeHostError(
  directory,
  currentStage,
  error,
  io = fs,
  uid = process.getuid(),
) {
  assert.equal(path.dirname(directory), path.join(root, '.tmp'));
  assert(
    /^(po|supplier)-runtime\.[A-Za-z0-9]+$/.test(path.basename(directory)),
  );
  validatePrivatePath(
    directory,
    io.realpathSync(directory),
    io.lstatSync(directory),
    uid,
    0o700,
  );
  io.writeFileSync(
    path.join(directory, 'host-error.json'),
    JSON.stringify(hostFailureDiagnostic(currentStage, error), null, 2),
    { mode: 0o600, flag: 'wx' },
  );
}
function recordHostFailure(currentStage, error) {
  try {
    if (run) writeHostError(run, currentStage, error);
  } catch {
    // Retain first failure, including on shutdown. Never log the failed diagnostic/error.
  }
}
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
  const candidate = privatePath(process.argv[2], 0o700);
  assert.equal(path.dirname(candidate), path.join(root, '.tmp'));
  assert(
    path
      .basename(candidate)
      .startsWith(poMode ? 'po-runtime.' : 'supplier-runtime.'),
  );
  // No failure/shutdown artifact may be written until RUN's location is trusted.
  run = candidate;
  try {
    feOrigin = new URL(
      process.argv[3] || (poMode ? 'http://127.0.0.1:43179' : ''),
    ).origin;
  } catch {
    throw new Error('Usage: host.cjs <RUN> <feOrigin URL>');
  }
  if (!poMode) assert.equal(feOrigin, 'http://127.0.0.1:43179');
  else assert.match(feOrigin, /^https?:\/\//);
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
function isolatePoProviders(builder, po, load = compiled) {
  if (!po) return;
  // Compile-time Nest logs must not bypass the bounded failure diagnostic.
  builder.setLogger({
    log() {},
    error() {},
    warn() {},
    debug() {},
    verbose() {},
    fatal() {},
  });
  for (const [file, name] of [
    ['shared/outbox/outbox-poller.service', 'OutboxPollerService'],
    ['shared/outbox/outbox-dispatcher.service', 'OutboxDispatcherService'],
    ['auth/authorization/infrastructure/permission.seeder', 'PermissionSeeder'],
  ])
    builder.overrideProvider(load(file)[name]).useValue({});
}
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
  stage = 'seed-password';
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
  stage = 'seed-tenants';
  for (const [id, name] of [
    [tenantId, 'Supplier runtime tenant'],
    [otherTenantId, 'Supplier runtime foreign tenant'],
  ])
    await db.tenant.create({ data: { id, name, slug: `o3a-${id}` } });
  stage = 'seed-foreign-supplier';
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
    stage = 'seed-users';
    await db.user.create({
      data: {
        id: userId,
        email,
        name: `Supplier ${label}`,
        hashedPassword: hash,
      },
    });
    stage = 'seed-roles';
    await db.role.create({
      data: {
        id: roleId,
        tenantId,
        name: `Supplier runtime ${label} ${roleId}`,
      },
    });
    stage = 'seed-permissions';
    for (const [subject, action] of fixtureGrants(label, poMode))
      await db.rolePermission.create({
        data: { roleId, permissionId: (await permission(action, subject)).id },
      });
    stage = 'seed-memberships';
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
    stage = 'seed-catalog-products';
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
        stage = 'seed-catalog-variants';
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
  stage = 'seed-catalog-suppliers';
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

// Shared by the runtime and the compile-only test; this does not initialize an app.
function createHostBuilder(po) {
  const { Test } = require('@nestjs/testing');
  const { ConfigModule } = require('@nestjs/config');
  const { ClsModule } = require('nestjs-cls');
  stage = 'build-module';
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
            ...(po
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
      ...(po
        ? [
            require('@nestjs/event-emitter').EventEmitterModule.forRoot(),
            compiled('procurement/purchase-orders/purchase-orders.module')
              .PurchaseOrdersModule,
            compiled('products/products.module').ProductsModule,
          ]
        : []),
    ],
  });
  stage = 'override-providers';
  isolatePoProviders(builder, po);
  return builder;
}

async function main(options = {}) {
  poMode = options.po === true;
  stage = 'configure';
  configure();
  stage = 'isolate-environment';
  if (poMode)
    process.env = {
      DATABASE_URL: process.env.DATABASE_URL,
      NODE_ENV: 'development',
      COREPACK_ENABLE_NETWORK: '0',
      PRISMA_GENERATE_SKIP_AUTOINSTALL: 'true',
    };
  stage = 'started-record';
  record('host-started.json', { pid: process.pid });
  stage = 'load-testing';
  const builder = createHostBuilder(poMode);
  stage = 'compile-module';
  const module = await builder.compile();
  stage = 'create-application';
  app = module.createNestApplication({
    logger: poMode ? false : ['error', 'warn'],
  });
  stage = 'configure-http';
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
  stage = 'initialize-application';
  await app.init();
  stage = 'identity-pin';
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
  stage = 'listen';
  await app.listen(0, '127.0.0.1');
  const port = app.getHttpServer().address().port;
  assert.notEqual(port, 3000);
  const apiOrigin = `http://127.0.0.1:${port}`;
  stage = 'credentials-record';
  record('credentials.json', { apiOrigin, password, ...fixture });
  stage = 'ready-record';
  record('ready.json', { apiOrigin, feOrigin, pid: process.pid });
  stage = 'ready';
  console.log(`Owned supplier API ready at ${apiOrigin}; credentials private`);
}

async function close(code) {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => process.exit(1), 5000);
  try {
    await app?.close();
    record('host-stopped.json', { pid: process.pid });
  } catch (error) {
    recordHostFailure('shutdown', error);
    code = 1;
  } finally {
    clearTimeout(deadline);
    process.exit(code);
  }
}
function start(options) {
  process.once('SIGTERM', () => void close(0));
  process.once('SIGINT', () => void close(0));
  main(options).catch(async (error) => {
    recordHostFailure(stage, error);
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
  isolatePoProviders,
  createHostBuilder,
  hostFailureDiagnostic,
  writeHostError,
  start,
};
if (require.main === module) process.once('SIGTERM', () => void close(0));
if (require.main === module) process.once('SIGINT', () => void close(0));
const execution = require.main === module ? main() : null;
execution?.catch(async (error) => {
  recordHostFailure(stage, error);
  console.error('Supplier host failed; private target or runtime check failed');
  await close(1);
});
