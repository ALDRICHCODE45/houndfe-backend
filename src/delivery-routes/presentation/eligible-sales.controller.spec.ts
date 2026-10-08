/**
 * PRESENTATION SPEC: EligibleSalesController — delivery-routes / T4.
 *
 * Thin adapter contract:
 *   - builds the service context from `request.user` + `request.ability`
 *   - delegates to `EligibleSalesService.list`
 *   - fails loudly when the PermissionsGuard did not attach the ability
 */
import { EligibleSalesController } from './eligible-sales.controller';
import { EligibleSalesService } from '../application/eligible-sales.service';
import { EligibleSalesQueryDto } from '../dto/eligible-sales-query.dto';
import type { EligibleSalesResponseDto } from '../dto/eligible-sales-response.dto';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import type { AppAbility } from '../../auth/authorization/domain/permission';
import type { Request } from 'express';

type RequestWithAbility = Request & { ability?: AppAbility };

const makeHarness = () => {
  const response: EligibleSalesResponseDto = {
    data: [],
    pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
  };
  const service = {
    list: jest.fn(),
  };
  service.list.mockResolvedValue(response);
  const controller = new EligibleSalesController(
    service as unknown as EligibleSalesService,
  );
  return { controller, service, response };
};

describe('EligibleSalesController.list', () => {
  it('delegates to the service with the request context', async () => {
    const { controller, service, response } = makeHarness();
    const user = { userId: 'user-1' } as AuthenticatedUser;
    const ability = { can: jest.fn() } as unknown as AppAbility;
    const req = { ability } as RequestWithAbility;
    const query = new EligibleSalesQueryDto();

    const result = await controller.list(query, user, req);

    expect(service.list).toHaveBeenCalledWith(
      { userId: 'user-1', ability },
      query,
    );
    expect(result).toBe(response);
  });

  it('throws when the PermissionsGuard did not attach an ability', () => {
    const { controller } = makeHarness();
    const user = { userId: 'user-1' } as AuthenticatedUser;

    expect(() =>
      controller.list(
        new EligibleSalesQueryDto(),
        user,
        {} as RequestWithAbility,
      ),
    ).toThrow(/request\.ability/);
  });
});
