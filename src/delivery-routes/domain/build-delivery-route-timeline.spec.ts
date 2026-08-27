/**
 * DOMAIN UNIT SPEC: buildDeliveryRouteTimeline — delivery-routes / WU3 (3.14).
 *
 * Pure-function coverage mirroring the WU2 entity spec style:
 *   - ROUTE_CREATED is always emitted at createdAt with actor=null.
 *   - ROUTE_STARTED is emitted at startedAt (driver actor).
 *   - STOP_CHECKED_IN is emitted per stop with non-null checkedInAt.
 *   - ROUTE_COMPLETED / ROUTE_CANCELLED are emitted mutually exclusive.
 *   - Final sort is ascending by `at`.
 *
 * Spec: design.md §7.3 + spec scenario *DeliveryRoute Timeline Mirrors
 * buildSaleTimeline*.
 */
import { buildDeliveryRouteTimeline } from './build-delivery-route-timeline';
import type { DeliveryRouteTimelineEventDto } from '../dto/delivery-route-response.dto';

const driver = { id: 'driver-1', name: 'Driver One' };

describe('buildDeliveryRouteTimeline (delivery-routes / WU3)', () => {
  it('Given a freshly created DRAFT route (no stops), when the timeline is built, then it contains ONLY ROUTE_CREATED at createdAt with actor=null', () => {
    const createdAt = new Date('2026-08-01T10:00:00.000Z');
    const events = buildDeliveryRouteTimeline({
      createdAt,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      driver,
      stops: [],
    });
    expect(events).toEqual([
      {
        type: 'ROUTE_CREATED',
        at: createdAt.toISOString(),
        actor: null,
      },
    ]);
  });

  it('Given a started route with no stop check-ins, when the timeline is built, then it contains ROUTE_CREATED + ROUTE_STARTED (driver actor)', () => {
    const createdAt = new Date('2026-08-01T10:00:00.000Z');
    const startedAt = new Date('2026-08-01T11:00:00.000Z');
    const events = buildDeliveryRouteTimeline({
      createdAt,
      startedAt,
      completedAt: null,
      cancelledAt: null,
      driver,
      stops: [],
    });
    expect(events.map((e) => e.type)).toEqual(['ROUTE_CREATED', 'ROUTE_STARTED']);
    expect(events[1]).toMatchObject({ actor: driver });
    expect(events[1].at).toBe(startedAt.toISOString());
  });

  it('Given a started route with two checked-in stops, when the timeline is built, then it contains ROUTE_CREATED + ROUTE_STARTED + 2× STOP_CHECKED_IN', () => {
    const createdAt = new Date('2026-08-01T10:00:00.000Z');
    const startedAt = new Date('2026-08-01T11:00:00.000Z');
    const checkedInA = new Date('2026-08-01T11:30:00.000Z');
    const checkedInB = new Date('2026-08-01T12:30:00.000Z');
    const events = buildDeliveryRouteTimeline({
      createdAt,
      startedAt,
      completedAt: null,
      cancelledAt: null,
      driver,
      stops: [
        { id: 'stop-a', sortOrder: 0, checkedInAt: checkedInA },
        { id: 'stop-b', sortOrder: 1, checkedInAt: null },
        { id: 'stop-c', sortOrder: 2, checkedInAt: checkedInB },
      ],
    });
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'ROUTE_CREATED',
      'ROUTE_STARTED',
      'STOP_CHECKED_IN',
      'STOP_CHECKED_IN',
    ]);
    // PENDING stop (stop-b) is skipped — no STOP_CHECKED_IN event.
    const stopCheckIns = events.filter(
      (e): e is Extract<DeliveryRouteTimelineEventDto, { type: 'STOP_CHECKED_IN' }> =>
        e.type === 'STOP_CHECKED_IN',
    );
    expect(stopCheckIns.map((e) => e.stopId)).toEqual(['stop-a', 'stop-c']);
    expect(stopCheckIns[0].sortOrder).toBe(0);
    expect(stopCheckIns[1].sortOrder).toBe(2);
  });

  it('Given a COMPLETED route, when the timeline is built, then it ends with ROUTE_COMPLETED (driver actor)', () => {
    const createdAt = new Date('2026-08-01T10:00:00.000Z');
    const startedAt = new Date('2026-08-01T11:00:00.000Z');
    const completedAt = new Date('2026-08-01T12:00:00.000Z');
    const events = buildDeliveryRouteTimeline({
      createdAt,
      startedAt,
      completedAt,
      cancelledAt: null,
      driver,
      stops: [
        { id: 'stop-a', sortOrder: 0, checkedInAt: completedAt },
      ],
    });
    expect(events[events.length - 1].type).toBe('ROUTE_COMPLETED');
    expect(events[events.length - 1]).toMatchObject({ actor: driver });
  });

  it('Given a CANCELLED route, when the timeline is built, then the timeline ends with ROUTE_CANCELLED and contains NO ROUTE_COMPLETED', () => {
    const createdAt = new Date('2026-08-01T10:00:00.000Z');
    const cancelledAt = new Date('2026-08-01T11:30:00.000Z');
    const events = buildDeliveryRouteTimeline({
      createdAt,
      startedAt: null,
      completedAt: null,
      cancelledAt,
      driver,
      stops: [],
    });
    const types = events.map((e) => e.type);
    expect(types[types.length - 1]).toBe('ROUTE_CANCELLED');
    expect(types).not.toContain('ROUTE_COMPLETED');
  });

  it('Given a route with no driver, when the timeline is built, then driver-attributable events use actor=null', () => {
    const createdAt = new Date('2026-08-01T10:00:00.000Z');
    const startedAt = new Date('2026-08-01T11:00:00.000Z');
    const events = buildDeliveryRouteTimeline({
      createdAt,
      startedAt,
      completedAt: null,
      cancelledAt: null,
      driver: null,
      stops: [],
    });
    expect(events[1]).toMatchObject({ actor: null });
  });

  it('Given events with mixed `at` timestamps, when the timeline is built, then the result is sorted ascending by `at`', () => {
    const createdAt = new Date('2026-08-01T10:00:00.000Z');
    const startedAt = new Date('2026-08-01T09:00:00.000Z'); // intentionally before createdAt for the sort test
    const events = buildDeliveryRouteTimeline({
      createdAt,
      startedAt,
      completedAt: null,
      cancelledAt: null,
      driver,
      stops: [],
    });
    const ats = events.map((e) => e.at);
    expect(ats).toEqual([...ats].sort());
  });
});
