/**
 * QuotationsController — HTTP Layer Tests.
 *
 * WU2 covers the suite-style assertions for the WU2 routes (openDraft,
 * findAll, findOne, assignCustomer, setPriceList).
 * WU3 adds the items/promotions/expiry/cancel routes. Each test mocks
 * the service and asserts the controller passes args through correctly.
 */
import { QuotationsController } from './quotations.controller';
import type { QuotationsService } from '../application/quotations.service';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';

function makeMockService() {
  return {
    openDraft: jest.fn(),
    assignCustomer: jest.fn(),
    setPriceList: jest.fn(),
    addItem: jest.fn(),
    updateItemQuantity: jest.fn(),
    removeItem: jest.fn(),
    overrideItemPrice: jest.fn(),
    applyManualPromotion: jest.fn(),
    removeManualPromotion: jest.fn(),
    vetoPromotion: jest.fn(),
    optInPromotion: jest.fn(),
    setExpiry: jest.fn(),
    cancel: jest.fn(),
    findOne: jest.fn(),
    findAll: jest.fn(),
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

describe('QuotationsController', () => {
  let service: ReturnType<typeof makeMockService>;
  let controller: QuotationsController;

  beforeEach(() => {
    service = makeMockService();
    controller = new QuotationsController(service);
  });

  describe('POST /quotations/drafts', () => {
    it('passes (userId, dto) through to service.openDraft', async () => {
      const mockDraft = {
        id: 'q-1',
        sellerUserId: 'user-1',
        status: 'DRAFT',
        customerId: null,
        globalPriceListId: null,
      };
      service.openDraft.mockResolvedValue(mockDraft);
      const user = makeMockUser('user-1');

      const result = await controller.openDraft({}, user);

      expect(service.openDraft).toHaveBeenCalledWith('user-1', {});
      expect(result).toEqual(mockDraft);
    });

    it('forwards create-quotation dto fields', async () => {
      service.openDraft.mockResolvedValue({});
      const user = makeMockUser('user-1');
      const dto = { customerId: 'cust-1', globalPriceListId: 'gpl-1' };

      await controller.openDraft(dto, user);

      expect(service.openDraft).toHaveBeenCalledWith('user-1', dto);
    });
  });

  describe('GET /quotations', () => {
    it('passes the query down to service.findAll', async () => {
      service.findAll.mockResolvedValue({
        data: [],
        pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
      });
      const query = {
        page: 1,
        limit: 20,
        status: 'DRAFT',
        customerId: 'cust-1',
      };

      await controller.list(query as never);

      expect(service.findAll).toHaveBeenCalledWith(query);
    });
  });

  describe('GET /quotations/:id', () => {
    it('passes the id down to service.findOne', async () => {
      const detail = { id: 'q-1', status: 'DRAFT' };
      service.findOne.mockResolvedValue(detail);

      const result = await controller.detail('q-1');

      expect(service.findOne).toHaveBeenCalledWith('q-1');
      expect(result).toEqual(detail);
    });
  });

  describe('PUT /quotations/drafts/:id/customer', () => {
    it('passes (id, dto) to service.assignCustomer', async () => {
      service.assignCustomer.mockResolvedValue({ id: 'q-1' });
      const dto = { customerId: 'cust-1' };

      const result = await controller.assignCustomer('q-1', dto);

      expect(service.assignCustomer).toHaveBeenCalledWith('q-1', dto);
      expect(result).toEqual({ id: 'q-1' });
    });
  });

  describe('PUT /quotations/drafts/:id/price-list', () => {
    it('passes (id, dto) to service.setPriceList', async () => {
      service.setPriceList.mockResolvedValue({ id: 'q-1' });
      const dto = { globalPriceListId: 'gpl-mayoreo' };

      const result = await controller.setPriceList('q-1', dto);

      expect(service.setPriceList).toHaveBeenCalledWith('q-1', dto);
      expect(result).toEqual({ id: 'q-1' });
    });
  });

  describe('Item endpoints (T037)', () => {
    it('POST /quotations/drafts/:id/items delegates to addItem', async () => {
      service.addItem.mockResolvedValue({ id: 'q-1', items: [] });
      const dto = { productId: 'prod-1', quantity: 2 };

      const result = await controller.addItem('q-1', dto);

      expect(service.addItem).toHaveBeenCalledWith('q-1', dto);
      expect(result).toEqual({ id: 'q-1', items: [] });
    });

    it('PATCH /quotations/drafts/:id/items/:itemId/quantity delegates to updateItemQuantity', async () => {
      service.updateItemQuantity.mockResolvedValue({ id: 'q-1' });
      const dto = { quantity: 5 };

      const result = await controller.updateItemQuantity(
        'q-1',
        'item-1',
        dto,
      );

      expect(service.updateItemQuantity).toHaveBeenCalledWith(
        'q-1',
        'item-1',
        dto,
      );
      expect(result).toEqual({ id: 'q-1' });
    });

    it('DELETE /quotations/drafts/:id/items/:itemId delegates to removeItem', async () => {
      service.removeItem.mockResolvedValue({ id: 'q-1' });

      const result = await controller.removeItem('q-1', 'item-1');

      expect(service.removeItem).toHaveBeenCalledWith('q-1', 'item-1');
      expect(result).toEqual({ id: 'q-1' });
    });

    it('PATCH /quotations/drafts/:id/items/:itemId/price delegates to overrideItemPrice', async () => {
      service.overrideItemPrice.mockResolvedValue({ id: 'q-1' });
      const dto = { unitPriceCents: 2000 };

      const result = await controller.overrideItemPrice(
        'q-1',
        'item-1',
        dto,
      );

      expect(service.overrideItemPrice).toHaveBeenCalledWith(
        'q-1',
        'item-1',
        dto,
      );
      expect(result).toEqual({ id: 'q-1' });
    });
  });

  describe('Manual promotion endpoints (T037)', () => {
    it('PUT /quotations/drafts/:id/manual-promotions/:promoId delegates to applyManualPromotion', async () => {
      service.applyManualPromotion.mockResolvedValue({ id: 'q-1' });

      const result = await controller.applyManualPromotion('q-1', 'promo-1');

      expect(service.applyManualPromotion).toHaveBeenCalledWith(
        'q-1',
        'promo-1',
      );
      expect(result).toEqual({ id: 'q-1' });
    });

    it('DELETE /quotations/drafts/:id/manual-promotions/:promoId delegates to removeManualPromotion', async () => {
      service.removeManualPromotion.mockResolvedValue({ id: 'q-1' });

      const result = await controller.removeManualPromotion('q-1', 'promo-1');

      expect(service.removeManualPromotion).toHaveBeenCalledWith(
        'q-1',
        'promo-1',
      );
      expect(result).toEqual({ id: 'q-1' });
    });
  });

  describe('Auto promotion veto / opt-in endpoints (T037)', () => {
    it('POST /quotations/drafts/:id/promotions/:promoId/veto delegates to vetoPromotion', async () => {
      service.vetoPromotion.mockResolvedValue({ id: 'q-1' });

      const result = await controller.vetoPromotion('q-1', 'promo-1');

      expect(service.vetoPromotion).toHaveBeenCalledWith('q-1', 'promo-1');
      expect(result).toEqual({ id: 'q-1' });
    });

    it('DELETE /quotations/drafts/:id/promotions/:promoId/veto delegates to optInPromotion', async () => {
      service.optInPromotion.mockResolvedValue({ id: 'q-1' });

      const result = await controller.optInPromotion('q-1', 'promo-1');

      expect(service.optInPromotion).toHaveBeenCalledWith('q-1', 'promo-1');
      expect(result).toEqual({ id: 'q-1' });
    });
  });

  describe('Expiry + cancel endpoints (T037)', () => {
    it('PATCH /quotations/drafts/:id/expiry delegates to setExpiry', async () => {
      service.setExpiry.mockResolvedValue({ id: 'q-1' });
      const dto = { expiresAt: '2026-12-31T00:00:00Z' };

      const result = await controller.setExpiry('q-1', dto);

      expect(service.setExpiry).toHaveBeenCalledWith('q-1', dto);
      expect(result).toEqual({ id: 'q-1' });
    });

    it('POST /quotations/drafts/:id/cancel delegates to cancel', async () => {
      service.cancel.mockResolvedValue({ id: 'q-1', status: 'CANCELLED' });
      const dto = { cancelReason: 'CUSTOMER_REQUEST' as const };

      const result = await controller.cancel('q-1', dto);

      expect(service.cancel).toHaveBeenCalledWith('q-1', dto);
      expect(result).toEqual({ id: 'q-1', status: 'CANCELLED' });
    });
  });
});
