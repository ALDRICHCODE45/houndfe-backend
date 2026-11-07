// Ops › load test products: creates six «[PRUEBA] » pet products in one tenant
// through the backend's own application services (ProductsService.create and
// ProductPackagingService.putProduct), so they carry a default price, INITIAL
// stock in the inventory journal, packaging and the online-catalog flag
// exactly as POST /products + PUT /products/:id/packaging would leave them.
//
// Runs against the COMPILED app: run it from the app root (the directory that
// holds dist/, node_modules/ and prisma/), e.g. /app inside the container.
// Without --apply it is a dry run: it only reads, prints the plan and never
// boots Nest (booting runs the permission seeder, which writes).
//
//   node scripts/ops/load-test-products.cjs --tenant <slug> --actor-email <email>
//        [--apply] [--delete-demo] [--delete-test]
//
// --delete-demo  also deletes the prisma/seed.ts demo products (Paracetamol
//                500mg, Ibuprofeno 400mg) of the tenant, only if unsold.
// --delete-test  deletes the six test products instead of loading them.
//
// Idempotent: a product that already exists by name in the tenant is skipped
// (only its packaging is restored if it is missing).
'use strict';

const path = require('node:path');
const { createRequire } = require('node:module');

const APP_ROOT = process.cwd();
const appRequire = createRequire(path.join(APP_ROOT, 'package.json'));

const PREFIX = '[PRUEBA] ';
const DEMO_NAMES = ['Paracetamol 500mg', 'Ibuprofeno 400mg'];
const peso = (amount) => Math.round(amount * 100);

// From scripts/dev-showcase/catalog.cjs (prices, cost, IVA, brand, category)
// and scripts/dev-showcase/shipping.cjs (packaging). The croquetas name drops
// «Familiar»: with the prefix the full name is 107 characters and
// CreateProductDto caps names at 100. The last four fit «Caja chica»
// (30×20×15 cm, 5 kg).
const PRODUCTS = [
  {
    name: 'Croquetas Naturales Sin Grano de Salmón y Camote para Perros Adultos de Raza Grande 18 kg',
    cat: 'Alimento para perro',
    brand: 'Taste of the Wild',
    price: 1599,
    cost: 1090,
    iva: 'IVA_0',
    description:
      'Fórmula sin granos con salmón, camote y probióticos. Presentación familiar de 18 kg.',
    packaging: { weightG: 18000, lengthCm: 68, widthCm: 43, heightCm: 12 },
  },
  {
    name: 'Arena Sanitaria Aglomerante 10 kg',
    cat: 'Alimento para gato',
    brand: 'Sin Marca',
    price: 189,
    cost: 118,
    packaging: { weightG: 10300, lengthCm: 40, widthCm: 28, heightCm: 12 },
  },
  {
    name: 'Shampoo Hipoalergénico 500 ml',
    cat: 'Higiene y cuidado',
    brand: 'Bio-Groom',
    price: 219,
    cost: 130,
    packaging: { weightG: 560, lengthCm: 20.5, widthCm: 7, heightCm: 5.5 },
  },
  {
    name: 'Premios de Entrenamiento Mini Hígado 200 g',
    cat: 'Alimento para perro',
    brand: 'Pedigree',
    price: 79,
    cost: 44,
    iva: 'IVA_0',
    packaging: { weightG: 230, lengthCm: 18, widthCm: 12, heightCm: 4 },
  },
  {
    name: 'Pelota de Goma Resistente',
    cat: 'Juguetes',
    brand: 'Kong',
    price: 169,
    cost: 90,
    packaging: { weightG: 260, lengthCm: 9, widthCm: 9, heightCm: 9 },
  },
  {
    name: 'Alimento para Peces Tropicales 100 g',
    cat: 'Acuario',
    brand: 'Tetra',
    price: 89,
    cost: 48,
    packaging: { weightG: 140, lengthCm: 12, widthCm: 7, heightCm: 7 },
  },
].map((spec) => ({ ...spec, name: PREFIX + spec.name }));
const STOCK = 50;

class OpsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function parseArgs(argv) {
  const args = {
    apply: false,
    deleteDemo: false,
    deleteTest: false,
    help: false,
  };
  const flags = {
    '--apply': 'apply',
    '--delete-demo': 'deleteDemo',
    '--delete-test': 'deleteTest',
    '--help': 'help',
  };
  const values = { '--tenant': 'tenant', '--actor-email': 'actorEmail' };
  for (let i = 0; i < argv.length; i += 1) {
    const [key, inline] = argv[i].split(/=(.*)/s, 2);
    if (flags[key] && inline === undefined) {
      args[flags[key]] = true;
    } else if (values[key]) {
      const value = inline ?? argv[(i += 1)];
      if (!value || value.startsWith('--')) {
        throw new OpsError('BAD_ARGS', `${key} needs a value`);
      }
      args[values[key]] = value.trim();
    } else {
      throw new OpsError('BAD_ARGS', `unknown argument ${argv[i]}`);
    }
  }
  if (args.help) return args;
  if (!args.tenant) throw new OpsError('BAD_ARGS', '--tenant is required');
  if (!args.actorEmail) {
    throw new OpsError('BAD_ARGS', '--actor-email is required');
  }
  return args;
}

/** host:port/database of DATABASE_URL — never the credentials. */
function databaseTarget() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new OpsError('ENV_MISSING', 'DATABASE_URL is not set');
  try {
    const url = new URL(raw);
    return `${url.hostname}:${url.port || '5432'}${url.pathname}`;
  } catch {
    throw new OpsError('ENV_INVALID', 'DATABASE_URL is not a valid URL');
  }
}

function loadDist() {
  const dist = (file) => appRequire(`./dist/${file}`);
  try {
    return {
      createAppValidationPipe: dist('shared/listing/app-validation.pipe')
        .createAppValidationPipe,
      CreateProductDto: dist('products/dto/create-product.dto')
        .CreateProductDto,
      PutPackagingDto: dist('shipping/packaging/dto/packaging.dto')
        .PutPackagingDto,
      dist,
    };
  } catch (err) {
    throw new OpsError(
      'DIST_MISSING',
      `cannot load the compiled app from ${APP_ROOT}/dist (run from the app root after a build): ${err.message}`,
    );
  }
}

// ── Plan (read-only) ───────────────────────────────────────────────────────

function productBody(spec, refs) {
  const body = {
    name: spec.name,
    type: 'PRODUCT',
    priceCents: peso(spec.price),
    ivaRate: spec.iva ?? 'IVA_16',
    purchaseCost: { mode: 'NET', valueCents: peso(spec.cost) },
    sellInPos: true,
    includeInOnlineCatalog: true,
    useStock: true,
    quantity: STOCK,
  };
  if (spec.description) body.description = spec.description;
  if (refs.categories.has(spec.cat)) {
    body.categoryId = refs.categories.get(spec.cat);
  }
  if (refs.brands.has(spec.brand)) body.brandId = refs.brands.get(spec.brand);
  return body;
}

/** Same pipe as main.ts: whitelist, forbidNonWhitelisted, transform. */
async function validateBody(dist, metatype, body, label) {
  try {
    return await dist
      .createAppValidationPipe()
      .transform(body, { type: 'body', metatype });
  } catch (err) {
    const response = err.getResponse?.();
    const detail = response?.message ?? response ?? err.message;
    throw new OpsError(
      'VALIDATION_FAILED',
      `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`,
    );
  }
}

const byName = async (delegate, names) =>
  new Map(
    (
      await delegate.findMany({
        where: { name: { in: [...new Set(names)] } },
        select: { id: true, name: true },
      })
    ).map((row) => [row.name, row.id]),
  );

async function deletionTargets(prisma, tenantId, names) {
  const targets = [];
  for (const name of names) {
    const row = await prisma.product.findFirst({
      where: { tenantId, name },
      select: { id: true },
    });
    if (!row) {
      targets.push({ name, id: null, sales: 0 });
      continue;
    }
    const sales = await prisma.saleItem.count({
      where: { tenantId, productId: row.id },
    });
    targets.push({ name, id: row.id, sales });
  }
  return targets;
}

async function buildPlan(prisma, dist, args) {
  const tenant = await prisma.tenant.findUnique({
    where: { slug: args.tenant },
    select: { id: true, slug: true, name: true, isActive: true },
  });
  if (!tenant) {
    throw new OpsError('TENANT_NOT_FOUND', `tenant "${args.tenant}"`);
  }
  if (!tenant.isActive) {
    throw new OpsError('TENANT_INACTIVE', `tenant "${args.tenant}"`);
  }
  const actor = await prisma.user.findFirst({
    where: { email: { equals: args.actorEmail, mode: 'insensitive' } },
    select: { id: true, name: true, isActive: true },
  });
  if (!actor || !actor.isActive) {
    throw new OpsError('ACTOR_NOT_FOUND', `no active user ${args.actorEmail}`);
  }
  const memberships = await prisma.tenantMembership.findMany({
    where: { userId: actor.id, tenantId: tenant.id },
    select: { role: { select: { name: true } } },
  });
  if (memberships.length === 0) {
    throw new OpsError(
      'ACTOR_NOT_MEMBER',
      `${args.actorEmail} has no membership in tenant "${tenant.slug}"`,
    );
  }
  actor.roles = memberships.map((row) => row.role.name);

  const plan = { tenant, actor, products: [], deleteDemo: [], deleteTest: [] };

  if (args.deleteTest) {
    plan.deleteTest = await deletionTargets(
      prisma,
      tenant.id,
      PRODUCTS.map((spec) => spec.name),
    );
  } else {
    const defaultList = await prisma.globalPriceList.findFirst({
      where: { isDefault: true },
      select: { name: true },
    });
    if (!defaultList) {
      throw new OpsError(
        'DEFAULT_PRICE_LIST_MISSING',
        'no global price list is marked isDefault',
      );
    }
    plan.defaultPriceList = defaultList.name;
    const refs = {
      categories: await byName(
        prisma.category,
        PRODUCTS.map((spec) => spec.cat),
      ),
      brands: await byName(
        prisma.brand,
        PRODUCTS.map((spec) => spec.brand),
      ),
    };
    for (const spec of PRODUCTS) {
      const body = productBody(spec, refs);
      // Validated in the dry run too, so a bad spec fails before --apply.
      await validateBody(dist, dist.CreateProductDto, body, spec.name);
      await validateBody(
        dist,
        dist.PutPackagingDto,
        spec.packaging,
        `${spec.name} packaging`,
      );
      const existing = await prisma.product.findFirst({
        where: { tenantId: tenant.id, name: spec.name },
        select: { id: true },
      });
      const hasPackaging = existing
        ? (await prisma.productPackaging.count({
            where: { tenantId: tenant.id, productId: existing.id },
          })) > 0
        : false;
      plan.products.push({ spec, body, existing, hasPackaging });
    }
  }
  if (args.deleteDemo) {
    plan.deleteDemo = await deletionTargets(prisma, tenant.id, DEMO_NAMES);
  }
  return plan;
}

const dims = ({ weightG, lengthCm, widthCm, heightCm }) =>
  `${weightG} g ${lengthCm}×${widthCm}×${heightCm} cm`;

function printPlan(plan, args) {
  const { tenant, actor } = plan;
  console.log(`Tenant: ${tenant.slug} (${tenant.name}) ${tenant.id}`);
  console.log(`Actor: ${actor.name} [${actor.roles.join(', ')}]`);
  if (plan.defaultPriceList) {
    console.log(`Default price list: ${plan.defaultPriceList}`);
  }
  for (const { spec, body, existing, hasPackaging } of plan.products) {
    if (existing) {
      const note = hasPackaging ? '' : ' — packaging missing, will be set';
      console.log(`  SKIP   ${spec.name} (exists ${existing.id})${note}`);
      continue;
    }
    const refs = [
      body.categoryId ? `cat ${spec.cat}` : `cat ${spec.cat} (not found, none)`,
      body.brandId
        ? `brand ${spec.brand}`
        : `brand ${spec.brand} (not found, none)`,
    ];
    console.log(
      `  CREATE ${spec.name}\n         $${spec.price} ${body.ivaRate}, stock ${STOCK}, ${dims(spec.packaging)}, online catalog; ${refs.join(', ')}`,
    );
  }
  for (const [label, targets] of [
    ['demo', plan.deleteDemo],
    ['test', plan.deleteTest],
  ]) {
    for (const target of targets) {
      if (!target.id) {
        console.log(`  ABSENT ${target.name} (${label})`);
      } else if (target.sales > 0) {
        console.log(
          `  KEEP   ${target.name} (${label}, ${target.sales} sale item(s))`,
        );
      } else {
        console.log(`  DELETE ${target.name} (${label}, ${target.id})`);
      }
    }
  }
  if (!args.apply) console.log('Dry run: nothing written. Add --apply.');
}

// ── Apply (application services) ───────────────────────────────────────────

async function bootApp(dist) {
  const { NestFactory } = appRequire('@nestjs/core');
  const { SchedulerRegistry } = appRequire('@nestjs/schedule');
  const { AppModule } = dist.dist('app.module');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
    abortOnError: false,
  });
  // The running API owns the outbox pollers; this one-off process must not
  // compete with them.
  const scheduler = app.get(SchedulerRegistry);
  for (const name of scheduler.getIntervals()) scheduler.deleteInterval(name);
  for (const name of scheduler.getTimeouts()) scheduler.deleteTimeout(name);
  for (const name of scheduler.getCronJobs().keys()) {
    scheduler.deleteCronJob(name);
  }
  return app;
}

async function apply(app, dist, args) {
  const get = (file, name) => app.get(dist.dist(file)[name], { strict: false });
  const prisma = get('shared/prisma/prisma.service', 'PrismaService');
  const products = get('products/products.service', 'ProductsService');
  const packaging = get(
    'shipping/packaging/application/product-packaging.service',
    'ProductPackagingService',
  );
  const abilities = get(
    'auth/authorization/casl-ability.factory',
    'CaslAbilityFactory',
  );
  const cls = app.get(appRequire('nestjs-cls').ClsService);

  // Re-read with the app's own client right before writing.
  const plan = await buildPlan(prisma, dist, args);
  printPlan(plan, args);
  const { tenant, actor } = plan;

  // Same permission checks as the PermissionsGuard on the HTTP routes.
  const ability = await abilities.createForUser(actor.id, {
    tenantId: tenant.id,
    isSuperAdmin: false,
  });
  const needed = [];
  if (plan.products.length) needed.push('create', 'update');
  if (plan.deleteDemo.length || plan.deleteTest.length) needed.push('delete');
  const missing = needed.filter((action) => !ability.can(action, 'Product'));
  if (missing.length) {
    throw new OpsError(
      'ACTOR_FORBIDDEN',
      `${args.actorEmail} lacks ${missing.join(', ')} on Product in "${tenant.slug}"`,
    );
  }

  // The CLS keys TenantContextGuard sets for an authenticated request.
  const asActor = (work) =>
    cls.run(async () => {
      cls.set('userId', actor.id);
      cls.set('tenantId', tenant.id);
      cls.set('tenantSlug', tenant.slug);
      cls.set('isSuperAdmin', false);
      return work();
    });

  const summary = { created: 0, skipped: 0, packagingSet: 0, deleted: 0 };
  for (const entry of plan.products) {
    const { spec, existing, hasPackaging } = entry;
    let productId = existing?.id;
    if (!existing) {
      const body = await validateBody(
        dist,
        dist.CreateProductDto,
        entry.body,
        spec.name,
      );
      productId = (await asActor(() => products.create(body))).id;
      summary.created += 1;
      console.log(`  created ${spec.name} ${productId}`);
    } else {
      summary.skipped += 1;
    }
    if (!existing || !hasPackaging) {
      const body = await validateBody(
        dist,
        dist.PutPackagingDto,
        spec.packaging,
        `${spec.name} packaging`,
      );
      await asActor(() => packaging.putProduct(productId, body));
      summary.packagingSet += 1;
    }
  }
  for (const target of [...plan.deleteDemo, ...plan.deleteTest]) {
    if (!target.id || target.sales > 0) continue;
    await asActor(() => products.remove(target.id));
    summary.deleted += 1;
    console.log(`  deleted ${target.name} ${target.id}`);
  }
  console.log(`Done: ${JSON.stringify(summary)}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      'node scripts/ops/load-test-products.cjs --tenant <slug> --actor-email <email> [--apply] [--delete-demo] [--delete-test]',
    );
    return;
  }
  const dist = loadDist();
  if (!process.env.DATABASE_URL) {
    // Dev convenience; production gets DATABASE_URL from the container env.
    try {
      process.loadEnvFile(path.join(APP_ROOT, '.env'));
    } catch {
      // No .env: databaseTarget() reports the missing variable.
    }
  }
  console.log(
    `${args.apply ? 'APPLY' : 'DRY RUN'} on ${databaseTarget()} (NODE_ENV=${process.env.NODE_ENV ?? 'unset'})`,
  );

  if (!args.apply) {
    const { PrismaClient } = appRequire('@prisma/client');
    const prisma = new PrismaClient();
    try {
      printPlan(await buildPlan(prisma, dist, args), args);
    } finally {
      await prisma.$disconnect();
    }
    return;
  }
  const app = await bootApp(dist);
  try {
    await apply(app, dist, args);
  } finally {
    await app.close();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    const response = err?.getResponse?.();
    const message =
      typeof response === 'object' && response?.message
        ? JSON.stringify(response.message)
        : String(err?.message ?? err);
    const code = err?.code ?? err?.name ?? 'ERROR';
    console.error(`FAILED ${code}: ${message.slice(0, 1000)}`);
    process.exit(1);
  },
);
