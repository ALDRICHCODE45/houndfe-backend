import { Promotion } from '../domain/promotion.entity';
import { EvaluateCartPromotionsUseCase } from './evaluate-cart-promotions.use-case';

function promotion(
  overrides: Partial<Parameters<typeof Promotion.fromPersistence>[0]> = {},
) {
  // Simulate legacy snapshot rows that bypass current creation validation.
  return Object.assign(
    Promotion.create({
      id: 'promo',
      title: 'Bot discount',
      type: 'PRODUCT_DISCOUNT',
      method: 'AUTOMATIC',
      botEligible: true,
      appliesTo: 'PRODUCTS',
      discountType: 'PERCENTAGE',
      discountValue: 20,
    }),
    overrides,
  );
}

const pricing = {
  items: [
    {
      productId: 'product',
      variantId: null,
      quantity: 2,
      unitPriceCents: 800,
      originalPriceCents: 1600,
      finalPriceCents: 1280,
      discountAmountCents: 320,
      appliedPromotionTitle: 'Bot discount',
    },
  ],
};
const base = {
  ...pricing.items[0],
  finalPriceCents: 1600,
  discountAmountCents: 0,
  appliedPromotionTitle: null,
};

function harness(promotions = [promotion()], complete = true) {
  const repository = {
    findActiveAutomaticSnapshot: jest
      .fn()
      .mockResolvedValue({ promotions, complete }),
  };
  const useCase = new EvaluateCartPromotionsUseCase(repository as never);
  return { repository, useCase };
}

describe('EvaluateCartPromotionsUseCase preview safety guards', () => {
  it('keeps the shared sale preview without recalculating discounts', async () => {
    const h = harness();
    await expect(h.useCase.execute(pricing)).resolves.toEqual({
      items: pricing.items,
      promotionEvaluationStatus: 'fully_evaluated',
    });
  });

  it.each(['VARIANTS', 'CATEGORIES', 'BRANDS'] as const)(
    'keeps the shared preview for eligible %s discounts',
    async (appliesTo) => {
      const h = harness([promotion({ appliesTo })]);
      await expect(h.useCase.execute(pricing)).resolves.toEqual({
        items: pricing.items,
        promotionEvaluationStatus: 'fully_evaluated',
      });
    },
  );

  it('keeps the shared preview for eligible weekday and date-window discounts', async () => {
    const h = harness([
      promotion({
        daysOfWeek: [{ id: 'day-1', day: 'MONDAY' }],
        startDate: new Date('2026-10-01T06:00:00.000Z'),
        endDate: new Date('2026-11-01T05:59:59.999Z'),
      }),
    ]);
    await expect(h.useCase.execute(pricing)).resolves.toEqual({
      items: pricing.items,
      promotionEvaluationStatus: 'fully_evaluated',
    });
  });

  it('ignores unsupported promotions that are not bot eligible', async () => {
    const h = harness([promotion({ method: 'MANUAL', botEligible: false })]);
    await expect(h.useCase.execute(pricing)).resolves.toEqual({
      items: pricing.items,
      promotionEvaluationStatus: 'fully_evaluated',
    });
  });

  it.each([
    { customerScope: 'REGISTERED_ONLY' as const },
    {
      customerScope: 'SPECIFIC' as const,
      customers: [{ id: 'restriction', customerId: 'customer' }],
    },
    { priceLists: [{ id: 'restriction', globalPriceListId: 'list' }] },
  ])(
    'keeps the shared preview for supported customer/list restrictions: %j',
    async (rule) => {
      const h = harness([promotion(rule)]);
      await expect(h.useCase.execute(pricing)).resolves.toEqual({
        items: pricing.items,
        promotionEvaluationStatus: 'fully_evaluated',
      });
    },
  );

  it.each([{ method: 'MANUAL' as const }])(
    'fails closed for an unsupported eligible snapshot: %j',
    async (rule) => {
      const h = harness([promotion(rule)]);
      await expect(h.useCase.execute(pricing)).resolves.toEqual({
        items: [base],
        promotionEvaluationStatus: 'needs_human_review',
      });
    },
  );

  it('keeps backend base prices for an incomplete snapshot', async () => {
    const h = harness([], false);
    await expect(h.useCase.execute(pricing)).resolves.toEqual({
      items: [base],
      promotionEvaluationStatus: 'needs_human_review',
    });
  });

  it('keeps a prorated eligible order promotion fully evaluated', async () => {
    const h = harness([promotion({ type: 'ORDER_DISCOUNT', appliesTo: null })]);
    await expect(h.useCase.execute(pricing)).resolves.toEqual({
      items: pricing.items,
      promotionEvaluationStatus: 'fully_evaluated',
    });
  });

  it('keeps an eligible BXGY reward fully evaluated', async () => {
    const h = harness([promotion({ type: 'BUY_X_GET_Y' })]);
    await expect(h.useCase.execute(pricing)).resolves.toEqual({
      items: pricing.items,
      promotionEvaluationStatus: 'fully_evaluated',
    });
  });

  it('keeps an eligible ADVANCED get-side reward fully evaluated', async () => {
    const h = harness([promotion({ type: 'ADVANCED', appliesTo: null })]);
    await expect(h.useCase.execute(pricing)).resolves.toEqual({
      items: pricing.items,
      promotionEvaluationStatus: 'fully_evaluated',
    });
  });

  it('propagates snapshot failures rather than silently quoting', async () => {
    const h = harness();
    h.repository.findActiveAutomaticSnapshot.mockRejectedValue(
      new Error('snapshot unavailable'),
    );
    await expect(h.useCase.execute(pricing)).rejects.toThrow(
      'snapshot unavailable',
    );
  });
});
