/**
 * ADAPTER: PrismaDeliveryRouteRepository — delivery-routes / WU2.
 *
 * Concrete implementation of `IDeliveryRouteRepository` using Prisma.
 * Tenant scoping is delegated to `TenantPrismaService` (CLS-driven
 * WHERE-injection; see `src/shared/prisma/tenant-prisma.factory.ts`).
 * `DeliveryRoute` and `DeliveryRouteStop` are both in
 * `TENANT_SCOPED_MODELS` so every read/write gets auto-filtered by
 * `tenantId` at the top-level `where`/`data`.
 *
 * P2002 → 409 mapping: the partial unique index
 * `delivery_route_stops_active_sale_uniq` on
 * `(tenant_id, sale_id) WHERE activeRouteId IS NOT NULL` raises
 * `P2002` when a route claims a sale already reserved by another
 * DRAFT/ACTIVE route (S2 — the marker is armed at DRAFT assignment and
 * survives DRAFT→ACTIVE). The adapter maps that violation to
 * `DeliveryRouteSaleAlreadyInActiveRouteError` (HTTP 409 via the
 * global filter's `BusinessRuleViolationError` branch — see design §9
 * error table) and carries the structured `conflictSaleIds` the wire
 * contract exposes; a P2002 from a DIFFERENT unique index (e.g. the
 * `(routeId, sortOrder)` stop index) is rethrown instead of being
 * mislabelled as a sale reservation conflict.
 *
 * The outbox-claim trio (`claimNextOutboxEvent` / `markOutboxEventSent` /
 * `markOutboxEventFailed`) is stubbed with `null` / no-ops for WU2;
 * WU3's dedicated poller/dispatcher overrides the behavior with real
 * SQL. Keeping the signatures in the WU2 port + adapter means WU3 can
 * swap implementations without churning the service contract.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';
import { DeliveryRoute } from '../domain/delivery-route.entity';
import { DeliveryRouteSaleAlreadyInActiveRouteError } from '../domain/delivery-route.errors';
import type {
  DeliveryRouteReadModel,
  DeliveryRouteStateExpectation,
  DeliveryRouteTransitionOutcome,
  IDeliveryRouteRepository,
  ListDeliveryRoutesInput,
} from '../domain/delivery-route.repository';

/** Stop statuses that still need a driver action — used by the
 *  persisted-state route-completion reconciliation. */
const OPEN_STOP_STATUSES = ['PENDING', 'IN_PROGRESS'] as const;

/**
 * Did the transition change this stop's comparable state? Compares only
 * the fields `commitTransition` predicates on (status, timestamps, ADR-7
 * marker) so a no-op replay issues no write at all.
 */
function stopTransitionChanged(
  prior: DeliveryRouteStateExpectation['stops'][number],
  next: {
    status: DeliveryRouteStateExpectation['stops'][number]['status'];
    checkedInAt: Date | null;
    completedAt: Date | null;
    activeRouteId: string | null;
  },
): boolean {
  return (
    prior.status !== next.status ||
    !sameInstant(prior.checkedInAt, next.checkedInAt) ||
    !sameInstant(prior.completedAt, next.completedAt) ||
    prior.activeRouteId !== next.activeRouteId
  );
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  return a === b || (a !== null && b !== null && a.getTime() === b.getTime());
}

/**
 * Is this error the sale-reservation P2002 raised by the ADR-7 partial
 * unique index `delivery_route_stops_active_sale_uniq`? Every other P2002
 * (notably the `delivery_route_stops_routeId_sortOrder_key` index) is NOT
 * a sale conflict and must be rethrown so the wire never reports a
 * misleading `DELIVERY_ROUTE_STOP_SALE_ALREADY_ON_ACTIVE_ROUTE`.
 *
 * Prisma reports the offending fields in `meta.target`. The reservation
 * index is `(tenantId, saleId)` while the stop-order index is
 * `(routeId, sortOrder)`, so `saleId` is the discriminator. An unknown /
 * absent target preserves the historical 409 mapping (defensive: the
 * reservation index is by far the likeliest P2002 on this table).
 */
export function isSaleReservationP2002(error: unknown): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== 'P2002'
  ) {
    return false;
  }
  const target = error.meta?.target;
  const fields =
    typeof target === 'string'
      ? [target]
      : Array.isArray(target)
        ? target.map((entry) => String(entry))
        : null;
  if (fields === null) {
    // Unknown target shape — keep the historical 409 contract.
    return true;
  }
  return fields.some((field) => {
    const normalized = field.toLowerCase();
    return (
      normalized === 'saleid' ||
      normalized === 'sale_id' ||
      normalized.includes('active_sale_uniq')
    );
  });
}

/**
 * ODD O1 — the single nested sale projection shared by the two route read
 * models. `tenantId` is selected on the sale AND on both of its to-one
 * children because Prisma cannot express a tenant `where` on a to-one
 * relation (and the CLS tenant extension never recurses into a nested
 * `select`), so the tenant check has to happen during mapping.
 */
const STOP_SALE_SELECT = {
  id: true,
  tenantId: true,
  folio: true,
  customer: {
    select: {
      id: true,
      tenantId: true,
      firstName: true,
      lastName: true,
      email: true,
    },
  },
  shippingAddress: {
    select: {
      id: true,
      tenantId: true,
      street: true,
      exteriorNumber: true,
      interiorNumber: true,
      zipCode: true,
      neighborhood: true,
      municipality: true,
      city: true,
      state: true,
      label: true,
      latitude: true,
      longitude: true,
    },
  },
} satisfies Prisma.SaleSelect;

type StopSaleProjection = Prisma.SaleGetPayload<{
  select: typeof STOP_SALE_SELECT;
}>;

/** The stop fields the shared read mapper consumes. */
type RouteReadStopProjection = {
  id: string;
  saleId: string;
  sortOrder: number;
  status: DeliveryRouteReadModel['stops'][number]['status'];
  checkedInAt: Date | null;
  completedAt: Date | null;
  sale: StopSaleProjection | null;
};

/**
 * Project one tenant-owned stop into the route read model (ODD O1).
 *
 * Tenant defense in depth: the stop itself is already tenant-filtered by
 * the explicit nested `stops.where`, but its to-one chain is not — Prisma
 * to-one relations support no relation `where`, and the CLS extension only
 * rewrites top-level predicates. A row owned by another tenant is
 * therefore treated as absent: the stop keeps its own `saleId` (a column
 * of the tenant's own stop row) while every nested field resolves to
 * `null`. The sale's customer and address are checked INDEPENDENTLY, so a
 * foreign child never suppresses an otherwise valid sibling.
 */
function mapRouteStopReadModel(
  stop: RouteReadStopProjection,
  routeTenantId: string,
): DeliveryRouteReadModel['stops'][number] {
  const sale =
    stop.sale !== null && stop.sale.tenantId === routeTenantId
      ? stop.sale
      : null;
  const customer =
    sale !== null &&
    sale.customer !== null &&
    sale.customer.tenantId === routeTenantId
      ? sale.customer
      : null;
  const shippingAddress =
    sale !== null &&
    sale.shippingAddress !== null &&
    sale.shippingAddress.tenantId === routeTenantId
      ? sale.shippingAddress
      : null;

  return {
    id: stop.id,
    saleId: stop.saleId,
    saleFolio: sale?.folio ?? null,
    sortOrder: stop.sortOrder,
    status: stop.status,
    checkedInAt: stop.checkedInAt,
    completedAt: stop.completedAt,
    customer: customer
      ? {
          id: customer.id,
          name: `${customer.firstName}${customer.lastName ? ' ' + customer.lastName : ''}`,
          email: customer.email ?? null,
        }
      : null,
    shippingAddress: shippingAddress
      ? {
          id: shippingAddress.id,
          street: shippingAddress.street,
          exteriorNumber: shippingAddress.exteriorNumber,
          interiorNumber: shippingAddress.interiorNumber,
          zipCode: shippingAddress.zipCode,
          neighborhood: shippingAddress.neighborhood,
          municipality: shippingAddress.municipality,
          city: shippingAddress.city,
          state: shippingAddress.state,
          label: shippingAddress.label,
          latitude: shippingAddress.latitude,
          longitude: shippingAddress.longitude,
        }
      : null,
  };
}

@Injectable()
export class PrismaDeliveryRouteRepository implements IDeliveryRouteRepository {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private getClient(): ReturnType<TenantPrismaService['getClient']> {
    return this.tenantPrisma.getClient();
  }

  async save(route: DeliveryRoute): Promise<DeliveryRoute> {
    // Parent state and stop replacement must commit or roll back together.
    // Reuse an ambient transaction when the caller already owns one.
    return this.tenantPrisma.runInTransaction(() =>
      this.saveInTransaction(route),
    );
  }

  private async saveInTransaction(
    route: DeliveryRoute,
  ): Promise<DeliveryRoute> {
    const prisma = this.getClient();
    const data = route.toPersistence();

    try {
      // Parent row first — upsert preserves the same id on subsequent
      // saves (create on first call, update thereafter). `updatedAt` is
      // bumped on every mutation per the design contract.
      await prisma.deliveryRoute.upsert({
        where: { id: route.id },
        create: {
          id: data.id,
          tenantId: data.tenantId,
          driverUserId: data.driverUserId,
          status: data.status,
          startedAt: data.startedAt,
          completedAt: data.completedAt,
          cancelledAt: data.cancelledAt,
          notes: data.notes,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
        },
        update: {
          driverUserId: data.driverUserId,
          status: data.status,
          startedAt: data.startedAt,
          completedAt: data.completedAt,
          cancelledAt: data.cancelledAt,
          notes: data.notes,
          updatedAt: data.updatedAt,
        },
      });

      // Child stops: delete-then-recreate so the aggregate is the
      // single source of truth. Deleting first also releases this route's
      // own reservations, so the S2 conflict pre-check below observes only
      // OTHER routes' reservations.
      await prisma.deliveryRouteStop.deleteMany({
        where: { routeId: route.id },
      });

      // S2 conflict pre-check — surface the structured `conflictSaleIds`
      // the wire contract exposes (per-sale inline conflicts). The partial
      // unique index below is still the race-safe authoritative guard.
      const saleIds = data.stops.map((stop) => stop.saleId);
      if (saleIds.length > 0) {
        const conflicting = await prisma.deliveryRouteStop.findMany({
          where: {
            tenantId: data.tenantId,
            saleId: { in: saleIds },
            activeRouteId: { not: null },
          },
          select: { saleId: true },
        });
        const conflictSaleIds = [
          ...new Set(conflicting.map((row) => row.saleId)),
        ];
        if (conflictSaleIds.length > 0) {
          throw new DeliveryRouteSaleAlreadyInActiveRouteError(
            'One or more sales are already reserved by another draft or active route',
            {
              reason: 'SALE_ALREADY_RESERVED',
              routeId: route.id,
              conflictSaleIds,
            },
          );
        }
      }

      if (data.stops.length > 0) {
        await prisma.deliveryRouteStop.createMany({
          data: data.stops.map((stop) => ({
            id: stop.id,
            tenantId: stop.tenantId,
            routeId: stop.routeId,
            saleId: stop.saleId,
            sortOrder: stop.sortOrder,
            status: stop.status,
            checkedInAt: stop.checkedInAt,
            completedAt: stop.completedAt,
            skippedReason: stop.skippedReason,
            activeRouteId: stop.activeRouteId,
            createdAt: stop.createdAt,
            updatedAt: stop.updatedAt,
          })),
        });
      }
    } catch (error) {
      if (isSaleReservationP2002(error)) {
        // ADR-7 — the partial unique index
        // `delivery_route_stops_active_sale_uniq` raised. Translate to
        // the canonical 409 domain error so the global filter maps it
        // to HTTP 409 (design §9). A concurrent winner beat the pre-check
        // to the sale, so the conflicting ids are not resolvable from the
        // already-aborted transaction; the field stays a stable array.
        throw new DeliveryRouteSaleAlreadyInActiveRouteError(
          'One or more sales already belong to another draft or active route',
          {
            reason: 'PARTIAL_UNIQUE_INDEX_VIOLATION',
            routeId: route.id,
            conflictSaleIds: [],
          },
        );
      }
      throw error;
    }

    return (await this.findById({ tenantId: data.tenantId, id: route.id }))!;
  }

  /**
   * S2/S3 concurrency seam. See the port docs: this is the row-level lock
   * that every read-modify-write path takes before loading the aggregate,
   * so two writers can never commit full-replacement `save`s derived from
   * the same stale snapshot (a transaction alone does not prevent that).
   *
   * Locks are taken in ascending id order so a two-route transfer and a
   * single-route mutation can never deadlock. The raw statement bypasses
   * the CLS tenant extension, so `tenantId` is passed explicitly; the
   * explicit tenant predicate also keeps a foreign-tenant id from being
   * locked (it is reported as missing).
   */
  async lockRoutesForUpdate(input: {
    tx: Prisma.TransactionClient;
    tenantId: string;
    routeIds: string[];
  }): Promise<string[]> {
    const orderedIds = [...new Set(input.routeIds)].sort((a, b) =>
      a.localeCompare(b),
    );
    if (orderedIds.length === 0) return [];
    const rows = await input.tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT "id" FROM "delivery_routes" WHERE "tenantId" = ${input.tenantId} AND "id" IN (${Prisma.join(
        orderedIds,
      )}) ORDER BY "id" FOR UPDATE`,
    );
    const locked = new Set(rows.map((row) => row.id));
    return orderedIds.filter((id) => !locked.has(id));
  }

  async findById(input: {
    tenantId: string;
    id: string;
  }): Promise<DeliveryRoute | null> {
    const prisma = this.getClient();
    return this.loadRoute(prisma, input.tenantId, input.id);
  }

  /**
   * ODD O1 — tenant-qualified conditional aggregate commit used by the
   * check-in / cancel paths. See the port method docs for the contract;
   * the three steps below are the compare-and-set parent write, the
   * compare-and-set per-stop writes (never delete-then-recreate), and the
   * persisted-state route-completion reconciliation.
   */
  async commitTransition(input: {
    tx: Prisma.TransactionClient;
    tenantId: string;
    routeId: string;
    expected: DeliveryRouteStateExpectation;
    next: DeliveryRoute;
  }): Promise<DeliveryRouteTransitionOutcome> {
    // SAFETY: `Prisma.TransactionClient` and the tenant-scoped client expose
    // the same model delegates; the transaction client only omits the
    // client-level lifecycle methods this write never calls. The assertion
    // makes that shared delegate surface statically visible.
    const prisma = input.tx as unknown as ReturnType<
      TenantPrismaService['getClient']
    >;
    const { tenantId, routeId, expected } = input;
    const nextRow = input.next.toPersistence();

    // 1. Parent-row compare-and-set. Every route-level writer mutates this
    //    row (check-in, cancel and the CRUD `save`), so a miss means
    //    another writer committed after the caller loaded its snapshot.
    const parent = await prisma.deliveryRoute.updateMany({
      where: {
        id: routeId,
        tenantId,
        status: expected.status,
        startedAt: expected.startedAt,
        completedAt: expected.completedAt,
        cancelledAt: expected.cancelledAt,
        updatedAt: expected.updatedAt,
      },
      data: {
        driverUserId: nextRow.driverUserId,
        status: nextRow.status,
        startedAt: nextRow.startedAt,
        completedAt: nextRow.completedAt,
        cancelledAt: nextRow.cancelledAt,
        notes: nextRow.notes,
        updatedAt: nextRow.updatedAt,
      },
    });
    if (parent.count === 0) {
      return this.classifyStaleTransition(prisma, tenantId, routeId);
    }

    // 2. Per-stop compare-and-set for the stops this transition changed.
    //    Stops are written in place, so a stop another writer completed is
    //    neither overwritten nor reverted by this aggregate's snapshot.
    const expectedStops = new Map(
      expected.stops.map((stop) => [stop.id, stop]),
    );
    for (const stop of input.next.stops) {
      const prior = expectedStops.get(stop.id);
      if (!prior) {
        // Stops are only ever appended through the DRAFT-only CRUD path
        // (`save`), never by a check-in / cancel transition.
        continue;
      }
      const data = stop.toPersistence();
      if (!stopTransitionChanged(prior, data)) continue;
      const written = await prisma.deliveryRouteStop.updateMany({
        where: {
          id: data.id,
          tenantId,
          routeId,
          status: prior.status,
          checkedInAt: prior.checkedInAt,
          completedAt: prior.completedAt,
          activeRouteId: prior.activeRouteId,
        },
        data: {
          status: data.status,
          checkedInAt: data.checkedInAt,
          completedAt: data.completedAt,
          activeRouteId: data.activeRouteId,
          updatedAt: data.updatedAt,
        },
      });
      if (written.count === 0) {
        return this.classifyStaleTransition(prisma, tenantId, routeId);
      }
    }

    // 3. Route completion is decided from the PERSISTED stop set, so two
    //    concurrent final pending stops cannot leave an ACTIVE route with
    //    no pending stops.
    await this.reconcileRouteCompletion(prisma, tenantId, routeId);
    return { kind: 'committed' };
  }

  /**
   * Explicit tenant-qualified re-read after a predicate miss: the route
   * still exists in this tenant ⇒ `stale` (the caller re-evaluates); it
   * does not ⇒ `missing` (404, no cross-tenant disclosure).
   */
  private async classifyStaleTransition(
    prisma: ReturnType<TenantPrismaService['getClient']>,
    tenantId: string,
    routeId: string,
  ): Promise<DeliveryRouteTransitionOutcome> {
    const current = await this.loadRoute(prisma, tenantId, routeId);
    return current ? { kind: 'stale' } : { kind: 'missing' };
  }

  /**
   * Enforce the route-level completion invariant against the persisted
   * stop rows: an ACTIVE route with zero open stops becomes COMPLETED and
   * its ADR-7 markers are cleared (a marker is non-null exactly while the
   * owning route is ACTIVE). Idempotent — a route already COMPLETED or
   * CANCELLED is left untouched by the status predicate.
   */
  private async reconcileRouteCompletion(
    prisma: ReturnType<TenantPrismaService['getClient']>,
    tenantId: string,
    routeId: string,
  ): Promise<void> {
    const openStops = await prisma.deliveryRouteStop.count({
      where: {
        routeId,
        tenantId,
        status: { in: [...OPEN_STOP_STATUSES] },
      },
    });
    if (openStops > 0) return;

    const now = new Date();
    await prisma.deliveryRoute.updateMany({
      where: { id: routeId, tenantId, status: 'ACTIVE' },
      data: { status: 'COMPLETED', completedAt: now, updatedAt: now },
    });
    await prisma.deliveryRouteStop.updateMany({
      where: { routeId, tenantId, activeRouteId: { not: null } },
      data: { activeRouteId: null },
    });
  }

  /** Tenant-qualified aggregate load shared by `findById` and the
   *  conditional-commit classification read. The nested stop read is
   *  tenant-qualified EXPLICITLY: the CLS tenant extension only rewrites
   *  top-level `where`, and this method also runs on raw transaction
   *  clients, so `include: { stops: true }` would rehydrate a child row
   *  attached to the same `routeId` but owned by another tenant. */
  private async loadRoute(
    prisma: ReturnType<TenantPrismaService['getClient']>,
    tenantId: string,
    id: string,
  ): Promise<DeliveryRoute | null> {
    const row = await prisma.deliveryRoute.findFirst({
      where: { id, tenantId },
      include: { stops: { where: { tenantId } } },
    });
    if (!row) return null;
    return DeliveryRoute.fromPersistence({
      id: row.id,
      tenantId: row.tenantId,
      driverUserId: row.driverUserId,
      status: row.status as 'DRAFT' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED',
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      cancelledAt: row.cancelledAt,
      notes: row.notes,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      stops: row.stops.map((stop) => ({
        id: stop.id,
        tenantId: stop.tenantId,
        routeId: stop.routeId,
        saleId: stop.saleId,
        sortOrder: stop.sortOrder,
        status: stop.status as
          | 'PENDING'
          | 'IN_PROGRESS'
          | 'COMPLETED'
          | 'SKIPPED',
        checkedInAt: stop.checkedInAt,
        completedAt: stop.completedAt,
        skippedReason: stop.skippedReason,
        activeRouteId: stop.activeRouteId,
        createdAt: stop.createdAt,
        updatedAt: stop.updatedAt,
      })),
    });
  }

  async findOneWithStops(input: {
    tenantId: string;
    id: string;
  }): Promise<DeliveryRouteReadModel | null> {
    const prisma = this.getClient();
    const tenantId = input.tenantId;
    const row = await prisma.deliveryRoute.findFirst({
      where: { id: input.id, tenantId },
      include: {
        driver: { select: { id: true, name: true, email: true } },
        stops: {
          // Explicit nested tenant predicate: the CLS tenant extension only
          // rewrites top-level `where`, and the relation joins on `routeId`
          // alone, so a child row owned by another tenant could otherwise be
          // rehydrated into this tenant's read model (same asymmetry as
          // `loadRoute`).
          where: { tenantId },
          orderBy: { sortOrder: 'asc' },
          // ODD O1 — the sale's own `tenantId` plus the tenant ids of its
          // to-one children are selected so the mapper can reject a nested
          // row owned by another tenant.
          include: { sale: { select: STOP_SALE_SELECT } },
        },
      },
    });
    if (!row) return null;
    return {
      id: row.id,
      tenantId: row.tenantId,
      driverUserId: row.driverUserId,
      status: row.status as 'DRAFT' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED',
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      cancelledAt: row.cancelledAt,
      notes: row.notes,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      driver: row.driver
        ? {
            id: row.driver.id,
            name: row.driver.name,
            email: row.driver.email,
          }
        : null,
      // ODD O1 — tenant-qualified nested projection (see the mapper).
      stops: row.stops.map((stop) => mapRouteStopReadModel(stop, row.tenantId)),
    };
  }

  async list(
    input: ListDeliveryRoutesInput,
  ): Promise<DeliveryRouteReadModel[]> {
    const prisma = this.getClient();
    const tenantId = input.tenantId;
    const where: Prisma.DeliveryRouteWhereInput = { tenantId };
    if (input.driverUserId) {
      where.driverUserId = input.driverUserId;
    }
    if (input.status && input.status.length > 0) {
      where.status = { in: input.status };
    }
    const rows = await prisma.deliveryRoute.findMany({
      where,
      include: {
        driver: { select: { id: true, name: true, email: true } },
        stops: {
          // Same explicit nested tenant predicate as `findOneWithStops`: the
          // list read model must not attach a foreign-tenant stop that shares
          // this route's id.
          where: { tenantId },
          orderBy: { sortOrder: 'asc' },
          // Same ODD O1 nested projection as `findOneWithStops`.
          include: { sale: { select: STOP_SALE_SELECT } },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      driverUserId: row.driverUserId,
      status: row.status as 'DRAFT' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED',
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      cancelledAt: row.cancelledAt,
      notes: row.notes,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      driver: row.driver
        ? {
            id: row.driver.id,
            name: row.driver.name,
            email: row.driver.email,
          }
        : null,
      // ODD O1 — same tenant-qualified nested projection as the detail read.
      stops: row.stops.map((stop) => mapRouteStopReadModel(stop, row.tenantId)),
    }));
  }

  async findDriverUserIdById(input: {
    tenantId: string;
    id: string;
  }): Promise<{ driverUserId: string } | null> {
    const prisma = this.getClient();
    const tenantId = input.tenantId;
    const row = await prisma.deliveryRoute.findFirst({
      where: { id: input.id, tenantId },
      select: { driverUserId: true },
    });
    return row ? { driverUserId: row.driverUserId } : null;
  }

  async delete(input: { tenantId: string; id: string }): Promise<void> {
    const prisma = this.getClient();
    const tenantId = input.tenantId;
    // Adapter-side precondition: only DRAFT routes with zero stops may
    // be hard-deleted. The aggregate's `canDelete()` pre-checks in the
    // service; the adapter re-validates to keep the guard rails close
    // to the persistence call.
    const row = await prisma.deliveryRoute.findFirst({
      where: { id: input.id, tenantId },
      // Explicit nested tenant predicate: the CLS tenant extension only
      // rewrites top-level `where`, and the stop relation joins on `routeId`
      // alone, so a foreign-tenant stop sharing this route id would otherwise
      // appear in the probe and falsely block the delete.
      include: { stops: { where: { tenantId }, take: 1 } },
    });
    if (!row) {
      // Already gone — idempotent.
      return;
    }
    if (row.status !== 'DRAFT' || row.stops.length > 0) {
      throw new BusinessRuleViolationError(
        'DeliveryRoute can only be deleted when DRAFT with no stops',
        'DELIVERY_ROUTE_INVALID_TRANSITION',
      );
    }
    await prisma.deliveryRoute.delete({ where: { id: input.id } });
  }

  async runInTransaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.tenantPrisma.runInTransaction(async () => {
      // SAFETY: inside `runInTransaction` the CLS client IS the ambient
      // transaction client; the shared delegate surface is identical, only
      // the client-level lifecycle methods differ.
      const tx =
        this.tenantPrisma.getClient() as unknown as Prisma.TransactionClient;
      return work(tx);
    });
  }

  // ── Outbox seam (WU3 poller/dispatcher overrides) ───────────────────
  // WU2 ships stubs because the port contract requires the methods to
  // exist. The WU3 poller/dispatcher rewires them with the
  // dedicated-claim SQL; until then, the methods throw so any
  // accidental WU2 path that reaches them fails loudly.

  claimNextOutboxEvent(): Promise<unknown> {
    return Promise.reject(
      new BusinessRuleViolationError(
        'claimNextOutboxEvent is not implemented in WU2',
        'OUTBOX_NOT_WIRED',
      ),
    );
  }

  markOutboxEventSent(): Promise<void> {
    return Promise.reject(
      new BusinessRuleViolationError(
        'markOutboxEventSent is not implemented in WU2',
        'OUTBOX_NOT_WIRED',
      ),
    );
  }

  markOutboxEventFailed(): Promise<void> {
    return Promise.reject(
      new BusinessRuleViolationError(
        'markOutboxEventFailed is not implemented in WU2',
        'OUTBOX_NOT_WIRED',
      ),
    );
  }

  getTransactionClient(): Prisma.TransactionClient | null {
    if (!this.tenantPrisma.isInTransaction()) {
      return null;
    }
    // SAFETY: guarded by `isInTransaction()`, so the CLS client is the
    // ambient transaction client; the delegate surface it exposes is the
    // same one a `Prisma.TransactionClient` exposes.
    return this.tenantPrisma.getClient() as unknown as Prisma.TransactionClient;
  }
}
