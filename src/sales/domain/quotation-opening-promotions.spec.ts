/**
 * quotation-sale-conversion / T2 (S8) — which promotions must be vetoed so
 * a sale opened from a quotation keeps the exact quoted total.
 */
import { promotionsToVetoForExactOpening } from './quotation-opening-promotions';

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

  it('returns [] when nothing would change the total', () => {
    expect(
      promotionsToVetoForExactOpening({ lines: [], order: null }, ['x']),
    ).toEqual([]);
  });
});
