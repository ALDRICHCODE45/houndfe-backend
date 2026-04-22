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
    clearItems: jest.fn(),
    deleteDraft: jest.fn(),
    getUserDrafts: jest.fn(),
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
});
