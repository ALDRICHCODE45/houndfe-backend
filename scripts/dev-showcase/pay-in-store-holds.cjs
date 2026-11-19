// Dev only: pay-in-store hold scenarios for the POS live test
// (odd/tasks/pay-in-store-pickup.md, T5 / S9). In Sucursal Centro, where
// manager@houndfe.com works, it leaves:
//
//   live   — a CONFIRMED ONLINE PICKUP CREDIT bot sale with an active IN_STORE
//            hold (~24 h ahead): the POS badge «Apartado · pagar en tienda».
//   review — a bot sale whose hold deadline is moved to a few seconds ahead and
//            that gets a PARTIAL cash payment before it. At the deadline the
//            hold sweep (every 30 s in the running API) does not cancel it and
//            raises SALE_HOLD_REVIEW to the staff with `update:Sale`.
//
// Everything goes through the real routes of a RUNNING local API: the bot
// sale (`POST /chatbot-api/sales`, pickup) and the intent (`PATCH
// /chatbot-api/sales/:id/payment-intent`) with the bot credential; the
// deadline (`PATCH /sales/:id/hold`) and the payment (`POST
// /sales/:id/payments`, no cash session) as manager@houndfe.com. Prisma only
// reads, to plan and to find earlier runs by their bot Idempotency-Key
// (`showcase:pay-in-store:<scenario>:<run>`), so a re-run creates nothing
// while the live hold is still > 1 h ahead and the review sale is PARTIAL.
//
//   node scripts/dev-showcase/pay-in-store-holds.cjs            # dry run (reads only)
//   SHOWCASE_BOT_TOKEN_FILE=.tmp/chatbot-service-token \
//     node scripts/dev-showcase/pay-in-store-holds.cjs --apply
//
// Env: SHOWCASE_API_URL (default http://127.0.0.1:3003, must be local),
// SHOWCASE_BOT_TOKEN or SHOWCASE_BOT_TOKEN_FILE (a `svc_` credential of
// Centro with `sales:create` + `sales:write`; default file
// .tmp/chatbot-service-token), optional SHOWCASE_MANAGER_PASSWORD (else the
// base-seed password), SHOWCASE_BOT_CASHIER_EMAIL (else the cashier of the
// latest ONLINE sale, else cashier@houndfe.com), SHOWCASE_HOLD_CUSTOMER_PHONE.
// Options: --review-in <seconds> (default 60). Same local-database guard as the
// showcase. Prints folios and ids only, never a token or a password.
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const MANAGER = 'manager@houndfe.com';
const FALLBACK_CASHIER = 'cashier@houndfe.com';
// Stocked, lot-free catalog product (catalog.cjs).
const PRODUCT = 'Arena Sanitaria Aglomerante 10 kg';
const DEFAULT_API_URL = 'http://127.0.0.1:3003';
const DEFAULT_TOKEN_FILE = '.tmp/chatbot-service-token';
const REQUIRED_SCOPES = ['sales:create', 'sales:write'];
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];
const KEY_PREFIX = {
  live: 'showcase:pay-in-store:live:',
  review: 'showcase:pay-in-store:review:',
};
const BOT_SALE_OPERATION = 'bot_sale_register';
const HOUR_MS = 3_600_000;
// A live hold closer than this to its deadline is replaced by a new one.
const LIVE_MIN_REMAINING_MS = HOUR_MS;
// A review sale still on its default deadline (24 h) gets the short one.
const REVIEW_SHORTEN_ABOVE_MS = 10 * 60_000;
// The partial payment must land before the deadline, or the sweep may
// cancel the sale first (CREDIT, nothing paid).
const REVIEW_PAY_MARGIN_MS = 15_000;

const CUSTOMER = {
  firstName: 'Paola',
  lastName: 'Apartado Mostrador',
  // Fictional by default; the bot may message it (pickup_* feed items).
  phone: '5500000901',
};

// ── Pure helpers ───────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { apply: false, reviewInSeconds: 60 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--apply') args.apply = true;
    else if (flag === '--review-in') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 30 || value > 3600) {
        throw new Error('--review-in needs whole seconds between 30 and 3600');
      }
      args.reviewInSeconds = value;
      i += 1;
    } else throw new Error(`unknown option ${flag}`);
  }
  return args;
}

/** Refuses an API that is not on this machine unless SHOWCASE_ALLOW=1. */
function assertLocalApi(url, env = process.env) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`SHOWCASE_API_URL is not a URL: ${url}`);
  }
  if (!LOCAL_HOSTS.includes(host) && env.SHOWCASE_ALLOW !== '1') {
    throw new Error(
      `Refusing to call API host "${host}"; set SHOWCASE_ALLOW=1 if it is disposable`,
    );
  }
  return url.replace(/\/+$/, '');
}

/** Same hash ServiceAuthGuard stores in service_credentials.hashedKey. */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** The bot token from SHOWCASE_BOT_TOKEN or a file; never printed. */
function readBotToken(env = process.env, root = ROOT) {
  let token = env.SHOWCASE_BOT_TOKEN?.trim();
  if (!token) {
    const file = path.resolve(
      root,
      env.SHOWCASE_BOT_TOKEN_FILE || DEFAULT_TOKEN_FILE,
    );
    if (!fs.existsSync(file)) {
      throw new Error(
        'No bot credential: set SHOWCASE_BOT_TOKEN or SHOWCASE_BOT_TOKEN_FILE',
      );
    }
    token = fs.readFileSync(file, 'utf8').trim();
  }
  if (!token.startsWith('svc_')) {
    throw new Error('The bot credential must start with svc_');
  }
  return token;
}

/** Missing scopes of a credential row, or a reason it cannot be used. */
function credentialProblem(row, tenantId) {
  if (!row) return 'bot credential not found or revoked';
  if (row.tenantId !== tenantId)
    return 'bot credential belongs to another sucursal';
  const missing = REQUIRED_SCOPES.filter(
    (scope) => !row.scopes.includes(scope),
  );
  return missing.length > 0
    ? `bot credential lacks ${missing.join(', ')}`
    : null;
}

const isOpenCredit = (sale) =>
  sale.status === 'CONFIRMED' &&
  sale.channel === 'ONLINE' &&
  sale.fulfillmentMode === 'PICKUP' &&
  sale.paymentStatus === 'CREDIT' &&
  sale.paidCents === 0;

/**
 * Steps for the live scenario given the newest earlier live sale (or null):
 * keep a hold still > 1 h ahead, finish a sale a crashed run left without its
 * intent, else start over with a new bot sale.
 */
function planLive(sale, now) {
  if (sale && isOpenCredit(sale)) {
    if (sale.paymentIntent === null)
      return { saleId: sale.id, steps: ['mark'] };
    if (
      sale.holdStage === 0 &&
      sale.holdExpiresAt.getTime() - now.getTime() > LIVE_MIN_REMAINING_MS
    ) {
      return { saleId: sale.id, steps: [] };
    }
  }
  return { saleId: null, steps: ['create', 'mark'] };
}

/**
 * Steps for the review scenario given the newest earlier review sale (or
 * null). Done once the sale is CONFIRMED + PARTIAL with the intent; a sale a
 * crashed run left open is finished while its deadline is still ahead.
 */
function planReview(sale, now) {
  const full = { saleId: null, steps: ['create', 'mark', 'shorten', 'pay'] };
  if (!sale) return full;
  if (
    sale.status === 'CONFIRMED' &&
    sale.paymentStatus === 'PARTIAL' &&
    sale.paymentIntent === 'IN_STORE'
  ) {
    return { saleId: sale.id, steps: [] };
  }
  if (!isOpenCredit(sale)) return full;
  if (sale.paymentIntent === null) {
    return { saleId: sale.id, steps: ['mark', 'shorten', 'pay'] };
  }
  const remaining = sale.holdExpiresAt.getTime() - now.getTime();
  if (remaining > REVIEW_SHORTEN_ABOVE_MS) {
    return { saleId: sale.id, steps: ['shorten', 'pay'] };
  }
  if (remaining > REVIEW_PAY_MARGIN_MS)
    return { saleId: sale.id, steps: ['pay'] };
  return full;
}

/** A partial payment: half the total, at least 1 cent, never the total. */
function partialAmount(totalCents) {
  if (!Number.isInteger(totalCents) || totalCents < 2) {
    throw new Error(`sale total ${totalCents} cannot be paid partially`);
  }
  return Math.floor(totalCents / 2);
}

/**
 * Price the bot must quote for one unit: the effective price of the first
 * list at quantity 1 (same rule as ProductsService.selectEffectivePrice).
 */
function unitPrice(priceLists) {
  const list = priceLists.find((row) => row.priceCents > 0);
  if (!list) throw new Error(`no price for ${PRODUCT}`);
  const tier = list.tierPrices
    .filter((row) => row.minQuantity <= 1 && row.priceCents > 0)
    .sort((a, b) => b.minQuantity - a.minQuantity)[0];
  return tier?.priceCents ?? list.priceCents;
}

// ── Steps ──────────────────────────────────────────────────────────────────

async function call(api, method, route, { token, body, headers = {} } = {}) {
  const res = await api.http(method, route, { token, body, headers });
  if (res.status < 200 || res.status >= 300) {
    const detail =
      typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    throw new Error(
      `${method} ${route} -> HTTP ${res.status} ${String(detail).slice(0, 300)}`,
    );
  }
  return res.body;
}

const SALE_FIELDS = {
  id: true,
  folio: true,
  status: true,
  channel: true,
  fulfillmentMode: true,
  paymentStatus: true,
  paidCents: true,
  totalCents: true,
  paymentIntent: true,
  holdExpiresAt: true,
  holdStage: true,
  holdVersion: true,
};

async function newestScenarioSale(prisma, tenantId, prefix) {
  const row = await prisma.saleIdempotency.findFirst({
    where: {
      tenantId,
      operation: BOT_SALE_OPERATION,
      key: { startsWith: prefix },
      saleId: { not: null },
    },
    orderBy: { createdAt: 'desc' },
    select: { saleId: true },
  });
  if (!row) return null;
  return prisma.sale.findFirst({
    where: { id: row.saleId, tenantId },
    select: SALE_FIELDS,
  });
}

async function resolveCashier(prisma, tenantId, env = process.env) {
  if (env.SHOWCASE_BOT_CASHIER_EMAIL) {
    const user = await prisma.user.findUnique({
      where: { email: env.SHOWCASE_BOT_CASHIER_EMAIL },
      select: { id: true, email: true },
    });
    if (!user) throw new Error('SHOWCASE_BOT_CASHIER_EMAIL user not found');
    return user;
  }
  const lastOnline = await prisma.sale.findFirst({
    where: { tenantId, channel: 'ONLINE', status: { not: 'DRAFT' } },
    orderBy: { createdAt: 'desc' },
    select: { user: { select: { id: true, email: true } } },
  });
  if (lastOnline) return lastOnline.user;
  const fallback = await prisma.user.findUnique({
    where: { email: FALLBACK_CASHIER },
    select: { id: true, email: true },
  });
  if (!fallback) throw new Error(`bot cashier missing: ${FALLBACK_CASHIER}`);
  return fallback;
}

async function findCustomer(prisma, tenantId) {
  return prisma.customer.findFirst({
    where: {
      tenantId,
      firstName: CUSTOMER.firstName,
      lastName: CUSTOMER.lastName,
    },
    select: { id: true },
  });
}

async function ensureCustomer(ctx) {
  const existing = await findCustomer(ctx.prisma, ctx.centro.id);
  if (existing) return existing.id;
  await call(ctx.api, 'POST', '/customers', {
    token: ctx.managerToken,
    body: {
      firstName: CUSTOMER.firstName,
      lastName: CUSTOMER.lastName,
      phoneCountryCode: '52',
      phone: process.env.SHOWCASE_HOLD_CUSTOMER_PHONE || CUSTOMER.phone,
    },
  });
  const created = await findCustomer(ctx.prisma, ctx.centro.id);
  if (!created) {
    throw new Error(
      'customer created by the API is not in DATABASE_URL: API and script use different databases',
    );
  }
  return created.id;
}

async function createBotPickupSale(ctx, scenario, customerId) {
  const key = `${KEY_PREFIX[scenario]}${ctx.now.toISOString()}`;
  const body = await call(ctx.api, 'POST', '/chatbot-api/sales', {
    token: ctx.botToken,
    headers: { 'x-idempotency-key': key },
    body: {
      cashierUserId: ctx.cashier.id,
      customerId,
      items: [
        {
          productId: ctx.product.id,
          productName: ctx.product.name,
          quantity: 1,
          unitPriceCents: ctx.unitPriceCents,
        },
      ],
      shipping: { mode: 'pickup' },
    },
  });
  const seen = await ctx.prisma.sale.findFirst({
    where: { id: body.saleId, tenantId: ctx.centro.id },
    select: { id: true },
  });
  if (!seen) {
    throw new Error(
      'sale created by the API is not in DATABASE_URL: API and script use different databases',
    );
  }
  return body.saleId;
}

async function runSteps(ctx, scenario, plan) {
  let saleId = plan.saleId;
  let customerId = null;
  const result = { steps: plan.steps };
  for (const step of plan.steps) {
    if (step === 'create') {
      customerId ??= await ensureCustomer(ctx);
      saleId = await createBotPickupSale(ctx, scenario, customerId);
    } else if (step === 'mark') {
      await call(
        ctx.api,
        'PATCH',
        `/chatbot-api/sales/${saleId}/payment-intent`,
        { token: ctx.botToken, body: { method: 'IN_STORE' } },
      );
    } else if (step === 'shorten') {
      const sale = await ctx.prisma.sale.findFirstOrThrow({
        where: { id: saleId, tenantId: ctx.centro.id },
        select: { holdVersion: true },
      });
      const expiresAt = new Date(Date.now() + ctx.reviewInSeconds * 1000);
      await call(ctx.api, 'PATCH', `/sales/${saleId}/hold`, {
        token: ctx.managerToken,
        body: {
          expiresAt: expiresAt.toISOString(),
          expectedVersion: sale.holdVersion,
        },
      });
    } else if (step === 'pay') {
      const sale = await ctx.prisma.sale.findFirstOrThrow({
        where: { id: saleId, tenantId: ctx.centro.id },
        select: { totalCents: true },
      });
      // Later collection without cashSessionId: outside any cash session.
      await call(ctx.api, 'POST', `/sales/${saleId}/payments`, {
        token: ctx.managerToken,
        headers: {
          'idempotency-key': `showcase:pay-in-store:review-pay:${saleId}`,
        },
        body: { method: 'cash', amountCents: partialAmount(sale.totalCents) },
      });
    }
  }
  const sale = await ctx.prisma.sale.findFirstOrThrow({
    where: { id: saleId, tenantId: ctx.centro.id },
    select: SALE_FIELDS,
  });
  return { ...result, ...summarize(sale) };
}

/** Folio, id and hold state only. */
function summarize(sale) {
  return {
    saleId: sale.id,
    folio: sale.folio,
    status: sale.status,
    paymentStatus: sale.paymentStatus,
    paidCents: sale.paidCents,
    totalCents: sale.totalCents,
    paymentIntent: sale.paymentIntent,
    holdExpiresAt: sale.holdExpiresAt?.toISOString() ?? null,
    holdStage: sale.holdStage,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const {
    loadEnv,
    assertSafeTarget,
    makeApi,
    devPasswords,
  } = require('./seed.cjs');
  loadEnv();
  assertSafeTarget();
  const apiUrl = assertLocalApi(
    process.env.SHOWCASE_API_URL || DEFAULT_API_URL,
  );
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const centro = await prisma.tenant.findUnique({
      where: { slug: 'centro' },
    });
    if (!centro)
      throw new Error('Base seed missing (tenant centro): run `pnpm seed`');
    const product = await prisma.product.findFirst({
      where: { tenantId: centro.id, name: PRODUCT },
      select: {
        id: true,
        name: true,
        priceLists: {
          select: {
            priceCents: true,
            tierPrices: { select: { minQuantity: true, priceCents: true } },
          },
        },
      },
    });
    if (!product) throw new Error(`product missing (run catalog): ${PRODUCT}`);
    const cashier = await resolveCashier(prisma, centro.id);
    const now = new Date();
    const plans = {
      live: planLive(
        await newestScenarioSale(prisma, centro.id, KEY_PREFIX.live),
        now,
      ),
      review: planReview(
        await newestScenarioSale(prisma, centro.id, KEY_PREFIX.review),
        now,
      ),
    };
    const header = {
      sucursal: centro.name,
      api: apiUrl,
      botCashier: cashier.email,
      reviewDeadlineInSeconds: args.reviewInSeconds,
    };
    if (!args.apply) {
      const customer = await findCustomer(prisma, centro.id);
      console.log(
        JSON.stringify(
          {
            dryRun: true,
            ...header,
            customer: customer ? customer.id : 'create',
            plans,
          },
          null,
          2,
        ),
      );
      return;
    }

    const botToken = readBotToken();
    const credential = await prisma.serviceCredential.findFirst({
      where: {
        hashedKey: hashToken(botToken),
        isActive: true,
        revokedAt: null,
      },
      select: { tenantId: true, scopes: true },
    });
    const problem = credentialProblem(credential, centro.id);
    if (problem) throw new Error(problem);

    const passwords = devPasswords();
    if (process.env.SHOWCASE_MANAGER_PASSWORD) {
      passwords.set(MANAGER, process.env.SHOWCASE_MANAGER_PASSWORD);
    }
    const api = makeApi(apiUrl, passwords);
    const ctx = {
      prisma,
      api,
      centro,
      now,
      cashier,
      product,
      unitPriceCents: unitPrice(product.priceLists),
      botToken,
      managerToken: await api.login(MANAGER, centro.id),
      reviewInSeconds: args.reviewInSeconds,
    };
    const report = { ...header };
    report.live = await runSteps(ctx, 'live', plans.live);
    report.review = await runSteps(ctx, 'review', plans.review);
    report.next =
      'The review sale gets SALE_HOLD_REVIEW on the first sweep tick (30 s) after holdExpiresAt, in the API running the hold sweep.';
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  CUSTOMER,
  KEY_PREFIX,
  PRODUCT,
  parseArgs,
  assertLocalApi,
  hashToken,
  readBotToken,
  credentialProblem,
  planLive,
  planReview,
  partialAmount,
  unitPrice,
};
