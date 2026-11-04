'use strict';
// O1 inventory-journal runtime proof (S1–S10) over REAL HTTP against a running app and the
// dev DB. Mutating probes run on throwaway «Prueba T8 …» products that are created and then
// deleted by the probe itself; the showcase products are only read or hit with rejected
// requests. Writes the full evidence to INVENTORY_EVIDENCE (default /tmp/inventory-evidence.json)
// and never prints passwords or tokens.
//   INVENTORY_BASE_URL=http://127.0.0.1:3917 INVENTORY_DEV_PASSWORD=… \
//   INVENTORY_NOPERM_PASSWORD=… INVENTORY_ADMIN_PASSWORD=… node scripts/inventory-runtime/probe.cjs
const crypto = require('node:crypto');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const {
  DEV_EMAIL,
  NOPERM_EMAIL,
  prismaClient,
  requireEnv,
  http,
  login,
  tenantBySlug,
} = require('./lib.cjs');

const ADMIN_EMAIL = process.env.INVENTORY_ADMIN_EMAIL || 'admin@houndfe.com';
const OTHER_TENANT_SLUG = 'norte';
const EVIDENCE =
  process.env.INVENTORY_EVIDENCE || '/tmp/inventory-evidence.json';
const EXPIRED_DATE = '2026-10-15';
const key = () => crypto.randomUUID();
const records = [];

// Records one probe: expected HTTP status (+ optional error code) and an optional extra check.
function rec(specs, label, res, expectStatus, { error, check, fields } = {}) {
  let ok = res.status === expectStatus;
  let detail = '';
  if (ok && error !== undefined) {
    ok = res.body && res.body.error === error;
    if (!ok) detail = `expected error ${error}`;
  }
  if (ok && check) {
    try {
      check(res.body);
    } catch (e) {
      ok = false;
      detail = e.message.split('\n')[0];
    }
  }
  records.push({
    specs,
    label,
    status: res.status,
    expectStatus,
    ok,
    detail,
    body: fields ? fields(res.body) : res.body,
  });
  if (!ok)
    console.error(
      `FAIL ${specs} ${label}: HTTP ${res.status} ${detail} ${JSON.stringify(res.body).slice(0, 300)}`,
    );
  return res;
}

async function main() {
  const prisma = prismaClient();
  const tenant = await tenantBySlug(prisma);
  const other = await tenantBySlug(prisma, OTHER_TENANT_SLUG);
  const dev = await login(
    DEV_EMAIL,
    requireEnv('INVENTORY_DEV_PASSWORD'),
    tenant.id,
  );
  const noperm = await login(
    NOPERM_EMAIL,
    requireEnv('INVENTORY_NOPERM_PASSWORD'),
    tenant.id,
  );
  const admin = await login(
    ADMIN_EMAIL,
    requireEnv('INVENTORY_ADMIN_PASSWORD'),
    other.id,
  );
  const g = (route, token = dev) => http('GET', route, { token });
  const adjust = (body, k = key(), token = dev) =>
    http('POST', '/inventory/adjustments', {
      token,
      body,
      headers: { 'idempotency-key': k },
    });
  const stockOf = async (id) =>
    (await g(`/inventory/products/${id}/stock`)).body;
  const kardex = async (id, query = '') =>
    (await g(`/inventory/movements?productId=${id}${query}`)).body;
  const suffix = Date.now().toString(36);
  const created = [];
  const mk = async (name, body) => {
    const res = await http('POST', '/products', {
      token: dev,
      body: { name: `Prueba T8 ${name} ${suffix}`, ...body },
    });
    assert.equal(
      res.status,
      201,
      `create ${name}: ${JSON.stringify(res.body)}`,
    );
    created.push(res.body.id);
    return res.body.id;
  };

  // ── Fixtures (S2 INITIAL) ────────────────────────────────────────────────
  const P = await mk('Croquetas', {
    useStock: true,
    useLotsAndExpirations: true,
    priceCents: 10000,
    lots: [
      { lotNumber: 'T8-VENCIDO', quantity: 8, expirationDate: EXPIRED_DATE },
      { lotNumber: 'T8-ENE-27', quantity: 22, expirationDate: '2027-01-15' },
      { lotNumber: 'T8-JUN-27', quantity: 30, expirationDate: '2027-06-30' },
    ],
  });
  rec(
    'S6',
    'fixture: +12 untracked units through an adjustment',
    await adjust({
      target: { productId: P },
      expectedVersion: 0,
      delta: 12,
      reason: 'PHYSICAL_COUNT',
    }),
    201,
  );
  const NOSTOCK = await mk('Placa', { useStock: false, priceCents: 5000 });
  const VP = await mk('Collar', {
    useStock: true,
    hasVariants: true,
    priceCents: 9000,
    variants: [
      { name: 'Chico · Azul', quantity: 15 },
      { name: 'Mediano · Rojo', quantity: 9 },
    ],
  });
  const PLAIN = await mk('Desparasitante', {
    useStock: true,
    quantity: 20,
    priceCents: 7000,
  });
  const s0 = await stockOf(P);
  const [lotA, lotB, lotC] = s0.lots;
  const vs = await stockOf(VP);

  // ── S10 stock view ───────────────────────────────────────────────────────
  rec(
    'S10',
    'GET stock: expired flag, sellable, versions',
    await g(`/inventory/products/${P}/stock`),
    200,
    {
      check: (b) => {
        assert.equal(b.product.quantity, 72);
        assert.equal(b.product.untracked.quantity, 12);
        assert.equal(b.product.sellable, 64);
        assert.deepEqual(
          b.lots.map((l) => l.expired),
          [true, false, false],
        );
        assert.deepEqual(
          b.lots.map((l) => l.quantity),
          [8, 22, 30],
        );
        assert(b.lots.every((l) => Number.isInteger(l.version)));
      },
    },
  );
  rec(
    'S10',
    'GET stock of a variant product',
    await g(`/inventory/products/${VP}/stock`),
    200,
    {
      check: (b) => {
        assert.equal(b.variants.length, 2);
        assert.equal(b.lots.length, 0);
        assert.equal(b.product.quantity, 24);
      },
    },
  );
  rec(
    'S10',
    'GET stock of a useStock=false product (sellable null)',
    await g(`/inventory/products/${NOSTOCK}/stock`),
    200,
    { check: (b) => assert.equal(b.product.sellable, null) },
  );
  rec(
    'S10',
    'GET stock unknown product',
    await g(`/inventory/products/${crypto.randomUUID()}/stock`),
    404,
    { error: 'NOT_FOUND' },
  );
  rec(
    'S5',
    'GET stock of this product from another tenant (norte)',
    await g(`/inventory/products/${P}/stock`, admin),
    404,
    { error: 'NOT_FOUND' },
  );
  rec(
    'S5',
    'GET movements of this product from another tenant: empty page',
    await g(`/inventory/movements?productId=${P}`, admin),
    200,
    { check: (b) => assert.equal(b.items.length, 0) },
  );
  rec(
    'S10',
    'GET stock without permission',
    await g(`/inventory/products/${P}/stock`, noperm),
    403,
    { error: 'FORBIDDEN' },
  );
  rec(
    'S10',
    'GET stock without token',
    await http('GET', `/inventory/products/${P}/stock`),
    401,
    { error: 'UNAUTHORIZED' },
  );

  // ── S1 OPENING rows written by the migration ─────────────────────────────
  const opening = await prisma.stockMovement.findFirst({
    where: { tenantId: tenant.id, type: 'OPENING' },
    orderBy: { createdAt: 'asc' },
  });
  const openingCount = await prisma.stockMovement.count({
    where: { type: 'OPENING' },
  });
  assert(opening, 'no OPENING movement in the dev DB');
  rec(
    'S1',
    `kardex of a pre-journal product (${openingCount} OPENING rows in DB)`,
    await g(`/inventory/movements?productId=${opening.productId}`),
    200,
    {
      check: (b) => {
        const row = b.items.find((m) => m.type === 'OPENING');
        assert(
          row &&
            row.actor.displayName === 'Sistema' &&
            row.delta > 0 &&
            row.group.type === 'PRODUCT',
        );
      },
      fields: (b) => ({
        openingRows: b.items
          .filter((m) => m.type === 'OPENING')
          .map((m) => ({
            type: m.type,
            bucket: m.bucket,
            delta: m.delta,
            balanceAfter: m.balanceAfter,
            actor: m.actor,
            createdAt: m.createdAt,
          })),
      }),
    },
  );

  // ── S10 kardex paging ────────────────────────────────────────────────────
  const page1 = rec(
    'S10',
    'GET movements limit=2 (newest first, nextCursor)',
    await g(`/inventory/movements?productId=${P}&limit=2`),
    200,
    {
      check: (b) => {
        assert.equal(b.items.length, 2);
        assert(b.nextCursor);
        assert.equal(b.items[0].type, 'ADJUSTMENT');
      },
      fields: (b) => ({
        types: b.items.map((i) => i.type),
        nextCursor: !!b.nextCursor,
      }),
    },
  );
  const seen = [...page1.body.items];
  let cursor = page1.body.nextCursor;
  let guard = 0;
  while (cursor && guard++ < 10) {
    const next = await g(
      `/inventory/movements?productId=${P}&limit=2&cursor=${encodeURIComponent(cursor)}`,
    );
    assert.equal(next.status, 200);
    seen.push(...next.body.items);
    cursor = next.body.nextCursor;
  }
  rec(
    'S10',
    'follow nextCursor to the end: 4 rows, no duplicates, last page nextCursor null',
    { status: 200, body: seen.map((m) => m.type) },
    200,
    {
      check: () => {
        assert.equal(seen.length, 4);
        assert.equal(new Set(seen.map((m) => m.id)).size, 4);
        assert.deepEqual(seen.map((m) => m.type).sort(), [
          'ADJUSTMENT',
          'INITIAL',
          'INITIAL',
          'INITIAL',
        ]);
        assert.equal(cursor, null);
      },
    },
  );
  rec(
    'S10',
    'cursor reused with another productId',
    await g(
      `/inventory/movements?productId=${PLAIN}&limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`,
    ),
    400,
    { error: 'MALFORMED' },
  );
  rec(
    'S10',
    'variantId + lotId together',
    await g(
      `/inventory/movements?productId=${P}&variantId=${crypto.randomUUID()}&lotId=${lotB.id}`,
    ),
    400,
    { error: 'MALFORMED' },
  );
  rec('S10', 'productId missing', await g('/inventory/movements'), 400, {
    error: 'MALFORMED',
  });
  rec(
    'S10',
    'limit=101',
    await g(`/inventory/movements?productId=${P}&limit=101`),
    400,
    { error: 'MALFORMED' },
  );
  rec(
    'S10',
    'lotId filter',
    await g(`/inventory/movements?productId=${P}&lotId=${lotB.id}`),
    200,
    {
      check: (b) =>
        assert(b.items.length === 1 && b.items[0].lotId === lotB.id),
    },
  );

  // ── S3 / S4 / S10 adjustments ────────────────────────────────────────────
  const bodyB = {
    target: { productId: P, lotId: lotB.id },
    expectedVersion: lotB.version,
    delta: -2,
    reason: 'DAMAGE',
    note: 'Bolsas rotas',
  };
  const k1 = key();
  const first = rec(
    'S10',
    'POST adjustment lot B -2 DAMAGE',
    await adjust(bodyB, k1),
    201,
    {
      check: (b) => {
        assert.equal(b.movement.type, 'ADJUSTMENT');
        assert.equal(b.movement.delta, -2);
        assert.equal(b.movement.balanceAfter, 20);
        assert.equal(b.movement.productBalanceAfter, 70);
        assert.equal(b.movement.reason, 'DAMAGE');
        assert.equal(b.movement.actor.displayName, 'Manager Centro');
        assert.equal(
          b.stock.lots.find((l) => l.id === lotB.id).version,
          lotB.version + 1,
        );
      },
      fields: (b) => ({
        movement: {
          type: b.movement.type,
          bucket: b.movement.bucket,
          delta: b.movement.delta,
          balanceAfter: b.movement.balanceAfter,
          productBalanceAfter: b.movement.productBalanceAfter,
          reason: b.movement.reason,
          note: b.movement.note,
          group: b.movement.group,
          actor: b.movement.actor,
        },
        lotBVersion: b.stock.lots.find((l) => l.id === lotB.id).version,
        productQuantity: b.stock.product.quantity,
      }),
    },
  );
  const rowsBefore = (await kardex(P)).items.length;
  const replay = await adjust(bodyB, k1);
  rec(
    'S10',
    'replay same key + same body: same 201 body, no 2nd row',
    replay,
    201,
    {
      check: (b) => {
        assert.deepEqual(b, first.body);
        assert.equal(rowsBefore, 5);
      },
      fields: () => ({ sameBody: true, rowsBefore, rowsAfter: undefined }),
    },
  );
  records[records.length - 1].body.rowsAfter = (await kardex(P)).items.length;
  assert.equal(records[records.length - 1].body.rowsAfter, rowsBefore);
  rec(
    'S10',
    'same key, different body',
    await adjust({ ...bodyB, delta: -3 }, k1),
    409,
    { error: 'IDEMPOTENCY_KEY_CONFLICT' },
  );
  rec('S10', 'stale expectedVersion', await adjust(bodyB), 409, {
    error: 'STOCK_VERSION_CONFLICT',
  });
  const bNow = (await stockOf(P)).lots.find((l) => l.id === lotB.id);
  const stockBeforeNeg = await stockOf(P);
  rec(
    'S4',
    'negative lot result (-1000)',
    await adjust({
      ...bodyB,
      expectedVersion: bNow.version,
      delta: -1000,
      reason: 'THEFT_LOSS',
    }),
    409,
    { error: 'INSUFFICIENT_STOCK' },
  );
  assert.deepEqual(await stockOf(P), stockBeforeNeg);
  rec(
    'S4',
    'nothing changed after INSUFFICIENT_STOCK (stock identical)',
    { status: 200, body: { unchanged: true } },
    200,
  );
  rec(
    'S4',
    'delta 0',
    await adjust({ ...bodyB, expectedVersion: bNow.version, delta: 0 }),
    400,
    { error: 'MALFORMED' },
  );
  rec(
    'S3',
    'reason OTHER without note',
    await adjust({
      ...bodyB,
      expectedVersion: bNow.version,
      reason: 'OTHER',
      note: undefined,
    }),
    400,
    { error: 'MALFORMED' },
  );
  rec(
    'S3',
    'reason OTHER with blank note',
    await adjust({
      ...bodyB,
      expectedVersion: bNow.version,
      reason: 'OTHER',
      note: '   ',
    }),
    400,
    { error: 'MALFORMED' },
  );
  rec(
    'S3',
    'reason OTHER with 501-char note',
    await adjust({
      ...bodyB,
      expectedVersion: bNow.version,
      reason: 'OTHER',
      note: 'x'.repeat(501),
    }),
    400,
    { error: 'MALFORMED' },
  );
  rec(
    'S3',
    'unknown reason',
    await adjust({ ...bodyB, expectedVersion: bNow.version, reason: 'LOST' }),
    400,
    { error: 'MALFORMED' },
  );
  rec(
    'S5',
    'tenant key in the body',
    await adjust({
      ...bodyB,
      expectedVersion: bNow.version,
      tenantId: other.id,
    }),
    400,
    { error: 'MALFORMED' },
  );
  const noKey = await http('POST', '/inventory/adjustments', {
    token: dev,
    body: { ...bodyB, expectedVersion: bNow.version },
  });
  rec('S10', 'missing Idempotency-Key header', noKey, 400, {
    error: 'MALFORMED',
  });
  rec(
    'S10',
    'useStock=false product',
    await adjust({
      target: { productId: NOSTOCK },
      expectedVersion: 0,
      delta: 1,
      reason: 'PHYSICAL_COUNT',
    }),
    409,
    { error: 'STOCK_NOT_TRACKED' },
  );
  rec(
    'S10',
    'variant product with productId-only target',
    await adjust({
      target: { productId: VP },
      expectedVersion: 0,
      delta: 1,
      reason: 'PHYSICAL_COUNT',
    }),
    404,
    { error: 'NOT_FOUND' },
  );
  rec(
    'S10',
    'POST adjustment without permission',
    await adjust({ ...bodyB, expectedVersion: bNow.version }, key(), noperm),
    403,
    { error: 'FORBIDDEN' },
  );
  rec(
    'S10',
    'POST adjustment without token',
    await http('POST', '/inventory/adjustments', {
      body: bodyB,
      headers: { 'idempotency-key': key() },
    }),
    401,
    { error: 'UNAUTHORIZED' },
  );
  rec(
    'S5',
    'adjust this tenant lot from another tenant',
    await adjust({ ...bodyB, expectedVersion: bNow.version }, key(), admin),
    404,
    { error: 'NOT_FOUND' },
  );
  let plainVersion = (await stockOf(PLAIN)).product.untracked.version;
  for (const [reason, delta, note] of [
    ['PHYSICAL_COUNT', -1],
    ['DAMAGE', -1, 'Envase abollado'],
    ['EXPIRED', -1],
    ['THEFT_LOSS', -1],
    ['DATA_ENTRY_CORRECTION', 3, 'Captura duplicada'],
    ['OTHER', -2, 'Donación a refugio'],
  ]) {
    const res = rec(
      'S3',
      `reason ${reason}`,
      await adjust({
        target: { productId: PLAIN },
        expectedVersion: plainVersion,
        delta,
        reason,
        note,
      }),
      201,
      {
        fields: (b) => ({
          reason: b.movement.reason,
          note: b.movement.note,
          delta: b.movement.delta,
          balanceAfter: b.movement.balanceAfter,
        }),
      },
    );
    plainVersion = res.body.stock.product.untracked.version;
  }
  const varA = vs.variants[0];
  rec(
    'S4',
    'variant bucket negative (-100)',
    await adjust({
      target: { productId: VP, variantId: varA.id },
      expectedVersion: varA.version,
      delta: -100,
      reason: 'DAMAGE',
    }),
    409,
    { error: 'INSUFFICIENT_STOCK' },
  );
  rec(
    'S10',
    'variant bucket -1',
    await adjust({
      target: { productId: VP, variantId: varA.id },
      expectedVersion: varA.version,
      delta: -1,
      reason: 'DAMAGE',
    }),
    201,
    { check: (b) => assert.equal(b.movement.bucket, 'VARIANT') },
  );

  // ── S2 quantity read-only; S8 guards ─────────────────────────────────────
  const snap = async () =>
    JSON.stringify([
      await stockOf(P),
      await stockOf(VP),
      (await kardex(P)).items.length,
    ]);
  const before = await snap();
  const lotsRes = await g(`/products/${P}/lots`);
  const variantsRes = await g(`/products/${VP}/variants`);
  rec(
    'S2',
    'PATCH product with quantity',
    await http('PATCH', `/products/${P}`, {
      token: dev,
      body: { quantity: 999 },
    }),
    400,
    { error: 'STOCK_QUANTITY_READ_ONLY' },
  );
  rec(
    'S2',
    'PATCH product with quantity: null',
    await http('PATCH', `/products/${P}`, {
      token: dev,
      body: { quantity: null },
    }),
    400,
    { error: 'STOCK_QUANTITY_READ_ONLY' },
  );
  rec(
    'S2',
    'PATCH product with quantity: 0',
    await http('PATCH', `/products/${P}`, {
      token: dev,
      body: { quantity: 0 },
    }),
    400,
    { error: 'STOCK_QUANTITY_READ_ONLY' },
  );
  rec(
    'S2',
    'PATCH product with quantity: 7',
    await http('PATCH', `/products/${P}`, {
      token: dev,
      body: { quantity: 7 },
    }),
    400,
    { error: 'STOCK_QUANTITY_READ_ONLY' },
  );
  rec(
    'S2',
    'PATCH variant with quantity',
    await http('PATCH', `/products/${VP}/variants/${varA.id}`, {
      token: dev,
      body: { quantity: 999 },
    }),
    400,
    { error: 'STOCK_QUANTITY_READ_ONLY' },
  );
  rec(
    'S2',
    'PATCH lot with quantity',
    await http('PATCH', `/products/${P}/lots/${lotB.id}`, {
      token: dev,
      body: { quantity: 999 },
    }),
    400,
    { error: 'STOCK_QUANTITY_READ_ONLY' },
  );
  assert.equal(await snap(), before);
  rec(
    'S2',
    'stock + kardex identical after the three rejected PATCH',
    { status: 200, body: { unchanged: true } },
    200,
  );
  rec(
    'S2',
    'saving a lots product does not rewrite quantity (PATCH minQuantity)',
    await http('PATCH', `/products/${P}`, {
      token: dev,
      body: { minQuantity: 5 },
    }),
    200,
    {
      check: async () => {},
    },
  );
  const afterSave = await stockOf(P);
  rec(
    'S2',
    'stock after PATCH minQuantity: quantity 70 untouched',
    { status: 200, body: afterSave.product },
    200,
    { check: () => assert.equal(afterSave.product.quantity, 70) },
  );
  rec(
    'S2',
    'PATCH lot expirationDate keeps its quantity',
    await http('PATCH', `/products/${P}/lots/${lotC.id}`, {
      token: dev,
      body: { expirationDate: '2027-06-30' },
    }),
    200,
  );
  assert.equal(
    (await stockOf(P)).lots.find((l) => l.id === lotC.id).quantity,
    30,
  );
  rec(
    'S8',
    'DELETE lot with stock',
    await http('DELETE', `/products/${P}/lots/${lotB.id}`, { token: dev }),
    409,
    {
      error: 'LOT_HAS_STOCK',
      fields: (b) => ({
        error: b.error,
        lotId: b.lotId === lotB.id,
        quantity: b.quantity,
      }),
    },
  );
  rec(
    'S8',
    'PATCH useStock:false with stock',
    await http('PATCH', `/products/${PLAIN}`, {
      token: dev,
      body: { useStock: false },
    }),
    409,
    { error: 'STOCK_TRACKING_HAS_STOCK' },
  );
  rec(
    'S5',
    'DELETE lot of this tenant from another tenant',
    await http('DELETE', `/products/${P}/lots/${lotB.id}`, { token: admin }),
    404,
  );
  void lotsRes;
  void variantsRes;
  rec(
    'S2',
    'POST /products/:id/lots raises the product total and journals INITIAL',
    await http('POST', `/products/${P}/lots`, {
      token: dev,
      body: {
        lotNumber: 'T8-NUEVO',
        quantity: 10,
        expirationDate: '2027-09-01',
      },
    }),
    201,
    {
      check: async () => {},
    },
  );
  const afterLot = await stockOf(P);
  assert.equal(afterLot.product.quantity, 80);
  records[records.length - 1].body = {
    productQuantityAfter: afterLot.product.quantity,
    lots: afterLot.lots.map((l) => [l.lotNumber, l.quantity]),
  };

  // ── S6 / S7 sale across lots + untracked ─────────────────────────────────
  const address = await prisma.customerAddress.findFirst({
    where: { tenantId: tenant.id },
  });
  assert(
    address,
    'no customer address in the tenant to make a cancellable (delivery) sale',
  );
  // Neutralise the extra lot so the numbers stay: B 20, C 30, untracked 12 (A expired 8).
  const extra = afterLot.lots.find((l) => l.lotNumber === 'T8-NUEVO');
  rec(
    'S6',
    'fixture: adjust extra lot back to 0 (EXPIRED)',
    await adjust({
      target: { productId: P, lotId: extra.id },
      expectedVersion: extra.version,
      delta: -10,
      reason: 'DATA_ENTRY_CORRECTION',
    }),
    201,
  );
  rec(
    'S8',
    'DELETE lot at quantity 0',
    await http('DELETE', `/products/${P}/lots/${extra.id}`, { token: dev }),
    204,
  );
  const pre = await stockOf(P);
  assert.equal(pre.product.sellable, 62);
  const draft = (await http('POST', '/sales/drafts', { token: dev })).body;
  const added = await http('POST', `/sales/drafts/${draft.id}/items`, {
    token: dev,
    body: { productId: P, quantity: 60 },
  });
  rec('S6', 'draft addItem 60 (sellable 62)', added, 200, {
    fields: (b) => ({ totalCents: b.totalCents }),
  });
  rec(
    'S6',
    'draft addItem beyond sellable (63) is refused with the sales error body',
    await http(
      'POST',
      `/sales/drafts/${(await http('POST', '/sales/drafts', { token: dev })).body.id}/items`,
      { token: dev, body: { productId: P, quantity: 63 } },
    ),
    422,
    { error: 'BUSINESS_RULE_VIOLATION' },
  );
  await http('PUT', `/sales/drafts/${draft.id}/customer`, {
    token: dev,
    body: { customerId: address.customerId, shippingAddressId: address.id },
  });
  const charge = rec(
    'S6',
    'POST charge 60 (delivery=true so it stays cancellable)',
    await http('POST', `/sales/drafts/${draft.id}/charge`, {
      token: dev,
      headers: { 'idempotency-key': key() },
      body: {
        method: 'cash',
        amountCents: added.body.totalCents,
        delivery: true,
      },
    }),
    201,
    {
      fields: (b) => ({
        saleId: b.saleId,
        folio: b.folio,
        totalCents: b.totalCents,
        paymentStatus: b.paymentStatus,
      }),
    },
  );
  const saleId = charge.body.saleId;
  const sold = await kardex(P, '&limit=20');
  const saleRows = sold.items.filter((m) => m.type === 'SALE');
  const nameOf = (m) => m.labels.lot ?? 'Sin lote';
  rec(
    'S6',
    'SALE rows split FEFO (expired lot untouched)',
    {
      status: 200,
      body: saleRows.map((m) => ({
        type: m.type,
        bucket: m.bucket,
        lot: nameOf(m),
        delta: m.delta,
        balanceAfter: m.balanceAfter,
        productBalanceAfter: m.productBalanceAfter,
        group: m.group,
        actor: m.actor,
      })),
    },
    200,
    {
      check: () => {
        const by = Object.fromEntries(
          saleRows.map((m) => [nameOf(m), m.delta]),
        );
        assert.deepEqual(by, {
          'T8-ENE-27': -20,
          'T8-JUN-27': -30,
          'Sin lote': -10,
        });
        assert(
          saleRows.every(
            (m) => m.group.type === 'SALE' && m.group.id === saleId,
          ),
        );
        assert(!saleRows.some((m) => m.lotId === lotA.id));
      },
    },
  );
  const afterSale = await stockOf(P);
  rec(
    'S6',
    'stock after sale: expired lot still 8, product 10, sellable 2',
    {
      status: 200,
      body: {
        product: afterSale.product,
        lots: afterSale.lots.map((l) => [l.lotNumber, l.quantity, l.expired]),
      },
    },
    200,
    {
      check: () => {
        assert.equal(afterSale.product.quantity, 10);
        assert.equal(afterSale.product.sellable, 2);
        assert.equal(afterSale.lots.find((l) => l.id === lotA.id).quantity, 8);
      },
    },
  );
  const cancel = rec(
    'S7',
    'POST /sales/:id/cancel',
    await http('POST', `/sales/${saleId}/cancel`, {
      token: dev,
      body: { reason: 'ORDER_ERROR' },
    }),
    200,
    { fields: (b) => ({ status: b.status, cancelReason: b.cancelReason }) },
  );
  void cancel;
  const cancelled = (await kardex(P, '&limit=20')).items.filter(
    (m) => m.type === 'SALE_CANCELLATION',
  );
  rec(
    'S7',
    'SALE_CANCELLATION rows restore the same lots',
    {
      status: 200,
      body: cancelled.map((m) => ({
        type: m.type,
        bucket: m.bucket,
        lot: nameOf(m),
        delta: m.delta,
        balanceAfter: m.balanceAfter,
        productBalanceAfter: m.productBalanceAfter,
        group: m.group,
      })),
    },
    200,
    {
      check: () => {
        assert.deepEqual(
          Object.fromEntries(cancelled.map((m) => [nameOf(m), m.delta])),
          { 'T8-ENE-27': 20, 'T8-JUN-27': 30, 'Sin lote': 10 },
        );
        assert(cancelled.every((m) => m.group.id === saleId));
      },
    },
  );
  const restored = await stockOf(P);
  rec(
    'S7',
    'stock restored: product 70, sellable 62, expired lot 8',
    {
      status: 200,
      body: {
        product: restored.product,
        lots: restored.lots.map((l) => [l.lotNumber, l.quantity]),
      },
    },
    200,
    {
      check: () =>
        assert(
          restored.product.quantity === 70 && restored.product.sellable === 62,
        ),
    },
  );
  rec(
    'S7',
    'cancel twice is idempotent (200) and never restores twice',
    await http('POST', `/sales/${saleId}/cancel`, {
      token: dev,
      body: { reason: 'ORDER_ERROR' },
    }),
    200,
  );
  assert.equal(
    (await kardex(P, '&limit=50')).items.filter(
      (m) => m.type === 'SALE_CANCELLATION',
    ).length,
    3,
  );

  // Charge exceeding sellable: the stock drops between addItem and charge.
  const d2 = (await http('POST', '/sales/drafts', { token: dev })).body;
  const add2 = await http('POST', `/sales/drafts/${d2.id}/items`, {
    token: dev,
    body: { productId: P, quantity: 60 },
  });
  const u = (await stockOf(P)).product.untracked;
  await adjust({
    target: { productId: P },
    expectedVersion: u.version,
    delta: -5,
    reason: 'THEFT_LOSS',
  });
  const rowsPre = (await kardex(P, '&limit=100')).items.length;
  const stockPre = await stockOf(P);
  rec(
    'S6',
    'charge exceeding sellable (60 > 57)',
    await http('POST', `/sales/drafts/${d2.id}/charge`, {
      token: dev,
      headers: { 'idempotency-key': key() },
      body: { method: 'cash', amountCents: add2.body.totalCents },
    }),
    409,
    { error: 'STOCK_INSUFFICIENT_AT_CONFIRM' },
  );
  assert.deepEqual(await stockOf(P), stockPre);
  assert.equal((await kardex(P, '&limit=100')).items.length, rowsPre);
  rec(
    'S6',
    'nothing written by the failed charge (stock and kardex identical)',
    { status: 200, body: { unchanged: true } },
    200,
  );
  await http('DELETE', `/sales/drafts/${d2.id}`, { token: dev });

  // ── S8 removal rows ──────────────────────────────────────────────────────
  const FV = await mk('PrimeraVariante', {
    useStock: true,
    quantity: 5,
    priceCents: 1000,
  });
  rec(
    'S8',
    'first variant on a product with stock',
    await http('POST', `/products/${FV}/variants`, {
      token: dev,
      body: { name: 'Único', quantity: 2 },
    }),
    201,
  );
  rec(
    'S8',
    'kardex shows REMOVAL FIRST_VARIANT_ZEROING',
    await g(`/inventory/movements?productId=${FV}`),
    200,
    {
      check: (b) =>
        assert(
          b.items.some(
            (m) =>
              m.type === 'REMOVAL' &&
              m.removalCause === 'FIRST_VARIANT_ZEROING' &&
              m.delta === -5,
          ),
        ),
      fields: (b) =>
        b.items.map((m) => [m.type, m.bucket, m.delta, m.removalCause]),
    },
  );
  const vsNow = await stockOf(VP);
  rec(
    'S8',
    'DELETE variant with stock',
    await http('DELETE', `/products/${VP}/variants/${vsNow.variants[1].id}`, {
      token: dev,
    }),
    204,
  );
  rec(
    'S8',
    'kardex shows REMOVAL VARIANT_DELETED',
    await g(
      `/inventory/movements?productId=${VP}&variantId=${vsNow.variants[1].id}`,
    ),
    200,
    {
      check: (b) =>
        assert(
          b.items.some(
            (m) =>
              m.type === 'REMOVAL' &&
              m.removalCause === 'VARIANT_DELETED' &&
              m.delta === -9,
          ),
        ),
      fields: (b) =>
        b.items.map((m) => [
          m.type,
          m.labels.variant,
          m.delta,
          m.balanceAfter,
          m.removalCause,
        ]),
    },
  );
  const SV = await mk('AServicio', {
    useStock: true,
    quantity: 3,
    priceCents: 1000,
  });
  rec(
    'S8',
    'PATCH type PRODUCT→SERVICE with stock is blocked (existing rule)',
    await http('PATCH', `/products/${SV}`, {
      token: dev,
      body: { type: 'SERVICE' },
    }),
    422,
    { error: 'PRODUCT_TYPE_CHANGE_BLOCKED' },
  );
  rec(
    'S8',
    'adjust the product to 0, then PATCH type SERVICE succeeds',
    await adjust({
      target: { productId: SV },
      expectedVersion: (await stockOf(SV)).product.untracked.version,
      delta: -3,
      reason: 'DATA_ENTRY_CORRECTION',
    }),
    201,
  );
  rec(
    'S8',
    'PATCH type SERVICE at stock 0',
    await http('PATCH', `/products/${SV}`, {
      token: dev,
      body: { type: 'SERVICE' },
    }),
    200,
  );
  rec(
    'S8',
    'kardex of the converted product',
    await g(`/inventory/movements?productId=${SV}`),
    200,
    {
      fields: (b) =>
        b.items.map((m) => [m.type, m.bucket, m.delta, m.removalCause]),
    },
  );

  // ── S9 /orders retired ───────────────────────────────────────────────────
  rec(
    'S9',
    'POST /orders',
    await http('POST', '/orders', { token: dev, body: { items: [] } }),
    404,
  );
  rec(
    'S9',
    'PATCH /orders/:id/cancel',
    await http('PATCH', `/orders/${crypto.randomUUID()}/cancel`, {
      token: dev,
    }),
    404,
  );
  rec('S9', 'GET /orders', await g('/orders'), 404);

  // ── Cleanup: delete the throwaway products (writes REMOVAL rows; history survives) ──
  const kept = [];
  for (const id of created) {
    const del = await http('DELETE', `/products/${id}`, { token: dev });
    // A product with sale history cannot be deleted (FK): 400 «Invalid relation reference».
    if (del.status !== 204) kept.push({ id, status: del.status });
  }
  const removed = (await kardex(PLAIN, '&limit=100')).items.filter(
    (m) => m.type === 'REMOVAL',
  );
  rec(
    'S8',
    'DELETE product with stock: REMOVAL PRODUCT_DELETED row; history still readable',
    {
      status: 200,
      body: removed.map((m) => [
        m.type,
        nameOf(m),
        m.delta,
        m.balanceAfter,
        m.removalCause,
      ]),
    },
    200,
    {
      check: () =>
        assert(
          removed.length === 1 &&
            removed[0].delta === -17 &&
            removed[0].removalCause === 'PRODUCT_DELETED',
        ),
    },
  );
  rec(
    'S8',
    'DELETE product that has sale history is blocked by its FK (existing behavior)',
    { status: kept[0] ? kept[0].status : 204, body: kept },
    400,
  );
  rec(
    'S8',
    'kardex of the deleted product returns its full history',
    await g(`/inventory/movements?productId=${PLAIN}&limit=100`),
    200,
    {
      check: (b) => assert(b.items.length >= 8),
      fields: (b) => ({ rows: b.items.length, nextCursor: b.nextCursor }),
    },
  );
  rec(
    'S10',
    'kardex of an unknown product: empty page',
    await g(`/inventory/movements?productId=${crypto.randomUUID()}`),
    200,
    { check: (b) => assert.deepEqual(b, { items: [], nextCursor: null }) },
  );

  fs.writeFileSync(
    EVIDENCE,
    JSON.stringify(
      {
        tenant: tenant.slug,
        createdProbeProducts: created,
        keptBecauseOfSales: kept,
        records,
      },
      null,
      2,
    ),
  );
  const failed = records.filter((r) => !r.ok);
  for (const r of records)
    console.log(
      `${r.ok ? 'PASS' : 'FAIL'} ${r.specs.padEnd(4)} HTTP ${String(r.status).padEnd(3)} ${r.label}`,
    );
  console.log(
    `\n${records.length - failed.length}/${records.length} probes passed; evidence: ${EVIDENCE}`,
  );
  await prisma.$disconnect();
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
