import {
  type EditorialOfferedSubjectObservationV2 as Observation,
  selectEditorialOfferedSubjectsV2 as select,
} from './editorial-offered-subjects-v2';

function fixture(): Observation {
  return {
    availableGlobalPriceListIds: ['a', 'b'],
    product: {
      type: 'PRODUCT',
      includeInOnlineCatalog: true,
      hidePriceInOnlineCatalog: false,
      requiresPrescription: false,
      hasVariants: false,
    },
    supportedCatalogPriceListIds: [],
    productPrices: [
      { id: 'pa', globalPriceListId: 'a', priceCents: 100 },
      { id: 'pb', globalPriceListId: 'b', priceCents: 200 },
    ],
    variants: [
      {
        id: 'v2',
        catalogPublishMode: 'INHERIT',
        prices: [{ priceListId: 'pb', priceCents: 20 }],
      },
      {
        id: 'v1',
        catalogPublishMode: 'ON',
        prices: [
          { priceListId: 'pa', priceCents: 10 },
          { priceListId: 'pb', priceCents: 30 },
        ],
      },
      {
        id: 'off',
        catalogPublishMode: 'OFF',
        prices: [{ priceListId: 'pa', priceCents: 10 }],
      },
    ],
  };
}

function shape(hasVariants: boolean): Observation {
  const input = fixture();
  return { ...input, product: { ...input.product, hasVariants } };
}

it.each([false, true])(
  'unions every available context, variants=%s',
  (variants) => {
    expect(select(shape(variants))).toEqual(variants ? ['v2', 'v1'] : [null]);
  },
);

it.each([false, true])(
  'offers through a non-default context without fallback, variants=%s',
  (variants) => {
    const input = shape(variants);
    expect(select({ ...input, availableGlobalPriceListIds: ['b'] })).toEqual(
      variants ? ['v2', 'v1'] : [null],
    );
    expect(
      select({ ...input, availableGlobalPriceListIds: ['unpriced'] }),
    ).toEqual([]);
  },
);

it.each([false, true])(
  'requires an available context even with hidden prices, variants=%s',
  (variants) => {
    const input = shape(variants);
    for (const flags of [
      {},
      { hidePriceInOnlineCatalog: true },
      { requiresPrescription: true },
    ]) {
      expect(
        select({
          ...input,
          availableGlobalPriceListIds: [],
          product: { ...input.product, ...flags },
        }),
      ).toEqual([]);
    }
  },
);

it.each([false, true])(
  'never bypasses the parent gates, variants=%s',
  (variants) => {
    const input = shape(variants);
    for (const flags of [
      {},
      { hidePriceInOnlineCatalog: true },
      { requiresPrescription: true },
    ]) {
      for (const exclusion of [
        { type: 'SERVICE' as const },
        { includeInOnlineCatalog: false },
      ]) {
        expect(
          select({
            ...input,
            product: { ...input.product, ...flags, ...exclusion },
          }),
        ).toEqual([]);
      }
    }
  },
);

it.each([false, true])(
  'honors empty, restricted and stale allowlists, variants=%s',
  (variants) => {
    const input = shape(variants);
    expect(select({ ...input, supportedCatalogPriceListIds: ['a'] })).toEqual(
      variants ? ['v1'] : [null],
    );
    expect(
      select({ ...input, supportedCatalogPriceListIds: ['b', 'stale'] }),
    ).toEqual(variants ? ['v2', 'v1'] : [null]);
    expect(
      select({ ...input, supportedCatalogPriceListIds: ['stale'] }),
    ).toEqual([]);
  },
);

it.each([false, true])(
  'requires positive product prices, variants=%s',
  (variants) => {
    const input = shape(variants);
    expect(select({ ...input, productPrices: [] })).toEqual([]);
    expect(
      select({
        ...input,
        productPrices: input.productPrices.map((row) => ({
          ...row,
          priceCents: 0,
        })),
      }),
    ).toEqual([]);
    expect(
      select({
        ...input,
        productPrices: input.productPrices.filter(
          (row) => row.globalPriceListId === 'a',
        ),
      }),
    ).toEqual(variants ? ['v1'] : [null]);
  },
);

it('requires BOTH prices in the same available context, never cross-context', () => {
  const input = shape(true);
  const observed = {
    ...input,
    productPrices: input.productPrices.map((row) => ({
      ...row,
      priceCents: row.id === 'pa' ? 100 : 0,
    })),
  };
  expect(select(observed)).toEqual(['v1']);
  expect(select({ ...observed, variants: [input.variants[0]] })).toEqual([]);
  expect(
    select({
      ...input,
      supportedCatalogPriceListIds: ['a'],
      variants: [input.variants[0]],
    }),
  ).toEqual([]);
});

it.each([0, 1])(
  'checks positive prices for each real variant, price=%s',
  (priceCents) => {
    const input = shape(true);
    const variants = input.variants.map((variant) => ({
      ...variant,
      prices: variant.prices.map((price) => ({ ...price, priceCents })),
    }));
    expect(select({ ...input, variants })).toEqual(
      priceCents ? ['v2', 'v1'] : [],
    );
    expect(
      select({
        ...input,
        variants: variants.map((variant) => ({ ...variant, prices: [] })),
      }),
    ).toEqual([]);
  },
);

it.each(['hidePriceInOnlineCatalog', 'requiresPrescription'] as const)(
  '%s bypasses prices and allowlists but not variant membership',
  (flag) => {
    for (const hasVariants of [false, true]) {
      const input = shape(hasVariants);
      const observed = {
        ...input,
        product: { ...input.product, [flag]: true },
        supportedCatalogPriceListIds: ['stale'],
        productPrices: [],
        variants: input.variants.map((variant) => ({ ...variant, prices: [] })),
      };
      expect(select(observed)).toEqual(hasVariants ? ['v2', 'v1'] : [null]);
      expect(select({ ...observed, variants: [] })).toEqual(
        hasVariants ? [] : [null],
      );
      expect(
        select({
          ...observed,
          variants: input.variants.filter(
            (variant) => variant.catalogPublishMode === 'OFF',
          ),
        }),
      ).toEqual(hasVariants ? [] : [null]);
    }
  },
);

it('does not fabricate a base subject for a variant product with no offered variants', () => {
  const input = shape(true);
  expect(select({ ...input, variants: [] })).toEqual([]);
  expect(
    select({
      ...input,
      variants: input.variants.filter(
        (variant) => variant.catalogPublishMode === 'OFF',
      ),
    }),
  ).toEqual([]);
});

it('deduplicates cross-context eligibility and preserves variant order', () => {
  const input = shape(true);
  expect(select({ ...input, availableGlobalPriceListIds: ['b', 'a'] })).toEqual(
    ['v2', 'v1'],
  );
  expect(select({ ...input, variants: [...input.variants].reverse() })).toEqual(
    ['v1', 'v2'],
  );
});

it('does not mutate frozen observations or retain a mutable result alias', () => {
  const input = shape(true);
  const before = JSON.stringify(input);
  for (const variant of input.variants) {
    variant.prices.forEach(Object.freeze);
    Object.freeze(variant.prices);
    Object.freeze(variant);
  }
  input.productPrices.forEach(Object.freeze);
  Object.freeze(input.productPrices);
  Object.freeze(input.variants);
  Object.freeze(input.product);
  Object.freeze(input.availableGlobalPriceListIds);
  Object.freeze(input.supportedCatalogPriceListIds);
  Object.freeze(input);
  const result = select(input);
  expect(result).toEqual(['v2', 'v1']);
  result.reverse();
  expect(select(input)).toEqual(['v2', 'v1']);
  expect(JSON.stringify(input)).toBe(before);
});
