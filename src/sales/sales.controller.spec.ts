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
  } as any;
}

function makeMockUser(userId: string): AuthenticatedUser {
  return { userId, email: `${userId}@test.com` };
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
      const result = await controller.removeItem('sale-4b', 'item-removed', user);

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
      const result = await controller.applyItemDiscount('s', 'i', dto as any, user);
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
      expect(service.removeItemDiscount).toHaveBeenCalledWith('s', 'i', 'user-1');
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
      const result = await controller.applyGlobalDiscount('s', dto as any, user);

      expect(result).toEqual({ sale: { id: 's', items: [] }, skippedItems: [] });
      expect(service.applyGlobalDiscount).toHaveBeenCalledWith('s', dto, 'user-1');
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
});
