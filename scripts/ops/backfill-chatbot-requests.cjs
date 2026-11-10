// Ops › backfill chatbot requests (human-intervention unit 3, slice 3b;
// contract §2.4). Wraps the legacy human flows that have no `ChatbotRequest`
// yet: PENDING rows become NEW requests and rows RESOLVED in the last 7 days
// become RESOLVED ones (RESTOCK/EXPIRATION decisions, delivery-zone requesters
// waiting on a validation, TRANSFER_RECEIPT evidences). Older resolved rows are
// not wrapped. It reuses the 3a wrapper code (folio, customerKey, R1 ambiguity
// flag, customer groups) from the compiled app and is idempotent: a second run
// has nothing to create.
//
//   (default)  DRY RUN: reads and prints the plan, writes nothing
//   --apply    writes, in batches of 100 (one transaction each); safe while
//              the API is live
//   --check    read-only §2.1 invariant check; exits 1 on any mismatch
//
//   node scripts/ops/backfill-chatbot-requests.cjs [--tenant <slug>] [--apply | --check] [--batch-size <n>]
//
// Run it right after deploying the 3a code and before announcing the inbox, from
// the app root (the directory holding dist/, node_modules/ and prisma/; /app
// inside the container). docs/chatbot-requests-backfill.md is the runbook.
// The output has counts and ids only: no phone numbers, no customer text. A
// crash prints the error class and its Prisma/PostgreSQL code (P2002, 40P01),
// never the raw message, and any run of 6+ digits is redacted.
//
// Exit codes: 0 clean (or a dry run / apply that finished), 1 --check found a
// mismatch, 2 the script crashed (bad arguments, missing build, database error).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const CORE_DIST =
  'dist/chatbot-requests/infrastructure/chatbot-request-backfill.js';
const USAGE =
  'node scripts/ops/backfill-chatbot-requests.cjs [--tenant <slug>] [--apply | --check] [--batch-size <n>]';
const BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 1000;
const RECENT_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const SUBTYPES = ['RESTOCK', 'EXPIRATION', 'DELIVERY_ZONE', 'TRANSFER_RECEIPT'];
const EXAMPLE_LIMIT = 5;
const EXIT = Object.freeze({ CLEAN: 0, MISMATCH: 1, CRASH: 2 });

class OpsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OpsError';
    this.code = code;
  }
}

function parseArgs(argv) {
  const args = {
    apply: false,
    check: false,
    help: false,
    tenant: null,
    batchSize: BATCH_SIZE,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const [key, inline] = argv[i].split(/=(.*)/s, 2);
    if (
      (key === '--apply' || key === '--check' || key === '--help') &&
      inline === undefined
    ) {
      args[key.slice(2)] = true;
    } else if (key === '--tenant') {
      const value = inline ?? argv[(i += 1)];
      if (!value || value.startsWith('--')) {
        throw new OpsError('BAD_ARGS', '--tenant needs a value');
      }
      args.tenant = value.trim();
    } else if (key === '--batch-size') {
      const value = inline ?? argv[(i += 1)];
      const size = Number(value);
      if (!/^\d+$/.test(String(value)) || size < 1 || size > MAX_BATCH_SIZE) {
        throw new OpsError(
          'BAD_ARGS',
          `--batch-size must be an integer from 1 to ${MAX_BATCH_SIZE}`,
        );
      }
      args.batchSize = size;
    } else {
      throw new OpsError('BAD_ARGS', `unknown argument ${argv[i]}`);
    }
  }
  if (args.check && args.apply) {
    throw new OpsError('BAD_ARGS', '--check is read-only: drop --apply');
  }
  return args;
}

/** The resolved rows of the last `days` days are wrapped (contract §2.4). */
function recentCutoff(now, days = RECENT_DAYS) {
  return new Date(now.getTime() - days * DAY_MS);
}

/** `RESTOCK 41 d, DELIVERY_ZONE 3 d`: whole days since the oldest row was created. */
function oldestPending(report, tenant) {
  const parts = SUBTYPES.flatMap((subtype) => {
    const at = tenant.oldestOpenAt?.[subtype];
    if (!at) return [];
    const days = Math.max(0, Math.floor((report.now - at) / DAY_MS));
    return [`${subtype} ${days} d`];
  });
  return parts.length === 0 ? 'none' : parts.join(', ');
}

const slugOf = (slugs, tenantId) => slugs.get(tenantId) ?? tenantId;

function formatReport(report, slugs, log) {
  const verb = report.applied ? 'created' : 'would create';
  log(
    report.applied
      ? `APPLIED (resolved rows since ${report.cutoff.toISOString()} are wrapped)`
      : `DRY RUN: nothing is written (resolved rows since ${report.cutoff.toISOString()} are wrapped)`,
  );
  let total = 0;
  let ambiguous = 0;
  let wrapped = 0;
  for (const tenant of report.tenants) {
    log(`tenant ${slugOf(slugs, tenant.tenantId)}`);
    for (const subtype of SUBTYPES) {
      const { open, resolved } = tenant.create[subtype];
      total += open + resolved;
      const detail =
        open + resolved === 0 ? '' : ` (${open} open, ${resolved} resolved)`;
      log(`  ${subtype.padEnd(17)}${verb} ${open + resolved}${detail}`);
    }
    ambiguous += tenant.ambiguousCustomers;
    wrapped += tenant.alreadyWrapped;
    log(`  ambiguous customers: ${tenant.ambiguousCustomers}`);
    log(`  oldest pending row to wrap: ${oldestPending(report, tenant)}`);
    log(`  skipped, already wrapped: ${tenant.alreadyWrapped}`);
    if (tenant.changedUnderLock > 0) {
      log(
        `  skipped under lock (wrapped or changed since planning): ${tenant.changedUnderLock}`,
      );
    }
    if (tenant.undatedRejectedReceipts > 0) {
      log(
        `  rejected receipts without a resolution date (not wrapped): ${tenant.undatedRejectedReceipts}`,
      );
    }
  }
  log(
    `Total: ${total} request(s) ${report.applied ? 'created' : 'to create'}, ${ambiguous} ambiguous customer(s), ${wrapped} already wrapped, ${report.tenants.length} tenant(s).`,
  );
  log(
    report.applied
      ? 'Next: node scripts/ops/backfill-chatbot-requests.cjs --check'
      : 'Re-run with --apply to write.',
  );
}

/** Prints the mismatches of --check and returns how many there are. */
function formatCheck(report, slugs, log) {
  let mismatches = 0;
  for (const tenant of report.tenants) {
    log(`tenant ${slugOf(slugs, tenant.tenantId)}`);
    log(
      `  open wrapped rows: ${tenant.openWrapped}, open requests wrapping one: ${tenant.openRequests}`,
    );
    const kinds = new Map();
    for (const mismatch of tenant.mismatches) {
      const list = kinds.get(mismatch.kind) ?? [];
      list.push(mismatch);
      kinds.set(mismatch.kind, list);
    }
    for (const [kind, list] of kinds) {
      const examples = list
        .slice(0, EXAMPLE_LIMIT)
        .map((m) => (m.subtype ? `${m.subtype} ${m.id}` : m.id))
        .join(', ');
      const more = list.length > EXAMPLE_LIMIT ? ', …' : '';
      log(`  ${kind}: ${list.length} (${examples}${more})`);
    }
    mismatches += tenant.mismatches.length;
  }
  log(
    mismatches === 0
      ? `OK: 0 mismatches across ${report.tenants.length} tenant(s).`
      : `MISMATCH: ${mismatches} across ${report.tenants.length} tenant(s). Re-run --apply for MISSING_REQUEST or RESOLVED_UNWRAPPED; a lone result under live traffic may be transient, so re-check first.`,
  );
  return mismatches;
}

const redact = (text) => String(text).replace(/\d{6,}/g, '[redacted]');

/** The error class and the Prisma/PostgreSQL code(s): never the raw message. */
function errorCodes(err) {
  const codes = [err?.code, err?.meta?.code, err?.cause?.code].filter(
    (code) => typeof code === 'string' && /^[A-Za-z0-9_]{3,40}$/.test(code),
  );
  return [...new Set(codes)];
}

/**
 * The single line printed when the script crashes. Our own `OpsError`s carry a
 * message we wrote (digit runs redacted); anything else (Prisma, pg, Node) can
 * echo customer values in its message, so only its class and code are shown.
 */
function formatFailure(err) {
  const isError = err !== null && typeof err === 'object';
  if (isError && err.name === 'OpsError') {
    return `FAILED ${err.code ?? 'ERROR'}: ${redact(err.message).slice(0, 1000)}`;
  }
  const name =
    isError && typeof err.name === 'string' && /^\w+$/.test(err.name)
      ? err.name
      : 'UnknownError';
  return ['FAILED', name, ...(isError ? errorCodes(err) : [])].join(' ');
}

function loadCore(appRoot) {
  const file = path.join(appRoot, CORE_DIST);
  if (!fs.existsSync(file)) {
    throw new OpsError(
      'BUILD_MISSING',
      `${CORE_DIST} not found; run from the app root of a release built from the backfill commit or later`,
    );
  }
  try {
    return createRequire(file)(file);
  } catch (err) {
    const detail = ['', ...errorCodes(err)].join(' ');
    throw new OpsError(
      'LOAD_FAILED',
      `${CORE_DIST} exists but failed to load (${err?.name ?? 'error'}${detail})`,
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

/**
 * Orchestration, with the core and the Prisma client injected so it is testable
 * without a database. Returns the process exit code.
 */
async function run({ args, prisma, core, log, now = new Date() }) {
  const tenants = await prisma.tenant.findMany({
    where: args.tenant ? { slug: args.tenant } : {},
    orderBy: { slug: 'asc' },
    select: { id: true, slug: true },
  });
  if (args.tenant && tenants.length === 0) {
    throw new OpsError('TENANT_NOT_FOUND', `tenant "${args.tenant}"`);
  }
  const tenantIds = tenants.map((tenant) => tenant.id);
  const slugs = new Map(tenants.map((tenant) => [tenant.id, tenant.slug]));

  if (args.check) {
    const report = await core.checkInvariant(prisma, { tenantIds });
    return formatCheck(report, slugs, log) === 0 ? EXIT.CLEAN : EXIT.MISMATCH;
  }
  const report = await core.runBackfill(prisma, {
    apply: args.apply,
    tenantIds,
    batchSize: args.batchSize,
    now,
  });
  formatReport(report, slugs, log);
  return EXIT.CLEAN;
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
  const mode = args.check
    ? 'CHECK (read only)'
    : args.apply
      ? 'APPLY'
      : 'DRY RUN';
  console.log(`${mode} on ${databaseTarget()}`);

  const core = loadCore(appRoot);
  const appRequire = createRequire(path.join(appRoot, 'package.json'));
  const { PrismaClient } = appRequire('@prisma/client');
  const prisma = new PrismaClient();
  try {
    process.exitCode = await run({
      args,
      prisma,
      core,
      log: (line) => console.log(line),
    });
  } finally {
    await prisma.$disconnect();
  }
}

module.exports = {
  BATCH_SIZE,
  CORE_DIST,
  EXIT,
  RECENT_DAYS,
  formatCheck,
  formatFailure,
  formatReport,
  loadCore,
  parseArgs,
  recentCutoff,
  run,
};

if (require.main === module) {
  main().then(
    () => process.exit(process.exitCode ?? EXIT.CLEAN),
    (err) => {
      console.error(formatFailure(err));
      process.exit(EXIT.CRASH);
    },
  );
}
