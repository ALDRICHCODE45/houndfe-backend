/**
 * DOMAIN UNIT SPEC: DeliveryRoute aggregate — delivery-routes / WU2.
 *
 * Covers the lifecycle contract (tasks.md 3.11):
 *   - `create` validation: empty saleIds → 422, ineligible sale → 422
 *   - `start` DRAFT→ACTIVE: stamps startedAt, arms ADR-7 activeRouteId
 *   - `cancel` DRAFT|ACTIVE→CANCELLED; COMPLETED is terminal → 422
 *   - `checkInStop`: stop→COMPLETED, auto-complete on last stop, idempotent
 *     replay on an already-COMPLETED stop, unknown stop → 422
 *   - DRAFT-only `reorderStops` / `assignDriver`; delete precondition via
 *     `canDelete()` (DRAFT + zero stops only)
 *
 * Pure domain — no NestJS, no Prisma. The `checkSaleEligibility` probe is
 * mocked at the port boundary.
 */
import {
  DeliveryRoute,
  type SaleEligibilitySnapshot,
} from './delivery-route.entity';
import type { DeliveryRouteStopProps } from './delivery-route-stop.entity';
import {
  DeliveryRouteInvalidTransitionError,
  DeliveryRouteSaleNotEligibleError,
} from './delivery-route.errors';

const TENANT_ID = 'tenant-1';
const DRIVER_USER_ID = 'driver-1';
const NOW = new Date('2026-08-01T12:00:00.000Z');

/** Default eligible snapshot for a sale id. */
const eligible = (saleId: string): SaleEligibilitySnapshot => ({
  deliveryStatus: 'PENDING',
  shippingAddressId: `addr-${saleId}`,
});

/** Build a `checkSaleEligibility` probe from a snapshot map. */
const makeProbe = (
  snapshots: Record<string, SaleEligibilitySnapshot | null>,
): jest.Mock => jest.fn(async (saleId: string) => snapshots[saleId] ?? null);

/** Probe that answers `eligible(saleId)` for every listed sale id. */
const probeForAll = (saleIds: string[]): jest.Mock =>
  makeProbe(
    Object.fromEntries(saleIds.map((saleId) => [saleId, eligible(saleId)])),
  );

const createRoute = async (
  saleIds: string[],
  options: { probe?: jest.Mock; driverUserId?: string } = {},
): Promise<DeliveryRoute> =>
  DeliveryRoute.create({
    tenantId: TENANT_ID,
    driverUserId: options.driverUserId ?? DRIVER_USER_ID,
    saleIds,
    checkSaleEligibility: options.probe ?? probeForAll(saleIds),
    now: NOW,
  });

const makeStopProps = (
  index: number,
  overrides: Partial<DeliveryRouteStopProps> = {},
): DeliveryRouteStopProps => ({
  id: `stop-${index}`,
  tenantId: TENANT_ID,
  routeId: 'route-1',
  saleId: `sale-${index}`,
  sortOrder: index,
  status: 'PENDING',
  checkedInAt: null,
  completedAt: null,
  skippedReason: null,
  activeRouteId: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const routeFromPersistence = (
  overrides: {
    status?: 'DRAFT' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
    stops?: DeliveryRouteStopProps[];
  } = {},
): DeliveryRoute =>
  DeliveryRoute.fromPersistence({
    id: 'route-1',
    tenantId: TENANT_ID,
    driverUserId: DRIVER_USER_ID,
    status: overrides.status ?? 'DRAFT',
    startedAt: overrides.status === 'ACTIVE' ? NOW : null,
    completedAt: overrides.status === 'COMPLETED' ? NOW : null,
    cancelledAt: overrides.status === 'CANCELLED' ? NOW : null,
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    stops: overrides.stops ?? [makeStopProps(0), makeStopProps(1)],
  });

describe('DeliveryRoute (delivery-routes / WU2)', () => {
  describe('create — input validation', () => {
    it('Given an empty saleIds payload, when the route is created, then it throws DeliveryRouteInvalidTransitionError (EMPTY_SALE_IDS)', async () => {
      await expect(createRoute([])).rejects.toMatchObject({
        code: 'DELIVERY_ROUTE_INVALID_TRANSITION',
        details: { reason: 'EMPTY_SALE_IDS' },
      });
    });

    it('Given a sale whose deliveryStatus is not PENDING/SHIPPED, when the route is created, then it throws DeliveryRouteSaleNotEligibleError (INELIGIBLE_SALE)', async () => {
      const probe = makeProbe({
        'sale-1': { deliveryStatus: 'DELIVERED', shippingAddressId: 'addr-1' },
      });
      await expect(createRoute(['sale-1'], { probe })).rejects.toMatchObject({
        code: 'DELIVERY_ROUTE_STOP_SALE_NOT_ELIGIBLE',
        details: {
          reason: 'INELIGIBLE_SALE',
          saleId: 'sale-1',
          deliveryStatus: 'DELIVERED',
        },
      });
    });

    it('Given a PENDING sale without a shippingAddressId, when the route is created, then it throws DeliveryRouteSaleNotEligibleError (INELIGIBLE_SALE)', async () => {
      const probe = makeProbe({
        'sale-1': { deliveryStatus: 'PENDING', shippingAddressId: null },
      });
      await expect(createRoute(['sale-1'], { probe })).rejects.toMatchObject({
        code: 'DELIVERY_ROUTE_STOP_SALE_NOT_ELIGIBLE',
        details: {
          reason: 'INELIGIBLE_SALE',
          saleId: 'sale-1',
          hasShippingAddress: false,
        },
      });
    });

    it('Given a sale id the tenant does not own (probe resolves null), when the route is created, then it throws DeliveryRouteSaleNotEligibleError', async () => {
      const probe = makeProbe({});
      await expect(createRoute(['sale-missing'], { probe })).rejects.toBeInstanceOf(
        DeliveryRouteSaleNotEligibleError,
      );
    });

    it('Given eligible saleIds, when the route is created, then it is a DRAFT route with ordered PENDING stops', async () => {
      const route = await createRoute(['sale-1', 'sale-2']);
      expect(route.status).toBe('DRAFT');
      expect(route.startedAt).toBeNull();
      expect(route.stops.map((s) => s.saleId)).toEqual(['sale-1', 'sale-2']);
      expect(route.stops.map((s) => s.sortOrder)).toEqual([0, 1]);
      expect(route.stops.every((s) => s.status === 'PENDING')).toBe(true);
      expect(route.stops.every((s) => s.activeRouteId === null)).toBe(true);
    });
  });

  describe('start — DRAFT → ACTIVE', () => {
    it('Given a DRAFT route, when it is started, then it becomes ACTIVE, stamps startedAt, and sets activeRouteId on every stop (ADR-7)', async () => {
      const route = await createRoute(['sale-1', 'sale-2']);
      const result = route.start({ now: NOW });

      expect(result).toBe(route);
      expect(route.status).toBe('ACTIVE');
      expect(route.startedAt).toEqual(NOW);
      for (const stop of route.stops) {
        expect(stop.activeRouteId).toBe(route.id);
      }
    });

    it('Given an ACTIVE route, when it is started again, then it throws DeliveryRouteInvalidTransitionError', async () => {
      const route = await createRoute(['sale-1']);
      route.start({ now: NOW });
      expect(() => route.start({ now: NOW })).toThrow(
        DeliveryRouteInvalidTransitionError,
      );
    });
  });

  describe('cancel — DRAFT | ACTIVE → CANCELLED', () => {
    it('Given a DRAFT route, when it is cancelled, then it becomes CANCELLED and stamps cancelledAt', async () => {
      const route = await createRoute(['sale-1']);
      route.cancel({ now: NOW });

      expect(route.status).toBe('CANCELLED');
      expect(route.cancelledAt).toEqual(NOW);
      expect(route.stops[0].activeRouteId).toBeNull();
    });

    it('Given an ACTIVE route, when it is cancelled, then it becomes CANCELLED and every stop activeRouteId is cleared (ADR-7)', async () => {
      const route = await createRoute(['sale-1', 'sale-2']);
      route.start({ now: NOW });
      route.cancel({ now: NOW });

      expect(route.status).toBe('CANCELLED');
      expect(route.cancelledAt).toEqual(NOW);
      for (const stop of route.stops) {
        expect(stop.activeRouteId).toBeNull();
      }
    });

    it('Given a COMPLETED route, when it is cancelled, then it throws DeliveryRouteInvalidTransitionError (terminal state)', () => {
      const route = routeFromPersistence({
        status: 'COMPLETED',
        stops: [
          makeStopProps(0, {
            status: 'COMPLETED',
            checkedInAt: NOW,
            completedAt: NOW,
          }),
        ],
      });
      expect(() => route.cancel({ now: NOW })).toThrow(
        DeliveryRouteInvalidTransitionError,
      );
    });
  });

  describe('checkInStop — atomic per-stop completion', () => {
    it('Given an ACTIVE route with a next stop, when a stop is checked in, then the stop becomes COMPLETED, the route stays ACTIVE, and the next PENDING stop is returned', async () => {
      const route = await createRoute(['sale-1', 'sale-2']);
      route.start({ now: NOW });

      const result = route.checkInStop({ stopId: route.stops[0].id, now: NOW });

      expect(route.stops[0].status).toBe('COMPLETED');
      expect(route.stops[0].checkedInAt).toEqual(NOW);
      expect(route.stops[0].completedAt).toEqual(NOW);
      expect(route.status).toBe('ACTIVE');
      expect(result.nextStop?.id).toBe(route.stops[1].id);
      expect(result.nextStop?.saleId).toBe('sale-2');
      expect(result.completedStop.id).toBe(route.stops[0].id);
    });

    it('Given an ACTIVE route, when the last PENDING stop is checked in, then the route auto-completes, stamps completedAt, and clears activeRouteId on every stop', async () => {
      const route = await createRoute(['sale-1']);
      route.start({ now: NOW });
      expect(route.stops[0].activeRouteId).toBe(route.id);

      const result = route.checkInStop({ stopId: route.stops[0].id, now: NOW });

      expect(route.status).toBe('COMPLETED');
      expect(route.completedAt).toEqual(NOW);
      expect(result.nextStop).toBeNull();
      expect(route.stops[0].status).toBe('COMPLETED');
      expect(route.stops[0].activeRouteId).toBeNull();
    });

    it('Given an ACTIVE route, when an already-COMPLETED stop is checked in again, then it is an idempotent no-op returning the same completed stop and next stop', async () => {
      const route = await createRoute(['sale-1', 'sale-2']);
      route.start({ now: NOW });

      const first = route.checkInStop({ stopId: route.stops[0].id, now: NOW });
      const replay = route.checkInStop({ stopId: route.stops[0].id, now: NOW });

      expect(replay.completedStop.id).toBe(first.completedStop.id);
      expect(replay.nextStop?.id).toBe(first.nextStop?.id);
      expect(replay.route.status).toBe('ACTIVE');
      // No double-marking: timestamps are untouched by the replay.
      expect(replay.completedStop.checkedInAt).toEqual(
        first.completedStop.checkedInAt,
      );
      expect(replay.completedStop.completedAt).toEqual(
        first.completedStop.completedAt,
      );
    });

    it('Given a COMPLETED route, when its completed stop is checked in again (replayed final check-in), then it is an idempotent no-op', async () => {
      const route = await createRoute(['sale-1']);
      route.start({ now: NOW });
      const first = route.checkInStop({ stopId: route.stops[0].id, now: NOW });
      expect(first.route.status).toBe('COMPLETED');

      const replay = route.checkInStop({ stopId: route.stops[0].id, now: NOW });

      expect(replay.route.status).toBe('COMPLETED');
      expect(replay.nextStop).toBeNull();
      expect(replay.completedStop.id).toBe(route.stops[0].id);
    });

    it('Given an ACTIVE route, when a stop id that does not belong to the route is checked in, then it throws DeliveryRouteInvalidTransitionError (UNKNOWN_STOP_ID)', async () => {
      const route = await createRoute(['sale-1', 'sale-2']);
      route.start({ now: NOW });

      expect(() =>
        route.checkInStop({ stopId: 'stop-not-in-route', now: NOW }),
      ).toThrow(DeliveryRouteInvalidTransitionError);
    });

    it('Given a DRAFT route, when a stop is checked in, then it throws DeliveryRouteInvalidTransitionError (CHECKIN_NOT_ACTIVE)', async () => {
      const route = await createRoute(['sale-1']);
      expect(() => route.checkInStop({ stopId: route.stops[0].id, now: NOW })).toThrow(
        DeliveryRouteInvalidTransitionError,
      );
    });
  });

  describe('canDelete — DRAFT-only hard-delete precondition', () => {
    it('Given a DRAFT route with zero stops, then canDelete() returns true', () => {
      const route = routeFromPersistence({ status: 'DRAFT', stops: [] });
      expect(route.canDelete()).toBe(true);
    });

    it('Given a DRAFT route with stops, then canDelete() returns false', async () => {
      const route = await createRoute(['sale-1']);
      expect(route.canDelete()).toBe(false);
    });

    it('Given an ACTIVE route, then canDelete() returns false (delete rejected)', async () => {
      const route = await createRoute(['sale-1']);
      route.start({ now: NOW });
      expect(route.canDelete()).toBe(false);
    });
  });

  describe('reorderStops — DRAFT-only', () => {
    it('Given a DRAFT route, when the stops are reordered, then the stop order and sortOrder reflect the new sequence', async () => {
      const route = await createRoute(['sale-1', 'sale-2', 'sale-3']);
      const [a, b, c] = route.stops;

      route.reorderStops({ orderedStopIds: [c.id, a.id, b.id], now: NOW });

      expect(route.stops.map((s) => s.id)).toEqual([c.id, a.id, b.id]);
      expect(route.stops.map((s) => s.saleId)).toEqual(['sale-3', 'sale-1', 'sale-2']);
      expect(route.stops.map((s) => s.sortOrder)).toEqual([0, 1, 2]);
    });

    it('Given a DRAFT route, when reorderStops references a stop id outside the route, then it throws DeliveryRouteInvalidTransitionError', async () => {
      const route = await createRoute(['sale-1', 'sale-2']);
      expect(() =>
        route.reorderStops({
          orderedStopIds: [route.stops[0].id, 'stop-foreign'],
        }),
      ).toThrow(DeliveryRouteInvalidTransitionError);
    });

    it('Given an ACTIVE route, when the stops are reordered, then it throws DeliveryRouteInvalidTransitionError (DRAFT-only)', async () => {
      const route = await createRoute(['sale-1', 'sale-2']);
      route.start({ now: NOW });
      expect(() =>
        route.reorderStops({
          orderedStopIds: [route.stops[1].id, route.stops[0].id],
        }),
      ).toThrow(DeliveryRouteInvalidTransitionError);
    });
  });

  describe('assignDriver — DRAFT-only', () => {
    it('Given a DRAFT route, when the driver is reassigned, then the route exposes the new driverUserId (and the persistence projection carries it)', async () => {
      const route = await createRoute(['sale-1']);
      route.assignDriver({ driverUserId: 'driver-2', now: NOW });

      expect(route.driverUserId).toBe('driver-2');
      expect(route.toPersistence().driverUserId).toBe('driver-2');
    });

    it('Given an ACTIVE route, when the driver is reassigned, then it throws DeliveryRouteInvalidTransitionError (DRAFT-only, ADR Q4)', async () => {
      const route = await createRoute(['sale-1']);
      route.start({ now: NOW });
      expect(() =>
        route.assignDriver({ driverUserId: 'driver-2', now: NOW }),
      ).toThrow(DeliveryRouteInvalidTransitionError);
    });
  });
});
