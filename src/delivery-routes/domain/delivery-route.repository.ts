/**
 * PORT: IDeliveryRouteRepository (Driven Port) — delivery-routes / WU2.
 *
 * Persistence contract for the `DeliveryRoute` aggregate. The concrete
 * Prisma adapter lives in
 * `infrastructure/prisma-delivery-route.repository.ts` and is wired into
 * NestJS DI via the `DELIVERY_ROUTE_REPOSITORY` Symbol token (matches
 * the cross-context seam convention used by `MAILER`,
 * `NOTIFICATION_CONFIG_REPOSITORY`, `USER_EMAIL_LOOKUP`, etc.).
 *
 * TENANT SCOPING: every read method takes an explicit `tenantId`; cross-
 * tenant access returns `null` / empty arrays. The HTTP layer translates
 * cross-tenant misses to 404 (`DeliveryRouteNotFoundError`) so presence
 * is indistinguishable across tenants.
 *
 * The outbox-claim trio (`claimNextOutboxEvent` / `markOutboxEventSent`
 * / `markOutboxEventFailed`) is a port-side seam so the WU3 dedicated
 * poller / dispatcher can sit in the same module without reaching for
 * the global Prisma client. WU2 ships the signatures; the WU3 poller
 * wires them up.
 */
import type {
  DeliveryRoute,
  DeliveryRouteStatusValue,
} from './delivery-route.entity';
import type { DeliveryRouteStopStatusValue } from './delivery-route-stop.entity';

export const DELIVERY_ROUTE_REPOSITORY = Symbol.for('IDeliveryRouteRepository');

/**
 * The state identity of a route snapshot a caller loaded and evaluated
 * (ODD O1). `commitTransition` compares exactly these fields —
 * tenant-qualified — at write time, so a transition built from a stale
 * snapshot is detected and the caller can re-evaluate against freshly
 * persisted state instead of overwriting a concurrent winner. This is
 * the seam that replaces the unconditional full aggregate replacement
 * for check-in / cancel.
 */
export interface DeliveryRouteStateExpectation {
  status: DeliveryRouteStatusValue;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  updatedAt: Date;
  stops: Array<{
    id: string;
    status: DeliveryRouteStopStatusValue;
    checkedInAt: Date | null;
    completedAt: Date | null;
    activeRouteId: string | null;
  }>;
}

/**
 * Outcome of the conditional aggregate commit. `stale` means at least one
 * predicate no longer matched the persisted row: nothing of that attempt
 * may be treated as applied — the caller re-evaluates from fresh state.
 * `missing` means the route is gone (or belongs to another tenant); the
 * two are deliberately indistinguishable to the HTTP layer (404).
 */
export type DeliveryRouteTransitionOutcome =
  | { kind: 'committed' }
  | { kind: 'stale' }
  | { kind: 'missing' };

export type DeliveryRouteStatusFilter =
  | 'DRAFT'
  | 'ACTIVE'
  | 'COMPLETED'
  | 'CANCELLED';

export interface ListDeliveryRoutesInput {
  tenantId: string;
  /** Optional filter — driver list scope uses this when the caller is
   *  driver-only. Admins / route-managers pass undefined. */
  driverUserId?: string;
  /** Optional status filter. Multi-value is OR. */
  status?: DeliveryRouteStatusFilter[];
}

/**
 * Read-model projection for `findOneWithStops`. Mirrors the Sale
 * `findOneWithRelations` shape (design §7.2): route fields, driver
 * projection, per-stop sale folio + customer + shipping address. The
 * ADR-7 `activeRouteId` marker column is NOT selected (it is
 * authorization / invariant machinery, not wire data).
 */
export interface DeliveryRouteReadModel {
  id: string;
  tenantId: string;
  driverUserId: string;
  status: DeliveryRouteStatusFilter;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  driver: { id: string; name: string; email: string } | null;
  stops: Array<{
    id: string;
    saleId: string;
    saleFolio: string | null;
    sortOrder: number;
    status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'SKIPPED';
    checkedInAt: Date | null;
    completedAt: Date | null;
    customer: { id: string; name: string; email: string | null } | null;
    shippingAddress: {
      id: string;
      street: string | null;
      exteriorNumber: string | null;
      interiorNumber: string | null;
      zipCode: string | null;
      neighborhood: string | null;
      municipality: string | null;
      city: string | null;
      state: string | null;
      label: string | null;
    } | null;
  }>;
}

export interface IDeliveryRouteRepository {
  /** Persist a route (insert or update). The implementation handles the
   *  parent row + child stop set (createMany / deleteMany) atomically. */
  save(route: DeliveryRoute): Promise<DeliveryRoute>;

  /**
   * Tenant-qualified CONDITIONAL transition commit for the concurrent
   * check-in / cancel paths (ODD O1).
   *
   * Runs inside the supplied transaction and:
   *   1. compare-and-sets the parent row against `expected` (status +
   *      timestamps + `updatedAt`), so a route-level write that committed
   *      after the caller loaded its snapshot is detected;
   *   2. compare-and-sets ONLY the stops this transition changed, against
   *      their expected prior state (status / timestamps / activeRouteId),
   *      so another writer's stop completion is never overwritten or
   *      resurrected (no delete-then-recreate of the stop set);
   *   3. re-derives route auto-completion from the PERSISTED stop set: an
   *      ACTIVE route left with zero pending stops becomes COMPLETED and
   *      its ADR-7 markers are cleared.
   *
   * Every predicate carries `tenantId` explicitly (no tenant extension may
   * be assumed inside a transaction). Returns `stale` without applying the
   * caller's desired state whenever a predicate misses; the caller owns
   * re-evaluation and the retry policy. */
  commitTransition(input: {
    tx: import('@prisma/client').Prisma.TransactionClient;
    tenantId: string;
    routeId: string;
    /** Snapshot the caller loaded before mutating. */
    expected: DeliveryRouteStateExpectation;
    /** The mutated aggregate to persist when `expected` is current. */
    next: DeliveryRoute;
  }): Promise<DeliveryRouteTransitionOutcome>;

  /** Tenant-scoped find by id. Returns null on cross-tenant or missing. */
  findById(input: { tenantId: string; id: string }): Promise<DeliveryRoute | null>;

  /** Projected read model used by the detail endpoint. null on miss. */
  findOneWithStops(input: {
    tenantId: string;
    id: string;
  }): Promise<DeliveryRouteReadModel | null>;

  /** List routes with optional driver / status filter. */
  list(input: ListDeliveryRoutesInput): Promise<DeliveryRouteReadModel[]>;

  /** Authorization helper: returns the route's `driverUserId` or null.
   *  Used by the CASL subject-instance resolver registry (design ADR-5)
   *  so the guard can evaluate `{ driverUserId: <userId> }` conditions
   *  without re-loading the full aggregate. null on cross-tenant / miss. */
  findDriverUserIdById(input: {
    tenantId: string;
    id: string;
  }): Promise<{ driverUserId: string } | null>;

  /** Hard-delete a DRAFT route (no stops). Adapter MUST enforce the
   *  precondition (status='DRAFT' AND zero stops) inside the same
   *  transaction. Throws otherwise. */
  delete(input: { tenantId: string; id: string }): Promise<void>;

  /** Run a callback inside a Prisma transaction. The callback receives
   *  the raw transaction client so it can compose writes across the
   *  sale + outbox + stop tables atomically (design §5). */
  runInTransaction<T>(
    work: (tx: import('@prisma/client').Prisma.TransactionClient) => Promise<T>,
  ): Promise<T>;

  // ── Outbox seam (WU3 poller/dispatcher) ──────────────────────────────
  // The signature trio is in the WU2 port so the WU3 poller/dispatcher
  // can be wired without churning the interface. The implementations
  // live in the WU3 poller/dispatcher files (not in the WU2 adapter).

  /** Claim the next PENDING `delivery.next_stop.notify` outbox event
   *  inside the supplied transaction (FOR UPDATE SKIP LOCKED). */
  claimNextOutboxEvent(
    tx: import('@prisma/client').Prisma.TransactionClient,
  ): Promise<unknown | null>;

  /** Mark a claimed outbox event as PUBLISHED (CAS via `lockToken`). */
  markOutboxEventSent(input: {
    eventId: string;
    lockToken: string;
  }): Promise<void>;

  /** Mark a claimed outbox event as FAILED (CAS via `lockToken`). */
  markOutboxEventFailed(input: {
    eventId: string;
    lockToken: string;
    errorMessage: string;
  }): Promise<void>;

  /** Session-scoped accessor so the service can compose writes against
   *  the ambient Prisma transaction client (mirrors `TenantPrismaService.
   *  getClient()`). Returns `null` when not inside a transaction. */
  getTransactionClient(): import('@prisma/client').Prisma.TransactionClient | null;
}
