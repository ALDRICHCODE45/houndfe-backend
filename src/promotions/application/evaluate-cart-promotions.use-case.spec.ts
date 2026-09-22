import { Promotion } from '../domain/promotion.entity';
import type { IPromotionRepository } from '../domain/promotion.repository';
import { EvaluateCartPromotionsUseCase } from './evaluate-cart-promotions.use-case';
import type { CartItemForEvaluation } from './ports/evaluate-cart-promotions.port';

function makePromotion(
  overrides: Partial<Parameters<typeof Promotion.fromPersistence>[0]> = {},
): Promotion {
  return Promotion.fromPersistence({
    id: 'promo-1',
    title: 'Automatic promo',
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
    createdAt: new Date('2026-06-11T00:00:00.000Z'),
    updatedAt: new Date('2026-06-11T00:00:00.000Z'),
    targetItems: [
      {
        id: 'target-1',
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
  } as jest.Mocked<IPromotionRepository>;
}

describe('EvaluateCartPromotionsUseCase', () => {
  it('applies an active percentage product discount to matching cart items', async () => {
    const repository = makeRepository([
      makePromotion({
        title: '10% off Royal Canin',
        discountType: 'PERCENTAGE',
        discountValue: 10,
      }),
    ]);
    const useCase = new EvaluateCartPromotionsUseCase(repository);

    await expect(
      useCase.execute({
        items: [
          {
            productId: 'prod-1',
            variantId: null,
            quantity: 2,
            unitPriceCents: 1000,
          },
        ],
      }),
    ).resolves.toEqual({
      items: [
        {
          productId: 'prod-1',
          variantId: null,
          quantity: 2,
          unitPriceCents: 1000,
          originalPriceCents: 2000,
          finalPriceCents: 1800,
          appliedPromotionTitle: '10% off Royal Canin',
          discountAmountCents: 200,
        },
      ],
      promotionEvaluationStatus: 'fully_evaluated',
    });
  });

  it('applies an active fixed product discount and caps it at the line total', async () => {
    const repository = makeRepository([
      makePromotion({
        title: '$3 off snack',
        discountType: 'FIXED',
        discountValue: 300,
      }),
    ]);
    const useCase = new EvaluateCartPromotionsUseCase(repository);

    await expect(
      useCase.execute({
        items: [
          {
            productId: 'prod-1',
            variantId: 'var-1',
            quantity: 2,
            unitPriceCents: 250,
          },
        ],
      }),
    ).resolves.toEqual({
      items: [
        {
          productId: 'prod-1',
          variantId: 'var-1',
          quantity: 2,
          unitPriceCents: 250,
          originalPriceCents: 500,
          finalPriceCents: 0,
          appliedPromotionTitle: '$3 off snack',
          discountAmountCents: 500,
        },
      ],
      promotionEvaluationStatus: 'fully_evaluated',
    });
  });

  it('returns needs_human_review when an unsupported active promotion is present', async () => {
    const repository = makeRepository([
      makePromotion({
        id: 'promo-advanced',
        title: 'Buy one get one mystery',
        type: 'BUY_X_GET_Y',
        discountType: null,
        discountValue: null,
        appliesTo: null,
        targetItems: [],
      }),
    ]);
    const useCase = new EvaluateCartPromotionsUseCase(repository);

    await expect(
      useCase.execute({
        items: [
          {
            productId: 'prod-1',
            variantId: null,
            quantity: 1,
            unitPriceCents: 1000,
          },
        ],
      }),
    ).resolves.toEqual({
      items: [
        {
          productId: 'prod-1',
          variantId: null,
          quantity: 1,
          unitPriceCents: 1000,
          originalPriceCents: 1000,
          finalPriceCents: 1000,
          appliedPromotionTitle: null,
          discountAmountCents: 0,
        },
      ],
      promotionEvaluationStatus: 'needs_human_review',
    });
  });

  it('returns base pricing with fully_evaluated when there are no active automatic promotions', async () => {
    const repository = makeRepository([]);
    const useCase = new EvaluateCartPromotionsUseCase(repository);

    await expect(
      useCase.execute({
        items: [
          {
            productId: 'prod-1',
            variantId: null,
            quantity: 3,
            unitPriceCents: 1000,
          },
        ],
      }),
    ).resolves.toEqual({
      items: [
        {
          productId: 'prod-1',
          variantId: null,
          quantity: 3,
          unitPriceCents: 1000,
          originalPriceCents: 3000,
          finalPriceCents: 3000,
          appliedPromotionTitle: null,
          discountAmountCents: 0,
        },
      ],
      promotionEvaluationStatus: 'fully_evaluated',
    });
  });
});

function productTarget(productId: string) {
  return {
    id: `target-${productId}`,
    side: 'DEFAULT' as const,
    targetType: 'PRODUCTS' as const,
    targetId: productId,
  };
}

function bothProductTargets() {
  return [productTarget('prod-1'), productTarget('prod-2')];
}

function cartLine(
  productId: string,
  quantity: number,
  unitPriceCents = 1000,
): CartItemForEvaluation {
  return { productId, variantId: null, quantity, unitPriceCents };
}

function expectedLine(
  productId: string,
  quantity: number,
  finalPriceCents: number,
  appliedPromotionTitle: string | null,
  unitPriceCents = 1000,
) {
  const originalPriceCents = unitPriceCents * quantity;
  return {
    productId,
    variantId: null,
    quantity,
    unitPriceCents,
    originalPriceCents,
    finalPriceCents,
    appliedPromotionTitle,
    discountAmountCents: originalPriceCents - finalPriceCents,
  };
}

function evaluate(promotions: Promotion[], items: CartItemForEvaluation[]) {
  return new EvaluateCartPromotionsUseCase(makeRepository(promotions)).execute({
    items,
  });
}

describe('EvaluateCartPromotionsUseCase capacity fallback', () => {
  it('excludes a capped promotion whose aggregate demand overruns and falls back on both lines without leaking the internal id', async () => {
    const result = await evaluate(
      [
        makePromotion({
          id: 'promo-capped',
          title: '10% off capped',
          maxProductUnits: 1,
          targetItems: bothProductTargets(),
        }),
        makePromotion({
          id: 'promo-fallback',
          title: '20% off fallback',
          discountValue: 20,
          targetItems: bothProductTargets(),
        }),
      ],
      [cartLine('prod-1', 1), cartLine('prod-2', 1)],
    );

    expect(result).toEqual({
      items: [
        expectedLine('prod-1', 1, 800, '20% off fallback'),
        expectedLine('prod-2', 1, 800, '20% off fallback'),
      ],
      promotionEvaluationStatus: 'fully_evaluated',
    });
    expect(Object.keys(result.items[0]).sort()).toEqual([
      'appliedPromotionTitle',
      'discountAmountCents',
      'finalPriceCents',
      'originalPriceCents',
      'productId',
      'quantity',
      'unitPriceCents',
      'variantId',
    ]);
  });

  const capacityCases = [
    {
      label:
        'returns base prices when a capped promotion overruns with no fallback',
      promotions: [
        makePromotion({
          id: 'promo-capped',
          maxProductUnits: 1,
          targetItems: bothProductTargets(),
        }),
      ],
      items: [cartLine('prod-1', 1), cartLine('prod-2', 1)],
      expectedItems: [
        expectedLine('prod-1', 1, 1000, null),
        expectedLine('prod-2', 1, 1000, null),
      ],
    },
    {
      label: 'applies a capped promotion when aggregate demand fits exactly',
      promotions: [
        makePromotion({
          id: 'promo-capped',
          maxProductUnits: 2,
          targetItems: bothProductTargets(),
        }),
      ],
      items: [cartLine('prod-1', 1), cartLine('prod-2', 1)],
      expectedItems: [
        expectedLine('prod-1', 1, 900, 'Automatic promo'),
        expectedLine('prod-2', 1, 900, 'Automatic promo'),
      ],
    },
    {
      label: 'applies an unlimited promotion regardless of aggregate demand',
      promotions: [
        makePromotion({
          id: 'promo-unlimited',
          maxProductUnits: null,
          targetItems: bothProductTargets(),
        }),
      ],
      items: [cartLine('prod-1', 5), cartLine('prod-2', 7)],
      expectedItems: [
        expectedLine('prod-1', 5, 4500, 'Automatic promo'),
        expectedLine('prod-2', 7, 6300, 'Automatic promo'),
      ],
    },
  ];

  it.each(capacityCases)(
    '$label',
    async ({ promotions, items, expectedItems }) => {
      await expect(evaluate(promotions, items)).resolves.toEqual({
        items: expectedItems,
        promotionEvaluationStatus: 'fully_evaluated',
      });
    },
  );

  it('excludes every overrun winner from the same pass and preserves needs_human_review for unsupported promotions', async () => {
    const promotions = [
      makePromotion({
        id: 'promo-a',
        maxProductUnits: 1,
        targetItems: [productTarget('prod-1')],
      }),
      makePromotion({
        id: 'promo-b',
        maxProductUnits: 1,
        targetItems: [productTarget('prod-2')],
      }),
      makePromotion({
        id: 'promo-fallback',
        title: '30% off fallback',
        discountValue: 30,
        targetItems: bothProductTargets(),
      }),
      makePromotion({
        id: 'promo-unsupported',
        type: 'BUY_X_GET_Y',
        discountType: null,
        discountValue: null,
        appliesTo: null,
        targetItems: [],
      }),
    ];

    await expect(
      evaluate(promotions, [cartLine('prod-1', 2), cartLine('prod-2', 2)]),
    ).resolves.toEqual({
      items: [
        expectedLine('prod-1', 2, 1400, '30% off fallback'),
        expectedLine('prod-2', 2, 1400, '30% off fallback'),
      ],
      promotionEvaluationStatus: 'needs_human_review',
    });
  });
});
