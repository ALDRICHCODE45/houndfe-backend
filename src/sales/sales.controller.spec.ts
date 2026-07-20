/**
 * SalesController — HTTP Layer Tests
 *
 * Tests for REST API endpoints: POST /sales/drafts, POST /sales/drafts/:id/items,
 * PATCH /sales/drafts/:id/items/:itemId, DELETE /sales/drafts/:id/items,
 * DELETE /sales/drafts/:id, GET /sales/drafts.
 */
import { SalesController } from './sales.controller';
import type { SalesService } from './sales.service';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';

// ── Minimal mocks ──────────────────────────────────────────────────────

function makeMockSalesService() {
  return {
    openDraft: jest.fn(),
    addItem: jest.fn(),
    updateItemQuantity: jest.fn(),
    removeItem: jest.fn(),
    clearItems: jest.fn(),
    deleteDraft: jest.fn(),
    getUserDrafts: jest.fn(),
    getAvailablePrices: jest.fn(),
    overrideItemPrice: jest.fn(),
    applyItemDiscount: jest.fn(),
    removeItemDiscount: jest.fn(),
    applyGlobalDiscount: jest.fn(),
    removeGlobalDiscount: jest.fn(),
    chargeDraft: jest.fn(),
    assignCustomer: jest.fn(),
    clearCustomer: jest.fn(),
    setShippingAddress: jest.fn(),
    clearShippingAddress: jest.fn(),
    listApplicablePromotions: jest.fn(),
    applyManualPromotion: jest.fn(),
    removeManualPromotion: jest.fn(),
    removeAppliedPromotion: jest.fn(),
    // WU3 — POS Price List Tiers.
    setSalePriceList: jest.fn(),
  } as any;
}

function makeMockUser(userId: string): AuthenticatedUser {
  return {
    userId,
    email: `${userId}@test.com`,
    tenantId: null,
    tenantSlug: null,
    isSuperAdmin: false,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('SalesController', () => {
  let service: ReturnType<typeof makeMockSalesService>;
  let controller: SalesController;

  beforeEach(() => {
    service = makeMockSalesService();
    controller = new SalesController(service);
  });

  describe('POST /sales/drafts', () => {
    it('should create a new draft sale', async () => {
      const mockDraft = {
        id: 'sale-1',
        userId: 'user-1',
        status: 'DRAFT',
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      service.openDraft.mockResolvedValue(mockDraft);

      const user = makeMockUser('user-1');
      const result = await controller.openDraft(user);

      expect(result).toEqual(mockDraft);
      expect(service.openDraft).toHaveBeenCalledWith('user-1');
    });
  });

  describe('POST /sales/drafts/:id/items', () => {
    it('should add item to draft', async () => {
      const mockSale = {
        id: 'sale-2',
        userId: 'user-1',
        status: 'DRAFT',
        items: [
          {
            id: 'item-1',
            productId: 'prod-1',
            variantId: null,
            productName: 'Product 1',
            variantName: null,
            quantity: 2,
            unitPriceCents: 1000,
            unitPriceCurrency: 'MXN',
          },
        ],
      };

      service.addItem.mockResolvedValue(mockSale);

      const user = makeMockUser('user-1');
      const dto = { productId: 'prod-1', variantId: null, quantity: 2 };
      const result = await controller.addItem('sale-2', dto, user);

      expect(result).toEqual(mockSale);
      expect(service.addItem).toHaveBeenCalledWith('sale-2', 'user-1', dto);
    });
  });

  describe('PATCH /sales/drafts/:id/items/:itemId', () => {
    it('should update item quantity', async () => {
      const mockSale = {
        id: 'sale-3',
        userId: 'user-1',
        status: 'DRAFT',
        items: [
          {
            id: 'item-2',
            productId: 'prod-2',
            quantity: 10,
          },
        ],
      };

      service.updateItemQuantity.mockResolvedValue(mockSale);

      const user = makeMockUser('user-1');
      const dto = { quantity: 10 };
      const result = await controller.updateItemQuantity(
        'sale-3',
        'item-2',
        dto,
        user,
      );

      expect(result).toEqual(mockSale);
      expect(service.updateItemQuantity).toHaveBeenCalledWith(
        'sale-3',
        'user-1',
        'item-2',
        dto,
      );
    });
  });

  describe('DELETE /sales/drafts/:id/items', () => {
    it('should clear all items from draft', async () => {
      const mockSale = {
        id: 'sale-4',
        userId: 'user-1',
        status: 'DRAFT',
        items: [],
      };

      service.clearItems.mockResolvedValue(mockSale);

      const user = makeMockUser('user-1');
      const result = await controller.clearItems('sale-4', user);

      expect(result).toEqual(mockSale);
      expect(service.clearItems).toHaveBeenCalledWith('sale-4', 'user-1');
    });
  });

  describe('DELETE /sales/drafts/:id/items/:itemId', () => {
    it('should delegate single-item deletion to service and forward response', async () => {
      const mockSale = {
        id: 'sale-4b',
        userId: 'user-1',
        status: 'DRAFT',
        items: [
          {
            id: 'item-remaining',
            productId: 'prod-remaining',
            quantity: 1,
          },
        ],
      };

      service.removeItem.mockResolvedValue(mockSale);

      const user = makeMockUser('user-1');
      const result = await controller.removeItem(
        'sale-4b',
        'item-removed',
        user,
      );

      expect(result).toEqual(mockSale);
      expect(service.removeItem).toHaveBeenCalledWith(
        'sale-4b',
        'user-1',
        'item-removed',
      );
    });
  });

  describe('DELETE /sales/drafts/:id', () => {
    it('should delete a draft', async () => {
      service.deleteDraft.mockResolvedValue(undefined);

      const user = makeMockUser('user-1');
      const result = await controller.deleteDraft('sale-5', user);

      expect(result).toBeUndefined();
      expect(service.deleteDraft).toHaveBeenCalledWith('sale-5', 'user-1');
    });
  });

  describe('GET /sales/drafts', () => {
    it('should return all user drafts', async () => {
      const mockDrafts = [
        {
          id: 'sale-6',
          userId: 'user-1',
          status: 'DRAFT',
          items: [],
        },
        {
          id: 'sale-7',
          userId: 'user-1',
          status: 'DRAFT',
          items: [],
        },
      ];

      service.getUserDrafts.mockResolvedValue(mockDrafts);

      const user = makeMockUser('user-1');
      const result = await controller.getUserDrafts(user);

      expect(result).toEqual(mockDrafts);
      expect(service.getUserDrafts).toHaveBeenCalledWith('user-1');
    });
  });

  describe('GET /sales/drafts/:id/items/:itemId/available-prices', () => {
    it('should delegate to service', async () => {
      service.getAvailablePrices.mockResolvedValue({
        saleId: 's',
        itemId: 'i',
        prices: [],
      });
      const user = makeMockUser('user-1');
      const result = await controller.getAvailablePrices('s', 'i', user);
      expect(result).toEqual({ saleId: 's', itemId: 'i', prices: [] });
      expect(service.getAvailablePrices).toHaveBeenCalledWith(
        's',
        'i',
        'user-1',
      );
    });
  });

  describe('PATCH /sales/drafts/:id/items/:itemId/price', () => {
    it('should delegate price override to service', async () => {
      service.overrideItemPrice.mockResolvedValue({ id: 's', items: [] });
      const user = makeMockUser('user-1');
      const dto = { customPriceCents: 1200 };
      const result = await controller.overrideItemPrice(
        's',
        'i',
        dto as any,
        user,
      );
      expect(result).toEqual({ id: 's', items: [] });
      expect(service.overrideItemPrice).toHaveBeenCalledWith(
        's',
        'i',
        dto,
        'user-1',
      );
    });
  });

  describe('PATCH /sales/drafts/:id/items/:itemId/discount', () => {
    it('should delegate discount apply to service', async () => {
      service.applyItemDiscount.mockResolvedValue({ id: 's', items: [] });
      const user = makeMockUser('user-1');
      const dto = { type: 'amount', amountCents: 100, discountTitle: 'promo' };
      const result = await controller.applyItemDiscount(
        's',
        'i',
        dto as any,
        user,
      );
      expect(result).toEqual({ id: 's', items: [] });
      expect(service.applyItemDiscount).toHaveBeenCalledWith(
        's',
        'i',
        dto,
        'user-1',
      );
    });
  });

  describe('DELETE /sales/drafts/:id/items/:itemId/discount', () => {
    it('should delegate discount removal to service', async () => {
      service.removeItemDiscount.mockResolvedValue({ id: 's', items: [] });
      const user = makeMockUser('user-1');
      const result = await controller.removeItemDiscount('s', 'i', user);
      expect(result).toEqual({ id: 's', items: [] });
      expect(service.removeItemDiscount).toHaveBeenCalledWith(
        's',
        'i',
        'user-1',
      );
    });
  });

  describe('PATCH /sales/drafts/:id/discount', () => {
    it('should delegate global discount apply to service', async () => {
      service.applyGlobalDiscount.mockResolvedValue({
        sale: { id: 's', items: [] },
        skippedItems: [],
      });

      const user = makeMockUser('user-1');
      const dto = { type: 'percentage', percent: 10 };
      const result = await controller.applyGlobalDiscount(
        's',
        dto as any,
        user,
      );

      expect(result).toEqual({
        sale: { id: 's', items: [] },
        skippedItems: [],
      });
      expect(service.applyGlobalDiscount).toHaveBeenCalledWith(
        's',
        dto,
        'user-1',
      );
    });
  });

  describe('DELETE /sales/drafts/:id/discount', () => {
    it('should delegate global discount removal to service', async () => {
      service.removeGlobalDiscount.mockResolvedValue({ id: 's', items: [] });

      const user = makeMockUser('user-1');
      const result = await controller.removeGlobalDiscount('s', user);

      expect(result).toEqual({ id: 's', items: [] });
      expect(service.removeGlobalDiscount).toHaveBeenCalledWith('s', 'user-1');
    });
  });

  describe('POST /sales/drafts/:id/charge', () => {
    it('should delegate charge to service with idempotency key', async () => {
      service.chargeDraft.mockResolvedValue({
        saleId: 'sale-1',
        folio: 'A-2605-000001',
        totalCents: 1500,
        paidCents: 1500,
        debtCents: 0,
        changeDueCents: 0,
        paymentStatus: 'PAID',
        confirmedAt: new Date().toISOString(),
      });

      const user = makeMockUser('user-1');
      const dto = { method: 'cash', amountCents: 1500 };
      const result = await controller.chargeDraft(
        'sale-1',
        dto as any,
        'idem-1',
        user,
      );

      expect(result).toEqual(
        expect.objectContaining({
          saleId: 'sale-1',
          folio: 'A-2605-000001',
        }),
      );
      expect(service.chargeDraft).toHaveBeenCalledWith(
        'sale-1',
        'user-1',
        dto,
        'idem-1',
      );
    });

    it('should reject missing idempotency key header', async () => {
      const user = makeMockUser('user-1');

      expect(() =>
        controller.chargeDraft(
          '6f4f4d42-3e8d-44e3-bd05-496ff67a7a6a',
          { method: 'cash', amountCents: 1500 } as any,
          undefined as any,
          user,
        ),
      ).toThrow('IDEMPOTENCY_KEY_REQUIRED');

      expect(service.chargeDraft).not.toHaveBeenCalled();
    });

    it('should forward payments[] shape to service', async () => {
      service.chargeDraft.mockResolvedValue({
        saleId: 'sale-1',
        folio: 'A-2605-000002',
        totalCents: 2000,
        paidCents: 2000,
        debtCents: 0,
        changeDueCents: 0,
        paymentStatus: 'PAID',
        confirmedAt: new Date().toISOString(),
      });

      const user = makeMockUser('user-1');
      const dto = {
        payments: [
          { method: 'cash', amountCents: 1000 },
          { method: 'card_debit', amountCents: 1000, reference: 'REF-1' },
        ],
      };

      await controller.chargeDraft(
        'sale-1',
        dto as never,
        'idem-array-1',
        user,
      );

      expect(service.chargeDraft).toHaveBeenCalledWith(
        'sale-1',
        'user-1',
        dto,
        'idem-array-1',
      );
    });
  });

  describe('draft customer and shipping address endpoints', () => {
    it('assignCustomer delegates and returns response', async () => {
      const user = makeMockUser('user-1');
      const dto = {
        customerId: 'f9d2f368-10be-4f4b-a3cc-0e67735f7f26',
        shippingAddressId: '8f311d31-131f-449a-8a15-6a3257b0d865',
      };
      service.assignCustomer.mockResolvedValue({
        id: 'sale-1',
        customer: { id: dto.customerId },
      });

      const result = await controller.assignCustomer('sale-1', dto, user);
      expect(result).toEqual({
        id: 'sale-1',
        customer: { id: dto.customerId },
      });
      expect(service.assignCustomer).toHaveBeenCalledWith(
        'sale-1',
        'user-1',
        dto,
      );
    });

    it('assignCustomer forwards service errors', async () => {
      const user = makeMockUser('user-1');
      const dto = { customerId: 'f9d2f368-10be-4f4b-a3cc-0e67735f7f26' };
      service.assignCustomer.mockRejectedValue(new Error('CUSTOMER_NOT_FOUND'));

      await expect(
        controller.assignCustomer('sale-1', dto, user),
      ).rejects.toThrow('CUSTOMER_NOT_FOUND');
    });

    it('clearCustomer delegates to service', async () => {
      const user = makeMockUser('user-1');
      service.clearCustomer.mockResolvedValue(undefined);

      const result = await controller.clearCustomer('sale-1', user);
      expect(result).toBeUndefined();
      expect(service.clearCustomer).toHaveBeenCalledWith('sale-1', 'user-1');
    });

    it('clearCustomer forwards service errors', async () => {
      const user = makeMockUser('user-1');
      service.clearCustomer.mockRejectedValue(new Error('SALE_NOT_DRAFT'));

      await expect(controller.clearCustomer('sale-1', user)).rejects.toThrow(
        'SALE_NOT_DRAFT',
      );
    });

    it('setShippingAddress delegates and returns response', async () => {
      const user = makeMockUser('user-1');
      const dto = { shippingAddressId: '8f311d31-131f-449a-8a15-6a3257b0d865' };
      service.setShippingAddress.mockResolvedValue({
        id: 'sale-1',
        shippingAddress: { id: dto.shippingAddressId },
      });

      const result = await controller.setShippingAddress('sale-1', dto, user);
      expect(result).toEqual({
        id: 'sale-1',
        shippingAddress: { id: dto.shippingAddressId },
      });
      expect(service.setShippingAddress).toHaveBeenCalledWith(
        'sale-1',
        'user-1',
        dto,
      );
    });

    it('setShippingAddress forwards service errors', async () => {
      const user = makeMockUser('user-1');
      const dto = { shippingAddressId: '8f311d31-131f-449a-8a15-6a3257b0d865' };
      service.setShippingAddress.mockRejectedValue(
        new Error('SHIPPING_ADDRESS_NOT_FOR_CUSTOMER'),
      );

      await expect(
        controller.setShippingAddress('sale-1', dto, user),
      ).rejects.toThrow('SHIPPING_ADDRESS_NOT_FOR_CUSTOMER');
    });

    it('clearShippingAddress delegates to service', async () => {
      const user = makeMockUser('user-1');
      service.clearShippingAddress.mockResolvedValue(undefined);

      const result = await controller.clearShippingAddress('sale-1', user);
      expect(result).toBeUndefined();
      expect(service.clearShippingAddress).toHaveBeenCalledWith(
        'sale-1',
        'user-1',
      );
    });

    it('clearShippingAddress forwards service errors', async () => {
      const user = makeMockUser('user-1');
      service.clearShippingAddress.mockRejectedValue(
        new Error('SALE_NOT_DRAFT'),
      );

      await expect(
        controller.clearShippingAddress('sale-1', user),
      ).rejects.toThrow('SALE_NOT_DRAFT');
    });
  });

  // ============================================================================
  // Work Unit 6 — Manual apply/remove + veto routes (6.7)
  // ============================================================================
  describe('Work Unit 6 — manual promotion routes', () => {
    it('GET /sales/drafts/:id/applicable-promotions delegates to listApplicablePromotions', async () => {
      const user = makeMockUser('user-1');
      service.listApplicablePromotions.mockResolvedValue({
        saleId: 'sale-1',
        promotions: [
          { id: 'promo-m-1', title: '10% off', type: 'PRODUCT_DISCOUNT' },
        ],
      });

      const result = await controller.listApplicablePromotions('sale-1', user);

      expect(result).toEqual({
        saleId: 'sale-1',
        promotions: [
          { id: 'promo-m-1', title: '10% off', type: 'PRODUCT_DISCOUNT' },
        ],
      });
      expect(service.listApplicablePromotions).toHaveBeenCalledWith(
        'sale-1',
        'user-1',
      );
    });

    it('POST /sales/drafts/:id/manual-promotions/:promotionId delegates to applyManualPromotion', async () => {
      const user = makeMockUser('user-1');
      service.applyManualPromotion.mockResolvedValue({
        id: 'sale-1',
        items: [
          { id: 'item-1', promotionId: 'promo-m-1', unitPriceCents: 900 },
        ],
      });

      const result = await controller.applyManualPromotion(
        'sale-1',
        'promo-m-1',
        {},
        user,
      );

      expect(result).toEqual({
        id: 'sale-1',
        items: [
          { id: 'item-1', promotionId: 'promo-m-1', unitPriceCents: 900 },
        ],
      });
      expect(service.applyManualPromotion).toHaveBeenCalledWith(
        'sale-1',
        'user-1',
        'promo-m-1',
      );
    });

    it('DELETE /sales/drafts/:id/manual-promotions/:promotionId delegates to removeManualPromotion', async () => {
      const user = makeMockUser('user-1');
      service.removeManualPromotion.mockResolvedValue({
        id: 'sale-1',
        items: [{ id: 'item-1', promotionId: null, unitPriceCents: 1000 }],
      });

      const result = await controller.removeManualPromotion(
        'sale-1',
        'promo-m-1',
        {},
        user,
      );

      expect(result).toEqual({
        id: 'sale-1',
        items: [{ id: 'item-1', promotionId: null, unitPriceCents: 1000 }],
      });
      expect(service.removeManualPromotion).toHaveBeenCalledWith(
        'sale-1',
        'user-1',
        'promo-m-1',
      );
    });

    it('DELETE /sales/drafts/:id/promotions/:promotionId delegates to removeAppliedPromotion', async () => {
      const user = makeMockUser('user-1');
      service.removeAppliedPromotion.mockResolvedValue({
        id: 'sale-1',
        items: [{ id: 'item-1', promotionId: null, unitPriceCents: 1000 }],
      });

      const result = await controller.removeAppliedPromotion(
        'sale-1',
        'promo-auto-1',
        {},
        user,
      );

      expect(result).toEqual({
        id: 'sale-1',
        items: [{ id: 'item-1', promotionId: null, unitPriceCents: 1000 }],
      });
      expect(service.removeAppliedPromotion).toHaveBeenCalledWith(
        'sale-1',
        'user-1',
        'promo-auto-1',
      );
    });

    it('routes forward service errors', async () => {
      const user = makeMockUser('user-1');
      service.applyManualPromotion.mockRejectedValue(
        new Error('PROMOTION_NOT_FOUND'),
      );

      await expect(
        controller.applyManualPromotion('sale-1', 'promo-m-1', {}, user),
      ).rejects.toThrow('PROMOTION_NOT_FOUND');
    });
  });

  // ==========================================================================
  // WU3 — PUT /sales/drafts/:id/price-list endpoint
  // --------------------------------------------------------------------------
  // RBAC: the controller-level guards (JwtAuthGuard, TenantContextGuard,
  // PermissionsGuard) are applied at @UseGuards. The method-level
  // @RequirePermissions(['update', 'Sale']) decorator enforces the same
  // permission shape as the other draft-mutation routes (addItem /
  // updateItemQuantity / removeItem / assignCustomer).
  // ==========================================================================
  describe('WU3 — PUT /sales/drafts/:id/price-list', () => {
    it('passes userId + saleId + body through to service.setSalePriceList', async () => {
      const user = makeMockUser('user-1');
      const dto = { globalPriceListId: 'gpl-mayoreo' };
      const draft = {
        id: 'sale-1',
        userId: 'user-1',
        status: 'DRAFT',
        globalPriceListId: 'gpl-mayoreo',
        items: [],
      };
      service.setSalePriceList.mockResolvedValue(draft);

      const result = await controller.setSalePriceList('sale-1', dto, user);

      expect(service.setSalePriceList).toHaveBeenCalledWith(
        'sale-1',
        'user-1',
        dto,
      );
      expect(result).toEqual(draft);
    });

    it('accepts explicit null on globalPriceListId (cashier clear)', async () => {
      const user = makeMockUser('user-1');
      const dto = { globalPriceListId: null };
      const draft = {
        id: 'sale-1',
        userId: 'user-1',
        status: 'DRAFT',
        globalPriceListId: null,
        items: [],
      };
      service.setSalePriceList.mockResolvedValue(draft);

      const result = await controller.setSalePriceList('sale-1', dto, user);

      expect(service.setSalePriceList).toHaveBeenCalledWith(
        'sale-1',
        'user-1',
        { globalPriceListId: null },
      );
      expect(result).toEqual(draft);
    });
  });
});
