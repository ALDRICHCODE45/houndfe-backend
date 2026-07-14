/**
 * WU3 — BUY_X_GET_Y engine pass (RED-first).
 *
 * Contract (design.md Decisions 3 + 4; spec.md:21-37,60-96):
 *   - Gate: `isSupportedEngineType(promo)` admits BXGY with
 *     `appliesTo ∈ {PRODUCTS, VARIANTS, CATEGORIES, BRANDS}` (Q1 — Q5
 *     targeted).
 *   - Counting (spec.md:60-91): per-line, gated on
 *     `line.quantity >= buyQuantity`; helper computes
 *     `floor(qty / (N+M)) * M * Math.round((unitPrice * getDiscountPercent) / 100)`.
 *   - Comparator (Q5 REVISED — cross-type TOTAL saving):
 *     pdPerUnitCents = computeAppliedDiscountCents(line, existingPd)   // per-unit
 *     pdTotalCents   = pdPerUnitCents * line.quantity                   // line total
 *     bxgyTotalCents = bxgyWinner.lineDiscountCents                    // line total R
 *     bxgy wins IFF bxgyTotalCents > pdTotalCents
 *       OR (bxgyTotalCents === pdTotalCents && bxgyWinner.id < existingPd.promotionId).
 *   - Pass order (spec.md:34-37): the per-line BXGY pass runs AFTER
 *     the per-line PRODUCT_DISCOUNT best-wins pass and BEFORE the
 *     post-line-subtotal ORDER_DISCOUNT computation, so the
 *     `postLineSubtotalCents` fed to `pickBestOrderPromo` reflects
 *     the BXGY saving.
 *   - `hasManualDiscount` short-circuit (mirrors use-case.ts:419):
 *     AUTOMATIC BXGY skips a line already carrying a seller free-form
 *     discount — same gate as the per-line PRODUCT_DISCOUNT branch.
 *   - Discriminated `PosEvalLineResult` union: BXGY kind carries
 *     `{kind:'buy-x-get-y', lineDiscountCents, perUnitRewardCents,
 *       discountedUnitCount, promotionId, discountTitle}`; per-unit
 *       kind keeps the existing `discountType`/`discountValue` shape
 *       and gains an OPTIONAL `kind?: 'per-unit'` discriminator (default
 *       keeps existing literals compiling).
 *
 * Engine is pure (no I/O). All tests use a mocked IPromotionRepository.
 */
import { PosEvaluatePromotionsUseCase } from './pos-evaluate-promotions.use-case';
import type { IPromotionRepository } from '../domain/promotion.repository';
import { Promotion, type DayOfWeek } from '../domain/promotion.entity';
import type {
  PosEvalInput,
  PosEvalLine,
  PosEvalLineResult,
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

/**
 * Build a BUY_X_GET_Y promotion that targets product `prod-1`
 * (the default line's productId). Caller supplies the deal shape
 * (buy/get/getDiscountPercent). `getDiscountPercent` is allowed to
 * be 100 — the entity currently caps it at 99, but the engine gate
 * and pass only need the persisted shape; the WU5 tests own the
 * 100-cap inversion.
 */
function makeBuyXGetYPromotion(
  overrides: PromoOverrides & {
    buyQuantity?: number;
    getQuantity?: number;
    getDiscountPercent?: number;
  } = {},
): Promotion {
  const {
    buyQuantity = 2,
    getQuantity = 1,
    getDiscountPercent = 50,
    ...rest
  } = overrides;
  return makePromotion({
    type: 'BUY_X_GET_Y',
    appliesTo: 'PRODUCTS',
    discountType: null,
    discountValue: null,
    buyQuantity,
    getQuantity,
    getDiscountPercent,
    // BUY_X_GET_Y entity rejects discountType/discountValue — clear them
    // explicitly so the helper that builds via `fromPersistence` is safe.
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
// Tests
// ============================================================

describe('PosEvaluatePromotionsUseCase — BUY_X_GET_Y gate (WU3, spec.md:60-96)', () => {
  it('admits a BXGY promotion with appliesTo=PRODUCTS into the per-line candidate set', async () => {
    // spec.md:60-96 — the gate must let BXGY through; the engine
    // admits it as an eligible candidate on a matching line.
    const bxgy = makeBuyXGetYPromotion({
      id: 'promo-bxgy-1',
      title: '2x1 @ 50%',
    });
    const repo = makeRepository([bxgy]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        // qty 3 → one full N+M group → R = 1 * round(1000*50/100) = 500c.
        lines: [makeLine({ quantity: 3 })],
      }),
    );

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].promotionId).toBe('promo-bxgy-1');
  });

  it('admits a BXGY promotion with appliesTo=VARIANTS into the per-line candidate set', async () => {
    const bxgy = makeBuyXGetYPromotion({
      id: 'promo-bxgy-var',
      appliesTo: 'VARIANTS',
      targetItems: [
        {
          id: 't-v1',
          side: 'DEFAULT',
          targetType: 'VARIANTS',
          targetId: 'var-1',
        },
      ],
    });
    const repo = makeRepository([bxgy]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({ variantId: 'var-1', quantity: 3 }),
        ],
      }),
    );

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].promotionId).toBe('promo-bxgy-var');
  });

  it('admits a BXGY promotion with appliesTo=CATEGORIES into the per-line candidate set', async () => {
    const bxgy = makeBuyXGetYPromotion({
      id: 'promo-bxgy-cat',
      appliesTo: 'CATEGORIES',
      targetItems: [
        {
          id: 't-c1',
          side: 'DEFAULT',
          targetType: 'CATEGORIES',
          targetId: 'cat-1',
        },
      ],
    });
    const repo = makeRepository([bxgy]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [makeLine({ quantity: 3, categoryId: 'cat-1' })],
      }),
    );

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].promotionId).toBe('promo-bxgy-cat');
  });

  it('admits a BXGY promotion with appliesTo=BRANDS into the per-line candidate set', async () => {
    const bxgy = makeBuyXGetYPromotion({
      id: 'promo-bxgy-brand',
      appliesTo: 'BRANDS',
      targetItems: [
        {
          id: 't-b1',
          side: 'DEFAULT',
          targetType: 'BRANDS',
          targetId: 'brand-1',
        },
      ],
    });
    const repo = makeRepository([bxgy]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [makeLine({ quantity: 3, brandId: 'brand-1' })],
      }),
    );

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].promotionId).toBe('promo-bxgy-brand');
  });
});

describe('PosEvaluatePromotionsUseCase — BUY_X_GET_Y counting (WU3, spec.md:60-91)', () => {
  it('one full N+M group: qty 3, 1000c/unit, buy 2 get 1 @ 50% → R=500c (line discount)', async () => {
    // spec.md:74-78 — the engine emits a per-line result whose
    // `lineDiscountCents = 1 * round(1000*50/100) = 500c`.
    const bxgy = makeBuyXGetYPromotion({
      id: 'promo-bxgy-1',
      buyQuantity: 2,
      getQuantity: 1,
      getDiscountPercent: 50,
    });
    const repo = makeRepository([bxgy]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [makeLine({ quantity: 3 })],
      }),
    );

    expect(result.lines).toHaveLength(1);
    const line = result.lines[0];
    // Discriminated union — BXGY kind carries lineDiscountCents.
    expect(line.kind).toBe('buy-x-get-y');
    if (line.kind === 'buy-x-get-y') {
      expect(line.lineDiscountCents).toBe(500);
      expect(line.perUnitRewardCents).toBe(500);
      expect(line.discountedUnitCount).toBe(1);
      // WU1 — the exact promo percent is carried through the port result.
      expect(line.getDiscountPercent).toBe(50);
    }
  });

  it('multiple groups: qty 6, 1000c/unit, buy 2 get 1 @ 50% → R=1000c', async () => {
    // spec.md:79-83 — floor(6/3)=2 groups × 1 get-unit × 500c.
    const bxgy = makeBuyXGetYPromotion({
      id: 'promo-bxgy-1',
      buyQuantity: 2,
      getQuantity: 1,
      getDiscountPercent: 50,
    });
    const repo = makeRepository([bxgy]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [makeLine({ quantity: 6 })],
      }),
    );

    expect(result.lines).toHaveLength(1);
    const line = result.lines[0];
    if (line.kind === 'buy-x-get-y') {
      expect(line.lineDiscountCents).toBe(1000);
      expect(line.discountedUnitCount).toBe(2);
    } else {
      fail('expected buy-x-get-y kind');
    }
  });

  it('line below buyQuantity is NOT eligible (qty 1 < N=2 → no reward, no result)', async () => {
    // spec.md:64-67 — the engine does NOT emit a per-line result when
    // qty < buyQuantity (silent skip, no exception).
    const bxgy = makeBuyXGetYPromotion({
      id: 'promo-bxgy-1',
      buyQuantity: 2,
      getQuantity: 1,
      getDiscountPercent: 50,
    });
    const repo = makeRepository([bxgy]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [makeLine({ quantity: 1 })],
      }),
    );

    expect(result.lines).toEqual([]);
  });

  it('line at buyQuantity but below N+M yields zero reward (qty 2 < 3 → no result)', async () => {
    // spec.md:69-72 — qty 2, 2+1 deal → floor(2/3)=0 → no result emitted.
    const bxgy = makeBuyXGetYPromotion({
      id: 'promo-bxgy-1',
      buyQuantity: 2,
      getQuantity: 1,
      getDiscountPercent: 50,
    });
    const repo = makeRepository([bxgy]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [makeLine({ quantity: 2 })],
      }),
    );

    expect(result.lines).toEqual([]);
  });

  it('non-matching line yields zero reward (P2 line vs P1-targeted BXGY)', async () => {
    // spec.md:93-96 — a line whose productId is not in the BXGY
    // targetItems MUST NOT receive a reward.
    const bxgy = makeBuyXGetYPromotion({
      id: 'promo-bxgy-P1',
      targetItems: [
        {
          id: 't-p1',
          side: 'DEFAULT',
          targetType: 'PRODUCTS',
          targetId: 'prod-1',
        },
      ],
    });
    const repo = makeRepository([bxgy]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({ itemId: 'item-P1', productId: 'prod-1', quantity: 3 }),
          makeLine({ itemId: 'item-P2', productId: 'prod-2', quantity: 3 }),
        ],
      }),
    );

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].itemId).toBe('item-P1');
  });

  it('per-unit Math.round rounding: qty 2, 100c/unit, buy 1 get 1 @ 33% → perUnit=33c', async () => {
    // spec.md:88-91 — engine convention: Math.round((base*percent)/100).
    // (100*33)/100 = 33 exactly.
    const bxgy = makeBuyXGetYPromotion({
      id: 'promo-bxgy-rounding',
      buyQuantity: 1,
      getQuantity: 1,
      getDiscountPercent: 33,
    });
    const repo = makeRepository([bxgy]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({ effectiveUnitPriceCents: 100, quantity: 2 }),
        ],
      }),
    );

    expect(result.lines).toHaveLength(1);
    const line = result.lines[0];
    if (line.kind === 'buy-x-get-y') {
      expect(line.perUnitRewardCents).toBe(33);
      expect(line.lineDiscountCents).toBe(33);
      // WU1 — exact promo percent carried through (not derived).
      expect(line.getDiscountPercent).toBe(33);
    } else {
      fail('expected buy-x-get-y kind');
    }
  });
});

describe('PosEvaluatePromotionsUseCase — BUY_X_GET_Y short-circuits (WU3, spec.md:60-96)', () => {
  it('AUTO BXGY skips a line with hasManualDiscount=true (mirrors use-case.ts:419)', async () => {
    // design.md Decision 3 — AUTOMATIC BXGY MUST replicate the
    // `if (line.hasManualDiscount) return null` short-circuit so an
    // AUTO BXGY skips a line carrying a seller free-form discount.
    const bxgy = makeBuyXGetYPromotion({ id: 'promo-bxgy-1' });
    const repo = makeRepository([bxgy]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({
            itemId: 'item-manual',
            hasManualDiscount: true,
            quantity: 3,
          }),
        ],
      }),
    );

    expect(result.lines).toEqual([]);
  });
});

describe('PosEvaluatePromotionsUseCase — BUY_X_GET_Y cross-type best-wins (WU3, spec.md:21-37)', () => {
  it('BXGY beats a smaller per-line PD on the same line (BXGY 1000c > PD total 600c)', async () => {
    // spec.md:24-27 — case where BXGY total saving > PD total saving
    // (PD: FIXED 100c/unit × qty 6 = 600c; BXGY: floor(6/3)*1*500 = 1000c).
    const pd = makePromotion({
      id: 'promo-P-A',
      discountType: 'FIXED',
      discountValue: 100, // FIXED 100c/unit, on qty 6 → 600c total
    });
    const bxgy = makeBuyXGetYPromotion({
      id: 'promo-P-B',
      buyQuantity: 2,
      getQuantity: 1,
      getDiscountPercent: 50, // 1 get-unit × 500c × 2 groups = 1000c total
    });
    const repo = makeRepository([pd, bxgy]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [makeLine({ quantity: 6 })],
      }),
    );

    // BXGY wins — its total (1000c) > PD total (600c).
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].kind).toBe('buy-x-get-y');
    expect(result.lines[0].promotionId).toBe('promo-P-B');
  });

  it('PD wins when PD total saving > BXGY total saving (PD 1500c > BXGY 500c)', async () => {
    // spec.md:29-32 case A — PD FIXED 500c/unit × qty 3 = 1500c,
    // BXGY: floor(3/3)*1*500 = 500c. PD wins.
    const pd = makePromotion({
      id: 'promo-P-A',
      discountType: 'FIXED',
      discountValue: 500, // 500c/unit × 3 = 1500c total
    });
    const bxgy = makeBuyXGetYPromotion({
      id: 'promo-P-B',
      buyQuantity: 2,
      getQuantity: 1,
      getDiscountPercent: 50, // 1 group × 1 unit × 500c = 500c total
    });
    const repo = makeRepository([pd, bxgy]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [makeLine({ quantity: 3 })],
      }),
    );

    // PD wins by total saving (1500c > 500c).
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].promotionId).toBe('promo-P-A');
    // Per-unit kind carries the existing shape.
    expect(result.lines[0].kind ?? 'per-unit').toBe('per-unit');
  });

  it('genuine cross-type TIE resolves to lowest promotionId (BXGY wins when id < PD id)', async () => {
    // spec.md:29-32 case B — PD FIXED 100c/unit × qty 6 = 600c total,
    // BXGY: floor(6/3)*1*round(1000*30/100) = 300c × 2 = 600c.
    // Total saving is exactly 600c == 600c → tie → lowest id wins.
    //
    // IDs chosen so the BXGY id is lexicographically LOWER than the
    // PD id: `promo-A-bxgy` < `promo-Z-pd` (A < Z at the discriminator
    // position). BXGY must win the tiebreak.
    const pd = makePromotion({
      id: 'promo-Z-pd',
      discountType: 'FIXED',
      discountValue: 100,
    });
    const bxgy = makeBuyXGetYPromotion({
      id: 'promo-A-bxgy',
      buyQuantity: 2,
      getQuantity: 1,
      getDiscountPercent: 30,
    });
    const repo = makeRepository([pd, bxgy]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [makeLine({ quantity: 6 })],
      }),
    );

    // Tie (600c == 600c), A-bxgy < Z-pd → BXGY wins on lowest id.
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].promotionId).toBe('promo-A-bxgy');
    expect(result.lines[0].kind).toBe('buy-x-get-y');
  });

  it('genuine cross-type TIE with PD id < BXGY id → PD wins (lowest-id tiebreak)', async () => {
    // Same totals as above (600c == 600c), but flip the ids so PD
    // has the lower id. Tie → lowest id wins → PD keeps the line.
    const pd = makePromotion({
      id: 'promo-A-pd',
      discountType: 'FIXED',
      discountValue: 100,
    });
    const bxgy = makeBuyXGetYPromotion({
      id: 'promo-Z-bxgy',
      buyQuantity: 2,
      getQuantity: 1,
      getDiscountPercent: 30,
    });
    const repo = makeRepository([pd, bxgy]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [makeLine({ quantity: 6 })],
      }),
    );

    // Tie → lowest id (promo-A-pd) wins.
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].promotionId).toBe('promo-A-pd');
    expect(result.lines[0].kind ?? 'per-unit').toBe('per-unit');
  });
});

describe('PosEvaluatePromotionsUseCase — BUY_X_GET_Y pass order (WU3, spec.md:34-37)', () => {
  it('the post-line subtotal fed to ORDER_DISCOUNT reflects the BXGY saving', async () => {
    // spec.md:34-37 — L1 (qty 3 @ 1000c/unit) with BXGY saving 300c
    // (i.e. buy 2 get 1 @ 30%, floor(3/3)*1*round(1000*30/100)=300c)
    // and L2 (qty 1 @ 1000c/unit) with PD saving 100c, plus an
    // ORDER_DISCOUNT 10% PERCENTAGE with minPurchaseAmountCents=0.
    //
    // postLineSubtotal = (3000 - 300) + (1000 - 100) = 3600c
    // ORDER_DISCOUNT saving = round(3600 * 10 / 100) = 360c.
    const bxgy = makeBuyXGetYPromotion({
      id: 'promo-bxgy-1',
      buyQuantity: 2,
      getQuantity: 1,
      getDiscountPercent: 30, // 1 get-unit × 300c = 300c line saving
    });
    const pd = makePromotion({
      id: 'promo-pd-L2',
      title: 'L2 PD',
      discountType: 'FIXED',
      discountValue: 100,
      targetItems: [
        {
          id: 't-P2',
          side: 'DEFAULT',
          targetType: 'PRODUCTS',
          targetId: 'prod-2',
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
    const repo = makeRepository([bxgy, pd, order]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({ itemId: 'L1', productId: 'prod-1', quantity: 3 }),
          makeLine({ itemId: 'L2', productId: 'prod-2', quantity: 1 }),
        ],
      }),
    );

    // Both per-line winners present (no cross-stacking — they target
    // different lines).
    expect(result.lines).toHaveLength(2);

    // The ORDER_DISCOUNT computes its saving AGAINST the post-line
    // subtotal that ALREADY reflects the BXGY line saving.
    // postLineSubtotal = (3000 - 300) + (1000 - 100) = 3600c
    // saving = round(3600 * 10 / 100) = 360c
    expect(result.order).not.toBeNull();
    expect(result.order!.promotionId).toBe('promo-order-10pct');
    expect(result.order!.discountAmountCents).toBe(360);
  });
});

/**
 * WU6 — BUY_X_GET_Y MANUAL wiring (spec.md:108-130, design.md Decision 7).
 *
 *   - MANUAL BXGY appears in `availableManualPromotions` when ANY line
 *     in the cart matches the BXGY target — the candidate mapper MUST
 *     emit `type: 'BUY_X_GET_Y'` on the wire (port union + response DTO
 *     extension).
 *   - MANUAL BXGY appears in `targetableManualPromotionIds` for a
 *     specific line that matches — same matchTargetTier predicate as
 *     the per-line gate.
 *   - Opted-in MANUAL BXGY is considered in best-wins: when the line
 *     matches and qty >= buyQuantity, the engine emits the same
 *     `kind: 'buy-x-get-y'` line result it does for AUTOMATIC BXGY.
 *     The sales.service.spec.ts covers the two-recompute survival
 *     contract; the engine only needs to emit a winner on opt-in.
 */
describe('PosEvaluatePromotionsUseCase — BUY_X_GET_Y MANUAL wiring (WU6, spec.md:108-130)', () => {
  it('MANUAL BXGY with a matching line appears in availableManualPromotions with type BUY_X_GET_Y', async () => {
    // spec.md:117-120 — a draft with one P1 line (qty 3) and one
    // MANUAL BXGY (target P1) — without opt-in the promo is in
    // availableManualPromotions (NOT in the applied list).
    //
    // WUB — candidate carries eligibility data: buy2get1 with matching
    // qty=3 → groupSize=3 → eligible:true, unitsNeeded=0. The frontend
    // uses these to render an honest hint ("2x1 · requiere 2 unidades")
    // and to block a no-op apply.
    const bxgy = makeBuyXGetYPromotion({
      id: 'promo-bxgy-manual-1',
      method: 'MANUAL',
      title: 'Manual 2x1 @ 50%',
    });
    const repo = makeRepository([bxgy]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        // Not opted-in — qty 3 → 1 group, but MANUAL is gated on opt-in.
        lines: [makeLine({ quantity: 3 })],
      }),
    );

    // NOT applied (MANUAL + not opted-in).
    expect(result.lines).toEqual([]);

    // Surfaced as a candidate with the new BUY_X_GET_Y wire type AND
    // additive eligibility payload (WUB).
    expect(result.availableManualPromotions).toHaveLength(1);
    expect(result.availableManualPromotions[0]).toEqual({
      id: 'promo-bxgy-manual-1',
      title: 'Manual 2x1 @ 50%',
      type: 'BUY_X_GET_Y',
      method: 'MANUAL',
      eligible: true,
      buyQuantity: 2,
      getQuantity: 1,
      unitsNeeded: 0,
  });
});

/**
 * WUB — Eligibility data on `availableManualPromotions[]` (frontend follow-up).
 *
 * Contract (additive, see design.md Decision 7 follow-up):
 *   - ORDER_DISCOUNT / PRODUCT_DISCOUNT: `eligible=true`,
 *     `buyQuantity=null`, `getQuantity=null`, `unitsNeeded=0` — always
 *     give something when surfaced.
 *   - BUY_X_GET_Y: keep surfacing the candidate whenever at least one
 *     line matches the target — `buyQuantity` and `getQuantity` are the
 *     promotion's values; `eligible` and `unitsNeeded` are derived from
 *     the max matching `line.quantity` against `groupSize =
 *     buyQuantity + getQuantity`:
 *       eligible     = maxMatchQty >= groupSize
 *       unitsNeeded  = eligible ? 0 : (groupSize - maxMatchQty)  // >= 1
 *
 * The buy/get fields let the frontend render an honest hint
 * ("2x1 · requiere 2 unidades") and block a no-op apply.
 */
describe('PosEvaluatePromotionsUseCase — MANUAL candidate eligibility data (WUB)', () => {
  it('BXGY buy2get1 with matching line qty=1 → eligible=false, unitsNeeded=2', async () => {
    // qty=1 < groupSize=3 → not eligible. unitsNeeded = 3 - 1 = 2.
    const bxgy = makeBuyXGetYPromotion({
      id: 'promo-bxgy-e1',
      method: 'MANUAL',
      title: '2x1',
      buyQuantity: 2,
      getQuantity: 1,
    });
    const repo = makeRepository([bxgy]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({ lines: [makeLine({ quantity: 1 })] }),
    );

    expect(result.availableManualPromotions).toHaveLength(1);
    expect(result.availableManualPromotions[0]).toEqual({
      id: 'promo-bxgy-e1',
      title: '2x1',
      type: 'BUY_X_GET_Y',
      method: 'MANUAL',
      eligible: false,
      buyQuantity: 2,
      getQuantity: 1,
      unitsNeeded: 2,
    });
  });

  it('BXGY buy2get1 with matching line qty=2 → eligible=false, unitsNeeded=1', async () => {
    // qty=2 < groupSize=3 → still not eligible. unitsNeeded = 3 - 2 = 1.
    const bxgy = makeBuyXGetYPromotion({
      id: 'promo-bxgy-e2',
      method: 'MANUAL',
      title: '2x1',
      buyQuantity: 2,
      getQuantity: 1,
    });
    const repo = makeRepository([bxgy]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({ lines: [makeLine({ quantity: 2 })] }),
    );

    expect(result.availableManualPromotions).toHaveLength(1);
    expect(result.availableManualPromotions[0]).toEqual({
      id: 'promo-bxgy-e2',
      title: '2x1',
      type: 'BUY_X_GET_Y',
      method: 'MANUAL',
      eligible: false,
      buyQuantity: 2,
      getQuantity: 1,
      unitsNeeded: 1,
    });
  });

  it('BXGY buy2get1 with matching line qty=3 → eligible=true, unitsNeeded=0', async () => {
    // qty=3 >= groupSize=3 → exactly enough for one full group → eligible.
    // unitsNeeded = 0.
    const bxgy = makeBuyXGetYPromotion({
      id: 'promo-bxgy-e3',
      method: 'MANUAL',
      title: '2x1',
      buyQuantity: 2,
      getQuantity: 1,
    });
    const repo = makeRepository([bxgy]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({ lines: [makeLine({ quantity: 3 })] }),
    );

    expect(result.availableManualPromotions).toHaveLength(1);
    expect(result.availableManualPromotions[0]).toEqual({
      id: 'promo-bxgy-e3',
      title: '2x1',
      type: 'BUY_X_GET_Y',
      method: 'MANUAL',
      eligible: true,
      buyQuantity: 2,
      getQuantity: 1,
      unitsNeeded: 0,
    });
  });

  it('PRODUCT_DISCOUNT candidate carries eligible=true / buy=null / get=null / unitsNeeded=0', async () => {
    // ORDER_DISCOUNT and PRODUCT_DISCOUNT candidates always give
    // something when surfaced, so eligible=true and the buy/get fields
    // are null (they don't apply to non-BXGY types).
    const pd = makePromotion({
      id: 'promo-pd-m',
      method: 'MANUAL',
      type: 'PRODUCT_DISCOUNT',
      title: '10% off',
      discountType: 'PERCENTAGE',
      discountValue: 10,
    });
    const repo = makeRepository([pd]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({ lines: [makeLine({ quantity: 1 })] }),
    );

    expect(result.availableManualPromotions).toHaveLength(1);
    expect(result.availableManualPromotions[0]).toEqual({
      id: 'promo-pd-m',
      title: '10% off',
      type: 'PRODUCT_DISCOUNT',
      method: 'MANUAL',
      eligible: true,
      buyQuantity: null,
      getQuantity: null,
      unitsNeeded: 0,
    });
  });
});


  it('MANUAL BXGY with a matching line + opt-in → applied AND retained in targetableManualPromotionIds', async () => {
    // spec.md:122-125 — opted-in MANUAL BXGY emits the same BXGY line
    // result AND remains in targetableManualPromotionIds (self-heal
    // keeps the opt-in across recomputes when the target is in the cart).
    const bxgy = makeBuyXGetYPromotion({
      id: 'promo-bxgy-manual-1',
      method: 'MANUAL',
      title: 'Manual 2x1 @ 50%',
    });
    const repo = makeRepository([bxgy]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        optedInManualPromotionIds: ['promo-bxgy-manual-1'],
        lines: [makeLine({ quantity: 3 })],
      }),
    );

    // Applied as the BXGY line result.
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].promotionId).toBe('promo-bxgy-manual-1');
    expect(result.lines[0].kind).toBe('buy-x-get-y');

    // Self-heal: still in targetableManualPromotionIds (target present).
    expect(result.targetableManualPromotionIds).toContain('promo-bxgy-manual-1');
  });

  it('opted-in MANUAL BXGY with NO matching line drops out of targetableManualPromotionIds (target gone)', async () => {
    // Self-heal retention rule: when the target is REMOVED from the
    // cart, the opted-in MANUAL BXGY MUST NOT appear in
    // targetableManualPromotionIds — that's the resurrection-bug fix
    // (the WU4 self-heal prunes opt-ins whose target is gone).
    const bxgy = makeBuyXGetYPromotion({
      id: 'promo-bxgy-manual-1',
      method: 'MANUAL',
      title: 'Manual 2x1 @ 50%',
      targetItems: [
        {
          id: 't-P1',
          side: 'DEFAULT',
          targetType: 'PRODUCTS',
          targetId: 'prod-1',
        },
      ],
    });
    const repo = makeRepository([bxgy]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        optedInManualPromotionIds: ['promo-bxgy-manual-1'],
        // No lines — target is gone.
        lines: [],
      }),
    );

    expect(result.lines).toEqual([]);
    expect(result.targetableManualPromotionIds).not.toContain(
      'promo-bxgy-manual-1',
    );
  });

  it('MANUAL BXGY with NO matching line stays out of availableManualPromotions (target not in cart)', async () => {
    // spec.md:117-120 — "when ANY line matches". A MANUAL BXGY whose
    // target is NOT in the draft should NOT be surfaced (no line to
    // apply it to). Same matcher used by the per-line gate.
    const bxgy = makeBuyXGetYPromotion({
      id: 'promo-bxgy-manual-P1',
      method: 'MANUAL',
      title: 'Manual 2x1 on P1',
      targetItems: [
        {
          id: 't-P1',
          side: 'DEFAULT',
          targetType: 'PRODUCTS',
          targetId: 'prod-1',
        },
      ],
    });
    const repo = makeRepository([bxgy]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        // Draft has P2 only — the BXGY is targeted at P1.
        lines: [makeLine({ productId: 'prod-2', quantity: 3 })],
      }),
    );

    expect(result.availableManualPromotions).toEqual([]);
  });
});
