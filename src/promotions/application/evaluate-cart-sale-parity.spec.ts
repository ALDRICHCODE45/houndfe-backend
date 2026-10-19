import { ConfigService } from '@nestjs/config';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Server } from 'node:http';
import { CheckoutController } from '../../chatbot-api/presentation/checkout.controller';
import type { CheckoutResponse } from '../../chatbot-api/presentation/dto/checkout.response';
import { ServiceAuthGuard } from '../../chatbot-api/presentation/guards/service-auth.guard';
import { BotAuditInterceptor } from '../../chatbot-api/presentation/interceptors/bot-audit.interceptor';
import { CheckoutService } from '../../chatbot-api/application/checkout.service';
import { ChatbotApiService } from '../../chatbot-api/application/chatbot-api.service';
import { SalesService } from '../../sales/sales.service';
import type { Sale } from '../../sales/domain/sale.entity';
import { Promotion } from '../domain/promotion.entity';
import type {
  CreatePromotionParams,
  PromotionTargetType,
} from '../domain/promotion.entity';
import { EvaluateCartPromotionsUseCase } from './evaluate-cart-promotions.use-case';
import type { IPromotionRepository } from '../domain/promotion.repository';
import { PosEvaluatePromotionsUseCase } from './pos-evaluate-promotions.use-case';

type Dependencies = ConstructorParameters<typeof SalesService>;

function harness(
  customerList: string | null,
  percent = 0,
  missingListPrice = false,
  appliesTo: PromotionTargetType = 'PRODUCTS',
  schedule: Pick<
    CreatePromotionParams,
    'daysOfWeek' | 'startDate' | 'endDate' | 'customerScope' | 'priceLists'
  > & { customers?: Promotion['customers'] } = {},
) {
  const promo = Promotion.create({
    id: 'promo',
    title: 'Bot discount',
    type: 'PRODUCT_DISCOUNT',
    method: 'AUTOMATIC',
    botEligible: true,
    appliesTo,
    discountType: 'PERCENTAGE',
    discountValue: percent || 20,
    ...schedule,
  });
  promo.customers = schedule.customers ?? [];
  promo.targetItems = [
    {
      id: 'target',
      side: 'DEFAULT',
      targetType: appliesTo,
      targetId: {
        PRODUCTS: 'prod-1',
        VARIANTS: 'variant-1',
        CATEGORIES: 'category-1',
        BRANDS: 'brand-1',
      }[appliesTo],
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
    resolveProductCategoryBrandIds: jest.fn().mockResolvedValue(
      new Map([
        ['prod-1', { categoryId: 'category-1', brandId: 'brand-1' }],
        ['prod-2', { categoryId: 'category-2', brandId: 'brand-2' }],
      ]),
    ),
    decrementStockForCharge: jest.fn().mockResolvedValue([]),
  };
  const customerFindUnique = jest.fn().mockResolvedValue({
    id: 'customer',
    globalPriceListId: customerList,
  });
  const addressFindUnique = jest
    .fn()
    .mockResolvedValue({ id: 'address', customerId: 'customer' });
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
        customerAddress: {
          findUnique: addressFindUnique,
        },
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
    promo,
    saleRepo,
    products,
    outbox,
    usage,
    findAll,
    customerFindUnique,
    addressFindUnique,
    engine,
  };
}

function quoteService(
  h: ReturnType<typeof harness>,
  customers: () => Array<{ id: string }>,
) {
  type Ports = ConstructorParameters<typeof ChatbotApiService>;
  return new ChatbotApiService(
    {} as Ports[0],
    {} as Ports[1],
    new EvaluateCartPromotionsUseCase({
      findActiveAutomaticSnapshot: jest
        .fn()
        .mockResolvedValue({ promotions: [h.promo], complete: true }),
    } as unknown as IPromotionRepository),
    h.service,
    {} as Ports[4],
    {
      getTenantId: () => 'tenant',
      getClient: () => ({
        customer: { findMany: jest.fn(() => Promise.resolve(customers())) },
      }),
    } as unknown as Ports[5],
    new ConfigService(),
  );
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
      scope: 'REGISTERED_ONLY',
      customerId: 'customer',
      list: null,
      restrictedList: null,
      discount: 200,
    },
    {
      scope: 'SPECIFIC',
      customerId: 'customer',
      list: null,
      restrictedList: null,
      discount: 200,
    },
    {
      scope: 'SPECIFIC',
      customerId: 'other',
      list: null,
      restrictedList: null,
      discount: 0,
    },
    {
      scope: 'ALL',
      customerId: 'customer',
      list: 'customer-list',
      restrictedList: 'customer-list',
      discount: 160,
    },
    {
      scope: 'ALL',
      customerId: 'customer',
      list: null,
      restrictedList: 'customer-list',
      discount: 0,
    },
    {
      scope: 'ALL',
      customerId: 'customer',
      list: 'customer-list',
      restrictedList: 'public',
      discount: 0,
    },
    {
      scope: 'ALL',
      customerId: 'customer',
      list: null,
      restrictedList: 'public',
      discount: 200,
    },
  ] as const)(
    'quotes and charges $scope / $customerId / $list restricted to $restrictedList',
    async ({ scope, customerId, list, restrictedList, discount }) => {
      const h = harness(list, 20, false, 'PRODUCTS', {
        customerScope: scope,
        customers: [{ id: 'customer-link', customerId: 'customer' }],
        priceLists: restrictedList
          ? [{ id: 'list-link', globalPriceListId: restrictedList }]
          : [],
      });
      const quote = await quoteService(h, () => [
        { id: customerId },
      ]).evaluateCart({
        phoneCountryCode: '52',
        phone: '5512345678',
        items: [item],
      });
      expect(quote.customerResolution).toBe('unique');
      expect(quote.promotionEvaluationStatus).toBe('fully_evaluated');
      expect(quote.items[0].discountAmountCents).toBe(discount);
      for (const line of quote.items) {
        expect(line.finalPriceCents + line.discountAmountCents).toBe(
          line.originalPriceCents,
        );
      }
      const result = await h.service.confirmBotSale({
        customerId,
        cashierUserId: 'cashier',
        items: quote.items.map((line) => ({ ...line, productName: 'Product' })),
        expectedTotalCents: quote.items[0].finalPriceCents,
      });
      expect(result.totalCents).toBe(quote.items[0].finalPriceCents);
      expect(result.discountCents).toBe(discount);
      const chargedLine = h.saleRepo.save.mock.calls.at(-1)![0].items[0];
      expect(chargedLine.subtotalCents).toBe(quote.items[0].finalPriceCents);
      expect(chargedLine.promotionId).toBe(discount ? 'promo' : null);
    },
  );

  it.each(['REGISTERED_ONLY', 'SPECIFIC'] as const)(
    'excludes %s without an identified customer for every public resolution',
    async (customerScope) => {
      const h = harness(null, 20, false, 'PRODUCTS', {
        customerScope,
        customers: [{ id: 'link', customerId: 'customer' }],
      });
      for (const resolution of ['not_found', 'ambiguous', 'not_provided']) {
        const customers =
          resolution === 'ambiguous'
            ? [{ id: 'customer' }, { id: 'other' }]
            : [];
        const quote = await quoteService(h, () => customers).evaluateCart({
          items: [item],
          ...(resolution !== 'not_provided'
            ? { phoneCountryCode: '52', phone: '5512345678' }
            : {}),
        });
        expect(quote.customerResolution).toBe(resolution);
        expect(quote.promotionEvaluationStatus).toBe('fully_evaluated');
        expect(quote.items[0]).toMatchObject({
          originalPriceCents: 1000,
          finalPriceCents: 1000,
          discountAmountCents: 0,
          appliedPromotionTitle: null,
        });
      }
      expect(h.customerFindUnique).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'checkout preserves quote pricing for an initially existing customer=%s and subsequent purchases',
    async (initiallyExisting) => {
      const h = harness(null, 20, false, 'PRODUCTS', {
        customerScope: 'REGISTERED_ONLY',
      });
      const productId = '10000000-0000-4000-8000-000000000001';
      const cashierUserId = '20000000-0000-4000-8000-000000000001';
      const customer = {
        id: '30000000-0000-4000-8000-000000000001',
        firstName: 'Ana',
        lastName: null,
        globalPriceListId: null,
      };
      h.promo.targetItems[0].targetId = productId;
      h.customerFindUnique.mockResolvedValue(customer);
      let exists = initiallyExisting;
      const address = {
        id: '40000000-0000-4000-8000-000000000001',
        customerId: customer.id,
        updatedAt: new Date('2026-10-19T18:00:00.000Z'),
      };
      h.addressFindUnique.mockResolvedValue(address);
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([{ acquired: true }]),
        saleIdempotency: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({}),
        },
        tenantMembership: {
          findFirst: jest.fn().mockResolvedValue({ id: 'membership' }),
        },
        customer: {
          findMany: jest.fn(() => Promise.resolve(exists ? [customer] : [])),
          create: jest.fn(() => {
            exists = true;
            return Promise.resolve(customer);
          }),
        },
        customerAddress: { create: jest.fn().mockResolvedValue(address) },
      };
      const tenant = {
        getTenantId: () => 'tenant',
        getClient: () => tx,
        runInTransaction: <T>(work: () => Promise<T>) => work(),
      };
      const checkout = new CheckoutService(
        tenant as unknown as ConstructorParameters<typeof CheckoutService>[0],
        h.service,
        new ConfigService(),
      );
      const confirm = jest.spyOn(h.service, 'confirmBotSale');
      const quotes = quoteService(h, () => (exists ? [customer] : []));
      // Authentication is outside this pricing proof; request parsing and HTTP status are real.
      const module = await Test.createTestingModule({
        controllers: [CheckoutController],
        providers: [{ provide: CheckoutService, useValue: checkout }],
      })
        .overrideGuard(ServiceAuthGuard)
        .useValue({ canActivate: () => true })
        .overrideInterceptor(BotAuditInterceptor)
        .useValue({
          intercept: (_context: ExecutionContext, next: CallHandler) =>
            next.handle(),
        })
        .compile();
      const app = module.createNestApplication();
      await app.init();
      try {
        for (let purchase = 0; purchase < 2; purchase++) {
          const quote = await quotes.evaluateCart({
            phoneCountryCode: '52',
            phone: '5512345678',
            items: [{ ...item, productId }],
          });
          const created = !initiallyExisting && purchase === 0;
          expect(quote.customerResolution).toBe(
            created ? 'not_found' : 'unique',
          );
          expect(quote.promotionEvaluationStatus).toBe('fully_evaluated');
          const expectedTotalCents = created ? 1000 : 800;
          expect(quote.items[0].finalPriceCents).toBe(expectedTotalCents);
          const http = await request(app.getHttpServer() as Server)
            .post('/chatbot-api/checkouts')
            .set('X-Idempotency-Key', `purchase-${purchase}`)
            .send({
              phoneCountryCode: '52',
              phone: '5512345678',
              customer: initiallyExisting
                ? { mode: 'existing', customerId: customer.id }
                : { mode: 'createIfAbsent', firstName: 'Ana' },
              deliveryAddress: {
                mode: 'newSaved',
                address: { street: 'Fixture Street' },
              },
              sale: {
                cashierUserId,
                items: quote.items.map((line) => ({
                  productId: line.productId,
                  variantId: line.variantId,
                  quantity: line.quantity,
                  unitPriceCents: line.unitPriceCents,
                  productName: 'Product',
                })),
                expectedTotalCents,
              },
            });
          expect(http.status).toBe(201);
          const response = http.body as CheckoutResponse;
          expect(response.status).toBe('created');
          expect(response.customer.resolution).toBe(
            created ? 'created' : 'existing',
          );
          expect(response.sale.totalCents).toBe(expectedTotalCents);
          expect(response.sale.discountCents).toBe(created ? 0 : 200);
          const confirmationInput = confirm.mock.calls.at(-1)![0];
          if (created) {
            expect(confirmationInput).toHaveProperty(
              'excludeRegisteredOnlyPromotions',
              true,
            );
          } else {
            expect(confirmationInput).not.toHaveProperty(
              'excludeRegisteredOnlyPromotions',
            );
          }
          const chargedLine = h.saleRepo.save.mock.calls.at(-1)![0].items[0];
          expect(chargedLine.subtotalCents).toBe(expectedTotalCents);
          expect(chargedLine.promotionId).toBe(created ? null : 'promo');
        }
        expect(tx.customer.create).toHaveBeenCalledTimes(
          initiallyExisting ? 0 : 1,
        );
      } finally {
        await app.close();
      }
    },
  );

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

  it.each(['VARIANTS', 'CATEGORIES', 'BRANDS'] as const)(
    'quotes and charges the same eligible %s discount only on matching lines',
    async (appliesTo) => {
      const h = harness(null, 20, false, appliesTo);
      const preview = await h.service.previewBotPricing({
        customerId: 'customer',
        items: [
          { ...item, variantId: 'variant-1', quantity: 2 },
          {
            ...item,
            productId: appliesTo === 'VARIANTS' ? 'prod-1' : 'prod-2',
            variantId: 'variant-2',
          },
        ],
      });
      const guard = new EvaluateCartPromotionsUseCase({
        findActiveAutomaticSnapshot: jest.fn().mockResolvedValue({
          promotions: [h.promo],
          complete: true,
        }),
      } as unknown as IPromotionRepository);
      await expect(guard.execute(preview)).resolves.toEqual({
        items: preview.items,
        promotionEvaluationStatus: 'fully_evaluated',
      });
      expect(preview).toMatchObject({
        items: [
          {
            unitPriceCents: 1000,
            originalPriceCents: 2000,
            finalPriceCents: 1600,
            discountAmountCents: 400,
            appliedPromotionTitle: 'Bot discount',
          },
          {
            unitPriceCents: 1000,
            originalPriceCents: 1000,
            finalPriceCents: 1000,
            discountAmountCents: 0,
            appliedPromotionTitle: null,
          },
        ],
        hasOrderPromotion: false,
        hasNonPerUnitReward: false,
      });
      for (const line of preview.items) {
        expect(line.finalPriceCents + line.discountAmountCents).toBe(
          line.originalPriceCents,
        );
      }
      const expectedTotalCents = preview.items.reduce(
        (sum, line) => sum + line.finalPriceCents,
        0,
      );
      const result = await h.service.confirmBotSale({
        customerId: 'customer',
        cashierUserId: 'cashier',
        items: preview.items.map((line) => ({
          ...line,
          productName: 'Product',
        })),
        expectedTotalCents,
      });
      expect(result.totalCents).toBe(expectedTotalCents);
      expect(result.discountCents).toBe(400);
      const chargedSale = h.saleRepo.save.mock.calls.at(-1)![0];
      expect(
        chargedSale.items.map((line) => [
          line.subtotalCents,
          (line.discountAmountCents ?? 0) * line.quantity,
        ]),
      ).toEqual(
        preview.items.map((line) => [
          line.finalPriceCents,
          line.discountAmountCents,
        ]),
      );
      expect(h.saleRepo.persistChargeConfirmation).toHaveBeenCalledWith(
        expect.objectContaining({
          totalCents: expectedTotalCents,
          discountCents: 400,
        }),
      );
      expect(h.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ botEligible: true }),
      );
    },
  );

  describe('weekday and date-window parity in the business timezone', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it.each([
      {
        name: 'allowed Monday',
        now: '2026-10-19T18:00:00.000Z',
        day: 'MONDAY',
        discount: 400,
      },
      {
        name: 'disallowed Tuesday',
        now: '2026-10-20T18:00:00.000Z',
        day: 'MONDAY',
        discount: 0,
      },
      {
        name: 'Monday in Mexico City while UTC is already Tuesday',
        now: '2026-10-20T00:30:00.000Z',
        day: 'MONDAY',
        discount: 400,
      },
      {
        name: 'UTC Tuesday does not activate a local Tuesday promotion on Monday',
        now: '2026-10-20T00:30:00.000Z',
        day: 'TUESDAY',
        discount: 0,
      },
      {
        name: 'future date window',
        now: '2026-10-19T18:00:00.000Z',
        startDate: '2026-10-19T18:00:00.001Z',
        discount: 0,
      },
      {
        name: 'expired date window',
        now: '2026-10-19T18:00:00.000Z',
        endDate: '2026-10-19T17:59:59.999Z',
        discount: 0,
      },
      {
        name: 'inclusive start date',
        now: '2026-10-19T18:00:00.000Z',
        startDate: '2026-10-19T18:00:00.000Z',
        discount: 400,
      },
      {
        name: 'inclusive end date',
        now: '2026-10-19T18:00:00.000Z',
        endDate: '2026-10-19T18:00:00.000Z',
        discount: 400,
      },
    ] as const)('$name', async (testCase) => {
      jest.setSystemTime(new Date(testCase.now));
      const h = harness(null, 20, false, 'PRODUCTS', {
        daysOfWeek: testCase.day ? [{ id: 'day-1', day: testCase.day }] : [],
        startDate: testCase.startDate ? new Date(testCase.startDate) : null,
        endDate: testCase.endDate ? new Date(testCase.endDate) : null,
      });
      const preview = await h.service.previewBotPricing({
        customerId: 'customer',
        items: [
          { ...item, quantity: 2 },
          { ...item, productId: 'prod-2' },
        ],
      });
      const guard = new EvaluateCartPromotionsUseCase({
        findActiveAutomaticSnapshot: jest.fn().mockResolvedValue({
          promotions: [h.promo],
          complete: true,
        }),
      } as unknown as IPromotionRepository);
      const quote = await guard.execute(preview);
      expect(quote.promotionEvaluationStatus).toBe('fully_evaluated');
      expect(quote.items.map((line) => line.discountAmountCents)).toEqual([
        testCase.discount,
        0,
      ]);
      expect(quote.items[0].appliedPromotionTitle).toBe(
        testCase.discount ? 'Bot discount' : null,
      );
      for (const line of quote.items) {
        expect(line.finalPriceCents + line.discountAmountCents).toBe(
          line.originalPriceCents,
        );
      }
      const expectedTotalCents = 3000 - testCase.discount;
      expect(
        quote.items.reduce((sum, line) => sum + line.finalPriceCents, 0),
      ).toBe(expectedTotalCents);
      const result = await h.service.confirmBotSale({
        customerId: 'customer',
        cashierUserId: 'cashier',
        items: quote.items.map((line) => ({ ...line, productName: 'Product' })),
        expectedTotalCents,
      });
      expect(result.totalCents).toBe(expectedTotalCents);
      expect(result.discountCents).toBe(testCase.discount);
      const chargedSale = h.saleRepo.save.mock.calls.at(-1)![0];
      expect(
        chargedSale.items.map((line) => [
          line.subtotalCents,
          (line.discountAmountCents ?? 0) * line.quantity,
        ]),
      ).toEqual(
        quote.items.map((line) => [
          line.finalPriceCents,
          line.discountAmountCents,
        ]),
      );
      expect(h.saleRepo.persistChargeConfirmation).toHaveBeenCalledWith(
        expect.objectContaining({
          totalCents: expectedTotalCents,
          discountCents: testCase.discount,
        }),
      );
      expect(h.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ botEligible: true }),
      );
    });
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
