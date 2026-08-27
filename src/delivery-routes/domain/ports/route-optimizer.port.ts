/**
 * PORT: IRouteOptimizer — delivery-routes / WU2 (design ADR-4).
 *
 * Hides route-ordering logic behind a Symbol-port seam so a future map-
 * provider adapter can replace the manual identity adapter with a one-
 * line DI change. The MVP `ManualRouteOptimizer` returns the input
 * order verbatim — no GPS / distance / time-window optimization.
 *
 * The token is `Symbol.for('IRouteOptimizer')`, matching the cross-
 * context convention used by `MAILER`, `USER_EMAIL_LOOKUP`,
 * `NOTIFICATION_CONFIG_REPOSITORY`. The proposal chose ONE convention
 * for the new context rather than mirroring the codebase's mixed
 * `Symbol('…')` / `Symbol.for('…')` history.
 *
 * The `saleIds` parameter is the unordered set of eligible sale ids the
 * caller resolved; the optimizer returns the order the route should
 * persist. For WU2 the consumer side is the service `create` /
 * `addStop` / `reorderStops` paths.
 */
export const ROUTE_OPTIMIZER = Symbol.for('IRouteOptimizer');

export interface OptimizeRouteInput {
  tenantId: string;
  saleIds: string[];
}

export interface OptimizeRouteResult {
  /** Optimizer-supplied order. The MVP returns the caller's order. */
  orderedSaleIds: string[];
}

export interface IRouteOptimizer {
  optimize(input: OptimizeRouteInput): Promise<OptimizeRouteResult>;
}
