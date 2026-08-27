/**
 * APPLICATION UNIT SPEC: DeliveryRoutesService — delivery-routes / WU2+WU3.
 *
 * Covers the use-case orchestration contract (tasks.md 3.12):
 *   - `checkInStop` transaction choreography: stop flip + Sale mirror
 *     (`markSaleDelivered` via the SALE_REPOSITORY port) inside one
 *     `repo.runInTransaction`; the next-stop outbox row is published
 *     inside the SAME transaction when a next stop exists (WU3).
 *   - `list` driver-only scoping via `request.ability.can('create',
 *     'DeliveryRoute')`.
 *   - `start` eligible → proceeds / DB conflict (P2002 race) →
 *     `DeliveryRouteSaleAlreadyInActiveRouteError` (409 domain contract).
 *   - Error mapping: not-found → 404 (`DeliveryRouteNotFoundError`),
 *     invalid transition → 422 (`DeliveryRouteInvalidTransitionError`).
 *
 * All ports (DELIVERY_ROUTE_REPOSITORY, SALE_REPOSITORY, ROUTE_OPTIMIZER,
 * OutboxWriterService) are Jest mocks — no real DB, no NestJS DI
 * container.
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
import type { OutboxWriterService } from '../../shared/outbox/outbox-writer.service';

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

/** Minimal in-memory sale projection used by the next-stop payload composer. */
const saleProjection = (saleId: string) => ({
  folio: `F-${saleId}`,
  customer: {
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: `${saleId}@example.com`,
  },
  shippingAddress: {
    label: null,
    street: 'Av. Reforma',
    exteriorNumber: '123',
    interiorNumber: null,
    zipCode: '06600',
    neighborhood: 'Centro',
    municipality: 'Cuauhtémoc',
    city: 'CDMX',
    state: 'CDMX',
  },
});

const makeService = (
  overrides: {
    repo?: Partial<IDeliveryRouteRepository>;
    saleRepo?: Partial<Pick<ISaleRepository, 'markSaleDelivered'>>;
    outboxWriter?: Partial<Pick<OutboxWriterService, 'publish'>>;
    saleProjectionMap?: Map<string, ReturnType<typeof saleProjection> | null>;
  } = {},
) => {
  const tx = {} as Prisma.TransactionClient;
  const projectionMap =
    overrides.saleProjectionMap ??
    new Map<string, ReturnType<typeof saleProjection> | null>();
  // Default: every sale returns a populated projection.
  if (!overrides.saleProjectionMap) {
    projectionMap.set('sale-1', saleProjection('sale-1'));
    projectionMap.set('sale-2', saleProjection('sale-2'));
  }

  const txPrisma = {
    sale: {
      findFirst: jest.fn(async ({ where }: { where: { id: string } }) => {
        return projectionMap.get(where.id) ?? null;
      }),
    },
  };

  const repo = {
    save: jest.fn(async (r: DeliveryRoute) => r),
    findById: jest.fn(async () => null),
    findOneWithStops: jest.fn(async () => null),
    list: jest.fn(async () => []),
    runInTransaction: jest.fn(
      async (work: (t: Prisma.TransactionClient) => Promise<unknown>) =>
        work({ ...tx, ...txPrisma } as Prisma.TransactionClient),
    ),
    ...overrides.repo,
  } as jest.Mocked<IDeliveryRouteRepository>;
  const saleRepo = {
    markSaleDelivered: jest.fn(async () => undefined),
    ...overrides.saleRepo,
  } as jest.Mocked<Pick<ISaleRepository, 'markSaleDelivered'>>;
  const optimizer = { optimize: jest.fn() } as jest.Mocked<IRouteOptimizer>;
  const tenantPrisma = {
    getClient: () => txPrisma,
  } as unknown as TenantPrismaService;
  const cls = {
    get: jest.fn(() => ({ tenantId: TENANT_ID, isSuperAdmin: false })),
  } as unknown as ClsService<TenantClsStore>;
  const outboxWriter = {
    publish: jest.fn(async () => undefined),
    ...overrides.outboxWriter,
  } as jest.Mocked<Pick<OutboxWriterService, 'publish'>>;

  const service = new DeliveryRoutesService(
    repo,
    saleRepo as never,
    optimizer,
    tenantPrisma,
    cls,
    outboxWriter as unknown as OutboxWriterService,
  );
  return { service, repo, saleRepo, cls, tx, txPrisma, outboxWriter };
};

const makeCtx = (can: jest.Mock = jest.fn(() => false)): DeliveryRouteRequestContext => ({
  userId: USER_ID,
  ability: { can } as unknown as AppAbility,
});

describe('DeliveryRoutesService (delivery-routes / WU2+WU3)', () => {
  describe('checkInStop — transaction orchestration', () => {
    it('Given an ACTIVE route with a next stop, when a stop is checked in, then the stop flip, the Sale mirror, and the next-stop outbox row all happen inside one transaction', async () => {
      const route = await makeRoute(['sale-1', 'sale-2'], 'ACTIVE');
      const { service, repo, saleRepo, outboxWriter, txPrisma } = makeService({
        repo: {
          findById: jest.fn(async () => route),
          findOneWithStops: jest.fn(async () => readModelFor(route)),
        },
      });

      const dto = await service.checkInStop(
        makeCtx(),
        route.id,
        route.stops[0].id,
      );

      expect(repo.runInTransaction).toHaveBeenCalledTimes(1);
      expect(saleRepo.markSaleDelivered).toHaveBeenCalledTimes(1);
      expect(repo.save).toHaveBeenCalledWith(route);
      // Stop flip + route still ACTIVE with a next stop.
      expect(route.stops[0].status).toBe('COMPLETED');
      expect(route.status).toBe('ACTIVE');

      // Outbox row published EXACTLY ONCE with the correct aggregate keys.
      expect(outboxWriter.publish).toHaveBeenCalledTimes(1);
      const callArgs = outboxWriter.publish.mock.calls[0];
      expect(callArgs[0]).toEqual(txPrisma); // tx client (same as the runInTransaction callback's tx)
      expect(callArgs[1]).toBe(TENANT_ID);
      expect(callArgs[2]).toBe('DeliveryRoute');
      expect(callArgs[3]).toBe(route.id);
      expect(callArgs[4]).toBe('delivery.next_stop.notify');
      const payload = callArgs[5] as {
        tenantId: string;
        routeId: string;
        currentStopId: string;
        nextStopId: string;
        nextSaleId: string;
        nextCustomerName: string;
        nextCustomerEmail: string;
        nextAddressLabel: string;
        idempotencyKey: string;
        occurredAt: string;
      };
      expect(payload.tenantId).toBe(TENANT_ID);
      expect(payload.routeId).toBe(route.id);
      expect(payload.currentStopId).toBe(route.stops[0].id);
      expect(payload.nextStopId).toBe(route.stops[1].id);
      expect(payload.nextSaleId).toBe('sale-2');
      expect(payload.nextCustomerName).toBe('Ada Lovelace');
      expect(payload.nextCustomerEmail).toBe('sale-2@example.com');
      expect(payload.nextAddressLabel).toContain('Av. Reforma');
      expect(payload.idempotencyKey).toBe(
        `${TENANT_ID}:${route.stops[0].id}`,
      );
      expect(typeof payload.occurredAt).toBe('string');

      expect(dto.status).toBe('ACTIVE');
      expect(dto.timeline.length).toBeGreaterThan(0);
    });

    it('Given an ACTIVE route, when its last stop is checked in, then the route auto-completes and NO outbox row is emitted (no next stop)', async () => {
      const route = await makeRoute(['sale-1'], 'ACTIVE');
      const { service, repo, saleRepo, outboxWriter } = makeService({
        repo: {
          findById: jest.fn(async () => route),
          findOneWithStops: jest.fn(async () => readModelFor(route)),
        },
      });

      const dto = await service.checkInStop(makeCtx(), route.id, route.stops[0].id);

      expect(route.status).toBe('COMPLETED');
      expect(saleRepo.markSaleDelivered).toHaveBeenCalledTimes(1);
      expect(repo.save).toHaveBeenCalled();
      // No next stop ⇒ no outbox row.
      expect(outboxWriter.publish).not.toHaveBeenCalled();
      expect(dto.status).toBe('COMPLETED');
    });

    it('Given a check-in replay (already-COMPLETED stop), when the service is called again, then the aggregate is a no-op AND no second outbox row is published', async () => {
      const route = await makeRoute(['sale-1', 'sale-2'], 'ACTIVE');
      const { service, outboxWriter } = makeService({
        repo: {
          findById: jest.fn(async () => route),
          findOneWithStops: jest.fn(async () => readModelFor(route)),
        },
      });

      await service.checkInStop(makeCtx(), route.id, route.stops[0].id);
      expect(outboxWriter.publish).toHaveBeenCalledTimes(1);

      // Second call on the SAME already-COMPLETED stop — aggregate
      // returns the existing state (idempotent) and emits no second row.
      await service.checkInStop(makeCtx(), route.id, route.stops[0].id);
      expect(outboxWriter.publish).toHaveBeenCalledTimes(1);
    });

    it('Given a vanished sale (P2025 from the Sale mirror), when a stop is checked in, then the service maps it to DeliveryRouteNotFoundError (404 semantics) and the outbox row is NOT published', async () => {
      const route = await makeRoute(['sale-1', 'sale-2'], 'ACTIVE');
      const { service, repo, saleRepo, outboxWriter } = makeService({
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
      expect(error).toBeInstanceOf(EntityNotFoundError);
      expect(saleRepo.markSaleDelivered).toHaveBeenCalledTimes(1);
      expect(repo.save).not.toHaveBeenCalled();
      // The tx aborted — no outbox row was committed.
      expect(outboxWriter.publish).not.toHaveBeenCalled();
    });

    it('Given a route missing inside the transaction, when a stop is checked in, then the service throws DeliveryRouteNotFoundError and nothing is persisted', async () => {
      const { service, repo, saleRepo, outboxWriter } = makeService({
        repo: { findById: jest.fn(async () => null) },
      });

      await expect(
        service.checkInStop(makeCtx(), 'missing-route', 'stop-1'),
      ).rejects.toBeInstanceOf(DeliveryRouteNotFoundError);
      expect(saleRepo.markSaleDelivered).not.toHaveBeenCalled();
      expect(repo.save).not.toHaveBeenCalled();
      expect(outboxWriter.publish).not.toHaveBeenCalled();
    });

    it('Given a DRAFT route, when a stop is checked in, then the service propagates DeliveryRouteInvalidTransitionError (422 semantics)', async () => {
      const route = await makeRoute(['sale-1'], 'DRAFT');
      const { service, repo, outboxWriter } = makeService({
        repo: { findById: jest.fn(async () => route) },
      });

      const error = await service
        .checkInStop(makeCtx(), route.id, route.stops[0].id)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(DeliveryRouteInvalidTransitionError);
      expect(error).toBeInstanceOf(BusinessRuleViolationError);
      expect(repo.save).not.toHaveBeenCalled();
      expect(outboxWriter.publish).not.toHaveBeenCalled();
    });

    it('Given an ACTIVE route, when the next sale has no customer (null projection), then the outbox row still publishes with `nextCustomerName: null`', async () => {
      const route = await makeRoute(['sale-1', 'sale-2'], 'ACTIVE');
      const projectionMap = new Map<string, ReturnType<typeof saleProjection> | null>();
      projectionMap.set('sale-2', {
        folio: 'F-2',
        customer: null,
        shippingAddress: null,
      });
      const { service, outboxWriter } = makeService({
        repo: {
          findById: jest.fn(async () => route),
          findOneWithStops: jest.fn(async () => readModelFor(route)),
        },
        saleProjectionMap: projectionMap,
      });

      await service.checkInStop(makeCtx(), route.id, route.stops[0].id);

      expect(outboxWriter.publish).toHaveBeenCalledTimes(1);
      const payload = (outboxWriter.publish.mock.calls[0] as unknown[])[5] as {
        nextCustomerName: string | null;
        nextCustomerEmail: string | null;
        nextAddressLabel: string | null;
      };
      expect(payload.nextCustomerName).toBeNull();
      expect(payload.nextCustomerEmail).toBeNull();
      expect(payload.nextAddressLabel).toBeNull();
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
      expect(error).toBeInstanceOf(EntityNotFoundError);
    });
  });

  describe('getById — timeline assembly (WU3)', () => {
    it('Given an ACTIVE route with two stops (one checked in), when getById is called, then the timeline contains ROUTE_CREATED + ROUTE_STARTED + STOP_CHECKED_IN events in chronological order', async () => {
      const route = await makeRoute(['sale-1', 'sale-2'], 'ACTIVE');
      const later = new Date(NOW.getTime() + 5_000);
      route.stops[0].markCompleted(later);
      const row = readModelFor(route);
      const { service } = makeService({
        repo: {
          findOneWithStops: jest.fn(async () => row),
        },
      });

      const dto = await service.getById(makeCtx(), route.id);

      const types = dto.timeline.map((e: { type: string }) => e.type);
      expect(types).toEqual([
        'ROUTE_CREATED',
        'ROUTE_STARTED',
        'STOP_CHECKED_IN',
      ]);
      // Ascending by `at`.
      const ats = dto.timeline.map((e: { at: string }) => e.at);
      expect(ats).toEqual([...ats].sort());
    });

    it('Given a COMPLETED route, when getById is called, then the timeline ends with ROUTE_COMPLETED', async () => {
      const route = await makeRoute(['sale-1'], 'ACTIVE');
      const later = new Date(NOW.getTime() + 5_000);
      route.stops[0].markCompleted(later);
      // Aggregate auto-completes when the last stop is marked.
      // Trigger the auto-complete by replaying checkInStop semantics via
      // direct mutation for the spec seam.
      // (Aggregate already transitioned to COMPLETED via the markCompleted
      // call when there is only one stop — covered by the entity spec; we
      // verify the read model state here.)
      const row = readModelFor(route);
      // Force the read model to COMPLETED so the timeline builder emits
      // the terminal event.
      const completedRow: DeliveryRouteReadModel = {
        ...row,
        status: 'COMPLETED',
        completedAt: later,
      };
      const { service } = makeService({
        repo: {
          findOneWithStops: jest.fn(async () => completedRow),
        },
      });

      const dto = await service.getById(makeCtx(), route.id);

      const types = dto.timeline.map((e: { type: string }) => e.type);
      expect(types[types.length - 1]).toBe('ROUTE_COMPLETED');
    });

    it('Given a CANCELLED route, when getById is called, then the timeline ends with ROUTE_CANCELLED (not COMPLETED)', async () => {
      const route = await makeRoute(['sale-1'], 'DRAFT');
      route.cancel({ now: NOW });
      const row = readModelFor(route);
      const { service } = makeService({
        repo: {
          findOneWithStops: jest.fn(async () => row),
        },
      });

      const dto = await service.getById(makeCtx(), route.id);

      const types = dto.timeline.map((e: { type: string }) => e.type);
      expect(types).toContain('ROUTE_CANCELLED');
      expect(types).not.toContain('ROUTE_COMPLETED');
    });

    it('Given a missing route, when getById is called, then the service throws DeliveryRouteNotFoundError', async () => {
      const { service } = makeService({
        repo: { findOneWithStops: jest.fn(async () => null) },
      });

      const error = await service
        .getById(makeCtx(), 'missing-route')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(DeliveryRouteNotFoundError);
    });
  });
});
