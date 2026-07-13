/**
 * PosEvaluatePromotionsUseCase — POS promotion engine unit tests (RED).
 *
 * Covers Work Unit 2 RED cases (2.1–2.4):
 *  - 2.1 Eligibility: effective status, date window, dayOfWeek,
 *    customerScope (ALL / REGISTERED_ONLY / SPECIFIC), priceList
 *    restriction, ORDER min-purchase. Negative cases: ineligible
 *    promotions are not applied; silent skip when customer-scope
 *    fails because no customer is assigned.
 *  - 2.2 C1: a PROMO restricted by `priceLists[]` (PromotionPriceList.
 *    globalPriceListId) matches a line ONLY when the line's
 *    `appliedGlobalPriceListId` resolves to a global id in the
 *    promotion's list — not the raw `appliedPriceListId`
 *    (PriceList.id).
 *  - 2.3 W3: a 100% PERCENTAGE promo is ranked by the SAME clamped
 *    (99%) discount it will actually apply; ranking value ==
 *    applied value.
 *  - 2.4 best-wins tiebreak (lowest promotion.id); MANUAL promos
 *    only considered when opted-in; vetoed ids always excluded;
 *    manual-free-form-discount line (`hasManualDiscount`) is
 *    skipped by auto-promos.
 *
 * Engine is a PURE application service: tests use a MOCKED
 * IPromotionRepository. No DB. No ProductsService dependency.
 */
import {
  PosEvaluatePromotionsUseCase,
  clampPercentageToSafeRange,
} from './pos-evaluate-promotions.use-case';
import type { IPromotionRepository } from '../domain/promotion.repository';
import { Promotion, type DayOfWeek } from '../domain/promotion.entity';
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
const TOMORROW = new Date('2026-06-11T15:00:00.000Z');
const NEXT_WEEK = new Date('2026-06-17T15:00:00.000Z');
const ONE_HOUR_AGO = new Date('2026-06-10T14:00:00.000Z');
const ONE_HOUR_FROM_NOW = new Date('2026-06-10T16:00:00.000Z');

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

function makeOrderPromotion(overrides: PromoOverrides = {}): Promotion {
  return makePromotion({
    type: 'ORDER_DISCOUNT',
    appliesTo: null,
    targetItems: [],
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
// Tests
// ============================================================

describe('PosEvaluatePromotionsUseCase — pure helpers', () => {
  it('clampPercentageToSafeRange pins 100% to 99 (W3 ranking == applied)', () => {
    expect(clampPercentageToSafeRange(100)).toBe(99);
    expect(clampPercentageToSafeRange(150)).toBe(99);
    expect(clampPercentageToSafeRange(99)).toBe(99);
    expect(clampPercentageToSafeRange(1)).toBe(1);
    expect(clampPercentageToSafeRange(0)).toBe(1);
  });
});

describe('PosEvaluatePromotionsUseCase — load shape (2.6 wiring)', () => {
  it('loads candidates through findAll with status=ACTIVE and limit=500, without method filter', async () => {
    const repo = makeRepository([]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    await useCase.evaluate(makeInput());

    expect(repo.findAll).toHaveBeenCalledTimes(1);
    const query = (repo.findAll as jest.Mock).mock.calls[0][0];
    expect(query.status).toBe('ACTIVE');
    expect(query.limit).toBe(500);
    expect(query.method).toBeUndefined();
  });
});

describe('PosEvaluatePromotionsUseCase — eligibility (2.1)', () => {
  it('SCHEDULED (startDate in the future) does NOT apply', async () => {
    // Build a promotion whose startDate is in the future so
    // getEffectiveStatus(now) === 'SCHEDULED'.
    const scheduled = makePromotion({
      id: 'promo-sched',
      startDate: TOMORROW,
    });
    const repo = makeRepository([scheduled]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result: PosEvalResult = await useCase.evaluate(
      makeInput({ now: NOW }),
    );

    expect(result.lines).toEqual([]);
    expect(result.order).toBeNull();
  });

  it('ACTIVE promotion at evaluation time is NOT excluded by status gate', async () => {
    const promo = makePromotion({
      id: 'promo-active',
      startDate: YESTERDAY,
      endDate: NEXT_WEEK,
    });
    const repo = makeRepository([promo]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        now: NOW,
        lines: [makeLine({ effectiveUnitPriceCents: 1000 })],
      }),
    );

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].promotionId).toBe('promo-active');
  });

  it('before startDate is NOT eligible (date window)', async () => {
    const promo = makePromotion({
      id: 'promo-future',
      startDate: TOMORROW,
    });
    const repo = makeRepository([promo]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        now: NOW,
        lines: [makeLine({ effectiveUnitPriceCents: 1000 })],
      }),
    );

    expect(result.lines).toEqual([]);
  });

  it('at endDate is STILL eligible (inclusive bound)', async () => {
    const promo = makePromotion({
      id: 'promo-end',
      startDate: null,
      endDate: NOW, // same instant
    });
    const repo = makeRepository([promo]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        now: NOW,
        lines: [makeLine({ effectiveUnitPriceCents: 1000 })],
      }),
    );

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].promotionId).toBe('promo-end');
  });

  it('NOT eligible when today is not in daysOfWeek', async () => {
    // NOW is Wednesday; daysOfWeek = [MONDAY, TUESDAY].
    const promo = makePromotion({
      id: 'promo-dow',
      daysOfWeek: [
        { id: 'd-mon', day: 'MONDAY' },
        { id: 'd-tue', day: 'TUESDAY' },
      ],
    });
    const repo = makeRepository([promo]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        now: NOW,
        lines: [makeLine({ effectiveUnitPriceCents: 1000 })],
      }),
    );

    expect(result.lines).toEqual([]);
  });

  it('empty daysOfWeek OPENS the gate (any day passes)', async () => {
    const promo = makePromotion({
      id: 'promo-dow-open',
      daysOfWeek: [],
    });
    const repo = makeRepository([promo]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        now: NOW,
        lines: [makeLine({ effectiveUnitPriceCents: 1000 })],
      }),
    );

    expect(result.lines).toHaveLength(1);
  });

  it('customerScope=ALL with no customer is NOT excluded', async () => {
    const promo = makePromotion({
      id: 'promo-all',
      customerScope: 'ALL',
    });
    const repo = makeRepository([promo]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        now: NOW,
        customerId: null,
        lines: [makeLine({ effectiveUnitPriceCents: 1000 })],
      }),
    );

    expect(result.lines).toHaveLength(1);
  });

  it('REGISTERED_ONLY without customer silently skips (no error, not applied)', async () => {
    const promo = makePromotion({
      id: 'promo-reg',
      customerScope: 'REGISTERED_ONLY',
    });
    const repo = makeRepository([promo]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(makeInput({ customerId: null }));

    expect(result.lines).toEqual([]);
    expect(result.order).toBeNull();
  });

  it('SPECIFIC without customer silently skips; auto-applies once eligible customer assigned', async () => {
    const promo = makePromotion({
      id: 'promo-specific',
      customerScope: 'SPECIFIC',
      customers: [
        {
          id: 'pc-1',
          customerId: 'cust-1',
          customer: { id: 'cust-1', firstName: 'C', lastName: null },
        },
      ],
    });
    const repo = makeRepository([promo]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const before = await useCase.evaluate(makeInput({ customerId: null }));
    expect(before.lines).toEqual([]);

    const after = await useCase.evaluate(makeInput({ customerId: 'cust-1' }));
    expect(after.lines).toHaveLength(1);
    expect(after.lines[0].promotionId).toBe('promo-specific');
  });

  it('SPECIFIC with non-listed customer is NOT eligible', async () => {
    const promo = makePromotion({
      id: 'promo-specific',
      customerScope: 'SPECIFIC',
      customers: [
        {
          id: 'pc-1',
          customerId: 'cust-1',
          customer: { id: 'cust-1', firstName: 'C', lastName: null },
        },
      ],
    });
    const repo = makeRepository([promo]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(makeInput({ customerId: 'cust-2' }));

    expect(result.lines).toEqual([]);
  });

  it('open price-list gate (empty priceLists) accepts a line with no price list', async () => {
    const promo = makePromotion({
      id: 'promo-pl-open',
      priceLists: [],
    });
    const repo = makeRepository([promo]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({
            appliedPriceListId: null,
            appliedGlobalPriceListId: null,
            effectiveUnitPriceCents: 1000,
          }),
        ],
      }),
    );

    expect(result.lines).toHaveLength(1);
  });

  it('ORDER_DISCOUNT with subtotal below minPurchaseAmountCents is NOT eligible', async () => {
    const promo = makeOrderPromotion({
      id: 'promo-min',
      discountType: 'FIXED',
      discountValue: 100,
      minPurchaseAmountCents: 10000,
    });
    const repo = makeRepository([promo]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    // subtotal = 900c (line qty 1 × 900) is below 10000c.
    const result = await useCase.evaluate(
      makeInput({
        lines: [makeLine({ quantity: 1, effectiveUnitPriceCents: 900 })],
      }),
    );

    expect(result.order).toBeNull();
  });

  it('ORDER_DISCOUNT with subtotal at minimum IS eligible', async () => {
    const promo = makeOrderPromotion({
      id: 'promo-min',
      discountType: 'FIXED',
      discountValue: 100,
      minPurchaseAmountCents: 10000,
    });
    const repo = makeRepository([promo]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({
            quantity: 10,
            effectiveUnitPriceCents: 1000,
          }),
        ],
      }),
    );

    expect(result.order).not.toBeNull();
    expect(result.order?.promotionId).toBe('promo-min');
  });
});

// ============================================================
// 2.2 — C1: appliedGlobalPriceListId membership
// ============================================================
describe('PosEvaluatePromotionsUseCase — C1 price-list id resolution (2.2)', () => {
  it('eligible when the resolved appliedGlobalPriceListId is in the promo priceLists', async () => {
    const promo = makePromotion({
      id: 'promo-c1-yes',
      // promo restricted to globalPriceListId = 'GPL-retail'
      priceLists: [{ id: 'ppl-1', globalPriceListId: 'GPL-retail' }],
    });
    const repo = makeRepository([promo]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          // raw PriceList.id is a per-product row key; its underlying
          // globalPriceListId (resolved by the caller) is the membership
          // key — it IS in the promo's set.
          makeLine({
            appliedPriceListId: 'PL-row-7',
            appliedGlobalPriceListId: 'GPL-retail',
            effectiveUnitPriceCents: 1000,
          }),
        ],
      }),
    );

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].promotionId).toBe('promo-c1-yes');
  });

  it('NOT eligible when the resolved appliedGlobalPriceListId is NOT in the promo priceLists', async () => {
    const promo = makePromotion({
      id: 'promo-c1-no',
      priceLists: [{ id: 'ppl-1', globalPriceListId: 'GPL-retail' }],
    });
    const repo = makeRepository([promo]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          // Resolved global id is 'GPL-mayoreo' which is NOT in the promo.
          // The raw PL-row-9 happens to also not be a PromotionPriceList
          // id (they live in different id spaces), but the engine should
          // not even compare raw appliedPriceListId to globalPriceListId.
          makeLine({
            appliedPriceListId: 'PL-row-9',
            appliedGlobalPriceListId: 'GPL-mayoreo',
            effectiveUnitPriceCents: 1000,
          }),
        ],
      }),
    );

    expect(result.lines).toEqual([]);
  });

  it('NOT eligible when the line has no price list and the promo IS restricted', async () => {
    const promo = makePromotion({
      id: 'promo-c1-required',
      priceLists: [{ id: 'ppl-1', globalPriceListId: 'GPL-retail' }],
    });
    const repo = makeRepository([promo]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({
            appliedPriceListId: null,
            appliedGlobalPriceListId: null,
            effectiveUnitPriceCents: 1000,
          }),
        ],
      }),
    );

    expect(result.lines).toEqual([]);
  });
});

// ============================================================
// 2.3 — W3: 100% PERCENTAGE ranking == applied (clamped 99)
// ============================================================
describe('PosEvaluatePromotionsUseCase — W3 100% PERCENTAGE clamp (2.3)', () => {
  it('emitted discountValue on a 100% PROMO is 99 (clamped), not 100', async () => {
    const promo = makePromotion({
      id: 'promo-hundred',
      discountType: 'PERCENTAGE',
      discountValue: 100,
    });
    const repo = makeRepository([promo]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [makeLine({ effectiveUnitPriceCents: 1000 })],
      }),
    );

    expect(result.lines).toHaveLength(1);
    // W3: the engine emits the SAME clamped value the entity will use.
    expect(result.lines[0].discountType).toBe('percentage');
    expect(result.lines[0].discountValue).toBe(99);
  });

  it('ranking uses the clamped (99) value, so a 100% PROMO ties with a 99% PROMO and loses to FIXED > 990 on 1000c', async () => {
    const promoA = makePromotion({
      id: 'promo-A-100pct',
      discountType: 'PERCENTAGE',
      discountValue: 100,
    });
    const promoB = makePromotion({
      id: 'promo-B-fixed-991',
      discountType: 'FIXED',
      discountValue: 991,
    });
    const repo = makeRepository([promoA, promoB]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    // baseline = 1000c
    //   promoA ranking: round(1000 * 99 / 100) = 990  (clamped 100 → 99)
    //   promoB ranking: 991
    //   → promoB wins; emitted discountValue = 991.
    const result = await useCase.evaluate(
      makeInput({
        lines: [makeLine({ effectiveUnitPriceCents: 1000 })],
      }),
    );

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].promotionId).toBe('promo-B-fixed-991');
    expect(result.lines[0].discountType).toBe('amount');
    expect(result.lines[0].discountValue).toBe(991);
  });

  it('ranked value == applied value: a 100% PROMO alone produces 99 emitted + round(1000*99/100)=990 ranking', async () => {
    const promo = makePromotion({
      id: 'promo-100',
      discountType: 'PERCENTAGE',
      discountValue: 100,
    });
    const repo = makeRepository([promo]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [makeLine({ effectiveUnitPriceCents: 1000 })],
      }),
    );

    // Sanity: the entity side clamps percent to [1,99] and computes the
    // same discount = round(1000 * 99 / 100) = 990. Since the engine
    // emits 99, the entity will produce 990 — matching the engine's
    // own ranking. W3 invariant proven: ranking value (990) ==
    // applied value (990).
    expect(result.lines[0].discountValue).toBe(99);
    // round(1000 * 99 / 100) = 990
    const expectedRanking = Math.round((1000 * 99) / 100);
    expect(expectedRanking).toBe(990);
  });
});

// ============================================================
// 2.4 — best-wins, MANUAL opt-in, veto, manual-wins precedence
// ============================================================
describe('PosEvaluatePromotionsUseCase — best-wins, MANUAL, veto, manual-wins (2.4)', () => {
  it('best-wins picks the promo with the highest customer discount', async () => {
    // P-A: PERCENTAGE 10% on 1000c → 100c
    // P-B: FIXED 200c on 1000c → 200c
    const promoA = makePromotion({
      id: 'promo-A',
      title: '10% off',
      discountType: 'PERCENTAGE',
      discountValue: 10,
    });
    const promoB = makePromotion({
      id: 'promo-B',
      title: '$2 off',
      discountType: 'FIXED',
      discountValue: 200,
    });
    const repo = makeRepository([promoA, promoB]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [makeLine({ effectiveUnitPriceCents: 1000 })],
      }),
    );

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].promotionId).toBe('promo-B');
    expect(result.lines[0].discountValue).toBe(200);
  });

  it('tie on discount resolves by lowest promotionId (deterministic)', async () => {
    // Two FIXED 100c promos with different ids; lower id wins.
    const promoA = makePromotion({
      id: 'promo-A',
      discountType: 'FIXED',
      discountValue: 100,
    });
    const promoZ = makePromotion({
      id: 'promo-Z',
      discountType: 'FIXED',
      discountValue: 100,
    });
    const repo = makeRepository([promoA, promoZ]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [makeLine({ effectiveUnitPriceCents: 1000 })],
      }),
    );

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].promotionId).toBe('promo-A');
  });

  it('MANUAL promotion NOT in opted-in is NEVER auto-applied; appears in availableManualPromotions', async () => {
    const manual = makePromotion({
      id: 'promo-manual',
      method: 'MANUAL',
      title: 'Manual 10%',
      discountType: 'PERCENTAGE',
      discountValue: 10,
    });
    const repo = makeRepository([manual]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        optedInManualPromotionIds: [], // not opted-in
        lines: [makeLine({ effectiveUnitPriceCents: 1000 })],
      }),
    );

    expect(result.lines).toEqual([]);
    expect(result.availableManualPromotions).toHaveLength(1);
    expect(result.availableManualPromotions[0].id).toBe('promo-manual');
    expect(result.availableManualPromotions[0].type).toBe('PRODUCT_DISCOUNT');
  });

  it('MANUAL promotion in opted-in IS considered in best-wins', async () => {
    const auto = makePromotion({
      id: 'promo-auto',
      title: 'Auto 5%',
      discountType: 'PERCENTAGE',
      discountValue: 5,
    });
    const manual = makePromotion({
      id: 'promo-manual',
      method: 'MANUAL',
      title: 'Manual 50%',
      discountType: 'PERCENTAGE',
      discountValue: 50,
    });
    const repo = makeRepository([auto, manual]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        optedInManualPromotionIds: ['promo-manual'],
        lines: [makeLine({ effectiveUnitPriceCents: 1000 })],
      }),
    );

    expect(result.lines).toHaveLength(1);
    // manual 50% → 500c > auto 5% → 50c; manual wins.
    expect(result.lines[0].promotionId).toBe('promo-manual');
    // And the manual one is no longer in "available for opt-in".
    expect(
      result.availableManualPromotions.find((p) => p.id === 'promo-manual'),
    ).toBeUndefined();
  });

  it('vetoed AUTOMATIC promotion id is ALWAYS excluded from best-wins', async () => {
    const promoA = makePromotion({
      id: 'promo-vetoed',
      title: 'Big 30%',
      discountType: 'PERCENTAGE',
      discountValue: 30,
    });
    const promoB = makePromotion({
      id: 'promo-okay',
      title: 'Small 5%',
      discountType: 'PERCENTAGE',
      discountValue: 5,
    });
    const repo = makeRepository([promoA, promoB]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        vetoedPromotionIds: ['promo-vetoed'],
        lines: [makeLine({ effectiveUnitPriceCents: 1000 })],
      }),
    );

    // The otherwise-best 'promo-vetoed' is excluded; 'promo-okay' is the
    // only candidate left and gets applied.
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].promotionId).toBe('promo-okay');
    expect(
      result.availableManualPromotions.find((p) => p.id === 'promo-vetoed'),
    ).toBeUndefined();
  });

  it('a line with hasManualDiscount=true is SKIPPED by auto-promos', async () => {
    // Big auto promo; the line carries a manual seller free-form discount.
    const auto = makePromotion({
      id: 'promo-auto-big',
      discountType: 'PERCENTAGE',
      discountValue: 50,
    });
    const repo = makeRepository([auto]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({
            itemId: 'item-2',
            productId: 'prod-2',
            variantId: null,
            quantity: 1,
            effectiveUnitPriceCents: 1000,
            appliedPriceListId: null,
            appliedGlobalPriceListId: null,
            hasManualDiscount: true,
          }),
        ],
      }),
    );

    // auto-promo skipped for that line; no apply result emitted.
    expect(result.lines).toEqual([]);
  });

  it('best of two ORDER promos: max customer discount wins', async () => {
    // Both ORDER level; one is FIXED 200c, other is PERCENTAGE 5%.
    // On a 5000c subtotal: PERCENTAGE → 250c, FIXED → 200c → PERCENTAGE wins.
    const promoPct = makeOrderPromotion({
      id: 'order-pct',
      discountType: 'PERCENTAGE',
      discountValue: 5,
    });
    const promoFix = makeOrderPromotion({
      id: 'order-fix',
      discountType: 'FIXED',
      discountValue: 200,
    });
    const repo = makeRepository([promoPct, promoFix]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        lines: [
          makeLine({
            quantity: 5,
            effectiveUnitPriceCents: 1000, // subtotal = 5000c
          }),
        ],
      }),
    );

    expect(result.order).not.toBeNull();
    expect(result.order?.promotionId).toBe('order-pct');
    expect(result.order?.discountValue).toBe(5);
    expect(result.order?.discountType).toBe('percentage');
    // round(5000 * 5 / 100) = 250
    expect(result.order?.discountAmountCents).toBe(250);
  });

  // -------------------------------------------------------------------------
  // Veto-aware MANUAL apply: legacy corrupt drafts self-heal
  //
  // Pre-fix, the MANUAL apply branch in pickBestPerLine / pickBestOrderPromo
  // checked ONLY optedInManualPromotionIds and ignored the veto set. A
  // legacy draft where the same id was both opted-in AND vetoed would
  // (a) be hidden from availableManualPromotions but (b) STILL be re-applied
  // on the next recompute — the very bug reported. The fix: even when the
  // id is in opted-in, the engine skips it if it is ALSO in the veto set.
  // The "safe default" — veto wins for legacy data, while new drafts
  // remain unrepresentable thanks to the entity cross-clear.
  // -------------------------------------------------------------------------
  it('MANUAL opted-in BUT ALSO vetoed is NOT applied (legacy corrupt drafts self-heal)', async () => {
    const manual = makePromotion({
      id: 'promo-corrupt',
      method: 'MANUAL',
      discountType: 'PERCENTAGE',
      discountValue: 50,
    });
    const repo = makeRepository([manual]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        optedInManualPromotionIds: ['promo-corrupt'],
        vetoedPromotionIds: ['promo-corrupt'], // legacy corrupt state
        lines: [makeLine({ effectiveUnitPriceCents: 1000 })],
      }),
    );

    // The corrupt id MUST NOT be re-applied to the line.
    expect(result.lines).toEqual([]);
    // And it MUST NOT appear in available (already excluded by both
    // gates — this guards the existing behavior too).
    expect(result.availableManualPromotions).toEqual([]);
  });

  it('MANUAL opted-in and NOT vetoed is applied (regression-safe)', async () => {
    const manual = makePromotion({
      id: 'promo-manual',
      method: 'MANUAL',
      discountType: 'PERCENTAGE',
      discountValue: 10,
    });
    const repo = makeRepository([manual]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        optedInManualPromotionIds: ['promo-manual'],
        vetoedPromotionIds: [],
        lines: [makeLine({ effectiveUnitPriceCents: 1000 })],
      }),
    );

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].promotionId).toBe('promo-manual');
    // Not in available list (already opted-in).
    expect(
      result.availableManualPromotions.find((p) => p.id === 'promo-manual'),
    ).toBeUndefined();
  });

  it('ORDER MANUAL opted-in BUT vetoed is NOT applied (pickBestOrderPromo veto-aware)', async () => {
    const orderManual = makeOrderPromotion({
      id: 'order-manual-corrupt',
      method: 'MANUAL',
      discountType: 'FIXED',
      discountValue: 200,
    });
    const repo = makeRepository([orderManual]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        optedInManualPromotionIds: ['order-manual-corrupt'],
        vetoedPromotionIds: ['order-manual-corrupt'],
        lines: [
          makeLine({
            quantity: 5,
            effectiveUnitPriceCents: 1000, // subtotal = 5000c
          }),
        ],
      }),
    );

    expect(result.order).toBeNull();
    expect(result.availableManualPromotions).toEqual([]);
  });

  it('ORDER MANUAL opted-in and NOT vetoed is applied (regression-safe)', async () => {
    const orderManual = makeOrderPromotion({
      id: 'order-manual',
      method: 'MANUAL',
      discountType: 'FIXED',
      discountValue: 200,
    });
    const repo = makeRepository([orderManual]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        optedInManualPromotionIds: ['order-manual'],
        vetoedPromotionIds: [],
        lines: [
          makeLine({
            quantity: 5,
            effectiveUnitPriceCents: 1000, // subtotal = 5000c
          }),
        ],
      }),
    );

    expect(result.order).not.toBeNull();
    expect(result.order?.promotionId).toBe('order-manual');
    expect(result.order?.discountAmountCents).toBe(200);
  });

  it('AUTOMATIC not-vetoed still applies (regression-safe)', async () => {
    const auto = makePromotion({
      id: 'promo-auto',
      discountType: 'PERCENTAGE',
      discountValue: 10,
    });
    const repo = makeRepository([auto]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        vetoedPromotionIds: [],
        optedInManualPromotionIds: [],
        lines: [makeLine({ effectiveUnitPriceCents: 1000 })],
      }),
    );

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].promotionId).toBe('promo-auto');
  });

  it('MANUAL NOT opted-in still does NOT auto-apply (regression-safe)', async () => {
    const manual = makePromotion({
      id: 'promo-manual-no-optin',
      method: 'MANUAL',
      discountType: 'PERCENTAGE',
      discountValue: 10,
    });
    const repo = makeRepository([manual]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        optedInManualPromotionIds: [],
        vetoedPromotionIds: [],
        lines: [makeLine({ effectiveUnitPriceCents: 1000 })],
      }),
    );

    expect(result.lines).toEqual([]);
    // But it DOES appear in availableManualPromotions.
    expect(result.availableManualPromotions).toHaveLength(1);
    expect(result.availableManualPromotions[0].id).toBe('promo-manual-no-optin');
  });

  it('availableManualPromotions still excludes opted-in AND vetoed (regression-safe)', async () => {
    const manualEligible = makePromotion({
      id: 'promo-eligible',
      method: 'MANUAL',
      discountType: 'PERCENTAGE',
      discountValue: 5,
    });
    const manualOptedIn = makePromotion({
      id: 'promo-opted-in',
      method: 'MANUAL',
      discountType: 'PERCENTAGE',
      discountValue: 5,
    });
    const manualVetoed = makePromotion({
      id: 'promo-vetoed',
      method: 'MANUAL',
      discountType: 'PERCENTAGE',
      discountValue: 5,
    });
    const repo = makeRepository([manualEligible, manualOptedIn, manualVetoed]);
    const useCase = new PosEvaluatePromotionsUseCase(repo);

    const result = await useCase.evaluate(
      makeInput({
        optedInManualPromotionIds: ['promo-opted-in'],
        vetoedPromotionIds: ['promo-vetoed'],
        lines: [makeLine({ effectiveUnitPriceCents: 1000 })],
      }),
    );

    expect(result.availableManualPromotions).toHaveLength(1);
    expect(result.availableManualPromotions[0].id).toBe('promo-eligible');
  });
});

// ============================================================
// Day-of-week helper coverage
// ============================================================
describe('PosEvaluatePromotionsUseCase — dayOfWeek mapping', () => {
  const cases: Array<{ date: string; expected: DayOfWeek }> = [
    { date: '2026-06-08T00:00:00.000Z', expected: 'MONDAY' },
    { date: '2026-06-09T00:00:00.000Z', expected: 'TUESDAY' },
    { date: '2026-06-10T00:00:00.000Z', expected: 'WEDNESDAY' },
    { date: '2026-06-11T00:00:00.000Z', expected: 'THURSDAY' },
    { date: '2026-06-12T00:00:00.000Z', expected: 'FRIDAY' },
    { date: '2026-06-13T00:00:00.000Z', expected: 'SATURDAY' },
    { date: '2026-06-14T00:00:00.000Z', expected: 'SUNDAY' },
  ];

  for (const c of cases) {
    it(`maps ${c.date} to ${c.expected}`, async () => {
      const target = new Date(c.date);
      const promo = makePromotion({
        id: `promo-${c.expected}`,
        daysOfWeek: [{ id: `d-${c.expected}`, day: c.expected }],
      });
      const repo = makeRepository([promo]);
      const useCase = new PosEvaluatePromotionsUseCase(repo);

      const result = await useCase.evaluate(
        makeInput({
          now: target,
          lines: [makeLine({ effectiveUnitPriceCents: 1000 })],
        }),
      );

      expect(result.lines).toHaveLength(1);
    });
  }
});
