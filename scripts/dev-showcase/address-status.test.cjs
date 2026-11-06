// Offline: `node --test scripts/dev-showcase/address-status.test.cjs` (pure
// data and planning checks; no API, no database).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SALES,
  CUSTOMER,
  idempotencyKey,
  planAddresses,
  planSourceStatus,
} = require('./address-status.cjs');
const { ZONES } = require('./shipping.cjs');

const bySlug = (slug) => SALES.find((spec) => spec.slug === slug);
const unchanged = SALES.find((spec) => spec.status === 'UNCHANGED');
const changed = SALES.find((spec) => spec.status === 'CHANGED');
const deleted = SALES.find((spec) => spec.status === 'DELETED');

test('one sale per source status, each with its own street and key', () => {
  assert.deepEqual(SALES.map((spec) => spec.status).sort(), [
    'CHANGED',
    'DELETED',
    'UNCHANGED',
  ]);
  const streets = SALES.map((spec) => spec.address.street);
  assert.equal(new Set(streets).size, SALES.length);
  assert.equal(streets.includes(changed.editedStreet), false);
  const keys = SALES.map(idempotencyKey);
  assert.equal(new Set(keys).size, SALES.length);
  for (const key of keys) assert.match(key, /^showcase:sale:/);
});

test('addresses pass the customer address DTO limits and use FREE zones', () => {
  const free = new Set(
    ZONES.filter((z) => z.type === 'FREE' && z.isActive !== false).map(
      (z) => z.zipCode,
    ),
  );
  for (const { address } of SALES) {
    assert.ok(address.street.length >= 1 && address.street.length <= 200);
    assert.ok(address.exteriorNumber.length <= 20);
    assert.ok(address.zipCode.length <= 10);
    assert.ok(free.has(address.zipCode), address.zipCode);
  }
  assert.ok(changed.editedStreet.length <= 200);
  assert.match(CUSTOMER.phone, /^[0-9]{10}$/);
});

test('planAddresses adds only the streets of sales not charged yet', () => {
  const all = SALES.map((spec) => spec.address);
  assert.deepEqual(planAddresses(SALES, new Set(), []), all);
  assert.deepEqual(planAddresses(SALES, new Set(), all), []);
  // Charged sales never get their (edited or deleted) address back.
  const charged = new Set(SALES.map((spec) => spec.slug));
  assert.deepEqual(planAddresses(SALES, charged, []), []);
  assert.deepEqual(
    planAddresses(SALES, new Set([changed.slug]), [unchanged.address]),
    [deleted.address],
  );
});

test('planSourceStatus edits the CHANGED source street once', () => {
  const street = changed.address.street;
  const sale = { shippingStreet: street, shippingAddressId: 'a2' };
  assert.deepEqual(planSourceStatus(changed, sale, { street }), {
    action: 'patch',
    body: { street: changed.editedStreet },
  });
  assert.equal(
    planSourceStatus(changed, sale, { street: changed.editedStreet }),
    null,
  );
  // Already deleted by hand: nothing to edit any more.
  assert.equal(
    planSourceStatus(
      changed,
      { shippingStreet: street, shippingAddressId: null },
      null,
    ),
    null,
  );
});

test('planSourceStatus deletes the DELETED source address once', () => {
  const street = deleted.address.street;
  assert.deepEqual(
    planSourceStatus(
      deleted,
      { shippingStreet: street, shippingAddressId: 'a3' },
      { street },
    ),
    { action: 'delete' },
  );
  assert.equal(
    planSourceStatus(
      deleted,
      { shippingStreet: street, shippingAddressId: null },
      null,
    ),
    null,
  );
});

test('planSourceStatus never touches the UNCHANGED source address', () => {
  const street = unchanged.address.street;
  const sale = { shippingStreet: street, shippingAddressId: 'a1' };
  assert.equal(planSourceStatus(unchanged, sale, { street }), null);
  assert.equal(
    planSourceStatus(unchanged, sale, { street: 'Editada en el FE' }),
    null,
  );
  assert.equal(bySlug('domicilio-sin-cambios'), unchanged);
});
