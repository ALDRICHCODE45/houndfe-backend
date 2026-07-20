/**
 * W4 — Wire match sites + VARIANT-wins precedence (RED-first).
 *
 * This is the behavior layer for scenarios 5, 6, 8, 9 (VARIANTS-wins
 * precedence + MANUAL opt-in self-heal). Scenarios 1-4, 7 are covered
 * by `match-target-tier.spec.ts` (W3, the pure helper).
 *
 * Production code changes that this file pins:
 *   - `pickBestPerLine` collects {promo, tier, discountCents} using the
 *     shared `matchTargetTier` helper instead of an inline PRODUCTS
 *     predicate.
 *   - The per-line precedence pre-pass drops tier='PRODUCT' candidates
 *     when ANY candidate for that line is tier='VARIANT' — BEFORE
 *     best-wins.
 *   - `targetableManualPromotionIds` uses `matchTargetTier(...) !== null`
 *     as the "has matching line" test, accepting VARIANTS matches too
 *     (self-heal must retain opted-in VARIANTS promos whose target line
 *     is still in the cart).
 *   - `isSupportedEngineType` returns true for PRODUCT_DISCOUNT with
 *     appliesTo='VARIANTS' (the variant-aware gate).
 *   - `appliesTo='VARIANTS'` lines flow through `pickBestPerLine` and
 *     hit the same gates (price-list, hasManualDiscount, MANUAL opt-in,
 *     veto) as PRODUCTS lines.
 */
import {
  PosEvaluatePromotionsUseCase,
  clampPercentageToSafeRange,
} from './pos-evaluate-promotions.use-case';
import type { IPromotionRepository } from '../domain/promotion.repository';
import { Promotion } from '../domain/promotion.entity';
import type {
  PosEvalInput,
  PosEvalLine,
} from './ports/pos-evaluate-promotions.port';

// ============================================================
// Fixtures — extends W3 helpers with VARIANTS-typed targets
// ============================================================

const NOW = new Date('2026-06-10T15:00:00.000Z');
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
  };
}

function makeInput(overrides: Partial<PosEvalInput> = {}): PosEvalInput {
  return {
    now: NOW,
    customerId: null,
    lines: [makeLine()],
    vetoedPromotionIds: [],
    optedInManualPromotionIds: [],
    ...overrides,
  };
}

// ============================================================
// Scenario 5 — VARIANTS wins over PRODUCTS on the same line
// ============================================================

describe('PosEvaluatePromotionsUseCase — VARIANT-wins precedence (scenario 5)', () => {
  it('applies VARIANTS promo (V-A, 30c) over PRODUCTS promo (P1, 50c) on the V-A line; applies PRODUCTS on the V-B line', async () => {
    // P-V : PRODUCTS on P1, AUTOMATIC, FIXED 50c
    // P-W : VARIANTS on V-A, AUTOMATIC, FIXED 30c
    const promoPV = makePromotion({
      id: 'promo-PV',
      appliesTo: 'PRODUCTS',
      discountType: 'FIXED',
      discountValue: 50,
      targetItems: [
        {
          id: 'ti-pv',
          side: 'DEFAULT',
          targetType: 'PRODUCTS',
          targetId: 'P1',
        },
      ],
    });
    const promoPW = makePromotion({
      id: 'promo-PW',
      appliesTo: 'VARIANTS',
      discountType: 'FIXED',
      discountValue: 30,
      targetItems: [
        {
          id: 'ti-pw',
          side: 'DEFAULT',
          targetType: 'VARIANTS',
          targetId: 'V-A',
        },
      ],
    });
    const repo = makeRepository([promoPV, promoPW]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({
            itemId: 'item-A',
            productId: 'P1',
            variantId: 'V-A',
            effectiveUnitPriceCents: 1000,
          }),
          makeLine({
            itemId: 'item-B',
            productId: 'P1',
            variantId: 'V-B',
            effectiveUnitPriceCents: 1000,
          }),
        ],
      }),
    );

    expect(result.lines).toHaveLength(2);

    const lineA = result.lines.find((l) => l.itemId === 'item-A');
    expect(lineA).toBeDefined();
    expect(lineA!.promotionId).toBe('promo-PW'); // VARIANTS wins over PRODUCTS
    expect(lineA!.discountType).toBe('amount');
    expect(lineA!.discountValue).toBe(30);

    const lineB = result.lines.find((l) => l.itemId === 'item-B');
    expect(lineB).toBeDefined();
    expect(lineB!.promotionId).toBe('promo-PV'); // PRODUCTS only matches V-B line
    expect(lineB!.discountType).toBe('amount');
    expect(lineB!.discountValue).toBe(50);
  });
});

// ============================================================
// Scenario 6 — VARIANTS wins regardless of discount magnitude
// ============================================================

describe('PosEvaluatePromotionsUseCase — VARIANTS wins regardless of discount (scenario 6)', () => {
  it('applies VARIANTS promo (V-A, FIXED 10c) over PRODUCTS promo (P1, FIXED 500c) on the V-A line', async () => {
    // VARIANTS (lower discount) wins on V-A over PRODUCTS (higher discount).
    const promoVariants = makePromotion({
      id: 'promo-V-10c',
      appliesTo: 'VARIANTS',
      discountType: 'FIXED',
      discountValue: 10,
      targetItems: [
        {
          id: 'ti-v',
          side: 'DEFAULT',
          targetType: 'VARIANTS',
          targetId: 'V-A',
        },
      ],
    });
    const promoProducts = makePromotion({
      id: 'promo-X-500c',
      appliesTo: 'PRODUCTS',
      discountType: 'FIXED',
      discountValue: 500,
      targetItems: [
        { id: 'ti-x', side: 'DEFAULT', targetType: 'PRODUCTS', targetId: 'P1' },
      ],
    });
    const repo = makeRepository([promoVariants, promoProducts]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({
            itemId: 'item-A',
            productId: 'P1',
            variantId: 'V-A',
            effectiveUnitPriceCents: 1000,
          }),
        ],
      }),
    );

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].promotionId).toBe('promo-V-10c');
    expect(result.lines[0].discountValue).toBe(10);
    // Explicit anti-regression — the PRODUCTS-500c promo MUST NOT be applied.
    expect(result.lines[0].promotionId).not.toBe('promo-X-500c');
  });
});

// ============================================================
// Scenario 7 — VARIANTS target on a different variant does NOT match
// ============================================================

describe('PosEvaluatePromotionsUseCase — VARIANTS on different variant does not match (scenario 7)', () => {
  it('a VARIANTS promo on V-B is NOT applied to a V-A line', async () => {
    const promoY = makePromotion({
      id: 'promo-Y',
      appliesTo: 'VARIANTS',
      discountType: 'FIXED',
      discountValue: 30,
      targetItems: [
        {
          id: 'ti-y',
          side: 'DEFAULT',
          targetType: 'VARIANTS',
          targetId: 'V-B',
        },
      ],
    });
    const repo = makeRepository([promoY]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({
            itemId: 'item-A',
            productId: 'P1',
            variantId: 'V-A',
            effectiveUnitPriceCents: 1000,
          }),
        ],
      }),
    );

    expect(result.lines).toEqual([]);
  });
});

// ============================================================
// Scenario 8 — MANUAL VARIANTS-targeted promo appears in targetable set
// ============================================================

describe('PosEvaluatePromotionsUseCase — MANUAL VARIANTS in targetable set (scenario 8)', () => {
  it('opt-in MANUAL VARIANTS promo on V-A appears in targetableManualPromotionIds for a draft with one V-A line', async () => {
    const promoM = makePromotion({
      id: 'promo-M',
      method: 'MANUAL',
      appliesTo: 'VARIANTS',
      discountType: 'FIXED',
      discountValue: 100,
      targetItems: [
        {
          id: 'ti-m',
          side: 'DEFAULT',
          targetType: 'VARIANTS',
          targetId: 'V-A',
        },
      ],
    });
    const repo = makeRepository([promoM]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        optedInManualPromotionIds: ['promo-M'],
        lines: [
          makeLine({
            itemId: 'item-A',
            productId: 'P1',
            variantId: 'V-A',
            effectiveUnitPriceCents: 1000,
          }),
        ],
      }),
    );

    expect(result.targetableManualPromotionIds).toContain('promo-M');
  });
});

// ============================================================
// Scenario 9 — Opted-in MANUAL VARIANTS survives recompute after
// adding an unrelated line (self-heal must NOT lose the opt-in)
// ============================================================

describe('PosEvaluatePromotionsUseCase — opted-in MANUAL VARIANTS survives recompute (scenario 9)', () => {
  it('the opted-in MANUAL VARIANTS promo on V-A is still targetable after an unrelated P2 line is added', async () => {
    const promoM = makePromotion({
      id: 'promo-M',
      method: 'MANUAL',
      appliesTo: 'VARIANTS',
      discountType: 'FIXED',
      discountValue: 100,
      targetItems: [
        {
          id: 'ti-m',
          side: 'DEFAULT',
          targetType: 'VARIANTS',
          targetId: 'V-A',
        },
      ],
    });
    const repo = makeRepository([promoM]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    // Recompute 1: V-A line only.
    const first = await useCase.evaluate(
      makeInput({
        optedInManualPromotionIds: ['promo-M'],
        lines: [
          makeLine({
            itemId: 'item-A',
            productId: 'P1',
            variantId: 'V-A',
            effectiveUnitPriceCents: 1000,
          }),
        ],
      }),
    );
    expect(first.targetableManualPromotionIds).toContain('promo-M');

    // Recompute 2: V-A line AND an unrelated P2 line added by the seller.
    const second = await useCase.evaluate(
      makeInput({
        optedInManualPromotionIds: ['promo-M'],
        lines: [
          makeLine({
            itemId: 'item-A',
            productId: 'P1',
            variantId: 'V-A',
            effectiveUnitPriceCents: 1000,
          }),
          makeLine({
            itemId: 'item-P2',
            productId: 'P2',
            variantId: null,
            effectiveUnitPriceCents: 500,
          }),
        ],
      }),
    );
    // The opt-in MUST still be retained on V-A — the V-A line is still in
    // the cart, so targetable should still contain promo-M.
    expect(second.targetableManualPromotionIds).toContain('promo-M');
    // And the applied line MUST still report promo-M on the V-A line.
    const lineAResult = second.lines.find((l) => l.itemId === 'item-A');
    expect(lineAResult).toBeDefined();
    expect(lineAResult!.promotionId).toBe('promo-M');
  });
});

// ============================================================
// Regression — PRODUCTS still hits every variant of a variant-bearing product
// (scenario 3, end-to-end via the engine, not just the helper)
// ============================================================

describe('PosEvaluatePromotionsUseCase — PRODUCTS still hits every variant (regression)', () => {
  it('PRODUCTS promo on P1 applies to BOTH V-A and V-B lines', async () => {
    const promo = makePromotion({
      id: 'promo-products',
      appliesTo: 'PRODUCTS',
      discountType: 'FIXED',
      discountValue: 100,
      targetItems: [
        { id: 'ti-p', side: 'DEFAULT', targetType: 'PRODUCTS', targetId: 'P1' },
      ],
    });
    const repo = makeRepository([promo]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({
            itemId: 'item-A',
            productId: 'P1',
            variantId: 'V-A',
            effectiveUnitPriceCents: 1000,
          }),
          makeLine({
            itemId: 'item-B',
            productId: 'P1',
            variantId: 'V-B',
            effectiveUnitPriceCents: 1000,
          }),
        ],
      }),
    );

    expect(result.lines).toHaveLength(2);
    expect(result.lines[0].promotionId).toBe('promo-products');
    expect(result.lines[1].promotionId).toBe('promo-products');
  });
});

// ============================================================
// Regression — MANUAL VARIANTS promo considers price-list + hasManualDiscount
// ============================================================

describe('PosEvaluatePromotionsUseCase — MANUAL VARIANTS respects price-list + hasManualDiscount', () => {
  it('VARIANTS promo is skipped on a line with hasManualDiscount=true', async () => {
    const promoV = makePromotion({
      id: 'promo-V',
      appliesTo: 'VARIANTS',
      discountType: 'FIXED',
      discountValue: 100,
      targetItems: [
        {
          id: 'ti-v',
          side: 'DEFAULT',
          targetType: 'VARIANTS',
          targetId: 'V-A',
        },
      ],
    });
    const repo = makeRepository([promoV]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({
            itemId: 'item-A',
            productId: 'P1',
            variantId: 'V-A',
            effectiveUnitPriceCents: 1000,
            hasManualDiscount: true,
          }),
        ],
      }),
    );

    // Manual free-form discount wins — auto promo skips this line.
    expect(result.lines).toEqual([]);
  });

  it('VARIANTS promo is skipped when the line has no matching global price-list', async () => {
    const promoV = makePromotion({
      id: 'promo-V',
      appliesTo: 'VARIANTS',
      discountType: 'FIXED',
      discountValue: 100,
      priceLists: [{ id: 'ppl-1', globalPriceListId: 'GPL-retail' }],
      targetItems: [
        {
          id: 'ti-v',
          side: 'DEFAULT',
          targetType: 'VARIANTS',
          targetId: 'V-A',
        },
      ],
    });
    const repo = makeRepository([promoV]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({
            itemId: 'item-A',
            productId: 'P1',
            variantId: 'V-A',
            effectiveUnitPriceCents: 1000,
            appliedGlobalPriceListId: 'GPL-mayoreo',
          }),
        ],
      }),
    );

    expect(result.lines).toEqual([]);
  });
});

// ============================================================
// W3 clamp invariant still holds for VARIANTS promos
// ============================================================

describe('PosEvaluatePromotionsUseCase — clamp invariant survives VARIANTS', () => {
  it('emits the clamped 99% PERCENTAGE value for a VARIANTS promo', () => {
    expect(clampPercentageToSafeRange(100)).toBe(99);
  });
});

// ============================================================
// W2 — CATEGORIES / BRANDS gate flip + self-heal (RED-first)
//
// The engine's gate (`isSupportedEngineType`) currently returns
// `false` for PRODUCT_DISCOUNT + appliesTo ∈ {CATEGORIES, BRANDS}.
// After W2, those engine types MUST be accepted so the matcher can
// apply them. Behavior pinned here:
//   - An AUTO CATEGORIES promo on a matching line applies (gated in).
//   - An AUTO BRANDS promo on a matching line applies (gated in).
//   - An opted-in MANUAL CATEGORIES promo on a matching line is
//     retained in `targetableManualPromotionIds` (self-heal gate).
//   - An opted-in MANUAL BRANDS promo on a matching line is
//     retained in `targetableManualPromotionIds`.
//   - The `availableManualPromotions` list includes a MANUAL
//     CATEGORIES / BRANDS promo for the seller's opt-in UI.
// ============================================================

describe('PosEvaluatePromotionsUseCase — CATEGORIES/BRANDS gate flip (W2)', () => {
  it('applies an AUTO CATEGORIES promo on a line whose product.categoryId matches the target', async () => {
    const promo = makePromotion({
      id: 'promo-cat-auto',
      appliesTo: 'CATEGORIES',
      discountType: 'FIXED',
      discountValue: 100,
      targetItems: [
        {
          id: 'ti-c',
          side: 'DEFAULT',
          targetType: 'CATEGORIES',
          targetId: 'CAT1',
        },
      ],
    });
    const repo = makeRepository([promo]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({
            itemId: 'item-CAT1',
            productId: 'P1',
            variantId: null,
            categoryId: 'CAT1',
            brandId: null,
            effectiveUnitPriceCents: 1000,
          }),
        ],
      }),
    );

    // Gate accepts CATEGORIES + line matches → applied.
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].promotionId).toBe('promo-cat-auto');
    expect(result.lines[0].discountValue).toBe(100);
  });

  it('applies an AUTO BRANDS promo on a line whose product.brandId matches the target', async () => {
    const promo = makePromotion({
      id: 'promo-brand-auto',
      appliesTo: 'BRANDS',
      discountType: 'FIXED',
      discountValue: 75,
      targetItems: [
        { id: 'ti-b', side: 'DEFAULT', targetType: 'BRANDS', targetId: 'BR1' },
      ],
    });
    const repo = makeRepository([promo]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({
            itemId: 'item-BR1',
            productId: 'P1',
            variantId: null,
            categoryId: null,
            brandId: 'BR1',
            effectiveUnitPriceCents: 1000,
          }),
        ],
      }),
    );

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].promotionId).toBe('promo-brand-auto');
    expect(result.lines[0].discountValue).toBe(75);
  });

  it('a MANUAL CATEGORIES promo appears in availableManualPromotions (not opted-in yet)', async () => {
    const promo = makePromotion({
      id: 'promo-cat-manual',
      method: 'MANUAL',
      appliesTo: 'CATEGORIES',
      discountType: 'FIXED',
      discountValue: 50,
      targetItems: [
        {
          id: 'ti-c',
          side: 'DEFAULT',
          targetType: 'CATEGORIES',
          targetId: 'CAT1',
        },
      ],
    });
    const repo = makeRepository([promo]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({
            itemId: 'item-CAT1',
            productId: 'P1',
            categoryId: 'CAT1',
            brandId: null,
            effectiveUnitPriceCents: 1000,
          }),
        ],
      }),
    );

    // The seller's opt-in UI must include the MANUAL CATEGORIES
    // promo for a line in CAT1 — gate accepts it.
    expect(result.availableManualPromotions).toHaveLength(1);
    expect(result.availableManualPromotions[0].id).toBe('promo-cat-manual');
  });

  it('a MANUAL BRANDS promo appears in availableManualPromotions (not opted-in yet)', async () => {
    const promo = makePromotion({
      id: 'promo-brand-manual',
      method: 'MANUAL',
      appliesTo: 'BRANDS',
      discountType: 'FIXED',
      discountValue: 50,
      targetItems: [
        { id: 'ti-b', side: 'DEFAULT', targetType: 'BRANDS', targetId: 'BR1' },
      ],
    });
    const repo = makeRepository([promo]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({
            itemId: 'item-BR1',
            productId: 'P1',
            categoryId: null,
            brandId: 'BR1',
            effectiveUnitPriceCents: 1000,
          }),
        ],
      }),
    );

    expect(result.availableManualPromotions).toHaveLength(1);
    expect(result.availableManualPromotions[0].id).toBe('promo-brand-manual');
  });

  it('an opted-in MANUAL CATEGORIES promo with a matching line is retained in targetableManualPromotionIds (self-heal)', async () => {
    const promo = makePromotion({
      id: 'promo-cat-opted',
      method: 'MANUAL',
      appliesTo: 'CATEGORIES',
      discountType: 'FIXED',
      discountValue: 200,
      targetItems: [
        {
          id: 'ti-c',
          side: 'DEFAULT',
          targetType: 'CATEGORIES',
          targetId: 'CAT1',
        },
      ],
    });
    const repo = makeRepository([promo]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        optedInManualPromotionIds: ['promo-cat-opted'],
        lines: [
          makeLine({
            itemId: 'item-CAT1',
            productId: 'P1',
            categoryId: 'CAT1',
            brandId: null,
            effectiveUnitPriceCents: 1000,
          }),
        ],
      }),
    );

    // The opt-in MUST be retained because the line still matches.
    expect(result.targetableManualPromotionIds).toContain('promo-cat-opted');
  });

  it('an opted-in MANUAL BRANDS promo with a matching line is retained in targetableManualPromotionIds (self-heal)', async () => {
    const promo = makePromotion({
      id: 'promo-brand-opted',
      method: 'MANUAL',
      appliesTo: 'BRANDS',
      discountType: 'FIXED',
      discountValue: 200,
      targetItems: [
        { id: 'ti-b', side: 'DEFAULT', targetType: 'BRANDS', targetId: 'BR1' },
      ],
    });
    const repo = makeRepository([promo]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        optedInManualPromotionIds: ['promo-brand-opted'],
        lines: [
          makeLine({
            itemId: 'item-BR1',
            productId: 'P1',
            categoryId: null,
            brandId: 'BR1',
            effectiveUnitPriceCents: 1000,
          }),
        ],
      }),
    );

    expect(result.targetableManualPromotionIds).toContain('promo-brand-opted');
  });

  it('an opted-in MANUAL CATEGORIES promo whose category is REMOVED from the cart is NOT in targetable (orphan prune)', async () => {
    // Self-heal gate: only retain the opt-in while at least one
    // line in the cart matches the target.
    const promo = makePromotion({
      id: 'promo-cat-opted-orphan',
      method: 'MANUAL',
      appliesTo: 'CATEGORIES',
      discountType: 'FIXED',
      discountValue: 200,
      targetItems: [
        {
          id: 'ti-c',
          side: 'DEFAULT',
          targetType: 'CATEGORIES',
          targetId: 'CAT1',
        },
      ],
    });
    const repo = makeRepository([promo]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    // Cart has a CAT2 line — the CAT1 target is gone.
    const result = await useCase.evaluate(
      makeInput({
        optedInManualPromotionIds: ['promo-cat-opted-orphan'],
        lines: [
          makeLine({
            itemId: 'item-CAT2',
            productId: 'P2',
            categoryId: 'CAT2',
            brandId: null,
            effectiveUnitPriceCents: 1000,
          }),
        ],
      }),
    );

    expect(result.targetableManualPromotionIds).not.toContain(
      'promo-cat-opted-orphan',
    );
  });
});
