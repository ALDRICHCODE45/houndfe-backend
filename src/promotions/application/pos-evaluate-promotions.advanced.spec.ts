/**
 * WU4 — ADVANCED engine pass (RED-first).
 *
 * Contract (design.md Decisions 1, 4, 5; spec.md:41-47,72-100,137-149,
 * 152-163, 206-214):
 *   - Gate: `isSupportedEngineType(promo)` admits ADVANCED with
 *     `buyTargetType` and `getTargetType` each ∈ {PRODUCTS, VARIANTS,
 *     CATEGORIES, BRANDS}. null or unsupported values → silent skip.
 *   - AUTOMATIC-only: MANUAL ADVANCED is silently skipped at the gate
 *     (D6) — manual surface / `availableManualPromotions` is not
 *     extended for ADVANCED in this slice.
 *   - Counting (D1, D2): BUY-side aggregated across the whole draft
 *     via `matchTargetTier(items, line, 'BUY')`. Reward groups =
 *     `floor(totalBuyMatchedQty / buyQuantity)`.
 *   - Pass order: AFTER the BXGY pass and BEFORE ORDER_DISCOUNT.
 *   - Discriminated `kind:'advanced'` line result; replaces any
 *     pre-existing per-line PRODUCT_DISCOUNT result when it wins
 *     (D5 — cross-type 3-way max on `lineTotalSavingCents`).
 *   - Degenerate cart (S4): BUY met, no GET → no result emitted.
 *   - 100% (D3): produces a true free GET unit at 0c.
 *
 * Engine is pure (no I/O). All tests use a mocked IPromotionRepository.
 */
import { PosEvaluatePromotionsUseCase } from './pos-evaluate-promotions.use-case';
import type { IPromotionRepository } from '../domain/promotion.repository';
import {
  Promotion,
  type PromotionTargetItemData,
  type DayOfWeek,
} from '../domain/promotion.entity';
import type {
  PosEvalInput,
  PosEvalLine,
  PosEvalResult,
} from './ports/pos-evaluate-promotions.port';

// ============================================================
// Fixtures
// ============================================================

const NOW = new Date('2026-06-10T15:00:00.000Z'); // Wed Jun 10 2026
const YESTERDAY = new Date('2026-06-09T15:00:00.000Z');

type PromoOverrides = Partial<Parameters<typeof Promotion.fromPersistence>[0]>;

function makePromotion(overrides: PromoOverrides = {}): Promotion {
  return Promotion.fromPersistence({
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
    createdAt: YESTERDAY,
    updatedAt: YESTERDAY,
    targetItems: [],
    customers: [],
    priceLists: [],
    daysOfWeek: [],
    ...overrides,
  });
}

interface AdvancedTargetSpec {
  buyTargetType: 'PRODUCTS' | 'VARIANTS' | 'CATEGORIES' | 'BRANDS';
  buyTargetIds: string[];
  getTargetType: 'PRODUCTS' | 'VARIANTS' | 'CATEGORIES' | 'BRANDS';
  getTargetIds: string[];
}

/**
 * Build an AUTOMATIC ADVANCED promotion with the buy/get target type
 * and id lists the caller wants. Targets are split into two
 * `PromotionTargetItemData` rows per side (one per id) so the helper
 * resolves them by `side`.
 */
function makeAdvancedPromotion(
  spec: AdvancedTargetSpec,
  overrides: PromoOverrides & {
    buyQuantity?: number;
    getQuantity?: number;
    getDiscountPercent?: number;
  } = {},
): Promotion {
  const {
    buyQuantity = 3,
    getQuantity = 1,
    getDiscountPercent = 50,
    ...rest
  } = overrides;
  const targetItems: PromotionTargetItemData[] = [
    ...spec.buyTargetIds.map((id, idx) => ({
      id: `t-buy-${idx}`,
      side: 'BUY' as const,
      targetType: spec.buyTargetType,
      targetId: id,
    })),
    ...spec.getTargetIds.map((id, idx) => ({
      id: `t-get-${idx}`,
      side: 'GET' as const,
      targetType: spec.getTargetType,
      targetId: id,
    })),
  ];
  return makePromotion({
    type: 'ADVANCED',
    method: 'AUTOMATIC',
    appliesTo: null,
    discountType: null,
    discountValue: null,
    buyQuantity,
    getQuantity,
    getDiscountPercent,
    buyTargetType: spec.buyTargetType,
    getTargetType: spec.getTargetType,
    targetItems,
    ...rest,
  });
}

function makeRepository(
  promotions: Promotion[],
): jest.Mocked<IPromotionRepository> {
  return {
    save: jest.fn(),
    findById: jest.fn(),
    findAll: jest.fn().mockResolvedValue({
      data: promotions,
      total: promotions.length,
    }),
    delete: jest.fn(),
    updateStatus: jest.fn(),
  } as unknown as jest.Mocked<IPromotionRepository>;
}

function makeLine(overrides: Partial<PosEvalLine> = {}): PosEvalLine {
  return {
    itemId: 'item-get',
    productId: 'prod-get',
    variantId: null,
    quantity: 1,
    effectiveUnitPriceCents: 1000,
    appliedPriceListId: null,
    appliedGlobalPriceListId: null,
    categoryId: null,
    brandId: null,
    hasManualDiscount: false,
    ...overrides,
  };
}

function makeInput(overrides: Partial<PosEvalInput> = {}): PosEvalInput {
  return {
    now: NOW,
    customerId: null,
    lines: [],
    vetoedPromotionIds: [],
    optedInManualPromotionIds: [],
    ...overrides,
  };
}

// ============================================================
// WU4 tests
// ============================================================

describe('PosEvaluatePromotionsUseCase — ADVANCED gate (WU4, spec.md:43-55)', () => {
  it.each([
    ['PRODUCTS', 'PRODUCTS'],
    ['PRODUCTS', 'CATEGORIES'],
    ['VARIANTS', 'PRODUCTS'],
    ['VARIANTS', 'BRANDS'],
    ['CATEGORIES', 'PRODUCTS'],
    ['CATEGORIES', 'CATEGORIES'],
    ['BRANDS', 'BRANDS'],
    ['BRANDS', 'VARIANTS'],
  ] as const)(
    'admits ADVANCED with buyTargetType=%s and getTargetType=%s',
    async (buyType, getType) => {
      const advanced = makeAdvancedPromotion(
        {
          buyTargetType: buyType,
          buyTargetIds: ['buy-target-id'],
          getTargetType: getType,
          getTargetIds: ['get-target-id'],
        },
        { buyQuantity: 1, getQuantity: 1 },
      );
      const repo = makeRepository([advanced]);
      const useCase = new PosEvaluatePromotionsUseCase(repo);

      // Build two lines — one that matches BUY, one that matches GET.
      // The matcher's side-aware parameter isolates the per-side
      // target list, so a single line cannot match both sides here.
      const buyLine = makeLine({
        itemId: 'item-buy',
        productId:
          buyType === 'PRODUCTS' ? 'buy-target-id' : 'P-DUMMY',
        variantId: buyType === 'VARIANTS' ? 'buy-target-id' : null,
        categoryId:
          buyType === 'CATEGORIES' ? 'buy-target-id' : null,
        brandId: buyType === 'BRANDS' ? 'buy-target-id' : null,
        quantity: 1,
        effectiveUnitPriceCents: 100,
      });
      const getLine = makeLine({
        itemId: 'item-get',
        productId:
          getType === 'PRODUCTS' ? 'get-target-id' : 'P-GET-DUMMY',
        variantId: getType === 'VARIANTS' ? 'get-target-id' : null,
        categoryId:
          getType === 'CATEGORIES' ? 'get-target-id' : null,
        brandId: getType === 'BRANDS' ? 'get-target-id' : null,
        quantity: 1,
        effectiveUnitPriceCents: 100,
      });

      const result: PosEvalResult = await useCase.evaluate(
        makeInput({ lines: [buyLine, getLine] }),
      );

      // The gate admits; the pass emits the discriminated result on
      // the GET-side line.
      const advancedResult = result.lines.find((l) => l.kind === 'advanced');
      expect(advancedResult).toBeDefined();
      expect(advancedResult!.itemId).toBe('item-get');
    },
  );

  it('silently skips an ADVANCED with null buyTargetType', async () => {
    // spec.md:52-55 — null target types → not in candidate set.
    const advanced = makeAdvancedPromotion(
      {
        buyTargetType: 'PRODUCTS',
        buyTargetIds: ['P1'],
        getTargetType: 'PRODUCTS',
        getTargetIds: ['P2'],
      },
      { buyTargetType: null, buyQuantity: 1, getQuantity: 1 },
    );
    const repo = makeRepository([advanced]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({ itemId: 'item-1', productId: 'P1', quantity: 1 }),
          makeLine({ itemId: 'item-2', productId: 'P2', quantity: 1 }),
        ],
      }),
    );

    expect(result.lines.find((l) => l.kind === 'advanced')).toBeUndefined();
  });

  it('silently skips an ADVANCED with null getTargetType', async () => {
    const advanced = makeAdvancedPromotion(
      {
        buyTargetType: 'PRODUCTS',
        buyTargetIds: ['P1'],
        getTargetType: 'PRODUCTS',
        getTargetIds: ['P2'],
      },
      { getTargetType: null, buyQuantity: 1, getQuantity: 1 },
    );
    const repo = makeRepository([advanced]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({ itemId: 'item-1', productId: 'P1', quantity: 1 }),
          makeLine({ itemId: 'item-2', productId: 'P2', quantity: 1 }),
        ],
      }),
    );

    expect(result.lines.find((l) => l.kind === 'advanced')).toBeUndefined();
  });

  it('silently skips a MANUAL ADVANCED — no manual surface (D6)', async () => {
    // spec.md:152-163 — MANUAL ADVANCED is silently skipped. NOT in
    // availableManualPromotions, NOT in applied results, no error.
    const advanced = makeAdvancedPromotion(
      {
        buyTargetType: 'PRODUCTS',
        buyTargetIds: ['P1'],
        getTargetType: 'PRODUCTS',
        getTargetIds: ['P2'],
      },
      { method: 'MANUAL', buyQuantity: 1, getQuantity: 1 },
    );
    const repo = makeRepository([advanced]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({ itemId: 'item-1', productId: 'P1', quantity: 1 }),
          makeLine({ itemId: 'item-2', productId: 'P2', quantity: 1 }),
        ],
      }),
    );

    expect(result.lines.find((l) => l.kind === 'advanced')).toBeUndefined();
    expect(result.availableManualPromotions).toEqual([]);
  });
});

describe('PosEvaluatePromotionsUseCase — ADVANCED side-aware aggregated BUY counting (D1)', () => {
  it('S1 — multiple small BUY lines summing to N (canonical category→product)', async () => {
    // spec.md:75-79 — ADVANCED buy 3 from CAT1, get 1 of P2 at 50%.
    // Draft: 2 × Vela-A + 1 × Vela-B (all CAT1) + 1 × P2.
    // totalBuyMatchedQty = 2 + 1 = 3; floor(3/3) = 1 reward group.
    // 1 × 1 × Math.round((1000*50)/100) = 500c saving on the P2 line.
    const advanced = makeAdvancedPromotion(
      {
        buyTargetType: 'CATEGORIES',
        buyTargetIds: ['CAT-HOME-DECOR'],
        getTargetType: 'PRODUCTS',
        getTargetIds: ['P-MACETA-LARGE'],
      },
      { buyQuantity: 3, getQuantity: 1, getDiscountPercent: 50 },
    );
    const repo = makeRepository([advanced]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({
            itemId: 'item-vela-a',
            productId: 'P-VELA-A',
            categoryId: 'CAT-HOME-DECOR',
            quantity: 2,
            effectiveUnitPriceCents: 1000,
          }),
          makeLine({
            itemId: 'item-vela-b',
            productId: 'P-VELA-B',
            categoryId: 'CAT-HOME-DECOR',
            quantity: 1,
            effectiveUnitPriceCents: 1000,
          }),
          makeLine({
            itemId: 'item-maceta',
            productId: 'P-MACETA-LARGE',
            quantity: 1,
            effectiveUnitPriceCents: 1000,
          }),
        ],
      }),
    );

    expect(result.lines).toHaveLength(1);
    const line = result.lines[0];
    expect(line.kind).toBe('advanced');
    if (line.kind === 'advanced') {
      expect(line.itemId).toBe('item-maceta');
      expect(line.lineDiscountCents).toBe(500);
      expect(line.perUnitRewardCents).toBe(500);
      expect(line.discountedUnitCount).toBe(1);
      expect(line.getDiscountPercent).toBe(50);
    }
  });

  it('single BUY line at or above buyQuantity: qty 5 → floor(5/3)=1 reward group', async () => {
    const advanced = makeAdvancedPromotion(
      {
        buyTargetType: 'CATEGORIES',
        buyTargetIds: ['CAT1'],
        getTargetType: 'PRODUCTS',
        getTargetIds: ['P1'],
      },
      { buyQuantity: 3, getQuantity: 1, getDiscountPercent: 50 },
    );
    const repo = makeRepository([advanced]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({
            itemId: 'item-buy',
            productId: 'P-CAT1-1',
            categoryId: 'CAT1',
            quantity: 5,
            effectiveUnitPriceCents: 1000,
          }),
          makeLine({
            itemId: 'item-get',
            productId: 'P1',
            quantity: 1,
            effectiveUnitPriceCents: 1000,
          }),
        ],
      }),
    );

    const advancedResult = result.lines.find((l) => l.kind === 'advanced');
    expect(advancedResult).toBeDefined();
    if (advancedResult && advancedResult.kind === 'advanced') {
      expect(advancedResult.lineDiscountCents).toBe(500);
    }
  });

  it('out-of-target BUY lines do NOT contribute (2×CAT1 + 2×CAT2 + 1×P1 → totalBuyMatchedQty=2, no reward)', async () => {
    // spec.md:86-89 — CAT2 lines are not in the BUY target list, so
    // they don't contribute to `totalBuyMatchedQty`. 2 < buyQuantity=3
    // → no reward.
    const advanced = makeAdvancedPromotion(
      {
        buyTargetType: 'CATEGORIES',
        buyTargetIds: ['CAT1'],
        getTargetType: 'PRODUCTS',
        getTargetIds: ['P1'],
      },
      { buyQuantity: 3, getQuantity: 1, getDiscountPercent: 50 },
    );
    const repo = makeRepository([advanced]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({
            itemId: 'item-cat1-a',
            productId: 'P-CAT1-1',
            categoryId: 'CAT1',
            quantity: 2,
            effectiveUnitPriceCents: 1000,
          }),
          makeLine({
            itemId: 'item-cat2-a',
            productId: 'P-CAT2-1',
            categoryId: 'CAT2',
            quantity: 2,
            effectiveUnitPriceCents: 1000,
          }),
          makeLine({
            itemId: 'item-get',
            productId: 'P1',
            quantity: 1,
            effectiveUnitPriceCents: 1000,
          }),
        ],
      }),
    );

    expect(result.lines.find((l) => l.kind === 'advanced')).toBeUndefined();
  });

  it('S2 — six matched BUY units and buyQuantity=3 yield 2 reward applications → 600c saving', async () => {
    // spec.md:96-100 — buy 3 from Candles, get 1 of Holder-X at 30%
    // on 6 × Candle + 3 × Holder-X at 1000c. floor(6/3) = 2 reward
    // applications × 1 unit × 300c = 600c.
    const advanced = makeAdvancedPromotion(
      {
        buyTargetType: 'CATEGORIES',
        buyTargetIds: ['CAT-CANDLES'],
        getTargetType: 'PRODUCTS',
        getTargetIds: ['P-HOLDER-X'],
      },
      { buyQuantity: 3, getQuantity: 1, getDiscountPercent: 30 },
    );
    const repo = makeRepository([advanced]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({
            itemId: 'item-candle',
            productId: 'P-CANDLE-1',
            categoryId: 'CAT-CANDLES',
            quantity: 6,
            effectiveUnitPriceCents: 1000,
          }),
          makeLine({
            itemId: 'item-holder-x',
            productId: 'P-HOLDER-X',
            quantity: 3,
            effectiveUnitPriceCents: 1000,
          }),
        ],
      }),
    );

    const advancedResult = result.lines.find((l) => l.kind === 'advanced');
    expect(advancedResult).toBeDefined();
    if (advancedResult && advancedResult.kind === 'advanced') {
      expect(advancedResult.lineDiscountCents).toBe(600);
      expect(advancedResult.discountedUnitCount).toBe(2);
      expect(advancedResult.perUnitRewardCents).toBe(300);
    }
  });
});

describe('PosEvaluatePromotionsUseCase — ADVANCED degenerate-cart + 100% (D3, S4)', () => {
  it('S4 — BUY met but no GET line → NO ADVANCED result, NO receipt line', async () => {
    // spec.md:209-213 — 3 × CAT1 units and NO P1 line. The pass
    // silently skips (degenerate).
    const advanced = makeAdvancedPromotion(
      {
        buyTargetType: 'CATEGORIES',
        buyTargetIds: ['CAT1'],
        getTargetType: 'PRODUCTS',
        getTargetIds: ['P1'],
      },
      { buyQuantity: 3, getQuantity: 1, getDiscountPercent: 50 },
    );
    const repo = makeRepository([advanced]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({
            itemId: 'item-cat1',
            productId: 'P-CAT1-1',
            categoryId: 'CAT1',
            quantity: 3,
            effectiveUnitPriceCents: 1000,
          }),
        ],
      }),
    );

    expect(result.lines.find((l) => l.kind === 'advanced')).toBeUndefined();
  });

  it('100% ADVANCED yields a true free GET unit (per-unit=1000c, line discount=1000c)', async () => {
    // spec.md:111-116 — D3 cap lift. ADVANCED getDiscountPercent=100
    // yields perUnit=Math.round(1000*100/100)=1000c → full free unit.
    const advanced = makeAdvancedPromotion(
      {
        buyTargetType: 'CATEGORIES',
        buyTargetIds: ['CAT1'],
        getTargetType: 'PRODUCTS',
        getTargetIds: ['P1'],
      },
      { buyQuantity: 3, getQuantity: 1, getDiscountPercent: 100 },
    );
    const repo = makeRepository([advanced]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({
            itemId: 'item-cat1',
            productId: 'P-CAT1-1',
            categoryId: 'CAT1',
            quantity: 3,
            effectiveUnitPriceCents: 1000,
          }),
          makeLine({
            itemId: 'item-get',
            productId: 'P1',
            quantity: 1,
            effectiveUnitPriceCents: 1000,
          }),
        ],
      }),
    );

    const advancedResult = result.lines.find((l) => l.kind === 'advanced');
    expect(advancedResult).toBeDefined();
    if (advancedResult && advancedResult.kind === 'advanced') {
      expect(advancedResult.perUnitRewardCents).toBe(1000);
      expect(advancedResult.lineDiscountCents).toBe(1000);
    }
  });
});

describe('PosEvaluatePromotionsUseCase — ADVANCED cross-type best-wins (D5, S5)', () => {
  it('S5 — ADVANCED 50% beats 20% PRODUCT_DISCOUNT on the same line (500c > 200c)', async () => {
    // spec.md:141-144 — PD 20% on P1 saves 200c; ADVANCED 50% on P1
    // saves 500c. ADVANCED wins.
    const pd = makePromotion({
      id: 'promo-pd',
      title: '20% off P1',
      discountType: 'PERCENTAGE',
      discountValue: 20,
      targetItems: [
        {
          id: 't-pd-p1',
          side: 'DEFAULT',
          targetType: 'PRODUCTS',
          targetId: 'P1',
        },
      ],
    });
    const advanced = makeAdvancedPromotion(
      {
        buyTargetType: 'CATEGORIES',
        buyTargetIds: ['CAT1'],
        getTargetType: 'PRODUCTS',
        getTargetIds: ['P1'],
      },
      { buyQuantity: 3, getQuantity: 1, getDiscountPercent: 50 },
    );
    const repo = makeRepository([pd, advanced]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({
            itemId: 'item-cat1',
            productId: 'P-CAT1-1',
            categoryId: 'CAT1',
            quantity: 3,
            effectiveUnitPriceCents: 1000,
          }),
          makeLine({
            itemId: 'item-get',
            productId: 'P1',
            quantity: 1,
            effectiveUnitPriceCents: 1000,
          }),
        ],
      }),
    );

    // The P1 line must carry `kind:'advanced'`, NOT `kind:'per-unit'`.
    const getLineResult = result.lines.find((l) => l.itemId === 'item-get');
    expect(getLineResult).toBeDefined();
    expect(getLineResult!.kind).toBe('advanced');
  });

  it('cross-type tie → lowest promotionId wins (P-advanced.id < P-pd.id)', async () => {
    // spec.md:146-149 — tie resolves by lowest promotionId.
    // PD: PERCENTAGE 50 → 500c saving on 1000c.
    // ADVANCED: 1 group × 1 unit × Math.round(1000*50/100) = 500c.
    // Tie → lowest id wins.
    const pd = makePromotion({
      id: 'promo-Z-pd',
      title: 'PD 50% off P1',
      discountType: 'PERCENTAGE',
      discountValue: 50,
      targetItems: [
        {
          id: 't-pd-p1',
          side: 'DEFAULT',
          targetType: 'PRODUCTS',
          targetId: 'P1',
        },
      ],
    });
    const advanced = makeAdvancedPromotion(
      {
        buyTargetType: 'CATEGORIES',
        buyTargetIds: ['CAT1'],
        getTargetType: 'PRODUCTS',
        getTargetIds: ['P1'],
      },
      {
        id: 'promo-A-advanced',
        buyQuantity: 3,
        getQuantity: 1,
        getDiscountPercent: 50,
      },
    );
    const repo = makeRepository([pd, advanced]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({
            itemId: 'item-cat1',
            productId: 'P-CAT1-1',
            categoryId: 'CAT1',
            quantity: 3,
            effectiveUnitPriceCents: 1000,
          }),
          makeLine({
            itemId: 'item-get',
            productId: 'P1',
            quantity: 1,
            effectiveUnitPriceCents: 1000,
          }),
        ],
      }),
    );

    const getLineResult = result.lines.find((l) => l.itemId === 'item-get');
    expect(getLineResult).toBeDefined();
    expect(getLineResult!.kind).toBe('advanced');
    expect((getLineResult as { promotionId: string }).promotionId).toBe(
      'promo-A-advanced',
    );
  });
});

describe('PosEvaluatePromotionsUseCase — ADVANCED pass order (after BXGY, before ORDER)', () => {
  it('ADVANCED saving flows into ORDER_DISCOUNT subtotal (post-line subtotal reflects ADVANCED saving)', async () => {
    // spec.md:189-195 — L1: ADVANCED on L1 (cat BUY → P-GET, 1 group
    // → 500c saving). L2: BXGY on P2 (qty 3, 2+1 @ 50 → 500c saving).
    // Both line savings feed ORDER_DISCOUNT post-line subtotal.
    const advanced = makeAdvancedPromotion(
      {
        buyTargetType: 'CATEGORIES',
        buyTargetIds: ['CAT1'],
        getTargetType: 'PRODUCTS',
        getTargetIds: ['P-GET'],
      },
      { buyQuantity: 3, getQuantity: 1, getDiscountPercent: 50 },
    );
    const bxgy = makePromotion({
      id: 'promo-bxgy-p2',
      type: 'BUY_X_GET_Y',
      method: 'AUTOMATIC',
      appliesTo: 'PRODUCTS',
      buyQuantity: 2,
      getQuantity: 1,
      getDiscountPercent: 50,
      targetItems: [
        {
          id: 't-bxgy-p2',
          side: 'DEFAULT',
          targetType: 'PRODUCTS',
          targetId: 'P2',
        },
      ],
    });
    const order = makePromotion({
      id: 'promo-order-10pct',
      title: 'Order 10%',
      type: 'ORDER_DISCOUNT',
      appliesTo: null,
      targetItems: [],
      discountType: 'PERCENTAGE',
      discountValue: 10,
    });
    const repo = makeRepository([advanced, bxgy, order]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({
            itemId: 'L1-cat',
            productId: 'P-CAT1-1',
            categoryId: 'CAT1',
            quantity: 3,
            effectiveUnitPriceCents: 1000,
          }),
          makeLine({
            itemId: 'L1-get',
            productId: 'P-GET',
            quantity: 1,
            effectiveUnitPriceCents: 1000,
          }),
          makeLine({
            itemId: 'L2',
            productId: 'P2',
            quantity: 3,
            effectiveUnitPriceCents: 1000,
          }),
        ],
      }),
    );

    // Both per-line winners present (no cross-stacking).
    expect(result.lines).toHaveLength(2);
    // post-line subtotal = (L1-cat 3000c + L1-get 1000c - 500c ADVANCED saving)
    //                   + (L2 3000c - 500c BXGY saving)
    //                   = 3500 + 2500 = 6000c.
    // ORDER_DISCOUNT 10% on 6000c → 600c.
    expect(result.order).not.toBeNull();
    expect(result.order!.promotionId).toBe('promo-order-10pct');
    expect(result.order!.discountAmountCents).toBe(600);
  });
});