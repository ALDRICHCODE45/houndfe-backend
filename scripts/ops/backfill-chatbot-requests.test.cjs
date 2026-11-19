// Offline: `node --test scripts/ops/backfill-chatbot-requests.test.cjs`
// Argument parsing, the recency window, the report text and the run modes
// (dry run, --apply, --check) with a fake core and a fake Prisma client. The
// database behavior is proven by the PostgreSQL integration spec
// (src/chatbot-requests/chatbot-request-backfill.integration.spec.ts).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  BATCH_SIZE,
  RECENT_DAYS,
  CORE_DIST,
  EXIT,
  formatCheck,
  formatFailure,
  formatReport,
  loadCore,
  parseArgs,
  recentCutoff,
  run,
} = require('./backfill-chatbot-requests.cjs');

const SUBTYPES = ['RESTOCK', 'EXPIRATION', 'DELIVERY_ZONE', 'TRANSFER_RECEIPT'];
const zero = () =>
  Object.fromEntries(SUBTYPES.map((s) => [s, { open: 0, resolved: 0 }]));
const tenantReport = (tenantId, overrides = {}) => ({
  tenantId,
  create: zero(),
  alreadyWrapped: 0,
  ambiguousCustomers: 0,
  changedUnderLock: 0,
  undatedRejectedReceipts: 0,
  oldestOpenAt: Object.fromEntries(SUBTYPES.map((s) => [s, null])),
  batches: 0,
  ...overrides,
});
const NOW_FIXED = new Date('2026-11-10T12:00:00.000Z');
const report = (applied, tenants) => ({
  applied,
  now: NOW_FIXED,
  cutoff: new Date('2026-11-03T12:00:00.000Z'),
  tenants,
});

const capture = () => {
  const lines = [];
  return { lines, log: (line) => lines.push(line) };
};

// ------------------------------------------------------------- arguments

test('defaults: dry run over every tenant with batches of 100', () => {
  assert.deepEqual(parseArgs([]), {
    apply: false,
    check: false,
    help: false,
    tenant: null,
    batchSize: BATCH_SIZE,
  });
  assert.equal(BATCH_SIZE, 100);
});

test('parses --apply, --check, --tenant and --batch-size (also with =)', () => {
  assert.equal(parseArgs(['--apply']).apply, true);
  assert.equal(parseArgs(['--check']).check, true);
  assert.equal(parseArgs(['--tenant', 'centro']).tenant, 'centro');
  assert.equal(parseArgs(['--tenant=centro']).tenant, 'centro');
  assert.equal(parseArgs(['--batch-size', '25']).batchSize, 25);
  assert.equal(parseArgs(['--batch-size=500']).batchSize, 500);
  assert.equal(parseArgs(['--help']).help, true);
});

test('rejects unknown, valueless and out-of-range arguments', () => {
  const bad = (argv, pattern) =>
    assert.throws(
      () => parseArgs(argv),
      (err) => err.code === 'BAD_ARGS' && pattern.test(err.message),
    );
  bad(['--force'], /unknown argument --force/);
  bad(['--tenant'], /--tenant needs a value/);
  bad(['--tenant', '--apply'], /--tenant needs a value/);
  bad(['--batch-size', '0'], /--batch-size/);
  bad(['--batch-size', '1001'], /--batch-size/);
  bad(['--batch-size', 'many'], /--batch-size/);
  bad(['--apply=1'], /unknown argument/);
});

test('--check is read-only and cannot be combined with --apply', () => {
  assert.throws(
    () => parseArgs(['--check', '--apply']),
    (err) => err.code === 'BAD_ARGS' && /--check/.test(err.message),
  );
});

// ---------------------------------------------------------- the window

test('the recency window is the last 7 days (contract §2.4)', () => {
  assert.equal(RECENT_DAYS, 7);
  const now = new Date('2026-11-10T12:00:00.000Z');
  assert.equal(recentCutoff(now).toISOString(), '2026-11-03T12:00:00.000Z');
  assert.equal(recentCutoff(now, 1).toISOString(), '2026-11-09T12:00:00.000Z');
});

// ------------------------------------------------------------- reporting

test('the dry-run report counts per tenant and subtype, and says "would create"', () => {
  const create = zero();
  create.RESTOCK = { open: 3, resolved: 2 };
  create.DELIVERY_ZONE = { open: 4, resolved: 1 };
  const { lines, log } = capture();
  formatReport(
    report(false, [
      tenantReport('t1', {
        create,
        alreadyWrapped: 6,
        ambiguousCustomers: 2,
        undatedRejectedReceipts: 5,
      }),
    ]),
    new Map([['t1', 'centro']]),
    log,
  );
  const text = lines.join('\n');
  assert.match(text, /DRY RUN/);
  assert.match(text, /tenant centro/);
  assert.match(text, /RESTOCK +would create 5 \(3 open, 2 resolved\)/);
  assert.match(text, /EXPIRATION +would create 0/);
  assert.match(text, /DELIVERY_ZONE +would create 5 \(4 open, 1 resolved\)/);
  assert.match(text, /ambiguous customers: 2/);
  assert.match(text, /skipped, already wrapped: 6/);
  assert.match(text, /rejected receipts without a resolution date.*: 5/);
  assert.match(text, /Total: 10 request\(s\) to create/);
  assert.match(text, /--apply/);
});

test('the apply report says "created" and the zero-to-create total after a re-run', () => {
  const { lines, log } = capture();
  formatReport(
    report(true, [tenantReport('t1', { alreadyWrapped: 11 })]),
    new Map([['t1', 'centro']]),
    log,
  );
  const text = lines.join('\n');
  assert.match(text, /APPLIED/);
  assert.match(text, /RESTOCK +created 0/);
  assert.match(text, /Total: 0 request\(s\) created/);
  assert.doesNotMatch(text, /would create/);
});

test('the report prints no phone numbers or other digit runs beyond counts', () => {
  const { lines, log } = capture();
  formatReport(
    // A stray phone-like field in a tenant report must never be printed.
    report(false, [
      tenantReport('t1', { phone: '5512345678', ambiguousCustomers: 1 }),
    ]),
    new Map([['t1', 'centro']]),
    log,
  );
  assert.doesNotMatch(lines.join('\n'), /\d{7,}/);
});

test('the check report lists mismatches by category with ids only', () => {
  const { lines, log } = capture();
  const ok = formatCheck(
    {
      tenants: [
        { tenantId: 't1', mismatches: [], openWrapped: 4, openRequests: 4 },
      ],
    },
    new Map([['t1', 'centro']]),
    log,
  );
  assert.equal(ok, 0);
  assert.match(lines.join('\n'), /OK: 0 mismatches/);

  const bad = capture();
  const mismatches = formatCheck(
    {
      tenants: [
        {
          tenantId: 't1',
          openWrapped: 4,
          openRequests: 3,
          mismatches: [
            { kind: 'MISSING_REQUEST', subtype: 'RESTOCK', id: 'id-1' },
            { kind: 'MISSING_REQUEST', subtype: 'RESTOCK', id: 'id-2' },
            { kind: 'STATE_DISAGREES', subtype: 'DELIVERY_ZONE', id: 'id-3' },
          ],
        },
      ],
    },
    new Map([['t1', 'centro']]),
    bad.log,
  );
  assert.equal(mismatches, 3);
  const text = bad.lines.join('\n');
  assert.match(text, /MISSING_REQUEST: 2/);
  assert.match(text, /STATE_DISAGREES: 1/);
  assert.match(text, /id-1/);
  assert.match(text, /MISMATCH: 3/);
});

// ------------------------------------------------------------- run modes

function fakes({ tenants, core }) {
  const calls = [];
  const prisma = {
    tenant: {
      findMany: async ({ where }) => {
        calls.push(['tenants', where]);
        const list = tenants.filter(
          (tenant) => !where.slug || tenant.slug === where.slug,
        );
        return list;
      },
    },
  };
  return {
    calls,
    prisma,
    core: {
      runBackfill: async (client, options) => {
        calls.push(['run', options]);
        assert.equal(client, prisma);
        return (
          core?.runBackfill?.(options) ??
          report(
            options.apply,
            tenants.map((t) => tenantReport(t.id)),
          )
        );
      },
      checkInvariant: async (client, options) => {
        calls.push(['check', options]);
        return (
          core?.checkInvariant?.(options) ?? {
            tenants: tenants.map((t) => ({
              tenantId: t.id,
              mismatches: [],
              openWrapped: 0,
              openRequests: 0,
            })),
          }
        );
      },
    },
  };
}

const TENANTS = [
  { id: 't1', slug: 'centro' },
  { id: 't2', slug: 'norte' },
];
const NOW = new Date('2026-11-10T12:00:00.000Z');

test('dry run (the default) plans over all tenants and writes nothing', async () => {
  const { calls, prisma, core } = fakes({ tenants: TENANTS });
  const { lines, log } = capture();
  const code = await run({ args: parseArgs([]), prisma, core, log, now: NOW });
  assert.equal(code, 0);
  const [, options] = calls.find(([kind]) => kind === 'run');
  assert.equal(options.apply, false);
  assert.deepEqual(options.tenantIds, ['t1', 't2']);
  assert.equal(options.batchSize, 100);
  assert.equal(options.now, NOW);
  assert.match(lines.join('\n'), /DRY RUN/);
});

test('--apply passes apply=true, --tenant limits to one tenant', async () => {
  const { calls, prisma, core } = fakes({ tenants: TENANTS });
  const { lines, log } = capture();
  const code = await run({
    args: parseArgs(['--apply', '--tenant', 'norte', '--batch-size', '20']),
    prisma,
    core,
    log,
    now: NOW,
  });
  assert.equal(code, 0);
  const [, options] = calls.find(([kind]) => kind === 'run');
  assert.equal(options.apply, true);
  assert.deepEqual(options.tenantIds, ['t2']);
  assert.equal(options.batchSize, 20);
  assert.match(lines.join('\n'), /APPLIED/);
  assert.match(lines.join('\n'), /--check/);
});

test('an unknown tenant slug fails before any work', async () => {
  const { calls, prisma, core } = fakes({ tenants: TENANTS });
  await assert.rejects(
    run({
      args: parseArgs(['--tenant', 'nope']),
      prisma,
      core,
      log: () => {},
      now: NOW,
    }),
    (err) => err.code === 'TENANT_NOT_FOUND',
  );
  assert.equal(calls.filter(([kind]) => kind === 'run').length, 0);
});

test('--check reports the mismatches and exits non-zero; clean exits 0', async () => {
  const clean = fakes({ tenants: TENANTS });
  assert.equal(
    await run({
      args: parseArgs(['--check']),
      prisma: clean.prisma,
      core: clean.core,
      log: () => {},
      now: NOW,
    }),
    0,
  );
  assert.equal(clean.calls.filter(([kind]) => kind === 'run').length, 0);

  const dirty = fakes({
    tenants: TENANTS,
    core: {
      checkInvariant: () => ({
        tenants: [
          {
            tenantId: 't1',
            openWrapped: 1,
            openRequests: 0,
            mismatches: [
              { kind: 'MISSING_REQUEST', subtype: 'RESTOCK', id: 'x' },
            ],
          },
        ],
      }),
    },
  });
  const { lines, log } = capture();
  const code = await run({
    args: parseArgs(['--check', '--tenant', 'centro']),
    prisma: dirty.prisma,
    core: dirty.core,
    log,
    now: NOW,
  });
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /MISSING_REQUEST/);
  const [, options] = dirty.calls.find(([kind]) => kind === 'check');
  assert.deepEqual(options.tenantIds, ['t1']);
});

// --------------------------------------------------------------- loading

test('loadCore explains a missing build instead of a stack trace', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-core-'));
  try {
    assert.throws(
      () => loadCore(empty),
      (err) => err.code === 'BUILD_MISSING' && err.message.includes(CORE_DIST),
    );
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('the report gives the age of the oldest pending row per subtype', () => {
  const day = 24 * 60 * 60 * 1000;
  const { lines, log } = capture();
  formatReport(
    report(false, [
      tenantReport('t1', {
        oldestOpenAt: {
          RESTOCK: new Date(NOW_FIXED.getTime() - 41.5 * day),
          EXPIRATION: null,
          DELIVERY_ZONE: new Date(NOW_FIXED.getTime() - 3 * day),
          TRANSFER_RECEIPT: null,
        },
      }),
    ]),
    new Map([['t1', 'centro']]),
    log,
  );
  const text = lines.join('\n');
  assert.match(
    text,
    /oldest pending row to wrap: RESTOCK 41 d, DELIVERY_ZONE 3 d\b/,
  );
  assert.doesNotMatch(text, /EXPIRATION \d+ d/);
  const none = capture();
  formatReport(
    report(false, [tenantReport('t1')]),
    new Map([['t1', 'centro']]),
    none.log,
  );
  assert.match(none.lines.join('\n'), /oldest pending row to wrap: none/);
});

// ----------------------------------------------------- failure and exit codes

test('exit codes: clean 0, mismatch 1, crash 2', () => {
  assert.deepEqual(EXIT, { CLEAN: 0, MISMATCH: 1, CRASH: 2 });
});

test('a failure prints the error class and the Prisma/PostgreSQL code, never the raw message', () => {
  class PrismaClientKnownRequestError extends Error {
    constructor(message, code) {
      super(message);
      this.name = 'PrismaClientKnownRequestError';
      this.code = code;
    }
  }
  const unique = new PrismaClientKnownRequestError(
    'Unique constraint failed on (phone)=(5512345678) for ana@example.com',
    'P2002',
  );
  const line = formatFailure(unique);
  assert.equal(line, 'FAILED PrismaClientKnownRequestError P2002');
  assert.doesNotMatch(line, /5512345678|example\.com|Unique/);

  const deadlock = new Error('deadlock detected on 525512345678');
  deadlock.cause = { code: '40P01' };
  assert.equal(formatFailure(deadlock), 'FAILED Error 40P01');

  assert.equal(
    formatFailure(new TypeError('boom 123456789')),
    'FAILED TypeError',
  );
  assert.equal(formatFailure('weird 5512345678'), 'FAILED UnknownError');
});

test('our own ops errors keep their authored message, with long digit runs redacted', () => {
  const err = Object.assign(new Error('tenant "t-5512345678" and 12345'), {
    code: 'TENANT_NOT_FOUND',
  });
  Object.defineProperty(err, 'name', { value: 'OpsError' });
  const line = formatFailure(err);
  assert.match(line, /^FAILED TENANT_NOT_FOUND: /);
  assert.doesNotMatch(line, /\d{6,}/);
  assert.match(line, /12345/);
});

test('loadCore tells a missing file (BUILD_MISSING) from a file that fails to load (LOAD_FAILED)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-core-'));
  try {
    const file = path.join(dir, CORE_DIST);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "throw new Error('cannot read 5512345678 secret');");
    assert.throws(
      () => loadCore(dir),
      (err) =>
        err.code === 'LOAD_FAILED' &&
        err.message.includes(CORE_DIST) &&
        !/5512345678|secret/.test(err.message),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
