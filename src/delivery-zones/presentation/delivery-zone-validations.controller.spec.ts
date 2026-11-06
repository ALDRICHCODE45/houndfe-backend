/**
 * zone-validation-lookup / T1 (S1) — `listPending` forwards the optional
 * `zipCode` filter to the repository and keeps the pagination block.
 */
import type { Request } from 'express';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import type { IDeliveryZoneValidationRepository } from '../domain/delivery-zone-validation.repository';
import { DeliveryZoneValidationsController } from './delivery-zone-validations.controller';

function setup() {
  const listPending = jest.fn().mockResolvedValue({ items: [], totalCount: 0 });
  const controller = new DeliveryZoneValidationsController({
    listPending,
  } as unknown as IDeliveryZoneValidationRepository);
  const request = {
    user: { userId: 'user-1', tenantId: 'tenant-1' } as AuthenticatedUser,
  } as Request & { user?: AuthenticatedUser };
  return { controller, listPending, request };
}

describe('DeliveryZoneValidationsController.listPending', () => {
  it('passes the zipCode filter through', async () => {
    const { controller, listPending, request } = setup();
    const result = await controller.listPending(
      { zipCode: '06700', page: 2, limit: 5 },
      request,
    );
    expect(listPending).toHaveBeenCalledWith({
      page: 2,
      limit: 5,
      zipCode: '06700',
    });
    expect(result.pagination).toEqual({
      pageIndex: 1,
      pageSize: 5,
      totalCount: 0,
      pageCount: 0,
    });
  });

  it('lists every postal code without the filter', async () => {
    const { controller, listPending, request } = setup();
    await controller.listPending({}, request);
    expect(listPending).toHaveBeenCalledWith({ page: 1, limit: 20 });
  });
});
