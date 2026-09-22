/**
 * pca-2a — deterministic benefited-product-unit demand preview.
 * per-unit → discounted line qty; BXGY/ADVANCED → rewarded GET units; ORDER →
 * every item unit; ids summed, zero units omitted, sorted ascending. Pure
 * preview metadata (no counter writes); the evaluator test pins the wiring.
 */
import {
  PosEvaluatePromotionsUseCase,
  computePromotionCapacityDemands,
} from './pos-evaluate-promotions.use-case';
import type { IPromotionRepository } from '../domain/promotion.repository';
import { Promotion } from '../domain/promotion.entity';
import type {
  PosEvalLine,
  PosEvalLineResult,
  PosEvalOrderResult,
} from './ports/pos-evaluate-promotions.port';

const NOW = new Date('2026-06-10T15:00:00.000Z');

const promotion = (
  o: Partial<Parameters<typeof Promotion.fromPersistence>[0]> = {},
): Promotion =>
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
    targetItems: [
      {
        id: 't-1',
        side: 'DEFAULT',
        targetType: 'PRODUCTS',
        targetId: 'prod-1',
      },
    ],
    customers: [],
    priceLists: [],
    daysOfWeek: [],
    ...o,
  });

const line = (itemId: string, quantity: number): PosEvalLine => ({
  itemId,
  productId: 'prod-1',
  variantId: null,
  quantity,
  effectiveUnitPriceCents: 1000,
  appliedPriceListId: null,
  appliedGlobalPriceListId: null,
  categoryId: null,
  brandId: null,
  hasManualDiscount: false,
});

const perUnit = (itemId: string, promotionId: string): PosEvalLineResult => ({
  itemId,
  promotionId,
  discountType: 'amount',
  discountValue: 100,
  discountTitle: 'x',
});
const reward = (
  kind: 'buy-x-get-y' | 'advanced',
  itemId: string,
  promotionId: string,
  discountedUnitCount: number,
): PosEvalLineResult => ({
  kind,
  itemId,
  promotionId,
  discountTitle: 'x',
  lineDiscountCents: discountedUnitCount * 50,
  perUnitRewardCents: 50,
  discountedUnitCount,
  getDiscountPercent: 50,
});
const order = (promotionId: string): PosEvalOrderResult => ({
  promotionId,
  discountType: 'amount',
  discountValue: 100,
  discountTitle: 'x',
  discountAmountCents: 100,
});

describe('computePromotionCapacityDemands (pca-2a)', () => {
  it('aggregates per-unit lines per promotion, includes the order promo, and sorts ids ascending', () => {
    // promo-c = 2+1, promo-B = 4, promo-a = order total 7; 'promo-B' < 'promo-a'.
    expect(
      computePromotionCapacityDemands(
        [line('i1', 2), line('i2', 1), line('i3', 4)],
        [
          perUnit('i1', 'promo-c'),
          perUnit('i2', 'promo-c'),
          perUnit('i3', 'promo-B'),
        ],
        order('promo-a'),
      ),
    ).toEqual([
      { promotionId: 'promo-B', units: 4 },
      { promotionId: 'promo-a', units: 7 },
      { promotionId: 'promo-c', units: 3 },
    ]);
  });

  it('counts rewarded GET units for BXGY/ADVANCED, never the BUY units', () => {
    // BXGY rewards 2 of 6 units; multi-GET-line ADVANCED rewards 1 + 2.
    expect(
      computePromotionCapacityDemands(
        [line('i1', 6), line('i2', 3), line('i3', 3)],
        [
          reward('buy-x-get-y', 'i1', 'promo-a', 2),
          reward('advanced', 'i2', 'promo-a', 1),
          reward('advanced', 'i3', 'promo-a', 2),
        ],
        null,
      ),
    ).toEqual([{ promotionId: 'promo-a', units: 5 }]);
  });

  it('omits zero-unit entries and unknown lines', () => {
    expect(computePromotionCapacityDemands([], [], null)).toEqual([]);
    expect(
      computePromotionCapacityDemands(
        [line('i1', 0)],
        [
          perUnit('ghost', 'promo-x'),
          reward('buy-x-get-y', 'i1', 'promo-y', 0),
        ],
        order('promo-o'),
      ),
    ).toEqual([]);
  });
});

describe('PosEvaluatePromotionsUseCase — demand wiring (pca-2a)', () => {
  it('reports final winners and drops a zero-saving reward candidate', async () => {
    const repository = {
      findAll: jest.fn().mockResolvedValue({
        data: [
          // Unlimited promotion (no capacity config): still reports demand.
          promotion({ id: 'promo-pd' }),
          // qty 1 < buyQuantity 2 → zero saving → no result → no demand.
          promotion({
            id: 'promo-zero',
            type: 'BUY_X_GET_Y',
            discountType: null,
            discountValue: null,
            buyQuantity: 2,
            getQuantity: 1,
            getDiscountPercent: 50,
          }),
        ],
        total: 2,
      }),
    } as unknown as IPromotionRepository;
    const result = await new PosEvaluatePromotionsUseCase(repository).evaluate({
      now: NOW,
      customerId: null,
      lines: [line('i1', 1)],
      vetoedPromotionIds: [],
      optedInManualPromotionIds: [],
    });
    expect(result.lines.map((l) => l.promotionId)).toEqual(['promo-pd']);
    expect(result.promotionCapacityDemands).toEqual([
      { promotionId: 'promo-pd', units: 1 },
    ]);
  });
});
