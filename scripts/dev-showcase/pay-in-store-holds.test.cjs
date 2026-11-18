// Offline: `node --test scripts/dev-showcase/pay-in-store-holds.test.cjs`
// (pure planning helpers; no dist/, no database, no API).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseArgs,
  assertLocalApi,
  readBotToken,
  credentialProblem,
  planLive,
  planReview,
  partialAmount,
  unitPrice,
} = require('./pay-in-store-holds.cjs');

const NOW = new Date('2026-11-18T12:00:00.000Z');
const at = (ms) => new Date(NOW.getTime() + ms);
const HOUR = 3_600_000;

const openSale = (overrides = {}) => ({
  id: 's-1',
  status: 'CONFIRMED',
  channel: 'ONLINE',
  fulfillmentMode: 'PICKUP',
  paymentStatus: 'CREDIT',
  paidCents: 0,
  paymentIntent: 'IN_STORE',
  holdExpiresAt: at(24 * HOUR),
  holdStage: 0,
  ...overrides,
});

test('parseArgs defaults to a dry run with a 60 s review deadline', () => {
  assert.deepEqual(parseArgs([]), { apply: false, reviewInSeconds: 60 });
  assert.deepEqual(parseArgs(['--apply', '--review-in', '120']), {
    apply: true,
    reviewInSeconds: 120,
  });
  assert.throws(() => parseArgs(['--review-in', '5']), /between 30 and 3600/);
  assert.throws(() => parseArgs(['--force']), /unknown option/);
});

test('assertLocalApi accepts local hosts and refuses remote ones', () => {
  assert.equal(
    assertLocalApi('http://127.0.0.1:3003/', {}),
    'http://127.0.0.1:3003',
  );
  assert.equal(
    assertLocalApi('http://localhost:3003', {}),
    'http://localhost:3003',
  );
  assert.throws(
    () => assertLocalApi('https://api.houndfe.com', {}),
    /Refusing to call API host "api.houndfe.com"/,
  );
  assert.equal(
    assertLocalApi('https://dev.example.test', { SHOWCASE_ALLOW: '1' }),
    'https://dev.example.test',
  );
});

test('readBotToken prefers the env var, falls back to the file, needs svc_', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hold-token-'));
  fs.writeFileSync(path.join(dir, 'token'), 'svc_from_file\n');
  assert.equal(readBotToken({ SHOWCASE_BOT_TOKEN: 'svc_env' }, dir), 'svc_env');
  assert.equal(
    readBotToken({ SHOWCASE_BOT_TOKEN_FILE: 'token' }, dir),
    'svc_from_file',
  );
  assert.throws(
    () => readBotToken({ SHOWCASE_BOT_TOKEN: 'abc' }, dir),
    /must start with svc_/,
  );
  assert.throws(
    () => readBotToken({ SHOWCASE_BOT_TOKEN_FILE: 'missing' }, dir),
    /No bot credential/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('credentialProblem requires a Centro credential with both sales scopes', () => {
  assert.equal(
    credentialProblem(
      { tenantId: 't', scopes: ['sales:create', 'sales:write'] },
      't',
    ),
    null,
  );
  assert.match(credentialProblem(null, 't'), /not found/);
  assert.match(
    credentialProblem(
      { tenantId: 'x', scopes: ['sales:create', 'sales:write'] },
      't',
    ),
    /another sucursal/,
  );
  assert.match(
    credentialProblem({ tenantId: 't', scopes: ['sales:create'] }, 't'),
    /lacks sales:write/,
  );
});

test('planLive keeps a hold more than 1 h ahead and replaces the rest', () => {
  assert.deepEqual(planLive(null, NOW).steps, ['create', 'mark']);
  assert.deepEqual(planLive(openSale(), NOW), { saleId: 's-1', steps: [] });
  assert.deepEqual(planLive(openSale({ paymentIntent: null }), NOW), {
    saleId: 's-1',
    steps: ['mark'],
  });
  for (const stale of [
    openSale({ holdExpiresAt: at(30 * 60_000) }),
    openSale({ holdStage: 2 }),
    openSale({ status: 'CANCELED' }),
    openSale({ paymentStatus: 'PARTIAL', paidCents: 100 }),
  ]) {
    assert.deepEqual(planLive(stale, NOW), {
      saleId: null,
      steps: ['create', 'mark'],
    });
  }
});

test('planReview finishes or restarts the expired-with-partial-payment sale', () => {
  const full = ['create', 'mark', 'shorten', 'pay'];
  assert.deepEqual(planReview(null, NOW).steps, full);
  assert.deepEqual(
    planReview(openSale({ paymentStatus: 'PARTIAL', paidCents: 100 }), NOW),
    { saleId: 's-1', steps: [] },
  );
  assert.deepEqual(planReview(openSale({ paymentIntent: null }), NOW).steps, [
    'mark',
    'shorten',
    'pay',
  ]);
  assert.deepEqual(planReview(openSale(), NOW).steps, ['shorten', 'pay']);
  assert.deepEqual(
    planReview(openSale({ holdExpiresAt: at(60_000) }), NOW).steps,
    ['pay'],
  );
  // Too close to (or past) the deadline: the sweep may cancel it first.
  assert.deepEqual(
    planReview(openSale({ holdExpiresAt: at(5_000) }), NOW).steps,
    full,
  );
  assert.deepEqual(
    planReview(openSale({ status: 'CANCELED' }), NOW).steps,
    full,
  );
});

test('partialAmount pays half and never the whole total', () => {
  assert.equal(partialAmount(28_900), 14_450);
  assert.equal(partialAmount(3), 1);
  assert.throws(() => partialAmount(1), /cannot be paid partially/);
});

test('unitPrice is the effective single-unit price of the first priced list', () => {
  assert.equal(unitPrice([{ priceCents: 28_900, tierPrices: [] }]), 28_900);
  assert.equal(
    unitPrice([
      {
        priceCents: 28_900,
        tierPrices: [
          { minQuantity: 5, priceCents: 25_000 },
          { minQuantity: 1, priceCents: 27_000 },
        ],
      },
    ]),
    27_000,
  );
  assert.throws(() => unitPrice([]), /no price/);
});
