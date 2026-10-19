import { Promotion } from '../domain/promotion.entity';
import type { IPromotionRepository } from '../domain/promotion.repository';
import { EvaluateCartPromotionsUseCase } from './evaluate-cart-promotions.use-case';
import { PosEvaluatePromotionsUseCase } from './pos-evaluate-promotions.use-case';
import type { CartItemForEvaluation } from './ports/evaluate-cart-promotions.port';
import type {
  IPosEvaluatePromotionsUseCase,
  PosEvalLineResult,
  PosEvalResult,
} from './ports/pos-evaluate-promotions.port';

function makePromotion(
  overrides: Partial<Parameters<typeof Promotion.fromPersistence>[0]> = {},
): Promotion {
  return Promotion.fromPersistence({
    id: 'promo-1',
    title: 'Automatic promo',
    type: 'PRODUCT_DISCOUNT',
    method: 'AUTOMATIC',
    botEligible: true,
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
    createdAt: new Date('2026-06-11T00:00:00.000Z'),
    updatedAt: new Date('2026-06-11T00:00:00.000Z'),
    targetItems: [productTarget('prod-1')],
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
    findAll: jest
      .fn()
      .mockResolvedValue({ data: promotions, total: promotions.length }),
    findActiveAutomaticSnapshot: jest
      .fn()
      .mockResolvedValue({ promotions, complete: true }),
    delete: jest.fn(),
    deleteMany: jest.fn(),
    updateStatus: jest.fn(),
  };
}

function makeUseCase(
  repository: jest.Mocked<IPromotionRepository>,
  engine: IPosEvaluatePromotionsUseCase = new PosEvaluatePromotionsUseCase(
    repository,
  ),
): EvaluateCartPromotionsUseCase {
  return new EvaluateCartPromotionsUseCase(repository, engine);
}

function productTarget(productId: string) {
  return {
    id: `target-${productId}`,
    side: 'DEFAULT' as const,
    targetType: 'PRODUCTS' as const,
    targetId: productId,
  };
}

function cartLine(
  productId = 'prod-1',
  quantity = 1,
  unitPriceCents = 1000,
): CartItemForEvaluation {
  return { productId, variantId: null, quantity, unitPriceCents };
}

function expectedLine(
  item: CartItemForEvaluation,
  finalPriceCents: number,
  title: string | null = null,
) {
  const originalPriceCents = item.unitPriceCents * item.quantity;
  return {
    ...item,
    originalPriceCents,
    finalPriceCents,
    discountAmountCents: originalPriceCents - finalPriceCents,
    appliedPromotionTitle: title,
  };
}

function evaluate(promotions: Promotion[], items = [cartLine()]) {
  return makeUseCase(makeRepository(promotions)).execute({ items });
}

function engineResult(overrides: Partial<PosEvalResult> = {}): PosEvalResult {
  return {
    lines: [],
    order: null,
    availableManualPromotions: [],
    targetableManualPromotionIds: [],
    promotionCapacityDemands: [],
    capacityExcludedPromotionIds: [],
    ...overrides,
  };
}

describe('EvaluateCartPromotionsUseCase with the POS engine', () => {
  it.each(['PRODUCT_DISCOUNT', 'ORDER_DISCOUNT', 'BUY_X_GET_Y'] as const)(
    'ignores non-eligible %s without blocking or discounting',
    async (type) => {
      const item = cartLine('prod-1', 2);
      await expect(
        evaluate([makePromotion({ type, botEligible: false })], [item]),
      ).resolves.toEqual({
        items: [expectedLine(item, 2000)],
        promotionEvaluationStatus: 'fully_evaluated',
      });
    },
  );

  it('applies an eligible percentage product discount and preserves the public shape', async () => {
    const item = cartLine('prod-1', 2);
    await expect(evaluate([makePromotion()], [item])).resolves.toEqual({
      items: [expectedLine(item, 1800, 'Automatic promo')],
      promotionEvaluationStatus: 'fully_evaluated',
    });
  });

  it('chooses 20% over the first matching 10% promotion', async () => {
    await expect(
      evaluate([
        makePromotion(),
        makePromotion({ id: 'promo-2', title: '20% off', discountValue: 20 }),
      ]),
    ).resolves.toEqual({
      items: [expectedLine(cartLine(), 800, '20% off')],
      promotionEvaluationStatus: 'fully_evaluated',
    });
  });

  it('applies FIXED 150 per unit to a variant line', async () => {
    const item = { ...cartLine('prod-1', 2, 250), variantId: 'var-1' };
    await expect(
      evaluate(
        [makePromotion({ discountType: 'FIXED', discountValue: 150 })],
        [item],
      ),
    ).resolves.toEqual({
      items: [expectedLine(item, 200, 'Automatic promo')],
      promotionEvaluationStatus: 'fully_evaluated',
    });
  });

  it('returns base prices when there are no active automatic promotions or no matching target', async () => {
    const item = cartLine('prod-other', 3);
    for (const promotions of [[], [makePromotion()]]) {
      await expect(evaluate(promotions, [item])).resolves.toEqual({
        items: [expectedLine(item, 3000)],
        promotionEvaluationStatus: 'fully_evaluated',
      });
    }
  });

  it('excludes the best capped promotion on aggregate overrun and falls back on both lines', async () => {
    const items = [cartLine(), cartLine('prod-2')];
    const targetItems = items.map((item) => productTarget(item.productId));
    await expect(
      evaluate(
        [
          makePromotion({
            id: 'capped',
            discountValue: 30,
            maxProductUnits: 1,
            targetItems,
          }),
          makePromotion({
            id: 'fallback',
            title: '20% fallback',
            discountValue: 20,
            targetItems,
          }),
        ],
        items,
      ),
    ).resolves.toEqual({
      items: items.map((item) => expectedLine(item, 800, '20% fallback')),
      promotionEvaluationStatus: 'fully_evaluated',
    });
  });

  it.each([
    {
      maxProductUnits: 1,
      consumedProductUnits: 0,
      final: 1000,
      title: null,
    },
    {
      maxProductUnits: 2,
      consumedProductUnits: 2,
      final: 1000,
      title: null,
    },
    {
      maxProductUnits: 2,
      consumedProductUnits: 0,
      final: 900,
      title: 'Automatic promo',
    },
    {
      maxProductUnits: null,
      consumedProductUnits: 0,
      final: 900,
      title: 'Automatic promo',
    },
  ])(
    'handles aggregate capacity $maxProductUnits with $consumedProductUnits consumed',
    async ({ maxProductUnits, consumedProductUnits, final, title }) => {
      const items = [cartLine(), cartLine('prod-2')];
      await expect(
        evaluate(
          [
            makePromotion({
              maxProductUnits,
              consumedProductUnits,
              targetItems: items.map((item) => productTarget(item.productId)),
            }),
          ],
          items,
        ),
      ).resolves.toEqual({
        items: items.map((item) => expectedLine(item, final, title)),
        promotionEvaluationStatus: 'fully_evaluated',
      });
    },
  );
});

describe('EvaluateCartPromotionsUseCase snapshot guards', () => {
  const unsupported = [
    { type: 'BUY_X_GET_Y' as const, appliesTo: null },
    { customerScope: 'REGISTERED_ONLY' as const },
    {
      customerScope: 'SPECIFIC' as const,
      customers: [{ id: 'pc-1', customerId: 'cust-1' }],
    },
    { priceLists: [{ id: 'ppl-1', globalPriceListId: 'GPL-retail' }] },
    { daysOfWeek: [{ id: 'd-sun', day: 'SUNDAY' as const }] },
  ];

  it.each(unsupported)(
    'fails the whole cart closed for unsupported eligible rules: %j',
    async (overrides) => {
      const repository = makeRepository([
        makePromotion(),
        makePromotion({ id: 'unsupported', ...overrides }),
      ]);
      const engine = { evaluate: jest.fn() };
      const items = [cartLine(), cartLine('prod-2')];
      await expect(
        makeUseCase(repository, engine).execute({ items }),
      ).resolves.toEqual({
        items: items.map((item) => expectedLine(item, 1000)),
        promotionEvaluationStatus: 'needs_human_review',
      });
      expect(engine.evaluate).not.toHaveBeenCalled();
    },
  );

  it.each([0, 100])(
    'fails closed for an unrelated eligible restriction after %i open promotions',
    async (count) => {
      const repository = makeRepository([
        ...Array.from({ length: count }, (_, index) =>
          makePromotion({ id: `open-${index}` }),
        ),
        makePromotion({
          id: 'restricted',
          daysOfWeek: [{ id: 'd-sun', day: 'SUNDAY' }],
          targetItems: [productTarget('prod-2')],
        }),
      ]);
      const engine = { evaluate: jest.fn() };
      await expect(
        makeUseCase(repository, engine).execute({ items: [cartLine()] }),
      ).resolves.toEqual({
        items: [expectedLine(cartLine(), 1000)],
        promotionEvaluationStatus: 'needs_human_review',
      });
      expect(repository.findActiveAutomaticSnapshot.mock.calls).toHaveLength(1);
      expect(repository.findAll.mock.calls).toHaveLength(0);
      expect(engine.evaluate).not.toHaveBeenCalled();
    },
  );

  it('discounts when the bounded snapshot is exactly at its cap and complete', async () => {
    const repository = makeRepository(
      Array.from({ length: 1000 }, (_, index) =>
        makePromotion({ id: `open-${index}` }),
      ),
    );
    await expect(
      makeUseCase(repository).execute({ items: [cartLine()] }),
    ).resolves.toEqual({
      items: [expectedLine(cartLine(), 900, 'Automatic promo')],
      promotionEvaluationStatus: 'fully_evaluated',
    });
    expect(repository.findActiveAutomaticSnapshot.mock.calls).toHaveLength(1);
    expect(repository.findAll.mock.calls).toEqual([
      [{ page: 1, limit: 500, status: 'ACTIVE', botEligible: true }],
    ]);
  });

  it('fails the whole cart closed for an incomplete snapshot without invoking the engine', async () => {
    const repository = makeRepository([makePromotion()]);
    repository.findActiveAutomaticSnapshot.mockResolvedValue({
      promotions: [makePromotion()],
      complete: false,
    });
    const engine = { evaluate: jest.fn() };
    const items = [cartLine(), cartLine('prod-2')];
    await expect(
      makeUseCase(repository, engine).execute({ items }),
    ).resolves.toEqual({
      items: items.map((item) => expectedLine(item, 1000)),
      promotionEvaluationStatus: 'needs_human_review',
    });
    expect(engine.evaluate).not.toHaveBeenCalled();
  });

  it('propagates a snapshot read failure instead of silently quoting', async () => {
    const repository = makeRepository([]);
    repository.findActiveAutomaticSnapshot.mockRejectedValue(
      new Error('snapshot unavailable'),
    );
    const engine = { evaluate: jest.fn() };
    await expect(
      makeUseCase(repository, engine).execute({ items: [cartLine()] }),
    ).rejects.toThrow('snapshot unavailable');
    expect(engine.evaluate).not.toHaveBeenCalled();
  });
});

describe('EvaluateCartPromotionsUseCase engine contract', () => {
  it.each([undefined, 'per-unit'] as const)(
    'maps %s results by stable line id, not result order or product id',
    async (kind) => {
      const items = [
        cartLine(),
        { ...cartLine('prod-1', 3, 999), variantId: 'var-1' },
        cartLine('prod-2'),
      ];
      const engine = {
        evaluate: jest.fn().mockResolvedValue(
          engineResult({
            lines: [
              {
                kind,
                itemId: 'line-1',
                promotionId: 'p2',
                discountType: 'percentage',
                discountValue: 33,
                discountTitle: '33%',
              },
              {
                kind,
                itemId: 'line-0',
                promotionId: 'p1',
                discountType: 'amount',
                discountValue: 150,
                discountTitle: '150 off',
              },
            ],
          }),
        ),
      };
      await expect(
        makeUseCase(makeRepository([]), engine).execute({ items }),
      ).resolves.toEqual({
        items: [
          expectedLine(items[0], 850, '150 off'),
          expectedLine(items[1], 2007, '33%'),
          expectedLine(items[2], 1000),
        ],
        promotionEvaluationStatus: 'fully_evaluated',
      });
      expect(engine.evaluate).toHaveBeenCalledTimes(1);
      expect(engine.evaluate).toHaveBeenCalledWith({
        now: expect.any(Date) as Date,
        customerId: null,
        botEligibleOnly: true,
        vetoedPromotionIds: [],
        optedInManualPromotionIds: [],
        lines: items.map((item, index) => ({
          itemId: `line-${index}`,
          productId: item.productId,
          variantId: item.variantId,
          quantity: item.quantity,
          effectiveUnitPriceCents: item.unitPriceCents,
          appliedPriceListId: null,
          appliedGlobalPriceListId: null,
          categoryId: null,
          brandId: null,
          hasManualDiscount: false,
        })),
      });
    },
  );

  it.each(['buy-x-get-y', 'advanced'] as const)(
    'fails the whole cart closed for an unexpected %s engine result',
    async (kind) => {
      const lines: PosEvalLineResult[] = [
        {
          itemId: 'line-0',
          promotionId: 'p1',
          discountType: 'percentage',
          discountValue: 10,
          discountTitle: '10%',
        },
        {
          kind,
          itemId: 'line-1',
          promotionId: 'p2',
          discountTitle: 'Reward',
          lineDiscountCents: 100,
          perUnitRewardCents: 100,
          discountedUnitCount: 1,
          getDiscountPercent: 10,
        },
      ];
      const engine = {
        evaluate: jest.fn().mockResolvedValue(engineResult({ lines })),
      };
      const items = [cartLine(), cartLine('prod-2')];
      await expect(
        makeUseCase(makeRepository([]), engine).execute({ items }),
      ).resolves.toEqual({
        items: items.map((item) => expectedLine(item, 1000)),
        promotionEvaluationStatus: 'needs_human_review',
      });
    },
  );

  it('fails the whole cart closed for an unexpected order result even with valid line discounts', async () => {
    const engine = {
      evaluate: jest.fn().mockResolvedValue(
        engineResult({
          lines: [
            {
              itemId: 'line-0',
              promotionId: 'p1',
              discountType: 'percentage',
              discountValue: 10,
              discountTitle: '10%',
            },
          ],
          order: {
            promotionId: 'order',
            discountType: 'amount',
            discountValue: 100,
            discountTitle: 'Order',
            discountAmountCents: 100,
          },
        }),
      ),
    };
    await expect(
      makeUseCase(makeRepository([]), engine).execute({ items: [cartLine()] }),
    ).resolves.toEqual({
      items: [expectedLine(cartLine(), 1000)],
      promotionEvaluationStatus: 'needs_human_review',
    });
  });

  it('evaluates an empty cart without inventing lines', async () => {
    await expect(evaluate([], [])).resolves.toEqual({
      items: [],
      promotionEvaluationStatus: 'fully_evaluated',
    });
  });
});
