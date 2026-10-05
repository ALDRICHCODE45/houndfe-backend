import { ConfigService } from '@nestjs/config';
import { SalesService } from './sales.service';
import { Sale } from './domain/sale.entity';
import { Promotion } from '../promotions/domain/promotion.entity';
import type { IPromotionRepository } from '../promotions/domain/promotion.repository';
import { PosEvaluatePromotionsUseCase } from '../promotions/application/pos-evaluate-promotions.use-case';

// Real application services and aggregates; only data/provider boundaries are mocked.
// No AppModule, Prisma client instance, HTTP server, or database is started.
type Dependencies = ConstructorParameters<typeof SalesService>;
type PromotionProps = Parameters<typeof Promotion.fromPersistence>[0];
const NOW = new Date('2026-06-15T02:00:00.000Z'); // Sunday in Mexico City.

function promotion(overrides: Partial<PromotionProps> = {}): Promotion {
  return Promotion.fromPersistence({
    id: 'promo',
    title: 'Eligibility',
    type: 'ORDER_DISCOUNT',
    method: 'AUTOMATIC',
    status: 'ACTIVE',
    startDate: null,
    endDate: null,
    customerScope: 'ALL',
    discountType: 'PERCENTAGE',
    discountValue: 10,
    minPurchaseAmountCents: null,
    appliesTo: null,
    buyQuantity: null,
    getQuantity: null,
    getDiscountPercent: null,
    buyTargetType: null,
    getTargetType: null,
    createdAt: NOW,
    updatedAt: NOW,
    targetItems: [],
    customers: [],
    priceLists: [{ id: 'restriction', globalPriceListId: 'allowed' }],
    daysOfWeek: [],
    ...overrides,
  });
}

function harness(
  promo: Promotion,
  globals: [string | null, string | null],
  timezone = 'America/Mexico_City',
) {
  const sale = Sale.create({ id: 'sale', userId: 'cashier' });
  for (const [index, productId] of ['buy', 'get'].entries()) {
    sale.addItem({
      id: productId,
      saleId: 'sale',
      productId,
      variantId: null,
      productName: productId,
      variantName: null,
      quantity: 1,
      unitPriceCents: 1000,
      unitPriceCurrency: 'MXN',
      appliedPriceListId: `row-${index}`,
      priceSource: 'price_list',
    });
  }
  const snapshots: ReturnType<Sale['toResponse']>[] = [];
  const saleRepo = {
    findById: jest.fn().mockResolvedValue(sale),
    saveDraftItems: jest.fn((value: Sale) => {
      snapshots.push(value.toResponse());
      return Promise.resolve();
    }),
  };
  const products = {
    checkStockAvailability: jest
      .fn()
      .mockResolvedValue({ available: true, currentStock: 100 }),
    batchResolvePriceMap: jest.fn().mockResolvedValue(new Map()),
    resolvePriceListGlobalIds: jest
      .fn()
      .mockResolvedValue(
        new Map(
          globals.flatMap((id, i) => (id === null ? [] : [[`row-${i}`, id]])),
        ),
      ),
    resolveProductCategoryBrandIds: jest.fn().mockResolvedValue(
      new Map([
        ['buy', { categoryId: null, brandId: 'buy-brand' }],
        ['get', { categoryId: null, brandId: 'get-brand' }],
      ]),
    ),
  };
  const findAll = jest.fn().mockResolvedValue({ data: [promo], total: 1 });
  const evaluator = new PosEvaluatePromotionsUseCase(
    { findAll } as unknown as IPromotionRepository,
    new ConfigService({ PROMOTIONS_BUSINESS_TIMEZONE: timezone }),
  );
  const events = { emit: jest.fn() };
  const service = new SalesService(
    saleRepo as unknown as Dependencies[0],
    products as unknown as Dependencies[1],
    events as unknown as Dependencies[2],
    {} as Dependencies[3],
    {
      getClient: () => ({
        globalPriceList: { findFirst: jest.fn().mockResolvedValue(null) },
      }),
    } as unknown as Dependencies[4],
    {} as Dependencies[5],
    evaluator,
    {} as Dependencies[7],
    {} as Dependencies[8],
  );
  return { service, saleRepo, products, findAll, snapshots, events };
}

describe('SalesService with the real POS promotion evaluator', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([
    ['matching', 'allowed', 'allowed', true, 300],
    ['mixed', 'allowed', 'other', true, 0],
    ['unresolved', 'allowed', null, true, 0],
    ['unrestricted', 'other', null, false, 300],
  ] as const)(
    'ORDER %s: resolves row IDs before applying and saving totals',
    async (_name, buyList, getList, restricted, discount) => {
      const h = harness(
        promotion({
          priceLists: restricted
            ? [{ id: 'pl', globalPriceListId: 'allowed' }]
            : [],
        }),
        [buyList, getList],
      );
      const result = await h.service.updateItemQuantity(
        'sale',
        'cashier',
        'buy',
        { quantity: 2 },
      );
      expect(result).toMatchObject({
        subtotalCents: 3000,
        discountCents: discount,
        totalCents: 3000 - discount,
      });
      expect(result.items.map((item) => item.promotionId)).toEqual([
        null,
        null,
      ]);
      expect(h.products.resolvePriceListGlobalIds).toHaveBeenCalledWith([
        'row-0',
        'row-1',
      ]);
      expect(h.saleRepo.saveDraftItems).toHaveBeenCalledTimes(1);
      expect(h.snapshots).toEqual([result]);
      expect(h.findAll).toHaveBeenCalledTimes(1);
      expect(h.events.emit).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['brand to product', 'BRANDS', 'PRODUCTS', 'allowed', 'allowed', 500],
    ['product to brand', 'PRODUCTS', 'BRANDS', 'allowed', 'allowed', 500],
    ['wrong BUY list', 'BRANDS', 'PRODUCTS', 'other', 'allowed', 0],
    ['wrong GET list', 'PRODUCTS', 'BRANDS', 'allowed', 'other', 0],
    ['unresolved BUY', 'BRANDS', 'PRODUCTS', null, 'allowed', 0],
    ['unresolved GET', 'PRODUCTS', 'BRANDS', 'allowed', null, 0],
  ] as const)(
    'ADVANCED %s: applies the real reward and clears it below threshold',
    async (_name, buyType, getType, buyList, getList, discount) => {
      const h = harness(
        promotion({
          type: 'ADVANCED',
          discountType: null,
          discountValue: null,
          buyQuantity: 2,
          getQuantity: 1,
          getDiscountPercent: 50,
          buyTargetType: buyType,
          getTargetType: getType,
          targetItems: [
            {
              id: 'buy-target',
              side: 'BUY',
              targetType: buyType,
              targetId: buyType === 'BRANDS' ? 'buy-brand' : 'buy',
            },
            {
              id: 'get-target',
              side: 'GET',
              targetType: getType,
              targetId: getType === 'BRANDS' ? 'get-brand' : 'get',
            },
          ],
        }),
        [buyList, getList],
      );
      const result = await h.service.updateItemQuantity(
        'sale',
        'cashier',
        'buy',
        { quantity: 2 },
      );
      expect(result).toMatchObject({
        subtotalCents: 3000,
        discountCents: discount,
        totalCents: 3000 - discount,
      });
      expect(result.items.find((item) => item.id === 'buy')).toMatchObject({
        promotionId: null,
        rewardKind: null,
      });
      expect(result.items.find((item) => item.id === 'get')).toMatchObject({
        unitPriceCents: 1000,
        promotionId: discount ? 'promo' : null,
        rewardKind: discount ? 'advanced' : null,
        rewardDiscountPercent: discount ? 50 : null,
        discountAmountCents: discount || null,
      });
      expect(h.products.resolveProductCategoryBrandIds).toHaveBeenCalledWith([
        'buy',
        'get',
      ]);
      expect(h.snapshots[0]).toEqual(result);
      const below = await h.service.updateItemQuantity(
        'sale',
        'cashier',
        'buy',
        { quantity: 1 },
      );
      expect(below).toMatchObject({
        subtotalCents: 2000,
        discountCents: 0,
        totalCents: 2000,
      });
      expect(
        below.items.map((item) => ({
          promotionId: item.promotionId,
          rewardKind: item.rewardKind,
          rewardDiscountPercent: item.rewardDiscountPercent,
        })),
      ).toEqual([
        { promotionId: null, rewardKind: null, rewardDiscountPercent: null },
        { promotionId: null, rewardKind: null, rewardDiscountPercent: null },
      ]);
      expect(h.snapshots).toEqual([result, below]);
      expect(h.saleRepo.saveDraftItems).toHaveBeenCalledTimes(2);
      expect(h.findAll).toHaveBeenCalledTimes(2);
      expect(h.events.emit).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ['America/Mexico_City', 300],
    ['UTC', 0],
  ] as const)(
    'forwards the actual clock and respects Sunday in %s',
    async (timezone, discount) => {
      const h = harness(
        promotion({ daysOfWeek: [{ id: 'sunday', day: 'SUNDAY' }] }),
        ['allowed', 'allowed'],
        timezone,
      );
      const result = await h.service.updateItemQuantity(
        'sale',
        'cashier',
        'buy',
        { quantity: 2 },
      );
      expect(result).toMatchObject({
        subtotalCents: 3000,
        discountCents: discount,
        totalCents: 3000 - discount,
      });
      expect(h.snapshots).toEqual([result]);
      expect(h.saleRepo.saveDraftItems).toHaveBeenCalledTimes(1);
    },
  );
});
