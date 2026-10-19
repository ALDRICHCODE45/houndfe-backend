import { SaleItem } from '../../sales/domain/sale-item.entity';
import { Promotion } from '../domain/promotion.entity';
import type { IPromotionRepository } from '../domain/promotion.repository';
import { EvaluateCartPromotionsUseCase } from './evaluate-cart-promotions.use-case';
import { PosEvaluatePromotionsUseCase } from './pos-evaluate-promotions.use-case';
import type { PosEvalInput } from './ports/pos-evaluate-promotions.port';

function promotion(
  overrides: Partial<Parameters<typeof Promotion.fromPersistence>[0]> = {},
): Promotion {
  return Promotion.fromPersistence({
    id: 'promo-10',
    title: '10% off',
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

function repository(
  promotions: Promotion[],
): jest.Mocked<IPromotionRepository> {
  return {
    save: jest.fn(),
    findById: jest.fn(),
    findAll: jest.fn().mockResolvedValue({
      data: promotions,
      total: promotions.length,
    }),
    findActiveAutomaticSnapshot: jest.fn().mockResolvedValue({
      promotions,
      complete: true,
    }),
    delete: jest.fn(),
    deleteMany: jest.fn(),
    updateStatus: jest.fn(),
  };
}

describe('Bot cart preview / SaleItem pricing parity', () => {
  it.each([
    {
      name: 'overlapping 10% and 20% discounts',
      promotions: [
        promotion(),
        promotion({ id: 'promo-20', title: '20% off', discountValue: 20 }),
      ],
      unitPriceCents: 1000,
      quantity: 1,
      expectedFinal: 800,
      expectedPromotionId: 'promo-20',
    },
    {
      name: '33% per-unit rounding on 999 cents, quantity 3',
      promotions: [promotion({ discountValue: 33 })],
      unitPriceCents: 999,
      quantity: 3,
      expectedFinal: 2007,
      expectedPromotionId: 'promo-10',
    },
    {
      name: 'FIXED 150 cents, quantity 2',
      promotions: [promotion({ discountType: 'FIXED', discountValue: 150 })],
      unitPriceCents: 1000,
      quantity: 2,
      expectedFinal: 1700,
      expectedPromotionId: 'promo-10',
    },
    {
      name: 'capacity-limited winner falls back',
      promotions: [
        promotion({ discountValue: 30, maxProductUnits: 1 }),
        promotion({ id: 'fallback', discountValue: 20 }),
      ],
      unitPriceCents: 1000,
      quantity: 2,
      expectedFinal: 1600,
      expectedPromotionId: 'fallback',
    },
    {
      name: 'exhausted capacity without a fallback',
      promotions: [promotion({ maxProductUnits: 1, consumedProductUnits: 1 })],
      unitPriceCents: 1000,
      quantity: 2,
      expectedFinal: 2000,
      expectedPromotionId: null,
    },
  ])(
    '$name',
    async ({
      promotions,
      unitPriceCents,
      quantity,
      expectedFinal,
      expectedPromotionId,
    }) => {
      const engine = new PosEvaluatePromotionsUseCase(repository(promotions));
      const preview = new EvaluateCartPromotionsUseCase(
        repository(promotions),
        engine,
      );
      const item = {
        productId: 'prod-1',
        variantId: null,
        unitPriceCents,
        quantity,
      };
      const result = await preview.execute({ items: [item] });

      // Independently evaluate the sale input, then use the public entity path
      // that confirmation uses rather than reimplementing its discount math.
      const saleEngine = new PosEvaluatePromotionsUseCase(
        repository(promotions),
      );
      const input: PosEvalInput = {
        now: new Date(),
        customerId: null,
        botEligibleOnly: true,
        vetoedPromotionIds: [],
        optedInManualPromotionIds: [],
        lines: [
          {
            itemId: 'sale-item-1',
            productId: item.productId,
            variantId: item.variantId,
            quantity,
            effectiveUnitPriceCents: unitPriceCents,
            appliedPriceListId: null,
            appliedGlobalPriceListId: null,
            categoryId: null,
            brandId: null,
            hasManualDiscount: false,
          },
        ],
      };
      const saleResult = await saleEngine.evaluate(input);
      expect(saleResult.order).toBeNull();
      expect(saleResult.lines).toHaveLength(
        expectedPromotionId === null ? 0 : 1,
      );
      const saleItem = SaleItem.create({
        id: 'sale-item-1',
        saleId: 'sale-1',
        ...item,
        productName: 'Product',
        variantName: null,
        unitPriceCurrency: 'MXN',
      });
      const discount = saleResult.lines.find(
        (line) => line.itemId === saleItem.id,
      );
      expect(discount?.promotionId ?? null).toBe(expectedPromotionId);
      if (discount) {
        if (discount.kind !== undefined && discount.kind !== 'per-unit') {
          throw new Error('Expected a per-unit sale discount');
        }
        saleItem.applyDiscount({
          type: discount.discountType,
          ...(discount.discountType === 'amount'
            ? { amountCents: discount.discountValue }
            : { percent: discount.discountValue }),
          promotionId: discount.promotionId,
          discountTitle: discount.discountTitle,
        });
      }

      const saleTotal = saleItem.unitPriceCents * saleItem.quantity;
      expect(saleTotal).toBe(expectedFinal);
      expect(result.promotionEvaluationStatus).toBe('fully_evaluated');
      expect(result.items[0].finalPriceCents).toBe(saleTotal);
      expect(result.items[0].discountAmountCents).toBe(
        unitPriceCents * quantity - saleTotal,
      );
    },
  );
});
