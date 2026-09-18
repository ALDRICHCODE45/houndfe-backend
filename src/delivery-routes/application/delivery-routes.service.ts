/**
 * APPLICATION SERVICE: DeliveryRoutesService — delivery-routes / WU2.
 *
 * Use-case orchestrator for the bounded context. Owns:
 *   - eligibility probes for the aggregate (sale → deliveryStatus +
 *     shippingAddressId snapshots)
 *   - the `runInTransaction` choreography around checkInStop (stop +
 *     Sale mirror + outbox emission when a next stop exists)
 *   - list-scope filtering on `request.ability.can('create',
 *     'DeliveryRoute')` (driver-only → self filter; route-manager →
 *     tenant-wide list; design ADR-5)
 *
 * Outbox emission inside checkInStop is intentionally a STUB for WU2:
 * the seam collects the `nextStop` payload the service would publish,
 * but the actual `OutboxWriterService.publish(...)` call is wired in
 * WU3 when the dedicated poller/dispatcher + Inngest function land.
 * See task 2.5 / 3.2 in the tasks file. The WU2 gate (task 2.20)
 * requires the transaction orchestration to be visible end-to-end
 * without depending on the outbox table writes.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  BusinessRuleViolationError,
  InvalidArgumentError,
} from '../../shared/domain/domain-error';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  DeliveryRoute,
  type SaleEligibilitySnapshot,
} from '../domain/delivery-route.entity';
import {
  DeliveryRouteInvalidTransitionError,
  DeliveryRouteNotFoundError,
} from '../domain/delivery-route.errors';
import {
  DELIVERY_ROUTE_REPOSITORY,
  type DeliveryRouteReadModel,
  type DeliveryRouteStateExpectation,
  type DeliveryRouteTransitionOutcome,
  type IDeliveryRouteRepository,
  type ListDeliveryRoutesInput,
} from '../domain/delivery-route.repository';
import {
  SALE_REPOSITORY,
  type ISaleRepository,
} from '../../sales/domain/sale.repository';
import { SaleNotDeliverableError } from '../../sales/domain/sale.errors';
import { OutboxWriterService } from '../../shared/outbox/outbox-writer.service';
import {
  DELIVERY_NEXT_STOP_NOTIFY_EVENT_TYPE,
  DELIVERY_ROUTE_OUTBOX_AGGREGATE_TYPE,
  computeDeliveryNextStopIdempotencyKey,
  type DeliveryNextStopNotifyPayload,
} from '../outbox/delivery-route-outbox.types';
import { buildDeliveryRouteTimeline } from '../domain/build-delivery-route-timeline';
import type { AppAbility } from '../../auth/authorization/domain/permission';
import type {
  IRouteOptimizer,
  OptimizeRouteInput,
  OptimizeRouteResult,
} from '../domain/ports/route-optimizer.port';
import { ROUTE_OPTIMIZER } from '../domain/ports/route-optimizer.port';
import type {
  CreateDeliveryRouteDto,
} from '../dto/create-delivery-route.dto';
import type { AddStopDto } from '../dto/add-stop.dto';
import type { ReorderStopsDto } from '../dto/reorder-stops.dto';
import type { UpdateDeliveryRouteDto } from '../dto/update-delivery-route.dto';
import type { ListDeliveryRoutesQueryDto } from '../dto/list-delivery-routes-query.dto';
import type { DeliveryRouteResponseDto } from '../dto/delivery-route-response.dto';

export type DeliveryRouteRequestContext = {
  userId: string;
  ability: AppAbility;
};

/**
 * Abort signal for ONE optimistic attempt of a route transition. It is
 * thrown inside the attempt's transaction so the persisted writes of that
 * attempt roll back before the driver re-reads fresh state; it never
 * escapes the driver and never reaches the HTTP layer.
 */
class StaleDeliveryRouteSnapshotError extends Error {
  constructor() {
    super('delivery route snapshot is stale');
    this.name = 'StaleDeliveryRouteSnapshotError';
  }
}

/**
 * Bounded optimistic retries for the check-in / cancel transitions. Each
 * attempt runs in its own transaction, so a lost race is re-evaluated from
 * freshly persisted state without leaking a partial write into the retry.
 * Exhausting the budget is surfaced as the existing
 * `DELIVERY_ROUTE_INVALID_TRANSITION` (422) contract rather than a silent
 * success or a new wire code.
 */
const MAX_ROUTE_TRANSITION_ATTEMPTS = 4;

/**
 * Capture the state identity of a loaded route BEFORE it is mutated. The
 * conditional commit compares exactly these fields at write time; exporting
 * the builder keeps the application and its specs building one shape.
 */
export function captureRouteTransitionExpectation(
  route: DeliveryRoute,
): DeliveryRouteStateExpectation {
  return {
    status: route.status,
    startedAt: route.startedAt,
    completedAt: route.completedAt,
    cancelledAt: route.cancelledAt,
    updatedAt: route.updatedAt,
    stops: route.stops.map((stop) => ({
      id: stop.id,
      status: stop.status,
      checkedInAt: stop.checkedInAt,
      completedAt: stop.completedAt,
      activeRouteId: stop.activeRouteId,
    })),
  };
}

@Injectable()
export class DeliveryRoutesService {
  constructor(
    @Inject(DELIVERY_ROUTE_REPOSITORY)
    private readonly repo: IDeliveryRouteRepository,
    @Inject(SALE_REPOSITORY)
    private readonly saleRepo: ISaleRepository,
    @Inject(ROUTE_OPTIMIZER)
    private readonly optimizer: IRouteOptimizer,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly cls: ClsService<TenantClsStore>,
    private readonly outboxWriter: OutboxWriterService,
  ) {}

  // ── Use cases ────────────────────────────────────────────────────────

  /**
   * `POST /delivery-routes` — create a new DRAFT route. Routes the
   * saleIds through the optimizer (identity for the manual adapter)
   * before delegating to the aggregate.
   */
  async create(
    ctx: DeliveryRouteRequestContext,
    dto: CreateDeliveryRouteDto,
  ): Promise<DeliveryRouteResponseDto> {
    const tenantId = this.requireTenantId();
    const ordered = await this.runOptimizer({
      tenantId,
      saleIds: dto.saleIds,
    });

    const route = await DeliveryRoute.create({
      id: randomUUID(),
      tenantId,
      driverUserId: dto.driverUserId,
      saleIds: ordered.orderedSaleIds,
      notes: dto.notes ?? null,
      checkSaleEligibility: (saleId) => this.checkSaleEligibility(saleId, tenantId),
    });

    const saved = await this.repo.save(route);
    return this.toResponseDto(
      await this.requireReadModel({ tenantId, id: saved.id }),
    );
  }

  /**
   * `POST /delivery-routes/:id/stops` — append a sale to a DRAFT route.
   */
  async addStop(
    ctx: DeliveryRouteRequestContext,
    routeId: string,
    dto: AddStopDto,
  ): Promise<DeliveryRouteResponseDto> {
    const tenantId = this.requireTenantId();
    const existing = await this.requireRoute({ tenantId, id: routeId });
    await existing.addStop({
      saleId: dto.saleId,
      checkSaleEligibility: (saleId) =>
        this.checkSaleEligibility(saleId, tenantId),
    });
    const saved = await this.repo.save(existing);
    return this.toResponseDto(
      await this.requireReadModel({ tenantId, id: saved.id }),
    );
  }

  /**
   * `PUT /delivery-routes/:id/stops/reorder` — replace the stop order
   * on a DRAFT route.
   */
  async reorderStops(
    ctx: DeliveryRouteRequestContext,
    routeId: string,
    dto: ReorderStopsDto,
  ): Promise<DeliveryRouteResponseDto> {
    const tenantId = this.requireTenantId();
    const existing = await this.requireRoute({ tenantId, id: routeId });
    existing.reorderStops({ orderedStopIds: dto.orderedStopIds });
    const saved = await this.repo.save(existing);
    return this.toResponseDto(
      await this.requireReadModel({ tenantId, id: saved.id }),
    );
  }

  /**
   * `PATCH /delivery-routes/:id` — DRAFT-only mutations: driver
   * reassignment + notes. Mid-route reassignment is intentionally
   * rejected by the aggregate (design ADR Q4).
   */
  async update(
    ctx: DeliveryRouteRequestContext,
    routeId: string,
    dto: UpdateDeliveryRouteDto,
  ): Promise<DeliveryRouteResponseDto> {
    const tenantId = this.requireTenantId();
    const existing = await this.requireRoute({ tenantId, id: routeId });
    if (dto.driverUserId !== undefined) {
      existing.assignDriver({ driverUserId: dto.driverUserId });
    }
    if (dto.notes !== undefined) {
      existing.updateNotes(dto.notes ?? null);
    }
    const saved = await this.repo.save(existing);
    return this.toResponseDto(
      await this.requireReadModel({ tenantId, id: saved.id }),
    );
  }

  /**
   * `POST /delivery-routes/:id/start` — DRAFT → ACTIVE. Sets the
   * ADR-7 active marker on every stop. The application pre-check (sale
   * already on another ACTIVE route) is delegated to the repository's
   * `save` P2002 mapping; the service keeps the orchestrator simple.
   */
  async start(
    ctx: DeliveryRouteRequestContext,
    routeId: string,
  ): Promise<DeliveryRouteResponseDto> {
    const tenantId = this.requireTenantId();
    const existing = await this.requireRoute({ tenantId, id: routeId });
    existing.start({});
    const saved = await this.repo.save(existing);
    return this.toResponseDto(
      await this.requireReadModel({ tenantId, id: saved.id }),
    );
  }

  /**
   * `POST /delivery-routes/:id/cancel` — DRAFT | ACTIVE → CANCELLED.
   * Clears the ADR-7 active marker on every stop when transitioning out of
   * ACTIVE. Committed through the tenant-qualified conditional seam (ODD
   * O1) inside a transaction, so a cancellation built from a stale snapshot
   * cannot revert a stop a concurrent check-in just completed: the stale
   * attempt is detected and re-evaluated against freshly persisted state.
   */
  async cancel(
    ctx: DeliveryRouteRequestContext,
    routeId: string,
  ): Promise<DeliveryRouteResponseDto> {
    const tenantId = this.requireTenantId();
    await this.runTransitionWithStaleRetry(
      tenantId,
      routeId,
      async (tx, before) => {
        const expected = captureRouteTransitionExpectation(before);
        before.cancel({});
        const outcome = await this.repo.commitTransition({
          tx,
          tenantId,
          routeId,
          expected,
          next: before,
        });
        this.assertTransitionCommitted(outcome, routeId);
      },
    );
    return this.toResponseDto(
      await this.requireReadModel({ tenantId, id: routeId }),
    );
  }

  /**
   * `POST /delivery-routes/:id/stops/:stopId/check-in` — atomic check-in.
   *
   * The transition is committed through the tenant-qualified CONDITIONAL
   * seam (ODD O1) instead of an unconditional aggregate replacement, inside
   * the existing transaction choreography. Per attempt, inside ONE
   * transaction:
   *   1. Load the route (tenant-scoped, inside the tx). Miss → 404.
   *   2. Aggregate `checkInStop(stopId)` flips the stop to COMPLETED, sets
   *      `activeRouteId` per ADR-7 and reports the next pending stop. A
   *      route that is not ACTIVE (e.g. a cancellation that already won)
   *      throws `DeliveryRouteInvalidTransitionError` (422) here — before
   *      any sale, route, stop or outbox write.
   *   3. `commitTransition` compare-and-sets the row against the snapshot
   *      loaded in (1) BEFORE the sale mirror write, so a route state that
   *      changed under this request (a cancellation that won, say) is
   *      detected and re-evaluated without a sale, stop or outbox write
   *      having been issued for the losing snapshot. A miss means another
   *      writer committed first: this attempt rolls back and the driver
   *      re-evaluates from freshly persisted state (bounded retries).
   *      Route auto-completion is re-derived by the seam from the
   *      PERSISTED stop set, so two concurrent final pending stops cannot
   *      leave an ACTIVE route with no pending stops.
   *   4. The Sale mirror flip is delegated to `saleRepo.markSaleDelivered`
   *      inside the SAME transaction so the stop + sale writes commit
   *      atomically. That write is CONDITIONAL on the persisted sale
   *      lifecycle (`{ id, tenantId, status: 'CONFIRMED', deliveryStatus:
   *      IN (PENDING|SHIPPED|DELIVERED) }`), so a cancellation that
   *      committed first cannot be overwritten. The typed outcome maps to
   *      the wire contract without disclosing tenant existence:
   *      `not_deliverable` → `SaleNotDeliverableError` (422); `missing`
   *      → `DeliveryRouteNotFoundError` (404). Both abort the whole
   *      transaction — including the route/stop write of step 3 — before
   *      the outbox publish.
   *   5. When a `nextStop` exists, the service emits EXACTLY ONE
   *      `delivery.next_stop.notify` outbox row inside the same
   *      transaction via `OutboxWriterService.publish(tx, …)`. The row
   *      carries the next-sale snapshot (name, address label, write-
   *      time email). The Inngest function re-resolves the
   *      authoritative email at send-time so a tenant edit between
   *      check-in and dispatch does not lose the recipient.
   *
   * Idempotency: the aggregate's `checkInStop` is a no-op on an
   * already-COMPLETED stop, and the row is only published by the request
   * that observed PENDING on its winning attempt — so a duplicate
   * concurrent check-in reclassifies as a successful replay and produces
   * no second outbox row.
   */
  async checkInStop(
    _ctx: DeliveryRouteRequestContext,
    routeId: string,
    stopId: string,
  ): Promise<DeliveryRouteResponseDto> {
    const tenantId = this.requireTenantId();
    await this.runTransitionWithStaleRetry(
      tenantId,
      routeId,
      async (tx, before) => {
        // Capture the snapshot identity BEFORE mutating the aggregate —
        // the conditional commit compares exactly this expected state.
        const expected = captureRouteTransitionExpectation(before);
        // The pre-call stop status drives the duplicate-replay decision:
        // only the request that found the stop PENDING may publish a
        // next-stop row (a replayed COMPLETED stop must not).
        const wasPending =
          before.stops.find((stop) => stop.id === stopId)?.status ===
          'PENDING';
        const checkIn = before.checkInStop({ stopId });

        // Conditional, tenant-qualified commit of the transition. On a
        // stale snapshot this attempt rolls back and the driver
        // re-evaluates from freshly persisted state; a cancellation that
        // already won is detected HERE (either the aggregate throws 422 on
        // the re-read, or the compare-and-set misses) so it can never be
        // followed by a sale, stop or outbox write.
        const outcome = await this.repo.commitTransition({
          tx,
          tenantId,
          routeId,
          expected,
          next: before,
        });
        this.assertTransitionCommitted(outcome, routeId);

        // Sale mirror flip — conditional, tenant-qualified, same tx. The
        // typed outcome distinguishes a lifecycle loss (existing but not
        // deliverable) from a missing/foreign sale; neither path commits
        // the route write above or the outbox row below (the enclosing
        // transaction rolls all of them back together).
        const delivered = await this.saleRepo.markSaleDelivered(tx, {
          tenantId,
          saleId: checkIn.completedStop.saleId,
        });

        if (delivered.kind === 'missing') {
          throw new DeliveryRouteNotFoundError(routeId);
        }
        if (delivered.kind === 'not_deliverable') {
          // Cancellation (or any other non-deliverable lifecycle state) won
          // the race: 422 with the existing contract, stop not completed.
          throw new SaleNotDeliverableError();
        }

        // Emit the next-stop outbox row ONLY when:
        //   (a) a next stop exists (route is still ACTIVE), AND
        //   (b) this attempt observed the stop as PENDING (idempotency —
        //       a duplicate/replayed check-in writes no second row).
        // The aggregate's `checkInStop` returns `nextStop: null` when the
        // route just auto-completed, satisfying (a).
        if (checkIn.nextStop && wasPending) {
          const payload = await this.composeNextStopPayload(
            tx,
            tenantId,
            before,
            checkIn.completedStop.id,
            checkIn.nextStop.id,
            checkIn.nextStop.saleId,
          );
          await this.outboxWriter.publish(
            tx,
            tenantId,
            DELIVERY_ROUTE_OUTBOX_AGGREGATE_TYPE,
            before.id,
            DELIVERY_NEXT_STOP_NOTIFY_EVENT_TYPE,
            // SAFETY: `composeNextStopPayload` returns a plain object built
            // exclusively from `string | null` fields (see
            // `DeliveryNextStopNotifyPayload`), which is JSON-serializable at
            // runtime; Prisma's `InputJsonValue` type cannot express that
            // structurally, so this assertion only narrows the static type.
            payload as unknown as Prisma.InputJsonValue,
          );
        }
      },
    );

    return this.toResponseDto(
      await this.requireReadModel({ tenantId, id: routeId }),
    );
  }

  /**
   * `GET /delivery-routes` — list, filtered to the caller's driver
   * when the ability lacks `create:DeliveryRoute` (driver-only).
   */
  async list(
    ctx: DeliveryRouteRequestContext,
    query: ListDeliveryRoutesQueryDto,
  ): Promise<DeliveryRouteResponseDto[]> {
    const tenantId = this.requireTenantId();
    const isRouteManager = ctx.ability.can('create', 'DeliveryRoute');
    const driverUserId = isRouteManager
      ? undefined
      : ctx.userId;
    const status = query.status
      ? [query.status]
      : undefined;
    const input: ListDeliveryRoutesInput = {
      tenantId,
      driverUserId,
      status,
    };
    const rows = await this.repo.list(input);
    return rows.map((row) => this.toResponseDto(row));
  }

  /**
   * `GET /delivery-routes/:id` — read model + timeline. Cross-tenant
   * miss → 404 (`DeliveryRouteNotFoundError`).
   */
  async getById(
    _ctx: DeliveryRouteRequestContext,
    routeId: string,
  ): Promise<DeliveryRouteResponseDto> {
    const tenantId = this.requireTenantId();
    const row = await this.repo.findOneWithStops({ tenantId, id: routeId });
    if (!row) {
      throw new DeliveryRouteNotFoundError(routeId);
    }
    return this.toResponseDto(row);
  }

  /**
   * `DELETE /delivery-routes/:id` — DRAFT + zero stops only. Enforced
   * by the aggregate's `canDelete()` + the repository adapter's
   * precondition re-check.
   */
  async delete(
    _ctx: DeliveryRouteRequestContext,
    routeId: string,
  ): Promise<void> {
    const tenantId = this.requireTenantId();
    const existing = await this.requireRoute({ tenantId, id: routeId });
    if (!existing.canDelete()) {
      throw new BusinessRuleViolationError(
        'DeliveryRoute can only be deleted when DRAFT with no stops',
        'DELIVERY_ROUTE_INVALID_TRANSITION',
      );
    }
    await this.repo.delete({ tenantId, id: routeId });
  }

  // ── Private helpers ──────────────────────────────────────────────────

  /**
   * Build an `SaleEligibilitySnapshot` from the tenant-scoped Sale
   * projection. Returns null when the sale does not exist in the
   * tenant (the aggregate maps null → 422 via
   * `DeliveryRouteSaleNotEligibleError`).
   */
  private async checkSaleEligibility(
    saleId: string,
    tenantId: string,
  ): Promise<SaleEligibilitySnapshot | null> {
    const prisma = this.tenantPrisma.getClient();
    const row = await prisma.sale.findFirst({
      where: { id: saleId, tenantId },
      select: { deliveryStatus: true, shippingAddressId: true },
    });
    if (!row) return null;
    return {
      deliveryStatus: row.deliveryStatus as SaleEligibilitySnapshot['deliveryStatus'],
      shippingAddressId: row.shippingAddressId,
    };
  }

  /** Re-load the aggregate by id (throws 404 on miss). */
  private async requireRoute(input: {
    tenantId: string;
    id: string;
  }): Promise<DeliveryRoute> {
    const route = await this.repo.findById(input);
    if (!route) {
      throw new DeliveryRouteNotFoundError(input.id);
    }
    return route;
  }

  /** Same as requireRoute but uses the supplied transaction client. */
  private async findByIdInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
  ): Promise<DeliveryRoute | null> {
    // Use the ambient transaction client through `tenantPrisma` so the
    // tenantId allowlist injection keeps working — the CLS-stored tx
    // pointer is honored by `getClient()` (see
    // `TenantPrismaService.getClient()`).
    void tx;
    return this.repo.findById({ tenantId, id });
  }

  /**
   * Run a route transition with bounded optimistic retries, one
   * transaction per attempt (ODD O1).
   *
   * Each attempt loads fresh state, evaluates the transition and commits it
   * through the conditional seam. A predicate miss aborts the attempt's
   * transaction through `StaleDeliveryRouteSnapshotError` — so no write of
   * the losing attempt survives — and the driver re-evaluates from the
   * winner's committed state. The budget is bounded; exhausting it surfaces
   * the existing `DELIVERY_ROUTE_INVALID_TRANSITION` (422) contract instead
   * of reporting a false success.
   */
  private async runTransitionWithStaleRetry(
    tenantId: string,
    routeId: string,
    attempt: (
      tx: Prisma.TransactionClient,
      before: DeliveryRoute,
    ) => Promise<void>,
  ): Promise<void> {
    for (let index = 0; index < MAX_ROUTE_TRANSITION_ATTEMPTS; index++) {
      try {
        await this.repo.runInTransaction(async (tx) => {
          const before = await this.findByIdInTx(tx, tenantId, routeId);
          if (!before) {
            throw new DeliveryRouteNotFoundError(routeId);
          }
          await attempt(tx, before);
        });
        return;
      } catch (error) {
        if (error instanceof StaleDeliveryRouteSnapshotError) continue;
        throw error;
      }
    }
    throw new DeliveryRouteInvalidTransitionError(
      'DeliveryRoute was updated concurrently; the transition could not be applied',
      { reason: 'CONCURRENT_UPDATE_CONFLICT', routeId },
    );
  }

  /** Map the conditional-commit outcome onto the existing wire contract:
   *  `missing` → 404, `stale` → abort this attempt for re-evaluation. */
  private assertTransitionCommitted(
    outcome: DeliveryRouteTransitionOutcome,
    routeId: string,
  ): void {
    if (outcome.kind === 'missing') {
      throw new DeliveryRouteNotFoundError(routeId);
    }
    if (outcome.kind === 'stale') {
      throw new StaleDeliveryRouteSnapshotError();
    }
  }

  /** Re-load the read model by id (throws 404 on miss). */
  private async requireReadModel(input: {
    tenantId: string;
    id: string;
  }): Promise<DeliveryRouteReadModel> {
    const row = await this.repo.findOneWithStops(input);
    if (!row) {
      throw new DeliveryRouteNotFoundError(input.id);
    }
    return row;
  }

  /** Type-safe wrapper around the optimizer — keeps the seam visible. */
  private async runOptimizer(
    input: OptimizeRouteInput,
  ): Promise<OptimizeRouteResult> {
    return this.optimizer.optimize(input);
  }

  /** Resolve the caller's tenant — the controller layer is gated by the
   *  `TenantContextGuard` so the value is always present here. */
  private requireTenantId(): string {
    const { tenantId, isSuperAdmin } = this.cls.get();
    if (!tenantId && !isSuperAdmin) {
      throw new InvalidArgumentError(
        'Tenant context required',
        'TENANT_CONTEXT_REQUIRED',
      );
    }
    if (!tenantId) {
      throw new InvalidArgumentError(
        'DeliveryRoute operations require an explicit tenant',
        'TENANT_CONTEXT_REQUIRED',
      );
    }
    return tenantId;
  }

  /** Map a read model into the wire DTO. ISO-string the dates; attach the
   *  timeline from `buildDeliveryRouteTimeline` (WU3). */
  private toResponseDto(row: DeliveryRouteReadModel): DeliveryRouteResponseDto {
    return {
      id: row.id,
      status: row.status,
      driver: row.driver,
      startedAt: row.startedAt ? row.startedAt.toISOString() : null,
      completedAt: row.completedAt ? row.completedAt.toISOString() : null,
      cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
      notes: row.notes,
      stops: row.stops.map((stop) => ({
        id: stop.id,
        saleId: stop.saleId,
        saleFolio: stop.saleFolio,
        sortOrder: stop.sortOrder,
        status: stop.status,
        checkedInAt: stop.checkedInAt
          ? stop.checkedInAt.toISOString()
          : null,
        completedAt: stop.completedAt
          ? stop.completedAt.toISOString()
          : null,
        customer: stop.customer,
        shippingAddress: stop.shippingAddress,
      })),
      timeline: buildDeliveryRouteTimeline({
        createdAt: row.createdAt,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
        cancelledAt: row.cancelledAt,
        driver: row.driver ? { id: row.driver.id, name: row.driver.name } : null,
        stops: row.stops.map((stop) => ({
          id: stop.id,
          sortOrder: stop.sortOrder,
          checkedInAt: stop.checkedInAt,
        })),
      }),
    };
  }

  /**
   * Compose the next-stop outbox payload from the supplied tx client.
   *
   * Reads the next sale's `folio`, `customer.firstName`/`lastName`/
   * `email`, and `shippingAddress` so the Inngest function can render
   * the email body without re-querying. The email is a write-time
   * SNAPSHOT — the Inngest function re-resolves the authoritative
   * email at send-time via `ISaleCustomerEmailLookup`. The customer
   * name and address are pre-formatted (whitespace-cleaned) so the
   * template renders identically regardless of the DB state.
   *
   * Tenant scoping is enforced at the `where` clause; a vanished /
   * cross-tenant sale returns `null` projections and the payload
   * gracefully degrades (name/email/label all null → template still
   * renders with a generic greeting).
   *
   * The nested `customer` / `shippingAddress` relations cannot carry a
   * tenant predicate of their own (single-column relations, and the CLS
   * extension only rewrites top-level models), so both children are
   * re-checked against `tenantId` after the read. A foreign-tenant child
   * is treated exactly like a missing one — and each child is filtered
   * independently, so one foreign relation never suppresses a valid
   * sibling.
   */
  private async composeNextStopPayload(
    tx: Prisma.TransactionClient,
    tenantId: string,
    route: DeliveryRoute,
    currentStopId: string,
    nextStopId: string,
    nextSaleId: string,
  ): Promise<DeliveryNextStopNotifyPayload> {
    // SAFETY: `Prisma.TransactionClient` and the tenant-scoped client expose
    // the same model delegates; the transaction client only omits the
    // client-level lifecycle methods this read never calls. The assertion
    // makes that shared delegate surface statically visible.
    const prisma = tx as unknown as ReturnType<TenantPrismaService['getClient']>;
    const sale = await prisma.sale.findFirst({
      where: { id: nextSaleId, tenantId },
      select: {
        folio: true,
        customer: {
          select: {
            tenantId: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        shippingAddress: {
          select: {
            tenantId: true,
            label: true,
            street: true,
            exteriorNumber: true,
            interiorNumber: true,
            zipCode: true,
            neighborhood: true,
            municipality: true,
            city: true,
            state: true,
          },
        },
      },
    });

    // Post-read tenant filter: Prisma cannot attach the tenant predicate to
    // these to-one selections, so a foreign-tenant child must be dropped
    // here instead of being snapshotted into the outbox payload.
    const projectedCustomer = sale?.customer ?? null;
    const customer =
      projectedCustomer && projectedCustomer.tenantId === tenantId
        ? projectedCustomer
        : null;
    const projectedAddress = sale?.shippingAddress ?? null;
    const address =
      projectedAddress && projectedAddress.tenantId === tenantId
        ? projectedAddress
        : null;
    const fullName = customer
      ? `${customer.firstName ?? ''}${
          customer.lastName ? ' ' + customer.lastName : ''
        }`.trim() || null
      : null;
    const email =
      customer?.email && customer.email.trim().length > 0
        ? customer.email.trim()
        : null;
    const addressLabel = address ? formatShippingAddress(address) : null;
    const occurredAt = new Date().toISOString();

    void route;
    void nextStopId;

    return {
      tenantId,
      routeId: route.id,
      currentStopId,
      nextStopId,
      nextSaleId,
      nextCustomerName: fullName,
      nextAddressLabel: addressLabel,
      nextCustomerEmail: email,
      idempotencyKey: computeDeliveryNextStopIdempotencyKey({
        tenantId,
        currentStopId,
      }),
      occurredAt,
    };
  }
}

/**
 * Format a `CustomerAddress` row into a multi-line label suitable for
 * the email body. Returns `null` when every line would be empty
 * (defensive — the template's `nextAddressLabel` block is conditionally
 * rendered, so an all-empty label degrades gracefully).
 */
function formatShippingAddress(addr: {
  label: string | null;
  street: string | null;
  exteriorNumber: string | null;
  interiorNumber: string | null;
  neighborhood: string | null;
  zipCode: string | null;
  municipality: string | null;
  city: string | null;
  state: string | null;
}): string | null {
  const lines: string[] = [];
  if (addr.label && addr.label.trim().length > 0) {
    lines.push(addr.label.trim());
  }
  const streetLine = [
    addr.street,
    addr.exteriorNumber,
    addr.interiorNumber ? `Int. ${addr.interiorNumber}` : null,
  ]
    .filter((part): part is string => Boolean(part && part.trim().length > 0))
    .join(' ')
    .trim();
  if (streetLine.length > 0) lines.push(streetLine);
  const localityLine = [
    addr.neighborhood,
    addr.municipality,
    addr.city,
    addr.state,
  ]
    .filter((part): part is string => Boolean(part && part.trim().length > 0))
    .join(', ')
    .trim();
  if (localityLine.length > 0) lines.push(localityLine);
  if (addr.zipCode && addr.zipCode.trim().length > 0) {
    lines.push(`CP ${addr.zipCode.trim()}`);
  }
  return lines.length > 0 ? lines.join('\n') : null;
}
