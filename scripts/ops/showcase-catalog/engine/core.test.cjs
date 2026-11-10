// Offline: `node --test scripts/ops/showcase-catalog/engine/core.test.cjs`
// (pure engine parts: validation, variantKey mapping, payload building, SKU
// filter; no DB, no network).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('./core.cjs');
const fixture = require('./fixture.cjs');
const { retryDelayMs } = require('./images.cjs');

// The slice of the production vocabulary the fixture uses.
const options = (...codes) =>
  codes.map((code, sortOrder) => ({
    code,
    label: code,
    archived: false,
    sortOrder,
  }));
const units = (...codes) =>
  codes.map((code, sortOrder) => ({ code, label: code, sortOrder }));
const DEFINITIONS = [
  ['animal.target', 'multi', options('ani.dom.dog', 'ani.dom.cat')],
  ['life.stage', 'multi', options('life.dog.adult')],
  [
    'size.animal',
    'multi',
    options('size.animal.small', 'size.animal.medium', 'size.animal.large'),
  ],
  ['food.format', 'single', options('food.format.kibble')],
  ['food.role', 'single', options('food.role.complete')],
  [
    'food.texture',
    'multi',
    options('food.texture.dry', 'food.texture.crunchy'),
  ],
  ['pack.form', 'single', options('pack.form.bag', 'pack.form.bottle')],
  ['measure.net_mass', 'number', [], units('g', 'kg')],
  ['measure.net_volume', 'number', [], units('ml', 'l')],
  ['measure.fit.neck', 'range', [], units('cm', 'mm')],
  ['text.ingredients', 'text', []],
  ['text.instructions', 'text', []],
  ['accessory.type', 'single', options('accessory.type.collar')],
  [
    'color.base',
    'multi',
    [
      ...options('color.base.brown'),
      { code: 'color.base.old', label: 'x', archived: true, sortOrder: 9 },
    ],
  ],
  ['accessory.closure', 'multi', options('accessory.closure.buckle')],
  ['accessory.feature', 'multi', options('accessory.feature.adjustable')],
  ['size.label', 'single', options('size.label.m', 'size.label.l')],
  ['care.type', 'single', options('care.type.grooming')],
  ['care.form', 'single', options('care.form.solution')],
].map(([code, type, opts, unitRows = []]) => ({
  code,
  type,
  options: opts,
  units: unitRows,
}));
const bind = (codes) =>
  codes.map((definitionCode, sortOrder) => ({
    definitionCode,
    owner: 'sellable',
    sortOrder,
  }));
const VOCABULARY = {
  definitions: DEFINITIONS,
  families: [
    {
      code: 'food',
      bindings: bind([
        'animal.target',
        'life.stage',
        'size.animal',
        'food.format',
        'food.role',
        'food.texture',
        'pack.form',
        'measure.net_mass',
        'text.ingredients',
      ]),
    },
    {
      code: 'accessory',
      bindings: bind([
        'animal.target',
        'accessory.type',
        'color.base',
        'accessory.closure',
        'accessory.feature',
        'size.label',
        'size.animal',
        'measure.fit.neck',
      ]),
    },
    {
      code: 'care',
      bindings: bind([
        'animal.target',
        'care.type',
        'care.form',
        'pack.form',
        'measure.net_volume',
        'text.instructions',
      ]),
    },
  ],
};
const LISTS = {
  defaultId: 'g-publico',
  catalogDefaultId: 'g-publico',
  mayoreoId: 'g-mayoreo',
};
const clone = (value) => structuredClone(value);
const [food, collar, shampoo] = fixture;

test('the fixture validates against the vocabulary', () => {
  assert.deepEqual(core.validateCatalog(fixture, VOCABULARY), []);
});

test('SKU prefix, case and uniqueness are enforced before any write', () => {
  const products = clone(fixture);
  products[0].sku = 'FX-NO-PREFIX';
  products[1].variants[1].sku = 'sc-lower';
  products[2].sku = products[1].variants[0].sku;
  const problems = core.validateCatalog(products, VOCABULARY, {
    existingSkus: ['sc-fx-collar'],
  });
  assert.ok(problems.some((p) => p.includes('"FX-NO-PREFIX" must match')));
  assert.ok(problems.some((p) => p.includes('"sc-lower" must match')));
  assert.ok(problems.some((p) => p.includes('SC-FX-COLLAR-M also used by')));
  assert.ok(problems.some((p) => p.includes('SC-FX-COLLAR already taken')));
});

test('prices, names and stock are checked', () => {
  const products = clone(fixture);
  products[0].price = 0;
  products[0].brand = 'X';
  products[1].variants[0].mayoreo = -5;
  products[2].stock = 1.5;
  const problems = core.validateCatalog(products, VOCABULARY);
  assert.ok(
    problems.some((p) => p.startsWith('#1') && p.includes('price must be > 0')),
  );
  assert.ok(problems.some((p) => p.includes('brand must be 2..50')));
  assert.ok(
    problems.some((p) => p.includes('variants[0] m: mayoreo must be > 0')),
  );
  assert.ok(
    problems.some(
      (p) => p.startsWith('#3') && p.includes('stock must be an integer'),
    ),
  );
});

test('editorial codes must exist in the current vocabulary', () => {
  const products = clone(fixture);
  products[0].editorial.values.push({
    code: 'toy.type',
    variantKey: null,
    payload: { type: 'multi', value: ['x'] },
  });
  products[0].editorial.values[0].payload.value = ['ani.dom.dragon'];
  const color = products[1].editorial.values.find(
    (v) => v.code === 'color.base',
  );
  color.payload = { type: 'multi', value: ['color.base.old'] };
  products[2].editorial.values.find(
    (v) => v.code === 'measure.net_volume',
  ).payload.unit = 'gal';
  const problems = core.validateCatalog(products, VOCABULARY);
  assert.ok(
    problems.some((p) => p.includes('toy.type: not bound to family food')),
  );
  assert.ok(problems.some((p) => p.includes('unknown option ani.dom.dragon')));
  assert.ok(problems.some((p) => p.includes('archived option color.base.old')));
  assert.ok(problems.some((p) => p.includes('unit gal not in [ml,l]')));
});

test('variantKey: required on variant products, null on simple ones', () => {
  const products = clone(fixture);
  products[0].editorial.values[0].variantKey = 'm';
  products[1].editorial.values[0].variantKey = null;
  products[1].editorial.facts[1].variantKey = 'xl';
  const problems = core.validateCatalog(products, VOCABULARY);
  assert.ok(
    problems.some(
      (p) =>
        p.startsWith('#1') &&
        p.includes('simple product takes variantKey null'),
    ),
  );
  assert.ok(
    problems.some(
      (p) => p.startsWith('#2') && p.includes('needs a variantKey'),
    ),
  );
  assert.ok(problems.some((p) => p.includes('unknown variantKey "xl"')));
  assert.ok(problems.some((p) => p.includes('variant "l" has no facts row')));
});

test('the editorial document maps variantKey to the created variant id and fills evidence', () => {
  const ids = new Map([
    ['m', 'v-m'],
    ['l', 'v-l'],
  ]);
  const doc = core.editorialDocument(collar, VOCABULARY, ids, '2026-11-09');
  assert.deepEqual(Object.keys(doc).sort(), [
    'commercialTitle',
    'description',
    'facts',
    'familyCode',
    'mediaRefs',
    'schemaVersion',
    'values',
  ]);
  assert.equal(doc.schemaVersion, 2);
  assert.deepEqual(doc.mediaRefs, []);
  assert.deepEqual([...new Set(doc.values.map((v) => v.variantId))].sort(), [
    'v-l',
    'v-m',
  ]);
  assert.deepEqual(
    doc.facts.map((f) => f.variantId),
    ['v-m', 'v-l'],
  );
  for (const value of doc.values) {
    assert.equal(value.owner, 'sellable');
    assert.equal(value.state, 'known');
    assert.deepEqual(value.evidence, {
      sourceRef: 'Ficha del fabricante',
      verifiedOn: '2026-11-09',
    });
  }
  const declaration = doc.facts[0].declarations[0];
  assert.deepEqual(Object.keys(declaration).sort(), [
    'basis',
    'evidence',
    'key',
    'state',
    'value',
  ]);
  assert.equal(doc.facts[0].careReview, null);
  assert.throws(
    () =>
      core.editorialDocument(
        collar,
        VOCABULARY,
        new Map([['m', 'v-m']]),
        '2026-11-09',
      ),
    /variantKey "l"/,
  );
});

test('simple products keep variantId null; care reviews pass through; unknown states carry no payload', () => {
  const spec = clone(shampoo);
  spec.editorial.values.push({
    code: 'text.instructions',
    variantKey: null,
    state: 'unknown',
  });
  spec.editorial.values.splice(5, 1);
  const doc = core.editorialDocument(spec, VOCABULARY, new Map(), '2026-11-09');
  assert.ok(doc.values.every((v) => v.variantId === null));
  assert.deepEqual(doc.values.at(-1), {
    code: 'text.instructions',
    owner: 'sellable',
    variantId: null,
    state: 'unknown',
    evidence: null,
  });
  assert.deepEqual(
    doc.facts[0].careReview,
    shampoo.editorial.facts[0].careReview,
  );
  assert.notEqual(
    doc.facts[0].careReview,
    shampoo.editorial.facts[0].careReview,
  );
  assert.equal(core.careConfirmationFor('care'), 'review-v1');
  assert.equal(core.careConfirmationFor('food'), null);
});

test('product body: cents, Mayoreo inline, stock where it belongs', () => {
  const simple = core.productBody(
    food,
    { categoryId: 'c', brandId: 'b' },
    LISTS,
  );
  assert.equal(simple.priceCents, 48900);
  assert.equal(simple.quantity, 25);
  assert.equal(simple.minQuantity, core.LOW_STOCK_THRESHOLD);
  assert.deepEqual(simple.priceLists, [
    { priceListId: 'g-mayoreo', priceCents: 43900 },
  ]);
  assert.equal(simple.purchaseCost.valueCents, 32000);
  assert.equal(simple.ivaRate, 'IVA_0');
  assert.equal(simple.hasVariants, undefined);

  const variant = core.productBody(
    collar,
    {},
    { ...LISTS, catalogDefaultId: 'g-online' },
  );
  assert.equal(variant.hasVariants, true);
  assert.equal(variant.quantity, undefined);
  assert.deepEqual(
    variant.variants.map((v) => [v.sku, v.quantity, v.minQuantity]),
    [
      ['SC-FX-COLLAR-M', 3, 5],
      ['SC-FX-COLLAR-L', 0, 5],
    ],
  );
  assert.equal(variant.minQuantity, undefined);
  assert.deepEqual(
    variant.priceLists.map((row) => row.priceListId),
    ['g-mayoreo', 'g-online'],
  );
  assert.equal(variant.ivaRate, 'IVA_16');
});

test('variant prices target the product price-list rows', () => {
  const productLists = new Map([
    ['g-publico', 'pl-1'],
    ['g-mayoreo', 'pl-2'],
  ]);
  const bodies = core.variantPriceBodies(collar, productLists, LISTS);
  assert.deepEqual(bodies.get('l'), {
    prices: [
      { priceListId: 'pl-1', priceCents: 38900 },
      { priceListId: 'pl-2', priceCents: 33500 },
    ],
  });
  assert.throws(
    () => core.variantPriceBodies(collar, new Map(), LISTS),
    /no price list/,
  );
});

test('SKU filter for --delete and --only selection', () => {
  const rows = [
    { sku: 'SC-A' },
    { sku: 'sc-b' },
    { sku: 'XSC-C' },
    { sku: null },
    { sku: 'PARACETAMOL' },
  ];
  assert.deepEqual(
    core.showcaseProducts(rows).map((r) => r.sku),
    ['SC-A', 'sc-b'],
  );
  assert.deepEqual(
    core.selectProducts(fixture, 'fx-collar-cuero').map((s) => s.key),
    ['fx-collar-cuero'],
  );
  assert.equal(core.selectProducts(fixture, undefined).length, 3);
  assert.throws(
    () => core.selectProducts(fixture, 'nope'),
    /unknown keys nope/,
  );
});

test('helpers: https only, MIME base, readiness lines, keys, backoff', () => {
  assert.equal(
    core.isAllowedImageUrl('https://upload.wikimedia.org/a.jpg'),
    true,
  );
  assert.equal(core.isAllowedImageUrl('http://example.com/a.jpg'), false);
  assert.equal(core.isAllowedImageUrl('not a url'), false);
  assert.equal(core.baseMime('image/JPEG; charset=binary'), 'image/jpeg');
  assert.deepEqual(
    core.readinessLines(
      [
        {
          scope: 'definition',
          definitionCode: 'measure.net_mass',
          variantId: 'v-1',
          problem: 'REQUIRED_MISSING',
          message: 'Falta el peso neto.',
        },
      ],
      new Map([['v-1', 'm']]),
    ),
    ['measure.net_mass [m] REQUIRED_MISSING: Falta el peso neto.'],
  );
  const key = core.idempotencyKeyFor(
    'ab12cd34',
    '67895e12-264e-49b7-b34d-d322db159127',
    'publish',
  );
  assert.ok(key.length >= 1 && key.length <= 200 && !key.includes(','));
  assert.equal(retryDelayMs('3', 0), 3000);
  assert.equal(retryDelayMs(null, 2), 8000);
});
