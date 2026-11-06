// Offline: `node --test scripts/dev-showcase/shipping.test.cjs` (pure data and
// planning checks; no API, no database). The hash cross-check against the
// API's own function runs only when `dist/` is built.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const shipping = require('./shipping.cjs');

const {
  ZONES,
  VALIDATIONS,
  BOXES,
  ORIGIN,
  OPENING_HOURS,
  PACKAGING,
  VARIANT_PACKAGING,
  urgencyLevel,
  intakeRequest,
  hashIntake,
  zoneBody,
  planZone,
  planBoxes,
  planReanchor,
  stableUuid,
} = shipping;

const NOW = new Date('2026-11-06T18:00:00.000Z');
const HOUR = 3_600_000;
const ZIP = /^[0-9]{5}$/;
const oneDecimal = (n) => Math.round(n * 10) === n * 10;
const minutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

// Mirrors normalizeZoneSettings (delivery-zone.policy.ts).
function zoneShapeOk({ type, surchargeCents = null, etaDays = null }) {
  const eta = Number.isInteger(etaDays) && etaDays >= 0 && etaDays <= 60;
  switch (type) {
    case 'FREE':
      return surchargeCents === null && eta;
    case 'SURCHARGE':
      return (
        Number.isInteger(surchargeCents) &&
        surchargeCents >= 1 &&
        surchargeCents <= 100_000_000 &&
        eta
      );
    case 'CARRIER_ONLY':
    case 'DENIED':
      return surchargeCents === null && etaDays === null;
    default:
      return false;
  }
}

test('zones cover every type with valid shapes and unique postal codes', () => {
  assert.deepEqual([...new Set(ZONES.map((z) => z.type))].sort(), [
    'CARRIER_ONLY',
    'DENIED',
    'FREE',
    'SURCHARGE',
  ]);
  for (const zone of ZONES) {
    assert.match(zone.zipCode, ZIP);
    assert.ok(zoneShapeOk(zoneBody(zone)), `bad shape ${zone.zipCode}`);
    for (const label of [zone.municipality, zone.neighborhood]) {
      assert.ok(label.length >= 1 && label.length <= 120);
    }
  }
  assert.equal(new Set(ZONES.map((z) => z.zipCode)).size, ZONES.length);
  assert.equal(ZONES.filter((z) => z.isActive === false).length, 1);
});

test('zone PUT bodies omit the fields their type forbids', () => {
  const body = (type) => zoneBody(ZONES.find((z) => z.type === type));
  assert.deepEqual(Object.keys(body('DENIED')).sort(), [
    'municipality',
    'neighborhood',
    'state',
    'type',
  ]);
  assert.equal(body('FREE').surchargeCents, undefined);
  assert.equal(typeof body('SURCHARGE').surchargeCents, 'number');
});

test('validations never share a postal code with a manual zone', () => {
  const zoneZips = new Set(ZONES.map((z) => z.zipCode));
  for (const spec of VALIDATIONS) {
    assert.match(spec.zipCode, ZIP);
    assert.equal(zoneZips.has(spec.zipCode), false, spec.zipCode);
  }
  assert.ok(VALIDATIONS.some((v) => v.requesters.length >= 2 && v.level));
  const approve = VALIDATIONS.find((v) => v.resolve).resolve;
  assert.ok(
    zoneShapeOk({
      type: approve.zoneType,
      surchargeCents: approve.surchargeCents,
      etaDays: approve.etaDays,
    }),
  );
});

test('the planned offsets give OK, WARNING and CRITICAL right after seeding', () => {
  const levels = VALIDATIONS.filter((v) => v.level).map((spec) => {
    const oldest = Math.max(...spec.requesters.map((r) => r.hoursAgo));
    assert.equal(
      urgencyLevel(new Date(NOW.getTime() - oldest * HOUR), NOW),
      spec.level,
      spec.zipCode,
    );
    return spec.level;
  });
  assert.deepEqual(levels.sort(), ['CRITICAL', 'OK', 'WARNING']);
});

test('urgency bands match the backend policy', () => {
  const at = (hoursLeft) =>
    urgencyLevel(new Date(NOW.getTime() - (24 - hoursLeft) * HOUR), NOW);
  assert.equal(at(12), 'OK');
  assert.equal(at(11.9), 'WARNING');
  assert.equal(at(4), 'WARNING');
  assert.equal(at(3.9), 'CRITICAL');
  assert.equal(at(0), 'EXPIRED');
  assert.equal(at(-5), 'EXPIRED');
});

test('intake requests are deterministic and pass the intake parser rules', () => {
  const spec = VALIDATIONS[0];
  const a = intakeRequest(spec, spec.requesters[0], NOW);
  const b = intakeRequest(spec, spec.requesters[0], NOW);
  assert.deepEqual(a, b);
  assert.equal(hashIntake(a), hashIntake(b));
  assert.match(
    a.sourceRequestId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.match(a.phoneCountryCode, /^[0-9]{1,10}$/);
  assert.match(a.phone, /^[0-9]{1,20}$/);
  assert.ok(a.conversationRef.length <= 200);
  const ids = VALIDATIONS.flatMap((v) => v.requesters).map((r) =>
    stableUuid(`delivery-zone-request:${r.key}`),
  );
  assert.equal(new Set(ids).size, ids.length);
});

test('the hash covers the message instant, so a re-anchor rewrites it', () => {
  const spec = VALIDATIONS[0];
  const now = intakeRequest(spec, spec.requesters[0], NOW);
  const later = intakeRequest(
    spec,
    spec.requesters[0],
    new Date(NOW.getTime() + HOUR),
  );
  assert.notEqual(hashIntake(now), hashIntake(later));
});

const distIntake = path.resolve(
  __dirname,
  '../../dist/delivery-zones/domain/delivery-zone-intake.request.js',
);
test(
  'hashIntake equals the API hashDeliveryZoneIntake',
  { skip: !fs.existsSync(distIntake) && 'dist/ not built' },
  () => {
    const { hashDeliveryZoneIntake } = require(distIntake);
    for (const spec of VALIDATIONS) {
      for (const requester of spec.requesters) {
        const request = intakeRequest(spec, requester, NOW);
        assert.equal(hashIntake(request), hashDeliveryZoneIntake(request));
      }
    }
  },
);

test('planZone creates only missing zones; existing ones are kept', () => {
  const active = ZONES.find((z) => z.isActive !== false);
  const inactive = ZONES.find((z) => z.isActive === false);
  assert.deepEqual(planZone(active, null), ['put']);
  assert.deepEqual(planZone(inactive, null), ['put', 'deactivate']);
  assert.deepEqual(planZone(active, { type: 'DENIED' }), []);
  assert.deepEqual(planZone(inactive, { isActive: true }), []);
});

test('planBoxes creates only names not taken yet', () => {
  assert.deepEqual(planBoxes(BOXES, []), BOXES);
  assert.deepEqual(planBoxes(BOXES, [{ name: 'Caja chica' }]), [BOXES[1]]);
  assert.deepEqual(planBoxes(BOXES, BOXES), []);
});

test('planReanchor touches a PENDING validation only when its level drifted', () => {
  const spec = VALIDATIONS.find((v) => v.level === 'WARNING');
  const rows = (hoursAgo) =>
    spec.requesters.map((r, i) => ({
      id: `r${i}`,
      status: 'PENDING',
      lastCustomerMessageAt: new Date(
        NOW.getTime() - (hoursAgo ?? r.hoursAgo) * HOUR,
      ),
    }));
  const pending = { status: 'PENDING' };
  assert.deepEqual(planReanchor(spec, pending, rows(), NOW), []);
  assert.equal(planReanchor(spec, pending, rows(30), NOW).length, 2);
  assert.deepEqual(
    planReanchor(spec, { status: 'RESOLVED' }, rows(30), NOW),
    [],
  );
  assert.deepEqual(planReanchor(spec, null, rows(30), NOW), []);
  const resolvedSpec = VALIDATIONS.find((v) => v.resolve);
  assert.deepEqual(planReanchor(resolvedSpec, pending, rows(30), NOW), []);
});

test('boxes and packaging respect the API limits, and every item fits a box', () => {
  const side = (n) => n >= 0.1 && n <= 300 && oneDecimal(n);
  const grams = (n) => Number.isInteger(n) && n >= 1 && n <= 70_000;
  for (const box of BOXES) {
    assert.ok(box.name.trim().length > 0 && box.name.length <= 80);
    for (const n of [box.innerLengthCm, box.innerWidthCm, box.innerHeightCm])
      assert.ok(side(n), box.name);
    assert.ok(grams(box.weightG) && grams(box.maxContentWeightG));
  }
  const sorted = (dims) => [...dims].sort((a, b) => b - a);
  for (const item of [...PACKAGING, ...VARIANT_PACKAGING]) {
    const dims = [item.lengthCm, item.widthCm, item.heightCm];
    dims.forEach((n) => assert.ok(side(n), item.product));
    assert.ok(grams(item.weightG), item.product);
    const fits = BOXES.some((box) => {
      const inner = sorted([
        box.innerLengthCm,
        box.innerWidthCm,
        box.innerHeightCm,
      ]);
      return (
        sorted(dims).every((n, i) => n <= inner[i]) &&
        item.weightG <= box.maxContentWeightG
      );
    });
    assert.ok(fits, `${item.product} fits no box`);
  }
  assert.equal(new Set(PACKAGING.map((p) => p.product)).size, 5);
  assert.ok(
    VARIANT_PACKAGING.every((v) =>
      PACKAGING.some((p) => p.product === v.product),
    ),
  );
});

test('origin and opening hours pass the store validation rules', () => {
  assert.match(ORIGIN.postalCode, ZIP);
  assert.match(ORIGIN.contactPhone, /^\+?\d{10,15}$/);
  const weekdays = OPENING_HOURS.days.map((d) => d.day);
  assert.deepEqual(weekdays, [
    'MONDAY',
    'TUESDAY',
    'WEDNESDAY',
    'THURSDAY',
    'FRIDAY',
    'SATURDAY',
    'SUNDAY',
  ]);
  for (const { day, ranges } of OPENING_HOURS.days) {
    for (const [i, r] of ranges.entries()) {
      assert.match(r.open, /^([01]\d|2[0-3]):[0-5]\d$/);
      assert.match(r.close, /^([01]\d|2[0-3]):[0-5]\d$/);
      assert.ok(minutes(r.open) < minutes(r.close), day);
      if (i > 0) assert.ok(minutes(r.open) > minutes(ranges[i - 1].close));
    }
  }
  assert.equal(OPENING_HOURS.days[0].ranges.length, 2);
  assert.equal(OPENING_HOURS.days[5].ranges.length, 1);
  assert.equal(OPENING_HOURS.days[6].ranges.length, 0);
});
