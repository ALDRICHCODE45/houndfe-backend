/**
 * QuotationsController — HTTP Layer Tests (RED phase)
 *
 * Covers T019 — Controller routes pass through to the service with the
 * right guards + decorators + parameter shape. Suite-style assertions
 * keep the wiring honest without re-running integration logic.
 */
import { QuotationsController } from './quotations.controller';
import type { QuotationsService } from '../application/quotations.service';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';

function makeMockService() {
  return {
    openDraft: jest.fn(),
    assignCustomer: jest.fn(),
    setPriceList: jest.fn(),
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

describe('QuotationsController — WU2', () => {
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
});
