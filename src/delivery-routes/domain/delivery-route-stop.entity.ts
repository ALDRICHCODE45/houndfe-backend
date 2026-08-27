/**
 * DOMAIN ENTITY: DeliveryRouteStop — value object within the
 * `DeliveryRoute` aggregate (delivery-routes / WU2).
 *
 * Owns per-stop lifecycle state (`status`, `checkedInAt`, `completedAt`,
 * `skippedReason`) plus the ADR-7 `activeRouteId` marker that pins the
 * "one Sale in at most one ACTIVE route" invariant. Pure domain — no
 * NestJS, no Prisma, no I/O.
 *
 * Construction is via `static create(...)` (for a fresh PENDING stop on
 * `DeliveryRoute.create` / `addStop`) or `static fromPersistence(...)`
 * (round-trip from the Prisma row, no validation). Mutators return
 * `this` so the aggregate can chain them fluently.
 *
 * `markCompleted(now)` is the only stop-side transition used by WU2:
 * it flips `PENDING → COMPLETED`, sets both timestamps, and is
 * idempotent on `COMPLETED` so the route's `checkInStop` can replay
 * without doubling the outbox row.
 */
export type DeliveryRouteStopStatusValue =
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'SKIPPED';

export interface DeliveryRouteStopProps {
  id: string;
  tenantId: string;
  routeId: string;
  saleId: string;
  sortOrder: number;
  status: DeliveryRouteStopStatusValue;
  checkedInAt: Date | null;
  completedAt: Date | null;
  skippedReason: string | null;
  /**
   * ADR-7 — non-null exactly while the owning route is `ACTIVE`. The
   * partial unique index on `(tenantId, saleId) WHERE activeRouteId IS
   * NOT NULL` enforces "one Sale in at most one ACTIVE route" at commit
   * time. The value is set/cleared by the aggregate (never the stop).
   * Never exposed on the read model.
   */
  activeRouteId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateDeliveryRouteStopInput {
  id: string;
  tenantId: string;
  routeId: string;
  saleId: string;
  sortOrder: number;
  /** WU2 only creates PENDING stops. IN_PROGRESS / COMPLETED / SKIPPED
   *  are not produced by `create()` — use `fromPersistence` for those. */
  now?: Date;
}

export class DeliveryRouteStop {
  private _sortOrder: number;
  private _status: DeliveryRouteStopStatusValue;
  private _checkedInAt: Date | null;
  private _completedAt: Date | null;
  private _skippedReason: string | null;
  private _activeRouteId: string | null;
  private _updatedAt: Date;

  private constructor(
    public readonly id: string,
    public readonly tenantId: string,
    public readonly routeId: string,
    public readonly saleId: string,
    sortOrder: number,
    status: DeliveryRouteStopStatusValue,
    checkedInAt: Date | null,
    completedAt: Date | null,
    skippedReason: string | null,
    activeRouteId: string | null,
    public readonly createdAt: Date,
    updatedAt: Date,
  ) {
    this._sortOrder = sortOrder;
    this._status = status;
    this._checkedInAt = checkedInAt;
    this._completedAt = completedAt;
    this._skippedReason = skippedReason;
    this._activeRouteId = activeRouteId;
    this._updatedAt = updatedAt;
  }

  /**
   * Build a fresh PENDING stop. Sort order is validated as a non-negative
   * integer — the aggregate enforces uniqueness across the stop set.
   */
  static create(input: CreateDeliveryRouteStopInput): DeliveryRouteStop {
    if (!input.id || input.id.trim() === '') {
      throw new Error('DeliveryRouteStop id is required');
    }
    if (!input.tenantId || input.tenantId.trim() === '') {
      throw new Error('DeliveryRouteStop tenantId is required');
    }
    if (!input.routeId || input.routeId.trim() === '') {
      throw new Error('DeliveryRouteStop routeId is required');
    }
    if (!input.saleId || input.saleId.trim() === '') {
      throw new Error('DeliveryRouteStop saleId is required');
    }
    if (!Number.isInteger(input.sortOrder) || input.sortOrder < 0) {
      throw new Error(
        'DeliveryRouteStop sortOrder must be a non-negative integer',
      );
    }
    const now = input.now ?? new Date();
    return new DeliveryRouteStop(
      input.id,
      input.tenantId,
      input.routeId,
      input.saleId,
      input.sortOrder,
      'PENDING',
      null,
      null,
      null,
      null,
      now,
      now,
    );
  }

  /** Round-trip from persistence. No validation — data is already valid. */
  static fromPersistence(props: DeliveryRouteStopProps): DeliveryRouteStop {
    return new DeliveryRouteStop(
      props.id,
      props.tenantId,
      props.routeId,
      props.saleId,
      props.sortOrder,
      props.status,
      props.checkedInAt,
      props.completedAt,
      props.skippedReason,
      props.activeRouteId,
      props.createdAt,
      props.updatedAt,
    );
  }

  // ── Getters ──────────────────────────────────────────────────────────

  get sortOrder(): number {
    return this._sortOrder;
  }

  get status(): DeliveryRouteStopStatusValue {
    return this._status;
  }

  get checkedInAt(): Date | null {
    return this._checkedInAt;
  }

  get completedAt(): Date | null {
    return this._completedAt;
  }

  get skippedReason(): string | null {
    return this._skippedReason;
  }

  get activeRouteId(): string | null {
    return this._activeRouteId;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  // ── Mutators (aggregate-only) ────────────────────────────────────────

  /**
   * Flip the stop to COMPLETED and stamp both timestamps. Idempotent on
   * COMPLETED so the route's checkInStop can replay inside the same
   * transaction without emitting a second outbox row. Only the
   * aggregate mutates this method's callers (never the service layer
   * directly — the aggregate owns the lifecycle).
   */
  markCompleted(now: Date): DeliveryRouteStop {
    if (this._status === 'COMPLETED') {
      return this;
    }
    this._status = 'COMPLETED';
    this._checkedInAt = now;
    this._completedAt = now;
    this._updatedAt = now;
    return this;
  }

  /**
   * Set the ADR-7 active marker. Called by the aggregate on
   * `start()` / `cancel()` / `checkInStop()` (auto-complete). The
   * marker is the join between a stop and the active route — non-null
   * exactly while the owning route is ACTIVE.
   */
  setActiveRouteId(activeRouteId: string | null): void {
    this._activeRouteId = activeRouteId;
  }

  /**
   * Replace the sortOrder position. Used by `DeliveryRoute.reorderStops`
   * (DRAFT-only). Validation is the aggregate's responsibility
   * (uniqueness within the route's stop set).
   */
  setSortOrder(sortOrder: number): void {
    if (!Number.isInteger(sortOrder) || sortOrder < 0) {
      throw new Error(
        'DeliveryRouteStop sortOrder must be a non-negative integer',
      );
    }
    this._sortOrder = sortOrder;
    this._updatedAt = new Date();
  }

  /** Internal hook for the aggregate to bump the row's updatedAt on any
   *  stop-side mutation that does not otherwise set it. */
  touch(now: Date): void {
    this._updatedAt = now;
  }

  /**
   * Persistence projection. Mirrors the column shape on
   * `delivery_route_stops` so the Prisma adapter can `createMany` /
   * `update` without re-deriving fields.
   */
  toPersistence(): {
    id: string;
    tenantId: string;
    routeId: string;
    saleId: string;
    sortOrder: number;
    status: DeliveryRouteStopStatusValue;
    checkedInAt: Date | null;
    completedAt: Date | null;
    skippedReason: string | null;
    activeRouteId: string | null;
    createdAt: Date;
    updatedAt: Date;
  } {
    return {
      id: this.id,
      tenantId: this.tenantId,
      routeId: this.routeId,
      saleId: this.saleId,
      sortOrder: this._sortOrder,
      status: this._status,
      checkedInAt: this._checkedInAt,
      completedAt: this._completedAt,
      skippedReason: this._skippedReason,
      activeRouteId: this._activeRouteId,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }
}
