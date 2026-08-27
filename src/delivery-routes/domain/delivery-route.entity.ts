/**
 * AGGREGATE ROOT: DeliveryRoute (delivery-routes / WU2).
 *
 * Tenant-scoped aggregate that groups eligible `Sale`s into an ordered
 * list of `DeliveryRouteStop`s assigned to a driver `User`. Owns the
 * four-state lifecycle:
 *
 *   DRAFT ──start──▶ ACTIVE ──checkInStop(last)──▶ COMPLETED
 *     │                  │
 *     └──cancel──┐  ┌──cancel──┐
 *                ▼  ▼
 *              CANCELLED
 *
 * Pure domain — no NestJS, no Prisma, no I/O. The Sale eligibility check
 * the create/start transitions rely on (`deliveryStatus ∈ {PENDING,
 * SHIPPED}` + non-null `shippingAddressId`) is supplied as a callback
 * `checkSaleEligibility: (saleId) => SaleEligibilitySnapshot` so the
 * domain stays decoupled from the Sale repository.
 *
 * Lifecycle guards raise `DeliveryRouteInvalidTransitionError` (422).
 * Sale-conflict checks raise `DeliveryRouteSaleAlreadyInActiveRouteError`
 * (409) so the global filter maps the partial-unique-index race to the
 * correct HTTP status. The aggregate performs the application-level
 * pre-check; the DB index is the race-safe authoritative guard.
 */
import { randomUUID } from 'node:crypto';
import {
  DeliveryRouteInvalidTransitionError,
  DeliveryRouteSaleNotEligibleError,
} from './delivery-route.errors';
import {
  DeliveryRouteStop,
  type DeliveryRouteStopProps,
} from './delivery-route-stop.entity';

export type DeliveryRouteStatusValue =
  | 'DRAFT'
  | 'ACTIVE'
  | 'COMPLETED'
  | 'CANCELLED';

/** Snapshot the service layer provides to the aggregate when it needs
 *  to verify a sale's eligibility for delivery. Mirrors the projection
 *  loaded from the Sale repository's read path. */
export interface SaleEligibilitySnapshot {
  /** `PENDING` or `SHIPPED` only — every other value is ineligible. */
  deliveryStatus: 'PENDING' | 'DELIVERED' | 'NOT_APPLICABLE' | 'SHIPPED';
  /** Required for an ONLINE / bot sale — null blocks the route. */
  shippingAddressId: string | null;
}

export interface CreateDeliveryRouteInput {
  id?: string;
  tenantId: string;
  driverUserId: string;
  /** Ordered list of eligible sale ids. The optimizer returns the final
   *  order; the create factory routes through the optimizer. */
  saleIds: string[];
  notes?: string | null;
  /** Caller-supplied `now` (test seam). Defaults to `new Date()`. */
  now?: Date;
  /** Eligibility probe — must be supplied; null/undefined throws. */
  checkSaleEligibility: (
    saleId: string,
  ) => Promise<SaleEligibilitySnapshot | null>;
}

export interface AddStopInput {
  saleId: string;
  checkSaleEligibility: (
    saleId: string,
  ) => Promise<SaleEligibilitySnapshot | null>;
  now?: Date;
}

export interface ReorderStopsInput {
  /** New stop order as an array of stop ids in the desired sequence. */
  orderedStopIds: string[];
  now?: Date;
}

export interface AssignDriverInput {
  driverUserId: string;
  now?: Date;
}

export interface StartInput {
  now?: Date;
}

export interface CheckInStopInput {
  stopId: string;
  now?: Date;
}

export interface CancelInput {
  now?: Date;
}

export interface DeleteInput {
  now?: Date;
  /** Optional: hard-delete only when zero stops exist (WU2 rule). */
}

export interface FromPersistenceDeliveryRouteInput {
  id: string;
  tenantId: string;
  driverUserId: string;
  status: DeliveryRouteStatusValue;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  stops: DeliveryRouteStopProps[];
}

/**
 * Result of `checkInStop`: returns the stop the caller can use to emit
 * the next-stop outbox event (or null when the route was auto-completed
 * by this check-in — no next stop exists).
 */
export interface CheckInStopResult {
  route: DeliveryRoute;
  /** The COMPLETED stop (so the service can reference its id in the
   *  outbox payload's `currentStopId` and decide whether a next stop
   *  exists). */
  completedStop: DeliveryRouteStop;
  /** The next PENDING stop in sortOrder order, or null when the route
   *  is now COMPLETED. */
  nextStop: DeliveryRouteStop | null;
}

export class DeliveryRoute {
  private _stops: DeliveryRouteStop[];
  private _status: DeliveryRouteStatusValue;
  private _driverUserId: string;
  private _startedAt: Date | null;
  private _completedAt: Date | null;
  private _cancelledAt: Date | null;
  private _notes: string | null;
  private _updatedAt: Date;

  private constructor(
    public readonly id: string,
    public readonly tenantId: string,
    driverUserId: string,
    status: DeliveryRouteStatusValue,
    startedAt: Date | null,
    completedAt: Date | null,
    cancelledAt: Date | null,
    notes: string | null,
    public readonly createdAt: Date,
    updatedAt: Date,
    stops: DeliveryRouteStop[],
  ) {
    this._stops = stops;
    this._status = status;
    this._driverUserId = driverUserId;
    this._startedAt = startedAt;
    this._completedAt = completedAt;
    this._cancelledAt = cancelledAt;
    this._notes = notes;
    this._updatedAt = updatedAt;
  }

  // ── Factories ────────────────────────────────────────────────────────

  /**
   * Build a fresh DRAFT route with at least one stop. The sale ids are
   * run through the eligibility probe; every ineligible sale surfaces
   * as `DeliveryRouteSaleNotEligibleError` (422). Stops are created with
   * `sortOrder = 0..n-1` and `status = PENDING`. The optimizer is NOT
   * invoked here — the caller already passes the desired order through
   * `saleIds` (mirrors the manual adapter MVP). A future map-provider
   * adapter can be plugged in by pre-sorting `saleIds` upstream.
   */
  static async create(input: CreateDeliveryRouteInput): Promise<DeliveryRoute> {
    if (!input.tenantId || input.tenantId.trim() === '') {
      throw new Error('DeliveryRoute tenantId is required');
    }
    if (!input.driverUserId || input.driverUserId.trim() === '') {
      throw new Error('DeliveryRoute driverUserId is required');
    }
    if (!Array.isArray(input.saleIds) || input.saleIds.length < 1) {
      throw new DeliveryRouteInvalidTransitionError(
        'A DeliveryRoute requires at least one sale',
        { reason: 'EMPTY_SALE_IDS' },
      );
    }
    // Reject duplicate sale ids inside the same create — the partial
    // unique index only catches the "two ACTIVE routes claim the same
    // sale" race; a duplicate within a single create is a programmer
    // error and surfaces immediately.
    const uniqueSaleIds = new Set(input.saleIds);
    if (uniqueSaleIds.size !== input.saleIds.length) {
      throw new DeliveryRouteSaleNotEligibleError(
        'Duplicate saleIds in the same create payload',
        { reason: 'DUPLICATE_SALE_IDS' },
      );
    }
    if (typeof input.checkSaleEligibility !== 'function') {
      throw new Error('DeliveryRoute.create requires checkSaleEligibility');
    }

    const now = input.now ?? new Date();
    const stops: DeliveryRouteStop[] = [];
    for (let index = 0; index < input.saleIds.length; index++) {
      const saleId = input.saleIds[index];
      const eligibility = await input.checkSaleEligibility(saleId);
      if (
        !eligibility ||
        (eligibility.deliveryStatus !== 'PENDING' &&
          eligibility.deliveryStatus !== 'SHIPPED') ||
        !eligibility.shippingAddressId
      ) {
        throw new DeliveryRouteSaleNotEligibleError(
          `Sale "${saleId}" is not eligible for delivery`,
          {
            reason: 'INELIGIBLE_SALE',
            saleId,
            deliveryStatus: eligibility?.deliveryStatus ?? null,
            hasShippingAddress: Boolean(eligibility?.shippingAddressId),
          },
        );
      }
      stops.push(
        DeliveryRouteStop.create({
          id: randomUUID(),
          tenantId: input.tenantId,
          routeId: input.id ?? 'pending',
          saleId,
          sortOrder: index,
          now,
        }),
      );
    }

    return new DeliveryRoute(
      input.id ?? randomUUID(),
      input.tenantId,
      input.driverUserId,
      'DRAFT',
      null,
      null,
      null,
      input.notes ? input.notes.trim() || null : null,
      now,
      now,
      stops,
    );
  }

  /**
   * Re-hydrate from a Prisma row (no validation, no eligibility probe).
   * The routeId on every stop must be rewritten to the aggregate's id
   * so the persistence projection is self-consistent.
   */
  static fromPersistence(
    input: FromPersistenceDeliveryRouteInput,
  ): DeliveryRoute {
    const stops = input.stops.map((stop) =>
      DeliveryRouteStop.fromPersistence({
        ...stop,
        routeId: input.id,
      }),
    );
    return new DeliveryRoute(
      input.id,
      input.tenantId,
      input.driverUserId,
      input.status,
      input.startedAt,
      input.completedAt,
      input.cancelledAt,
      input.notes,
      input.createdAt,
      input.updatedAt,
      stops,
    );
  }

  // ── Getters ──────────────────────────────────────────────────────────

  get driverUserId(): string {
    return this._driverUserId;
  }

  get status(): DeliveryRouteStatusValue {
    return this._status;
  }

  get startedAt(): Date | null {
    return this._startedAt;
  }

  get completedAt(): Date | null {
    return this._completedAt;
  }

  get cancelledAt(): Date | null {
    return this._cancelledAt;
  }

  get notes(): string | null {
    return this._notes;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  get stops(): ReadonlyArray<DeliveryRouteStop> {
    return this._stops;
  }

  // ── DRAFT-only mutators ─────────────────────────────────────────────

  /**
   * Append a stop to a DRAFT route. Re-checks eligibility through the
   * probe — same rule as `create`. The new stop gets the next
   * `sortOrder` index.
   */
  async addStop(input: AddStopInput): Promise<DeliveryRoute> {
    this.assertDraft();
    if (typeof input.checkSaleEligibility !== 'function') {
      throw new Error('DeliveryRoute.addStop requires checkSaleEligibility');
    }
    const eligibility = await input.checkSaleEligibility(input.saleId);
    if (
      !eligibility ||
      (eligibility.deliveryStatus !== 'PENDING' &&
        eligibility.deliveryStatus !== 'SHIPPED') ||
      !eligibility.shippingAddressId
    ) {
      throw new DeliveryRouteSaleNotEligibleError(
        `Sale "${input.saleId}" is not eligible for delivery`,
        {
          reason: 'INELIGIBLE_SALE',
          saleId: input.saleId,
          deliveryStatus: eligibility?.deliveryStatus ?? null,
          hasShippingAddress: Boolean(eligibility?.shippingAddressId),
        },
      );
    }
    const now = input.now ?? new Date();
    const nextIndex = this._stops.length;
    this._stops.push(
      DeliveryRouteStop.create({
        id: randomUUID(),
        tenantId: this.tenantId,
        routeId: this.id,
        saleId: input.saleId,
        sortOrder: nextIndex,
        now,
      }),
    );
    this._updatedAt = now;
    return this;
  }

  /**
   * Replace the stop order with `orderedStopIds` (DRAFT-only). Stops not
   * mentioned in the input are dropped; stops mentioned twice throw.
   * `sortOrder` is rewritten to the new position index so the DB
   * `@@unique([routeId, sortOrder])` constraint is preserved.
   */
  reorderStops(input: ReorderStopsInput): DeliveryRoute {
    this.assertDraft();
    if (!Array.isArray(input.orderedStopIds)) {
      throw new Error('orderedStopIds must be an array');
    }
    if (input.orderedStopIds.length !== this._stops.length) {
      throw new DeliveryRouteInvalidTransitionError(
        'reorderStops must reference every stop exactly once',
        {
          reason: 'REORDER_LENGTH_MISMATCH',
          expected: this._stops.length,
          received: input.orderedStopIds.length,
        },
      );
    }
    const byId = new Map(this._stops.map((s) => [s.id, s]));
    const seen = new Set<string>();
    const reordered: DeliveryRouteStop[] = [];
    for (let index = 0; index < input.orderedStopIds.length; index++) {
      const stopId = input.orderedStopIds[index];
      const stop = byId.get(stopId);
      if (!stop) {
        throw new DeliveryRouteInvalidTransitionError(
          `Stop "${stopId}" does not belong to this route`,
          { reason: 'UNKNOWN_STOP_ID', stopId },
        );
      }
      if (seen.has(stopId)) {
        throw new DeliveryRouteInvalidTransitionError(
          'Stop ids in orderedStopIds must be unique',
          { reason: 'DUPLICATE_STOP_ID', stopId },
        );
      }
      seen.add(stopId);
      stop.setSortOrder(index);
      reordered.push(stop);
    }
    this._stops = reordered;
    this._updatedAt = input.now ?? new Date();
    return this;
  }

  /** DRAFT-only — reassign the driver User. Mid-route reassignment is
   *  intentionally rejected per design ADR Q4. */
  assignDriver(input: AssignDriverInput): DeliveryRoute {
    this.assertDraft();
    if (!input.driverUserId || input.driverUserId.trim() === '') {
      throw new Error('driverUserId is required');
    }
    this._driverUserId = input.driverUserId;
    this._updatedAt = input.now ?? new Date();
    return this;
  }

  /** Set / clear notes (DRAFT-only — admin convenience). */
  updateNotes(notes: string | null, now: Date = new Date()): DeliveryRoute {
    this.assertDraft();
    this._notes = notes && notes.trim() !== '' ? notes.trim() : null;
    this._updatedAt = now;
    return this;
  }

  // ── Lifecycle transitions ────────────────────────────────────────────

  /**
   * DRAFT → ACTIVE. Sets `activeRouteId` on every stop (ADR-7) so the
   * partial unique index `(tenantId, saleId) WHERE activeRouteId IS NOT
   * NULL` arms. The route's `_driverUserId` is immutable from here.
   */
  start(input: StartInput): DeliveryRoute {
    this.assertDraft();
    if (this._stops.length < 1) {
      throw new DeliveryRouteInvalidTransitionError(
        'Cannot start a route with zero stops',
        { reason: 'EMPTY_ROUTE' },
      );
    }
    const now = input.now ?? new Date();
    for (const stop of this._stops) {
      stop.setActiveRouteId(this.id);
    }
    this._status = 'ACTIVE';
    this._startedAt = now;
    this._updatedAt = now;
    return this;
  }

  /**
   * ACTIVE → COMPLETED-via-check-in. Flips the target stop to COMPLETED
   * and stamps both timestamps. Idempotent on a COMPLETED stop (returns
   * the existing state without double-marking). When this is the last
   * PENDING stop, the route auto-completes (clears `activeRouteId` on
   * every stop per ADR-7). When a next stop exists, the route stays
   * ACTIVE so the caller can emit the next-stop outbox event.
   *
   * The Sale mirror flip (`Sale.markDelivered`) is the service's job —
   * the aggregate stays sale-agnostic and returns `{ route, completedStop,
   * nextStop }` so the service can `Promise.all([saleRepo.markSaleDelivered,
   * outboxWriter.publish])` inside the same `runInTransaction`.
   */
  checkInStop(input: CheckInStopInput): CheckInStopResult {
    const stop = this._stops.find((s) => s.id === input.stopId);
    if (!stop) {
      throw new DeliveryRouteInvalidTransitionError(
        `Stop "${input.stopId}" does not belong to this route`,
        { reason: 'UNKNOWN_STOP_ID', stopId: input.stopId },
      );
    }
    // Idempotent replay: an already-COMPLETED stop is returned as-is
    // without double-marking, so a replayed transaction surfaces the
    // same response without a second write. Valid on an ACTIVE route
    // (mid-route replay) and on a COMPLETED route (replay of the final
    // check-in that auto-completed the route).
    if (stop.status === 'COMPLETED') {
      if (this._status !== 'ACTIVE' && this._status !== 'COMPLETED') {
        throw new DeliveryRouteInvalidTransitionError(
          `Cannot check in a stop on a route in status "${this._status}"`,
          {
            reason: 'CHECKIN_NOT_ACTIVE',
            currentStatus: this._status,
          },
        );
      }
      const nextStop = this.nextPendingStop();
      return { route: this, completedStop: stop, nextStop };
    }
    if (this._status !== 'ACTIVE') {
      throw new DeliveryRouteInvalidTransitionError(
        `Cannot check in a stop on a route in status "${this._status}"`,
        {
          reason: 'CHECKIN_NOT_ACTIVE',
          currentStatus: this._status,
        },
      );
    }
    if (stop.status !== 'PENDING') {
      throw new DeliveryRouteInvalidTransitionError(
        `Stop "${input.stopId}" cannot be checked in from status "${stop.status}"`,
        {
          reason: 'STOP_INVALID_TRANSITION',
          stopId: input.stopId,
          currentStatus: stop.status,
        },
      );
    }
    const now = input.now ?? new Date();
    stop.markCompleted(now);

    // Find the next PENDING stop in sortOrder ascending order. Returns
    // null when the route just completed its last stop.
    const nextStop = this.nextPendingStop();

    if (!nextStop) {
      // Last stop completed → auto-complete the route and clear the
      // ADR-7 active marker on every stop so the sales can join a new
      // ACTIVE route in a future change.
      for (const s of this._stops) {
        s.setActiveRouteId(null);
      }
      this._status = 'COMPLETED';
      this._completedAt = now;
      this._updatedAt = now;
    } else {
      this._updatedAt = now;
    }

    return { route: this, completedStop: stop, nextStop };
  }

  /**
   * DRAFT | ACTIVE → CANCELLED. Clears `activeRouteId` on every stop
   * (ADR-7) so the sales can join a new ACTIVE route in a future
   * change. COMPLETED is terminal.
   */
  cancel(input: CancelInput): DeliveryRoute {
    if (this._status !== 'DRAFT' && this._status !== 'ACTIVE') {
      throw new DeliveryRouteInvalidTransitionError(
        `Cannot cancel a route in status "${this._status}"`,
        {
          reason: 'CANCEL_TERMINAL',
          currentStatus: this._status,
        },
      );
    }
    const now = input.now ?? new Date();
    if (this._status === 'ACTIVE') {
      for (const stop of this._stops) {
        stop.setActiveRouteId(null);
      }
    }
    this._status = 'CANCELLED';
    this._cancelledAt = now;
    this._updatedAt = now;
    return this;
  }

  /**
   * DRAFT-only hard-delete precondition helper. The aggregate does NOT
   * own a `delete()` method that mutates state — deletion is a
   * repository concern. The aggregate exposes `canDelete()` so the
   * service can pre-check (zero stops + DRAFT) before issuing the
   * repository `delete()`.
   */
  canDelete(): boolean {
    return this._status === 'DRAFT' && this._stops.length === 0;
  }

  // ── Serialization ────────────────────────────────────────────────────

  /** Persistence projection used by the Prisma adapter on `save`. The
   *  adapter is responsible for `update` + `createMany`/`deleteMany` of
   *  the child stops; this projection is the source of truth for the
   *  parent row + the desired child stop set. */
  toPersistence(): {
    id: string;
    tenantId: string;
    driverUserId: string;
    status: DeliveryRouteStatusValue;
    startedAt: Date | null;
    completedAt: Date | null;
    cancelledAt: Date | null;
    notes: string | null;
    createdAt: Date;
    updatedAt: Date;
    stops: ReturnType<DeliveryRouteStop['toPersistence']>[];
  } {
    return {
      id: this.id,
      tenantId: this.tenantId,
      driverUserId: this.driverUserId,
      status: this._status,
      startedAt: this._startedAt,
      completedAt: this._completedAt,
      cancelledAt: this._cancelledAt,
      notes: this._notes,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
      stops: this._stops.map((s) => s.toPersistence()),
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────

  /** Next PENDING/IN_PROGRESS stop in sortOrder ascending order, or
   *  null when no stop remains (the route is auto-completing). */
  private nextPendingStop(): DeliveryRouteStop | null {
    const orderedPending = this._stops
      .filter((s) => s.status === 'PENDING' || s.status === 'IN_PROGRESS')
      .sort((a, b) => a.sortOrder - b.sortOrder);
    return orderedPending[0] ?? null;
  }

  // ── Private guards ───────────────────────────────────────────────────

  private assertDraft(): void {
    if (this._status !== 'DRAFT') {
      throw new DeliveryRouteInvalidTransitionError(
        `Operation not allowed in status "${this._status}" (DRAFT only)`,
        {
          reason: 'NOT_DRAFT',
          currentStatus: this._status,
        },
      );
    }
  }
}
