/**
 * pca-2b2a — capacity-correct POS MANUAL candidate presentation.
 *
 * A capped, not-yet-opted MANUAL PRODUCT_DISCOUNT / ORDER_DISCOUNT /
 * BUY_X_GET_Y candidate is hidden from `availableManualPromotions` ONLY when
 * its EXACT selected-winner demand — simulated opted-in on the same fixed
 * snapshot / exclusion set — exceeds `remainingProductUnits`. The full
 * matching footprint is NOT the demand: it over-counts lines a stronger auto
 * promo wins, so the "loses matching lines" case fails under a footprint bound.
 */
import { PosEvaluatePromotionsUseCase } from './pos-evaluate-promotions.use-case';
import type { IPromotionRepository } from '../domain/promotion.repository';
import { Promotion } from '../domain/promotion.entity';
import type {
  PosEvalInput,
  PosEvalLine,
  PosEvalResult,
} from './ports/pos-evaluate-promotions.port';

const NOW = new Date('2026-06-10T15:00:00.000Z');
type PromoOverrides = Partial<Parameters<typeof Promotion.fromPersistence>[0]>;

const productTargets = (
  ...productIds: string[]
): NonNullable<PromoOverrides['targetItems']> =>
  productIds.map((productId, index) => ({
    id: `t-${index + 1}`,
    side: 'DEFAULT',
    targetType: 'PRODUCTS',
    targetId: productId,
  }));

const promotion = (overrides: PromoOverrides = {}): Promotion =>
  Promotion.fromPersistence({
    id: 'promo-x',
    title: 'X',
    type: 'PRODUCT_DISCOUNT',
    method: 'AUTOMATIC',
    status: 'ACTIVE',
    startDate: null,
    endDate: null,
    customerScope: 'ALL',
    discountType: 'PERCENTAGE',
    discountValue: 10,
    minPurchaseAmountCents: null,
    appliesTo: 'PRODUCTS',
    buyQuantity: null,
    getQuantity: null,
    getDiscountPercent: null,
    buyTargetType: null,
    getTargetType: null,
    createdAt: NOW,
    updatedAt: NOW,
    targetItems: productTargets('prod-1'),
    customers: [],
    priceLists: [],
    daysOfWeek: [],
    ...overrides,
  });

const line = (overrides: Partial<PosEvalLine> = {}): PosEvalLine => ({
  itemId: 'item-1',
  productId: 'prod-1',
  variantId: null,
  quantity: 1,
  effectiveUnitPriceCents: 1000,
  appliedPriceListId: null,
  appliedGlobalPriceListId: null,
  categoryId: null,
  brandId: null,
  hasManualDiscount: false,
  ...overrides,
});

/** Capped capacity overrides: `maxProductUnits` with an optional counter. */
const capped = (
  maxProductUnits: number,
  consumedProductUnits = 0,
): PromoOverrides => ({ maxProductUnits, consumedProductUnits });

const manualProduct = (overrides: PromoOverrides = {}): PromoOverrides => ({
  id: 'promo-manual',
  method: 'MANUAL',
  ...overrides,
});

const manualOrder = (overrides: PromoOverrides = {}): PromoOverrides => ({
  id: 'promo-order',
  type: 'ORDER_DISCOUNT',
  method: 'MANUAL',
  appliesTo: null,
  targetItems: [],
  ...overrides,
});

const manualBxgy = (overrides: PromoOverrides = {}): PromoOverrides => ({
  id: 'promo-bxgy',
  type: 'BUY_X_GET_Y',
  method: 'MANUAL',
  discountType: null,
  discountValue: null,
  buyQuantity: 2,
  getQuantity: 1,
  getDiscountPercent: 100,
  ...overrides,
});

function run(
  promotions: Promotion[],
  input: Partial<PosEvalInput> = {},
): Promise<PosEvalResult> {
  const repository = {
    save: jest.fn(),
    findById: jest.fn(),
    findAll: jest
      .fn()
      .mockResolvedValue({ data: promotions, total: promotions.length }),
    delete: jest.fn(),
    updateStatus: jest.fn(),
  } as unknown as jest.Mocked<IPromotionRepository>;
  return new PosEvaluatePromotionsUseCase(repository).evaluate({
    now: NOW,
    customerId: null,
    lines: [line()],
    vetoedPromotionIds: [],
    optedInManualPromotionIds: [],
    ...input,
  });
}

const ids = (result: PosEvalResult): string[] =>
  result.availableManualPromotions.map((candidate) => candidate.id);

describe('PosEvaluatePromotionsUseCase — manual capacity (pca-2b2a)', () => {
  it('hides an insufficient capped ORDER candidate and keeps an exact fit', async () => {
    const insufficient = await run([promotion(manualOrder(capped(1)))], {
      lines: [line({ quantity: 2 })],
    });
    expect(insufficient.availableManualPromotions).toEqual([]);

    const exactFit = await run([promotion(manualOrder(capped(2)))], {
      lines: [line({ quantity: 2 })],
    });
    // Order demand (2) === remaining (2) — exact fit stays visible.
    expect(ids(exactFit)).toEqual(['promo-order']);
  });

  it('hides an insufficient capped PRODUCT candidate but keeps unlimited ones', async () => {
    const insufficient = await run(
      [promotion(manualProduct({ discountValue: 10, ...capped(1) }))],
      { lines: [line({ quantity: 3 })] },
    );
    expect(insufficient.availableManualPromotions).toEqual([]);

    const unlimited = await run(
      [promotion(manualProduct({ discountValue: 10 }))],
      { lines: [line({ quantity: 10 })] },
    );
    expect(ids(unlimited)).toEqual(['promo-manual']);
  });

  it('does NOT falsely hide a capped PRODUCT candidate that loses matching lines to a stronger auto promo', async () => {
    const result = await run(
      [
        promotion({ id: 'promo-auto', discountValue: 50 }),
        promotion(
          manualProduct({
            discountValue: 10,
            // Matches BOTH lines (footprint 5) but only wins i2.
            targetItems: productTargets('prod-1', 'prod-2'),
            ...capped(2),
          }),
        ),
      ],
      {
        lines: [
          line({ itemId: 'i1', productId: 'prod-1', quantity: 3 }),
          line({ itemId: 'i2', productId: 'prod-2', quantity: 2 }),
        ],
      },
    );

    // Selected demand is i2 only (2) — exact fit; footprint 5 would hide it.
    expect(ids(result)).toEqual(['promo-manual']);
    expect(result.availableManualPromotions[0]).toMatchObject({
      type: 'PRODUCT_DISCOUNT',
      eligible: true,
      buyQuantity: null,
      getQuantity: null,
      unitsNeeded: 0,
    });
    expect(result.lines.map((l) => [l.itemId, l.promotionId])).toEqual([
      ['i1', 'promo-auto'],
    ]);
  });

  it('keeps a capped PRODUCT candidate that loses every matching line (zero demand)', async () => {
    const result = await run(
      [
        promotion({ id: 'promo-auto', discountValue: 50 }),
        promotion(manualProduct({ discountValue: 10, ...capped(1) })),
      ],
      { lines: [line({ quantity: 5 })] },
    );
    // Zero selected demand → prior availability preserved.
    expect(ids(result)).toEqual(['promo-manual']);
  });

  it('hides an insufficient capped BXGY candidate and keeps an exact fit with its hints', async () => {
    const insufficient = await run([promotion(manualBxgy(capped(0)))], {
      lines: [line({ quantity: 3 })],
    });
    // qty 3 → one reward group → 1 rewarded unit > remaining 0.
    expect(insufficient.availableManualPromotions).toEqual([]);

    const exactFit = await run([promotion(manualBxgy(capped(1)))], {
      lines: [line({ quantity: 3 })],
    });
    // Rewarded demand (1) === remaining (1); eligibility hint untouched.
    expect(exactFit.availableManualPromotions).toHaveLength(1);
    expect(exactFit.availableManualPromotions[0]).toMatchObject({
      type: 'BUY_X_GET_Y',
      eligible: true,
      buyQuantity: 2,
      getQuantity: 1,
      unitsNeeded: 0,
    });
  });

  it('keeps an opted-in capacity-excluded manual id targetable while the fallback wins', async () => {
    const result = await run(
      [
        promotion(manualProduct({ discountValue: 20, ...capped(1) })),
        promotion({ id: 'promo-auto', discountValue: 10 }),
      ],
      {
        lines: [line({ quantity: 3 })],
        optedInManualPromotionIds: ['promo-manual'],
      },
    );

    // Manual wins pass 1 (20% > 10%) but demands 3 > remaining 1, so it is
    // capacity-excluded and the auto fallback takes the line. Target presence
    // — not capacity — decides opt-in retention.
    expect(result.lines.map((l) => l.promotionId)).toEqual(['promo-auto']);
    expect(result.capacityExcludedPromotionIds).toEqual(['promo-manual']);
    expect(result.targetableManualPromotionIds).toEqual(['promo-manual']);
  });
});
