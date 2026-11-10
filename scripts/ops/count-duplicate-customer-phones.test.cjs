// Offline: `node --test scripts/ops/count-duplicate-customer-phones.test.cjs`
// Pure counting and masking (no DB). The parity test loads the compiled
// `canonicalPhone` (run `pnpm build` first) and pins the contract R1 cases, so
// the script cannot drift from the function intake uses.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  analyzeCustomers,
  loadCanonicalPhone,
  maskPhone,
  parseArgs,
  CANONICAL_PHONE_DIST,
} = require('./count-duplicate-customer-phones.cjs');

// Stand-in for the pure counting tests: country code digits + last 10 digits.
const stub = (cc, phone) => {
  const ccDigits = String(cc).replace(/\D/g, '');
  const digits = String(phone).replace(/\D/g, '');
  const cleanCc = ccDigits === '521' ? '52' : ccDigits;
  return digits.length >= 10 && cleanCc ? cleanCc + digits.slice(-10) : null;
};

const customer = (id, phoneCountryCode, phone, tenantId = 't1') => ({
  id,
  tenantId,
  phoneCountryCode,
  phone,
});
const run = (customers) =>
  analyzeCustomers({ customers, canonicalPhone: stub, exampleLimit: 3 });

test('counts canonical keys shared by more than one customer, per tenant', () => {
  const result = run([
    customer('a', '52', '5512345678'),
    customer('b', '521', '5512345678'),
    customer('c', '52', '5512345678'),
    customer('d', '52', '5599998888'),
    customer('e', '52', '5512345678', 't2'),
  ]);
  assert.deepEqual(result.get('t1').duplicateKeys, 1);
  assert.equal(result.get('t1').customersInDuplicateKeys, 3);
  assert.equal(result.get('t1').canonicalKeys, 2);
  assert.equal(result.get('t1').customers, 4);
  assert.equal(result.get('t2').duplicateKeys, 0);
});

test('counts null-country-code customers that would collide with a coded one', () => {
  const result = run([
    customer('a', '52', '5512345678'),
    customer('b', null, '5512345678'),
    customer('c', '', '525512345678'),
    customer('d', null, '5500000000'),
    customer('e', null, 'abc'),
  ]);
  const t1 = result.get('t1');
  // `e` has no phone digits at all, so it is not counted as uncoded.
  assert.equal(t1.nullCountryCode, 3);
  assert.equal(t1.nullCountryCollisions, 2);
  assert.equal(t1.duplicateKeys, 0);
});

test('a null-country-code customer alone, with no coded one, collides with nothing', () => {
  const t1 = run([customer('a', null, '5512345678')]).get('t1');
  assert.equal(t1.nullCountryCode, 1);
  assert.equal(t1.nullCountryCollisions, 0);
});

test('prints masked examples only, never a full phone', () => {
  const result = run([
    customer('a', '52', '5512345678'),
    customer('b', '521', '5512345678'),
    customer('c', null, '5512345678'),
  ]);
  const t1 = result.get('t1');
  assert.deepEqual(t1.examples, [{ phone: '55****5678', customers: 2 }]);
  assert.deepEqual(t1.nullCountryExamples, ['55****5678']);
  assert.ok(!JSON.stringify([...result]).includes('5512345678'));
});

test('limits the examples', () => {
  const customers = [];
  for (let i = 0; i < 5; i += 1) {
    const phone = `55${String(10000000 + i)}`;
    customers.push(
      customer(`a${i}`, '52', phone),
      customer(`b${i}`, '52', phone),
    );
  }
  assert.equal(run(customers).get('t1').examples.length, 3);
  assert.equal(run(customers).get('t1').duplicateKeys, 5);
});

test('maskPhone keeps the area code and the last four digits', () => {
  assert.equal(maskPhone('525512345678'), '55****5678');
  assert.equal(maskPhone('5512345678'), '55****5678');
  assert.equal(maskPhone('12345'), '****');
  assert.equal(maskPhone(''), '****');
});

test('parseArgs accepts --tenant and --help only (read-only: no --apply)', () => {
  assert.deepEqual(parseArgs([]), { tenant: null, help: false });
  assert.deepEqual(parseArgs(['--tenant', 'centro']), {
    tenant: 'centro',
    help: false,
  });
  assert.equal(parseArgs(['--help']).help, true);
  assert.throws(() => parseArgs(['--apply']), { code: 'BAD_ARGS' });
  assert.throws(() => parseArgs(['--tenant']), { code: 'BAD_ARGS' });
});

test(
  'parity: the compiled canonicalPhone gives the R1 contract keys',
  {
    skip:
      !fs.existsSync(path.join(process.cwd(), CANONICAL_PHONE_DIST)) &&
      'run pnpm build first',
  },
  () => {
    const canonicalPhone = loadCanonicalPhone(process.cwd());
    const cases = [
      ['52', '5512345678', '525512345678'],
      ['52', '5215512345678', '525512345678'],
      ['521', '5512345678', '525512345678'],
      ['52', '15512345678', '525512345678'],
      ['+52', '+52 1 55 1234 5678', '525512345678'],
      ['1', '15555550123', '15555550123'],
      ['57', '3001234567', '573001234567'],
      ['52', '0512345678', null],
      ['52', '551234567', null],
      ['52', 'abc', null],
    ];
    for (const [cc, phone, key] of cases) {
      assert.equal(canonicalPhone(cc, phone), key, `${cc} ${phone}`);
    }
  },
);
