/**
 * quotation-sale-conversion / T2 (S8) — which promotions must be vetoed so
 * a sale opened from a quotation keeps the exact quoted total.
 */
import {
  keptQuotedPromotionMismatches,
  promotionsToVetoForExactOpening,
  withoutQuotedDiscount,
} from './quotation-opening-promotions';

const perUnit = (itemId: string, promotionId: string) => ({
  kind: 'per-unit' as const,
  itemId,
  promotionId,
});

describe('promotionsToVetoForExactOpening (S8)', () => {
  it('returns every line and order promotion the engine would apply, once each, in first-seen order', () => {
    expect(
      promotionsToVetoForExactOpening(
        {
          lines: [
            perUnit('i-1', 'promo-line'),
            perUnit('i-2', 'promo-line'),
            {
              kind: 'buy-x-get-y' as const,
              itemId: 'i-3',
              promotionId: 'bxgy',
            },
          ],
          order: { promotionId: 'promo-order' },
        },
        [],
      ),
    ).toEqual(['promo-line', 'bxgy', 'promo-order']);
  });

  it('skips promotions already vetoed (e.g. copied from the quotation)', () => {
    expect(
      promotionsToVetoForExactOpening(
        {
          lines: [perUnit('i-1', 'promo-a'), perUnit('i-2', 'promo-b')],
          order: { promotionId: 'promo-a' },
        },
        ['promo-a'],
      ),
    ).toEqual(['promo-b']);
  });

  it('T3: never vetoes a kept quoted promotion', () => {
    expect(
      promotionsToVetoForExactOpening(
        {
          lines: [perUnit('i-1', 'kept'), perUnit('i-2', 'other')],
          order: { promotionId: 'order' },
        },
        [],
        new Set(['kept']),
      ),
    ).toEqual(['other', 'order']);
  });

  it('returns [] when nothing would change the total', () => {
    expect(
      promotionsToVetoForExactOpening({ lines: [], order: null }, ['x']),
    ).toEqual([]);
  });
});

describe('T3 (D2) — quoted promotion kept as its line application', () => {
  const expected = [
    {
      itemId: 'i-1',
      promotionId: 'p',
      unitPriceCents: 62_010,
      discountAmountCents: 6_890,
    },
  ];
  const line = (overrides: Record<string, unknown> = {}) => ({
    id: 'i-1',
    promotionId: 'p' as string | null,
    unitPriceCents: 62_010,
    discountAmountCents: 6_890 as number | null,
    isReward: false,
    ...overrides,
  });
  const kept = new Set(['p']);

  it('reports no mismatch when the engine reproduced the quoted line exactly', () => {
    expect(
      keptQuotedPromotionMismatches(
        [
          line(),
          line({ id: 'i-2', promotionId: null, discountAmountCents: null }),
        ],
        expected,
        kept,
      ),
    ).toEqual([]);
  });

  it.each([
    ['another amount', { unitPriceCents: 62_000, discountAmountCents: 6_900 }],
    ['not applied', { promotionId: null, discountAmountCents: null }],
    ['another promotion won', { promotionId: 'q' }],
    ['applied as a whole-line reward', { isReward: true }],
  ])('flags the kept promotion when the quoted line got %s', (_l, o) => {
    expect(keptQuotedPromotionMismatches([line(o)], expected, kept)).toEqual([
      'p',
    ]);
  });

  it('flags the kept promotion when it lands on a line that did not quote it', () => {
    expect(
      keptQuotedPromotionMismatches(
        [line(), line({ id: 'i-2' })],
        expected,
        kept,
      ),
    ).toEqual(['p']);
  });

  it('ignores expectations for promotions no longer kept', () => {
    expect(
      keptQuotedPromotionMismatches(
        [line({ promotionId: null })],
        expected,
        new Set(),
      ),
    ).toEqual([]);
  });

  it('withoutQuotedDiscount restores the gross sticky price and clears every discount field', () => {
    const now = new Date();
    expect(
      withoutQuotedDiscount({
        productId: 'prod',
        variantId: null,
        productName: 'Croqueta',
        variantName: null,
        imageUrl: null,
        quantity: 1,
        unitPriceCents: 62_010,
        unitPriceCurrency: 'MXN',
        priceSource: 'custom',
        customPriceCents: 68_900,
        appliedPriceListId: null,
        originalPriceCents: null,
        discountType: 'percentage',
        discountValue: 10,
        discountAmountCents: 6_890,
        prePriceCentsBeforeDiscount: 68_900,
        discountTitle: 'Promo',
        discountedAt: now,
        promotionId: null,
      }),
    ).toMatchObject({
      unitPriceCents: 68_900,
      priceSource: 'custom',
      customPriceCents: 68_900,
      discountType: null,
      discountValue: null,
      discountAmountCents: null,
      prePriceCentsBeforeDiscount: null,
      discountTitle: null,
      discountedAt: null,
      promotionId: null,
    });
  });
});
