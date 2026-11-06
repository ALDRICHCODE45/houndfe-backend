// Dev showcase seed: varied, readable demo data for every UI screen.
// Idempotent; runs after the base seed (`pnpm seed`) on a migrated DB.
// Run: pnpm seed:showcase   (see README.md › "Datos de demostración")
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');

const ROOT = path.resolve(__dirname, '../..');
const TZ = 'America/Mexico_City';
// Run order matters: org creates people, catalog creates stock, commerce
// sells it, ops builds routes/purchases on top. Missing modules are skipped.
const MODULES = ['org', 'catalog', 'commerce', 'ops'];
// Leftovers from earlier runtime probes on the disposable dev DB.
const GARBAGE_PRODUCT_PREFIXES = ['Prueba T8', 'zz sale probe'];
const GARBAGE_PRICE_LIST_NAMES = ['Online (dev)'];
const GARBAGE_ROUTE_NOTES = ['Lleva cambio por fvor.'];

function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

/** Refuses production and non-local databases unless SHOWCASE_ALLOW=1. */
function assertSafeTarget() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed showcase data with NODE_ENV=production');
  }
  const url = process.env.DATABASE_URL ?? '';
  const host = /@([^:/?]+)/.exec(url)?.[1] ?? '';
  const local = ['localhost', '127.0.0.1', '::1', 'postgres', 'db'];
  if (!local.includes(host) && process.env.SHOWCASE_ALLOW !== '1') {
    throw new Error(
      `Refusing to seed showcase data on database host "${host}"; set SHOWCASE_ALLOW=1 if it is disposable`,
    );
  }
}

/** Dev logins come from the base seed; the password never leaves this process. */
function devPasswords() {
  const source = fs.readFileSync(path.join(ROOT, 'prisma/seed.ts'), 'utf8');
  const passwords = new Map();
  const pattern = /email:\s*'([^']+)'[\s\S]{0,200}?password:\s*'([^']+)'/g;
  for (const [, email, password] of source.matchAll(pattern)) {
    passwords.set(email, password);
  }
  // Users created by the org module share its demo password.
  const org = path.join(__dirname, 'org.cjs');
  if (fs.existsSync(org)) {
    const { DEMO_USERS = [], DEMO_PASSWORD } = require(org);
    for (const user of DEMO_USERS) {
      if (!passwords.has(user.email)) passwords.set(user.email, DEMO_PASSWORD);
    }
  }
  return passwords;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startApp() {
  if (!fs.existsSync(path.join(ROOT, 'dist/main.js'))) {
    throw new Error('dist/main.js missing: run `pnpm build` first');
  }
  const port = await freePort();
  const log = fs.openSync(path.join(ROOT, '.showcase-app.log'), 'w');
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development' },
    stdio: ['ignore', log, log],
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error('API exited during startup; see .showcase-app.log');
    }
    try {
      await fetch(baseUrl, { signal: AbortSignal.timeout(2000) });
      return { child, baseUrl };
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  child.kill();
  throw new Error('API did not become ready in 90 s; see .showcase-app.log');
}

function makeApi(baseUrl, passwords) {
  async function http(method, route, { token, body, headers = {} } = {}) {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let parsed = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* keep the raw text */
    }
    return { status: response.status, body: parsed, headers: response.headers };
  }

  const tokens = new Map();
  /** Logs in a base-seed user (NODE_ENV=development skips OTP). */
  async function login(email, tenantId) {
    const key = `${email}:${tenantId ?? ''}`;
    if (tokens.has(key)) return tokens.get(key);
    const password = passwords.get(email);
    if (!password)
      throw new Error(`No dev password for ${email} in prisma/seed.ts`);
    const res = await http('POST', '/auth/login', {
      body: { email, password },
    });
    if (res.status !== 200 || !res.body?.accessToken) {
      throw new Error(`login ${email}: HTTP ${res.status}`);
    }
    let token = res.body.accessToken;
    let claims;
    try {
      claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
    } catch {
      throw new Error(`login ${email}: unreadable access token`);
    }
    if (claims.tenantId == null && tenantId) {
      const switched = await http('POST', '/auth/switch-tenant', {
        token,
        body: { tenantId },
      });
      if (switched.status !== 200) {
        throw new Error(`switch-tenant ${email}: HTTP ${switched.status}`);
      }
      token = switched.body.accessToken;
    }
    tokens.set(key, token);
    return token;
  }

  return { baseUrl, http, login };
}

/** Removes probe leftovers. Products with sales cannot be deleted by API. */
async function cleanupGarbage(prisma) {
  const removed = { products: 0, priceLists: 0, routes: 0 };
  removed.routes = (
    await prisma.deliveryRoute.deleteMany({
      where: { notes: { in: GARBAGE_ROUTE_NOTES } },
    })
  ).count;
  const products = await prisma.product.findMany({
    where: {
      OR: GARBAGE_PRODUCT_PREFIXES.map((prefix) => ({
        name: { startsWith: prefix },
      })),
    },
    select: { id: true },
  });
  const ids = products.map((p) => p.id);
  if (ids.length > 0) {
    await prisma.$transaction(async (tx) => {
      const saleIds = (
        await tx.saleItem.findMany({
          where: { productId: { in: ids } },
          select: { saleId: true },
        })
      ).map((item) => item.saleId);
      await tx.stockMovement.deleteMany({ where: { productId: { in: ids } } });
      if (saleIds.length > 0) {
        await tx.sale.deleteMany({ where: { id: { in: saleIds } } });
      }
      removed.products = (
        await tx.product.deleteMany({ where: { id: { in: ids } } })
      ).count;
    });
  }
  removed.priceLists = (
    await prisma.globalPriceList
      .deleteMany({ where: { name: { in: GARBAGE_PRICE_LIST_NAMES } } })
      .catch(() => ({ count: 0 }))
  ).count;
  return removed;
}

async function main() {
  loadEnv();
  assertSafeTarget();
  const prisma = new PrismaClient();
  let app;
  const report = {};
  try {
    const [centro, norte] = await Promise.all(
      ['centro', 'norte'].map((slug) =>
        prisma.tenant.findUnique({ where: { slug } }),
      ),
    );
    if (!centro || !norte) {
      throw new Error(
        'Base seed missing (tenants centro/norte): run `pnpm seed` first',
      );
    }
    report.cleanup = await cleanupGarbage(prisma);
    // The showcase logs in several demo users per run; reset the login rate
    // buckets (dev only: assertSafeTarget already refused other databases).
    await prisma.authRateBucket.deleteMany({});
    app = await startApp();
    const ctx = {
      prisma,
      centro,
      norte,
      today: new Date(),
      tz: TZ,
      api: makeApi(app.baseUrl, devPasswords()),
    };
    for (const name of MODULES) {
      const file = path.join(__dirname, `${name}.cjs`);
      if (!fs.existsSync(file)) {
        report[name] = 'skipped (module not present)';
        continue;
      }
      const started = Date.now();
      report[name] = await require(file).run(ctx);
      console.log(`✓ ${name} (${Math.round((Date.now() - started) / 1000)} s)`);
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    app?.child.kill();
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { loadEnv, assertSafeTarget };
