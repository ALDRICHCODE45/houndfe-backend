/**
 * HTTP UNIT SPEC: DeliveryRoutesController — S3 transfer endpoint.
 *
 * Verifies the S3 wire contract at the controller boundary (no Nest
 * container): the explicit stop-transfer route exists at
 * `POST /delivery-routes/:routeId/stops/:stopId/transfer`, is gated by the
 * coarse `update:DeliveryRoute` permission, and delegates
 * `(ctx, routeId, stopId, dto)` verbatim to the application service. The
 * service owns the instance-scoped permission check for BOTH routes (the
 * `PermissionsGuard` subject-instance resolver keys on `:id`, which this
 * route deliberately does not use).
 */
import { PATH_METADATA } from '@nestjs/common/constants';
import { DeliveryRoutesController } from './delivery-routes.controller';
import { PERMISSIONS_KEY } from '../../auth/authorization/decorators/require-permissions.decorator';
import type { DeliveryRoutesService } from '../application/delivery-routes.service';
import type { AppAbility } from '../../auth/authorization/domain/permission';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import type { TransferStopDto } from '../dto/transfer-stop.dto';
import type { TransferStopResponseDto } from '../dto/delivery-route-response.dto';

const USER: AuthenticatedUser = {
  userId: 'user-1',
  tenantId: 'tenant-1',
  isSuperAdmin: false,
} as unknown as AuthenticatedUser;

const ability = { can: jest.fn(() => true) } as unknown as AppAbility;

type TransferRequest = Parameters<DeliveryRoutesController['transferStop']>[4];

/** Minimal Express-like request double — the controller only reads `ability`. */
const makeReq = (withAbility = true): TransferRequest =>
  (withAbility ? { ability } : {}) as unknown as TransferRequest;

/** Read a prototype method without triggering the unbound-method lint rule. */
const handlerDescriptor = (name: 'transferStop') =>
  Object.getOwnPropertyDescriptor(DeliveryRoutesController.prototype, name)
    ?.value as (...args: unknown[]) => unknown;

const makeController = () => {
  const transferStop = jest.fn(() =>
    Promise.resolve({} as TransferStopResponseDto),
  );
  const service = { transferStop } as unknown as DeliveryRoutesService;
  return { controller: new DeliveryRoutesController(service), transferStop };
};

describe('DeliveryRoutesController — S3 transfer endpoint', () => {
  it('Given the transfer handler, when its metadata is read, then it is POST :routeId/stops/:stopId/transfer requiring update:DeliveryRoute', () => {
    const handler = handlerDescriptor('transferStop');
    const path = Reflect.getMetadata(PATH_METADATA, handler) as unknown;
    const permissions = Reflect.getMetadata(
      PERMISSIONS_KEY,
      handler,
    ) as unknown;
    const classPath = Reflect.getMetadata(
      PATH_METADATA,
      DeliveryRoutesController,
    ) as unknown;

    expect(classPath).toBe('delivery-routes');
    expect(path).toBe(':routeId/stops/:stopId/transfer');
    expect(permissions).toEqual([['update', 'DeliveryRoute']]);
  });

  it('Given valid route/stop ids and a destination, when the handler runs, then the service receives the request context, ids and DTO verbatim', async () => {
    const { controller, transferStop } = makeController();
    const dto: TransferStopDto = { destinationRouteId: 'route-2' };

    await controller.transferStop('route-1', 'stop-1', dto, USER, makeReq());

    expect(transferStop).toHaveBeenCalledTimes(1);
    expect(transferStop).toHaveBeenCalledWith(
      { userId: USER.userId, ability },
      'route-1',
      'stop-1',
      dto,
    );
  });

  it('Given a request without an attached ability, when the handler runs, then it fails fast (PermissionsGuard wiring invariant)', () => {
    const { controller } = makeController();

    expect(() =>
      controller.transferStop(
        'route-1',
        'stop-1',
        { destinationRouteId: 'route-2' },
        USER,
        makeReq(false),
      ),
    ).toThrow(/PermissionsGuard must attach request.ability/);
  });
});
