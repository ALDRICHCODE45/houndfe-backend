import { SalesQueryController } from './sales-query.controller';
import type { SalesService } from './sales.service';
import { ParseUUIDPipe } from '@nestjs/common';

function makeMockSalesService() {
  return {
    listSales: jest.fn(),
    getSaleDetail: jest.fn(),
    setDueDate: jest.fn(),
  } as any;
}

describe('SalesQueryController', () => {
  let service: ReturnType<typeof makeMockSalesService>;
  let controller: SalesQueryController;

  beforeEach(() => {
    service = makeMockSalesService();
    controller = new SalesQueryController(service as SalesService);
  });

  it('delegates GET /sales query to service', async () => {
    const response = {
      data: [{ id: 'sale-1', folio: 'V-0001' }],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
      counts: { all: 1, pendingPayments: 0, notDelivered: 0 },
    };
    service.listSales.mockResolvedValue(response);
    const query = { page: 1, limit: 20, q: '0001' };

    const result = await controller.list(query as any);

    expect(result).toEqual(response);
    expect(service.listSales).toHaveBeenCalledWith(query);
  });

  it('delegates GET /sales/:id to service', async () => {
    const id = 'b5e2b8fd-bdfd-471f-b687-ec340d578885';
    const response = { id, folio: 'V-0002' };
    service.getSaleDetail.mockResolvedValue(response);

    const result = await controller.detail(id);

    expect(result).toEqual(response);
    expect(service.getSaleDetail).toHaveBeenCalledWith(id);
  });

  it('delegates 404 errors from service without masking', async () => {
    const id = 'b5e2b8fd-bdfd-471f-b687-ec340d578885';
    const error = new Error('Sale not found');
    service.getSaleDetail.mockRejectedValue(error);

    await expect(controller.detail(id)).rejects.toThrow('Sale not found');
  });

  it('rejects invalid UUID format for GET /sales/:id param', async () => {
    const pipe = new ParseUUIDPipe();
    await expect(pipe.transform('not-a-uuid', { type: 'param', metatype: String, data: 'id' })).rejects.toThrow();
  });

  it('delegates PATCH /sales/:id/due-date to service', async () => {
    const id = 'b5e2b8fd-bdfd-471f-b687-ec340d578885';
    const dto = { dueDate: '2026-07-01T00:00:00.000Z' };
    const response = { id, dueDate: dto.dueDate };
    service.setDueDate.mockResolvedValue(response);

    const result = await controller.setDueDate(id, dto);

    expect(result).toEqual(response);
    expect(service.setDueDate).toHaveBeenCalledWith(id, dto);
  });
});
