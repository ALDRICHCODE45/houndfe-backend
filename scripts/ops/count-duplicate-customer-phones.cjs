// Ops › count duplicate customer phones (contract v1 §10.1 R1, required before
// stage 3). READ ONLY: it never writes and has no --apply.
//
// R1 groups every request by `customerKey` = canonicalPhone(cc, phone) and
// links a Customer only when that key maps to exactly one customer in the
// tenant; with more than one the request stays unlinked and flagged
// AMBIGUOUS_CUSTOMER. `Customer` has no unique phone, so this counts how often
// that happens, per tenant:
//
//   - duplicate keys: canonical keys shared by more than one customer, and how
//     many customers sit in them;
//   - null-country-code customers: those with a phone but no country code, and
//     how many of them would collide with a coded customer if they were given
//     the tenant's country code(s) (intake never matches them today).
//
// The counts are an UPPER BOUND of the ambiguity intake will see. Here the
// stored phones are compared by their canonical key, but intake looks customers
// up by exact stored values (`phoneLookupVariants`: the `52`/`521` country
// codes and the 10-13 digit forms it builds), so two customers that share a
// canonical key but are stored in a form intake never queries do not make a
// request ambiguous. Treat every number below as "at most".
//
// It uses the SAME canonicalPhone intake uses, loaded from the compiled app
// (dist/chatbot-requests/domain/canonical-phone.js), so the counts cannot
// drift from the function. Examples are masked (55****78: the first two and
// the last two digits, never more than four), never full phones.
//
// Run from the app root (the directory holding dist/, node_modules/ and
// prisma/; /app inside the container):
//
//   node scripts/ops/count-duplicate-customer-phones.cjs [--tenant <slug>]
'use strict';

const path = require('node:path');
const { createRequire } = require('node:module');

const CANONICAL_PHONE_DIST = 'dist/chatbot-requests/domain/canonical-phone.js';
const USAGE =
  'node scripts/ops/count-duplicate-customer-phones.cjs [--tenant <slug>]';
const PAGE_SIZE = 5000;
const EXAMPLE_LIMIT = 3;

class OpsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function parseArgs(argv) {
  const args = { tenant: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const [key, inline] = argv[i].split(/=(.*)/s, 2);
    if (key === '--help' && inline === undefined) {
      args.help = true;
    } else if (key === '--tenant') {
      const value = inline ?? argv[(i += 1)];
      if (!value || value.startsWith('--')) {
        throw new OpsError('BAD_ARGS', '--tenant needs a value');
      }
      args.tenant = value.trim();
    } else {
      throw new OpsError('BAD_ARGS', `unknown argument ${argv[i]}`);
    }
  }
  return args;
}

/**
 * `55****78`: the first two and the last two digits of the last ten, so never
 * more than 4 digits in total; fewer than 6 digits show nothing.
 */
function maskPhone(digits) {
  const last = String(digits).replace(/\D/g, '').slice(-10);
  return last.length < 6 ? '****' : `${last.slice(0, 2)}****${last.slice(-2)}`;
}

const digitsOf = (value) => String(value ?? '').replace(/\D/g, '');

/**
 * Pure counting per tenant.
 *
 * @param {{ customers: { id: string, tenantId: string, phoneCountryCode: string | null, phone: string | null }[],
 *           canonicalPhone: (cc: string, phone: string) => string | null,
 *           exampleLimit?: number }} input
 * @returns {Map<string, object>} tenantId -> counts
 */
function analyzeCustomers({
  customers,
  canonicalPhone,
  exampleLimit = EXAMPLE_LIMIT,
}) {
  const byTenant = new Map();
  for (const customer of customers) {
    const list = byTenant.get(customer.tenantId) ?? [];
    list.push(customer);
    byTenant.set(customer.tenantId, list);
  }

  const result = new Map();
  for (const [tenantId, list] of byTenant) {
    const keyCustomers = new Map();
    const countryCodes = new Set();
    const uncoded = [];
    for (const customer of list) {
      const cc = digitsOf(customer.phoneCountryCode);
      if (cc === '') {
        if (digitsOf(customer.phone) !== '') uncoded.push(customer);
        continue;
      }
      const key = canonicalPhone(cc, customer.phone ?? '');
      if (key === null) continue;
      countryCodes.add(cc === '521' ? '52' : cc);
      keyCustomers.set(key, (keyCustomers.get(key) ?? 0) + 1);
    }

    const duplicates = [...keyCustomers].filter(([, count]) => count > 1);
    const collisions = [];
    for (const customer of uncoded) {
      for (const cc of countryCodes) {
        const key = canonicalPhone(cc, customer.phone);
        if (key !== null && keyCustomers.has(key)) {
          collisions.push(key);
          break;
        }
      }
    }

    result.set(tenantId, {
      customers: list.length,
      canonicalKeys: keyCustomers.size,
      duplicateKeys: duplicates.length,
      customersInDuplicateKeys: duplicates.reduce(
        (sum, [, count]) => sum + count,
        0,
      ),
      nullCountryCode: uncoded.length,
      nullCountryCollisions: collisions.length,
      examples: duplicates
        .slice(0, exampleLimit)
        .map(([key, count]) => ({ phone: maskPhone(key), customers: count })),
      nullCountryExamples: collisions.slice(0, exampleLimit).map(maskPhone),
    });
  }
  return result;
}

function loadCanonicalPhone(appRoot) {
  const file = path.join(appRoot, CANONICAL_PHONE_DIST);
  try {
    return createRequire(file)(file).canonicalPhone;
  } catch {
    throw new OpsError(
      'BUILD_MISSING',
      `${CANONICAL_PHONE_DIST} not found; run from the app root of a built release`,
    );
  }
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

async function readCustomers(prisma, tenantIds) {
  const customers = [];
  let cursor;
  for (;;) {
    const page = await prisma.customer.findMany({
      where: { tenantId: { in: tenantIds }, phone: { not: null } },
      orderBy: { id: 'asc' },
      take: PAGE_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: { id: true, tenantId: true, phoneCountryCode: true, phone: true },
    });
    customers.push(...page);
    if (page.length < PAGE_SIZE) return customers;
    cursor = page[page.length - 1].id;
  }
}

function printReport(tenants, counts, log = console.log) {
  let duplicateKeys = 0;
  let collisions = 0;
  for (const tenant of tenants) {
    const c = counts.get(tenant.id);
    log(`tenant ${tenant.slug}`);
    if (!c) {
      log('  no customers with a phone');
      continue;
    }
    duplicateKeys += c.duplicateKeys;
    collisions += c.nullCountryCollisions;
    log(
      `  customers with a phone: ${c.customers}, canonical keys: ${c.canonicalKeys}`,
    );
    log(
      `  keys shared by more than one customer: ${c.duplicateKeys} (${c.customersInDuplicateKeys} customers)`,
    );
    for (const example of c.examples) {
      log(`    e.g. ${example.phone} ×${example.customers}`);
    }
    log(
      `  customers with a phone and no country code: ${c.nullCountryCode}, colliding with a coded one: ${c.nullCountryCollisions}`,
    );
    for (const example of c.nullCountryExamples) {
      log(`    e.g. ${example}`);
    }
  }
  log(
    'Counts are an UPPER BOUND: intake matches stored values exactly (phoneLookupVariants), so it can see fewer ambiguous requests than this.',
  );
  log(
    `Total: ${duplicateKeys} duplicated key(s) and ${collisions} null-country-code collision(s) across ${tenants.length} tenant(s).`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const appRoot = process.cwd();
  if (!process.env.DATABASE_URL) {
    // Dev convenience; production gets DATABASE_URL from the container env.
    try {
      process.loadEnvFile(path.join(appRoot, '.env'));
    } catch {
      // No .env: databaseTarget() reports the missing variable.
    }
  }
  console.log(`READ ONLY on ${databaseTarget()}`);

  const canonicalPhone = loadCanonicalPhone(appRoot);
  const appRequire = createRequire(path.join(appRoot, 'package.json'));
  const { PrismaClient } = appRequire('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const tenants = await prisma.tenant.findMany({
      where: args.tenant ? { slug: args.tenant } : {},
      orderBy: { slug: 'asc' },
      select: { id: true, slug: true },
    });
    if (args.tenant && tenants.length === 0) {
      throw new OpsError('TENANT_NOT_FOUND', `tenant "${args.tenant}"`);
    }
    const customers = await readCustomers(
      prisma,
      tenants.map((tenant) => tenant.id),
    );
    printReport(tenants, analyzeCustomers({ customers, canonicalPhone }));
  } finally {
    await prisma.$disconnect();
  }
}

module.exports = {
  CANONICAL_PHONE_DIST,
  analyzeCustomers,
  loadCanonicalPhone,
  maskPhone,
  parseArgs,
  printReport,
};

if (require.main === module) {
  main().then(
    () => process.exit(process.exitCode ?? 0),
    (err) => {
      const code = err?.code ?? err?.name ?? 'ERROR';
      console.error(
        `FAILED ${code}: ${String(err?.message ?? err).slice(0, 4000)}`,
      );
      process.exit(1);
    },
  );
}
