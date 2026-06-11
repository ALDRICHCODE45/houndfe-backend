import { Promotion } from '../domain/promotion.entity';
import type { IPromotionRepository } from '../domain/promotion.repository';
import { EvaluateCartPromotionsUseCase } from './evaluate-cart-promotions.use-case';

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
