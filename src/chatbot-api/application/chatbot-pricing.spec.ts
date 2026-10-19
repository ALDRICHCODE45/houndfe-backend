import { ChatbotApiService } from './chatbot-api.service';
import { EvaluateCartPromotionsUseCase } from '../../promotions/application/evaluate-cart-promotions.use-case';
import { Promotion } from '../../promotions/domain/promotion.entity';
import type {
  CartEvaluationResult,
  CartItemForEvaluation,
} from '../../promotions/application/ports/evaluate-cart-promotions.port';

type Dependencies = ConstructorParameters<typeof ChatbotApiService>;
const item = {
  productId: 'product',
  variantId: null,
  quantity: 2,
  unitPriceCents: 1000,
};

describe('Chatbot customer-aware pricing', () => {
  it.each([
    {
      customers: [{ id: 'customer' }],
      phone: true,
      resolution: 'unique' as const,
      base: 800,
    },
    {
      customers: [],
      phone: true,
      resolution: 'not_found' as const,
      base: 1000,
    },
    {
      customers: [{ id: 'one' }, { id: 'two' }],
      phone: true,
      resolution: 'ambiguous' as const,
      base: 1000,
    },
    {
      customers: [],
      phone: false,
      resolution: 'not_provided' as const,
      base: 1000,
    },
  ])(
    '$resolution uses only the resolved customer or public price',
    async ({ customers, phone, resolution, base }) => {
      const findMany = jest.fn().mockResolvedValue(customers);
      const previewBotPricing = jest
        .fn()
        .mockImplementation((input: { customerId: string | null }) => {
          const unit = input.customerId ? 800 : 1000;
          return Promise.resolve({
            items: [
              {
                ...item,
                unitPriceCents: unit,
                originalPriceCents: unit * 2,
                finalPriceCents: unit * 2,
                discountAmountCents: 0,
                appliedPromotionTitle: null,
              },
            ],
          });
        });
      const snapshot = {
        findActiveAutomaticSnapshot: jest.fn().mockResolvedValue({
          promotions: [],
          complete: true,
        }),
      };
      const guard = new EvaluateCartPromotionsUseCase(snapshot as never);
      const service = new ChatbotApiService(
        {} as Dependencies[0],
        {} as Dependencies[1],
        guard,
        { previewBotPricing } as unknown as Dependencies[3],
        {} as Dependencies[4],
        {
          getTenantId: () => 'tenant',
          getClient: () => ({ customer: { findMany } }),
        } as unknown as Dependencies[5],
        {} as Dependencies[6],
      );
      const input: {
        items: CartItemForEvaluation[];
        phoneCountryCode?: string;
        phone?: string;
      } = {
        items: [item],
        ...(phone ? { phoneCountryCode: '52', phone: '5512345678' } : {}),
      };
      const result = await service.evaluateCart(input);
      expect(result).toEqual({
        items: [
          {
            ...item,
            unitPriceCents: base,
            originalPriceCents: base * 2,
            finalPriceCents: base * 2,
            discountAmountCents: 0,
            appliedPromotionTitle: null,
          },
        ],
        promotionEvaluationStatus: 'fully_evaluated',
        customerResolution: resolution,
      } satisfies CartEvaluationResult);
      expect(previewBotPricing).toHaveBeenCalledWith({
        items: [item],
        customerId: resolution === 'unique' ? 'customer' : null,
      });
      if (phone) {
        expect(findMany).toHaveBeenCalledWith({
          where: {
            tenantId: 'tenant',
            phoneCountryCode: '52',
            phone: '5512345678',
          },
          take: 2,
          select: { id: true },
        });
      } else {
        expect(findMany).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['incomplete', 'unsupported'] as const)(
    '%s review quotes keep the backend base, not the submitted price',
    async (reason) => {
      const promotion = Promotion.create({
        id: 'unsupported',
        title: 'Legacy rule',
        type: 'PRODUCT_DISCOUNT',
        method: 'AUTOMATIC',
        discountType: 'PERCENTAGE',
        discountValue: 20,
        botEligible: true,
        appliesTo: 'PRODUCTS',
      });
      // Model a legacy unsupported row, not a valid new promotion.
      Object.assign(promotion, { method: 'MANUAL' });
      const guard = new EvaluateCartPromotionsUseCase({
        findActiveAutomaticSnapshot: jest.fn().mockResolvedValue({
          promotions: reason === 'unsupported' ? [promotion] : [],
          complete: reason !== 'incomplete',
        }),
      } as never);
      const previewBotPricing = jest.fn().mockResolvedValue({
        items: [
          {
            ...item,
            unitPriceCents: 800,
            originalPriceCents: 1600,
            finalPriceCents: 1280,
            discountAmountCents: 320,
            appliedPromotionTitle: '20% off',
          },
        ],
      });
      const service = new ChatbotApiService(
        {} as Dependencies[0],
        {} as Dependencies[1],
        guard,
        { previewBotPricing } as unknown as Dependencies[3],
        {} as Dependencies[4],
        {
          getTenantId: () => 'tenant',
          getClient: () => ({
            customer: {
              findMany: jest.fn().mockResolvedValue([{ id: 'customer' }]),
            },
          }),
        } as unknown as Dependencies[5],
        {} as Dependencies[6],
      );
      await expect(
        service.evaluateCart({
          items: [item],
          phoneCountryCode: '52',
          phone: '5512345678',
        }),
      ).resolves.toEqual({
        items: [
          {
            ...item,
            unitPriceCents: 800,
            originalPriceCents: 1600,
            finalPriceCents: 1600,
            discountAmountCents: 0,
            appliedPromotionTitle: null,
          },
        ],
        promotionEvaluationStatus: 'needs_human_review',
        customerResolution: 'unique',
      });
    },
  );
});

describe('Chatbot cart line uniqueness', () => {
  it.each([
    [null, null],
    ['variant', 'variant'],
  ])(
    'rejects repeated product/variant lines (%s) before pricing',
    async (first, second) => {
      const previewBotPricing = jest.fn();
      const service = new ChatbotApiService(
        {} as Dependencies[0],
        {} as Dependencies[1],
        {} as Dependencies[2],
        { previewBotPricing } as unknown as Dependencies[3],
        {} as Dependencies[4],
        {} as Dependencies[5],
        {} as Dependencies[6],
      );
      await expect(
        service.evaluateCart({
          items: [
            { ...item, variantId: first },
            { ...item, variantId: second },
          ],
        }),
      ).rejects.toMatchObject({ code: 'DUPLICATE_CART_LINE' });
      expect(previewBotPricing).not.toHaveBeenCalled();
    },
  );
});
