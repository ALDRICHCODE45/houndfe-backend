/**
 * Timeline builder — delivery-routes / WU3 (design §7.3).
 *
 * Pure function that assembles the `timeline: DeliveryRouteTimelineEventDto[]`
 * array returned by `GET /delivery-routes/:id`. Mirrors the
 * `buildSaleTimeline` style (`src/sales/domain/build-sale-timeline.ts`):
 * no I/O, no Prisma, no NestJS. The service layer hands in the
 * already-projected read model + driver identity and gets back a
 * deterministically-sorted array of timeline events.
 *
 * **Event ordering.** All events are sorted by `at` ascending so the
 * caller does not need to rely on the projection order. The function
 * emits the canonical events (created / started / stopCompleted /
 * cancelled / completed) in the order the aggregate lifecycle dictates;
 * the final sort step normalizes ordering for cross-event types (e.g.
 * a stop check-in after the route completes is not possible, but the
 * sort would handle the edge case correctly).
 *
 * **Actor attribution default.** The MVP persists no per-action actor
 * ids (`createdByUserId`, `startedByUserId`, `cancelledByUserId`,
 * `checkedInByUserId`). The route's assigned `driver` is the single
 * available actor identity and is used for all driver-attributable
 * events; `ROUTE_CREATED` uses `null` (no creator is tracked). If a
 * future change needs precise per-action actors, those columns are
 * additive.
 *
 * Spec: design.md §7.3 + spec scenario *DeliveryRoute Timeline
 * Mirrors buildSaleTimeline*.
 */
import type { DeliveryRouteTimelineEventDto } from '../dto/delivery-route-response.dto';

export interface BuildDeliveryRouteTimelineInput {
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  driver: { id: string; name: string } | null;
  stops: ReadonlyArray<{
    id: string;
    sortOrder: number;
    checkedInAt: Date | null;
  }>;
}

export function buildDeliveryRouteTimeline(
  input: BuildDeliveryRouteTimelineInput,
): DeliveryRouteTimelineEventDto[] {
  const driverActor = input.driver
    ? { id: input.driver.id, name: input.driver.name }
    : null;

  const events: DeliveryRouteTimelineEventDto[] = [];

  // 1. Always emit ROUTE_CREATED at createdAt with actor=null (no
  //    creator is tracked in MVP).
  events.push({
    type: 'ROUTE_CREATED',
    at: input.createdAt.toISOString(),
    actor: null,
  });

  // 2. ROUTE_STARTED at startedAt (actor = driver).
  if (input.startedAt) {
    events.push({
      type: 'ROUTE_STARTED',
      at: input.startedAt.toISOString(),
      actor: driverActor,
    });
  }

  // 3. STOP_CHECKED_IN per stop with non-null checkedInAt (actor = driver).
  for (const stop of input.stops) {
    if (!stop.checkedInAt) continue;
    events.push({
      type: 'STOP_CHECKED_IN',
      at: stop.checkedInAt.toISOString(),
      stopId: stop.id,
      sortOrder: stop.sortOrder,
      actor: driverActor,
    });
  }

  // 4. ROUTE_COMPLETED at completedAt OR ROUTE_CANCELLED at cancelledAt
  //    (mutually exclusive; the aggregate lifecycle prevents both).
  if (input.completedAt) {
    events.push({
      type: 'ROUTE_COMPLETED',
      at: input.completedAt.toISOString(),
      actor: driverActor,
    });
  }
  if (input.cancelledAt) {
    events.push({
      type: 'ROUTE_CANCELLED',
      at: input.cancelledAt.toISOString(),
      actor: driverActor,
    });
  }

  // 5. Sort ascending by `at`. Same locale-aware compare as the sale
  //    timeline builder — ISO-8601 strings sort lexicographically.
  events.sort((a, b) => a.at.localeCompare(b.at));
  return events;
}
