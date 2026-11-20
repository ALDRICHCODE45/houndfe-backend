// Dev only: sample restock backorders («pedidos por reposición») in every
// state for the POS screens (odd/tasks/restock-backorder.md, T5b / L13). In
// Sucursal Centro, where manager@houndfe.com works, it leaves:
//
//   WAITING    — a head backorder passed over by later ones (passedOverCount 1)
//                and another waiting behind it.
//   RESERVED   — units really set aside: the journal holds a BACKORDER_RESERVE
//                row and the product's sellable `quantity` is already net of
//                them (reservedForBackorders > 0 on the product reads).
//   CONFIRMED  — reserved, then consumed by a CONFIRMED online sale (journal:
//                RESERVE, RELEASE, SALE; the backorder points at the sale).
//   EXPIRED    — reserved, not confirmed in 24 h (journal: RESERVE, RELEASE).
//   CANCELLED  — one cancelled by the customer and one by staff.
//
// Approach (documented choice): Prisma writes the SAME rows the allocator,
// the sweep and the bot checkout write, in one transaction per product
// (`stock_movements` rows with the BACKORDER group, product `quantity` and
// `stockVersion` moved by the same deltas). It does not call the HTTP API:
// the staff API cannot create backorders (owner Q5), the bot route needs a
// credential with `backorders:create` and an answered RESTOCK decision, and a
// RESERVED state cannot be produced reliably through HTTP without waiting for
// the sweep. The journal rows are checked against the real allocator output
// by `src/inventory/infrastructure/backorder-showcase.integration.spec.ts`.
// Three dedicated products (sku DEMO-BO-*) carry the stories, so the kardex of
// the catalog showcase products is never touched. No feed item and no staff
// notice is written: the sample customers get no bot message from the seed
// itself (the running sweep will still remind/expire the live RESERVED one
// ~18/~21 h after the run, like any real backorder: use fictional phones).
//
//   node scripts/dev-showcase/backorders.cjs            # dry run (reads only)
//   node scripts/dev-showcase/backorders.cjs --apply    # create what is missing
//
// Idempotent: every backorder has a fixed idempotency key
// (`showcase:backorder:<slug>`); one that exists is never touched or recreated,
// and a product story is written in one transaction, so a re-run creates
// nothing once the stories exist.
//
// Partial re-run (T8 d): a story is only ever created WHOLE, together with its
// product and its arrival, because every reserve/release step assumes the
// arrival's units are on the shelf. If a story's product (sku DEMO-BO-*) already
// exists but some of its backorder keys are missing (someone deleted a
// backorder, or the product was made by hand), the story is SKIPPED, in the dry
// run too: nothing is written for it and the output says so with a `⚠` line and
// in `report.skipped` (sku, missing slugs). The script never deletes anything,
// so recreating it is the operator's call: remove the product's demo backorders
// and the product (or the whole dev database) and re-run. Env: DATABASE_URL (from .env). Same
// local-database guard as the showcase (`SHOWCASE_ALLOW=1` only for a
// disposable remote database). Prints folios, ids and states only.
'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const TENANT_SLUG = 'centro';
const CASHIER_EMAIL = 'cashier@houndfe.com';
const MANAGER_EMAIL = 'manager@houndfe.com';
const KEY_PREFIX = 'showcase:backorder:';
const DECISION_SOURCE = 'showcase-backorders';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Journal actors, like the app: the system has no user; the bot checkout acts
// as `Bot` on behalf of the cashier user (`StockJournalWriter` actor).
const SYSTEM = 'system';
const BOT = 'bot';

/**
 * The stories. `at` are offsets (ms) from the run time; every product starts
 * with an INITIAL arrival, then each backorder follows its own timeline.
 * Prices are cents per unit.
 */
const PRODUCTS = [
  {
    slug: 'queue',
    sku: 'DEMO-BO-GATO',
    name: 'Alimento Gato Senior 7 kg (demo reposición)',
    priceCents: 48_900,
    arrivalUnits: 3,
    arrivalAt: -3 * HOUR,
    backorders: [
      {
        slug: 'waiting-head',
        status: 'WAITING',
        customer: ['Rosa', 'Mendoza Ibarra', '5500000911'],
        quantity: 10,
        scheduledAt: -4 * DAY,
        passedOverCount: 1,
      },
      {
        slug: 'reserved',
        status: 'RESERVED',
        customer: ['Luis', 'Ortega Salas', '5500000912'],
        quantity: 2,
        scheduledAt: -3 * DAY,
        // Arrival reserved it right away (journal RESERVE, 24 h to confirm).
        reservedAt: -3 * HOUR,
        currentPriceCents: 45_900,
        reservationStage: 0,
      },
      {
        slug: 'waiting-behind',
        status: 'WAITING',
        customer: ['Carmen', 'Vidal Pineda', '5500000913'],
        quantity: 4,
        scheduledAt: -2 * DAY,
        passedOverCount: 0,
      },
    ],
  },
  {
    slug: 'confirmed',
    sku: 'DEMO-BO-SHAMPOO',
    name: 'Shampoo Antipulgas 500 ml (demo reposición)',
    priceCents: 12_900,
    arrivalUnits: 6,
    arrivalAt: -2 * DAY,
    backorders: [
      {
        slug: 'confirmed',
        status: 'CONFIRMED',
        customer: ['Jorge', 'Salinas Rangel', '5500000914'],
        quantity: 2,
        scheduledAt: -4 * DAY,
        reservedAt: -2 * DAY,
        currentPriceCents: 12_900,
        confirmedAfter: 5 * HOUR,
      },
    ],
  },
  {
    slug: 'closed',
    sku: 'DEMO-BO-COLLAR',
    name: 'Collar Reflejante Mediano (demo reposición)',
    priceCents: 8_900,
    arrivalUnits: 5,
    arrivalAt: -4 * DAY,
    backorders: [
      {
        slug: 'expired',
        status: 'EXPIRED',
        customer: ['Marta', 'Ibarra Lozano', '5500000915'],
        quantity: 2,
        scheduledAt: -6 * DAY,
        reservedAt: -4 * DAY,
        currentPriceCents: 8_900,
      },
      {
        slug: 'cancelled-customer',
        status: 'CANCELLED',
        customer: ['Pedro', 'Aldama Cruz', '5500000916'],
        quantity: 1,
        scheduledAt: -5 * DAY,
        cancelledAt: -5 * DAY + 6 * HOUR,
        cancelledBy: 'CUSTOMER',
        cancelReason: 'Ya lo compré en otra tienda',
      },
      {
        slug: 'cancelled-staff',
        status: 'CANCELLED',
        customer: ['Elena', 'Rojas Mena', '5500000917'],
        quantity: 9,
        scheduledAt: -3 * DAY,
        cancelledAt: -2 * DAY,
        cancelledBy: 'STAFF',
        cancelReason: 'El proveedor descontinuó la talla',
      },
    ],
  },
];

// Every spec points back to its product (prices, names).
for (const product of PRODUCTS) {
  for (const spec of product.backorders) spec.product = product;
}
const ALL_BACKORDERS = PRODUCTS.flatMap((product) => product.backorders);

// ── Pure helpers ───────────────────────────────────────────────────────────

const idempotencyKey = (spec) => `${KEY_PREFIX}${spec.slug}`;
const requestHash = (spec) =>
  crypto.createHash('sha256').update(idempotencyKey(spec)).digest('hex');
const at = (now, offsetMs) => new Date(now.getTime() + offsetMs);

/** `BO-000012` — same format as the app's folio allocator. */
function formatFolio(number) {
  return `BO-${String(number).padStart(6, '0')}`;
}

/** Folio-less columns of one backorder row, exactly as the app leaves them. */
function backorderColumns(spec, now, refs) {
  const { product } = spec;
  const scheduledAt = at(now, spec.scheduledAt);
  const base = {
    tenantId: refs.tenantId,
    status: spec.status,
    version: 1,
    customerId: refs.customerId,
    productId: refs.productId,
    variantId: null,
    quantity: spec.quantity,
    referencePriceCents: product.priceCents,
    scheduledAt,
    estimatedArrivalDays: 7,
    estimatedAt: new Date(refs.decisionResolvedAt.getTime() + 7 * DAY),
    sourceDecisionId: refs.decisionId,
    reservationStage: 0,
    etaStage: 0,
    passedOverCount: spec.passedOverCount ?? 0,
    idempotencyKey: idempotencyKey(spec),
    requestHash: requestHash(spec),
  };
  if (spec.status === 'WAITING') return base;
  if (spec.status === 'CANCELLED') {
    return {
      ...base,
      version: 2,
      cancelledAt: at(now, spec.cancelledAt),
      cancelledByKind: spec.cancelledBy,
      cancelledByUserId:
        spec.cancelledBy === 'STAFF' ? (refs.managerId ?? null) : null,
      cancelReason: spec.cancelReason,
    };
  }
  const reservedAt = at(now, spec.reservedAt);
  const reservedUntil = new Date(reservedAt.getTime() + DAY);
  const reserved = {
    ...base,
    version: 2,
    reservedAt,
    reservedUntil,
    reminderAt: new Date(reservedUntil.getTime() - 3 * HOUR),
    currentPriceCents: spec.currentPriceCents,
    finalPriceCents: Math.min(product.priceCents, spec.currentPriceCents),
  };
  if (spec.status === 'RESERVED') return reserved;
  if (spec.status === 'CONFIRMED') {
    return {
      ...reserved,
      version: 3,
      confirmedAt: new Date(reservedAt.getTime() + spec.confirmedAfter),
      saleId: refs.saleId,
    };
  }
  // EXPIRED: reminded, then the sweep expired it just after the 24 h.
  return {
    ...reserved,
    version: 3,
    reservationStage: 2,
    expiredAt: new Date(reservedUntil.getTime() + 30_000),
  };
}

/**
 * Ordered journal steps of one product story (deltas on the sellable
 * `quantity`): the arrival, then each backorder's reserve (and release/sale).
 * Only backorders that must be created appear; the arrival only when the
 * product is new. `time` is the row's createdAt.
 */
function journalPlan(product, pending, now, { productIsNew }) {
  const steps = [];
  if (productIsNew) {
    steps.push({
      kind: 'ARRIVAL',
      type: 'INITIAL',
      groupType: 'PRODUCT',
      delta: product.arrivalUnits,
      time: at(now, product.arrivalAt),
      actor: SYSTEM,
    });
  }
  let tick = 1;
  for (const spec of pending) {
    if (!['RESERVED', 'CONFIRMED', 'EXPIRED'].includes(spec.status)) continue;
    const reservedAt = at(now, spec.reservedAt);
    steps.push({
      kind: 'RESERVE',
      spec,
      type: 'BACKORDER_RESERVE',
      groupType: 'BACKORDER',
      delta: -spec.quantity,
      // Strictly after the arrival row (the kardex orders by createdAt).
      time: new Date(reservedAt.getTime() + tick),
      actor: SYSTEM,
    });
    tick += 1;
    if (spec.status === 'CONFIRMED') {
      const confirmedAt = new Date(reservedAt.getTime() + spec.confirmedAfter);
      steps.push({
        kind: 'RELEASE',
        spec,
        type: 'BACKORDER_RELEASE',
        groupType: 'BACKORDER',
        delta: spec.quantity,
        time: confirmedAt,
        actor: BOT,
      });
      steps.push({
        kind: 'SALE',
        spec,
        type: 'SALE',
        groupType: 'SALE',
        delta: -spec.quantity,
        time: new Date(confirmedAt.getTime() + 1),
        actor: BOT,
      });
    }
    if (spec.status === 'EXPIRED') {
      const expiredAt = new Date(reservedAt.getTime() + DAY + 30_000);
      steps.push({
        kind: 'RELEASE',
        spec,
        type: 'BACKORDER_RELEASE',
        groupType: 'BACKORDER',
        delta: spec.quantity,
        time: expiredAt,
        actor: SYSTEM,
      });
    }
  }
  return steps;
}

/** Final sellable quantity of a story given its journal steps (never < 0 on the way). */
function simulateQuantity(steps, start = 0) {
  let quantity = start;
  for (const step of steps) {
    quantity += step.delta;
    if (quantity < 0) {
      throw new Error(`story would oversell at step ${step.kind}`);
    }
  }
  return quantity;
}

// ── Database steps ─────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { apply: false };
  for (const flag of argv) {
    if (flag === '--apply') args.apply = true;
    else throw new Error(`unknown option ${flag}`);
  }
  return args;
}

async function nextFolio(tx, tenantId) {
  const counter = await tx.backorderFolioCounter.upsert({
    where: { tenantId },
    create: { tenantId, lastNumber: 1 },
    update: { lastNumber: { increment: 1 } },
  });
  return formatFolio(counter.lastNumber);
}

async function ensureCustomer(tx, tenantId, [firstName, lastName, phone]) {
  const existing = await tx.customer.findFirst({
    where: { tenantId, phoneCountryCode: '52', phone },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await tx.customer.create({
    data: {
      tenantId,
      firstName,
      lastName,
      phoneCountryCode: '52',
      phone,
      comments: 'Cliente de demostración (pedidos por reposición)',
    },
  });
  return created.id;
}

async function ensureProduct(tx, tenantId, product, defaultListId) {
  const existing = await tx.product.findFirst({
    where: { tenantId, sku: product.sku },
    select: { id: true, name: true },
  });
  if (existing) return { id: existing.id, name: existing.name, isNew: false };
  const created = await tx.product.create({
    data: {
      tenantId,
      name: product.name,
      sku: product.sku,
      useStock: true,
      quantity: 0,
      minQuantity: 0,
    },
  });
  await tx.priceList.create({
    data: {
      tenantId,
      productId: created.id,
      globalPriceListId: defaultListId,
      priceCents: product.priceCents,
    },
  });
  return { id: created.id, name: created.name, isNew: true };
}

async function ensureDecision(tx, tenantId, tenant, product, productRow, now) {
  const sourceRequestId = `showcase-backorder-${product.slug}`;
  const existing = await tx.humanDecision.findFirst({
    where: { tenantId, source: DECISION_SOURCE, sourceRequestId },
    select: { id: true, resolvedAt: true },
  });
  if (existing) return existing;
  const resolvedAt = at(now, -5 * DAY);
  return tx.humanDecision.create({
    data: {
      tenantId,
      source: DECISION_SOURCE,
      sourceRequestId,
      type: 'RESTOCK',
      canonicalRequestHash: crypto
        .createHash('sha256')
        .update(sourceRequestId)
        .digest('hex'),
      submittedCredentialId: 'showcase',
      branchId: tenantId,
      branchName: tenant.name,
      productId: productRow.id,
      productName: productRow.name,
      variantId: null,
      status: 'RESOLVED',
      version: 2,
      resolutionAction: 'PROVIDE_RESTOCK_ESTIMATE',
      restockDays: 7,
      resolutionRequestId: crypto.randomUUID(),
      resolvedAt,
      resolvedByActorId: 'showcase',
      resolvedByDisplayName: 'Gerente (demo)',
    },
    select: { id: true, resolvedAt: true },
  });
}

/** Writes one journal row and moves the product exactly like `StockJournalWriter.persist`. */
async function writeMovement(tx, ctx, productRow, step, groupId) {
  const tenantId = ctx.tenantId;
  const actor =
    step.actor === BOT
      ? { id: ctx.cashierId, name: 'Bot' }
      : { id: null, name: 'Sistema' };
  const updated = await tx.product.update({
    where: { id: productRow.id },
    data: {
      quantity: { increment: step.delta },
      stockVersion: { increment: 1 },
    },
    select: { quantity: true },
  });
  if (updated.quantity < 0)
    throw new Error('journal would leave negative stock');
  await tx.stockMovement.create({
    data: {
      tenantId,
      productId: productRow.id,
      variantId: null,
      lotId: null,
      productName: productRow.name,
      variantLabel: null,
      lotNumber: null,
      bucketKind: 'PRODUCT_UNTRACKED',
      type: step.type,
      delta: step.delta,
      balanceAfter: updated.quantity,
      productBalanceAfter: updated.quantity,
      groupType: step.groupType,
      groupId,
      actorId: actor.id,
      actorDisplayName: actor.name,
      createdAt: step.time,
    },
  });
}

async function createSale(tx, ctx, spec, refs, backorderColumnsForSale) {
  const folioNow = backorderColumnsForSale.confirmedAt;
  const period = `${folioNow.getUTCFullYear()}${String(folioNow.getUTCMonth() + 1).padStart(2, '0')}`;
  const counter = await tx.saleFolioCounter.upsert({
    where: { tenantId_period: { tenantId: ctx.tenantId, period } },
    create: { tenantId: ctx.tenantId, period, lastNumber: 1 },
    update: { lastNumber: { increment: 1 } },
  });
  const unit = backorderColumnsForSale.finalPriceCents;
  const total = unit * spec.quantity;
  const sale = await tx.sale.create({
    data: {
      tenantId: ctx.tenantId,
      userId: ctx.cashierId,
      customerId: refs.customerId,
      status: 'CONFIRMED',
      channel: 'ONLINE',
      fulfillmentMode: 'PICKUP',
      deliveryStatus: 'PENDING',
      subtotalCents: total,
      totalCents: total,
      paidCents: 0,
      debtCents: total,
      paymentStatus: 'CREDIT',
      confirmedAt: folioNow,
      folio: `A-${period}-${String(counter.lastNumber).padStart(6, '0')}`,
      items: {
        create: {
          tenantId: ctx.tenantId,
          productId: refs.productId,
          productName: refs.productName,
          quantity: spec.quantity,
          unitPriceCents: unit,
          originalPriceCents: spec.product.priceCents,
          // The bot checkout stores a backorder line as a sticky custom price.
          priceSource: 'CUSTOM',
          customPriceCents: unit,
        },
      },
    },
    select: { id: true, folio: true },
  });
  return sale;
}

/**
 * What to do with one product story (pure). `create`: the product does not
 * exist yet, write the whole story (product, arrival, every backorder).
 * `none`: every key exists. `skip`: the product exists but some keys are
 * missing, so the arrival cannot be recreated consistently (T8 d); the story is
 * left alone and `message` tells the operator why.
 */
function planStory(product, existingKeys, productExists) {
  const pending = product.backorders.filter(
    (spec) => !existingKeys.has(idempotencyKey(spec)),
  );
  if (pending.length === 0) return { action: 'none', pending };
  if (!productExists) return { action: 'create', pending };
  const missing = pending.map((spec) => spec.slug).join(', ');
  return {
    action: 'skip',
    pending,
    message:
      `Historia omitida: el producto ${product.sku} ya existe pero faltan ` +
      `pedidos de ejemplo (${missing}). No se escribe nada para no dejar ` +
      `reservas sin su llegada de stock. Borra el producto de ejemplo y sus ` +
      `pedidos DEMO-BO (o la base de desarrollo) y vuelve a ejecutar.`,
  };
}

/** One transaction per product story. Returns the report rows of that story. */
async function writeStory(prisma, ctx, product, existingKeys) {
  const pending = product.backorders.filter(
    (spec) => !existingKeys.has(idempotencyKey(spec)),
  );
  if (pending.length === 0) return [];
  return prisma.$transaction(
    async (tx) => {
      const productRow = await ensureProduct(
        tx,
        ctx.tenantId,
        product,
        ctx.defaultListId,
      );
      if (!productRow.isNew) {
        // Appeared after `planStory` read: never write reserves without the arrival.
        throw new Error(
          `product ${product.sku} appeared while the story was planned: re-run`,
        );
      }
      const decision = await ensureDecision(
        tx,
        ctx.tenantId,
        ctx.tenant,
        product,
        productRow,
        ctx.now,
      );
      const steps = journalPlan(product, pending, ctx.now, {
        productIsNew: productRow.isNew,
      });
      const rows = [];
      const created = new Map();
      // Backorder rows first (the journal groups by their ids).
      for (const spec of pending) {
        const customerId = await ensureCustomer(
          tx,
          ctx.tenantId,
          spec.customer,
        );
        const refs = {
          tenantId: ctx.tenantId,
          customerId,
          productId: productRow.id,
          productName: productRow.name,
          decisionId: decision.id,
          decisionResolvedAt: decision.resolvedAt,
          managerId: ctx.managerId,
          saleId: null,
        };
        let columns = backorderColumns(spec, ctx.now, {
          ...refs,
          saleId: 'pending',
        });
        let sale = null;
        if (spec.status === 'CONFIRMED') {
          sale = await createSale(tx, ctx, spec, refs, columns);
          columns = { ...columns, saleId: sale.id };
        }
        const { saleId, ...rest } = columns;
        const row = await tx.backorder.create({
          data: {
            ...rest,
            ...(saleId ? { saleId } : {}),
            folio: await nextFolio(tx, ctx.tenantId),
          },
          select: { id: true, folio: true },
        });
        created.set(spec.slug, { id: row.id, saleId: sale?.id ?? null });
        rows.push({
          slug: spec.slug,
          folio: row.folio,
          id: row.id,
          status: spec.status,
          product: product.name,
          quantity: spec.quantity,
          passedOverCount: spec.passedOverCount ?? 0,
          sale: sale?.folio ?? null,
        });
      }
      for (const step of steps) {
        const groupId =
          step.kind === 'ARRIVAL'
            ? productRow.id
            : step.kind === 'SALE'
              ? created.get(step.spec.slug).saleId
              : created.get(step.spec.slug).id;
        await writeMovement(tx, ctx, productRow, step, groupId);
      }
      return rows;
    },
    { timeout: 60_000, maxWait: 15_000 },
  );
}

/** What exists already, by the fixed idempotency keys (reads only). */
async function existingBackorders(prisma, tenantId) {
  const rows = await prisma.backorder.findMany({
    where: {
      tenantId,
      idempotencyKey: { in: ALL_BACKORDERS.map(idempotencyKey) },
    },
    select: { idempotencyKey: true, folio: true, status: true, id: true },
  });
  return new Map(rows.map((row) => [row.idempotencyKey, row]));
}

async function context(prisma, now, who) {
  const tenant = await prisma.tenant.findUnique({
    where: { slug: who.tenantSlug },
  });
  if (!tenant) {
    throw new Error(
      `Base seed missing (tenant ${who.tenantSlug}): run \`pnpm seed\` first`,
    );
  }
  const [cashier, manager, defaultList] = await Promise.all([
    prisma.user.findUnique({ where: { email: who.cashierEmail } }),
    prisma.user.findUnique({ where: { email: who.managerEmail } }),
    prisma.globalPriceList.findFirst({ where: { isDefault: true } }),
  ]);
  if (!cashier) {
    throw new Error(`user ${who.cashierEmail} not found: run \`pnpm seed\``);
  }
  if (!defaultList) throw new Error('default (PUBLICO) price list not found');
  return {
    tenant,
    tenantId: tenant.id,
    cashierId: cashier.id,
    managerId: manager?.id ?? null,
    defaultListId: defaultList.id,
    now,
  };
}

/**
 * Creates the missing sample backorders. `apply: false` only reads and returns
 * what it would create. Returns `{ created, existing, wouldCreate }` rows.
 */
async function run({
  prisma,
  now = new Date(),
  apply = true,
  tenantSlug = TENANT_SLUG,
  cashierEmail = CASHIER_EMAIL,
  managerEmail = MANAGER_EMAIL,
}) {
  const ctx = await context(prisma, now, {
    tenantSlug,
    cashierEmail,
    managerEmail,
  });
  const existing = await existingBackorders(prisma, ctx.tenantId);
  const existingKeys = new Set(existing.keys());
  const report = {
    existing: [...existing.values()].map((row) => ({
      slug: row.idempotencyKey.slice(KEY_PREFIX.length),
      folio: row.folio,
      status: row.status,
      id: row.id,
    })),
    created: [],
    wouldCreate: [],
    skipped: [],
  };
  for (const product of PRODUCTS) {
    const productExists =
      (await prisma.product.findFirst({
        where: { tenantId: ctx.tenantId, sku: product.sku },
        select: { id: true },
      })) !== null;
    const { action, pending, message } = planStory(
      product,
      existingKeys,
      productExists,
    );
    if (action === 'none') continue;
    if (action === 'skip') {
      report.skipped.push({
        sku: product.sku,
        product: product.name,
        missing: pending.map((spec) => spec.slug),
        message,
      });
      continue;
    }
    if (!apply) {
      report.wouldCreate.push(
        ...pending.map((spec) => ({
          slug: spec.slug,
          status: spec.status,
          product: product.name,
        })),
      );
      continue;
    }
    report.created.push(
      ...(await writeStory(prisma, ctx, product, existingKeys)),
    );
  }
  return report;
}

async function main() {
  const { loadEnv, assertSafeTarget } = require(
    path.join(__dirname, 'seed.cjs'),
  );
  const args = parseArgs(process.argv.slice(2));
  loadEnv();
  assertSafeTarget();
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const report = await run({ prisma, apply: args.apply });
    if (!args.apply) {
      console.log('Dry run (nothing written). Re-run with --apply to create:');
    }
    console.log(JSON.stringify(report, null, 2));
    for (const row of report.skipped) console.log(`⚠ ${row.message}`);
    for (const row of report.created) {
      console.log(
        `✓ ${row.folio}  ${row.status.padEnd(9)} ${row.product} ×${row.quantity}${row.sale ? `  venta ${row.sale}` : ''}`,
      );
    }
    if (args.apply && report.created.length === 0) {
      console.log(
        report.skipped.length > 0
          ? 'Nothing created: see the skipped stories above.'
          : 'Nothing to create: every sample backorder already exists.',
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  ALL_BACKORDERS,
  PRODUCTS,
  KEY_PREFIX,
  backorderColumns,
  formatFolio,
  idempotencyKey,
  journalPlan,
  parseArgs,
  planStory,
  run,
  simulateQuantity,
};
