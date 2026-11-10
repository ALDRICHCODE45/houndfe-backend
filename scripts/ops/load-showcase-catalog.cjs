// Ops › load showcase catalog: loads the realistic demo catalog of
// scripts/ops/showcase-catalog/products/ into one tenant through the
// backend's own application services, then publishes each product's editorial
// document and turns on the tenant catalog switch.
//
// Per product: ProductsService.create (variants and INITIAL stock in the
// inventory journal, public and Mayoreo prices), bulkUpsertVariantPrices
// (each variant's own prices), ProductPackagingService.putProduct, images
// downloaded and uploaded with ProductsService.uploadProductImage (the
// POST /products/:id/images/upload path, Spaces), and the editorial writers
// (initialize → save → readiness → publish) the editorial HTTP routes use.
//
// Runs against the COMPILED app: run it from the app root (the directory that
// holds dist/, node_modules/ and prisma/), e.g. /app inside the container.
// Without --apply it is a dry run: it only reads (DB and image HEAD requests),
// validates every product, prints the plan and never boots Nest.
//
//   node scripts/ops/load-showcase-catalog.cjs --tenant <slug> --actor-email <email>
//        [--apply] [--grant] [--delete] [--fixture] [--only <key,...>]
//        [--manifest <path>] [--image-mode upload|url] [--skip-image-check]
//        [--catalog-switch on|off|keep]
//
// Every product and variant SKU starts with «SC-»: that is the only marker,
// invisible in the public catalog. --delete removes every SC- product of the
// tenant (unsold only) with its images and editorial state.
// Idempotent: a product whose SKU exists is skipped; its editorial is only
// completed if it was never published.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const core = require('./showcase-catalog/engine/core.cjs');
const {
  downloadImage,
  mapLimit,
  probeImage,
} = require('./showcase-catalog/engine/images.cjs');

const APP_ROOT = process.cwd();
const appRequire = createRequire(path.join(APP_ROOT, 'package.json'));

const MAYOREO = 'Mayoreo';
const SUPER_ADMIN = 'Super Admin';
// ProductEditorialDraft has no `create` action: `update` is «Create and save
// product editorial drafts» (editorial-permissions.ts).
const GRANTS = [
  { subject: 'ProductEditorialDraft', action: 'read' },
  { subject: 'ProductEditorialDraft', action: 'update' },
  { subject: 'ProductEditorialDraft', action: 'publish' },
  { subject: 'TenantCatalogSettings', action: 'update' },
];
const USAGE =
  'node scripts/ops/load-showcase-catalog.cjs --tenant <slug> --actor-email <email> [--apply] [--grant] [--delete] [--fixture] [--only <key,...>] [--manifest <path>] [--image-mode upload|url] [--skip-image-check] [--catalog-switch on|off|keep]';

class OpsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function parseArgs(argv) {
  const args = {
    apply: false,
    grant: false,
    delete: false,
    fixture: false,
    skipImageCheck: false,
    help: false,
    imageMode: 'upload',
  };
  const flags = {
    '--apply': 'apply',
    '--grant': 'grant',
    '--delete': 'delete',
    '--fixture': 'fixture',
    '--skip-image-check': 'skipImageCheck',
    '--help': 'help',
  };
  const values = {
    '--tenant': 'tenant',
    '--actor-email': 'actorEmail',
    '--only': 'only',
    '--manifest': 'manifest',
    '--image-mode': 'imageMode',
    '--catalog-switch': 'catalogSwitch',
  };
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
  if (!['upload', 'url'].includes(args.imageMode)) {
    throw new OpsError('BAD_ARGS', '--image-mode is upload or url');
  }
  args.catalogSwitch ??= args.delete ? 'keep' : 'on';
  if (!['on', 'off', 'keep'].includes(args.catalogSwitch)) {
    throw new OpsError('BAD_ARGS', '--catalog-switch is on, off or keep');
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
      dist,
      createAppValidationPipe: dist('shared/listing/app-validation.pipe')
        .createAppValidationPipe,
      CreateProductDto: dist('products/dto/create-product.dto')
        .CreateProductDto,
      BulkUpsertVariantPricesDto: dist('products/dto/variant-price.dto')
        .BulkUpsertVariantPricesDto,
      PutPackagingDto: dist('shipping/packaging/dto/packaging.dto')
        .PutPackagingDto,
      UpdateCatalogSettingsDto: dist(
        'catalog-settings/dto/update-catalog-settings.dto',
      ).UpdateCatalogSettingsDto,
      CreateCategoryDto: dist('categories/dto/create-category.dto')
        .CreateCategoryDto,
      CreateBrandDto: dist('brands/dto/create-brand.dto').CreateBrandDto,
      CreatePriceListDto: dist('price-lists/dto/create-price-list.dto')
        .CreatePriceListDto,
      PrismaEditorialVocabularySnapshot: dist(
        'catalog-editorial/infrastructure/prisma-editorial-vocabulary-snapshot',
      ).PrismaEditorialVocabularySnapshot,
      readEditorialVocabulary: dist(
        'catalog-editorial/application/editorial-vocabulary-read',
      ).readEditorialVocabulary,
      hasGlobalEditorialAdministrator: dist(
        'catalog-editorial/infrastructure/editorial-administrator-authority',
      ).hasGlobalEditorialAdministrator,
      createEditorialWriteRequestV2: dist(
        'catalog-editorial/application/editorial-write-request-v2',
      ).createEditorialWriteRequestV2,
      EditorialPublicationNotReadyError: dist(
        'catalog-editorial/application/editorial-publish-writer',
      ).EditorialPublicationNotReadyError,
    };
  } catch (err) {
    throw new OpsError(
      'DIST_MISSING',
      `cannot load the compiled app from ${APP_ROOT}/dist (run from the app root after a build): ${err.message}`,
    );
  }
}

function loadProducts(args) {
  const file = args.fixture
    ? './showcase-catalog/engine/fixture.cjs'
    : './showcase-catalog/products/index.cjs';
  const products = require(file);
  try {
    return { source: file, products: core.selectProducts(products, args.only) };
  } catch (err) {
    throw new OpsError('BAD_ARGS', err.message);
  }
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

// ── Plan (read-only) ───────────────────────────────────────────────────────

async function resolveTenantActor(prisma, dist, args) {
  const tenant = await prisma.tenant.findUnique({
    where: { slug: args.tenant },
    select: {
      id: true,
      slug: true,
      name: true,
      isActive: true,
      catalogPublished: true,
      catalogRequiresPublishedEditorial: true,
    },
  });
  if (!tenant)
    throw new OpsError('TENANT_NOT_FOUND', `tenant "${args.tenant}"`);
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
    select: {
      role: {
        select: {
          name: true,
          permissions: {
            select: { permission: { select: { subject: true, action: true } } },
          },
        },
      },
    },
  });
  if (memberships.length === 0) {
    throw new OpsError(
      'ACTOR_NOT_MEMBER',
      `${args.actorEmail} has no membership in tenant "${tenant.slug}"`,
    );
  }
  actor.roles = memberships.map((row) => row.role.name);
  const granted = memberships.flatMap((row) =>
    row.role.permissions.map(
      ({ permission }) => `${permission.subject}:${permission.action}`,
    ),
  );
  // Same rule as PrismaEditorialAuthority: a global editorial administrator,
  // manage:all, or the exact read + update + publish rows.
  actor.editorial =
    (await dist.hasGlobalEditorialAdministrator(prisma, actor.id)) ||
    granted.includes('all:manage') ||
    ['read', 'update', 'publish'].every((action) =>
      granted.includes(`ProductEditorialDraft:${action}`),
    );
  return { tenant, actor };
}

async function loadVocabulary(prisma, dist) {
  const body = await dist.readEditorialVocabulary(
    new dist.PrismaEditorialVocabularySnapshot(prisma),
  );
  return { revision: body.vocabularyRevision, vocabulary: body.vocabulary };
}

async function priceLists(prisma, tenantId) {
  const defaultList = await prisma.globalPriceList.findFirst({
    where: { isDefault: true },
    select: { id: true, name: true },
  });
  if (!defaultList) {
    throw new OpsError(
      'DEFAULT_PRICE_LIST_MISSING',
      'no global price list is marked isDefault',
    );
  }
  const mayoreo = await prisma.globalPriceList.findFirst({
    where: { name: { equals: MAYOREO, mode: 'insensitive' } },
    select: { id: true, name: true },
  });
  const bindings = await prisma.tenantCatalogPriceList.findMany({
    where: { tenantId },
    select: {
      globalPriceListId: true,
      isCatalogDefault: true,
      globalPriceList: { select: { name: true } },
    },
  });
  const catalogDefault = bindings.find((row) => row.isCatalogDefault) ?? null;
  return { defaultList, mayoreo, bindings, catalogDefault };
}

async function switchCounts(prisma, tenantId) {
  const online = await prisma.product.count({
    where: { tenantId, type: 'PRODUCT', includeInOnlineCatalog: true },
  });
  const [{ count }] = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS count FROM catalog_editorial_states s
      JOIN products p ON p."tenantId" = s."tenantId" AND p.id = s."productId"
     WHERE s."tenantId" = ${tenantId} AND s."publishedRevision" IS NOT NULL
       AND (s."publishedDocument"->>'schemaVersion') = '2'
       AND p.type = 'PRODUCT' AND p."includeInOnlineCatalog" = true`;
  return { online, published: count, hidden: online - count };
}

async function deletionTargets(prisma, tenantId) {
  const rows = core.showcaseProducts(
    await prisma.product.findMany({
      where: {
        tenantId,
        sku: { startsWith: core.SKU_PREFIX },
      },
      select: { id: true, name: true, sku: true },
      orderBy: { sku: 'asc' },
    }),
  );
  for (const row of rows) {
    const where = { productId: row.id };
    row.blockers =
      (await prisma.saleItem.count({ where })) +
      (await prisma.quotationItem.count({ where })) +
      (await prisma.orderItem.count({ where }));
    row.images = await prisma.productImage.count({ where });
  }
  return rows;
}

async function grantPlan(prisma) {
  const role = await prisma.role.findFirst({
    where: { name: SUPER_ADMIN, tenantId: null },
    select: { id: true, permissions: { select: { permission: true } } },
  });
  if (!role)
    throw new OpsError('ROLE_NOT_FOUND', `global role "${SUPER_ADMIN}"`);
  const held = new Set(
    role.permissions.map(
      ({ permission }) => `${permission.subject}:${permission.action}`,
    ),
  );
  const rows = [];
  for (const grant of GRANTS) {
    const permission = await prisma.permission.findUnique({
      where: { subject_action: grant },
      select: { id: true },
    });
    if (!permission) {
      throw new OpsError(
        'PERMISSION_MISSING',
        `${grant.subject}:${grant.action} is not seeded`,
      );
    }
    rows.push({
      ...grant,
      permissionId: permission.id,
      held: held.has(`${grant.subject}:${grant.action}`),
    });
  }
  return { roleId: role.id, rows };
}

async function buildPlan(prisma, dist, args) {
  const { tenant, actor } = await resolveTenantActor(prisma, dist, args);
  const plan = { tenant, actor, products: [], deletions: [], grant: null };
  if (args.grant) plan.grant = await grantPlan(prisma);
  plan.counts = await switchCounts(prisma, tenant.id);
  if (args.delete) {
    plan.deletions = await deletionTargets(prisma, tenant.id);
    return plan;
  }

  const { source, products } = loadProducts(args);
  plan.source = source;
  const { revision, vocabulary } = await loadVocabulary(prisma, dist);
  plan.vocabularyRevision = revision;
  plan.vocabulary = vocabulary;
  plan.lists = await priceLists(prisma, tenant.id);

  // Products of the data set that already exist (by SKU) are skipped; any
  // other product of the tenant holding one of our SKUs is a conflict.
  const skus = core
    .catalogSkus(products)
    .filter(Boolean)
    .map((sku) => String(sku).toUpperCase());
  const existing = await prisma.product.findMany({
    where: {
      tenantId: tenant.id,
      sku: { in: products.map((spec) => spec.sku).filter(Boolean) },
    },
    select: {
      id: true,
      sku: true,
      variants: { select: { id: true, sku: true } },
    },
  });
  const existingBySku = new Map(existing.map((row) => [row.sku, row]));
  const ownIds = new Set(existing.map((row) => row.id));
  const takenProducts = await prisma.product.findMany({
    where: {
      tenantId: tenant.id,
      sku: { in: skus },
      id: { notIn: [...ownIds] },
    },
    select: { sku: true },
  });
  const takenVariants = await prisma.variant.findMany({
    where: {
      tenantId: tenant.id,
      sku: { in: skus },
      productId: { notIn: [...ownIds] },
    },
    select: { sku: true },
  });
  const problems = core.validateCatalog(products, vocabulary, {
    existingSkus: [...takenProducts, ...takenVariants].map((row) => row.sku),
  });
  if (problems.length) {
    throw new OpsError(
      'VALIDATION_FAILED',
      `${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`,
    );
  }

  const names = (field) => [...new Set(products.map((spec) => spec[field]))];
  const byName = async (delegate, list) =>
    new Map(
      (
        await delegate.findMany({
          where: { name: { in: list } },
          select: { id: true, name: true },
        })
      ).map((row) => [row.name, row.id]),
    );
  plan.categories = await byName(prisma.category, names('category'));
  plan.brands = await byName(prisma.brand, names('brand'));
  plan.missingCategories = names('category').filter(
    (name) => !plan.categories.has(name),
  );
  plan.missingBrands = names('brand').filter((name) => !plan.brands.has(name));

  // Ids the DTO validation needs; placeholders stand in for rows the apply
  // run creates first (Mayoreo, categories, brands).
  const placeholder = '00000000-0000-4000-8000-000000000000';
  const lists = listIds(plan.lists, placeholder);
  for (const spec of products) {
    const row = existingBySku.get(spec.sku) ?? null;
    const body = core.productBody(
      spec,
      {
        categoryId: plan.categories.get(spec.category) ?? placeholder,
        brandId: plan.brands.get(spec.brand) ?? placeholder,
      },
      lists,
    );
    await validateBody(dist, dist.CreateProductDto, body, spec.key);
    await validateBody(
      dist,
      dist.PutPackagingDto,
      { ...spec.packaging },
      `${spec.key} packaging`,
    );
    let state = null;
    if (row) {
      state = await prisma.catalogEditorialState.findUnique({
        where: {
          tenantId_productId: { tenantId: tenant.id, productId: row.id },
        },
        select: { publishedRevision: true },
      });
    }
    plan.products.push({
      spec,
      existing: row,
      published: state?.publishedRevision != null,
    });
  }

  if (!args.apply && !args.skipImageCheck) {
    const checks = plan.products
      .filter((entry) => !entry.existing)
      .flatMap((entry) =>
        entry.spec.images.map((image) => ({
          key: entry.spec.key,
          url: image.url,
        })),
      );
    plan.imageFailures = (
      await mapLimit(checks, 1, async (check) => {
        try {
          await probeImage(check.url);
          return null;
        } catch (err) {
          return `${check.key}: ${check.url} — ${err.message}`;
        }
      })
    ).filter(Boolean);
    plan.imagesChecked = checks.length;
  }
  return plan;
}

/** Global price-list ids the product bodies use. */
function listIds(lists, fallback) {
  return {
    defaultId: lists.defaultList.id,
    catalogDefaultId:
      lists.catalogDefault?.globalPriceListId ?? lists.defaultList.id,
    mayoreoId: lists.mayoreo?.id ?? fallback,
  };
}

const dims = ({ weightG, lengthCm, widthCm, heightCm }) =>
  `${weightG} g ${lengthCm}×${widthCm}×${heightCm} cm`;

function printSwitch(counts) {
  console.log(
    `Online catalog: ${counts.online} product(s), ${counts.published} with Published editorial V2 → ${counts.hidden} hidden while catalogRequiresPublishedEditorial is on`,
  );
}

function printPlan(plan, args) {
  const { tenant, actor } = plan;
  console.log(`Tenant: ${tenant.slug} (${tenant.name}) ${tenant.id}`);
  console.log(
    `  catalogPublished=${tenant.catalogPublished} catalogRequiresPublishedEditorial=${tenant.catalogRequiresPublishedEditorial}`,
  );
  console.log(
    `Actor: ${actor.name} [${actor.roles.join(', ')}] editorial=${actor.editorial ? 'yes' : 'NO'}`,
  );
  printSwitch(plan.counts);
  if (plan.grant) {
    for (const row of plan.grant.rows) {
      console.log(
        `  GRANT  ${SUPER_ADMIN} ${row.subject}:${row.action}${row.held ? ' (already held)' : ''}`,
      );
    }
  }
  if (args.delete) {
    if (plan.deletions.length === 0)
      console.log('  No SC- products in this tenant.');
    for (const row of plan.deletions) {
      if (row.blockers > 0) {
        console.log(
          `  KEEP   ${row.sku} ${row.name} (${row.blockers} sale/quotation/order line(s))`,
        );
      } else {
        console.log(
          `  DELETE ${row.sku} ${row.name} (${row.id}, ${row.images} image(s))`,
        );
      }
    }
  } else {
    const { lists } = plan;
    console.log(`Data: ${plan.source} (${plan.products.length} product(s))`);
    console.log(`Vocabulary: ${plan.vocabularyRevision}`);
    console.log(
      `Price lists: default ${lists.defaultList.name}; catalog default ${lists.catalogDefault?.globalPriceList.name ?? '(none: will be ' + lists.defaultList.name + ')'}; ${MAYOREO} ${lists.mayoreo ? 'exists' : 'will be created'}${lists.mayoreo && lists.bindings.some((row) => row.globalPriceListId === lists.mayoreo.id) ? ', public' : ', will be made public'}`,
    );
    if (plan.missingCategories.length) {
      console.log(
        `  Categories to create: ${plan.missingCategories.join(', ')}`,
      );
    }
    if (plan.missingBrands.length) {
      console.log(`  Brands to create: ${plan.missingBrands.join(', ')}`);
    }
    for (const { spec, existing, published } of plan.products) {
      if (existing) {
        console.log(
          `  SKIP   ${spec.sku} ${spec.name} (exists ${existing.id})${published ? '' : ' — editorial not published, will be completed'}`,
        );
        continue;
      }
      const variants = spec.variants ?? [];
      const stock = variants.length
        ? variants.map((v) => `${v.key}:${v.stock}`).join(' ')
        : `${spec.stock}`;
      console.log(
        `  CREATE ${spec.sku} ${spec.name}\n         $${spec.price} / Mayoreo $${spec.mayoreo}, stock ${stock}, ${dims(spec.packaging)}, ${spec.images.length} image(s), editorial ${spec.editorial.familyCode} (${spec.editorial.values.length} values)`,
      );
    }
    if (plan.imagesChecked !== undefined) {
      console.log(
        `Images: ${plan.imagesChecked} checked, ${plan.imageFailures.length} failed`,
      );
      for (const failure of plan.imageFailures)
        console.log(`  IMAGE  ${failure}`);
    }
  }
  console.log(`Catalog switch: ${args.catalogSwitch}`);
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

function services(app, dist) {
  const get = (file, name) => app.get(dist.dist(file)[name], { strict: false });
  const token = (file, name) =>
    app.get(dist.dist(`catalog-editorial/application/${file}`)[name], {
      strict: false,
    });
  return {
    prisma: get('shared/prisma/prisma.service', 'PrismaService'),
    products: get('products/products.service', 'ProductsService'),
    packaging: get(
      'shipping/packaging/application/product-packaging.service',
      'ProductPackagingService',
    ),
    categories: get('categories/categories.service', 'CategoriesService'),
    brands: get('brands/brands.service', 'BrandsService'),
    priceLists: get('price-lists/price-lists.service', 'PriceListsService'),
    catalogSettings: get(
      'catalog-settings/application/update-catalog-settings.use-case',
      'UpdateCatalogSettingsUseCase',
    ),
    abilities: get(
      'auth/authorization/casl-ability.factory',
      'CaslAbilityFactory',
    ),
    reader: token('editorial-document-reader', 'EDITORIAL_DOCUMENT_READER'),
    readiness: token(
      'editorial-readiness-reader',
      'EDITORIAL_READINESS_READER',
    ),
    initialize: token(
      'editorial-initialize-writer',
      'EDITORIAL_INITIALIZE_WRITER',
    ),
    save: token('editorial-save-writer', 'EDITORIAL_SAVE_WRITER'),
    publish: token('editorial-publish-writer', 'EDITORIAL_PUBLISH_WRITER'),
    cls: app.get(appRequire('nestjs-cls').ClsService),
  };
}

/** CASL checks the HTTP routes would make, before any write. */
async function assertAllowed(svc, plan, args) {
  const { tenant, actor } = plan;
  const ability = await svc.abilities.createForUser(actor.id, {
    tenantId: tenant.id,
    isSuperAdmin: false,
  });
  const needed = [];
  if (args.delete) needed.push(['delete', 'Product'], ['update', 'Product']);
  else {
    needed.push(['create', 'Product'], ['update', 'Product']);
    if (plan.missingCategories.length) needed.push(['create', 'Category']);
    if (plan.missingBrands.length) needed.push(['create', 'Brand']);
    if (!plan.lists.mayoreo) needed.push(['create', 'GlobalPriceList']);
    needed.push(['update', 'TenantCatalogSettings']);
  }
  if (args.catalogSwitch !== 'keep')
    needed.push(['update', 'TenantCatalogSettings']);
  const missing = needed.filter(
    ([action, subject]) => !ability.can(action, subject),
  );
  if (missing.length) {
    throw new OpsError(
      'ACTOR_FORBIDDEN',
      `${args.actorEmail} lacks ${missing.map((pair) => pair.join(':')).join(', ')} in "${tenant.slug}"`,
    );
  }
  if (!args.delete && !actor.editorial && !args.grant) {
    throw new OpsError(
      'ACTOR_FORBIDDEN',
      `${args.actorEmail} cannot read, save and publish editorial (try --grant)`,
    );
  }
}

async function applyGrant(svc, plan) {
  for (const row of plan.grant.rows) {
    // Additive, like PermissionSeeder: never replaces the role's other rows.
    await svc.prisma.rolePermission.upsert({
      where: {
        roleId_permissionId: {
          roleId: plan.grant.roleId,
          permissionId: row.permissionId,
        },
      },
      update: {},
      create: { roleId: plan.grant.roleId, permissionId: row.permissionId },
    });
    console.log(
      `  granted ${SUPER_ADMIN} ${row.subject}:${row.action}${row.held ? ' (already held)' : ''}`,
    );
  }
}

/** Mayoreo exists and is public in the tenant, with a catalog default. */
async function ensurePriceContexts(svc, dist, plan, asActor) {
  const { tenant, actor, lists } = plan;
  if (!lists.mayoreo) {
    const body = await validateBody(
      dist,
      dist.CreatePriceListDto,
      { name: MAYOREO },
      MAYOREO,
    );
    lists.mayoreo = await asActor(() => svc.priceLists.create(body));
    console.log(`  created global price list ${MAYOREO} ${lists.mayoreo.id}`);
  }
  const publicIds = lists.bindings.map((row) => row.globalPriceListId);
  const data = {};
  if (!publicIds.includes(lists.mayoreo.id))
    data.publicPriceListIds = [...publicIds, lists.mayoreo.id];
  if (!lists.catalogDefault) {
    data.publicPriceListIds = [
      ...new Set([
        ...(data.publicPriceListIds ?? publicIds),
        lists.defaultList.id,
      ]),
    ];
    data.catalogDefaultPriceListId = lists.defaultList.id;
  }
  if (Object.keys(data).length === 0) return;
  const body = await validateBody(
    dist,
    dist.UpdateCatalogSettingsDto,
    data,
    'catalog price contexts',
  );
  const result = await svc.catalogSettings.execute({
    tenantId: tenant.id,
    actorUserId: actor.id,
    data: body,
  });
  console.log(
    `  price contexts: ${result.priceContexts.map((row) => row.name + (row.isCatalogDefault ? ' (default)' : '')).join(', ')}`,
  );
  const fresh = await priceLists(svc.prisma, tenant.id);
  Object.assign(lists, fresh);
}

async function ensureNamed(svc, dist, plan, asActor) {
  for (const name of plan.missingCategories) {
    const body = await validateBody(
      dist,
      dist.CreateCategoryDto,
      { name },
      `category ${name}`,
    );
    plan.categories.set(
      name,
      (await asActor(() => svc.categories.create(body))).id,
    );
    console.log(`  created category ${name}`);
  }
  for (const name of plan.missingBrands) {
    const body = await validateBody(
      dist,
      dist.CreateBrandDto,
      { name },
      `brand ${name}`,
    );
    plan.brands.set(name, (await asActor(() => svc.brands.create(body))).id);
    console.log(`  created brand ${name}`);
  }
}

async function addImages(
  svc,
  entry,
  productId,
  actorId,
  args,
  asActor,
  record,
) {
  let first = null;
  for (const [index, image] of entry.spec.images.entries()) {
    const credit = {
      url: image.url,
      credit: image.credit,
      license: image.license,
      sourcePage: image.sourcePage,
    };
    try {
      let stored;
      if (args.imageMode === 'upload') {
        try {
          const file = await downloadImage(
            image.url,
            `${entry.spec.sku}-${index + 1}`,
          );
          stored = await asActor(() =>
            svc.products.uploadProductImage(productId, file, actorId),
          );
          record.push({
            ...credit,
            mode: 'upload',
            storedUrl: stored.url,
            imageId: stored.id,
          });
        } catch (err) {
          // Spaces unavailable (or the source refused the download): keep
          // the original URL so the product is not left without its image.
          console.log(
            `    image ${index + 1}: upload failed (${err.message}); using the source URL`,
          );
          stored = await asActor(() =>
            svc.products.addImage(productId, {
              url: image.url,
              sortOrder: index,
            }),
          );
          record.push({
            ...credit,
            mode: 'url-fallback',
            storedUrl: image.url,
            imageId: stored.id,
            error: err.message,
          });
        }
      } else {
        stored = await asActor(() =>
          svc.products.addImage(productId, {
            url: image.url,
            sortOrder: index,
          }),
        );
        record.push({
          ...credit,
          mode: 'url',
          storedUrl: image.url,
          imageId: stored.id,
        });
      }
      first ??= stored.id;
    } catch (err) {
      console.log(`    image ${index + 1}: FAILED ${err.message}`);
      record.push({ ...credit, mode: 'failed', error: err.message });
    }
  }
  if (first) await asActor(() => svc.products.setMainImage(productId, first));
}

function writeRequest(dist, operation, revision, careConfirmation, body) {
  return dist.createEditorialWriteRequestV2(
    operation,
    { vocabularyRevision: revision, careConfirmation },
    body,
  );
}

/**
 * initialize → save → readiness → publish, through the in-container writers.
 * Returns `{ status, revision?, items? }` and never throws for a product
 * that is simply not ready.
 */
async function runEditorial(svc, dist, plan, context, spec, variantIds, runId) {
  const revision = plan.vocabularyRevision;
  const key = (operation) =>
    core.idempotencyKeyFor(runId, context.productId, operation);
  let { state } = await svc.reader.read(context, revision);
  if (state.published)
    return { status: 'already-published', revision: state.published.revision };
  if (!state.draft) {
    const result = await svc.initialize.initialize(
      context,
      key('initialize'),
      writeRequest(dist, 'initialize', revision, null, {
        expectedCycle: state.cycle,
      }),
    );
    state = result.body.state;
  }
  const document = core.editorialDocument(
    spec,
    plan.vocabulary,
    variantIds,
    core.isoDay(),
  );
  const saved = await svc.save.save(
    context,
    key('save'),
    writeRequest(dist, 'save', revision, null, {
      expectedCycle: state.cycle,
      expectedRevision: state.draft.revision,
      document,
    }),
  );
  state = saved.body.state;
  const readiness = await svc.readiness.read(context, revision);
  if (!readiness.ready) return { status: 'not-ready', items: readiness.items };
  try {
    const published = await svc.publish.publish(
      context,
      key('publish'),
      writeRequest(
        dist,
        'publish',
        revision,
        core.careConfirmationFor(spec.editorial.familyCode),
        {
          expectedCycle: state.cycle,
          expectedRevision: state.draft.revision,
        },
      ),
    );
    return {
      status: 'published',
      revision: published.body.state.published.revision,
    };
  } catch (err) {
    if (err instanceof dist.EditorialPublicationNotReadyError) {
      return { status: 'not-ready', items: err.readiness.items };
    }
    throw err;
  }
}

async function loadOne(svc, dist, plan, args, entry, asActor, runId) {
  const { tenant, actor } = plan;
  const { spec } = entry;
  const record = { key: spec.key, sku: spec.sku, name: spec.name, images: [] };
  let productId = entry.existing?.id;
  const variantIds = new Map();
  if (entry.existing) {
    record.status = 'skipped';
    const bySku = new Map(
      entry.existing.variants.map((row) => [row.sku, row.id]),
    );
    for (const variant of spec.variants ?? [])
      variantIds.set(variant.key, bySku.get(variant.sku));
  } else {
    const lists = listIds(plan.lists);
    const body = await validateBody(
      dist,
      dist.CreateProductDto,
      core.productBody(
        spec,
        {
          categoryId: plan.categories.get(spec.category),
          brandId: plan.brands.get(spec.brand),
        },
        lists,
      ),
      spec.key,
    );
    const created = await asActor(() => svc.products.create(body));
    productId = created.id;
    record.status = 'created';
    console.log(`  created ${spec.sku} ${productId}`);
    if ((spec.variants ?? []).length) {
      const rows = await svc.prisma.variant.findMany({
        where: { tenantId: tenant.id, productId },
        select: { id: true, sku: true },
      });
      const bySku = new Map(rows.map((row) => [row.sku, row.id]));
      for (const variant of spec.variants)
        variantIds.set(variant.key, bySku.get(variant.sku));
      const productLists = new Map(
        (
          await svc.prisma.priceList.findMany({
            where: { tenantId: tenant.id, productId },
            select: { id: true, globalPriceListId: true },
          })
        ).map((row) => [row.globalPriceListId, row.id]),
      );
      for (const [variantKey, prices] of core.variantPriceBodies(
        spec,
        productLists,
        lists,
      )) {
        const priceBody = await validateBody(
          dist,
          dist.BulkUpsertVariantPricesDto,
          prices,
          `${spec.key}/${variantKey} prices`,
        );
        await asActor(() =>
          svc.products.bulkUpsertVariantPrices(
            productId,
            variantIds.get(variantKey),
            priceBody,
          ),
        );
      }
    }
    const packagingBody = await validateBody(
      dist,
      dist.PutPackagingDto,
      { ...spec.packaging },
      `${spec.key} packaging`,
    );
    await asActor(() => svc.packaging.putProduct(productId, packagingBody));
    await addImages(
      svc,
      entry,
      productId,
      actor.id,
      args,
      asActor,
      record.images,
    );
  }
  record.productId = productId;
  record.variants = Object.fromEntries(variantIds);
  if (entry.published) {
    record.editorial = { status: 'already-published' };
    console.log(`  ${spec.sku}: editorial already published`);
    return record;
  }
  try {
    record.editorial = await runEditorial(
      svc,
      dist,
      plan,
      { actorId: actor.id, tenantId: tenant.id, productId },
      spec,
      variantIds,
      runId,
    );
  } catch (err) {
    record.editorial = {
      status: 'error',
      error: `${err.name}: ${err.message}`,
    };
  }
  const keysById = new Map([...variantIds].map(([key, id]) => [id, key]));
  const { editorial } = record;
  console.log(
    `    editorial: ${editorial.status}${editorial.revision ? ' rev ' + editorial.revision : ''}${editorial.error ? ' — ' + editorial.error : ''}`,
  );
  for (const line of core.readinessLines(editorial.items ?? [], keysById))
    console.log(`      - ${line}`);
  return record;
}

async function deleteOne(svc, plan, row, asActor) {
  const { tenant } = plan;
  const images = await svc.prisma.productImage.findMany({
    where: { productId: row.id },
    select: { id: true, fileId: true },
  });
  let spaces = 0;
  for (const image of images) {
    // removeImage also deletes the FileObject and its Spaces object.
    await asActor(() => svc.products.removeImage(row.id, image.id));
    if (image.fileId) spaces += 1;
  }
  // No application service removes editorial state, and its FKs RESTRICT the
  // product delete: drop the receipts and the state of this product only.
  const where = { tenantId: tenant.id, productId: row.id };
  await svc.prisma.$transaction([
    svc.prisma.catalogEditorialCreateReceipt.deleteMany({ where }),
    svc.prisma.catalogEditorialSaveReceipt.deleteMany({ where }),
    svc.prisma.catalogEditorialPublishReceipt.deleteMany({ where }),
    svc.prisma.catalogEditorialDiscardReceipt.deleteMany({ where }),
    svc.prisma.catalogEditorialUnpublishReceipt.deleteMany({ where }),
    svc.prisma.catalogEditorialState.deleteMany({ where }),
  ]);
  await asActor(() => svc.products.remove(row.id));
  return { images: images.length, spaces };
}

async function setSwitch(svc, dist, plan, args) {
  if (args.catalogSwitch === 'keep') return;
  const data =
    args.catalogSwitch === 'on'
      ? { catalogPublished: true, catalogRequiresPublishedEditorial: true }
      : { catalogRequiresPublishedEditorial: false };
  const body = await validateBody(
    dist,
    dist.UpdateCatalogSettingsDto,
    data,
    'catalog switch',
  );
  const result = await svc.catalogSettings.execute({
    tenantId: plan.tenant.id,
    actorUserId: plan.actor.id,
    data: body,
  });
  console.log(
    `  catalog settings: catalogPublished=${result.catalogPublished} catalogRequiresPublishedEditorial=${result.catalogRequiresPublishedEditorial}`,
  );
}

function writeManifest(args, manifest) {
  const stamp = manifest.runAt.replace(/[:.]/g, '-');
  const file =
    args.manifest ??
    path.join('/tmp', `showcase-catalog-${args.tenant}-${stamp}.json`);
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Manifest: ${file}`);
}

async function apply(app, dist, args) {
  const svc = services(app, dist);
  // Re-read with the app's own client right before writing.
  const plan = await buildPlan(svc.prisma, dist, args);
  printPlan(plan, args);
  await assertAllowed(svc, plan, args);
  const { tenant, actor } = plan;

  // The CLS keys TenantContextGuard sets for an authenticated request.
  const asActor = (work) =>
    svc.cls.run(async () => {
      svc.cls.set('userId', actor.id);
      svc.cls.set('tenantId', tenant.id);
      svc.cls.set('tenantSlug', tenant.slug);
      svc.cls.set('isSuperAdmin', false);
      return work();
    });

  const runId = randomUUID().slice(0, 8);
  const manifest = {
    runAt: new Date().toISOString(),
    runId,
    tenant: { id: tenant.id, slug: tenant.slug },
    mode: args.delete ? 'delete' : 'load',
    source: plan.source ?? null,
    vocabularyRevision: plan.vocabularyRevision ?? null,
    products: [],
    deleted: [],
  };
  if (plan.grant) await applyGrant(svc, plan);

  if (args.delete) {
    for (const row of plan.deletions) {
      if (row.blockers > 0) {
        manifest.deleted.push({ ...row, status: 'kept' });
        continue;
      }
      try {
        const result = await deleteOne(svc, plan, row, asActor);
        manifest.deleted.push({
          id: row.id,
          sku: row.sku,
          status: 'deleted',
          ...result,
        });
        console.log(
          `  deleted ${row.sku} ${row.id} (${result.images} image(s), ${result.spaces} Spaces object(s))`,
        );
      } catch (err) {
        manifest.deleted.push({
          id: row.id,
          sku: row.sku,
          status: 'error',
          error: err.message,
        });
        console.log(`  FAILED  ${row.sku} ${row.id}: ${err.message}`);
      }
    }
  } else {
    await ensurePriceContexts(svc, dist, plan, asActor);
    await ensureNamed(svc, dist, plan, asActor);
    for (const entry of plan.products) {
      try {
        manifest.products.push(
          await loadOne(svc, dist, plan, args, entry, asActor, runId),
        );
      } catch (err) {
        manifest.products.push({
          key: entry.spec.key,
          sku: entry.spec.sku,
          status: 'error',
          error: err.message,
        });
        console.log(`  FAILED  ${entry.spec.sku}: ${err.message}`);
      }
    }
  }
  await setSwitch(svc, dist, plan, args);
  plan.counts = await switchCounts(svc.prisma, tenant.id);
  printSwitch(plan.counts);
  manifest.counts = plan.counts;
  writeManifest(args, manifest);

  const tally = (rows, field) =>
    rows.reduce(
      (acc, row) => ({ ...acc, [row[field]]: (acc[row[field]] ?? 0) + 1 }),
      {},
    );
  const summary = args.delete
    ? tally(manifest.deleted, 'status')
    : {
        products: tally(manifest.products, 'status'),
        editorial: tally(
          manifest.products.map((row) => ({
            s: row.editorial?.status ?? 'none',
          })),
          's',
        ),
      };
  console.log(`Done: ${JSON.stringify(summary)}`);
  const failed = args.delete
    ? manifest.deleted.some((row) => row.status === 'error')
    : manifest.products.some(
        (row) =>
          row.status === 'error' ||
          !['published', 'already-published'].includes(row.editorial?.status),
      );
  if (failed) process.exitCode = 2;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
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
      const plan = await buildPlan(prisma, dist, args);
      printPlan(plan, args);
      if (plan.imageFailures?.length) process.exitCode = 2;
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
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    const response = err?.getResponse?.();
    const message =
      typeof response === 'object' && response?.message
        ? JSON.stringify(response.message)
        : String(err?.message ?? err);
    const code = err?.code ?? err?.name ?? 'ERROR';
    console.error(`FAILED ${code}: ${message.slice(0, 4000)}`);
    process.exit(1);
  },
);
