/**
 * APPLICATION UNIT SPEC: DeliveryRoutesService — delivery-routes / WU2.
 *
 * Covers the use-case orchestration contract (tasks.md 3.12):
 *   - `checkInStop` transaction choreography: stop flip + Sale mirror
 *     (`markSaleDelivered` via the SALE_REPOSITORY port) inside one
 *     `repo.runInTransaction`; next-stop outbox payload when a next stop
 *     exists and none when the route auto-completes.
 *   - `list` driver-only scoping via `request.ability.can('create',
 *     'DeliveryRoute')`.
 *   - `start` eligible → proceeds / DB conflict (P2002 race) →
 *     `DeliveryRouteSaleAlreadyInActiveRouteError` (409 domain contract).
 *   - Error mapping: not-found → 404 (`DeliveryRouteNotFoundError`),
 *     invalid transition → 422 (`DeliveryRouteInvalidTransitionError`).
 *
 * All ports (DELIVERY_ROUTE_REPOSITORY, SALE_REPOSITORY, ROUTE_OPTIMIZER)
 * are Jest mocks — no real DB, no NestJS DI container.
 */
import { Prisma } from '@prisma/client';
import {
  DeliveryRoutesService,
  type DeliveryRouteRequestContext,
} from './delivery-routes.service';
import { DeliveryRoute } from '../domain/delivery-route.entity';
import {
  DELIVERY_ROUTE_REPOSITORY,
  type DeliveryRouteReadModel,
  type IDeliveryRouteRepository,
} from '../domain/delivery-route.repository';
import { SALE_REPOSITORY, type ISaleRepository } from '../../sales/domain/sale.repository';
import {
  ROUTE_OPTIMIZER,
  type IRouteOptimizer,
} from '../domain/ports/route-optimizer.port';
import {
  DeliveryRouteInvalidTransitionError,
  DeliveryRouteNotFoundError,
  DeliveryRouteSaleAlreadyInActiveRouteError,
} from '../domain/delivery-route.errors';
import {
  BusinessRuleViolationError,
  EntityNotFoundError,
} from '../../shared/domain/domain-error';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { ClsService } from 'nestjs-cls';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import type { AppAbility } from '../../auth/authorization/domain/permission';

const TENANT_ID = 'tenant-1';
const USER_ID = 'driver-1';
const NOW = new Date('2026-08-01T12:00:00.000Z');

/** Build a real ACTIVE/DRAFT aggregate — the aggregate is production code,
 *  only the ports are mocked. */
const makeRoute = async (
  saleIds: string[],
  status: 'DRAFT' | 'ACTIVE' = 'ACTIVE',
): Promise<DeliveryRoute> => {
  const route = await DeliveryRoute.create({
    tenantId: TENANT_ID,
    driverUserId: USER_ID,
    saleIds,
    checkSaleEligibility: jest.fn(async () => ({
      deliveryStatus: 'PENDING' as const,
      shippingAddressId: 'addr-1',
    })),
    now: NOW,
  });
  if (status === 'ACTIVE') {
    route.start({ now: NOW });
  }
  return route;
};

/** Lazy read-model projection — snapshots the aggregate's current state at
 *  call time so post-mutation reads (e.g. after auto-complete) are accurate. */
const readModelFor = (route: DeliveryRoute): DeliveryRouteReadModel => ({
  id: route.id,
  tenantId: route.tenantId,
  driverUserId: route.driverUserId,
  status: route.status,
  startedAt: route.startedAt,
  completedAt: route.completedAt,
  cancelledAt: route.cancelledAt,
  notes: route.notes,
  createdAt: route.createdAt,
  updatedAt: route.updatedAt,
  driver: { id: route.driverUserId, name: 'Driver One', email: 'driver@example.com' },
  stops: route.stops.map((stop) => ({
    id: stop.id,
    saleId: stop.saleId,
    saleFolio: `F-${stop.sortOrder + 1}`,
    sortOrder: stop.sortOrder,
    status: stop.status,
    checkedInAt: stop.checkedInAt,
    completedAt: stop.completedAt,
    customer: null,
    shippingAddress: null,
  })),
});

const makeService = (
  overrides: {
    repo?: Partial<IDeliveryRouteRepository>;
    saleRepo?: Partial<Pick<ISaleRepository, 'markSaleDelivered'>>;
  } = {},
) => {
  const tx = {} as Prisma.TransactionClient;
  const repo = {
    save: jest.fn(async (r: DeliveryRoute) => r),
    findById: jest.fn(async () => null),
    findOneWithStops: jest.fn(async () => null),
    list: jest.fn(async () => []),
    runInTransaction: jest.fn(
      async (work: (t: Prisma.TransactionClient) => Promise<unknown>) =>
        work(tx),
    ),
    ...overrides.repo,
  } as jest.Mocked<IDeliveryRouteRepository>;
  const saleRepo = {
    markSaleDelivered: jest.fn(async () => undefined),
    ...overrides.saleRepo,
  } as jest.Mocked<Pick<ISaleRepository, 'markSaleDelivered'>>;
  const optimizer = { optimize: jest.fn() } as jest.Mocked<IRouteOptimizer>;
  const tenantPrisma = {} as TenantPrismaService;
  const cls = {
    get: jest.fn(() => ({ tenantId: TENANT_ID, isSuperAdmin: false })),
  } as unknown as ClsService<TenantClsStore>;

  const service = new DeliveryRoutesService(
    repo,
    saleRepo as never,
    optimizer,
    tenantPrisma,
    cls,
  );
  return { service, repo, saleRepo, cls, tx };
};

const makeCtx = (can: jest.Mock = jest.fn(() => false)): DeliveryRouteRequestContext => ({
  userId: USER_ID,
  ability: { can } as unknown as AppAbility,
});

describe('DeliveryRoutesService (delivery-routes / WU2)', () => {
  describe('checkInStop — transaction orchestration', () => {
    it('Given an ACTIVE route with a next stop, when a stop is checked in, then the stop flip and the Sale mirror happen inside one transaction and the next-stop payload is emitted', async () => {
      const route = await makeRoute(['sale-1', 'sale-2'], 'ACTIVE');
      const { service, repo, saleRepo, tx } = makeService({
        repo: {
          findById: jest.fn(async () => route),
          findOneWithStops: jest.fn(async () => readModelFor(route)),
        },
      });
      const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);

      const dto = await service.checkInStop(
        makeCtx(),
        route.id,
        route.stops[0].id,
      );

      expect(repo.runInTransaction).toHaveBeenCalledTimes(1);
      expect(saleRepo.markSaleDelivered).toHaveBeenCalledWith(tx, {
        tenantId: TENANT_ID,
        saleId: 'sale-1',
      });
      expect(repo.save).toHaveBeenCalledWith(route);
      // Stop flip + route still ACTIVE with a next stop.
      expect(route.stops[0].status).toBe('COMPLETED');
      expect(route.status).toBe('ACTIVE');
      expect(infoSpy).toHaveBeenCalledWith(
        '[DeliveryRoutesService.checkInStop] next-stop payload',
        expect.objectContaining({
          routeId: route.id,
          completedStopId: route.stops[0].id,
          nextStopId: route.stops[1].id,
          nextSaleId: 'sale-2',
        }),
      );
      expect(dto.status).toBe('ACTIVE');
      infoSpy.mockRestore();
    });

    it('Given an ACTIVE route, when its last stop is checked in, then the route auto-completes and NO next-stop payload is emitted', async () => {
      const route = await makeRoute(['sale-1'], 'ACTIVE');
      const { service, repo, saleRepo, tx } = makeService({
        repo: {
          findById: jest.fn(async () => route),
          findOneWithStops: jest.fn(async () => readModelFor(route)),
        },
      });
      const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);

      const dto = await service.checkInStop(makeCtx(), route.id, route.stops[0].id);

      expect(route.status).toBe('COMPLETED');
      expect(saleRepo.markSaleDelivered).toHaveBeenCalledWith(tx, {
        tenantId: TENANT_ID,
        saleId: 'sale-1',
      });
      expect(repo.save).toHaveBeenCalled();
      expect(infoSpy).not.toHaveBeenCalled();
      expect(dto.status).toBe('COMPLETED');
      infoSpy.mockRestore();
    });

    it('Given a route missing inside the transaction, when a stop is checked in, then the service throws DeliveryRouteNotFoundError and nothing is persisted', async () => {
      const { service, repo, saleRepo } = makeService({
        repo: { findById: jest.fn(async () => null) },
      });

      await expect(
        service.checkInStop(makeCtx(), 'missing-route', 'stop-1'),
      ).rejects.toBeInstanceOf(DeliveryRouteNotFoundError);
      expect(saleRepo.markSaleDelivered).not.toHaveBeenCalled();
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('Given a vanished sale (P2025 from the Sale mirror), when a stop is checked in, then the service maps it to DeliveryRouteNotFoundError (404 semantics)', async () => {
      const route = await makeRoute(['sale-1', 'sale-2'], 'ACTIVE');
      const { service, repo, saleRepo } = makeService({
        repo: { findById: jest.fn(async () => route) },
        saleRepo: {
          markSaleDelivered: jest.fn(async () => {
            throw new Prisma.PrismaClientKnownRequestError('Record not found', {
              code: 'P2025',
              clientVersion: '6.19.2',
            });
          }),
        },
      });

      const error = await service
        .checkInStop(makeCtx(), route.id, route.stops[0].id)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(DeliveryRouteNotFoundError);
      expect(error).toBeInstanceOf(EntityNotFoundError); // → 404 via global filter
      expect((error as DeliveryRouteNotFoundError).code).toBe('ENTITY_NOT_FOUND');
      expect(saleRepo.markSaleDelivered).toHaveBeenCalledTimes(1);
      // The transaction aborted before the aggregate persisted.
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('Given a DRAFT route, when a stop is checked in, then the service propagates DeliveryRouteInvalidTransitionError (422 semantics)', async () => {
      const route = await makeRoute(['sale-1'], 'DRAFT');
      const { service, repo } = makeService({
        repo: { findById: jest.fn(async () => route) },
      });

      const error = await service
        .checkInStop(makeCtx(), route.id, route.stops[0].id)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(DeliveryRouteInvalidTransitionError);
      expect(error).toBeInstanceOf(BusinessRuleViolationError); // → 422 via global filter
      expect((error as DeliveryRouteInvalidTransitionError).code).toBe(
        'DELIVERY_ROUTE_INVALID_TRANSITION',
      );
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  describe('list — driver-only scoping (ADR-5)', () => {
    it('Given a driver-only caller (cannot create DeliveryRoute), when the routes are listed, then the repo is scoped to driverUserId = caller id', async () => {
      const { service, repo } = makeService();
      const can = jest.fn(() => false);
      repo.list.mockResolvedValue([]);

      await service.list(makeCtx(can), {});

      expect(can).toHaveBeenCalledWith('create', 'DeliveryRoute');
      expect(repo.list).toHaveBeenCalledWith({
        tenantId: TENANT_ID,
        driverUserId: USER_ID,
        status: undefined,
      });
    });

    it('Given a route-manager caller (can create DeliveryRoute), when the routes are listed, then the repo receives an unfiltered tenant list', async () => {
      const { service, repo } = makeService();
      repo.list.mockResolvedValue([]);

      await service.list(makeCtx(jest.fn(() => true)), {});

      expect(repo.list).toHaveBeenCalledWith({
        tenantId: TENANT_ID,
        driverUserId: undefined,
        status: undefined,
      });
    });

    it('Given a status query, when the routes are listed, then the status filter is forwarded', async () => {
      const { service, repo } = makeService();
      repo.list.mockResolvedValue([]);

      await service.list(makeCtx(jest.fn(() => false)), { status: 'ACTIVE' });

      expect(repo.list).toHaveBeenCalledWith({
        tenantId: TENANT_ID,
        driverUserId: USER_ID,
        status: ['ACTIVE'],
      });
    });
  });

  describe('start — pre-check vs DB conflict race', () => {
    it('Given an eligible DRAFT route, when it is started, then the route is persisted as ACTIVE with startedAt stamped and activeRouteId armed on every stop', async () => {
      const route = await makeRoute(['sale-1', 'sale-2'], 'DRAFT');
      const { service, repo } = makeService({
        repo: {
          findById: jest.fn(async () => route),
          findOneWithStops: jest.fn(async () => readModelFor(route)),
        },
      });

      const dto = await service.start(makeCtx(), route.id);

      expect(repo.save).toHaveBeenCalledWith(route);
      expect(route.status).toBe('ACTIVE');
      expect(route.startedAt).not.toBeNull();
      expect(route.stops.every((s) => s.activeRouteId === route.id)).toBe(true);
      expect(dto.status).toBe('ACTIVE');
    });

    it('Given a concurrent start race (P2002 on the ADR-7 partial unique index), when the route is started, then the service surfaces DeliveryRouteSaleAlreadyInActiveRouteError (409 domain contract)', async () => {
      const route = await makeRoute(['sale-1'], 'DRAFT');
      const conflictError = new DeliveryRouteSaleAlreadyInActiveRouteError(
        'One or more sales already belong to another active route',
        { reason: 'PARTIAL_UNIQUE_INDEX_VIOLATION', routeId: route.id },
      );
      const { service } = makeService({
        repo: {
          findById: jest.fn(async () => route),
          save: jest.fn(async () => {
            throw conflictError;
          }),
        },
      });

      const error = await service
        .start(makeCtx(), route.id)
        .catch((e: unknown) => e);

      expect(error).toBe(conflictError);
      expect((error as DeliveryRouteSaleAlreadyInActiveRouteError).code).toBe(
        'DELIVERY_ROUTE_STOP_SALE_ALREADY_ON_ACTIVE_ROUTE',
      );
      expect(error).toBeInstanceOf(BusinessRuleViolationError);
    });

    it('Given a route that does not exist, when it is started, then the service throws DeliveryRouteNotFoundError (404 semantics)', async () => {
      const { service } = makeService({
        repo: { findById: jest.fn(async () => null) },
      });

      const error = await service
        .start(makeCtx(), 'missing-route')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(DeliveryRouteNotFoundError);
      expect(error).toBeInstanceOf(EntityNotFoundError); // → 404 via global filter
    });
  });
});
