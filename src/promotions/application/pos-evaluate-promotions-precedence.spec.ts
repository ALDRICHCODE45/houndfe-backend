/**
 * PosEvaluatePromotionsUseCase — Specificity Precedence Ladder
 * (W2, ordinal pre-pass — RED-first).
 *
 * Pre-pass rule (design.md "Ordinal pre-pass — zero-regression
 * argument"): keep only candidates at the MAX ordinal present on a
 * line, then best-wins. Ordinals:
 *   VARIANT  = 3
 *   PRODUCT  = 2
 *   BRAND    = 1   (peer of CATEGORY — EQUAL-broadness)
 *   CATEGORY = 1   (peer of BRAND   — EQUAL-broadness)
 *
 * Spec scenarios exercised:
 *   - VARIANTS wins over BRANDS and CATEGORIES on the same line
 *   - PRODUCTS wins over BRANDS and CATEGORIES on the same line
 *   - BRAND ≡ CATEGORY: best-wins decides (higher discount wins the
 *     peer tie; on a tie, lowest id), NOT tier.
 *   - VARIANTS/PRODUCTS-only precedence is unchanged (regression
 *     guard: pre-existing fixtures must stay green).
 *
 * Tier order in the helper matters ONLY for picking which tier the
 * line "claims" when MULTIPLE tiers hit. The precedence pre-pass
 * handles the ranking — when both BRAND and CATEGORY hit a line, the
 * helper returns one of them (currently CATEGORY, but the value is
 * irrelevant for ranking — both have ordinal 1 and best-wins
 * tiebreaks). Both candidates enter `eligible[]` with their own tier
 * value; the ordinal pre-pass keeps them, then best-wins picks the
 * higher discount.
 *
 * The ordinal pre-pass MUST be provably equivalent to the old binary
 * `hasVariantTier` check on VARIANTS/PRODUCTS-only inputs:
 *   - If any VARIANT exists → maxOrd=3 → keep only VARIANT candidates
 *     (same as old hasVariantTier branch).
 *   - Else (PRODUCTS only) → maxOrd=2 → keep all (same as old else).
 * The `VARIANTS/PRODUCTS-only` regression block at the bottom of this
 * file pins this equivalence.
 */
import {
  PosEvaluatePromotionsUseCase,
} from './pos-evaluate-promotions.use-case';
import type { IPromotionRepository } from '../domain/promotion.repository';
import { Promotion } from '../domain/promotion.entity';
import type {
  PosEvalInput,
  PosEvalLine,
} from './ports/pos-evaluate-promotions.port';

// ============================================================
// Fixtures
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
// Spec 1 — VARIANTS wins over BRANDS and CATEGORIES on the same line
// ============================================================

describe('PosEvaluatePromotionsUseCase — VARIANT wins over BRAND/CATEGORY (4-tier)', () => {
  it('VARIANTS promo (V-A, FIXED 10c) wins over BRANDS BR1 (FIXED 500c) AND CATEGORIES CAT1 (FIXED 500c) on the same V-A line', async () => {
    const promoV = makePromotion({
      id: 'promo-V',
      appliesTo: 'VARIANTS',
      discountType: 'FIXED',
      discountValue: 10,
      targetItems: [
        { id: 'ti-v', side: 'DEFAULT', targetType: 'VARIANTS', targetId: 'V-A' },
      ],
    });
    const promoB = makePromotion({
      id: 'promo-B',
      appliesTo: 'BRANDS',
      discountType: 'FIXED',
      discountValue: 500,
      targetItems: [
        { id: 'ti-b', side: 'DEFAULT', targetType: 'BRANDS', targetId: 'BR1' },
      ],
    });
    const promoC = makePromotion({
      id: 'promo-C',
      appliesTo: 'CATEGORIES',
      discountType: 'FIXED',
      discountValue: 500,
      targetItems: [
        {
          id: 'ti-c',
          side: 'DEFAULT',
          targetType: 'CATEGORIES',
          targetId: 'CAT1',
        },
      ],
    });
    const repo = makeRepository([promoV, promoB, promoC]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({
            itemId: 'item-A',
            productId: 'P1',
            variantId: 'V-A',
            categoryId: 'CAT1',
            brandId: 'BR1',
            effectiveUnitPriceCents: 1000,
          }),
        ],
      }),
    );

    expect(result.lines).toHaveLength(1);
    // VARIANTS wins by tier — BRANDS/CATEGORIES (both ordinal 1) are
    // DROPPED even though their discount (500c) is larger than
    // VARIANTS' (10c). Specificity trumps magnitude.
    expect(result.lines[0].promotionId).toBe('promo-V');
    expect(result.lines[0].discountValue).toBe(10);
  });
});

// ============================================================
// Spec 2 — PRODUCTS wins over BRANDS and CATEGORIES on the same line
// ============================================================

describe('PosEvaluatePromotionsUseCase — PRODUCT wins over BRAND/CATEGORY (3-tier)', () => {
  it('PRODUCTS promo (P1, FIXED 10c) wins over BRANDS BR1 (FIXED 500c) AND CATEGORIES CAT1 (FIXED 500c) on the same P1 line', async () => {
    const promoP = makePromotion({
      id: 'promo-P',
      appliesTo: 'PRODUCTS',
      discountType: 'FIXED',
      discountValue: 10,
      targetItems: [
        {
          id: 'ti-p',
          side: 'DEFAULT',
          targetType: 'PRODUCTS',
          targetId: 'P1',
        },
      ],
    });
    const promoB = makePromotion({
      id: 'promo-B',
      appliesTo: 'BRANDS',
      discountType: 'FIXED',
      discountValue: 500,
      targetItems: [
        { id: 'ti-b', side: 'DEFAULT', targetType: 'BRANDS', targetId: 'BR1' },
      ],
    });
    const promoC = makePromotion({
      id: 'promo-C',
      appliesTo: 'CATEGORIES',
      discountType: 'FIXED',
      discountValue: 500,
      targetItems: [
        {
          id: 'ti-c',
          side: 'DEFAULT',
          targetType: 'CATEGORIES',
          targetId: 'CAT1',
        },
      ],
    });
    const repo = makeRepository([promoP, promoB, promoC]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({
            itemId: 'item-P1',
            productId: 'P1',
            variantId: null,
            categoryId: 'CAT1',
            brandId: 'BR1',
            effectiveUnitPriceCents: 1000,
          }),
        ],
      }),
    );

    expect(result.lines).toHaveLength(1);
    // PRODUCTS wins by tier — BRANDS/CATEGORIES (ordinal 1) are
    // dropped even though their discount (500c) is larger.
    expect(result.lines[0].promotionId).toBe('promo-P');
    expect(result.lines[0].discountValue).toBe(10);
  });
});

// ============================================================
// Spec 3 — BRAND ≡ CATEGORY: best-wins decides, not tier
// ============================================================

describe('PosEvaluatePromotionsUseCase — BRAND ≡ CATEGORY peers (2-tier)', () => {
  it('when CATEGORIES promo (CAT1, FIXED 500c) and BRANDS promo (BR1, FIXED 100c) both match a line, the higher discount (CATEGORIES) wins', async () => {
    const promoC = makePromotion({
      id: 'promo-C',
      appliesTo: 'CATEGORIES',
      discountType: 'FIXED',
      discountValue: 500,
      targetItems: [
        {
          id: 'ti-c',
          side: 'DEFAULT',
          targetType: 'CATEGORIES',
          targetId: 'CAT1',
        },
      ],
    });
    const promoB = makePromotion({
      id: 'promo-B',
      appliesTo: 'BRANDS',
      discountType: 'FIXED',
      discountValue: 100,
      targetItems: [
        { id: 'ti-b', side: 'DEFAULT', targetType: 'BRANDS', targetId: 'BR1' },
      ],
    });
    const repo = makeRepository([promoC, promoB]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({
            itemId: 'item-P1',
            productId: 'P1',
            variantId: null,
            categoryId: 'CAT1',
            brandId: 'BR1',
            effectiveUnitPriceCents: 1000,
          }),
        ],
      }),
    );

    expect(result.lines).toHaveLength(1);
    // CATEGORIES (500c) > BRANDS (100c) → CATEGORIES wins the peer
    // tie. NOT a BRAND-over-CATEGORY hierarchy — best-wins decides.
    expect(result.lines[0].promotionId).toBe('promo-C');
    expect(result.lines[0].discountValue).toBe(500);
  });

  it('flips: when BRANDS promo (BR1, FIXED 500c) > CATEGORIES promo (CAT1, FIXED 100c), BRANDS wins (no hierarchy)', async () => {
    // Same pair, but BRAND is the higher discount. The outcome MUST
    // flip — proves there is no BRAND-over-CATEGORY tier priority.
    const promoC = makePromotion({
      id: 'promo-C',
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
    const promoB = makePromotion({
      id: 'promo-B',
      appliesTo: 'BRANDS',
      discountType: 'FIXED',
      discountValue: 500,
      targetItems: [
        { id: 'ti-b', side: 'DEFAULT', targetType: 'BRANDS', targetId: 'BR1' },
      ],
    });
    const repo = makeRepository([promoC, promoB]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({
            itemId: 'item-P1',
            productId: 'P1',
            variantId: null,
            categoryId: 'CAT1',
            brandId: 'BR1',
            effectiveUnitPriceCents: 1000,
          }),
        ],
      }),
    );

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].promotionId).toBe('promo-B');
    expect(result.lines[0].discountValue).toBe(500);
  });

  it('BRAND vs CATEGORY tie on discount resolves by lowest promotionId (deterministic best-wins tiebreak)', async () => {
    const promoC = makePromotion({
      id: 'promo-C-Z',
      appliesTo: 'CATEGORIES',
      discountType: 'FIXED',
      discountValue: 500,
      targetItems: [
        {
          id: 'ti-c',
          side: 'DEFAULT',
          targetType: 'CATEGORIES',
          targetId: 'CAT1',
        },
      ],
    });
    const promoB = makePromotion({
      id: 'promo-B-A',
      appliesTo: 'BRANDS',
      discountType: 'FIXED',
      discountValue: 500,
      targetItems: [
        { id: 'ti-b', side: 'DEFAULT', targetType: 'BRANDS', targetId: 'BR1' },
      ],
    });
    const repo = makeRepository([promoC, promoB]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({
            itemId: 'item-P1',
            productId: 'P1',
            variantId: null,
            categoryId: 'CAT1',
            brandId: 'BR1',
            effectiveUnitPriceCents: 1000,
          }),
        ],
      }),
    );

    expect(result.lines).toHaveLength(1);
    // Equal discount, so lowest id wins: 'promo-B-A' < 'promo-C-Z'.
    expect(result.lines[0].promotionId).toBe('promo-B-A');
  });
});

// ============================================================
// Spec 4 — VARIANTS/PRODUCTS-only regression guard (zero-regression
// argument for the ordinal generalization).
// ============================================================

describe('PosEvaluatePromotionsUseCase — VARIANTS/PRODUCTS-only regression guard', () => {
  it('on a V-A line: VARIANTS (V-A, 30c) wins over PRODUCTS (P1, 50c); identical to old binary hasVariantTier branch', async () => {
    const promoPV = makePromotion({
      id: 'promo-PV',
      appliesTo: 'PRODUCTS',
      discountType: 'FIXED',
      discountValue: 50,
      targetItems: [
        { id: 'ti-pv', side: 'DEFAULT', targetType: 'PRODUCTS', targetId: 'P1' },
      ],
    });
    const promoPW = makePromotion({
      id: 'promo-PW',
      appliesTo: 'VARIANTS',
      discountType: 'FIXED',
      discountValue: 30,
      targetItems: [
        { id: 'ti-pw', side: 'DEFAULT', targetType: 'VARIANTS', targetId: 'V-A' },
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
        ],
      }),
    );

    expect(result.lines).toHaveLength(1);
    // VARIANTS wins on V-A — identical to the old `hasVariantTier`
    // branch behavior.
    expect(result.lines[0].promotionId).toBe('promo-PW');
    expect(result.lines[0].discountValue).toBe(30);
  });

  it('on a V-B line: VARIANTS (V-A) does NOT match → PRODUCTS (P1, 50c) wins; identical to old else branch', async () => {
    const promoPV = makePromotion({
      id: 'promo-PV',
      appliesTo: 'PRODUCTS',
      discountType: 'FIXED',
      discountValue: 50,
      targetItems: [
        { id: 'ti-pv', side: 'DEFAULT', targetType: 'PRODUCTS', targetId: 'P1' },
      ],
    });
    const promoPW = makePromotion({
      id: 'promo-PW',
      appliesTo: 'VARIANTS',
      discountType: 'FIXED',
      discountValue: 30,
      targetItems: [
        { id: 'ti-pw', side: 'DEFAULT', targetType: 'VARIANTS', targetId: 'V-A' },
      ],
    });
    const repo = makeRepository([promoPV, promoPW]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({
            itemId: 'item-B',
            productId: 'P1',
            variantId: 'V-B',
            effectiveUnitPriceCents: 1000,
          }),
        ],
      }),
    );

    expect(result.lines).toHaveLength(1);
    // VARIANTS V-A does NOT match V-B → PRODUCTS wins on P1.
    // Identical to the old `hasVariantTier=false` branch behavior.
    expect(result.lines[0].promotionId).toBe('promo-PV');
    expect(result.lines[0].discountValue).toBe(50);
  });

  it('PRODUCTS-only: only one PRODUCTS promo on P1 applies to P1 line — ordinal pre-pass keeps all (no VARIANTS)', async () => {
    const promoP = makePromotion({
      id: 'promo-products-only',
      appliesTo: 'PRODUCTS',
      discountType: 'FIXED',
      discountValue: 100,
      targetItems: [
        { id: 'ti-p', side: 'DEFAULT', targetType: 'PRODUCTS', targetId: 'P1' },
      ],
    });
    const repo = makeRepository([promoP]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({
            itemId: 'item-P1',
            productId: 'P1',
            variantId: null,
            effectiveUnitPriceCents: 1000,
          }),
        ],
      }),
    );

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].promotionId).toBe('promo-products-only');
  });
});