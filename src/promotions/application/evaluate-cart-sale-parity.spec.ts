import { SalesService } from '../../sales/sales.service';
import type { Sale } from '../../sales/domain/sale.entity';
import { Promotion } from '../domain/promotion.entity';
import type { IPromotionRepository } from '../domain/promotion.repository';
import { PosEvaluatePromotionsUseCase } from './pos-evaluate-promotions.use-case';

type Dependencies = ConstructorParameters<typeof SalesService>;

function harness(
  customerList: string | null,
  percent = 0,
  missingListPrice = false,
) {
  const promo = Promotion.create({
    id: 'promo',
    title: 'Bot discount',
    type: 'PRODUCT_DISCOUNT',
    method: 'AUTOMATIC',
    botEligible: true,
    appliesTo: 'PRODUCTS',
    discountType: 'PERCENTAGE',
    discountValue: percent || 20,
  });
  promo.targetItems = [
    {
      id: 'target',
      side: 'DEFAULT',
      targetType: 'PRODUCTS',
      targetId: 'prod-1',
    },
  ];
  const findAll = jest.fn().mockResolvedValue({
    data: percent ? [promo] : [],
    total: percent ? 1 : 0,
  });
  const engine = new PosEvaluatePromotionsUseCase({
    findAll,
  } as unknown as IPromotionRepository);
  const saleRepo = {
    runInTransaction: jest.fn((fn: () => Promise<unknown>) => fn()),
    save: jest.fn((sale: Sale) => Promise.resolve(sale)),
    allocateNextFolio: jest.fn().mockResolvedValue('BOT-1'),
    persistChargeConfirmation: jest.fn().mockResolvedValue([]),
  };
  const products = {
    getApplicablePrices: jest
      .fn()
      .mockResolvedValue([
        { priceCents: 800 },
        { priceCents: 1000 },
        { priceCents: 999 },
      ]),
    batchResolvePriceMap: jest.fn(
      (
        inputs: Array<{
          productId: string;
          variantId: string | null;
          priceListId: string;
          quantity: number;
        }>,
      ) =>
        Promise.resolve(
          new Map(
            inputs.flatMap((item) => {
              if (missingListPrice && item.priceListId === 'customer-list') {
                return [];
              }
              return [
                [
                  `${item.productId}::${item.variantId ?? ''}::${item.priceListId}`,
                  new Map([
                    [
                      item.quantity,
                      item.priceListId === 'customer-list' ? 800 : 1000,
                    ],
                  ]),
                ] as const,
              ];
            }),
          ),
        ),
    ),
    resolveProductCategoryBrandIds: jest.fn().mockResolvedValue(new Map()),
    decrementStockForCharge: jest.fn().mockResolvedValue([]),
  };
  const customerFindUnique = jest.fn().mockResolvedValue({
    id: 'customer',
    globalPriceListId: customerList,
  });
  const outbox = { publish: jest.fn() };
  const usage = { claimForSale: jest.fn() };
  const service = new SalesService(
    saleRepo as unknown as Dependencies[0],
    products as unknown as Dependencies[1],
    { emit: jest.fn() } as unknown as Dependencies[2],
    outbox as unknown as Dependencies[3],
    {
      getTenantId: () => 'tenant',
      getClient: () => ({
        customer: { findUnique: customerFindUnique },
        globalPriceList: {
          findFirst: jest.fn().mockResolvedValue({ id: 'public' }),
        },
      }),
    } as unknown as Dependencies[4],
    {} as Dependencies[5],
    engine,
    {} as Dependencies[7],
    usage as unknown as Dependencies[8],
  );
  return {
    service,
    saleRepo,
    products,
    outbox,
    usage,
    findAll,
    customerFindUnique,
    engine,
  };
}

const item = {
  productId: 'prod-1',
  variantId: null,
  quantity: 1,
  unitPriceCents: 7,
};

describe('Bot preview / confirmation parity through the same SalesService', () => {
  it.each([
    {
      name: 'customer list without promo',
      list: 'customer-list',
      percent: 0,
      customerId: 'customer',
      base: 800,
      final: 800,
    },
    {
      name: 'customer list with eligible 20%',
      list: 'customer-list',
      percent: 20,
      customerId: 'customer',
      base: 800,
      final: 640,
    },
    {
      name: 'customer without list',
      list: null,
      percent: 0,
      customerId: 'customer',
      base: 1000,
      final: 1000,
    },
    {
      name: 'new createIfAbsent customer',
      list: null,
      percent: 0,
      customerId: null,
      base: 1000,
      final: 1000,
    },
    {
      name: 'public with eligible 20%',
      list: null,
      percent: 20,
      customerId: null,
      base: 1000,
      final: 800,
    },
    {
      name: 'missing customer-list row keeps public seed',
      list: 'customer-list',
      percent: 20,
      customerId: 'customer',
      base: 1000,
      final: 800,
      missing: true,
    },
  ])('$name', async ({ list, percent, customerId, base, final, missing }) => {
    const h = harness(list, percent, missing);
    const preview = await h.service.previewBotPricing({
      customerId,
      items: [item],
    });
    expect(preview).toEqual({
      items: [
        {
          ...item,
          unitPriceCents: base,
          originalPriceCents: base,
          finalPriceCents: final,
          discountAmountCents: base - final,
          appliedPromotionTitle: percent ? 'Bot discount' : null,
        },
      ],
      hasOrderPromotion: false,
      hasNonPerUnitReward: false,
    });
    for (const mock of [
      h.saleRepo.runInTransaction,
      h.saleRepo.save,
      h.saleRepo.allocateNextFolio,
      h.saleRepo.persistChargeConfirmation,
      h.products.getApplicablePrices,
      h.products.decrementStockForCharge,
      h.usage.claimForSale,
      h.outbox.publish,
    ]) {
      expect(mock).not.toHaveBeenCalled();
    }
    if (customerId) {
      expect(h.customerFindUnique).toHaveBeenCalledWith({
        where: { id: customerId, tenantId: 'tenant' },
      });
    } else {
      expect(h.customerFindUnique).not.toHaveBeenCalled();
    }

    // Checkout creates a customer without a list before confirmation.
    const result = await h.service.confirmBotSale({
      customerId: 'customer',
      cashierUserId: 'cashier',
      items: preview.items.map((line) => ({
        ...line,
        productName: 'Product',
      })),
      expectedTotalCents: preview.items.reduce(
        (sum, line) => sum + line.finalPriceCents,
        0,
      ),
    });
    expect(result.totalCents).toBe(final);
    expect(result.discountCents).toBe(
      preview.items.reduce((sum, line) => sum + line.discountAmountCents, 0),
    );
    expect(h.saleRepo.persistChargeConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        totalCents: final,
        discountCents: base - final,
      }),
    );
    expect(h.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ botEligible: true }),
    );
  });

  it('rejects a vanished or foreign customer using the tenant-qualified lookup', async () => {
    const h = harness('customer-list');
    h.customerFindUnique.mockResolvedValue(null);
    await expect(
      h.service.previewBotPricing({ customerId: 'foreign', items: [item] }),
    ).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND' });
    expect(h.customerFindUnique).toHaveBeenCalledWith({
      where: { id: 'foreign', tenantId: 'tenant' },
    });
    expect(h.saleRepo.runInTransaction).not.toHaveBeenCalled();
  });

  it('does not quote the submitted price when no catalog price exists', async () => {
    const h = harness(null);
    h.products.batchResolvePriceMap.mockResolvedValue(new Map());
    await expect(
      h.service.previewBotPricing({ customerId: null, items: [item] }),
    ).rejects.toMatchObject({ code: 'PRICE_OUT_OF_DATE' });
    expect(h.saleRepo.runInTransaction).not.toHaveBeenCalled();
  });

  it.each(['buy-x-get-y', 'advanced', 'order'] as const)(
    'reports an applied %s reward for the bot safety guard',
    async (kind) => {
      const h = harness('customer-list');
      jest.spyOn(h.engine, 'evaluate').mockImplementation((input) =>
        Promise.resolve({
          lines:
            kind === 'order'
              ? []
              : [
                  {
                    kind,
                    itemId: input.lines[0].itemId,
                    promotionId: 'reward',
                    discountTitle: 'Reward',
                    lineDiscountCents: 100,
                    perUnitRewardCents: 100,
                    discountedUnitCount: 1,
                    getDiscountPercent: 20,
                  },
                ],
          order:
            kind === 'order'
              ? {
                  promotionId: 'order',
                  discountType: 'amount',
                  discountValue: 100,
                  discountTitle: 'Order',
                  discountAmountCents: 100,
                }
              : null,
          availableManualPromotions: [],
          targetableManualPromotionIds: [],
          promotionCapacityDemands: [],
          capacityExcludedPromotionIds: [],
        }),
      );
      const preview = await h.service.previewBotPricing({
        customerId: 'customer',
        items: [item],
      });
      expect(preview).toMatchObject({
        hasOrderPromotion: kind === 'order',
        hasNonPerUnitReward: kind !== 'order',
        items: [
          {
            unitPriceCents: 800,
            originalPriceCents: 800,
            finalPriceCents: kind === 'order' ? 800 : 700,
            discountAmountCents: kind === 'order' ? 0 : 100,
          },
        ],
      });
      expect(h.usage.claimForSale).not.toHaveBeenCalled();
    },
  );

  it('preserves input order and per-unit rounding for stacked duplicate lines', async () => {
    const h = harness('customer-list', 33);
    const preview = await h.service.previewBotPricing({
      customerId: 'customer',
      items: [{ ...item, quantity: 2 }, { ...item, productId: 'prod-2' }, item],
    });
    expect(
      preview.items.map((line) => [
        line.productId,
        line.quantity,
        line.unitPriceCents,
        line.finalPriceCents,
      ]),
    ).toEqual([
      ['prod-1', 2, 800, 1072],
      ['prod-2', 1, 800, 800],
      ['prod-1', 1, 800, 536],
    ]);
    const result = await h.service.confirmBotSale({
      customerId: 'customer',
      cashierUserId: 'cashier',
      items: preview.items.map((line) => ({ ...line, productName: 'Product' })),
      expectedTotalCents: 2408,
    });
    expect(result.totalCents).toBe(2408);
    expect(result.discountCents).toBe(792);
  });
});
