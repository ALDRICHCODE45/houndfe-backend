import { BackorderError } from './backorder-error';
import {
  assertExpectedReferencePrice,
  assertStockShortfall,
  assertVariantSelection,
  compareQueueOrder,
  computeBackorderRequestHash,
  queuePositions,
  resolveRestockEstimate,
  type BackorderIntent,
  type RestockDecisionView,
} from './backorder-rules';

const PRODUCT = '40000000-0000-4000-8000-000000000001';
const VARIANT = '50000000-0000-4000-8000-000000000001';
const DAY = 86_400_000;

function codeOf(run: () => void): { code: string; details: unknown } {
  try {
    run();
  } catch (error) {
    if (error instanceof BackorderError) {
      return { code: error.code, details: error.details };
    }
    throw error;
  }
  throw new Error('expected a BackorderError');
}

const decision = (
  over: Partial<RestockDecisionView> = {},
): RestockDecisionView => ({
  type: 'RESTOCK',
  status: 'RESOLVED',
  resolutionAction: 'PROVIDE_RESTOCK_ESTIMATE',
  restockDays: 7,
  resolvedAt: new Date('2026-11-20T15:00:00.000Z'),
  productId: PRODUCT,
  variantId: null,
  ...over,
});

describe('resolveRestockEstimate (source decision validation)', () => {
  it('estimatedAt = resolvedAt + restockDays', () => {
    expect(
      resolveRestockEstimate(decision(), {
        productId: PRODUCT,
        variantId: null,
      }),
    ).toEqual({
      estimatedArrivalDays: 7,
      estimatedAt: new Date('2026-11-27T15:00:00.000Z'),
    });
  });

  it('matches a variant decision only for the same variant', () => {
    const target = { productId: PRODUCT, variantId: VARIANT };
    expect(
      resolveRestockEstimate(
        decision({ variantId: VARIANT, restockDays: 1 }),
        target,
      ).estimatedAt.getTime(),
    ).toBe(new Date('2026-11-20T15:00:00.000Z').getTime() + DAY);
    expect(
      codeOf(() =>
        resolveRestockEstimate(decision({ variantId: null }), target),
      ).code,
    ).toBe('SOURCE_DECISION_NOT_FOUND');
  });

  it.each([
    ["is missing (or another tenant's)", null],
    ['is an EXPIRATION decision', decision({ type: 'EXPIRATION' })],
    [
      'is for another product',
      decision({ productId: '40000000-0000-4000-8000-0000000000ff' }),
    ],
    ['is for another variant', decision({ variantId: VARIANT })],
  ])('SOURCE_DECISION_NOT_FOUND when the decision %s', (_label, row) => {
    expect(
      codeOf(() =>
        resolveRestockEstimate(row, { productId: PRODUCT, variantId: null }),
      ),
    ).toEqual({ code: 'SOURCE_DECISION_NOT_FOUND', details: {} });
  });

  it.each([
    [
      'still pending',
      {
        status: 'PENDING',
        resolutionAction: null,
        restockDays: null,
        resolvedAt: null,
      },
    ],
    [
      'answered "estimate unavailable"',
      {
        resolutionAction: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
        restockDays: null,
      },
    ],
    ['resolved without days', { restockDays: null }],
    ['resolved without a resolution time', { resolvedAt: null }],
  ] as Array<[string, Partial<RestockDecisionView>]>)(
    'SOURCE_DECISION_NOT_ESTIMATED when the decision is %s',
    (_label, over) => {
      expect(
        codeOf(() =>
          resolveRestockEstimate(decision(over), {
            productId: PRODUCT,
            variantId: null,
          }),
        ).code,
      ).toBe('SOURCE_DECISION_NOT_ESTIMATED');
    },
  );

  it('keeps a past estimatedAt as is (T4 re-estimates it, etaStage stays 0)', () => {
    const past = resolveRestockEstimate(
      decision({
        resolvedAt: new Date('2020-01-01T00:00:00.000Z'),
        restockDays: 3,
      }),
      { productId: PRODUCT, variantId: null },
    );
    expect(past.estimatedAt.getTime()).toBeLessThan(Date.now());
  });
});

describe('assertVariantSelection', () => {
  const base = { productId: PRODUCT };

  it('requires a variant when the product has variants (422 VARIANT_REQUIRED)', () => {
    expect(
      codeOf(() =>
        assertVariantSelection({
          ...base,
          productHasVariants: true,
          variantId: null,
          variant: null,
        }),
      ).code,
    ).toBe('VARIANT_REQUIRED');
  });

  it('accepts a product without variants and no variant', () => {
    expect(() =>
      assertVariantSelection({
        ...base,
        productHasVariants: false,
        variantId: null,
        variant: null,
      }),
    ).not.toThrow();
  });

  it('VARIANT_NOT_FOUND when the variant id matches no row', () => {
    expect(
      codeOf(() =>
        assertVariantSelection({
          ...base,
          productHasVariants: true,
          variantId: VARIANT,
          variant: null,
        }),
      ).code,
    ).toBe('VARIANT_NOT_FOUND');
  });

  it('VARIANT_NOT_OF_PRODUCT when the variant belongs to another product', () => {
    expect(
      codeOf(() =>
        assertVariantSelection({
          ...base,
          productHasVariants: true,
          variantId: VARIANT,
          variant: { id: VARIANT, productId: 'other-product' },
        }),
      ).code,
    ).toBe('VARIANT_NOT_OF_PRODUCT');
  });

  it('VARIANT_NOT_OF_PRODUCT when a product without variants is given one', () => {
    expect(
      codeOf(() =>
        assertVariantSelection({
          ...base,
          productHasVariants: false,
          variantId: VARIANT,
          variant: { id: VARIANT, productId: PRODUCT },
        }),
      ).code,
    ).toBe('VARIANT_NOT_OF_PRODUCT');
  });

  it('accepts a variant of the product', () => {
    expect(() =>
      assertVariantSelection({
        ...base,
        productHasVariants: true,
        variantId: VARIANT,
        variant: { id: VARIANT, productId: PRODUCT },
      }),
    ).not.toThrow();
  });
});

describe('assertStockShortfall (STOCK_AVAILABLE_NOW)', () => {
  it('rejects when sellable stock already covers the quantity', () => {
    expect(
      codeOf(() => assertStockShortfall({ sellable: 5, quantity: 5 })),
    ).toEqual({
      code: 'STOCK_AVAILABLE_NOW',
      details: { availableToSell: 5 },
    });
    expect(
      codeOf(() => assertStockShortfall({ sellable: 9, quantity: 2 })).details,
    ).toEqual({ availableToSell: 9 });
  });

  it('accepts when stock is short, including zero stock', () => {
    expect(() =>
      assertStockShortfall({ sellable: 1, quantity: 2 }),
    ).not.toThrow();
    expect(() =>
      assertStockShortfall({ sellable: 0, quantity: 1 }),
    ).not.toThrow();
  });

  it('treats a product that does not track stock as always available', () => {
    expect(
      codeOf(() => assertStockShortfall({ sellable: null, quantity: 1 })),
    ).toEqual({
      code: 'STOCK_AVAILABLE_NOW',
      details: { availableToSell: null },
    });
  });
});

describe('assertExpectedReferencePrice (PRICE_OUT_OF_DATE)', () => {
  it('is optional: undefined and null accept any server price', () => {
    expect(() => assertExpectedReferencePrice(undefined, 114900)).not.toThrow();
    expect(() => assertExpectedReferencePrice(null, 114900)).not.toThrow();
  });

  it('accepts an equal price, including zero', () => {
    expect(() => assertExpectedReferencePrice(114900, 114900)).not.toThrow();
    expect(() => assertExpectedReferencePrice(0, 0)).not.toThrow();
  });

  it('rejects a different price and reports the current one', () => {
    expect(codeOf(() => assertExpectedReferencePrice(114900, 109900))).toEqual({
      code: 'PRICE_OUT_OF_DATE',
      details: { currentPriceCents: 109900 },
    });
    expect(codeOf(() => assertExpectedReferencePrice(0, 100)).code).toBe(
      'PRICE_OUT_OF_DATE',
    );
  });
});

describe('queue order and queuePosition', () => {
  const at = (iso: string) => new Date(iso);
  const entry = (
    id: string,
    iso: string,
    productId = PRODUCT,
    variantId: string | null = null,
  ) => ({ id, productId, variantId, scheduledAt: at(iso) });

  it('orders by scheduledAt, ties by id', () => {
    const a = { id: 'a', scheduledAt: at('2026-11-20T10:00:00.000Z') };
    const b = { id: 'b', scheduledAt: at('2026-11-20T10:00:00.000Z') };
    const c = { id: 'c', scheduledAt: at('2026-11-20T09:00:00.000Z') };
    expect([a, b, c].sort(compareQueueOrder).map((row) => row.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
    expect(compareQueueOrder(a, a)).toBe(0);
  });

  it('numbers positions 1-based in FIFO order, whatever the input order', () => {
    const positions = queuePositions([
      entry('c', '2026-11-20T12:00:00.000Z'),
      entry('a', '2026-11-20T10:00:00.000Z'),
      entry('b', '2026-11-20T11:00:00.000Z'),
    ]);
    expect(positions.get('a')).toBe(1);
    expect(positions.get('b')).toBe(2);
    expect(positions.get('c')).toBe(3);
  });

  it('breaks a scheduledAt tie by id', () => {
    const positions = queuePositions([
      entry('b', '2026-11-20T10:00:00.000Z'),
      entry('a', '2026-11-20T10:00:00.000Z'),
    ]);
    expect(positions.get('a')).toBe(1);
    expect(positions.get('b')).toBe(2);
  });

  it('counts each (product, variant) queue on its own, NULL variant included', () => {
    const positions = queuePositions([
      entry('p1', '2026-11-20T10:00:00.000Z', PRODUCT, null),
      entry('v1', '2026-11-20T10:01:00.000Z', PRODUCT, VARIANT),
      entry('p2', '2026-11-20T10:02:00.000Z', PRODUCT, null),
      entry('x1', '2026-11-20T10:03:00.000Z', 'other-product', null),
    ]);
    expect(positions.get('p1')).toBe(1);
    expect(positions.get('p2')).toBe(2);
    expect(positions.get('v1')).toBe(1);
    expect(positions.get('x1')).toBe(1);
  });

  it('is empty for an empty queue', () => {
    expect(queuePositions([]).size).toBe(0);
  });
});

describe('computeBackorderRequestHash', () => {
  const intent: BackorderIntent = {
    phoneCountryCode: '52',
    phone: '5512349901',
    customer: {
      mode: 'existing',
      customerId: '10000000-0000-4000-8000-000000000001',
    },
    productId: PRODUCT,
    variantId: null,
    quantity: 2,
    expectedReferencePriceCents: 114900,
    sourceDecisionId: '60000000-0000-4000-8000-000000000001',
    chatbotRequestId: null,
  };

  it('is a stable sha256 of the whole intent', () => {
    expect(computeBackorderRequestHash(intent)).toMatch(/^[0-9a-f]{64}$/);
    expect(computeBackorderRequestHash({ ...intent })).toBe(
      computeBackorderRequestHash(intent),
    );
  });

  it('hashes omitted and null optional members the same', () => {
    const {
      expectedReferencePriceCents,
      chatbotRequestId,
      variantId,
      ...rest
    } = intent;
    void expectedReferencePriceCents;
    void chatbotRequestId;
    void variantId;
    expect(computeBackorderRequestHash(rest)).toBe(
      computeBackorderRequestHash({
        ...rest,
        variantId: null,
        expectedReferencePriceCents: null,
        chatbotRequestId: null,
      }),
    );
  });

  it.each([
    ['phone', { phone: '5512340000' }],
    ['quantity', { quantity: 3 }],
    ['product', { productId: 'other' }],
    ['variant', { variantId: VARIANT }],
    ['expected price', { expectedReferencePriceCents: 1 }],
    ['source decision', { sourceDecisionId: 'other' }],
    [
      'wrapper request',
      { chatbotRequestId: '70000000-0000-4000-8000-000000000001' },
    ],
    [
      'customer intent',
      { customer: { mode: 'createIfAbsent' as const, firstName: 'Rosa' } },
    ],
  ] as Array<[string, Partial<BackorderIntent>]>)(
    'changes when the %s changes',
    (_label, over) => {
      expect(computeBackorderRequestHash({ ...intent, ...over })).not.toBe(
        computeBackorderRequestHash(intent),
      );
    },
  );

  it('distinguishes the createIfAbsent names', () => {
    const base = {
      ...intent,
      customer: { mode: 'createIfAbsent' as const, firstName: 'Rosa' },
    };
    expect(computeBackorderRequestHash(base)).toBe(
      computeBackorderRequestHash({
        ...base,
        customer: { mode: 'createIfAbsent', firstName: 'Rosa', lastName: null },
      }),
    );
    expect(computeBackorderRequestHash(base)).not.toBe(
      computeBackorderRequestHash({
        ...base,
        customer: {
          mode: 'createIfAbsent',
          firstName: 'Rosa',
          lastName: 'Díaz',
        },
      }),
    );
  });
});
