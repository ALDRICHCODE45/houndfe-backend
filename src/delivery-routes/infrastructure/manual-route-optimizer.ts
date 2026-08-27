/**
 * ADAPTER: ManualRouteOptimizer — delivery-routes / WU2 (design ADR-4).
 *
 * Default `IRouteOptimizer` adapter for the MVP. The optimizer is a pure
 * identity: it returns the caller-supplied `saleIds` in the same order.
 * No GPS, no distance, no time-window — those land in a future
 * map-provider adapter via a one-line DI swap.
 *
 * Registered in `DeliveryRoutesModule` as
 * `{ provide: ROUTE_OPTIMIZER, useClass: ManualRouteOptimizer }`. The
 * domain depends only on the port; swapping the adapter does not
 * require any change in the service / aggregate.
 */
import { Injectable } from '@nestjs/common';
import type {
  IRouteOptimizer,
  OptimizeRouteInput,
  OptimizeRouteResult,
} from '../domain/ports/route-optimizer.port';

@Injectable()
export class ManualRouteOptimizer implements IRouteOptimizer {
  async optimize(input: OptimizeRouteInput): Promise<OptimizeRouteResult> {
    if (!Array.isArray(input.saleIds)) {
      throw new Error('ManualRouteOptimizer requires saleIds to be an array');
    }
    // Identity — the manual MVP trusts the caller's order. We clone the
    // array so the caller cannot mutate the result through the input
    // reference (defensive but cheap).
    return { orderedSaleIds: [...input.saleIds] };
  }
}
