/** pca-2b1 — capacity-aware deterministic fallback over the fixed candidate snapshot. */
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

const orderPromo = (overrides: PromoOverrides = {}): PromoOverrides => ({
  type: 'ORDER_DISCOUNT',
  appliesTo: null,
  targetItems: [],
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

const winnerIds = (result: PosEvalResult): string[] =>
  result.lines.map((l) => l.promotionId);

describe('PosEvaluatePromotionsUseCase — capacity fallback (pca-2b1)', () => {
  it('keeps exact-fit and unlimited winners and reports nothing when nothing wins', async () => {
    const exact = await run(
      [promotion({ id: 'promo-a', discountValue: 20, ...capped(3) })],
      { lines: [line({ quantity: 3 })] },
    );
    expect(winnerIds(exact)).toEqual(['promo-a']);
    expect(exact.capacityExcludedPromotionIds).toEqual([]);

    const unlimited = await run(
      [promotion({ id: 'promo-a', discountValue: 20 })],
      { lines: [line({ quantity: 5 })] },
    );
    expect(winnerIds(unlimited)).toEqual(['promo-a']);
    expect(unlimited.capacityExcludedPromotionIds).toEqual([]);

    const none = await run([promotion({ id: 'promo-a', ...capped(1) })], {
      lines: [line({ productId: 'prod-other' })],
    });
    expect(none.lines).toEqual([]);
    expect(none.capacityExcludedPromotionIds).toEqual([]);
  });

  it('excludes a zero-remaining promotion whose demand is positive', async () => {
    const result = await run(
      [promotion({ id: 'promo-a', discountValue: 20, ...capped(2, 2) })],
      { lines: [line({ quantity: 1 })] },
    );
    expect(result.lines).toEqual([]);
    expect(result.capacityExcludedPromotionIds).toEqual(['promo-a']);
  });

  it('falls back to the next-best winner when the capped winner overruns (product, ORDER)', async () => {
    const product = await run(
      [
        promotion({ id: 'promo-a', discountValue: 20, ...capped(1) }),
        promotion({ id: 'promo-b', discountValue: 10 }),
      ],
      { lines: [line({ quantity: 3 })] },
    );
    expect(winnerIds(product)).toEqual(['promo-b']);
    expect(product.capacityExcludedPromotionIds).toEqual(['promo-a']);

    const order = await run(
      [
        promotion({
          id: 'order-a',
          ...orderPromo({ discountValue: 30, ...capped(1) }),
        }),
        promotion({ id: 'order-b', ...orderPromo({ discountValue: 10 }) }),
      ],
      { lines: [line({ quantity: 3 })] },
    );
    expect(order.order?.promotionId).toBe('order-b');
    expect(order.capacityExcludedPromotionIds).toEqual(['order-a']);
  });

  it('falls back to the line-discount winner when a reward winner overruns (BXGY, ADVANCED)', async () => {
    const bxgy = await run(
      [
        promotion({ id: 'promo-pd', discountValue: 10 }),
        promotion({
          id: 'promo-bxgy',
          type: 'BUY_X_GET_Y',
          discountType: null,
          discountValue: null,
          buyQuantity: 2,
          getQuantity: 1,
          getDiscountPercent: 100,
          ...capped(0),
        }),
      ],
      { lines: [line({ quantity: 3 })] },
    );
    expect(bxgy.lines).toHaveLength(1);
    expect(bxgy.lines[0].kind).toBeUndefined();
    expect(bxgy.lines[0].promotionId).toBe('promo-pd');
    expect(bxgy.capacityExcludedPromotionIds).toEqual(['promo-bxgy']);

    const advanced = await run(
      [
        promotion({
          id: 'promo-adv',
          type: 'ADVANCED',
          discountType: null,
          discountValue: null,
          buyQuantity: 2,
          getQuantity: 1,
          getDiscountPercent: 100,
          buyTargetType: 'PRODUCTS',
          getTargetType: 'PRODUCTS',
          targetItems: [
            {
              id: 't-buy',
              side: 'BUY',
              targetType: 'PRODUCTS',
              targetId: 'prod-1',
            },
            {
              id: 't-get',
              side: 'GET',
              targetType: 'PRODUCTS',
              targetId: 'prod-2',
            },
          ],
          ...capped(0),
        }),
        promotion({
          id: 'promo-pd',
          discountValue: 10,
          targetItems: [
            {
              id: 't-2',
              side: 'DEFAULT',
              targetType: 'PRODUCTS',
              targetId: 'prod-2',
            },
          ],
        }),
      ],
      {
        lines: [
          line({ itemId: 'i1', productId: 'prod-1', quantity: 2 }),
          line({ itemId: 'i2', productId: 'prod-2', quantity: 1 }),
        ],
      },
    );
    expect(advanced.lines.map((l) => [l.itemId, l.promotionId])).toEqual([
      ['i2', 'promo-pd'],
    ]);
    expect(advanced.capacityExcludedPromotionIds).toEqual(['promo-adv']);
  });

  it('chains exclusions until a fitting candidate wins and sorts ids ascending', async () => {
    const result = await run(
      [
        promotion({ id: 'promo-z', discountValue: 50, ...capped(1) }),
        promotion({ id: 'promo-a', discountValue: 30, ...capped(1) }),
        promotion({ id: 'promo-m', discountValue: 10 }),
      ],
      { lines: [line({ quantity: 3 })] },
    );
    expect(winnerIds(result)).toEqual(['promo-m']);
    // Discovery order is promo-z then promo-a; the emitted list is sorted.
    expect(result.capacityExcludedPromotionIds).toEqual(['promo-a', 'promo-z']);
  });

  it('keeps fitting MANUAL opt-in/veto semantics and excludes an insufficient MANUAL winner', async () => {
    const fitting = await run(
      [
        promotion({ id: 'promo-vetoed', discountValue: 40 }),
        promotion({ id: 'promo-manual', method: 'MANUAL', discountValue: 10 }),
      ],
      {
        lines: [line({ quantity: 2 })],
        vetoedPromotionIds: ['promo-vetoed'],
        optedInManualPromotionIds: ['promo-manual'],
      },
    );
    expect(winnerIds(fitting)).toEqual(['promo-manual']);
    expect(fitting.capacityExcludedPromotionIds).toEqual([]);

    const overrun = await run(
      [
        promotion({
          id: 'promo-manual',
          method: 'MANUAL',
          discountValue: 20,
          ...capped(1),
        }),
        promotion({ id: 'promo-auto', discountValue: 10 }),
      ],
      {
        lines: [line({ quantity: 2 })],
        optedInManualPromotionIds: ['promo-manual'],
      },
    );
    expect(winnerIds(overrun)).toEqual(['promo-auto']);
    expect(overrun.capacityExcludedPromotionIds).toEqual(['promo-manual']);
  });
});
