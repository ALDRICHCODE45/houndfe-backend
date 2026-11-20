// Offline: `node --test scripts/dev-showcase/backorders.test.cjs` (pure data and
// planning checks; no API, no database). The database behaviour is covered by
// src/inventory/infrastructure/backorder-showcase.integration.spec.ts.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ALL_BACKORDERS,
  PRODUCTS,
  backorderColumns,
  formatFolio,
  idempotencyKey,
  journalPlan,
  parseArgs,
  simulateQuantity,
} = require('./backorders.cjs');
const { assertSafeTarget } = require('./seed.cjs');

const NOW = new Date('2026-11-20T12:00:00.000Z');
const refs = {
  tenantId: 't',
  customerId: 'c',
  productId: 'p',
  decisionId: 'd',
  decisionResolvedAt: new Date(NOW.getTime() - 5 * 86_400_000),
  managerId: 'm',
  saleId: 's',
};

test('every backorder state is covered, with distinct keys, customers and phones', () => {
  const states = new Set(ALL_BACKORDERS.map((spec) => spec.status));
  assert.deepEqual([...states].sort(), [
    'CANCELLED',
    'CONFIRMED',
    'EXPIRED',
    'RESERVED',
    'WAITING',
  ]);
  const keys = ALL_BACKORDERS.map(idempotencyKey);
  assert.equal(new Set(keys).size, keys.length);
  for (const key of keys) assert.match(key, /^showcase:backorder:/);
  const phones = ALL_BACKORDERS.map((spec) => spec.customer[2]);
  assert.equal(new Set(phones).size, phones.length);
  for (const phone of phones) assert.match(phone, /^55000009[0-9]{2}$/);
  const skus = PRODUCTS.map((product) => product.sku);
  assert.equal(new Set(skus).size, skus.length);
});

test('a waiting head is passed over by a later reserved backorder of the same product', () => {
  const queue = PRODUCTS.find((product) => product.slug === 'queue');
  const [head, reserved] = queue.backorders;
  assert.equal(head.status, 'WAITING');
  assert.ok(head.passedOverCount > 0);
  assert.equal(reserved.status, 'RESERVED');
  // The head did not fit; the reserved one (scheduled later) did.
  assert.ok(head.quantity > queue.arrivalUnits);
  assert.ok(reserved.quantity <= queue.arrivalUnits);
  assert.ok(head.scheduledAt < reserved.scheduledAt);
});

test('rows respect the CHECK constraints of the backorders table', () => {
  for (const spec of ALL_BACKORDERS) {
    const row = backorderColumns(spec, NOW, refs);
    assert.ok(row.quantity >= 1 && row.version >= 1);
    assert.ok(row.estimatedArrivalDays >= 1 && row.estimatedArrivalDays <= 365);
    assert.ok(row.passedOverCount >= 0);
    if (row.finalPriceCents != null) {
      assert.ok(row.finalPriceCents <= row.referencePriceCents);
    }
    const reservation = [row.reservedAt, row.reservedUntil, row.reminderAt];
    if (row.status === 'WAITING') {
      assert.ok(reservation.every((value) => value === undefined));
    }
    if (row.status === 'RESERVED') {
      assert.equal(row.reservedUntil - row.reservedAt, 86_400_000);
      assert.equal(row.reservedUntil - row.reminderAt, 3 * 3_600_000);
      assert.ok(row.currentPriceCents != null && row.finalPriceCents != null);
      // Alive: still inside its 24 h at run time.
      assert.ok(row.reservedUntil > NOW);
    }
    assert.equal(row.status === 'CONFIRMED', row.confirmedAt !== undefined);
    assert.equal(row.status === 'CONFIRMED', row.saleId !== undefined);
    assert.equal(row.status === 'EXPIRED', row.expiredAt !== undefined);
    if (row.status === 'EXPIRED') {
      assert.equal(row.reservationStage, 2);
      assert.ok(row.expiredAt > row.reservedUntil && row.expiredAt < NOW);
    }
    if (row.status === 'CANCELLED') {
      assert.ok(row.cancelledAt && row.cancelledByKind && row.cancelReason);
      assert.ok(row.cancelReason.length <= 280);
      assert.equal(
        row.cancelledByUserId !== null,
        row.cancelledByKind === 'STAFF',
      );
    } else {
      assert.equal(row.cancelledAt, undefined);
    }
    assert.match(row.requestHash, /^[0-9a-f]{64}$/);
  }
});

test('the reserved and confirmed samples save the customer money or keep the reference', () => {
  for (const spec of ALL_BACKORDERS.filter((s) => s.currentPriceCents)) {
    const row = backorderColumns(spec, NOW, refs);
    assert.equal(
      row.finalPriceCents,
      Math.min(spec.product.priceCents, spec.currentPriceCents),
    );
  }
});

test('each product story journals in chronological order and never oversells', () => {
  const expectedQuantity = { queue: 1, confirmed: 4, closed: 5 };
  for (const product of PRODUCTS) {
    const steps = journalPlan(product, product.backorders, NOW, {
      productIsNew: true,
    });
    assert.equal(steps[0].type, 'INITIAL');
    for (let i = 1; i < steps.length; i += 1) {
      assert.ok(steps[i].time > steps[i - 1].time, `${product.slug} step ${i}`);
    }
    assert.equal(simulateQuantity(steps), expectedQuantity[product.slug]);
  }
});

test('confirmed: reserve, release and sale; expired: reserve and release; reserved: reserve only', () => {
  const kinds = (slug) => {
    const product = PRODUCTS.find((p) =>
      p.backorders.some((b) => b.slug === slug),
    );
    const spec = product.backorders.find((b) => b.slug === slug);
    return journalPlan(product, [spec], NOW, { productIsNew: false }).map(
      (step) => step.type,
    );
  };
  assert.deepEqual(kinds('confirmed'), [
    'BACKORDER_RESERVE',
    'BACKORDER_RELEASE',
    'SALE',
  ]);
  assert.deepEqual(kinds('expired'), [
    'BACKORDER_RESERVE',
    'BACKORDER_RELEASE',
  ]);
  assert.deepEqual(kinds('reserved'), ['BACKORDER_RESERVE']);
  assert.deepEqual(kinds('waiting-head'), []);
  assert.deepEqual(kinds('cancelled-staff'), []);
});

test('folios use the app format', () => {
  assert.equal(formatFolio(1), 'BO-000001');
  assert.equal(formatFolio(123456), 'BO-123456');
});

test('parseArgs: dry run by default, --apply, nothing else', () => {
  assert.deepEqual(parseArgs([]), { apply: false });
  assert.deepEqual(parseArgs(['--apply']), { apply: true });
  assert.throws(() => parseArgs(['--force']), /unknown option/);
});

test('refuses production and non-local databases (same guard as the showcase)', () => {
  const saved = { ...process.env };
  try {
    process.env.NODE_ENV = 'development';
    process.env.DATABASE_URL = 'postgresql://u:p@db.example.com:5432/x';
    delete process.env.SHOWCASE_ALLOW;
    assert.throws(() => assertSafeTarget(), /Refusing/);
    process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:5434/x';
    assert.doesNotThrow(() => assertSafeTarget());
    process.env.NODE_ENV = 'production';
    assert.throws(() => assertSafeTarget(), /NODE_ENV=production/);
  } finally {
    process.env = saved;
  }
});
